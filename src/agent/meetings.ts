/**
 * Appointments with the player: agreed one day, written down that night, kept the next day (docs/npc-meetings.md).
 * The model only names the time, the place and the quoted lines; code checks the quotes and the Mod walks the NPC there.
 */
import { clock } from './schedule.ts';
import { OPENING_LINE, SEASONS } from './dialogue.ts';
import { asksToMeet, type CallOff, type Change, type Invitation, type Kept, type LaterAgreement, namedDays, quotedAgreement, quotedCallOff, quotedChange, quotedDecline,
  quotedInvite,
  quotedLater, quotedLaterCallOff,
  quotedPeriodTime, quotedToday,
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

/**
 * Farm chores a close NPC did on arrival (docs/npc-farm-help.md), and the animals tended (docs/npc-farm-animals.md);
 * counts from the Mod. An older Mod sends no animal counts.
 */
export interface Helped {
  watered: number; harvested: number; fed: number; ponds: number;
  collected?: number; milked?: number; sheared?: number; petted?: number; truffles?: number;
}

/** "浇了 120 格水、收了 35 个作物放进农舍门口的箱子"; what there was nothing of is left out. */
export function helpedText(helped: Helped): string {
  const parts = [
    ...(helped.watered ? [`浇了 ${helped.watered} 格水`] : []),
    ...(helped.harvested ? [`收了 ${helped.harvested} 个作物放进农舍门口的箱子`] : []),
    ...(helped.fed ? [`给动物添了 ${helped.fed} 份干草`] : []),
    ...(helped.ponds ? [`收了 ${helped.ponds} 个鱼塘的产物放进箱子`] : []),
    ...(helped.collected ? [`捡了 ${helped.collected} 个鸡舍里的产品放进箱子`] : []),
    ...(helped.milked ? [`挤了 ${helped.milked} 只动物的奶`] : []),
    ...(helped.sheared ? [`剪了 ${helped.sheared} 只羊的毛`] : []),
    ...(helped.petted ? [`摸了 ${helped.petted} 只动物`] : []),
    ...(helped.truffles ? [`捡了 ${helped.truffles} 个松露`] : []),
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

/**
 * What the NPC saw the player do after they met somewhere ordinary, from the Mod (docs/npc-outing.md): places as the
 * game shows them, in the order first visited (at most six), and the first three kinds of fish caught.
 */
export interface Outing {
  places: string[]; here: string;
  fish: number; fishNames: string[]; escaped: number; treasures: number; foraged: number; artifacts: number;
}

/** "钓到 2 条鱼（鲈鱼、沙丁鱼），跑了 1 条，捡了 3 个采集物"; empty when the player did none of it. */
function outingDone(outing: Outing): string {
  const names = outing.fishNames.length ? `（${outing.fishNames.join('、')}）` : '';
  return [
    ...(outing.fish ? [`钓到 ${outing.fish} 条鱼${names}`] : []),
    ...(outing.escaped ? [`${outing.fish ? '' : '钓鱼'}跑了 ${outing.escaped} 条`] : []),
    ...(outing.treasures ? [`钓到 ${outing.treasures} 个宝箱`] : []),
    ...(outing.foraged ? [`捡了 ${outing.foraged} 个采集物`] : []),
    ...(outing.artifacts ? [`挖到 ${outing.artifacts} 件古物`] : []),
  ].join('，');
}

/** "你一直陪着农场主，从海滩到了鹈鹕镇；农场主钓到 2 条鱼（鲈鱼、沙丁鱼）", for a talk while together. */
export function outingText(outing: Outing): string {
  const { places, here } = outing;
  const where = places.length <= 1 ? `现在在${here}`
    : here === places.at(-1) ? `从${places[0]}到了${places.slice(1).join('、')}` : `去过${places.join('、')}，现在在${here}`;
  const done = outingDone(outing);
  return `你一直陪着农场主，${where}${done ? `；农场主${done}` : ''}`;
}

/** The outing as the NPC remembers it afterwards, in its own voice. */
function outingMemory(outing: Outing): string {
  const { places } = outing;
  const where = places.length <= 1 ? `在${places[0] ?? outing.here}走了走` : `从${places[0]}到了${places.slice(1).join('、')}`;
  const done = outingDone(outing);
  return `我陪农场主${where}${done ? `，看农场主${done}` : ''}`;
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
  /** Taken off today because it moved to another day: where to, for the Mod's notice (docs/npc-meetings-more.md §1). */
  movedTo?: string;
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
export function meetingLine(meeting: Meeting | undefined, now: number, here: boolean, helped?: Helped, trip?: MineTrip,
  outing?: Outing): string | undefined {
  if (!meeting || meeting.calledOff || !trip && !outing && (meeting.sameDay ? meeting.ended || now >= MEET_END : now > meetingLeave(meeting.time))) return undefined;
  const agreed = meeting.soon ? `今天 ${clock(meeting.time)} ${agreedText(meeting)}` : `今天 ${clock(meeting.time)} 在${meeting.place}见面`;
  if (trip) return `${agreed}；${tripText(meeting.place, trip)}`;
  if (outing) return `${agreed}；${outingText(outing)}`;
  return `${agreed}${here ? '，现在就在这里碰面了' : ''}${helped ? `；你来了以后已经${helpedText(helped)}` : ''}`;
}

/**
 * What the NPC remembers once the appointment is over, or once it was called off before they met; `arrived` is when one
 * agreed today got there late.
 */
export function meetingMemory(meeting: Meeting & { met: boolean; left: number; helped?: Helped; trip?: MineTrip; outing?: Outing; arrived?: number }): MemoryDraft {
  const late = meeting.arrived ? `，我 ${clock(meeting.arrived)} 才到` : '';
  const sent = meeting.met && meeting.calledOff ? meeting.calledOff === '玩家' ? '，后来农场主让我先回去了' : '，后来我先回去了' : '';
  if (meeting.trip) {
    // A rescue is the kind of thing one remembers for a long time.
    return { text: `${agreedText(meeting)}${late}，农场主来了，${tripMemory(meeting.place, meeting.trip)}${sent}。`,
      importance: meeting.trip.rescued ? 4 : 3, kind: 'observation', subjects: ['player'], visibility: 'private' };
  }
  // Time spent together is remembered like a trip into the mines.
  if (meeting.outing && meeting.met) {
    return { text: `${agreedText(meeting)}${late}，农场主来了，${outingMemory(meeting.outing)}${sent}。`, importance: 3, kind: 'observation',
      subjects: ['player'], visibility: 'private' };
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

type TurnLog = { player: string; npc: string; atMeeting?: true; invited?: true };
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

/**
 * The conversation that just ended opened with the NPC asking the player out (docs/npc-invites.md): what the player
 * said yes to, if anything, and how many lines that opening exchange takes, which the other checks leave to it.
 */
export function invitedIn(entries: readonly DayEntry[], npcId: string, today: number): { invitation: Invitation | null; opening: number } {
  const opening = entries.findLast(entry => turnOf(entry, npcId)?.player === OPENING_LINE);
  if (!opening || turnOf(opening, npcId)!.invited !== true) return { invitation: null, opening: 0 };
  return { invitation: quotedInvite(lastConversation(entries, npcId), MEET_PLACES, today), opening: 2 };
}

/** What `talk.close` logs when the conversation settled an appointment for today; `skip` leaves an invitation's opening out. */
export function todayAgreement(entries: readonly DayEntry[], npcId: string, today: number, skip = 0): Meeting | null {
  const found = quotedToday(lastConversation(entries, npcId).slice(skip), MEET_PLACES, today);
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
    const moved = log?.meetChanged as Record<string, unknown> | undefined;
    if (!meeting && agreed && typeof agreed.place === 'string' && Object.hasOwn(MEET_PLACES, agreed.place)
      && Number.isSafeInteger(agreed.time) && (agreed.time as number) % 10 === 0 && (agreed.time as number) % 100 <= 59)
      meeting = { time: agreed.time as number, place: agreed.place, sameDay: true, ...(agreed.soon === true ? { soon: true as const } : {}) };
    else if (meeting && log?.meeting) meeting.ended = true;
    else if (meeting && off && (off.by === '玩家' || off.by === 'NPC'))
      Object.assign(meeting, { calledOff: off.by }, off.met === true ? { sentHome: true } : {}, typeof off.movedTo === 'string' ? { movedTo: off.movedTo } : {});
    // Moved within today: agreed anew today, at the new time and place (docs/npc-meetings-more.md §1).
    else if (meeting && !meeting.ended && !meeting.calledOff && moved && typeof moved.place === 'string' && Object.hasOwn(MEET_PLACES, moved.place)
      && Number.isSafeInteger(moved.time)) {
      meeting = { time: moved.time as number, place: moved.place, sameDay: true };
    }
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

/**
 * Being stood up stays with the NPC three days, being turned down one (docs/npc-meetings-more.md §2): the memory of it
 * carries this topic and what happened, so the NPC's talks those days can say so.
 */
export const MOOD_TOPIC = '约定心情';
const STOOD_UP_DAYS = 3;
const TURNED_DOWN_DAYS = 1;
const AGO = ['今天', '昨天', '前天', '大前天'];

/** Tags for the memory of waiting in vain: "失约:41:1400:海滩:1530". */
export const stoodUpTopics = (day: number, meeting: Pick<Meeting, 'time' | 'place'>, left: number) =>
  [MOOD_TOPIC, `失约:${day}:${meeting.time}:${meeting.place}:${left}`];

/** "我约农场主出去，农场主没答应。" */
export function turnedDownNote(day: number): MemoryDraft {
  return { text: '我约农场主出去，农场主没答应。', importance: 2, kind: 'observation', subjects: ['player'], visibility: 'private',
    topics: [MOOD_TOPIC, `被拒:${day}`] };
}

/** The line for the NPC's talks while it still minds: the latest time it was stood up, or else turned down. */
export function moodLine(notes: readonly Pick<Memory, 'topics'>[], today: number): string | undefined {
  let stood: { day: number; time: number; place: string; left: number } | undefined;
  let declined: number | undefined;
  for (const topic of notes.flatMap(note => note.topics)) {
    const up = /^失约:(\d+):(\d+):(.+):(\d+)$/.exec(topic);
    if (up && today - Number(up[1]) <= STOOD_UP_DAYS && today >= Number(up[1]) && (!stood || Number(up[1]) > stood.day))
      stood = { day: Number(up[1]), time: Number(up[2]), place: up[3]!, left: Number(up[4]) };
    const down = /^被拒:(\d+)$/.exec(topic);
    if (down && today - Number(down[1]) <= TURNED_DOWN_DAYS && today >= Number(down[1])) declined = Math.max(declined ?? 0, Number(down[1]));
  }
  if (stood) return `- ${AGO[today - stood.day]}${agreedText(stood)}，农场主没来（你等到 ${clock(stood.left)}），你还记着；这几天农场主再约你，答不答应看你自己。`;
  return declined === undefined ? undefined : `- ${AGO[today - declined]}你开口约农场主出去，农场主当场说不行，没约成。`;
}

/** Whether the conversation that just ended turned the NPC's invitation down (docs/npc-meetings-more.md §2). */
export function declinedIn(entries: readonly DayEntry[], npcId: string): boolean {
  return quotedDecline(lastConversation(entries, npcId));
}

/** Where an appointment moved, as said to the NPC and shown by the Mod: "明天（周五）15:00 在镇广场". */
export const movedLabel = (to: Kept, today: number) => `${to.day === today ? '今天 ' : dayLabel(to.day, today)}${clock(to.time)} 在${to.place}`;

/** Today's moved to another day: "约好 14:00 在海滩见面，后来改到明天（周五）15:00 在镇广场。" */
export function movedNote(meeting: Meeting, label: string): MemoryDraft {
  return { text: `${agreedText(meeting)}，后来改到${label}。`, importance: 2, kind: 'observation', subjects: ['player'], visibility: 'private' };
}

/** A later one moved to another day: it hides the appointment on its old day, like a call-off. */
export function laterMovedNote(meeting: LaterMeeting, label: string): MemoryDraft {
  return { text: `${laterText(meeting)}，后来改到${label}。`, importance: 2, kind: 'observation', subjects: ['player'], visibility: 'private',
    topics: [LATER_TOPIC, dayTopic(meeting.day), '约定取消'] };
}

/**
 * The conversation that just ended moved an appointment made before it (docs/npc-meetings-more.md §1); not one held
 * while they are together, and not by the invitation's own opening.
 */
export function changeIn(entries: readonly DayEntry[], npcId: string, target: Kept, today: number, skip = 0): Change | null {
  if (openedAtMeeting(entries, npcId)) return null;
  return quotedChange(lastConversation(entries, npcId).slice(skip), target, MEET_PLACES, today);
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
/** Where an NPC may ask the player to meet, besides the farm and the mines it may also offer (docs/npc-invites.md). */
const ORDINARY_PLACES = Object.keys(MEET_PLACES).filter(place => !['农场', '矿洞', '骷髅洞穴', '火山'].includes(place));
/** From this time on there is too little of the day left to ask for later today. */
const INVITE_TODAY_UNTIL = 1800;

/**
 * The opening line for the NPC the Mod chose to ask the player out today (docs/npc-invites.md); only on that opening
 * turn. What the player answers is checked like any other appointment.
 */
export function invitationLine(now: number): string {
  const when = now < INVITE_TODAY_UNTIL ? '今天晚些时候或明天' : '明天';
  return `- 你今天想主动约农场主出去一次：${when}，从${ORDINARY_PLACES.join('、')}里挑一个合你心意的地方，也可以说去农场帮忙或陪农场主下矿，`
    + '说清几点。自然地问农场主愿不愿意；不答应也没关系，别勉强。';
}

export const farInvitationLine = (label: string) => `- 农场主约的是${label}，太远了：你只答应三天内（今天、明天、后天）的约定，这次婉拒，说到时候再约。`;

/** The nearest one ahead, for the NPC's own conversation: "后天（周六）14:00 在海滩见面". */
export function upcomingLine(upcoming: readonly LaterMeeting[], today: number): string | undefined {
  const next = upcoming.find(meeting => meeting.day > today);
  return next && `${dayLabel(next.day, today)}${clock(next.time)} 在${next.place}见面`;
}

/** What the conversation that just ended agreed for a later day, or took back of those already made. */
export function laterIn(entries: readonly DayEntry[], npcId: string, upcoming: readonly LaterMeeting[], today: number, skip = 0):
  { agreed: LaterAgreement | null; calledOff: { meeting: LaterMeeting; by: CallOff }[] } {
  const lines = lastConversation(entries, npcId);
  const calledOff = upcoming.flatMap(meeting => {
    const by = quotedLaterCallOff(lines, MEET_PLACES[meeting.place]!, MEET_PLACES, meeting.day, today);
    return by ? [{ meeting, by }] : [];
  });
  return { agreed: quotedLater(lines.slice(skip), MEET_PLACES, today), calledOff };
}
