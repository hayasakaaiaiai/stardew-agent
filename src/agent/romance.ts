import { readFileSync } from 'node:fs';
import type { Relation } from '../services/roster/index.ts';
import type { Json, NpcChange, NpcState } from '../types.ts';
import { lifeSerial } from './life.ts';

export const ROMANCE_NPCS = ['abigail', 'alex', 'elliott', 'emily', 'haley', 'harvey', 'leah', 'maru', 'penny', 'sam', 'sebastian', 'shane'] as const;
export const ROMANCE_VENUES = ['Forest', 'Beach', 'Town', 'Mountain'] as const;
export const ROMANCE_RELATIONS = ['dating', 'engaged', 'married'] as const;
export const ROMANCE_KINDS = ['romance.planned', 'romance.rescheduled', 'romance.started', 'romance.completed', 'romance.cancelled', 'romance.remembered'] as const;
export const ROMANCE_WEATHERS = ['sunny', 'rain', 'storm', 'snow', 'windy'] as const;
export type RomanceKind = typeof ROMANCE_KINDS[number];
export type RomanceVenue = typeof ROMANCE_VENUES[number];
export type RomanceRelation = typeof ROMANCE_RELATIONS[number];
export type RomancePreparation = 'quiet' | 'talk';
export type RomanceDetail = 'place' | 'weather' | 'company';
export type RomanceReason = 'player' | 'expired' | 'relationship' | 'interrupted';
export interface RomanceProfile {
  id: string;
  name: string;
  opening: string;
  invitation: string;
  closing: string;
  venues: { map: RomanceVenue; label: string }[];
  focus: RomancePreparation;
  references: string[];
}

function fail(message: string): never { throw new Error(`INVALID_ROMANCE_EVENT: ${message}`); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function member<const T extends readonly unknown[]>(value: unknown, values: T): value is T[number] {
  return values.includes(value);
}
function serial(id: unknown): number {
  if (typeof id !== 'string') fail('an event ID is required');
  try { return lifeSerial(id); } catch { fail('id must be life-<positive serial>'); }
}
function dateSerial(id: unknown): number {
  if (typeof id !== 'string' || !/^date-[1-9][0-9]{0,14}$/.test(id)) fail('dateId must be date-<creation serial>');
  return serial(`life-${id.slice(5)}`);
}
function safeText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim()
    && !/[\p{C}#$@%{}*^\[\]|]/u.test(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

/** One shared, checked content file is deployed to the Mod and read here; cards remain authoritative. */
export function parseRomanceProfiles(value: unknown): RomanceProfile[] {
  if (!Array.isArray(value) || value.length !== ROMANCE_NPCS.length) fail('profiles must cover all twelve romantic NPCs');
  const seen = new Set<string>();
  return value.map(raw => {
    if (!object(raw) || !exactKeys(raw, ['id', 'name', 'opening', 'invitation', 'closing', 'venues', 'focus', 'references'])
      || !member(raw.id, ROMANCE_NPCS) || seen.has(raw.id)) fail('invalid or repeated profile');
    seen.add(raw.id);
    if (!safeText(raw.name, 20) || !safeText(raw.opening, 240) || !safeText(raw.invitation, 240)
      || !safeText(raw.closing, 240) || !member(raw.focus, ['quiet', 'talk'] as const)) fail('invalid profile prose');
    if (!Array.isArray(raw.venues) || raw.venues.length !== 2 || raw.venues.some(venue => !object(venue)
      || !exactKeys(venue, ['map', 'label']) || !member(venue.map, ROMANCE_VENUES) || !safeText(venue.label, 40))
      || raw.venues[0].map === raw.venues[1].map) fail('a profile needs two different supported venues');
    if (!Array.isArray(raw.references) || raw.references.length < 2 || raw.references.length > 10
      || raw.references.some(ref => typeof ref !== 'string' || !/^(?:data\/npcs\/[a-z]+|reference\/wiki\/(?:zh|en)\/[A-Za-z]+)\.md$/.test(ref)))
      fail('profile references must be local card or wiki paths');
    return structuredClone(raw) as unknown as RomanceProfile;
  });
}

export const ROMANCE_PROFILES: readonly RomanceProfile[] = parseRomanceProfiles(
  JSON.parse(readFileSync(new URL('../../data/romance/profiles.json', import.meta.url), 'utf8')),
);
const PROFILES = new Map(ROMANCE_PROFILES.map(profile => [profile.id, profile]));
export function romanceProfile(npcId: string): RomanceProfile | undefined { return PROFILES.get(npcId); }
export function romanticRelation(relation: unknown): relation is RomanceRelation { return member(relation, ROMANCE_RELATIONS); }

export interface RomanceEvent {
  id: string;
  npc: string;
  day: number;
  kind: RomanceKind;
  dateId: string;
  dateDay?: number;
  time?: number;
  venue?: RomanceVenue;
  preparation?: RomancePreparation;
  relation?: RomanceRelation;
  initiator?: 'player' | 'npc';
  sourceId?: string;
  weather?: typeof ROMANCE_WEATHERS[number];
  minutes?: number;
  friendship?: number;
  reason?: RomanceReason;
  detail?: RomanceDetail;
}

const EXTRA_KEYS: Record<RomanceKind, readonly string[]> = {
  'romance.planned': ['dateDay', 'time', 'venue', 'preparation', 'relation', 'initiator', 'sourceId'],
  'romance.rescheduled': ['dateDay', 'time', 'venue', 'preparation', 'relation', 'initiator'],
  'romance.started': ['relation', 'venue', 'time'],
  'romance.completed': ['relation', 'venue', 'weather', 'minutes', 'friendship'],
  'romance.cancelled': ['reason'],
  'romance.remembered': ['sourceId', 'detail'],
};
const BASE_KEYS = ['id', 'npc', 'day', 'kind', 'dateId'];
const VENUE_LABELS: Record<RomanceVenue, string> = { Forest: '森林', Beach: '海滩', Town: '镇上', Mountain: '山间' };
const WEATHER_LABELS: Record<typeof ROMANCE_WEATHERS[number], string> = { sunny: '晴天', rain: '下雨', storm: '雷雨', snow: '下雪', windy: '刮风' };
const PREPARATION_LABELS: Record<RomancePreparation, string> = { quiet: '安静陪伴', talk: '留时间聊聊' };
const DETAIL_LABELS: Record<RomanceDetail, string> = { place: '当时的地方', weather: '当时的天气', company: '一起留出的时间' };
const RELATION_LABELS: Record<RomanceRelation, string> = { dating: '恋爱中', engaged: '已订婚', married: '已结婚' };
const REASON_LABELS: Record<RomanceReason, string> = { player: '明确取消', expired: '预约时间已过', relationship: '当前关系已不适合继续恋爱安排', interrupted: '实际活动中断' };

function minutesOf(time: number): number { return Math.floor(time / 100) * 60 + time % 100; }
function timeLabel(time: number): string { return `${Math.floor(time / 100).toString().padStart(2, '0')}:${(time % 100).toString().padStart(2, '0')}`; }

/** Native observations only. Text, high friendship and roommate status never establish a romance. */
export function parseRomanceEvents(value: unknown): RomanceEvent[] {
  if (!Array.isArray(value) || value.length > 32) fail('events must contain at most 32 observations');
  let previous = 0;
  return value.map(raw => {
    if (!object(raw) || !member(raw.kind, ROMANCE_KINDS)) fail('unknown romance kind');
    const kind = raw.kind;
    if (Object.keys(raw).some(key => ![...BASE_KEYS, ...EXTRA_KEYS[kind]].includes(key))) fail('fields do not match the event kind');
    const current = serial(raw.id);
    if (current <= previous) fail('events must have increasing serials');
    previous = current;
    const created = dateSerial(raw.dateId);
    if (raw.kind === 'romance.planned' ? created !== current : created >= current) fail('dateId must identify its original planned event');
    if (!member(raw.npc, ROMANCE_NPCS) || !integer(raw.day, 1, 1_000_000)) fail('invalid romantic NPC or absolute game day');
    if (raw.sourceId !== undefined && serial(raw.sourceId) >= current) fail('a source must precede this event');
    if (raw.kind === 'romance.planned' || raw.kind === 'romance.rescheduled') {
      if (!integer(raw.dateDay, raw.day, Math.min(raw.day + 1, 1_000_000)) || !member(raw.time, [1000, 1400, 1700] as const)
        || !member(raw.preparation, ['quiet', 'talk'] as const) || !member(raw.initiator, ['player', 'npc'] as const))
        fail('invalid date plan');
    }
    if (raw.kind === 'romance.planned' || raw.kind === 'romance.rescheduled' || raw.kind === 'romance.started' || raw.kind === 'romance.completed') {
      if (!romanticRelation(raw.relation)) fail('a native romantic relationship is required');
      if (!member(raw.venue, ROMANCE_VENUES) || !romanceProfile(raw.npc)!.venues.some(venue => venue.map === raw.venue))
        fail('venue is not offered by this NPC');
    }
    if (raw.kind === 'romance.started' && (!integer(raw.time, 900, 1900) || raw.time % 100 >= 60 || raw.time % 10 !== 0)) fail('invalid observed start time');
    if (raw.kind === 'romance.completed' && (!member(raw.weather, ROMANCE_WEATHERS) || !integer(raw.minutes, 30, 1440)
      || !integer(raw.friendship, 0, 30))) fail('completion requires observed company, weather and native friendship');
    if (raw.kind === 'romance.cancelled' && !member(raw.reason, ['player', 'expired', 'relationship', 'interrupted'] as const)) fail('invalid cancellation reason');
    if (raw.kind === 'romance.remembered' && (raw.sourceId === undefined || !member(raw.detail, ['place', 'weather', 'company'] as const)))
      fail('remembering requires a completion source and a supported detail');
    return structuredClone(raw) as unknown as RomanceEvent;
  });
}

interface DatePlan {
  dateId: string;
  dateDay: number;
  time: number;
  venue: RomanceVenue;
  preparation: RomancePreparation;
  relation: RomanceRelation;
  initiator: 'player' | 'npc';
  sourceId?: string;
  phase: 'planned' | 'started';
  startDay?: number;
  startTime?: number;
}
interface CompletedDate {
  dateId: string;
  eventId: string;
  day: number;
  venue: RomanceVenue;
  weather: typeof ROMANCE_WEATHERS[number];
  minutes: number;
  relation: RomanceRelation;
  preparation: RomancePreparation;
  detail?: RomanceDetail;
  sourceId?: string;
  revisitDay?: number;
}
interface RomanceState {
  version: 1;
  lastSerial: number;
  updatedDay: number;
  active: DatePlan | null;
  firstCompleted: CompletedDate | null;
  completed: CompletedDate[];
  completedCount: number;
  recent: { id: string; signature: string }[];
  cancelled: { day: number; reason: RomanceReason } | null;
}
const COMPLETION_LIMIT = 24;
const RECEIPT_LIMIT = 32;

function validPlan(value: unknown): value is DatePlan {
  if (!object(value)) return false;
  dateSerial(value.dateId);
  return integer(value.dateDay, 1, 1_000_000) && member(value.time, [1000, 1400, 1700] as const)
    && member(value.venue, ROMANCE_VENUES) && member(value.preparation, ['quiet', 'talk'] as const)
    && romanticRelation(value.relation) && member(value.initiator, ['player', 'npc'] as const)
    && (value.sourceId === undefined || serial(value.sourceId) > 0)
    && (value.phase === 'planned' && value.startDay === undefined && value.startTime === undefined
      || value.phase === 'started' && value.startDay === value.dateDay && integer(value.startTime, value.time, 1900)
        && value.startTime % 100 < 60 && value.startTime % 10 === 0 && minutesOf(value.startTime) - minutesOf(value.time) <= 60);
}
function validCompletion(value: unknown): value is CompletedDate {
  if (!object(value)) return false;
  const created = dateSerial(value.dateId), ended = serial(value.eventId);
  return ended > created && integer(value.day, 1, 1_000_000) && member(value.venue, ROMANCE_VENUES)
    && member(value.weather, ROMANCE_WEATHERS) && integer(value.minutes, 30, 1440) && romanticRelation(value.relation)
    && member(value.preparation, ['quiet', 'talk'] as const)
    && (value.detail === undefined || member(value.detail, ['place', 'weather', 'company'] as const))
    && (value.sourceId === undefined && value.revisitDay === undefined
      || value.sourceId !== undefined && serial(value.sourceId) < ended && integer(value.revisitDay, 1, value.day));
}
function readRomance(state: NpcState): RomanceState {
  const raw = state.romance;
  if (raw === undefined) return { version: 1, lastSerial: 0, updatedDay: 0, active: null,
    firstCompleted: null, completed: [], completedCount: 0, recent: [], cancelled: null };
  if (!object(raw) || raw.version !== 1 || !integer(raw.lastSerial, 0, Number.MAX_SAFE_INTEGER)
    || !integer(raw.updatedDay, 0, 1_000_000) || !integer(raw.completedCount, 0, 4096)
    || raw.active !== null && !validPlan(raw.active)
    || raw.firstCompleted !== null && !validCompletion(raw.firstCompleted)
    || !Array.isArray(raw.completed) || raw.completed.length > COMPLETION_LIMIT || !raw.completed.every(validCompletion)
    || !Array.isArray(raw.recent) || raw.recent.length > RECEIPT_LIMIT || raw.recent.some(receipt => !object(receipt)
      || serial(receipt.id) > (raw.lastSerial as number) || typeof receipt.signature !== 'string')
    || raw.cancelled !== null && (!object(raw.cancelled) || !integer(raw.cancelled.day, 1, 1_000_000)
      || !member(raw.cancelled.reason, ['player', 'expired', 'relationship', 'interrupted'] as const))) fail('invalid saved romance state');
  if (raw.completedCount < raw.completed.length || (raw.completedCount === 0) !== (raw.firstCompleted === null)
    || new Set((raw.completed as unknown as CompletedDate[]).map(completed => completed.eventId)).size !== raw.completed.length
    || raw.active && dateSerial(raw.active.dateId) > raw.lastSerial) fail('inconsistent saved romance state');
  return structuredClone(raw) as unknown as RomanceState;
}
function signature(event: RomanceEvent): string {
  return JSON.stringify(Object.fromEntries(Object.entries(event).sort(([a], [b]) => a.localeCompare(b))));
}
function completedSource(state: RomanceState, sourceId: string): CompletedDate | undefined {
  return state.completed.find(date => date.eventId === sourceId) ?? (state.firstCompleted?.eventId === sourceId ? state.firstCompleted : undefined);
}
function completionFact(date: CompletedDate): string {
  return `第 ${date.day} 天，我们在${VENUE_LABELS[date.venue]}实际约会相处了 ${date.minutes} 分钟，当时${WEATHER_LABELS[date.weather]}；当时的关系为${RELATION_LABELS[date.relation]}。`;
}

/** Pure projection; the bridge stores only state.romance into its atomic log.romanceState namespace. */
export function romanceChanges(events: readonly RomanceEvent[], prior: Readonly<Record<string, NpcState>>): NpcChange[] {
  const batch = parseRomanceEvents(events);
  const working = new Map<string, RomanceState>();
  const changes = new Map<string, NpcChange>();
  for (const event of batch) {
    let state = working.get(event.npc);
    if (!state) { state = readRomance(prior[event.npc] ?? {}); working.set(event.npc, state); }
    const old = state.recent.find(receipt => receipt.id === event.id);
    if (old && old.signature !== signature(event)) fail('an event ID was reused with different content');
    if (serial(event.id) <= state.lastSerial) continue;
    if (event.day < state.updatedDay) fail('a new observation predates the current state');
    let text: string;
    const active = state.active;
    switch (event.kind) {
      case 'romance.planned': {
        if (active) fail('an unfinished date already exists');
        const source = event.sourceId ? completedSource(state, event.sourceId) : undefined;
        if (event.sourceId && (!source || source.day > event.day || source.venue !== event.venue)) fail('a revisit requires this NPC\'s retained completion at the same venue');
        state.active = { dateId: event.dateId, dateDay: event.dateDay!, time: event.time!, venue: event.venue!,
          preparation: event.preparation!, relation: event.relation!, initiator: event.initiator!, phase: 'planned',
          ...(event.sourceId ? { sourceId: event.sourceId } : {}) };
        state.cancelled = null;
        text = `农场主和我明确商量好第 ${event.dateDay} 天 ${timeLabel(event.time!)} 在${VENUE_LABELS[event.venue!]}约会，打算${PREPARATION_LABELS[event.preparation!]}；由${event.initiator === 'npc' ? '我提出邀请' : '农场主发起商量'}，尚未出发或完成。`;
        if (source) text += `这次打算重访第 ${source.day} 天实际约会过的地方。`;
        break;
      }
      case 'romance.rescheduled': {
        if (!active || active.dateId !== event.dateId || active.phase !== 'planned') fail('only a pending date can be rescheduled');
        const source = active.sourceId ? completedSource(state, active.sourceId) : undefined;
        if (source && source.venue !== event.venue) fail('a revisit must keep its source venue');
        state.active = { ...active, dateDay: event.dateDay!, time: event.time!, venue: event.venue!,
          preparation: event.preparation!, relation: event.relation!, initiator: event.initiator! };
        text = `农场主和我明确把约会改为第 ${event.dateDay} 天 ${timeLabel(event.time!)} 在${VENUE_LABELS[event.venue!]}，打算${PREPARATION_LABELS[event.preparation!]}；尚未完成，改期本身不算失约。`;
        break;
      }
      case 'romance.started':
        if (!active || active.dateId !== event.dateId || active.phase !== 'planned' || event.day !== active.dateDay
          || event.venue !== active.venue || minutesOf(event.time!) < minutesOf(active.time)
          || minutesOf(event.time!) - minutesOf(active.time) > 60) fail('departure does not match the pending date and start window');
        active.phase = 'started'; active.startDay = event.day; active.startTime = event.time!; active.relation = event.relation!;
        text = `农场主和我已经碰面并为这次约会一起出发，目的地是${VENUE_LABELS[active.venue]}；这只表示出发，尚未记录在目的地完成约会。`;
        break;
      case 'romance.completed': {
        if (!active || active.dateId !== event.dateId || active.phase !== 'started' || event.day !== active.startDay || event.venue !== active.venue)
          fail('completion requires the same started date, day and destination');
        const source = active.sourceId ? completedSource(state, active.sourceId) : undefined;
        const completed: CompletedDate = { dateId: event.dateId, eventId: event.id, day: event.day, venue: event.venue!, weather: event.weather!,
          minutes: event.minutes!, relation: event.relation!, preparation: active.preparation,
          ...(source ? { sourceId: source.eventId, revisitDay: source.day } : {}) };
        state.firstCompleted ??= structuredClone(completed);
        state.completed = [...state.completed, completed].slice(-COMPLETION_LIMIT);
        state.completedCount++;
        if (state.completedCount > 4096) fail('romance history exceeds the journal bound');
        state.active = null; state.cancelled = null;
        text = completionFact(completed);
        if (source) text += `我们这次真实重访了第 ${source.day} 天约会过的地方。`;
        break;
      }
      case 'romance.cancelled':
        if (!active || active.dateId !== event.dateId) fail('cancellation requires the current unfinished date');
        if (event.reason === 'interrupted' && active.phase !== 'started') fail('only a started date can be interrupted');
        state.active = null; state.cancelled = { day: event.day, reason: event.reason! };
        text = `原定的这次约会因${REASON_LABELS[event.reason!]}而结束，没有记录为完成，也不据此推断失约或惩罚。`;
        break;
      case 'romance.remembered': {
        const source = completedSource(state, event.sourceId!);
        if (!source || source.dateId !== event.dateId || source.day > event.day) fail('a memory must name this date\'s retained completion');
        if (source.detail !== undefined) fail('a shared memory detail was already chosen');
        source.detail = event.detail!;
        if (state.firstCompleted?.eventId === source.eventId) state.firstCompleted.detail = event.detail!;
        text = `农场主选择把${DETAIL_LABELS[event.detail!]}作为我们这次共同回忆的重点。${completionFact(source)}`;
        break;
      }
    }
    state.lastSerial = serial(event.id); state.updatedDay = event.day;
    state.recent = [...state.recent, { id: event.id, signature: signature(event) }].slice(-RECEIPT_LIMIT);
    let change = changes.get(event.npc);
    if (!change) { change = { npcId: event.npc, log: { romanceEvents: [] }, memories: [] }; changes.set(event.npc, change); }
    (change.log!.romanceEvents as Json[]).push(structuredClone(event) as unknown as Json);
    change.memories!.push({ text: `第 ${event.day} 天：${text}`, kind: 'observation', importance: event.kind === 'romance.completed' || event.kind === 'romance.remembered' ? 4 : 3,
      subjects: ['player'], topics: ['romance', `romance:${event.id}`], visibility: 'private' });
    change.state = { ...(prior[event.npc] ?? {}), romance: structuredClone(state) as unknown as Json };
  }
  return [...changes.values()];
}

/** A small current-relationship cue; a historic romance never upgrades friendship, engagement or roommates. */
export function romanceContext(state: NpcState, today: number, relation: Relation): string | undefined {
  if (!integer(today, 1, 1_000_000) || !member(relation, ['stranger', 'friend', 'dating', 'engaged', 'married', 'roommate'] as const)) fail('invalid context day or relationship');
  if (state.romance === undefined) return undefined;
  const current = readRomance(state);
  if (!current.lastSerial || current.updatedDay > today) return undefined;
  const latest = current.completed.at(-1) ?? current.firstCompleted;
  if (!romanticRelation(relation)) return latest
    ? `## 共同往事\n第 ${latest.day} 天在${VENUE_LABELS[latest.venue]}的约会只属于过去。当前关系按原版状态，不把旧回忆说成仍在恋爱，也不执行旧约会。`
    : '## 过去的安排\n以前的约会安排只属于过去，没有已完成的约会记录。当前关系按原版状态，不把旧安排说成仍在交往，也不执行旧约会。';
  const lines: string[] = [];
  const active = current.active;
  if (active && active.dateDay < today) lines.push(`第 ${active.dateDay} 天的旧约会安排已过期；这次未记录完成，不继续执行，也不推断失约或惩罚。`);
  if (active && active.dateDay >= today) lines.push(active.phase === 'planned'
    ? `已商量第 ${active.dateDay} 天 ${timeLabel(active.time)} 在${VENUE_LABELS[active.venue]}约会，准备${PREPARATION_LABELS[active.preparation]}；尚未出发。`
    : `已一起出发去${VENUE_LABELS[active.venue]}约会，打算${PREPARATION_LABELS[active.preparation]}；未记录在目的地相处满 30 分钟，不能说已完成。`);
  if (latest && today - latest.day <= 7) lines.push(`最近实际约会：第 ${latest.day} 天，${VENUE_LABELS[latest.venue]}，${WEATHER_LABELS[latest.weather]}，相处 ${latest.minutes} 分钟${latest.detail ? `；共同选择记住${DETAIL_LABELS[latest.detail]}` : ''}。`);
  if (current.firstCompleted) lines.push(`已记录 ${current.completedCount} 次完成约会；最早可确认的是第 ${current.firstCompleted.day} 天，不猜交往起始日。`);
  if (!active && current.cancelled && today - current.cancelled.day <= 2) lines.push(`最近安排因${REASON_LABELS[current.cancelled.reason]}结束，不算已完成或失约。`);
  return lines.length ? `## 两人的约定与回忆\n${lines.join('\n')}\n亲密程度按当前原版关系；不推断排他承诺、同居、婚期或未记录的往事。` : undefined;
}
