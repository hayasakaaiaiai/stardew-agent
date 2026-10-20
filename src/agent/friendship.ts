/**
 * How an agent conversation moves vanilla friendship: the `friendship.adjust` action of design §8
 * (docs/npc-friendship.md). The model only rates each player line; the code turns it into points and keeps the
 * day's total for one NPC within range. The Mod checks the same range before changing the game.
 */
import type { Standing } from './dialogue.ts';
import type { DayEntry } from '../types.ts';

/**
 * Points per mood step by how well the NPC knows the player: a stranger is hard to win over and quick to take
 * offence; a close friend warms up easily and forgives easily. The tiers are the ones recall uses
 * (dialogue-memory.ts), so “knowing the player well” means the same everywhere.
 * 250 points make a heart; a vanilla chat gives 20, a loved gift 80.
 */
const STEPS = [
  { minHearts: 8, gain: 20, loss: 5 },
  { minHearts: 5, gain: 15, loss: 10 },
  { minHearts: 2, gain: 10, loss: 15 },
  { minHearts: 0, gain: 5, loss: 20 },
] as const;
const CLOSE = new Set<Standing['relation']>(['dating', 'engaged', 'married', 'roommate']);
export const FRIENDSHIP_DAY_MIN = -40;
export const FRIENDSHIP_DAY_MAX = 30;

const clampDay = (points: number) => Math.max(FRIENDSHIP_DAY_MIN, Math.min(FRIENDSHIP_DAY_MAX, points));

/** Points earlier turns with this NPC already changed today, as written in the day log. */
export function friendshipSoFar(entries: readonly DayEntry[], npcId: string): number {
  return entries.reduce((sum, entry) => {
    const value = entry.changes.find((change) => change.npcId === npcId)?.log?.friendship;
    return sum + (Number.isInteger(value) ? value as number : 0);
  }, 0);
}

export function pointsPerMood(standing: Pick<Standing, 'hearts' | 'relation'>): { gain: number; loss: number } {
  const hearts = CLOSE.has(standing.relation) ? Infinity : standing.hearts;
  return STEPS.find(step => hearts >= step.minHearts) ?? STEPS.at(-1)!;
}

/** What this turn may still change: the mood's points at this standing, cut where the day's total would leave its range. */
export function friendshipPoints(mood: number, soFar: number, standing: Pick<Standing, 'hearts' | 'relation'>): number {
  const steps = Math.max(-2, Math.min(2, Math.trunc(mood) || 0));
  const per = pointsPerMood(standing);
  const wanted = steps * (steps > 0 ? per.gain : per.loss);
  return clampDay(soFar + wanted) - clampDay(soFar);
}
