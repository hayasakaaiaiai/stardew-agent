import type { Context } from 'cordis';
import type { DayTxn } from '../save/day.ts';
import type { StoreService } from '../services/store/index.ts';
import type { DayEntry, NpcChange, NpcContext, RecallOptions } from '../types.ts';

/** M1 agent handle: independent session state, with shared persistence and retrieval. */
export class NpcAgent {
  static inject = ['save', 'day', 'store'];
  readonly npcId: string;
  readonly signal: AbortSignal;
  private readonly day: DayTxn;
  private readonly store: StoreService;

  constructor(ctx: Context, config: { npcId: string }) {
    this.npcId = config.npcId;
    this.day = ctx.day;
    this.store = ctx.store;
    this.signal = this.day.signal;
    ctx.save.register(this);
    ctx.effect(() => () => ctx.save.unregister(this));
  }

  record(input: Omit<DayEntry, 'changes'> & Omit<NpcChange, 'npcId'>): Promise<void> {
    const { seq, gameTime, ...change } = input;
    return this.day.record({ seq, gameTime, changes: [{ ...change, npcId: this.npcId }] });
  }

  async context(options: RecallOptions): Promise<NpcContext> {
    this.day.assertReadable();
    const overlay = this.day.overlay(this.npcId);
    const scope = { lineageId: this.day.identity.lineageId, headCommitId: this.day.identity.baseCommitId, npcId: this.npcId };
    const result = await this.store.call('context', { scope, options, overlay: { memories: overlay.memories,
      retired: [...overlay.retired], ...(overlay.state === undefined ? {} : { state: overlay.state }) } });
    this.day.assertReadable();
    return { ...result, today: options.sharedScene ? [] : overlay.today };
  }

  async recall(options: RecallOptions) { return (await this.context(options)).memories; }
}
