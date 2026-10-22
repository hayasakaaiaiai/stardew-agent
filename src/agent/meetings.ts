/**
 * Appointments with the player: agreed one day, written down that night, kept the next day (docs/npc-meetings.md).
 * The model only names the time, the place and the quoted lines; code checks the quotes and the Mod walks the NPC there.
 */
import { clock } from './schedule.ts';
import { quotedAgreement, quotedPeriodTime } from './meeting-agreement.ts';
import type { MemoryDraft, NpcState } from '../types.ts';

/** The places the Mod has a standing tile for (Meetings.cs), with how people say them. */
export const MEET_PLACES: Readonly<Record<string, RegExp>> = {
  海滩: /海滩|海边|沙滩|码头/,
  镇广场: /广场|镇中心/,
  墓地: /墓地|墓园/,
  山上湖边: /山上|湖/,
  森林河边: /森林|河边|树林/,
  博物馆: /博物馆|图书馆|图书室/,
  星之果实餐吧: /星之果实|餐吧|酒吧|酒馆/,
  杂货店: /杂货店|皮埃尔的店|皮埃尔那/,
  // Not 农场主, which is how everyone calls the player.
  农场: /农场(?!主)|地里|田里/,
  // The doors of the three dungeons; a close NPC met there goes in with the player (docs/npc-mine-companion.md).
  矿洞: /矿洞|矿井|矿坑|下矿|矿里/,
  骷髅洞穴: /骷髅洞|骷髅矿/,
  火山: /火山/,
};

/** Farm chores a close NPC did on arrival (docs/npc-farm-help.md); counts from the Mod. */
export interface Helped { watered: number; harvested: number; fed: number; ponds: number }

/** "浇了 120 格水、收了 35 个作物放进农舍门口的箱子"; what there was nothing of is left out. */
export function helpedText(helped: Helped): string {
  const parts = [
    ...(helped.watered ? [`浇了 ${helped.watered} 格水`] : []),
    ...(helped.harvested ? [`收了 ${helped.harvested} 个作物放进农舍门口的箱子`] : []),
    ...(helped.fed ? [`给动物添了 ${helped.fed} 份干草`] : []),
    ...(helped.ponds ? [`收了 ${helped.ponds} 个鱼塘的产物放进箱子`] : []),
  ];
  return parts.length ? parts.join('、') : '农场里没什么要干的活';
}

/** A trip into a dungeon with the player, from the Mod (docs/npc-mine-companion.md); floors as the game shows them, 0 = the entrance. */
export interface MineTrip { floor: number; deepest: number; kills: number; fights: boolean; rescued: boolean }

const floorName = (place: string, floor: number) => floor ? `${place}第 ${floor} 层` : `${place}入口`;

/** "现在在矿洞第 35 层，最深到过第 40 层，你打倒了 12 只怪物"; one who does not fight is told so. */
export function tripText(place: string, trip: MineTrip): string {
  const deepest = trip.deepest > trip.floor ? `，最深到过第 ${trip.deepest} 层` : '';
  const fight = !trip.fights ? '，你不会打架，只跟在后面' : trip.kills ? `，你打倒了 ${trip.kills} 只怪物` : '';
  return `你一直陪着农场主，现在在${floorName(place, trip.floor)}${deepest}${fight}`;
}

/** The trip as the NPC remembers it afterwards, in its own voice. */
function tripMemory(place: string, trip: MineTrip): string {
  const went = trip.deepest ? `下到${place}第 ${trip.deepest} 层` : `进了${place}`;
  const fight = !trip.fights ? '，我不会打架，一直跟在后面' : trip.kills ? `，打倒了 ${trip.kills} 只怪物` : '';
  return `我陪农场主${went}${fight}${trip.rescued ? '；农场主晕倒了，我把农场主背了出来' : ''}`;
}

const TOMORROW = /明天|明早|明晚|明儿|明日/;
const TIME_WORDS = /早上|早晨|上午|中午|下午|傍晚|晚上|明晚|明早|点|\d{1,2}[:：]\d{2}/;
const EARLIEST = 800;
const LATEST = 2100;
/** How long the NPC waits from the agreed time, and the latest it stays. */
export const MEET_MINUTES = 90;
const MEET_END = 2200;

export interface Meeting {
  /** HHMM, a multiple of ten minutes. */
  time: number;
  place: string;
}

/** What the nightly model wrote, before its quotes are checked. */
export interface MeetDraft { time: string; place: string; sources: string[] }

/** The JSON shape only; anything else means no appointment, never a rejected night. */
export function meetDraft(value: unknown): MeetDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { time, place, sources } = value as Record<string, unknown>;
  if (typeof time !== 'string' || typeof place !== 'string' || !Array.isArray(sources) || !sources.length || sources.length > 4
    || sources.some(id => typeof id !== 'string')) return null;
  return { time, place, sources: [...new Set(sources as string[])] };
}

/**
 * Kept only if the quoted lines exist, the player said one of them, and together they name tomorrow, a time of day and
 * the place; the time must fall between 8:00 and 21:00.
 */
export function checkMeet(draft: MeetDraft | null, sources: readonly { id: string; speaker: '玩家' | 'NPC'; text: string }[]): Meeting | null {
  const words = draft && Object.hasOwn(MEET_PLACES, draft.place) && MEET_PLACES[draft.place];
  const match = draft && /^(\d{1,2})[:：](\d{2})$/.exec(draft.time.trim());
  if (!draft || !words || !match || Number(match[2]) > 59) return null;
  const quoted = draft.sources.map(id => sources.find(source => source.id === id));
  if (quoted.some(source => !source) || !quoted.some(source => source!.speaker === '玩家')) return null;
  const text = quoted.map(source => source!.text).join('\n');
  if (!TOMORROW.test(text) || !TIME_WORDS.test(text) || !words.test(text)) return null;
  const proposed = Number(match[1]) * 100 + Math.floor(Number(match[2]) / 10) * 10;
  if (proposed < EARLIEST || proposed > LATEST) return null;
  const time = quotedPeriodTime(quoted as typeof sources, proposed);
  return time >= EARLIEST && time <= LATEST && quotedAgreement(quoted as typeof sources, sources, words, time) ? { time, place: draft.place } : null;
}

/** Today's appointment, written the night before; a stored one is checked again, like bubbles. */
export function meetingFor(state: NpcState, today: number): Meeting | undefined {
  const meet = state.meet as Record<string, unknown> | null | undefined;
  if (state.day !== today - 1 || !meet || typeof meet !== 'object' || typeof meet.place !== 'string' || !Object.hasOwn(MEET_PLACES, meet.place)
    || !Number.isSafeInteger(meet.time) || (meet.time as number) < EARLIEST || (meet.time as number) > LATEST
    || (meet.time as number) % 10 !== 0 || (meet.time as number) % 100 > 59) return undefined;
  return { time: meet.time as number, place: meet.place };
}

/** HHMM when the NPC leaves the place: ninety minutes after the agreed time, at 22:00 at the latest. */
export function meetingLeave(time: number): number {
  const minutes = Math.floor(time / 100) * 60 + time % 100 + MEET_MINUTES;
  return Math.min(Math.floor(minutes / 60) * 100 + minutes % 60, MEET_END);
}

/**
 * For the NPC's own conversation that day; nothing once it has left the place, unless it is still with the player in a
 * dungeon.
 */
export function meetingLine(meeting: Meeting | undefined, now: number, here: boolean, helped?: Helped, trip?: MineTrip): string | undefined {
  if (!meeting || (now > meetingLeave(meeting.time) && !trip)) return undefined;
  if (trip) return `今天 ${clock(meeting.time)} 在${meeting.place}见面；${tripText(meeting.place, trip)}`;
  return `今天 ${clock(meeting.time)} 在${meeting.place}见面${here ? '，现在就在这里碰面了' : ''}${helped ? `；你来了以后已经${helpedText(helped)}` : ''}`;
}

/** What the NPC remembers once the appointment is over. */
export function meetingMemory(meeting: Meeting & { met: boolean; left: number; helped?: Helped; trip?: MineTrip }): MemoryDraft {
  if (meeting.trip) {
    // A rescue is the kind of thing one remembers for a long time.
    return { text: `约好 ${clock(meeting.time)} 在${meeting.place}见面，农场主来了，${tripMemory(meeting.place, meeting.trip)}。`,
      importance: meeting.trip.rescued ? 4 : 3, kind: 'observation', subjects: ['player'], visibility: 'private' };
  }
  const agreed = `约好 ${clock(meeting.time)} 在${meeting.place}见面${meeting.helped ? `，我${helpedText(meeting.helped)}` : ''}`;
  return meeting.met
    ? { text: `${agreed}，农场主来了。`, importance: 2, kind: 'observation', subjects: ['player'], visibility: 'private' }
    : { text: `${agreed}，我等到 ${clock(meeting.left)}，农场主没来。`, importance: 3, kind: 'observation', subjects: ['player'], visibility: 'private' };
}
