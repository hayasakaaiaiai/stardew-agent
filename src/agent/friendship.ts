/**
 * How an agent conversation moves vanilla friendship: the `friendship.adjust` action of design §8
 * (docs/npc-friendship.md). The model only rates each player line; the code turns it into points and keeps the
 * day's total for one NPC within range. The Mod checks the same range before changing the game.
 */
import type { DayEntry } from '../types.ts';

/** Points per mood step. 250 points make a heart; a vanilla chat gives 20, a loved gift 80. */
const POINTS_PER_MOOD = 10;
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

/** What this turn may still change: the mood's points, cut where the day's total would leave its range. */
export function friendshipPoints(mood: number, soFar: number): number {
  const wanted = Math.max(-2, Math.min(2, Math.trunc(mood) || 0)) * POINTS_PER_MOOD;
  return clampDay(soFar + wanted) - clampDay(soFar);
}
