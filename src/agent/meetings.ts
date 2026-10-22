/**
 * Appointments with the player: agreed one day, written down that night, kept the next day (docs/npc-meetings.md).
 * The model only names the time, the place and the quoted lines; code checks the quotes and the Mod walks the NPC there.
 */
import { clock } from './schedule.ts';
import { OPENING_LINE, SEASONS } from './dialogue.ts';
import { asksToMeet, type CallOff, type LaterAgreement, namedDays, quotedAgreement, quotedCallOff, quotedLater, quotedLaterCallOff, quotedPeriodTime, quotedToday,
  type TimedQuote } from './meeting-agreement.ts';
import type { DayEntry, Memory, MemoryDraft, NpcState } from '../types.ts';

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
  /** Agreed in a conversation today, not last night (docs/npc-same-day-meetings.md). */
  sameDay?: true;
  /** Agreed as "right away"; `time` is when it was agreed. */
  soon?: true;
  /** The Mod has reported how it went. */
  ended?: true;
  /** Taken back, or the NPC sent home, in a later conversation, by whom (docs/npc-call-off.md). */
  calledOff?: CallOff;
  /** Called off while they were together: the Mod reports it, and the memory says so. */
  sentHome?: true;
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

/** "约好 14:00 在海滩见面", or "约好马上去矿洞见面" for one agreed as right away. */
const agreedText = (meeting: Meeting) => meeting.soon ? `约好马上去${meeting.place}见面` : `约好 ${clock(meeting.time)} 在${meeting.place}见面`;

/**
 * For the NPC's own conversation that day; nothing once it has left the place, unless it is still with the player in a
 * dungeon. One agreed today may arrive late, so it lasts until the Mod reports it over.
 */
export function meetingLine(meeting: Meeting | undefined, now: number, here: boolean, helped?: Helped, trip?: MineTrip): string | undefined {
  if (!meeting || meeting.calledOff || !trip && (meeting.sameDay ? meeting.ended || now >= MEET_END : now > meetingLeave(meeting.time))) return undefined;
  const agreed = meeting.soon ? `今天 ${clock(meeting.time)} ${agreedText(meeting)}` : `今天 ${clock(meeting.time)} 在${meeting.place}见面`;
  if (trip) return `${agreed}；${tripText(meeting.place, trip)}`;
  return `${agreed}${here ? '，现在就在这里碰面了' : ''}${helped ? `；你来了以后已经${helpedText(helped)}` : ''}`;
}

/**
 * What the NPC remembers once the appointment is over, or once it was called off before they met; `arrived` is when one
 * agreed today got there late.
 */
export function meetingMemory(meeting: Meeting & { met: boolean; left: number; helped?: Helped; trip?: MineTrip; arrived?: number }): MemoryDraft {
  const late = meeting.arrived ? `，我 ${clock(meeting.arrived)} 才到` : '';
  const sent = meeting.met && meeting.calledOff ? meeting.calledOff === '玩家' ? '，后来农场主让我先回去了' : '，后来我先回去了' : '';
  if (meeting.trip) {
    // A rescue is the kind of thing one remembers for a long time.
    return { text: `${agreedText(meeting)}${late}，农场主来了，${tripMemory(meeting.place, meeting.trip)}${sent}。`,
      importance: meeting.trip.rescued ? 4 : 3, kind: 'observation', subjects: ['player'], visibility: 'private' };
  }
  if (meeting.calledOff && !meeting.met) {
    return { text: `${agreedText(meeting)}，后来${meeting.calledOff === '玩家' ? '农场主说不去了' : '我跟农场主说去不了了'}。`, importance: 2,
      kind: 'observation', subjects: ['player'], visibility: 'private' };
  }
  const agreed = `${agreedText(meeting)}${late}${meeting.helped ? `，我${helpedText(meeting.helped)}` : ''}`;
  return meeting.met
    ? { text: `${agreed}，农场主来了${sent}。`, importance: 2, kind: 'observation', subjects: ['player'], visibility: 'private' }
    : { text: `${agreed}，我等到 ${clock(meeting.left)}，农场主没来。`, importance: 3, kind: 'observation', subjects: ['player'], visibility: 'private' };
}

/** At most this many appointments a day, as the Mod keeps (Meetings.cs). */
export const MEETS_PER_DAY = 3;

/** HHMM of an absolute game minute; after midnight counts on from 24:00, like the game clock. */
function hhmm(gameTime: number): number {
  const minutes = gameTime % 1440;
  const time = Math.floor(minutes / 60) * 100 + minutes % 60;
  return time < 600 ? time + 2400 : time;
}

type TurnLog = { player: string; npc: string; atMeeting?: true };
const turnOf = (entry: DayEntry, npcId: string) => {
  const log = entry.changes.find(change => change.npcId === npcId)?.log as Partial<TurnLog> | undefined;
  return log && typeof log.player === 'string' && typeof log.npc === 'string' ? log as TurnLog : undefined;
};

/**
 * The conversation that just ended, from its opening on, as quotes the code can check (docs/npc-same-day-meetings.md).
 * Speakers come from the saved log; the opening stage direction is not something the player said.
 */
export function lastConversation(entries: readonly DayEntry[], npcId: string): TimedQuote[] {
  const turns = entries.flatMap(entry => { const turn = turnOf(entry, npcId); return turn ? [{ ...turn, time: hhmm(entry.gameTime) }] : []; });
  const opened = turns.findLastIndex(turn => turn.player === OPENING_LINE);
  return turns.slice(Math.max(0, opened)).flatMap((turn, index) => [
    ...(turn.player === OPENING_LINE ? [] : [{ id: `p${index}`, speaker: '玩家' as const, text: turn.player, time: turn.time }]),
    { id: `n${index}`, speaker: 'NPC' as const, text: turn.npc, time: turn.time },
  ]);
}

/** What `talk.close` logs when the conversation settled an appointment for today. */
export function todayAgreement(entries: readonly DayEntry[], npcId: string, today: number): Meeting | null {
  const found = quotedToday(lastConversation(entries, npcId), MEET_PLACES, today);
  return found && { time: found.time, place: found.place, sameDay: true, ...(found.soon ? { soon: true as const } : {}) };
}

/** Whether the conversation that just ended was held at the appointment, with the NPC there or along. */
export function openedAtMeeting(entries: readonly DayEntry[], npcId: string): boolean {
  const opening = entries.findLast(entry => turnOf(entry, npcId)?.player === OPENING_LINE);
  return opening !== undefined && turnOf(opening, npcId)!.atMeeting === true;
}

/** Whether the conversation that just ended took today's appointment back, or sent the NPC home (docs/npc-call-off.md). */
export function callOffIn(entries: readonly DayEntry[], npcId: string, meeting: Meeting, today: number): CallOff | null {
  return quotedCallOff(lastConversation(entries, npcId), MEET_PLACES[meeting.place]!, MEET_PLACES, today);
}

/**
 * Today's appointment: last night's, or else one agreed in a conversation today (docs/npc-same-day-meetings.md), with
 * what the day's log says became of it: reported over by the Mod, or called off in a later conversation
 * (docs/npc-call-off.md).
 */
export function todayMeeting(nightly: Meeting | undefined, entries: readonly DayEntry[], npcId: string): Meeting | undefined {
  let meeting = nightly && { ...nightly };
  for (const entry of entries) {
    const log = entry.changes.find(change => change.npcId === npcId)?.log as Record<string, unknown> | undefined;
    const agreed = log?.meetToday as Record<string, unknown> | undefined;
    const off = log?.meetCalledOff as Record<string, unknown> | undefined;
    if (!meeting && agreed && typeof agreed.place === 'string' && Object.hasOwn(MEET_PLACES, agreed.place)
      && Number.isSafeInteger(agreed.time) && (agreed.time as number) % 10 === 0 && (agreed.time as number) % 100 <= 59)
      meeting = { time: agreed.time as number, place: agreed.place, sameDay: true, ...(agreed.soon === true ? { soon: true as const } : {}) };
    else if (meeting && log?.meeting) meeting.ended = true;
    else if (meeting && off && (off.by === '玩家' || off.by === 'NPC'))
      Object.assign(meeting, { calledOff: off.by }, off.met === true ? { sentHome: true } : {});
  }
  return meeting;
}

/**
 * Appointments for a later day than tomorrow are kept as the NPC's own notes, tagged with this topic and the day, so
 * they are saved or rolled back with the day they were made, like a gift handed over (docs/npc-later-meetings.md).
 */
export const LATER_TOPIC = '以后的约定';
const dayTopic = (day: number) => `约定日:${day}`;
const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const SEASON_ORDER = ['spring', 'summer', 'fall', 'winter'] as const;

/** "春季 12 日（周六）"; with `today`, "明天（周六）" and "后天（周六）" for the next two days. */
export function dayLabel(day: number, today?: number): string {
  const weekday = WEEKDAY_NAMES[(day - 1) % 7]!;
  if (today !== undefined && day - today === 1) return `明天（${weekday}）`;
  if (today !== undefined && day - today === 2) return `后天（${weekday}）`;
  return `${SEASONS[SEASON_ORDER[Math.floor((day - 1) / 28) % 4]!]} ${(day - 1) % 28 + 1} 日（${weekday}）`;
}

export interface LaterMeeting extends Meeting { day: number }

const laterText = (meeting: LaterMeeting) => `约好${dayLabel(meeting.day)}${clock(meeting.time)} 在${meeting.place}见面`;

/** The note that keeps it: "约好春季 12 日（周六）14:00 在海滩见面。" */
export function laterNote(agreement: LaterAgreement): MemoryDraft {
  return { text: `${laterText(agreement)}。`, importance: 3, kind: 'observation', subjects: ['player'], visibility: 'private',
    topics: [LATER_TOPIC, dayTopic(agreement.day), `约定:${agreement.time}:${agreement.place}`] };
}

/** Taken back before the day: "……，后来农场主说不去了。" It hides the appointment on that day. */
export function laterCallOffNote(meeting: LaterMeeting, by: CallOff): MemoryDraft {
  return { text: `${laterText(meeting)}，后来${by === '玩家' ? '农场主说不去了' : '我跟农场主说去不了了'}。`, importance: 2, kind: 'observation',
    subjects: ['player'], visibility: 'private', topics: [LATER_TOPIC, dayTopic(meeting.day), '约定取消'] };
}

/** The appointments the notes still hold, by day: the latest note for a day decides, and a call-off note leaves none. */
export function laterMeetings(notes: readonly Pick<Memory, 'topics' | 'gameTime'>[]): LaterMeeting[] {
  const latest = new Map<number, Pick<Memory, 'topics' | 'gameTime'>>();
  for (const note of notes) {
    const day = Number(note.topics.find(topic => topic.startsWith('约定日:'))?.slice('约定日:'.length));
    if (Number.isSafeInteger(day) && day > 0 && (latest.get(day)?.gameTime ?? -1) <= note.gameTime) latest.set(day, note);
  }
  return [...latest].flatMap(([day, note]) => {
    const kept = /^约定:(\d{3,4}):(.+)$/.exec(note.topics.find(topic => topic.startsWith('约定:')) ?? '');
    const time = Number(kept?.[1]);
    return kept && Object.hasOwn(MEET_PLACES, kept[2]!) && time >= 800 && time <= 2100 && time % 10 === 0 && time % 100 <= 59
      ? [{ day, time, place: kept[2]! }] : [];
  }).sort((a, b) => a.day - b.day);
}

/** Appointments go no further than the day after tomorrow; the user wants NPCs to turn down later ones. */
const NEAR_DAYS = 2;

/**
 * The far day a player's invitation names, beyond the day after tomorrow, as the NPC is told it this turn so it turns it
 * down: "下周三（6 天后）", "下个月"; undefined for a line that names none, or does not ask to meet (docs/npc-later-meetings.md).
 */
export function farInvitation(text: string, today: number): string | undefined {
  if (!asksToMeet(text)) return undefined;
  const days = namedDays(text, today);
  const far = Math.max(0, ...days);
  if (far > today + NEAR_DAYS) return `${far - today} 天后的${dayLabel(far)}`;
  if (days.some(day => day > today)) return undefined;
  return /下个?月/.test(text) ? '下个月' : /下个?(?:星期|礼拜|周)/.test(text) ? '下周' : undefined;
}

/** The line for that turn; measured to turn far invitations down 12/12 against 3/12 without (docs/npc-later-meetings.md §3). */
export const farInvitationLine = (label: string) => `- 农场主约的是${label}，太远了：你只答应三天内（今天、明天、后天）的约定，这次婉拒，说到时候再约。`;

/** The nearest one ahead, for the NPC's own conversation: "后天（周六）14:00 在海滩见面". */
export function upcomingLine(upcoming: readonly LaterMeeting[], today: number): string | undefined {
  const next = upcoming.find(meeting => meeting.day > today);
  return next && `${dayLabel(next.day, today)}${clock(next.time)} 在${next.place}见面`;
}

/** What the conversation that just ended agreed for a later day, or took back of those already made. */
export function laterIn(entries: readonly DayEntry[], npcId: string, upcoming: readonly LaterMeeting[], today: number):
  { agreed: LaterAgreement | null; calledOff: { meeting: LaterMeeting; by: CallOff }[] } {
  const lines = lastConversation(entries, npcId);
  const calledOff = upcoming.flatMap(meeting => {
    const by = quotedLaterCallOff(lines, MEET_PLACES[meeting.place]!, MEET_PLACES, meeting.day, today);
    return by ? [{ meeting, by }] : [];
  });
  return { agreed: quotedLater(lines, MEET_PLACES, today), calledOff };
}
