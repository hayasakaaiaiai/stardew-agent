/** WebSocket service for the SMAPI mod, with save-scoped M1 memory (docs/game-memory.md). */
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';
import { BACKSTAGE_PER_DAY, BACKSTAGE_TOPIC, type BackstagePerson, backstageHour, backstagePrompt, parseBackstage, pickBackstage } from '../agent/backstage.ts';
import { AMBIENT_CALLS_PER_DAY, type AmbientLine, type AmbientPerson, ambientPrompt, parseAmbient } from '../agent/ambient.ts';
import type { Consolidator } from '../agent/consolidation.ts';
import { OPENING_LINE, runTurn, type Standing, type WorldState } from '../agent/dialogue.ts';
import { farInvitation, farInvitationLine, invitationLine, meetingLine, MEETS_PER_DAY, upcomingLine } from '../agent/meetings.ts';
import { newsFor } from '../agent/news.ts';
import { parseScene, type SceneLine, type SceneNews, SCENES_PER_DAY, SCENE_GAP_MINUTES, scenePrompt } from '../agent/scene.ts';
import { nextStop, restOfDay, scheduleReplies, type ScheduleStop } from '../agent/schedule.ts';
import type { ChatModel } from '../services/model/client.ts';
import type { ModelGateway } from '../services/model/gateway.ts';
import type { Roster } from '../services/roster/index.ts';
import { SOCIAL_NPCS } from '../types.ts';
import { requireValue } from '../validation.ts';
import { GameMemory, type GameSave } from './memory.ts';
import { absoluteDay, type BackendMessage, type Envelope, gameMinutes, type ModMessage, parseModMessage, PROTOCOL_VERSION, type Schedules } from './protocol.ts';
import { clock, WEATHER, worldState } from './world.ts';

export interface BridgeOptions {
  roster: Roster;
  model: ChatModel;
  memoryDirectory: string;
  /** Consolidates each confirmed save in the background (docs/nightly-consolidation.md). */
  consolidator?: Consolidator;
  /** Override the 30-second recovery delay for isolated tests. */
  nightlyRetryDelayMs?: number;
  /**
   * Small talk between NPCs the player can overhear (docs/npc-chat.md) and lines near the player
   * (docs/ambient-lines.md); without it requests get no lines.
   */
  sceneModel?: ChatModel;
  /** NPCs who spend an hour together away from the player chat and remember it (docs/scheduler.md §4); without it there are none. */
  backstageModel?: ChatModel;
  /** Logs the model usage since the last save after each new save (docs/scheduler.md §3.2). */
  gateway?: ModelGateway;
  /** 0 picks a free port (tests). */
  port: number;
  host?: string;
  log?: (line: string) => void;
}

interface OpenTalk { npcId: string; standing: Standing; world: WorldState; inPersonGifts: boolean }
interface BackstageBudget { day: number; calls: number; joined: Set<string>; lastMinute: number }

/** An NPC's schedule from the Mod's map of game names (docs/npc-schedules.md); none when the Mod sent none. */
function scheduleOf(schedules: Schedules | undefined, id: string): ScheduleStop[] {
  return Object.entries(schedules ?? {}).find(([npc]) => npc.toLowerCase() === id)?.[1] ?? [];
}
class Session {
  hello = false;
  save: GameSave | undefined;
  readonly open = new Map<string, OpenTalk>();
  pending: AbortController | undefined;
  chain: Promise<void> = Promise.resolve();
  send: (message: BackendMessage) => void = () => {};
  todayRevision = 0;
  /** Pairs that already talked on this game day, for the per-day budget. */
  scenes = { day: 0, pairs: new Set<string>(), lastMinute: -1 };
  /** Calls on this game day and who has greeted the player, for docs/ambient-lines.md. */
  ambient = { day: 0, calls: 0, greeted: new Set<string>() };
}

export class BridgeServer {
  /**
   * Every read of today's appointments takes a ticket; a list is sent only if no newer one has gone out, so a slow read
   * at load never lands after the list a conversation just changed (docs/npc-later-meetings.md).
   */
  private readonly meetingTickets = new WeakMap<object, { issued: number; sent: number }>();

  private meetingTicket(session: object): () => boolean {
    const tickets = this.meetingTickets.get(session) ?? { issued: 0, sent: 0 };
    this.meetingTickets.set(session, tickets);
    const ticket = ++tickets.issued;
    return () => {
      if (ticket < tickets.sent) return false;
      tickets.sent = ticket;
      return true;
    };
  }

  private readonly options: BridgeOptions;
  private readonly server: WebSocketServer;
  private readonly memory: GameMemory;
  private readonly sessions = new Set<Session>();
  private readonly owners = new Map<string, Session>();
  /** The same load keeps its backstage budget when its WebSocket reconnects. A new load gets a new GameSave. */
  private readonly backstageBudgets = new WeakMap<GameSave, BackstageBudget>();

  private constructor(options: BridgeOptions, server: WebSocketServer, memory: GameMemory) {
    this.options = options; this.server = server; this.memory = memory;
    server.on('connection', socket => this.accept(socket));
    memory.onConsolidated = (lineageId, commitId) => {
      const owner = this.owners.get(lineageId);
      if (owner?.save?.head === commitId) void this.sendToday(owner);
    };
  }

  static async start(options: BridgeOptions): Promise<BridgeServer> {
    const memory = await GameMemory.open(options.memoryDirectory, options.log, options.consolidator, options.nightlyRetryDelayMs);
    const server = new WebSocketServer({ port: options.port, host: options.host ?? '127.0.0.1', maxPayload: 256 * 1024 });
    try {
      await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
      return new BridgeServer(options, server, memory);
    } catch (error) { await memory.close(); throw error; }
  }

  get port(): number { return (this.server.address() as AddressInfo).port; }

  async close(): Promise<void> {
    const sessions = [...this.sessions];
    for (const session of sessions) session.pending?.abort('Backend stopping');
    for (const client of this.server.clients) client.terminate();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    await Promise.all(sessions.map(session => session.chain));
    await this.memory.close();
  }

  private log(line: string) { this.options.log?.(line); }

  /** An NPC id such as "abigail" as the card calls her. */
  private readonly idName = (id: string) => this.options.roster.has(id) ? this.options.roster.get(id).name : id;

  /** A game name such as "Abigail" as the card calls her; unknown NPCs keep their game name. */
  private readonly cardName = (npc: string) => {
    const id = npc.toLowerCase();
    return this.options.roster.has(id) ? this.options.roster.get(id).name : npc;
  };

  /** Runs outside the lifecycle queue like a talk turn; the Mod gets empty lines whenever nothing should show. */
  private async scene(session: Session, message: Extract<ModMessage, { type: 'scene.request' }>, send: (message: BackendMessage) => void) {
    const save = session.save!;
    const reply = (lines: SceneLine[]) => { if (session.save === save) send({ type: 'scene.lines', ...envelope(message), lines }); };
    const [a, b] = message.npcs.map((npc) => npc.toLowerCase()).sort((x, y) => SOCIAL_NPCS.indexOf(x as never) - SOCIAL_NPCS.indexOf(y as never));
    const { roster, sceneModel } = this.options;
    if (session.scenes.day !== save.day) session.scenes = { day: save.day, pairs: new Set(), lastMinute: -1 };
    const requestedDay = absoluteDay(message.world.date);
    const time = message.world.date.time;
    const minute = Math.floor(time / 100) * 60 + time % 100;
    const pair = `${a}+${b}`;
    if (!sceneModel || save.closed || requestedDay !== save.day || a === b || !roster.has(a!) || !roster.has(b!)
      || (session.scenes.lastMinute >= 0 && minute - session.scenes.lastMinute < SCENE_GAP_MINUTES)
      || session.scenes.pairs.has(pair) || session.scenes.pairs.size >= SCENES_PER_DAY) {
      reply([]);
      return;
    }
    session.scenes.pairs.add(pair);
    session.scenes.lastMinute = minute;
    try {
      const people = await save.gossip([a!, b!]);
      const [newsA, newsB] = [newsFor(people[a!], people[b!]), newsFor(people[b!], people[a!])];
      const news: SceneNews = { ...(newsA ? { a: newsA } : {}), ...(newsB ? { b: newsB } : {}) };
      const next = [a!, b!].map(id => nextStop(scheduleOf(message.schedules, id), time));
      const completion = await sceneModel.chat(scenePrompt(roster, a!, b!, worldState(message.world, save.player, this.cardName), news, next),
        {}, { json: true });
      if (save.closed || save.day !== requestedDay) return;
      const { lines, told } = parseScene(completion.content, a!, b!, save.player.name, news);
      // The listener keeps the original words, not whatever line the model put on screen.
      save.noteScene(message.seq, told.map(teller => ({ listener: teller === a ? b! : a!, from: teller, item: (teller === a ? newsA : newsB)! })));
      reply(lines);
      this.log(`碰面聊天：${roster.get(a!).name}和${roster.get(b!).name}，${lines.length ? `${lines.length} 句` : '没有可显示的'}`
        + (told.length ? `，${told.map(teller => roster.get(teller).name).join('、')}说了新鲜事` : ''));
    } catch (error) {
      this.log(`碰面聊天失败：${error instanceof Error ? error.message : String(error)}`);
      reply([]);
    }
  }

  /**
   * Like a scene: outside the lifecycle queue, with empty lines whenever nothing should show. A greeting the backend
   * returned counts even if the Mod does not report it, so nobody greets the player twice a day.
   */
  private async ambient(session: Session, message: Extract<ModMessage, { type: 'ambient.request' }>, send: (message: BackendMessage) => void) {
    const save = session.save!;
    const reply = (lines: AmbientLine[]) => { if (session.save === save) send({ type: 'ambient.lines', ...envelope(message), lines }); };
    const { roster, sceneModel } = this.options;
    if (session.ambient.day !== save.day) session.ambient = { day: save.day, calls: 0, greeted: new Set() };
    const budget = session.ambient;
    const requestedDay = absoluteDay(message.world.date);
    const people: AmbientPerson[] = message.npcs.map(({ npc, hearts, relation, greeted, schedule }) => {
      const id = npc.toLowerCase();
      const next = nextStop(schedule ?? [], message.world.date.time);
      return { id, hearts, relation, greeted: greeted || budget.greeted.has(id), ...(next ? { next } : {}) };
    });
    if (!sceneModel || save.closed || requestedDay !== save.day || budget.calls >= AMBIENT_CALLS_PER_DAY
      || people.some(person => !roster.has(person.id)) || new Set(people.map(person => person.id)).size !== people.length) {
      reply([]);
      return;
    }
    budget.calls++;
    const names = people.map(person => roster.get(person.id).name).join('、');
    try {
      const completion = await sceneModel.chat(ambientPrompt(roster, people, worldState(message.world, save.player, this.cardName)),
        {}, { json: true });
      if (save.closed || save.day !== requestedDay) return;
      // A previous slow request can finish while this one is still generating.
      const currentPeople = people.map(person => ({ ...person, greeted: person.greeted || budget.greeted.has(person.id) }));
      const lines = parseAmbient(completion.content, currentPeople, save.player.name);
      const greeters = lines.filter(line => line.to === 'farmer').map(line => line.npc);
      for (const npc of greeters) budget.greeted.add(npc);
      reply(lines);
      this.log(`同图：${names}，${lines.length ? `${lines.length} 句` : '没有可显示的'}`
        + (greeters.length ? `，打招呼：${greeters.map(npc => roster.get(npc).name).join('、')}` : ''));
    } catch (error) {
      this.log(`同图失败：${error instanceof Error ? error.message : String(error)}`);
      reply([]);
    }
  }

  /**
   * At most one group per town hour talks among themselves (docs/scheduler.md §4). The result waits in the load's memory
   * until the next hour writes it, so it is saved or rolled back with the day; a scene that fails is just skipped.
   */
  private async backstage(session: Session, message: Extract<ModMessage, { type: 'town.hour' }>) {
    const save = session.save!;
    const { roster, backstageModel } = this.options;
    const day = absoluteDay(message.date);
    if (!backstageModel || !message.hearts || save.closed || day !== save.day || !backstageHour(message.date.time)) return;
    const previous = this.backstageBudgets.get(save);
    const budget: BackstageBudget = previous?.day === save.day ? previous
      : { day: save.day, calls: 0, joined: new Set(), lastMinute: -1 };
    this.backstageBudgets.set(save, budget);
    // A resent hour, or one older than the last, starts nothing: at most one scene per hour.
    const minute = gameMinutes(message.date);
    if (minute <= budget.lastMinute || budget.calls >= BACKSTAGE_PER_DAY) return;
    budget.lastMinute = minute;
    const hearts = Object.fromEntries(Object.entries(message.hearts).map(([npc, value]) => [npc.toLowerCase(), value]));
    const groups = message.groups.map((group, index) => ({ place: message.places?.[index] ?? '',
      ids: [...new Set(group.map(npc => npc.toLowerCase()))].filter(id => roster.has(id) && !budget.joined.has(id)) }))
      .filter(group => group.ids.length >= 2);
    if (!groups.length) return;
    try {
      const gossip = await save.gossip(groups.flatMap(group => group.ids));
      const pick = pickBackstage(groups.map(group => ({ place: group.place,
        people: group.ids.map(id => ({ id, hearts: hearts[id] ?? 0, hasNews: (gossip[id]?.tellable.length ?? 0) > 0 })) })), budget.joined);
      if (!pick || session.save !== save || save.closed || save.day !== day
        || budget.calls >= BACKSTAGE_PER_DAY || pick.ids.some(id => budget.joined.has(id))) return;
      budget.calls++;
      for (const id of pick.ids) budget.joined.add(id);
      const festivals = await save.festivalsFor(pick.ids, minute);
      if (session.save !== save || save.closed || save.day !== day) return;
      const people: BackstagePerson[] = pick.ids.map(id => {
        const next = nextStop(scheduleOf(message.schedules, id), message.date.time);
        return { id, news: gossip[id]?.tellable ?? [], festivals: festivals[id] ?? [], ...(next ? { next } : {}) };
      });
      const world = { ...message.date, time: clock(message.date.time), weather: message.weather ? WEATHER[message.weather] : '',
        location: pick.place, player: save.player, facts: {} };
      const names = pick.ids.map(this.idName).join('、');
      const completion = await backstageModel.chat(backstagePrompt(roster, people, pick.place, world), {}, { json: true });
      if (session.save !== save || save.closed || save.day !== day) return;
      const notes = parseBackstage(completion.content, pick.ids, pick.place, this.idName);
      save.noteBackstage(day, notes);
      this.log(`后台场景：${pick.place || '镇上'}，${names}，${notes.length ? `${notes.length} 条等下一个整点写入` : '没有可记的'}`);
    } catch (error) {
      this.log(`后台场景失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Replaces the Mod's bubbles and the NPCs who walk over for the day, and offers this morning's letter; sent again
   * when a late consolidation finishes (docs/npc-bubbles.md, docs/npc-approach.md, docs/npc-mail.md). The Mod ignores a
   * letter it already has.
   */
  private async sendToday(session: Session): Promise<void> {
    const save = session.save;
    const revision = ++session.todayRevision;
    const meetingsFresh = this.meetingTicket(session);
    if (!save || save.closed) return;
    const head = save.head, day = save.day;
    try {
      const { bubbles, letters, approach, meetings } = await save.today();
      if (session.save !== save || save.closed || session.todayRevision !== revision || save.head !== head || save.day !== day) return;
      const envelope = { lineageId: save.initial.lineageId, loadNonce: save.loadNonce, seq: 0 };
      session.send({ type: 'day.bubbles', ...envelope, npcs: bubbles });
      session.send({ type: 'day.letters', ...envelope, letters });
      session.send({ type: 'day.approach', ...envelope, npcs: approach });
      if (meetingsFresh()) session.send({ type: 'day.meetings', ...envelope, meetings });
      const names = Object.keys(bubbles);
      if (names.length) this.log(`今天的气泡：${names.join('、')}`);
      if (letters.length) this.log(`今天的信：${letters.map(letter => letter.npc).join('、')}`);
      const seekers = Object.entries(approach);
      if (seekers.length) this.log(`今天想主动找农场主的：${seekers.map(([npc, hearts]) => `${npc}（${hearts} 心起）`).join('、')}`);
      if (meetings.length) this.log(`今天的约定：${meetings.map(item => `${item.npc} ${clock(item.time)} ${item.place}`).join('、')}`);
    } catch (error) {
      this.log(`读取今天的气泡、信和主动找农场主的失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Only the appointments, after a conversation settled one for today or called it off (docs/npc-same-day-meetings.md, docs/npc-call-off.md). */
  private async sendMeetings(session: Session): Promise<void> {
    const save = session.save;
    const fresh = this.meetingTicket(session);
    if (!save || save.closed) return;
    try {
      const meetings = await save.meetings();
      if (session.save !== save || save.closed || !fresh()) return;
      session.send({ type: 'day.meetings', lineageId: save.initial.lineageId, loadNonce: save.loadNonce, seq: 0, meetings });
    } catch (error) {
      this.log(`读取今天的约定失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private accept(socket: WebSocket) {
    const session = new Session();
    this.sessions.add(session);
    const send = (message: BackendMessage) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message)); };
    session.send = send;
    this.log('Mod 已连接');
    socket.on('close', () => {
      session.pending?.abort('Mod disconnected');
      void session.chain.finally(() => {
        this.sessions.delete(session);
        if (session.save && this.owners.get(session.save.initial.lineageId) === session)
          this.owners.delete(session.save.initial.lineageId);
      });
      this.log('Mod 已断开；保留同次读档的当天工作区');
    });
    socket.on('message', data => {
      let message: ModMessage;
      try { message = parseModMessage(data.toString()); }
      catch (error) { this.log(`忽略一条无法解析的消息：${String(error)}`); return; }
      // Lifecycle messages stay ordered, but model requests run outside this queue so Saving can cancel them immediately.
      session.chain = session.chain.then(() => this.handle(session, message, send)).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.log(`处理 ${message.type} 出错：${reason}`);
        send({ type: 'sync.error', message: reason, ...(message.type === 'hello' ? {} : envelope(message)) });
      });
    });
  }

  private async handle(session: Session, message: ModMessage, send: (message: BackendMessage) => void) {
    if (message.type === 'hello') {
      session.hello = false;
      requireValue(message.protocol === PROTOCOL_VERSION, 'PROTOCOL_MISMATCH', 'Mod 与后端协议不一致，请一同更新');
      session.hello = true;
      send({ type: 'hello', protocol: PROTOCOL_VERSION });
      return;
    }
    requireValue(session.hello, 'HANDSHAKE_REQUIRED', '请先完成协议握手');
    if (message.type === 'save.loaded') {
      session.pending?.abort('Save reannounced');
      session.open.clear();
      if (session.save && this.owners.get(session.save.initial.lineageId) === session)
        this.owners.delete(session.save.initial.lineageId);
      const previousSave = session.save;
      session.save = await this.memory.load(message);
      // A rollback with a fresh nonce restarts the day's native scene budget. A repeated announcement of the
      // same load keeps it, and a failed load above must not erase the current load's budget.
      if (session.save !== previousSave) {
        session.scenes = { day: session.save.day, pairs: new Set(), lastMinute: -1 };
        session.ambient = { day: session.save.day, calls: 0, greeted: new Set() };
      }
      const previous = this.owners.get(message.lineageId);
      if (previous && previous !== session) {
        previous.pending?.abort('Connection superseded');
        previous.save = undefined; previous.open.clear();
      }
      this.owners.set(message.lineageId, session);
      send({ type: 'save.ready', ...envelope(message), day: session.save.day });
      void this.sendToday(session);
      this.log(`记忆已就绪：${message.player.name}，${message.player.farm}农场，第 ${session.save.day} 天`);
      return;
    }
    const save = session.save;
    requireValue(save && this.owners.get(message.lineageId) === session
      && message.lineageId === save.initial.lineageId && message.loadNonce === save.loadNonce,
      'STALE_LOAD', '消息不属于当前读档');

    if (message.type === 'talk.open') {
      const npcId = message.npc.toLowerCase();
      if (!this.options.roster.has(npcId)) {
        send({ type: 'talk.error', ...envelope(message), npc: message.npc, message: `没有 ${message.npc} 的角色卡` }); return;
      }
      if (session.pending) {
        send({ type: 'talk.error', ...envelope(message), npc: message.npc, message: '上一句还没回完' }); return;
      }
      const schedule = restOfDay(message.schedule ?? [], message.world.date.time);
      // Today's, or else the nearest one ahead (docs/npc-later-meetings.md).
      const meeting = meetingLine(await save.meeting(npcId), message.world.date.time, message.atMeeting === true, message.helped, message.mine,
        message.outing)
        ?? upcomingLine(await save.upcoming(npcId), save.day);
      // Asked out by the NPC the Mod chose today, unless something is already agreed or the day is full (docs/npc-invites.md).
      const invitation = message.invite === true && !meeting && (await save.meetings()).length < MEETS_PER_DAY
        ? invitationLine(message.world.date.time) : undefined;
      if (invitation) this.log(`${this.options.roster.get(npcId).name}开口约农场主`);
      const mood = await save.mood(npcId);
      const talk: OpenTalk = { npcId, inPersonGifts: message.inPersonGifts !== false,
        standing: { hearts: message.hearts, relation: message.relation, seenEvents: new Set(message.seenEvents) },
        world: { ...worldState(message.world, save.player, this.cardName),
          ...(schedule ? { schedule, scheduleFacts: scheduleReplies(message.schedule!, message.world.date.time)! } : {}),
          ...(meeting ? { meeting } : {}), ...(invitation ? { invitation } : {}), ...(mood ? { mood } : {}) } };
      session.open.set(message.npc, talk);
      void this.turn(session, talk, message, OPENING_LINE, send);
      return;
    }
    if (message.type === 'talk.say') {
      const talk = session.open.get(message.npc);
      if (!talk || session.pending) {
        send({ type: 'talk.error', ...envelope(message), npc: message.npc, message: talk ? '上一句还没回完' : '对话还没有打开' }); return;
      }
      // Only for this turn: an invitation beyond the day after tomorrow is turned down (docs/npc-later-meetings.md).
      const { farInvitation: _, invitation: __, ...world } = talk.world;
      const far = farInvitation(message.text, save.day);
      talk.world = { ...world, ...message.date, time: clock(message.date.time), ...(far ? { farInvitation: farInvitationLine(far) } : {}) };
      void this.turn(session, talk, message, message.text, send);
      return;
    }
    if (message.type === 'gift.given') {
      const note = await save.gift(message);
      send({ type: 'ack', ...envelope(message) });
      if (note) this.log(`${this.cardName(message.npc)}记下了：${note}`);
      return;
    }
    if (message.type === 'meet.ended') {
      const note = await save.meetEnded(message);
      send({ type: 'ack', ...envelope(message) });
      if (note) this.log(`${this.cardName(message.npc)}记下了：${note}`);
      return;
    }
    if (message.type === 'scene.shown') {
      const heard = await save.sceneShown(message, this.idName);
      send({ type: 'ack', ...envelope(message) });
      for (const item of heard) this.log(`${this.idName(item.npcId)}记下了：${item.memory.text}`);
      return;
    }
    if (message.type === 'town.hour') {
      const heard = await save.townHour(message, this.idName);
      send({ type: 'ack', ...envelope(message) });
      for (const item of heard) this.log(`${item.memory.topics?.includes(BACKSTAGE_TOPIC) ? '后台场景' : '镇上传话'}：${this.idName(item.npcId)}记下了：${item.memory.text}`);
      void this.backstage(session, message);
      return;
    }
    if (message.type === 'festival.ended') {
      const notes = await save.festival(message, this.idName);
      send({ type: 'ack', ...envelope(message) });
      for (const item of notes) this.log(`节日：${this.idName(item.npcId)}记下了：${item.memory.text}`);
      return;
    }
    if (message.type === 'scene.request') {
      void this.scene(session, message, send);
      return;
    }
    if (message.type === 'ambient.request') {
      void this.ambient(session, message, send);
      return;
    }
    const head = save.head, day = save.day;
    const settled = await save.control(message, () => {
      if (message.type === 'talk.close') session.open.delete(message.npc);
      else session.open.clear();
      session.pending?.abort('Conversation or game day ended');
      session.pending = undefined;
    });
    send({ type: 'ack', ...envelope(message) });
    // Notes for later days: an appointment made, or one taken back (docs/npc-later-meetings.md).
    if (message.type === 'talk.close') for (const note of settled?.later ?? []) this.log(`${this.cardName(message.npc)}记下了：${note}`);
    const agreed = settled?.today;
    if (agreed) {
      const name = this.cardName(agreed.npc);
      this.log(agreed.moved ? `${name}今天的约定改到 ${clock(agreed.time)} ${agreed.place}`
        : agreed.movedTo ? `${name}今天在${agreed.place}的约定改到${agreed.movedTo}`
        : !agreed.by ? `${name}答应了今天的约定：${agreed.soon ? `${clock(agreed.time)} 说好马上去` : clock(agreed.time)} ${agreed.place}`
        : agreed.sentHome ? `${name}${agreed.by === '玩家' ? '被农场主送回去了' : '说要先回去了'}（${agreed.place}）`
        : `${name}今天在${agreed.place}的约定取消了：${agreed.by === '玩家' ? '农场主说不去了' : `${name}说去不了了`}`);
      if (agreed.note) this.log(`${name}记下了：${agreed.note}`);
      void this.sendMeetings(session);
    }
    if (message.type === 'save.saved' && save.head !== head && this.options.gateway) this.log(this.options.gateway.report(day));
    if (message.type === 'day.started') void this.sendToday(session);
  }

  private async turn(session: Session, talk: OpenTalk, message: Extract<ModMessage, { type: 'talk.open' | 'talk.say' }>,
    playerLine: string, send: (message: BackendMessage) => void) {
    const cancel = new AbortController();
    session.pending = cancel;
    let signal = cancel.signal;
    const active = () => !signal.aborted && session.open.get(message.npc) === talk;
    try {
      const lease = await session.save!.begin(message, message.type === 'talk.open' ? message.world.date : message.date, cancel.signal,
        talk.inPersonGifts ? this.options.roster.get(talk.npcId).gifts : [], talk.world.invitation !== undefined);
      if ('type' in lease) { if (active()) send(lease); return; }
      signal = lease.signal;
      const result = await runTurn({ roster: this.options.roster, model: this.options.model, memory: lease.memory },
        { npcId: talk.npcId, world: talk.world, standing: talk.standing, playerLine },
        { signal: lease.signal, onReply: text => { if (active()) send({ type: 'talk.delta', ...envelope(message), npc: message.npc, text }); } });
      const reply = await lease.finish(result);
      if (active()) send(reply);
      const usage = result.usage ? `输入 ${result.usage.inputTokens}，输出 ${result.usage.outputTokens}` : '无用量';
      this.log(`${talk.npcId}：首字 ${result.timing.firstReplyMs ?? '—'}ms，总 ${result.timing.totalMs}ms，${usage}${result.metaOk ? '' : '，格式解析失败'}`);
      if (reply.gift) this.log(`${this.options.roster.get(talk.npcId).name}当面送了：${reply.gift}`);
    } catch (error) {
      if (active()) {
        const reason = error instanceof Error ? error.message : String(error);
        this.log(`${talk.npcId}：请求失败：${reason}`);
        send({ type: 'talk.error', ...envelope(message), npc: message.npc, message: reason });
      }
    } finally { if (session.pending === cancel) session.pending = undefined; }
  }
}

function envelope(message: Envelope): Envelope {
  return { lineageId: message.lineageId, loadNonce: message.loadNonce, seq: message.seq };
}
