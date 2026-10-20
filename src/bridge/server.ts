/** WebSocket service for the SMAPI mod, with save-scoped M1 memory (docs/game-memory.md). */
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';
import type { Consolidator } from '../agent/consolidation.ts';
import { OPENING_LINE, runTurn, type Standing, type WorldState } from '../agent/dialogue.ts';
import { parseScene, type SceneLine, SCENES_PER_DAY, scenePrompt } from '../agent/scene.ts';
import type { ModelClient } from '../services/model/client.ts';
import type { Roster } from '../services/roster/index.ts';
import { SOCIAL_NPCS } from '../types.ts';
import { requireValue } from '../validation.ts';
import { GameMemory, type GameSave } from './memory.ts';
import { type BackendMessage, type Envelope, type ModMessage, parseModMessage, PROTOCOL_VERSION } from './protocol.ts';
import { clock, worldState } from './world.ts';

export interface BridgeOptions {
  roster: Roster;
  model: ModelClient;
  memoryDirectory: string;
  /** Consolidates each confirmed save in the background (docs/nightly-consolidation.md). */
  consolidator?: Consolidator;
  /** Override the 30-second recovery delay for isolated tests. */
  nightlyRetryDelayMs?: number;
  /** Small talk between NPCs the player can overhear (docs/npc-chat.md); without it requests get no lines. */
  sceneModel?: ModelClient;
  /** 0 picks a free port (tests). */
  port: number;
  host?: string;
  log?: (line: string) => void;
}

interface OpenTalk { npcId: string; standing: Standing; world: WorldState }
class Session {
  hello = false;
  save: GameSave | undefined;
  readonly open = new Map<string, OpenTalk>();
  pending: AbortController | undefined;
  chain: Promise<void> = Promise.resolve();
  send: (message: BackendMessage) => void = () => {};
  todayRevision = 0;
  /** Pairs that already talked on this game day, for the per-day budget. */
  scenes = { day: 0, pairs: new Set<string>() };
}

export class BridgeServer {
  private readonly options: BridgeOptions;
  private readonly server: WebSocketServer;
  private readonly memory: GameMemory;
  private readonly sessions = new Set<Session>();
  private readonly owners = new Map<string, Session>();

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

  /** Runs outside the lifecycle queue like a talk turn; the Mod gets empty lines whenever nothing should show. */
  private async scene(session: Session, message: Extract<ModMessage, { type: 'scene.request' }>, send: (message: BackendMessage) => void) {
    const save = session.save!;
    const reply = (lines: SceneLine[]) => { if (session.save === save) send({ type: 'scene.lines', ...envelope(message), lines }); };
    const [a, b] = message.npcs.map((npc) => npc.toLowerCase()).sort((x, y) => SOCIAL_NPCS.indexOf(x as never) - SOCIAL_NPCS.indexOf(y as never));
    const { roster, sceneModel } = this.options;
    if (session.scenes.day !== save.day) session.scenes = { day: save.day, pairs: new Set() };
    const pair = `${a}+${b}`;
    if (!sceneModel || save.closed || a === b || !roster.has(a!) || !roster.has(b!)
      || session.scenes.pairs.has(pair) || session.scenes.pairs.size >= SCENES_PER_DAY) {
      reply([]);
      return;
    }
    session.scenes.pairs.add(pair);
    try {
      const completion = await sceneModel.chat(scenePrompt(roster, a!, b!, worldState(message.world, save.player)), {}, { json: true });
      if (save.closed) return;
      const lines = parseScene(completion.content, a!, b!, save.player.name);
      reply(lines);
      this.log(`碰面聊天：${roster.get(a!).name}和${roster.get(b!).name}，${lines.length ? `${lines.length} 句` : '没有可显示的'}`);
    } catch (error) {
      this.log(`碰面聊天失败：${error instanceof Error ? error.message : String(error)}`);
      reply([]);
    }
  }

  /**
   * Replaces the Mod's bubbles for the day and offers this morning's letter; sent again when a late consolidation
   * finishes (docs/npc-bubbles.md, docs/npc-mail.md). The Mod ignores a letter it already has.
   */
  private async sendToday(session: Session): Promise<void> {
    const save = session.save;
    const revision = ++session.todayRevision;
    if (!save || save.closed) return;
    const head = save.head, day = save.day;
    try {
      const { bubbles, letters } = await save.today();
      if (session.save !== save || save.closed || session.todayRevision !== revision || save.head !== head || save.day !== day) return;
      const envelope = { lineageId: save.initial.lineageId, loadNonce: save.loadNonce, seq: 0 };
      session.send({ type: 'day.bubbles', ...envelope, npcs: bubbles });
      session.send({ type: 'day.letters', ...envelope, letters });
      const names = Object.keys(bubbles);
      if (names.length) this.log(`今天的气泡：${names.join('、')}`);
      if (letters.length) this.log(`今天的信：${letters.map(letter => letter.npc).join('、')}`);
    } catch (error) {
      this.log(`读取今天的气泡和信失败：${error instanceof Error ? error.message : String(error)}`);
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
      session.save = await this.memory.load(message);
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
      const talk: OpenTalk = { npcId,
        standing: { hearts: message.hearts, relation: message.relation, seenEvents: new Set(message.seenEvents) },
        world: worldState(message.world, save.player) };
      session.open.set(message.npc, talk);
      void this.turn(session, talk, message, OPENING_LINE, send);
      return;
    }
    if (message.type === 'talk.say') {
      const talk = session.open.get(message.npc);
      if (!talk || session.pending) {
        send({ type: 'talk.error', ...envelope(message), npc: message.npc, message: talk ? '上一句还没回完' : '对话还没有打开' }); return;
      }
      talk.world = { ...talk.world, ...message.date, time: clock(message.date.time) };
      void this.turn(session, talk, message, message.text, send);
      return;
    }
    if (message.type === 'gift.given') {
      const note = await save.gift(message);
      send({ type: 'ack', ...envelope(message) });
      const npcId = message.npc.toLowerCase();
      if (note) this.log(`${this.options.roster.has(npcId) ? this.options.roster.get(npcId).name : message.npc}记下了：${note}`);
      return;
    }
    if (message.type === 'scene.request') {
      void this.scene(session, message, send);
      return;
    }
    await save.control(message, () => {
      if (message.type === 'talk.close') session.open.delete(message.npc);
      else session.open.clear();
      session.pending?.abort('Conversation or game day ended');
      session.pending = undefined;
    });
    send({ type: 'ack', ...envelope(message) });
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
        this.options.roster.get(talk.npcId).gifts);
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
