import { Context, Service } from 'cordis';
import type { Fiber } from 'cordis';
import { DayJournal } from './journal.ts';
import { SaveScope } from './scope.ts';
import type { LoadSave } from './scope.ts';
import { requireValue } from '../validation.ts';

declare module 'cordis' { interface Context { saves: SaveManager } }

export interface SavesConfig { journalDirectory: string; npcIds: string[] }

export class SaveManager extends Service {
  static inject = ['store'];
  private readonly ownerCtx: Context;
  private readonly config: SavesConfig;
  private readonly loaded = new Map<string, { save: SaveScope; fiber: Fiber }>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(ctx: Context, config: SavesConfig) {
    super(ctx, 'saves');
    this.ownerCtx = ctx;
    this.config = config;
  }

  private enqueue<T>(lineageId: string, run: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(lineageId) ?? Promise.resolve()).then(run);
    const settled = result.then(() => {}, () => {});
    this.queues.set(lineageId, settled);
    void settled.then(() => { if (this.queues.get(lineageId) === settled) this.queues.delete(lineageId); });
    return result;
  }

  load(input: LoadSave): Promise<SaveScope> {
    return this.enqueue(input.lineageId, async () => {
      const existing = this.loaded.get(input.lineageId)?.save;
      const day = existing?.ledger.currentDay;
      if (existing && day?.status === 'open' && day.identity.loadNonce === input.loadNonce
        && day.identity.day === input.day && (input.commitId === day.identity.baseCommitId
          || (input.commitId === undefined && existing.ledger.head.parentId === null))) return existing;
      await this.unload(input.lineageId, true);
      const ctx = this.ownerCtx.isolate('save').isolate('day');
      const fiber = ctx.plugin(SaveScope, { ...input, ...this.config });
      try {
        await fiber;
        requireValue(fiber.ctx.get('save'), 'SAVE_INIT_FAILED', 'Save scope did not initialize');
        const save = fiber.ctx.save;
        await Promise.all(save.agentFibers.map(agentFiber => agentFiber.await()));
        requireValue(save.agents.size === this.config.npcIds.length, 'AGENT_INIT_FAILED', 'Not all NPC session handles initialized');
        this.loaded.set(input.lineageId, { save, fiber });
        // Only after this load is up, so a failed load never costs the previous one its journal.
        await DayJournal.prune(this.config.journalDirectory, input.lineageId, input.loadNonce);
        return save;
      } catch (error) { await fiber.dispose(); throw error; }
    });
  }

  returnToTitle(lineageId: string): Promise<void> {
    return this.enqueue(lineageId, () => this.unload(lineageId, true));
  }

  private async unload(lineageId: string, discard: boolean): Promise<void> {
    const current = this.loaded.get(lineageId);
    if (!current) return;
    await current.save.ledger.close(discard);
    await current.fiber.dispose();
    this.loaded.delete(lineageId);
  }
}
