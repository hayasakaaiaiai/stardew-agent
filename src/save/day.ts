import { Context, Service } from 'cordis';
import type { DayEntry, DayIdentity, DaySnapshot, Memory, NpcState } from '../types.ts';
import { canonical, identifier, integer, materialize, requireValue, sourceId, validateEntry } from '../validation.ts';
import { DayJournal } from './journal.ts';

declare module 'cordis' { interface Context { day: DayTxn } }

export interface DayConfig extends DayIdentity { journalDirectory: string; npcIds: string[] }
export interface Overlay { state: NpcState | undefined; memories: Memory[]; retired: Set<string>; today: DayEntry[] }

export class DayTxn extends Service {
  static inject = ['store'];
  readonly identity: DayIdentity;
  readonly controller = new AbortController();
  private readonly config: DayConfig;
  private readonly allowed: Set<string>;
  private readonly store: Context['store'];
  private entries: DayEntry[] = [];
  private readonly bySequence = new Map<number, string>();
  private chain: Promise<void> = Promise.resolve();
  private journal: DayJournal | undefined;
  private phase: 'open' | 'frozen' | 'closed' = 'open';

  constructor(ctx: Context, config: DayConfig) {
    super(ctx, 'day');
    this.config = config;
    this.store = ctx.store;
    this.identity = { lineageId: config.lineageId, loadNonce: config.loadNonce, baseCommitId: config.baseCommitId, day: config.day };
    this.allowed = new Set(config.npcIds);
    identifier(config.lineageId, 'lineageId'); identifier(config.loadNonce, 'loadNonce');
    identifier(config.baseCommitId, 'baseCommitId'); integer(config.day, 'day', 1);
    ctx.effect(() => () => this.close(false));
  }

  async [Service.init](): Promise<void> {
    const opened = await DayJournal.open(this.config.journalDirectory, this.identity);
    this.journal = opened.journal;
    for (const entry of opened.entries) {
      this.validateRoster(entry);
      this.entries.push(entry);
      this.bySequence.set(entry.seq, canonical(entry));
    }
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get status(): string { return this.phase; }
  get recoveredEntries(): number { return this.entries.length; }

  assertOpen(): void { requireValue(this.phase === 'open', 'DAY_CLOSED', 'This game day is frozen or has been unloaded'); }
  assertReadable(): void { requireValue(this.phase !== 'closed', 'DAY_CLOSED', 'This game day has been unloaded'); }

  stopAccepting(): void {
    if (this.phase === 'open') this.phase = 'frozen';
    this.controller.abort('Game day stopped accepting new events');
  }

  private validateRoster(entry: DayEntry): void {
    for (const change of entry.changes) requireValue(this.allowed.has(change.npcId), 'UNKNOWN_NPC', `Unknown NPC ${change.npcId}`);
  }

  record(entry: DayEntry): Promise<void> {
    this.assertOpen();
    validateEntry(entry);
    this.validateRoster(entry);
    // Detach immediately, before waiting behind another write.
    const encoded = canonical(entry);
    const detached = JSON.parse(encoded) as DayEntry;
    const write = this.chain.then(async () => {
      requireValue(this.phase !== 'closed', 'DAY_CLOSED', 'The event belongs to an unloaded day');
      const existing = this.bySequence.get(detached.seq);
      if (existing !== undefined) {
        requireValue(existing === encoded, 'SEQUENCE_CONFLICT', 'A replayed sequence contains different data');
        return;
      }
      requireValue(detached.seq > (this.entries.at(-1)?.seq ?? 0), 'OUT_OF_ORDER', 'New events must have increasing sequence numbers');
      for (const change of detached.changes) {
        const pendingIds = new Set(this.overlay(change.npcId).memories.map(memory => memory.id));
        const ids = (change.retireMemoryIds ?? []).filter(id => !pendingIds.has(id));
        if (ids.length) await this.store.call('validateRetirements', { scope: { lineageId: this.identity.lineageId,
          headCommitId: this.identity.baseCommitId, npcId: change.npcId }, ids });
      }
      this.assertReadable();
      await this.journal!.append(detached);
      this.assertReadable();
      this.entries.push(detached);
      this.bySequence.set(detached.seq, encoded);
    });
    this.chain = write.catch(() => {});
    return write;
  }

  async freeze(): Promise<DaySnapshot> {
    this.assertReadable();
    this.stopAccepting();
    // Already-admitted events settle before the snapshot; new ones are rejected synchronously.
    await this.chain;
    await this.journal!.flush();
    return structuredClone({ ...this.identity, entries: this.entries });
  }

  overlay(npcId: string): Overlay {
    this.assertReadable();
    const result: Overlay = { state: undefined, memories: [], retired: new Set(), today: [] };
    for (const entry of this.entries) {
      const change = entry.changes.find(item => item.npcId === npcId);
      if (!change) continue;
      result.today.push(structuredClone({ ...entry, changes: [change] }));
      if (change.state !== undefined) result.state = structuredClone(change.state);
      for (const id of change.retireMemoryIds ?? []) result.retired.add(id);
      for (const [index, memory] of (change.memories ?? []).entries()) result.memories.push(
        materialize(structuredClone(memory), npcId, sourceId(this.identity, entry.seq), index, entry.gameTime, null));
    }
    return result;
  }

  async close(remove: boolean): Promise<void> {
    this.phase = 'closed';
    this.controller.abort('Game day unloaded');
    await this.chain;
    await this.journal?.close(remove);
    this.entries = [];
    this.bySequence.clear();
  }
}
