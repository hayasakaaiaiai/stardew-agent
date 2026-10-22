/** NPCs who walk over to the player the day after deciding to (docs/npc-approach.md). */
import { daysAgo, recallPolicy } from './dialogue-memory.ts';
import { grounded, morningPlan, talkedToday } from './morning.ts';
import type { NpcContext } from '../types.ts';

/** The heart levels where recall's importance floor changes (src/agent/dialogue-memory.ts). */
const HEART_STEPS = [0, 2, 5, 8];

/**
 * The fewest hearts at which this NPC walks over today, or undefined if it should not. It chose to last night
 * (`seek`), has not spoken to the player yet today, and its plan would open the first conversation: recall at that
 * standing reaches a quoted memory from yesterday, as the opening needs (src/agent/morning.ts).
 */
export function approachHearts(context: Pick<NpcContext, 'state' | 'memories' | 'today'>, today: number): number | undefined {
  if (context.state.seek !== true || morningPlan(context.state, today) === undefined || talkedToday(context.today)) return undefined;
  const now = today * 1440;
  const importance = Math.max(0, ...context.memories
    .filter(memory => daysAgo(now, memory.gameTime) === '昨天' && grounded(memory.text)).map(memory => memory.importance));
  return HEART_STEPS.find(hearts => importance >= recallPolicy({ hearts, relation: 'friend' }).minImportance);
}
