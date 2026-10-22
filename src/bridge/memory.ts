/** Game save coordination around the unchanged M1 memory kernel (docs/game-memory.md). */
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { approachHearts } from '../agent/approach.ts';
import { type BackstageNote, FESTIVAL_DAYS } from '../agent/backstage.ts';
import type { Consolidator } from '../agent/consolidation.ts';
import { type Bubble, bubblesFor } from '../agent/bubbles.ts';
import { AgentMemory, turnLog } from '../agent/dialogue-memory.ts';
import type { DialogueMemory, Exchange, Remembered, Standing, TurnResult } from '../agent/dialogue.ts';
import { FESTIVAL_TOPIC, festivalMemories } from '../agent/festivals.ts';
import { friendshipPoints, friendshipSoFar } from '../agent/friendship.ts';
import { giftItemName, giftMemory } from '../agent/gifts.ts';
import { GIVEN_TOPIC, givenMemory, withInPersonGift } from '../agent/in-person-gifts.ts';
import { type Gossip, gossipOf, heardMemory, heardToday, shareFor, spread, type Transfer } from '../agent/news.ts';
import { type DeliveredLetter, type Letter, letterFor, letterKey } from '../agent/letters.ts';
import { callOffIn, type Meeting, meetingFor, meetingMemory, MEET_PLACES, MEETS_PER_DAY, openedAtMeeting, todayAgreement, todayMeeting } from '../agent/meetings.ts';
import type { CallOff } from '../agent/meeting-agreement.ts';
import { Nightly } from '../agent/nightly.ts';
import { withMorningPlan } from '../agent/morning.ts';
import { createRuntime, type SaveScope } from '../index.ts';
import type { Gift } from '../services/roster/index.ts';
import { type MemoryDraft, SOCIAL_NPCS } from '../types.ts';
import { canonical, digest, requireValue } from '../validation.ts';
import { absoluteDay, gameMinutes, type Envelope, type GameDate, type LoadedSave, type ModMessage, type SavePointer, type TalkReply } from './protocol.ts';

type Runtime = Awaited<ReturnType<typeof createRuntime>>;
type Event = Exclude<ModMessage, { type: 'hello' } | LoadedSave>;
type TalkRequest = Extract<Event, { type: 'talk.open' | 'talk.say' }>;
type GiftGiven = Extract<Event, { type: 'gift.given' }>;
type SceneShown = Extract<Event, { type: 'scene.shown' }>;
type TownHour = Extract<Event, { type: 'town.hour' }>;
type FestivalEnded = Extract<Event, { type: 'festival.ended' }>;
type MeetEnded = Extract<Event, { type: 'meet.ended' }>;
type TalkClose = Extract<Event, { type: 'talk.close' }>;
/** An appointment as the Mod gets it (docs/npc-meetings.md, docs/npc-same-day-meetings.md, docs/npc-call-off.md). */
export type DayMeeting = { npc: string; time: number; place: string; sameDay?: true; calledOff?: true };
/** What a closed conversation did to today's appointment: settled one, or called it off and who did. */
export type Settled = DayMeeting & { soon?: true; by?: CallOff; sentHome?: true; note?: string };
/** Who learned what, for the log. */
export interface Heard { npcId: string; memory: MemoryDraft }
interface Receipt { seq: number; hash: string; reply?: TalkReply }
interface Checkpoint {
  format: 1;
  initial: LoadedSave;
  day: number;
  head: string;
  pointer: SavePointer | null;
  phase: 'open' | 'preparing' | 'saving' | 'confirming' | 'closed';
  pending: SavePointer | null;
  nextDay: number | null;
  lastSeq: number;
  receipts: Receipt[];
}

export interface TurnLease {
  memory: DialogueMemory;
  signal: AbortSignal;
  finish(result: TurnResult): Promise<TalkReply>;
}

export class GameMemory {
  private readonly runtime: Runtime;
  private readonly directory: string;
  private readonly log: (line: string) => void;
  private readonly nightly: Nightly | undefined;
  /** Only successful writes notify the Mod, including a delayed recovery round. */
  onConsolidated: ((lineageId: string, commitId: string) => void) | undefined;
  private readonly active = new Map<string, GameSave>();
  private readonly loading = new Map<string, Promise<void>>();

  private constructor(runtime: Runtime, directory: string, log: (line: string) => void, nightly: Nightly | undefined) {
    this.runtime = runtime; this.directory = directory; this.log = log; this.nightly = nightly;
  }

  /** Without a consolidator, saves are never consolidated (docs/nightly-consolidation.md). */
  static async open(directory: string, log: (line: string) => void = () => {}, consolidator?: Consolidator, retryDelayMs?: number): Promise<GameMemory> {
    const runtime = await createRuntime({ databasePath: join(directory, 'memory.sqlite'), journalDirectory: join(directory, 'scratch') });
    const nightly = consolidator ? new Nightly({ store: runtime.ctx.store, consolidator, npcIds: SOCIAL_NPCS, log,
      ...(retryDelayMs !== undefined ? { retryDelayMs } : {}) }) : undefined;
    const memory = new GameMemory(runtime, directory, log, nightly);
    if (nightly) nightly.onConsolidated = (lineageId, commitId) => memory.onConsolidated?.(lineageId, commitId);
    return memory;
  }

  load(initial: LoadedSave): Promise<GameSave> {
    const result = (this.loading.get(initial.lineageId) ?? Promise.resolve()).then(() => this.loadNow(initial));
    const settled = result.then(() => {}, () => {});
    this.loading.set(initial.lineageId, settled);
    void settled.then(() => { if (this.loading.get(initial.lineageId) === settled) this.loading.delete(initial.lineageId); });
    return result;
  }

  private async loadNow(initial: LoadedSave): Promise<GameSave> {
    const current = this.active.get(initial.lineageId);
    if (current?.loadNonce === initial.loadNonce) {
      requireValue(canonical(current.initial) === canonical(initial), 'LOAD_CONFLICT', '同一次读档的初始信息发生变化');
      return current;
    }
    const path = join(this.directory, 'bridge', digest(initial.lineageId), `${digest(initial.loadNonce)}.json`);
    let state: Checkpoint | undefined;
    try { state = JSON.parse(await readFile(path, 'utf8')) as Checkpoint; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (state) {
      requireValue(state.format === 1 && canonical(state.initial) === canonical(initial), 'LOAD_CONFLICT', '读档身份与恢复检查点不一致');
    } else {
      let head = await this.runtime.ctx.store.call('root', initial.lineageId);
      if (initial.commit) {
        const pointer = initial.commit;
        const commit = await this.runtime.ctx.store.call('getCommit', { lineageId: initial.lineageId, commitId: pointer.commitId });
        if (commit) head = commit;
        else {
          const parent = pointer.parentId === null ? head
            : await this.runtime.ctx.store.call('getCommit', { lineageId: initial.lineageId, commitId: pointer.parentId });
          requireValue(parent?.status === 'confirmed', 'MISSING_COMMIT', '存档引用的记忆和父提交均缺失；请恢复对应的记忆数据库');
          head = parent;
          this.log(`记忆缺口：${pointer.commitId} 不存在，仅恢复档内指定父提交 ${head.id}。`);
        }
      }
      state = { format: 1, initial, day: absoluteDay(initial.date), head: head.id, pointer: initial.commit,
        phase: 'open', pending: null, nextDay: null, lastSeq: 0, receipts: [] };
    }
    // Validate the requested checkpoint before discarding a still-running load's unsaved journal.
    if (current) await current.discard();
    const save = new GameSave(this.runtime, path, state,
      commitId => void this.nightly?.run(initial.lineageId, commitId));
    await save.restore();
    this.active.set(initial.lineageId, save);
    await this.prune(dirname(path), path);
    // A crash or a closed backend can leave the last nights unconsolidated.
    void this.nightly?.catchUp(initial.lineageId, save.head);
    return save;
  }

  /**
   * Checkpoints of this game save's other loads can never be resumed once a new load is up, just like their day
   * journals (src/save/journal.ts). Only files named like checkpoints are touched.
   */
  private async prune(folder: string, keep: string): Promise<void> {
    let names: string[];
    try { names = await readdir(folder); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const stale = names.filter(name => !join(folder, name).startsWith(keep) && /^[0-9a-f]{64}\.json(\.tmp)?$/.test(name));
    await Promise.all(stale.map(name => rm(join(folder, name), { force: true })));
    if (stale.length) this.log(`清理了这个存档以前读档留下的 ${stale.length} 个检查点。`);
  }

  async close(): Promise<void> {
    await Promise.all(this.loading.values());
    for (const save of this.active.values()) await save.settle();
    await this.nightly?.close();
    await this.runtime.close();
    this.active.clear();
  }
}

export class GameSave {
  private readonly runtime: Runtime;
  private readonly path: string;
  private readonly state: Checkpoint;
  private scope: SaveScope | undefined;
  private readonly confirmed: (commitId: string) => void;
  private chain: Promise<void> = Promise.resolve();
  private live = true;
  /** Request seq → what its listeners learned; only in memory, so a backend restart before it was shown forgets it. */
  private readonly scenes = new Map<number, { day: number; transfers: Transfer[] }>();
  /** Backstage results waiting for the next town hour (docs/scheduler.md §4.5); only in memory, like scenes. */
  private backstage: { day: number; notes: BackstageNote[] }[] = [];

  constructor(runtime: Runtime, path: string, state: Checkpoint, confirmed: (commitId: string) => void = () => {}) {
    this.runtime = runtime; this.path = path; this.state = state; this.confirmed = confirmed;
  }
  get initial(): LoadedSave { return this.state.initial; }
  get head(): string { return this.state.head; }
  get closed(): boolean { return !this.live || this.state.phase === 'closed'; }
  get loadNonce(): string { return this.initial.loadNonce; }
  get day(): number { return this.state.day; }
  get player() { return this.initial.player; }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.chain.then(run);
    this.chain = result.then(() => {}, () => {});
    return result;
  }
  settle(): Promise<void> { return this.chain; }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    const handle = await open(temporary, 'w', 0o600);
    try { await handle.writeFile(`${canonical(this.state)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, this.path);
  }

  private async openScope(head: string, day: number): Promise<void> {
    this.scope = await this.runtime.ctx.saves.load({ lineageId: this.initial.lineageId, loadNonce: this.loadNonce, day, commitId: head });
  }

  async restore(): Promise<void> {
    if (this.state.phase === 'closed') { this.live = false; return; }
    const pending = this.state.pending;
    if (this.state.phase === 'confirming') {
      requireValue(pending && this.state.nextDay !== null, 'BAD_CHECKPOINT', '缺少待确认的存档');
      const commit = await this.runtime.ctx.store.call('getCommit', { lineageId: this.initial.lineageId, commitId: pending.commitId });
      if (commit?.status === 'confirmed') await this.openScope(commit.id, this.state.nextDay);
      else {
        await this.openScope(this.state.head, this.state.day);
        await this.scope!.prepare(pending.commitId);
        await this.scope!.confirm(pending.commitId);
        await this.scope!.startDay(this.state.nextDay);
      }
      this.state.head = pending.commitId; this.state.pointer = pending; this.state.day = this.state.nextDay;
      this.state.phase = 'open'; this.state.pending = null; this.state.nextDay = null;
    } else {
      await this.openScope(this.state.head, this.state.day);
      if (this.state.phase === 'preparing' || this.state.phase === 'saving') {
        requireValue(pending, 'BAD_CHECKPOINT', '缺少准备中的存档');
        await this.scope!.prepare(pending.commitId);
        this.state.phase = 'saving';
      }
    }
    // The day entry is durable before its receipt checkpoint. Recover both from the same entry after a crash.
    for (const id of SOCIAL_NPCS) for (const entry of this.scope!.ledger.currentDay?.overlay(id).today ?? []) {
      const receipt = entry.changes[0]?.log?.bridgeReceipt;
      if (receipt && typeof receipt === 'object' && !Array.isArray(receipt)) this.addReceipt(receipt as unknown as Receipt);
    }
    await this.persist();
  }

  private check(message: Event): Receipt | undefined {
    requireValue(message.lineageId === this.initial.lineageId && message.loadNonce === this.loadNonce, 'STALE_LOAD', '忽略上一次读档的消息');
    const hash = digest(canonical(message));
    const receipt = this.state.receipts.find(item => item.seq === message.seq);
    if (receipt) {
      requireValue(receipt.hash === hash, 'SEQUENCE_CONFLICT', '同一个序号包含不同消息');
      return receipt;
    }
    requireValue((this.live && this.state.phase !== 'closed') || (message.type === 'title.returned' && this.state.phase === 'closed'),
      'SAVE_CLOSED', '存档已经退出');
    requireValue(message.seq > this.state.lastSeq, 'STALE_SEQUENCE', '消息序号过旧，不能重新执行');
    return undefined;
  }

  private addReceipt(receipt: Receipt): void {
    if (!this.state.receipts.some(item => item.seq === receipt.seq)) this.state.receipts.push(receipt);
    this.state.receipts.sort((a, b) => a.seq - b.seq);
    this.state.receipts = this.state.receipts.slice(-2000);
    this.state.lastSeq = Math.max(this.state.lastSeq, receipt.seq);
  }

  /** Returns what a closed conversation did to today's appointment, if anything (docs/npc-same-day-meetings.md, docs/npc-call-off.md). */
  async control(message: Exclude<Event, TalkRequest>, onApply: () => void = () => {}): Promise<Settled | undefined> {
    return this.enqueue(async () => {
      if (this.check(message)) return undefined;
      onApply();
      let agreed: Settled | undefined;
      switch (message.type) {
        case 'save.saving': {
          const p = message.commit;
          if (this.state.pending) requireValue(canonical(p) === canonical(this.state.pending), 'COMMIT_CONFLICT', '另一个存档正在准备');
          else {
            requireValue(this.state.phase === 'open' && p.dayEnded === this.day
              && p.parentId === (this.state.pointer?.commitId ?? null), 'COMMIT_CONFLICT', '存档日期或父提交不匹配');
            this.state.phase = 'preparing'; this.state.pending = p;
            await this.persist();
          }
          await this.scope!.prepare(p.commitId);
          this.state.phase = 'saving';
          break;
        }
        case 'save.saved': {
          const nextDay = absoluteDay(message.date);
          if (this.state.phase === 'open' && this.state.pointer?.commitId === message.commitId) {
            requireValue(this.day === nextDay, 'INVALID_DAY', '重复存档的日期不匹配');
            break;
          }
          const p = this.state.pending;
          requireValue(p?.commitId === message.commitId && nextDay >= this.day, 'COMMIT_CONFLICT', '保存成功通知没有对应的准备记录');
          this.state.phase = 'confirming'; this.state.nextDay = nextDay;
          await this.persist();
          await this.scope!.confirm(p.commitId);
          this.state.head = p.commitId; this.state.pointer = p; this.state.day = nextDay;
          await this.scope!.startDay(nextDay);
          this.state.phase = 'open'; this.state.pending = null; this.state.nextDay = null;
          this.confirmed(p.commitId);
          break;
        }
        case 'day.started':
          requireValue(this.state.phase === 'open' && absoluteDay(message.date) === this.day, 'INVALID_DAY', '新的一天尚未完成存档同步');
          break;
        case 'title.returned':
          await this.discardNow(); break;
        case 'talk.close':
          agreed = await this.settleToday(message);
          break;
      }
      this.addReceipt({ seq: message.seq, hash: digest(canonical(message)) });
      await this.persist();
      return agreed;
    });
  }

  /**
   * A conversation that settled an appointment for today, or called today's off, logs it in that NPC's day, so it is
   * saved or rolled back with the day like the conversation itself (docs/npc-same-day-meetings.md,
   * docs/npc-call-off.md). One a day for each NPC, three in all; one called off is not made again.
   */
  private async settleToday(message: TalkClose): Promise<Settled | undefined> {
    const npcId = message.npc.toLowerCase();
    if (this.state.phase !== 'open' || !(SOCIAL_NPCS as readonly string[]).includes(npcId)) return undefined;
    const entries = this.dayEntries(npcId);
    const current = await this.meeting(npcId);
    const receipt: Receipt = { seq: message.seq, hash: digest(canonical(message)) };
    const record = (log: Record<string, unknown>, memories: MemoryDraft[] = []) => this.scope!.agent(npcId).record({ seq: message.seq,
      gameTime: entries.at(-1)!.gameTime, log: { ...log, bridgeReceipt: JSON.parse(canonical(receipt)) }, memories });
    if (current) {
      const by = current.ended || current.calledOff ? null : callOffIn(entries, npcId, current);
      if (!by) return undefined;
      // Sent home while together, the Mod reports how it went; taken back beforehand, it is remembered now.
      const met = openedAtMeeting(entries, npcId);
      const note = met ? undefined : meetingMemory({ ...current, calledOff: by, met: false, left: 0 });
      await record({ meetCalledOff: { by, met } }, note ? [note] : []);
      return { npc: npcId, ...wire({ ...current, calledOff: by }), by, ...(met ? { sentHome: true as const } : {}), ...(note ? { note: note.text } : {}) };
    }
    const meeting = todayAgreement(entries, npcId);
    if (!meeting || (await this.meetings()).length >= MEETS_PER_DAY) return undefined;
    await record({ meetToday: { time: meeting.time, place: meeting.place, soon: meeting.soon === true } });
    return { npc: npcId, ...wire(meeting), ...(meeting.soon ? { soon: meeting.soon } : {}) };
  }

  /** `gifts` are the NPC's card gifts, one of which a close NPC may hand over (docs/npc-in-person-gifts.md). */
  begin(message: TalkRequest, date: GameDate, cancel: AbortSignal, gifts: readonly Gift[] = []): Promise<TalkReply | TurnLease> {
    return this.enqueue(async () => {
      const duplicate = this.check(message);
      if (duplicate?.reply) return duplicate.reply;
      requireValue(!duplicate && this.state.phase === 'open' && absoluteDay(date) === this.day, 'DAY_CLOSED', '当前日期的记忆尚未就绪');
      const npcId = message.npc.toLowerCase();
      const agent = this.scope!.agent(npcId);
      const signal = AbortSignal.any([agent.signal, cancel]);
      signal.throwIfAborted();
      const reader = new AgentMemory(() => agent, { now: () => gameMinutes(date), nextSeq: () => message.seq });
      let staged: { exchange: Exchange; remembered: Remembered[] } | undefined;
      let standing: Standing | undefined;
      const read = async () => {
        signal.throwIfAborted();
        const context = await agent.context({ nowGameTime: gameMinutes(date), limit: 1, maxChars: 1 });
        signal.throwIfAborted();
        return context;
      };
      const memory = withInPersonGift(withMorningPlan({
        context: async (query, current) => { signal.throwIfAborted(); standing = current; return reader.context(query, current); },
        record: async (exchange, remembered) => { signal.throwIfAborted(); staged = { exchange, remembered }; },
      }, { now: () => gameMinutes(date), read }), { gifts, now: () => gameMinutes(date), read: async () => {
        signal.throwIfAborted();
        const found = await agent.context({ topics: [GIVEN_TOPIC], nowGameTime: gameMinutes(date), limit: 5, maxChars: 1000 });
        signal.throwIfAborted();
        return { state: found.state, given: found.memories };
      } });
      return { memory, signal, finish: (result) => this.enqueue(async () => {
        signal.throwIfAborted(); this.check(message);
        requireValue(this.live && this.state.phase === 'open', 'DAY_CLOSED', '这轮对话所属日期已经关闭');
        const envelope: Envelope = { lineageId: message.lineageId, loadNonce: message.loadNonce, seq: message.seq };
        // Opening a conversation says nothing the NPC could feel anything about, and a turn that is not logged
        // could not be counted against the day's range (docs/npc-friendship.md).
        const friendship = message.type === 'talk.open' || !staged || !standing ? 0
          : friendshipPoints(result.meta.mood, friendshipSoFar(this.scope!.ledger.currentDay?.overlay(npcId).today ?? [], npcId), standing);
        // Only the item the code offered, only with a reply that is logged, so the cooldown can see it.
        const gave = staged && result.meta.give ? memory.offered()?.item : undefined;
        const reply: TalkReply = { ...envelope, type: 'talk.reply', npc: message.npc, reply: result.reply,
          emotion: result.meta.emotion, options: result.meta.options, end: result.meta.end, friendship, ...(gave ? { gift: gave } : {}) };
        const receipt: Receipt = { seq: message.seq, hash: digest(canonical(message)), reply };
        if (staged) await agent.record({ seq: message.seq, gameTime: gameMinutes(date),
          // Held at the appointment: sending the NPC home then is told apart from taking it back (docs/npc-call-off.md).
          log: { player: staged.exchange.player, npc: staged.exchange.npc, ...turnLog(standing, this.player),
            ...(message.type === 'talk.open' && message.atMeeting ? { atMeeting: true } : {}),
            ...(friendship ? { friendship } : {}), ...(gave ? { gave } : {}), bridgeReceipt: JSON.parse(canonical(receipt)) },
          memories: [...staged.remembered.map(item => ({ text: item.text, importance: item.importance,
            kind: 'conversation' as const, subjects: ['player'], visibility: 'private' as const })), ...(gave ? [givenMemory(gave)] : [])],
        });
        this.addReceipt(receipt);
        await this.persist();
        return reply;
      }) };
    });
  }

  /**
   * Writes the gift into that NPC's day, like a note from a conversation, so it is saved or rolled back with the
   * day (docs/npc-gifts.md). A resent message is answered from its receipt; one that no longer fits the open day
   * is acknowledged without a note rather than stopping the load. Returns the note, or undefined.
   */
  gift(message: GiftGiven): Promise<string | undefined> {
    return this.enqueue(async () => {
      if (this.check(message)) return undefined;
      const receipt: Receipt = { seq: message.seq, hash: digest(canonical(message)) };
      const npcId = message.npc.toLowerCase();
      const item = giftItemName(message.item);
      const fits = this.state.phase === 'open' && absoluteDay(message.date) === this.day
        && (SOCIAL_NPCS as readonly string[]).includes(npcId) && item !== undefined;
      const note = fits ? giftMemory({ item, taste: message.taste, birthday: message.birthday }) : undefined;
      if (note) await this.scope!.agent(npcId).record({ seq: message.seq, gameTime: gameMinutes(message.date),
        log: { gift: { item: item!, taste: message.taste, birthday: message.birthday }, bridgeReceipt: JSON.parse(canonical(receipt)) },
        memories: [note] });
      this.addReceipt(receipt);
      await this.persist();
      return note?.text;
    });
  }

  /**
   * Writes how an appointment went into that NPC's day, like a gift (docs/npc-meetings.md). A resent message is
   * answered from its receipt; one that no longer fits the open day is acknowledged without a note.
   */
  meetEnded(message: MeetEnded): Promise<string | undefined> {
    return this.enqueue(async () => {
      if (this.check(message)) return undefined;
      const receipt: Receipt = { seq: message.seq, hash: digest(canonical(message)) };
      const npcId = message.npc.toLowerCase();
      const fits = this.state.phase === 'open' && absoluteDay(message.date) === this.day
        && (SOCIAL_NPCS as readonly string[]).includes(npcId) && Object.hasOwn(MEET_PLACES, message.place);
      // Only one who came along can have been in the dungeon with the player.
      const trip = message.mine && message.met ? { ...message.mine } : undefined;
      // One agreed today is remembered as agreed, and as late when it was (docs/npc-same-day-meetings.md); one sent home
      // says so, and one taken back before they met was remembered then (docs/npc-call-off.md).
      const known = fits ? await this.meeting(npcId) : undefined;
      const same = known?.place === message.place ? known : undefined;
      const agreed = same?.sameDay ? { time: same.time, ...(same.soon ? { soon: same.soon } : {}),
        ...(!same.soon && message.time > same.time ? { arrived: message.time } : {}) } : { time: message.time };
      const note = fits && !(same?.calledOff && !same.sentHome) ? meetingMemory({ ...agreed, place: message.place, met: message.met, left: message.left,
        ...(same?.sentHome ? { calledOff: same.calledOff! } : {}), ...(message.helped ? { helped: message.helped } : {}), ...(trip ? { trip } : {}) })
        : undefined;
      // The Mod's change counts against the day's range like a conversation's (docs/npc-meeting-friendship.md).
      if (note) await this.scope!.agent(npcId).record({ seq: message.seq, gameTime: gameMinutes(message.date),
        log: { meeting: { place: message.place, time: message.time, left: message.left, met: message.met, ...(message.helped ? { helped: { ...message.helped } } : {}),
          ...(trip ? { mine: trip } : {}) }, ...(message.friendship ? { friendship: message.friendship } : {}), bridgeReceipt: JSON.parse(canonical(receipt)) },
        memories: [note] });
      this.addReceipt(receipt);
      await this.persist();
      return note?.text;
    });
  }

  /**
   * This NPC's appointment with the player today, written last night (docs/npc-meetings.md) or agreed in a conversation
   * today (docs/npc-same-day-meetings.md), and whether it is over or called off (docs/npc-call-off.md).
   */
  async meeting(npcId: string): Promise<Meeting | undefined> {
    const state = await this.runtime.ctx.store.call('state', { lineageId: this.initial.lineageId, headCommitId: this.state.head, npcId });
    return todayMeeting(meetingFor(state, this.state.day), this.dayEntries(npcId), npcId);
  }

  /** Today's appointments as the Mod gets them, resent when a conversation settles a new one. */
  async meetings(): Promise<DayMeeting[]> {
    const meetings: DayMeeting[] = [];
    for (const npcId of SOCIAL_NPCS) {
      const meeting = await this.meeting(npcId);
      if (meeting) meetings.push({ npc: npcId, ...wire(meeting) });
    }
    return meetings;
  }

  /** Today's events in this NPC's part of the day. */
  private dayEntries(npcId: string) {
    return this.scope?.ledger.currentDay?.overlay(npcId).today ?? [];
  }

  /** What each of these NPCs can tell today, and whose news it already knows (docs/offscreen-news.md). */
  async gossip(npcIds: readonly string[]): Promise<Record<string, Gossip>> {
    const found: Record<string, Gossip> = {};
    for (const npcId of new Set(npcIds)) {
      const state = await this.runtime.ctx.store.call('state', { lineageId: this.initial.lineageId, headCommitId: this.state.head, npcId });
      found[npcId] = gossipOf(npcId, shareFor(state, this.state.day), heardToday(this.dayEntries(npcId), npcId));
    }
    return found;
  }

  noteScene(request: number, transfers: Transfer[]): void {
    if (transfers.length) this.scenes.set(request, { day: this.state.day, transfers });
  }

  /** A model call returns seconds later, when the hour's seq is gone; the next hour writes it under its own seq. */
  noteBackstage(day: number, notes: BackstageNote[]): void {
    if (notes.length && day === this.state.day && !this.closed) this.backstage.push({ day, notes });
  }

  /** Each NPC's festival memories of the last week, newest first, for a backstage scene (docs/scheduler.md §4.3). */
  async festivalsFor(npcIds: readonly string[], now: number): Promise<Record<string, string[]>> {
    const found: Record<string, string[]> = {};
    for (const npcId of npcIds) {
      const memories = await this.scope!.agent(npcId).recall({ topics: [FESTIVAL_TOPIC], sharedScene: true, nowGameTime: now, limit: 8 });
      found[npcId] = memories.filter(memory => now - memory.gameTime <= FESTIVAL_DAYS * 1440)
        .sort((a, b) => b.gameTime - a.gameTime).map(memory => memory.text);
    }
    return found;
  }

  /**
   * Writes what listeners learned, and any backstage notes, as one event in their parts of the day, so it is saved or
   * rolled back with the day. A listener keeps each origin's news once, whoever told it first.
   */
  private async writeHeard(receipt: Receipt, date: GameDate, transfers: readonly Transfer[], name: (id: string) => string,
    notes: readonly BackstageNote[] = []): Promise<Heard[]> {
    const fresh = transfers.filter((transfer, index) => transfer.listener !== transfer.item.origin
      && !heardToday(this.dayEntries(transfer.listener), transfer.listener).some((item) => item.origin === transfer.item.origin)
      && transfers.findIndex((other) => other.listener === transfer.listener && other.item.origin === transfer.item.origin) === index);
    if (!fresh.length && !notes.length) return [];
    const npcIds = [...new Set([...fresh.map((transfer) => transfer.listener), ...notes.map((note) => note.npcId)])];
    await this.scope!.record({ seq: receipt.seq, gameTime: gameMinutes(date), changes: npcIds.map((npcId, index) => {
      const mine = fresh.filter((transfer) => transfer.listener === npcId);
      const own = notes.filter((note) => note.npcId === npcId);
      return { npcId, memories: [...mine.map((transfer) => heardMemory(transfer, name)), ...own.map((note) => note.memory)],
        log: { ...(mine.length ? { heard: mine.map(({ from, item }) => ({ origin: item.origin, from, share: item.share, hand: item.hand })) } : {}),
          ...(own.length ? { backstage: own.map((note) => note.memory.text) } : {}),
          ...(index === 0 ? { bridgeReceipt: JSON.parse(canonical(receipt)) } : {}) } };
    }) });
    return [...fresh.map((transfer) => ({ npcId: transfer.listener, memory: heardMemory(transfer, name) })), ...notes];
  }

  /** What the listeners of a shown scene learned (docs/npc-news.md); a resent or unknown scene writes nothing. */
  sceneShown(message: SceneShown, name: (id: string) => string): Promise<Heard[]> {
    return this.enqueue(async () => {
      if (this.check(message)) return [];
      const receipt: Receipt = { seq: message.seq, hash: digest(canonical(message)) };
      const scene = this.scenes.get(message.request);
      this.scenes.delete(message.request);
      const fits = scene && scene.day === this.day && this.state.phase === 'open' && absoluteDay(message.date) === this.day;
      const heard = fits ? await this.writeHeard(receipt, message.date, scene.transfers, name) : [];
      this.addReceipt(receipt);
      await this.persist();
      return heard;
    });
  }

  /**
   * NPCs who spent the hour together away from the player pass news on in code, without a model call
   * (docs/offscreen-news.md), and the backstage scenes that came back since the last hour are written with it
   * (docs/scheduler.md §4.5). One that no longer fits the open day is acknowledged without effect.
   */
  townHour(message: TownHour, name: (id: string) => string): Promise<Heard[]> {
    return this.enqueue(async () => {
      if (this.check(message)) return [];
      const receipt: Receipt = { seq: message.seq, hash: digest(canonical(message)) };
      let heard: Heard[] = [];
      if (this.state.phase === 'open' && absoluteDay(message.date) === this.day) {
        const groups = message.groups.map((group) => [...new Set(group.map((npc) => npc.toLowerCase()))]
          .filter((id) => (SOCIAL_NPCS as readonly string[]).includes(id))).filter((group) => group.length >= 2);
        const notes = this.backstage.filter((item) => item.day === this.day).flatMap((item) => item.notes);
        this.backstage = [];
        const transfers = groups.length ? spread(groups, await this.gossip(groups.flat())) : [];
        heard = await this.writeHeard(receipt, message.date, transfers, name, notes);
      }
      this.addReceipt(receipt);
      await this.persist();
      return heard;
    });
  }

  /**
   * Writes what happened at a festival into the day of each NPC who remembers it, as one event, so it is saved or
   * rolled back with the day (docs/festival-memories.md). Names outside the cards are ignored; a message that no
   * longer fits the open day is acknowledged without effect.
   */
  festival(message: FestivalEnded, name: (id: string) => string): Promise<Heard[]> {
    return this.enqueue(async () => {
      if (this.check(message)) return [];
      const receipt: Receipt = { seq: message.seq, hash: digest(canonical(message)) };
      const known = (npc: string | undefined) => {
        const id = npc?.toLowerCase();
        return id !== undefined && (SOCIAL_NPCS as readonly string[]).includes(id) ? id : null;
      };
      const santa = message.santa && known(message.santa.recipient) && known(message.santa.giver)
        ? { recipient: known(message.santa.recipient)!, giver: known(message.santa.giver)! } : null;
      // Only the result that belongs to this festival; the others stay null.
      const notes = this.state.phase === 'open' && absoluteDay(message.date) === this.day ? festivalMemories({
        festival: message.festival,
        present: message.npcs.flatMap(npc => known(npc) ?? []),
        dance: message.festival === 'spring24' ? known(message.dance ?? undefined) : null,
        santa: message.festival === 'winter25' ? santa : null,
        contest: message.festival === 'spring13' || message.festival === 'winter8' ? message.contest : null,
        grange: message.festival === 'fall16' ? message.grange : null,
        soup: message.festival === 'summer11' ? message.soup : null,
      }, name) : [];
      if (notes.length) {
        const npcIds = [...new Set(notes.map(note => note.npcId))];
        await this.scope!.record({ seq: message.seq, gameTime: gameMinutes(message.date), changes: npcIds.map((npcId, index) => ({
          npcId, memories: notes.filter(note => note.npcId === npcId).map(note => note.memory),
          log: { festival: message.festival, ...(index === 0 ? { bridgeReceipt: JSON.parse(canonical(receipt)) } : {}) },
        })) });
      }
      this.addReceipt(receipt);
      await this.persist();
      return notes;
    });
  }

  private async discardNow(): Promise<void> {
    this.live = false; this.state.phase = 'closed';
    await this.persist();
    await this.runtime.ctx.saves.returnToTitle(this.initial.lineageId);
    this.scope = undefined;
  }
  discard(): Promise<void> { return this.enqueue(() => this.discardNow()); }

  /**
   * What last night's consolidation left for today: every NPC's bubbles (docs/npc-bubbles.md), the one letter
   * from the NPC whose night mattered most (docs/npc-mail.md), who walks over to the player with the fewest hearts it
   * needs (docs/npc-approach.md), and today's appointments (docs/npc-meetings.md).
   */
  async today(): Promise<{ bubbles: Record<string, Bubble[]>; letters: DeliveredLetter[]; approach: Record<string, number>;
    meetings: DayMeeting[] }> {
    const { lineageId } = this.initial;
    const headCommitId = this.state.head;
    const day = this.state.day;
    const bubbles: Record<string, Bubble[]> = {};
    const approach: Record<string, number> = {};
    const meetings: DayMeeting[] = [];
    let best: { npcId: string; letter: Letter } | undefined;
    for (const npcId of SOCIAL_NPCS) {
      const state = await this.runtime.ctx.store.call('state', { lineageId, headCommitId, npcId });
      const lines = bubblesFor(state, day);
      if (lines.length) bubbles[npcId] = lines;
      const letter = letterFor(state, day);
      if (letter && (!best || letter.importance > best.letter.importance)) best = { npcId, letter };
      const meeting = todayMeeting(meetingFor(state, day), this.dayEntries(npcId), npcId);
      if (meeting) meetings.push({ npc: npcId, ...wire(meeting) });
      // Only the few who chose to last night need their memories and today's part of the day.
      if (state.seek === true && this.scope && !this.closed) {
        const hearts = approachHearts(await this.scope.agent(npcId).context({ nowGameTime: day * 1440, limit: 10, maxChars: 4000 }), day);
        if (hearts !== undefined) approach[npcId] = hearts;
      }
    }
    const letters = best ? [{ key: letterKey(lineageId, headCommitId, best.npcId), npc: best.npcId, text: best.letter.text,
      ...(best.letter.item ? { item: best.letter.item } : {}) }] : [];
    return { bubbles, letters, approach, meetings };
  }
}

/** Only what the Mod needs: one agreed today may come late rather than not at all; one called off is undone. */
function wire(meeting: Meeting): Omit<DayMeeting, 'npc'> {
  return { time: meeting.time, place: meeting.place, ...(meeting.sameDay ? { sameDay: true as const } : {}),
    ...(meeting.calledOff ? { calledOff: true as const } : {}) };
}
