import { Context, Service } from 'cordis';
import type { Fiber } from 'cordis';
import type { CommitRef, DayEntry } from '../types.ts';
import { identifier, integer, requireValue } from '../validation.ts';
import { NpcAgent } from '../agent/npc.ts';
import { DayTxn } from './day.ts';
import { Ledger } from './ledger.ts';

declare module 'cordis' { interface Context { save: SaveScope } }

export interface LoadSave {
  lineageId: string;
  loadNonce: string;
  day: number;
  /** The exact pointer read from the game save, never an assumed latest commit. */
  commitId?: string;
}

export interface SaveConfig extends LoadSave { journalDirectory: string; npcIds: string[] }

export class SaveScope extends Service {
  static inject = ['store'];
  readonly agents = new Map<string, NpcAgent>();
  readonly agentFibers: Fiber[] = [];
  readonly config: SaveConfig;
  ledger!: Ledger;
  private readonly ownerCtx: Context;
  private dayFiber: Fiber | undefined;
  private dayInstance: DayTxn | undefined;

  constructor(ctx: Context, config: SaveConfig) {
    super(ctx, 'save');
    this.ownerCtx = ctx;
    this.config = config;
    identifier(config.lineageId, 'lineageId'); identifier(config.loadNonce, 'loadNonce');
    integer(config.day, 'day', 1);
    for (const npcId of config.npcIds) this.agentFibers.push(ctx.plugin(NpcAgent, { npcId }));
    ctx.effect(() => async () => { if (this.ledger) await this.ledger.close(false); });
  }

  async [Service.init](): Promise<void> {
    const root = await this.ownerCtx.store.call('root', this.config.lineageId);
    let head = root;
    if (this.config.commitId !== undefined) {
      const commit = await this.ownerCtx.store.call('getCommit', { lineageId: this.config.lineageId, commitId: this.config.commitId });
      requireValue(commit, 'MISSING_COMMIT', 'The game save points to missing Agent data; do not guess a different branch');
      requireValue(this.config.day >= commit.dayEnded, 'INVALID_DAY', 'The loaded day precedes the game save commit');
      head = commit.status === 'prepared'
        ? await this.ownerCtx.store.call('confirm', { lineageId: this.config.lineageId, commitId: commit.id }) : commit;
    }
    this.ledger = new Ledger({
      store: this.ownerCtx.store,
      lineageId: this.config.lineageId,
      loadNonce: this.config.loadNonce,
      openDay: (base, day) => this.openDay(base, day),
      closeDay: remove => this.closeDay(remove),
    }, head);
    await this.ledger.startDay(this.config.day);
  }

  private async openDay(head: CommitRef, day: number): Promise<DayTxn> {
    // Use the provider's context, not Service.this.ctx (which traces to the caller).
    const fiber = this.ownerCtx.plugin(DayTxn, { lineageId: this.config.lineageId, loadNonce: this.config.loadNonce,
      baseCommitId: head.id, day, journalDirectory: this.config.journalDirectory, npcIds: this.config.npcIds });
    this.dayFiber = fiber;
    await fiber;
    requireValue(fiber.ctx.get('day'), 'DAY_INIT_FAILED', 'The day service did not initialize');
    this.dayInstance = fiber.ctx.day;
    return this.dayInstance;
  }

  private async closeDay(remove: boolean): Promise<void> {
    await this.dayInstance?.close(remove);
    await this.dayFiber?.dispose();
    this.dayInstance = undefined;
    this.dayFiber = undefined;
  }

  register(agent: NpcAgent): void {
    requireValue(!this.agents.has(agent.npcId), 'DUPLICATE_NPC', 'NPC agent was registered twice');
    this.agents.set(agent.npcId, agent);
  }

  unregister(agent: NpcAgent): void { if (this.agents.get(agent.npcId) === agent) this.agents.delete(agent.npcId); }

  agent(npcId: string): NpcAgent {
    const agent = this.agents.get(npcId);
    requireValue(agent, 'UNKNOWN_NPC', `NPC ${npcId} is not active`);
    return agent;
  }

  record(entry: DayEntry): Promise<void> {
    requireValue(this.ledger.currentDay, 'DAY_CLOSED', 'No day is active');
    return this.ledger.currentDay.record(entry);
  }

  prepare(commitId: string): Promise<CommitRef> { return this.ledger.prepare(commitId); }
  confirm(commitId: string): Promise<CommitRef> { return this.ledger.confirm(commitId); }
  async startDay(day: number): Promise<void> {
    await this.ledger.startDay(day);
    await Promise.all(this.agentFibers.map(fiber => fiber.await()));
  }
}
