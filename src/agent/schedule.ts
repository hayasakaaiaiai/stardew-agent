/**
 * Where an NPC goes today, from the game's own schedule (docs/npc-schedules.md). The game decides where NPCs walk,
 * so this is the one thing about their day the prompts can state as fact; no model call makes it.
 */

/** One stop of the day's schedule, as the Mod reports it. */
export interface ScheduleStop {
  /** When the NPC sets off, e.g. 1630. */
  time: number;
  /** The destination's display name. */
  place: string;
  /** Goes to bed there. */
  sleep: boolean;
}

/** A day has at most 6 stops once repeats are merged (docs/npc-schedules.md §3); more is not a real schedule. */
export const MAX_STOPS = 24;

/** 1530 → "15:30"; the game clock runs to 2600, i.e. 2 a.m. */
export function clock(time: number): string {
  const hours = Math.floor(time / 100) % 24;
  const minutes = time % 100;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** In time order, with walks around the same place merged into one stop. */
function merged(stops: readonly ScheduleStop[]): ScheduleStop[] {
  if (stops.length > MAX_STOPS) return [];
  return [...stops].sort((a, b) => a.time - b.time)
    .filter((stop, i, all) => i === 0 || stop.place !== all[i - 1]!.place || stop.sleep !== all[i - 1]!.sleep);
}

/** Going to bed is said as going home, unless the NPC is already there. */
function label(stop: ScheduleStop, previous: ScheduleStop | undefined, go = ''): string {
  if (!stop.sleep) return `${go}${stop.place}`;
  return previous?.place === stop.place ? '睡觉' : '回家睡觉';
}

/** The stop the NPC is on now and the rest of the day, for its own conversation: "13:00 鹈鹕镇，19:30 回家睡觉". */
export function restOfDay(stops: readonly ScheduleStop[], now: number): string | undefined {
  const day = merged(stops);
  const current = Math.max(0, day.findLastIndex((stop) => stop.time <= now));
  const rest = day.slice(current).map((stop, i) => `${clock(stop.time)} ${label(stop, day[current + i - 1])}`);
  return rest.length ? rest.join('，') : undefined;
}

/** Only the next stop, for scenes between NPCs: "16:30 去皮埃尔的杂货店". */
export function nextStop(stops: readonly ScheduleStop[], now: number): string | undefined {
  const day = merged(stops);
  const next = day.findIndex((stop) => stop.time > now);
  return next < 0 ? undefined : `${clock(day[next]!.time)} ${label(day[next]!, day[next - 1], '去')}`;
}

/** "- 接下来：a 17:00 去星之果实餐吧；b 23:00 回家睡觉"; nothing when nobody has a next stop. */
export function nextStopsLine(next: readonly (string | undefined)[], letters: readonly string[]): string | undefined {
  const parts = next.flatMap((stop, i) => stop ? [`${letters[i]} ${stop}`] : []);
  return parts.length ? `- 接下来：${parts.join('；')}` : undefined;
}
