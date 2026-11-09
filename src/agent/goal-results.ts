import { readFileSync } from 'node:fs';
import { lifeSerial } from './life.ts';
import { LONG_GOAL_IDS, longGoalContext, parseLongGoalEvents, type LongGoalEvent, type LongGoalId } from './long-goals.ts';
import type { Json, MemoryDraft, NpcChange, NpcState } from '../types.ts';

export const GOAL_RESULT_IDS = LONG_GOAL_IDS;
export const GOAL_RESULT_KINDS = ['goalresult.notified', 'goalresult.started', 'goalresult.checkpoint',
  'goalresult.completed', 'goalresult.cancelled', 'goalresult.reviewed'] as const;
export type GoalResultKind = typeof GOAL_RESULT_KINDS[number];
type Weather = 'sunny' | 'rain' | 'storm' | 'snow' | 'windy';
interface Choice { id: 'a' | 'b'; label: string; text: string }
export interface GoalResultDefinition {
  projectId: LongGoalId; owner: string; title: string; venue: string; venueLabel: string; mode: 'walk' | 'fishing' | 'foraging';
  minutes: number; opening: string; planChoices: Choice[];
  checkpoints: { point: number; title: string; prompt: string; choices: Choice[] }[];
  finishChoices: Choice[]; receiptIntro: string; reviewIntro: string; reviewChoices: Choice[]; references: string[];
}
const CONTRACTS: Record<LongGoalId, { owner: string; venue: string; mode: 'walk' | 'fishing' | 'foraging'; points: number }> = {
  penny_learning_book: { owner: 'penny', venue: 'Forest', mode: 'walk', points: 2 },
  elliott_triptych: { owner: 'elliott', venue: 'Beach', mode: 'walk', points: 2 },
  leah_form_study: { owner: 'leah', venue: 'Forest', mode: 'walk', points: 3 },
  maru_field_holder: { owner: 'maru', venue: 'Mountain', mode: 'walk', points: 2 },
  robin_small_space: { owner: 'robin', venue: 'Town', mode: 'walk', points: 3 },
  willy_shore_guide: { owner: 'willy', venue: 'Beach', mode: 'fishing', points: 1 },
  linus_light_steps: { owner: 'linus', venue: 'Forest', mode: 'foraging', points: 1 },
};
const WEATHER: Record<Weather, string> = { sunny: '晴天', rain: '下雨', storm: '雷雨', snow: '下雪', windy: '刮风' };
const BASE = ['id', 'npc', 'day', 'kind', 'projectId'];
const EXTRAS: Record<GoalResultKind, readonly string[]> = {
  'goalresult.notified': ['chapterId', 'sourceId'], 'goalresult.started': ['sourceId', 'choiceId'],
  'goalresult.checkpoint': ['attemptId', 'point', 'venue', 'x', 'y', 'time', 'weather', 'minutes', 'count', 'choiceId'],
  'goalresult.completed': ['attemptId', 'sourceId', 'minutes', 'count', 'choiceId'],
  'goalresult.cancelled': ['attemptId', 'reason'], 'goalresult.reviewed': ['sourceId', 'choiceId'],
};
function fail(message: string): never { throw new Error(`INVALID_GOAL_RESULT_EVENT: ${message}`); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function member<const T extends readonly unknown[]>(value: unknown, values: T): value is T[number] { return values.includes(value); }
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key)) && allowed.every(key => Object.hasOwn(value, key));
}
function prose(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim()
    && !/[\p{C}#$@%{}*^\[\]|]/u.test(value);
}
function serial(value: unknown): number {
  if (typeof value !== 'string') fail('an event ID is required');
  try { return lifeSerial(value); } catch { fail('id must be life-<positive serial>'); }
}
function signature(value: GoalResultEvent | LongGoalEvent): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}
function choices(value: unknown): value is Choice[] {
  return Array.isArray(value) && value.length === 2 && value.every(choice => object(choice)
    && keys(choice, ['id', 'label', 'text']) && member(choice.id, ['a', 'b']) && prose(choice.label, 100) && prose(choice.text, 800))
    && new Set(value.map(choice => choice.id)).size === 2;
}

/** Fixed routes and original text cannot configure rewards or pretend that an authored idea changed the game world. */
export function parseGoalResultDefinitions(value: unknown): GoalResultDefinition[] {
  if (!object(value) || !keys(value, ['version', 'practices']) || value.version !== 1 || !Array.isArray(value.practices)
    || value.practices.length !== GOAL_RESULT_IDS.length) fail('definitions must cover the seven supported practices');
  const seen = new Set<string>();
  return value.practices.map(raw => {
    if (!object(raw) || !member(raw.projectId, GOAL_RESULT_IDS) || seen.has(raw.projectId)) fail('unknown or duplicate project');
    seen.add(raw.projectId);
    const contract = CONTRACTS[raw.projectId];
    if (!keys(raw, ['projectId', 'owner', 'title', 'venue', 'venueLabel', 'mode', 'minutes', 'opening', 'planChoices', 'checkpoints',
      'finishChoices', 'receiptIntro', 'reviewIntro', 'reviewChoices', 'references']) || raw.owner !== contract.owner
      || raw.venue !== contract.venue || raw.mode !== contract.mode || raw.minutes !== (contract.mode === 'walk' ? 30 : 20)
      || !prose(raw.title, 100) || !prose(raw.venueLabel, 80) || !prose(raw.opening, 800) || !prose(raw.receiptIntro, 1200)
      || !prose(raw.reviewIntro, 800) || !choices(raw.planChoices) || !choices(raw.finishChoices) || !choices(raw.reviewChoices)
      || !Array.isArray(raw.references) || raw.references.length < 2 || raw.references.length > 10
      || raw.references.some(ref => typeof ref !== 'string' || !/^(?:data\/npcs\/[a-z]+|reference\/wiki\/(?:zh|en)\/[A-Za-z]+)\.md$/.test(ref)))
      fail('invalid practice owner, route, choices or prose');
    if (!Array.isArray(raw.checkpoints) || raw.checkpoints.length !== contract.points
      || raw.checkpoints.some((point, index) => !object(point) || !keys(point, ['point', 'title', 'prompt', 'choices'])
        || point.point !== index + 1 || !prose(point.title, 100) || !prose(point.prompt, 800) || !choices(point.choices)))
      fail('invalid practice checkpoints');
    return structuredClone(raw) as unknown as GoalResultDefinition;
  });
}
export const GOAL_RESULT_DEFINITIONS: readonly GoalResultDefinition[] = parseGoalResultDefinitions(
  JSON.parse(readFileSync(new URL('../../data/town/goal-results.json', import.meta.url), 'utf8')),
);
const DEFINITIONS = new Map(GOAL_RESULT_DEFINITIONS.map(definition => [definition.projectId, definition]));
export const GOAL_RESULT_NPCS: readonly string[] = GOAL_RESULT_DEFINITIONS.map(definition => definition.owner);
export function goalResultDefinition(projectId: string): GoalResultDefinition | undefined { return DEFINITIONS.get(projectId as LongGoalId); }

export interface GoalResultEvent {
  id: string; npc: string; day: number; kind: GoalResultKind; projectId: LongGoalId;
  chapterId?: number; sourceId?: string; choiceId?: string; attemptId?: string; point?: number;
  venue?: string; x?: number; y?: number; time?: number; weather?: Weather; minutes?: number; count?: number;
  reason?: 'player' | 'interrupted' | 'load';
}

/** Evidence comes from the marked native practice session, never from ordinary activity or romance completions. */
export function parseGoalResultEvents(value: unknown): GoalResultEvent[] {
  if (!Array.isArray(value) || value.length > 32) fail('events must contain at most 32 observations');
  let previous = 0;
  return value.map(raw => {
    if (!object(raw) || !member(raw.kind, GOAL_RESULT_KINDS) || !member(raw.projectId, GOAL_RESULT_IDS)
      || !keys(raw, [...BASE, ...EXTRAS[raw.kind]])) fail('unknown kind, project or event fields');
    const current = serial(raw.id), definition = DEFINITIONS.get(raw.projectId)!;
    if (current <= previous) fail('events must have increasing serials');
    previous = current;
    if (raw.npc !== definition.owner || !integer(raw.day, 1, 1_000_000)) fail('invalid owner or game day');
    for (const field of ['sourceId', 'attemptId']) if (EXTRAS[raw.kind].includes(field) && serial(raw[field]) >= current)
      fail('sources and attempts must precede the event');
    if (EXTRAS[raw.kind].includes('choiceId') && !member(raw.choiceId, ['a', 'b'])) fail('invalid explicit choice');
    if (raw.kind === 'goalresult.notified' && !member(raw.chapterId, [1, 2, 3])) fail('invalid notification chapter');
    if (raw.kind === 'goalresult.cancelled' && !member(raw.reason, ['player', 'interrupted', 'load'])) fail('invalid cancellation reason');
    if (raw.kind === 'goalresult.checkpoint' || raw.kind === 'goalresult.completed') {
      if (!integer(raw.minutes, raw.kind === 'goalresult.completed' ? definition.minutes : 10, 90) || raw.minutes % 10 !== 0
        || !integer(raw.count, definition.mode === 'walk' ? 0 : 1, 999) || definition.mode === 'walk' && raw.count !== 0)
        fail('invalid actual minutes or action count');
    }
    if (raw.kind === 'goalresult.checkpoint' && (!integer(raw.point, 1, definition.checkpoints.length) || raw.venue !== definition.venue
      || !integer(raw.x, 0, 500) || !integer(raw.y, 0, 500) || !integer(raw.time, 900, 2200) || raw.time % 100 >= 60 || raw.time % 10 !== 0
      || !member(raw.weather, Object.keys(WEATHER)))) fail('invalid checkpoint position, time, weather or route');
    return structuredClone(raw) as unknown as GoalResultEvent;
  });
}

interface ResultState {
  version: 1; owner: string; projectId: LongGoalId; watermark: number; sources: LongGoalEvent[]; events: GoalResultEvent[];
}
interface Attempt {
  started: GoalResultEvent; checkpoints: GoalResultEvent[]; completed: GoalResultEvent | null;
  cancelled: GoalResultEvent | null; reviewed: GoalResultEvent | null;
}
interface Progress { notices: GoalResultEvent[]; attempt: Attempt | null }
const clockMinutes = (time: number) => Math.floor(time / 100) * 60 + time % 100;
const distanceSquared = (a: GoalResultEvent, b: GoalResultEvent) => (a.x! - b.x!) ** 2 + (a.y! - b.y!) ** 2;

function project(state: ResultState): Progress {
  const definition = DEFINITIONS.get(state.projectId)!, progress: Progress = { notices: [], attempt: null };
  let previousDay = 0;
  for (const event of state.events) {
    if (event.npc !== state.owner || event.projectId !== state.projectId || event.day < previousDay) fail('inconsistent saved event owner or day');
    previousDay = event.day;
    if (event.kind === 'goalresult.notified' || event.kind === 'goalresult.started') {
      const source = state.sources.find(source => source.id === event.sourceId);
      if (!source || serial(source.id) >= serial(event.id) || source.day > event.day
        || source.chapterId !== (event.kind === 'goalresult.started' ? 3 : event.chapterId)) fail('the exact completed chapter is required');
      if (event.kind === 'goalresult.notified') {
        const available = state.sources.filter(source => serial(source.id) < serial(event.id));
        if (event.chapterId !== Math.max(...available.map(source => source.chapterId!))
          || progress.notices.some(previous => previous.chapterId! >= event.chapterId! || previous.day === event.day))
          fail('notify only the latest unnotified chapter once');
        progress.notices.push(event);
        continue;
      }
      if (progress.attempt) fail('a retained attempt cannot be overwritten or restarted');
      progress.attempt = { started: event, checkpoints: [], completed: null, cancelled: null, reviewed: null };
      continue;
    }
    const attempt = progress.attempt;
    if (!attempt) fail('the practice has not started');
    if (event.kind === 'goalresult.reviewed') {
      if (!attempt.completed || attempt.reviewed || event.sourceId !== attempt.completed.id || event.day <= attempt.completed.day)
        fail('review requires this completed practice on a later day, once');
      attempt.reviewed = event;
      continue;
    }
    if (attempt.completed || attempt.cancelled) fail('the attempt has already ended');
    if (event.attemptId !== attempt.started.id) fail('the source belongs to another attempt');
    if (event.kind === 'goalresult.cancelled') {
      if (event.reason === 'player' && event.day !== attempt.started.day) fail('player cancellation must be on the attempt day');
      attempt.cancelled = event;
      continue;
    }
    if (event.day !== attempt.started.day) fail('practice evidence must stay on the attempt day');
    const previous = attempt.checkpoints.at(-1);
    if (event.kind === 'goalresult.checkpoint') {
      if (event.point !== attempt.checkpoints.length + 1) fail('checkpoints must follow the configured order');
      if (!previous && event.minutes! > clockMinutes(event.time!) - 9 * 60) fail('the first checkpoint cannot predate the earliest start time');
      if (previous && (event.minutes! < previous.minutes! + 10 || clockMinutes(event.time!) < clockMinutes(previous.time!) + 10
        || event.minutes! - previous.minutes! > clockMinutes(event.time!) - clockMinutes(previous.time!)
        || event.count! < previous.count!)) fail('checkpoint time and action count cannot regress or exceed the elapsed interval');
      if (previous) {
        const first = attempt.checkpoints[0]!;
        const valid = definition.owner === 'robin' && event.point === 3 ? distanceSquared(first, event) <= 9
          : definition.owner === 'leah' ? attempt.checkpoints.every(point => distanceSquared(point, event) >= 36)
          : distanceSquared(first, event) >= 36;
        if (!valid) fail('checkpoint positions do not match the required route');
      }
      attempt.checkpoints.push(event);
    } else {
      if (attempt.checkpoints.length !== definition.checkpoints.length || !previous || event.sourceId !== previous.id
        || event.minutes! < previous.minutes! || event.count! < previous.count!
        || definition.owner === 'linus' && previous.choiceId === 'b' && event.count! < 2)
        fail('completion needs every checkpoint, its exact last source and the actual actions');
      attempt.completed = event;
    }
  }
  return progress;
}

function sourceEvents(state: NpcState, definition: GoalResultDefinition): LongGoalEvent[] | undefined {
  if (state.longGoal === undefined) return undefined;
  try { longGoalContext(state, 1_000_000); } catch { fail('invalid prerequisite long goal state'); }
  if (!object(state.longGoal) || state.longGoal.owner !== definition.owner || !Array.isArray(state.longGoal.events))
    fail('the prerequisite belongs to another owner');
  const events = parseLongGoalEvents(state.longGoal.events);
  if (events.some(event => event.longGoalId !== definition.projectId)) fail('the prerequisite belongs to another project');
  return events.filter(event => event.kind === 'longgoal.completed');
}

function readState(state: NpcState, owner?: string): ResultState | undefined {
  const raw = state.goalResult;
  if (raw === undefined) return undefined;
  if (!object(raw) || !keys(raw, ['version', 'owner', 'projectId', 'watermark', 'sources', 'events']) || raw.version !== 1
    || !member(raw.projectId, GOAL_RESULT_IDS) || raw.owner !== CONTRACTS[raw.projectId].owner || owner !== undefined && raw.owner !== owner
    || !integer(raw.watermark, 0, Number.MAX_SAFE_INTEGER) || !Array.isArray(raw.sources) || raw.sources.length < 1 || raw.sources.length > 3
    || !Array.isArray(raw.events) || raw.events.length < 1 || raw.events.length > 9) fail('invalid saved practice state');
  const sources = parseLongGoalEvents(raw.sources), events = parseGoalResultEvents(raw.events);
  if (sources.some(source => source.kind !== 'longgoal.completed' || source.npc !== raw.owner || source.longGoalId !== raw.projectId)
    || new Set(sources.map(source => source.chapterId)).size !== sources.length || raw.watermark >= serial(events.at(-1)!.id))
    fail('invalid saved completion sources or watermark');
  const parsed: ResultState = { version: 1, owner: raw.owner, projectId: raw.projectId, watermark: raw.watermark, sources, events };
  const progress = project(parsed), started = progress.attempt?.started;
  if (raw.watermark > 0 && (!started || serial(started.id) <= raw.watermark)) fail('watermark must precede the retained attempt');
  const actual = sourceEvents(state, DEFINITIONS.get(raw.projectId)!);
  if (actual && sources.some(source => !actual.some(candidate => signature(candidate) === signature(source))))
    fail('saved completion source does not match this project branch');
  return parsed;
}

function choiceLabel(choices: Choice[], id: string): string { return choices.find(choice => choice.id === id)!.label; }
function evidence(definition: GoalResultDefinition, event: GoalResultEvent): string {
  return `在${definition.venueLabel}实际共同实践 ${event.minutes} 分钟${definition.mode === 'walk' ? ''
    : `，本次实际${definition.mode === 'fishing' ? '钓获' : '采集'} ${event.count} ${definition.mode === 'fishing' ? '条鱼' : '件'}`}`;
}
function memoryFor(event: GoalResultEvent, definition: GoalResultDefinition, progress: Progress): { text: string; kind: NonNullable<MemoryDraft['kind']> } | undefined {
  if (event.kind === 'goalresult.notified') return undefined;
  const attempt = progress.attempt!;
  switch (event.kind) {
    case 'goalresult.started': return { text: `合册已有真实成品，我和农场主明确开始“${definition.title}”，选择“${choiceLabel(definition.planChoices, event.choiceId!)}”。这是本次实践的开始，尚未完成。`, kind: 'observation' };
    case 'goalresult.checkpoint': return { text: `“${definition.title}”本次第 ${event.point} 个记录点：第 ${event.day} 天 ${event.time}，${definition.venueLabel}格点 ${event.x}、${event.y}，${WEATHER[event.weather!]}；已累计实际同行 ${event.minutes} 分钟${definition.mode === 'walk' ? '' : `，实际收获 ${event.count} 件`}。农场主明确选择“${choiceLabel(definition.checkpoints[event.point! - 1]!.choices, event.choiceId!)}”。位置是记录时所在，不代表一直停在那里；尚未确认实践完成。`, kind: 'observation' };
    case 'goalresult.completed': return { text: `“${definition.title}”已由农场主明确收尾：${evidence(definition, event)}，完成 ${attempt.checkpoints.length} 个真实记录点；收尾选择“${choiceLabel(definition.finishChoices, event.choiceId!)}”。回执已经形成，尚未回访；不代表稿本建议已造成其他世界变化。`, kind: 'observation' };
    case 'goalresult.cancelled': return { text: `本次“${definition.title}”因${event.reason === 'player' ? '主动取消' : event.reason === 'load' ? '读档恢复' : '中断'}结束，未完成实践；已有点不转给下一次尝试。`, kind: 'observation' };
    case 'goalresult.reviewed': return { text: `农场主当面回访第 ${attempt.completed!.day} 天实际完成的“${definition.title}”，选择“${choiceLabel(definition.reviewChoices, event.choiceId!)}”。这是对那一次实践的反馈，不是再次完成活动。`, kind: 'heard' };
  }
}

/** Archived retries must be removed only after the bridge verifies their full global journal signatures. */
export function goalResultChanges(events: readonly GoalResultEvent[], prior: Readonly<Record<string, NpcState>>): NpcChange[] {
  const batch = parseGoalResultEvents(events), working = new Map<string, ResultState>(), changes = new Map<string, NpcChange>();
  const noticeDays = new Map<number, string>();
  for (const [owner, old] of Object.entries(prior)) if (old.goalResult !== undefined) {
    const saved = readState(old, owner)!;
    for (const notice of saved.events.filter(event => event.kind === 'goalresult.notified')) {
      const previous = noticeDays.get(notice.day);
      if (previous && previous !== notice.id) fail('multiple saved notifications on one day');
      noticeDays.set(notice.day, notice.id);
    }
  }
  for (const event of batch) {
    const definition = DEFINITIONS.get(event.projectId)!, npcPrior = prior[event.npc] ?? {};
    let state = working.get(event.npc) ?? readState(npcPrior, event.npc);
    if (state) {
      const old = state.events.find(old => old.id === event.id);
      if (old) { if (signature(old) !== signature(event)) fail('a repeated event changed'); continue; }
      if (serial(event.id) <= state.watermark) fail('archived replay requires global signature verification');
      if (serial(event.id) <= serial(state.events.at(-1)!.id)) fail('an unknown old event cannot be inserted');
      if (event.day < state.events.at(-1)!.day) fail('a new event predates current practice state');
      const current = project(state);
      if (event.kind === 'goalresult.started' && current.attempt?.cancelled) {
        state.watermark = serial(current.attempt.cancelled.id);
        state.events = state.events.filter(event => event.kind === 'goalresult.notified');
      }
    } else state = { version: 1, owner: event.npc, projectId: event.projectId, watermark: 0, sources: [], events: [] };
    const actual = sourceEvents(npcPrior, definition);
    if (actual) state.sources = structuredClone(actual);
    if (!state.sources.length) fail('a completed long-goal chapter is required');
    if (event.kind === 'goalresult.notified' && noticeDays.has(event.day)) fail('only one notification is allowed globally per day');
    state.events.push(event);
    const progress = project(state);
    if (event.kind === 'goalresult.notified') noticeDays.set(event.day, event.id);
    working.set(event.npc, state);
    let change = changes.get(event.npc);
    if (!change) { change = { npcId: event.npc, log: { goalResultEvents: [] }, memories: [] }; changes.set(event.npc, change); }
    (change.log!.goalResultEvents as Json[]).push(structuredClone(event) as unknown as Json);
    const memory = memoryFor(event, definition, progress);
    if (memory) change.memories!.push({ text: `第 ${event.day} 天：${memory.text}`, kind: memory.kind,
      importance: event.kind === 'goalresult.completed' || event.kind === 'goalresult.reviewed' ? 4 : 3,
      subjects: ['player'], topics: ['goalresult', `goalresult:${event.projectId}`, `goalresult:${event.id}`], visibility: 'private' });
    change.state = { ...npcPrior, goalResult: structuredClone(state) as unknown as Json };
  }
  return [...changes.values()];
}

/** Notification delivery is not reading or a new shared experience; only the current real attempt enters the prompt. */
export function goalResultContext(state: NpcState, day: number): string | undefined {
  if (!integer(day, 1, 1_000_000)) fail('invalid context day');
  const saved = readState(state);
  if (!saved || saved.events.at(-1)!.day > day) return undefined;
  const definition = DEFINITIONS.get(saved.projectId)!, attempt = project(saved).attempt;
  if (!attempt) return undefined;
  let text: string;
  if (attempt.cancelled) text = '上次尝试已结束且未完成，旧记录点不可用于新尝试。';
  else if (attempt.completed) text = `${evidence(definition, attempt.completed)}，${attempt.checkpoints.length} 个记录点齐全；收尾“${choiceLabel(definition.finishChoices, attempt.completed.choiceId!)}”。${attempt.reviewed
    ? `后来当面回访选择“${choiceLabel(definition.reviewChoices, attempt.reviewed.choiceId!)}”，这是反馈，未再次行动。`
    : '已形成回执，尚未进行次日回访。'}`;
  else text = `第 ${attempt.started.day} 天这次实践${attempt.started.day < day ? '已过期，不能继续或视为完成' : `已开始，方案“${choiceLabel(definition.planChoices, attempt.started.choiceId!)}”；已记录 ${attempt.checkpoints.length}/${definition.checkpoints.length} 个实际点，尚未完成`}。`;
  return `## 成果实践\n“${definition.title}”：${text}\n只认本次真实记录，不补写稿页、未记录的动作或其他世界变化。`;
}
