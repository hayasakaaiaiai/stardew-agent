/** Game save coordination around the unchanged M1 memory kernel (docs/game-memory.md). */
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Consolidator } from '../agent/consolidation.ts';
import { type Bubble, bubblesFor } from '../agent/bubbles.ts';
import { AgentMemory, turnLog } from '../agent/dialogue-memory.ts';
import type { DialogueMemory, Exchange, Remembered, Standing, TurnResult } from '../agent/dialogue.ts';
import { type DeliveredLetter, type Letter, letterFor, letterKey } from '../agent/letters.ts';
import { Nightly } from '../agent/nightly.ts';
import { withMorningPlan } from '../agent/morning.ts';
import { createRuntime, type SaveScope } from '../index.ts';
import { SOCIAL_NPCS } from '../types.ts';
import { canonical, digest, requireValue } from '../validation.ts';
import { absoluteDay, gameMinutes, type Envelope, type GameDate, type LoadedSave, type ModMessage, type SavePointer, type TalkReply } from './protocol.ts';

type Runtime = Awaited<ReturnType<typeof createRuntime>>;
type Event = Exclude<ModMessage, { type: 'hello' } | LoadedSave>;
type TalkRequest = Extract<Event, { type: 'talk.open' | 'talk.say' }>;
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
    if (current) await current.discard();
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
    const save = new GameSave(this.runtime, path, state,
      commitId => void this.nightly?.run(initial.lineageId, commitId));
    await save.restore();
    this.active.set(initial.lineageId, save);
    // A crash or a closed backend can leave the last nights unconsolidated.
    void this.nightly?.catchUp(initial.lineageId, save.head);
    return save;
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

  async control(message: Exclude<Event, TalkRequest>, onApply: () => void = () => {}): Promise<void> {
    return this.enqueue(async () => {
      if (this.check(message)) return;
      onApply();
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
          break;
      }
      this.addReceipt({ seq: message.seq, hash: digest(canonical(message)) });
      await this.persist();
    });
  }

  begin(message: TalkRequest, date: GameDate, cancel: AbortSignal): Promise<TalkReply | TurnLease> {
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
      const memory = withMorningPlan({
        context: async (query, current) => { signal.throwIfAborted(); standing = current; return reader.context(query, current); },
        record: async (exchange, remembered) => { signal.throwIfAborted(); staged = { exchange, remembered }; },
      }, { now: () => gameMinutes(date), read: async () => {
        signal.throwIfAborted();
        const context = await agent.context({ nowGameTime: gameMinutes(date), limit: 1, maxChars: 1 });
        signal.throwIfAborted();
        return context;
      } });
      return { memory, signal, finish: (result) => this.enqueue(async () => {
        signal.throwIfAborted(); this.check(message);
        requireValue(this.live && this.state.phase === 'open', 'DAY_CLOSED', '这轮对话所属日期已经关闭');
        const envelope: Envelope = { lineageId: message.lineageId, loadNonce: message.loadNonce, seq: message.seq };
        const reply: TalkReply = { ...envelope, type: 'talk.reply', npc: message.npc, reply: result.reply,
          emotion: result.meta.emotion, options: result.meta.options, end: result.meta.end };
        const receipt: Receipt = { seq: message.seq, hash: digest(canonical(message)), reply };
        if (staged) await agent.record({ seq: message.seq, gameTime: gameMinutes(date),
          log: { player: staged.exchange.player, npc: staged.exchange.npc, ...turnLog(standing, this.player),
            bridgeReceipt: JSON.parse(canonical(receipt)) },
          memories: staged.remembered.map(item => ({ text: item.text, importance: item.importance,
            kind: 'conversation', subjects: ['player'], visibility: 'private' })),
        });
        this.addReceipt(receipt);
        await this.persist();
        return reply;
      }) };
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
   * What last night's consolidation left for today: every NPC's bubbles (docs/npc-bubbles.md), and the one letter
   * from the NPC whose night mattered most (docs/npc-mail.md).
   */
  async today(): Promise<{ bubbles: Record<string, Bubble[]>; letters: DeliveredLetter[] }> {
    const { lineageId } = this.initial;
    const headCommitId = this.state.head;
    const day = this.state.day;
    const bubbles: Record<string, Bubble[]> = {};
    let best: { npcId: string; letter: Letter } | undefined;
    for (const npcId of SOCIAL_NPCS) {
      const state = await this.runtime.ctx.store.call('state', { lineageId, headCommitId, npcId });
      const lines = bubblesFor(state, day);
      if (lines.length) bubbles[npcId] = lines;
      const letter = letterFor(state, day);
      if (letter && (!best || letter.importance > best.letter.importance)) best = { npcId, letter };
    }
    const letters = best ? [{ key: letterKey(lineageId, headCommitId, best.npcId), npc: best.npcId, text: best.letter.text,
      ...(best.letter.item ? { item: best.letter.item } : {}) }] : [];
    return { bubbles, letters };
  }
}
