import type { ConsolidationInput, NpcChange } from '../types.ts';
import type { StoreService } from '../services/store/index.ts';
import { requireValue, validateChanges } from '../validation.ts';

export type Consolidator = (input: ConsolidationInput, signal: AbortSignal) => Promise<NpcChange[]>;

/** The caller selects an already-saved commit. The model never receives the live next day. */
export async function consolidateCommit(store: StoreService,
  request: { lineageId: string; commitId: string; npcIds: string[] }, model: Consolidator,
  signal = new AbortController().signal): Promise<void> {
  signal.throwIfAborted();
  const input = await store.call('consolidationInput', request);
  signal.throwIfAborted();
  if (input.completed) return;
  const changes: NpcChange[] = [];
  for (const npc of input.npcs) {
    if (!npc.logs.length) continue;
    signal.throwIfAborted();
    // Model-facing isolation is per NPC, even though the final DB write is one atomic batch.
    const output = await model(structuredClone({ ...input, npcs: [npc] }), signal);
    signal.throwIfAborted();
    validateChanges(output, true);
    for (const change of output) requireValue(change.npcId === npc.npcId, 'UNKNOWN_NPC', 'Consolidation returned an NPC outside the input');
    changes.push(...output);
  }
  validateChanges(changes, true);
  await store.call('consolidate', { lineageId: request.lineageId, commitId: request.commitId, changes });
}
