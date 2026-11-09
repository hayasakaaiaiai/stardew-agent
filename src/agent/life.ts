import { SOCIAL_NPCS, type Json, type NpcChange, type NpcState } from '../types.ts';

/** Native observations only. Neither dialogue text nor model output can create these events. */
export const LIFE_KINDS = ['goal.accepted', 'goal.delivered', 'goal.completed', 'goal.closed',
  'activity.completed', 'activity.cancelled', 'activity.missed', 'social.shared', 'relationship.apology'] as const;
export type LifeKind = typeof LIFE_KINDS[number];
export const LIFE_ACTIVITIES = ['forest_walk', 'foraging', 'fishing', 'cooking', 'spouse_walk', 'home_dinner'] as const;
export type LifeActivity = typeof LIFE_ACTIVITIES[number];
export const LIFE_GOALS = ['leah-driftwood-v1', 'willy-catfish-v1', 'maru-copper-v1'] as const;
export const GOALS = LIFE_GOALS;
export const LIFE_GOAL_DETAILS: Readonly<Record<string, { npc: string; item: string; count: number; unit: string; activity: LifeActivity; minutes: number; activityCount: number }>> = {
  'leah-driftwood-v1': { npc: 'leah', item: '浮木', count: 3, unit: '块', activity: 'forest_walk', minutes: 30, activityCount: 0 },
  'willy-catfish-v1': { npc: 'willy', item: '鲶鱼', count: 1, unit: '条', activity: 'fishing', minutes: 20, activityCount: 1 },
  'maru-copper-v1': { npc: 'maru', item: '铜锭', count: 1, unit: '块', activity: 'forest_walk', minutes: 30, activityCount: 0 },
};
/** Each pair is present in both cards' relationship sections, not inferred from proximity. */
export const LIFE_FRIEND_PAIRS = [['leah', 'elliott'], ['sam', 'sebastian'], ['sam', 'abigail'],
  ['sebastian', 'abigail'], ['maru', 'penny'], ['emily', 'sandy']] as const;
export interface LifeEvent {
  id: string;
  npc: string;
  day: number;
  kind: LifeKind;
  goal?: string;
  activity?: string;
  item?: string;
  count?: number;
  minutes?: number;
  other?: string;
  sourceId?: string;
  /** The Mod already applied this vanilla change; this module only records it. */
  friendship?: number;
}

const NAMES: Record<string, string> = { leah: '莉亚', elliott: '艾利欧特', sam: '山姆', sebastian: '塞巴斯蒂安',
  abigail: '阿比盖尔', maru: '玛鲁', penny: '潘妮', emily: '艾米丽', sandy: '桑迪' };
export const ACTIVITY_LABELS: Readonly<Record<string, string>> = { forest_walk: '在森林散步', foraging: '一起采集', fishing: '一起钓鱼',
  cooking: '一起做饭', spouse_walk: '外出散步', home_dinner: '在家一起吃饭' };
const KEYS = new Set(['id', 'npc', 'day', 'kind', 'goal', 'activity', 'item', 'count', 'minutes', 'other', 'sourceId', 'friendship']);
const NPCS = new Set<string>(SOCIAL_NPCS);
const SOURCE_LIMIT = 24;
const RECEIPT_LIMIT = 32;
type Receipt = { id: string; signature: string; day: number; text: string; shareable: boolean; activity?: string };
type Grievance = { id: string; day: number; apologized: boolean };
type GoalPhase = 'accepted' | 'delivered' | 'completed' | 'closed';
interface LifeState {
  version: 1;
  lastSerial: number;
  trust: number;
  lastTrustDay: number;
  updatedDay: number;
  mood: string;
  cause: string;
  untilDay: number;
  grievances: Grievance[];
  recent: Receipt[];
  sources: Receipt[];
  goals: Record<string, { phase: GoalPhase; day: number }>;
  heard: Record<string, number>;
}

function fail(message: string): never { throw new Error(`INVALID_LIFE_EVENT: ${message}`); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
export function lifeSerial(id: string): number {
  if (!/^life-[1-9][0-9]{0,14}$/.test(id)) fail('id must be life-<positive serial>');
  const value = Number(id.slice(5));
  if (!Number.isSafeInteger(value)) fail('serial is out of range');
  return value;
}
export function lifeFriends(a: string, b: string): boolean {
  return LIFE_FRIEND_PAIRS.some(([left, right]) => a === left && b === right || a === right && b === left);
}

/** A detached, bounded batch in journal order. Empty batches are valid synchronization probes. */
export function parseLifeEvents(value: unknown): LifeEvent[] {
  if (!Array.isArray(value) || value.length > 32) fail('events must contain at most 32 observations');
  let previous = 0;
  return value.map(raw => {
    if (!object(raw) || Object.keys(raw).some(key => !KEYS.has(key))) fail('unknown event fields');
    if (typeof raw.id !== 'string') fail('id is required');
    const serial = lifeSerial(raw.id);
    if (serial <= previous) fail('events must have increasing serials');
    previous = serial;
    if (typeof raw.npc !== 'string' || !NPCS.has(raw.npc)) fail('npc must be a known lowercase NPC');
    if (!integer(raw.day, 1, 1_000_000)) fail('day must be an absolute game day');
    if (typeof raw.kind !== 'string' || !(LIFE_KINDS as readonly string[]).includes(raw.kind)) fail('unknown kind');
    if (raw.goal !== undefined && (typeof raw.goal !== 'string' || !Object.hasOwn(LIFE_GOAL_DETAILS, raw.goal)
      || raw.npc !== LIFE_GOAL_DETAILS[raw.goal]!.npc)) fail('goal does not belong to this NPC');
    if (raw.activity !== undefined && !(LIFE_ACTIVITIES as readonly unknown[]).includes(raw.activity)) fail('unknown activity');
    if (raw.item !== undefined && (typeof raw.item !== 'string' || !raw.item.trim() || raw.item !== raw.item.trim()
      || raw.item.length > 64 || /[\p{C}#$@%{}*^\[\]|]/u.test(raw.item))) fail('invalid item label');
    if (raw.count !== undefined && !integer(raw.count, 0, 9999)) fail('invalid item count');
    if (raw.minutes !== undefined && !integer(raw.minutes, 0, 1440)) fail('invalid duration');
    if (raw.friendship !== undefined && !integer(raw.friendship, -40, 30)) fail('invalid native friendship delta');
    if (raw.other !== undefined && (typeof raw.other !== 'string' || !NPCS.has(raw.other) || raw.other === raw.npc)) fail('invalid other NPC');
    if (raw.sourceId !== undefined) {
      if (typeof raw.sourceId !== 'string' || lifeSerial(raw.sourceId) >= serial) fail('source must precede the event');
    }
    if (raw.kind.startsWith('goal.') && raw.goal === undefined) fail('goal is required');
    const goal = typeof raw.goal === 'string' ? LIFE_GOAL_DETAILS[raw.goal] : undefined;
    if (raw.kind === 'goal.delivered' && (raw.item !== goal!.item || raw.count !== goal!.count)) fail('goal delivery must match the exact item and quantity');
    if (raw.kind === 'goal.completed' && (raw.activity !== goal!.activity || !integer(raw.minutes, goal!.minutes, 1440)
      || goal!.activityCount > 0 && !integer(raw.count, goal!.activityCount, 9999))) fail('goal completion lacks the required observed activity');
    if (raw.kind.startsWith('activity.') && raw.kind !== 'activity.missed' && raw.activity === undefined) fail('activity is required');
    if (raw.kind === 'activity.missed' && raw.minutes !== undefined && raw.minutes !== 0) fail('a missed appointment has no observed shared minutes');
    if (raw.kind.startsWith('activity.') && goal && raw.activity !== goal.activity) fail('activity does not match the goal');
    if (raw.kind === 'activity.completed') {
      if ((raw.activity === 'forest_walk' || raw.activity === 'spouse_walk') && !integer(raw.minutes, 30, 1440)) fail('a walk requires 30 observed minutes');
      if ((raw.activity === 'fishing' || raw.activity === 'foraging') && (!integer(raw.minutes, 20, 1440) || !integer(raw.count, 1, 9999))) fail('fishing or foraging requires time and an observed result');
      if ((raw.activity === 'cooking' || raw.activity === 'home_dinner') && (!integer(raw.count, 1, 9999) || raw.item === undefined)) fail('food activities require an observed item and count');
    }
    if (raw.kind === 'social.shared' && (typeof raw.other !== 'string' || !lifeFriends(raw.npc, raw.other) || raw.sourceId === undefined))
      fail('sharing requires a known friend and a source');
    if (raw.kind !== 'social.shared' && raw.other !== undefined) fail('other is only valid for sharing');
    if (raw.kind !== 'social.shared' && raw.kind !== 'relationship.apology' && raw.sourceId !== undefined) fail('unexpected source');
    const extras: Record<LifeKind, readonly string[]> = {
      'goal.accepted': ['goal'], 'goal.delivered': ['goal', 'item', 'count'],
      'goal.completed': ['goal', 'activity', 'minutes', 'count'], 'goal.closed': ['goal'],
      'activity.completed': ['activity', 'minutes', 'count', 'item', 'goal', 'friendship'],
      'activity.cancelled': ['activity', 'minutes', 'count', 'goal', 'friendship'], 'activity.missed': ['activity', 'goal', 'minutes', 'friendship'],
      'social.shared': ['other', 'sourceId', 'activity'], 'relationship.apology': ['sourceId'],
    };
    if (Object.keys(raw).some(key => !['id', 'npc', 'day', 'kind', ...extras[raw.kind as LifeKind]].includes(key))) fail('fields do not match the event kind');
    return structuredClone(raw) as unknown as LifeEvent;
  });
}

function readLife(state: NpcState): LifeState {
  const raw = state.life;
  if (raw === undefined) return { version: 1, lastSerial: 0, trust: 0, lastTrustDay: 0, updatedDay: 0,
    mood: '', cause: '', untilDay: 0, grievances: [], recent: [], sources: [], goals: {}, heard: {} };
  if (!object(raw) || raw.version !== 1 || !integer(raw.lastSerial, 0, Number.MAX_SAFE_INTEGER)
    || !integer(raw.trust, -3, 3) || !integer(raw.lastTrustDay, 0, 1_000_000) || !integer(raw.updatedDay, 0, 1_000_000)
    || !integer(raw.untilDay, 0, 1_000_002) || typeof raw.mood !== 'string' || typeof raw.cause !== 'string'
    || !Array.isArray(raw.grievances) || raw.grievances.length > 3 || !Array.isArray(raw.recent) || raw.recent.length > RECEIPT_LIMIT
    || !Array.isArray(raw.sources) || raw.sources.length > SOURCE_LIMIT || !object(raw.goals) || !object(raw.heard)
    || Object.keys(raw.heard).length > 4096) fail('invalid saved life state');
  for (const [id, goal] of Object.entries(raw.goals)) if (!Object.hasOwn(LIFE_GOAL_DETAILS, id) || !object(goal)
    || !['accepted', 'delivered', 'completed', 'closed'].includes(goal.phase as string) || !integer(goal.day, 1, 1_000_000)) fail('invalid saved goal');
  for (const [key, serial] of Object.entries(raw.heard)) if (!/^[a-z]+:life-[1-9][0-9]*$/.test(key)
    || !integer(serial, 1, Number.MAX_SAFE_INTEGER)) fail('invalid saved shared source');
  for (const grievance of raw.grievances) if (!object(grievance) || typeof grievance.id !== 'string'
    || !integer(grievance.day, 1, 1_000_000) || typeof grievance.apologized !== 'boolean') fail('invalid saved grievance');
  for (const receipt of [...raw.recent, ...raw.sources]) if (!object(receipt) || typeof receipt.id !== 'string'
    || typeof receipt.signature !== 'string' || typeof receipt.text !== 'string' || !integer(receipt.day, 1, 1_000_000)
    || typeof receipt.shareable !== 'boolean') fail('invalid saved receipt');
  return structuredClone(raw) as unknown as LifeState;
}
function signature(event: LifeEvent): string {
  return JSON.stringify(Object.fromEntries(Object.entries(event).sort(([a], [b]) => a.localeCompare(b))));
}
function seen(state: LifeState, event: LifeEvent): boolean {
  const old = state.recent.find(receipt => receipt.id === event.id) ?? state.sources.find(receipt => receipt.id === event.id);
  if (old && old.signature !== signature(event)) fail('an event ID was reused with different content');
  return lifeSerial(event.id) <= state.lastSerial;
}
function finish(state: LifeState, event: LifeEvent, text: string, mood?: string, shareable = false): void {
  state.lastSerial = lifeSerial(event.id);
  state.updatedDay = Math.max(state.updatedDay, event.day);
  if (mood) { state.mood = mood; state.cause = `第 ${event.day} 天：${text}`; state.untilDay = event.day + 2; }
  const receipt = { id: event.id, signature: signature(event), day: event.day, text, shareable,
    ...(event.activity ? { activity: event.activity } : {}) };
  state.recent = [...state.recent, receipt].slice(-RECEIPT_LIMIT);
  // The public source excludes the private relationship-repair annotation added to an NPC's own memory.
  if (shareable) state.sources = [...state.sources, { ...receipt, text: fact(event) }].slice(-SOURCE_LIMIT);
}
function succeeded(state: LifeState, day: number): boolean {
  if (state.lastTrustDay === day) return false;
  state.lastTrustDay = day;
  state.trust = Math.min(3, state.trust + 1);
  const repaired = state.grievances.findIndex(grievance => grievance.apologized);
  if (repaired >= 0) state.grievances.splice(repaired, 1);
  return repaired >= 0;
}
function fact(event: LifeEvent): string {
  const activity = ACTIVITY_LABELS[event.activity ?? ''] ?? '一起活动';
  const goal = event.goal ? LIFE_GOAL_DETAILS[event.goal] : undefined;
  switch (event.kind) {
    case 'goal.accepted': return `农场主明确接下了帮我收集 ${goal!.count} ${goal!.unit}${goal!.item}的目标，尚未交付。`;
    case 'goal.delivered': return `农场主实际交给我 ${goal!.count} ${goal!.unit}${goal!.item}。`;
    case 'goal.completed': return `农场主完成了${goal!.item}目标，我们${activity}，实际共同活动 ${event.minutes} 分钟${event.count ? `，成果数量为 ${event.count}` : ''}。`;
    case 'goal.closed': return '农场主明确结束了这个共同目标；结束本身不代表失约，也不证明已经交料或同行。';
    case 'activity.completed': return `我和农场主${activity}${event.minutes === undefined ? '' : `，实际共同活动 ${event.minutes} 分钟`}${event.count === undefined ? '' : `，记录到的成果数量为 ${event.count}`}${event.item && !/^\([A-Za-z]+\)/.test(event.item) ? `（${event.item}）` : ''}。`;
    case 'activity.cancelled': return `我和农场主的${activity}安排取消了，没有记录为完成或失约。`;
    case 'activity.missed': return `${event.activity ? `原定与农场主${activity}` : '原先与农场主有约'}，实际等候后农场主没有赴约。`;
    case 'relationship.apology': return '农场主当面为先前的失约向我道歉。';
    case 'social.shared': return '';
  }
}

/** Pure projection. The bridge records the returned changes together under its own reliable receipt. */
export function lifeChanges(events: readonly LifeEvent[], prior: Readonly<Record<string, NpcState>>): NpcChange[] {
  const batch = parseLifeEvents(events);
  const working = new Map<string, LifeState>();
  const changes = new Map<string, NpcChange>();
  const life = (npc: string) => {
    let found = working.get(npc);
    if (!found) { found = readLife(prior[npc] ?? {}); working.set(npc, found); }
    return found;
  };
  const record = (npc: string, event: LifeEvent, text?: string, kind: 'observation' | 'heard' = 'observation') => {
    let change = changes.get(npc);
    if (!change) { change = { npcId: npc, log: { lifeEvents: [] }, memories: [] }; changes.set(npc, change); }
    (change.log!.lifeEvents as Json[]).push(structuredClone(event) as unknown as Json);
    if (text) change.memories!.push({ text: `第 ${event.day} 天：${text}`, kind, importance: event.kind === 'goal.completed' ? 4 : 3,
      subjects: kind === 'heard' ? ['player', event.npc] : ['player'], topics: ['life', `life:${event.id}`], visibility: 'private' });
  };
  for (const event of batch) {
    const state = life(event.npc);
    if (event.kind === 'social.shared') {
      const recipient = life(event.other!);
      const senderSeen = seen(state, event), receiverSeen = seen(recipient, event);
      if (senderSeen && receiverSeen) continue;
      if (!senderSeen && event.day < state.updatedDay || !receiverSeen && event.day < recipient.updatedDay) fail('a new observation predates the current state');
      const source = state.sources.find(receipt => receipt.id === event.sourceId && receipt.shareable);
      if (!source || source.day > event.day) fail('sharing lacks a retained public completion source');
      if (event.activity && event.activity !== source.activity) fail('shared activity differs from its source');
      const heardKey = `${event.npc}:${event.sourceId}`;
      if (recipient.heard[heardKey] !== undefined) {
        if (!senderSeen) { finish(state, event, '重复分享同一来源。'); record(event.npc, event); }
        if (!receiverSeen) { finish(recipient, event, '重复听到同一来源。'); record(event.other!, event); }
        continue;
      }
      const said = `我把与农场主共同活动的经历告诉了${NAMES[event.other!]}：第 ${source.day} 天，${source.text}`;
      const heard = `${NAMES[event.npc]}告诉我其与农场主的经历：“第 ${source.day} 天，${source.text}”这是转述，不是我亲历。`;
      if (!senderSeen) { finish(state, event, said, '轻松'); record(event.npc, event, said); }
      if (!receiverSeen) { recipient.heard[heardKey] = lifeSerial(event.id); finish(recipient, event, heard, '轻松'); record(event.other!, event, heard, 'heard'); }
      continue;
    }
    if (seen(state, event)) continue;
    if (event.day < state.updatedDay) fail('a new observation predates the current state');
    const beforeGoal = event.goal ? state.goals[event.goal]?.phase : undefined;
    if (event.kind.startsWith('activity.') && event.goal && beforeGoal !== 'delivered') fail('a goal activity requires delivered materials');
    if (event.kind.startsWith('goal.')) {
      const phase = beforeGoal;
      if (event.kind === 'goal.accepted' ? phase !== undefined
        : event.kind === 'goal.delivered' ? phase !== 'accepted'
          : event.kind === 'goal.completed' ? phase !== 'delivered' : phase !== 'accepted' && phase !== 'delivered') fail('invalid goal transition');
      state.goals[event.goal!] = { phase: event.kind.slice(5) as GoalPhase, day: event.day };
    }
    let text = fact(event), mood: string | undefined;
    if (event.kind === 'goal.closed') {
      const details = LIFE_GOAL_DETAILS[event.goal!]!;
      text = `农场主明确结束了共同目标；${beforeGoal === 'delivered'
        ? `此前已交付 ${details.count} ${details.unit}${details.item}，后续共同活动没有完成`
        : '尚未交付材料'}，没有记为失约。`;
    }
    if (event.kind === 'goal.accepted') mood = '期待';
    else if (event.kind === 'goal.delivered') mood = '感谢';
    else if (event.kind === 'goal.closed' || event.kind === 'activity.cancelled') mood = '平静';
    else if (event.kind === 'goal.completed' || event.kind === 'activity.completed') {
      const repaired = succeeded(state, event.day);
      if (repaired) text += '此前道歉后又用实际行动兑现承诺，我愿意逐步恢复信任。';
      mood = repaired ? '释然' : '欣慰';
    } else if (event.kind === 'activity.missed') {
      state.trust = Math.max(-3, state.trust - 1);
      state.grievances = [...state.grievances, { id: event.id, day: event.day, apologized: false }].slice(-3);
      mood = '失落';
    } else if (event.kind === 'relationship.apology') {
      const grievance = event.sourceId ? state.grievances.find(item => item.id === event.sourceId) : state.grievances.at(-1);
      if (grievance) {
        grievance.apologized = true;
        text += '我听到了道歉，仍想看看之后的实际行动。'; mood = '缓和';
      } else text = '农场主当面向我道歉；没有对应的已记录失约，不据此推断发生过矛盾。';
    }
    const shareable = event.kind === 'goal.completed' || event.kind === 'activity.completed'
      && event.activity !== 'spouse_walk' && event.activity !== 'home_dinner';
    finish(state, event, text, mood, shareable);
    record(event.npc, event, text);
  }
  for (const [npc, change] of changes) change.state = { ...structuredClone(prior[npc] ?? {}), life: working.get(npc)! as unknown as Json };
  return [...changes.values()];
}

/** An optional factual cue; it never changes vanilla hearts or unlocks card topics. */
export function lifeContext(state: NpcState, today: number): string | undefined {
  if (!integer(today, 1, 1_000_000)) fail('invalid context day');
  if (state.life === undefined) return undefined;
  const current = readLife(state);
  if (!current.lastSerial || current.updatedDay > today) return undefined;
  const lines: string[] = [];
  for (const [id, goal] of Object.entries(current.goals)) {
    const details = LIFE_GOAL_DETAILS[id]!;
    if (goal.phase === 'accepted') lines.push(`共同目标：第 ${goal.day} 天已接取 ${details.count} ${details.unit}${details.item}，尚未交付。`);
    else if (goal.phase === 'delivered') lines.push(`共同目标：第 ${goal.day} 天已交付 ${details.count} ${details.unit}${details.item}，后续${ACTIVITY_LABELS[details.activity]}尚未完成。`);
  }
  if (current.mood && today <= current.untilDay) lines.push(`当前心情：${current.mood}；依据：${current.cause}`);
  if (current.trust > 0) lines.push('实际共同经历让你更相信农场主会兑现承诺。');
  else if (current.trust < 0) lines.push('实际失约让你对承诺仍有顾虑；不要把正常取消说成失约。');
  if (current.grievances.some(grievance => grievance.apologized)) lines.push('已听到针对失约的道歉，关系修复还要看之后的实际行动。');
  return lines.length ? `## 最近相处\n${lines.join('\n')}\n亲疏仍按原版心数和关系，不编造未记录的经历。` : undefined;
}
