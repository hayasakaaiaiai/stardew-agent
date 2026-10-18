import { Context } from 'cordis';
import { StoreService } from './services/store/index.ts';
import { SaveManager } from './save/manager.ts';
import { SOCIAL_NPCS } from './types.ts';
import { identifier, requireValue } from './validation.ts';

export interface RuntimeConfig {
  databasePath: string;
  journalDirectory: string;
  npcIds?: readonly string[];
}

/** Only two global services and one DB Worker, regardless of the NPC count. */
export async function createRuntime(config: RuntimeConfig) {
  const npcIds = [...(config.npcIds ?? SOCIAL_NPCS)];
  for (const npcId of npcIds) identifier(npcId, 'npcId');
  requireValue(npcIds.length > 0 && npcIds.length <= 100 && new Set(npcIds).size === npcIds.length,
    'INVALID_INPUT', 'Provide 1–100 distinct NPC IDs');
  const ctx = new Context();
  try {
    const store = ctx.plugin(StoreService, { databasePath: config.databasePath });
    await store;
    requireValue(ctx.get('store'), 'STORE_INIT_FAILED', 'Memory store failed to initialize');
    const saves = ctx.plugin(SaveManager, { journalDirectory: config.journalDirectory, npcIds });
    await saves;
    return { ctx, close: () => ctx.fiber.dispose() };
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}

export type { LoadSave, SaveScope } from './save/scope.ts';
export type { NpcAgent } from './agent/npc.ts';
export * from './types.ts';
export { consolidateCommit } from './agent/consolidation.ts';
export type { Consolidator } from './agent/consolidation.ts';
