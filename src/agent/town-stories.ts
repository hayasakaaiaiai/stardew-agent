import { readFileSync } from 'node:fs';
import { SOCIAL_NPCS, type Json, type MemoryDraft, type NpcChange, type NpcState } from '../types.ts';
import { lifeSerial } from './life.ts';

export const STORY_IDS = ['gus_parcel', 'penny_field_notes', 'elliott_short_piece'] as const;
export const STORY_KINDS = ['story.started', 'story.clue', 'story.observed', 'story.choice', 'story.worked', 'story.resolved', 'story.told'] as const;
export const STORY_WEATHERS = ['sunny', 'rain', 'storm', 'snow', 'windy'] as const;
export type StoryId = typeof STORY_IDS[number];
export type StoryKind = typeof STORY_KINDS[number];
export type StoryWeather = typeof STORY_WEATHERS[number];
interface StoryEnding { id: string; title: string; text: string }
interface StoryBase { id: StoryId; owner: string; title: string; opening: string; references: string[]; endings: StoryEnding[] }
export interface InvestigationStory extends StoryBase {
  kind: 'investigation';
  clues: { id: string; witness?: string; text: string }[];
  site: { map: string; x: number; y: number; radius: number; label: string; hint: string };
}
export interface ProjectStory extends StoryBase {
  kind: 'project';
  observationVenues: { map: string; label: string }[];
  workVenues: string[];
  choices: { id: string; label: string; text: string }[];
}
export type StoryDefinition = InvestigationStory | ProjectStory;
const OWNERS: Record<StoryId, string> = { gus_parcel: 'gus', penny_field_notes: 'penny', elliott_short_piece: 'elliott' };
const NPCS = new Set<string>(SOCIAL_NPCS);
const VENUES: Record<string, string> = { Town: '镇上', Forest: '森林', Beach: '海滩', Trailer: '拖车屋',
  Trailer_Big: '潘妮家', ArchaeologyHouse: '博物馆', ElliottHouse: '艾利欧特的小屋' };
const WEATHER: Record<StoryWeather, string> = { sunny: '晴天', rain: '下雨', storm: '雷雨', snow: '下雪', windy: '刮风' };
const RECEIPT_LIMIT = 48;

function fail(message: string): never { throw new Error(`INVALID_STORY_EVENT: ${message}`); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function member<const T extends readonly unknown[]>(value: unknown, values: T): value is T[number] { return values.includes(value); }
function keys(value: Record<string, unknown>, allowed: readonly string[], required = allowed): boolean {
  return Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim()
    && !/[\p{C}#$@%{}*^\[\]|]/u.test(value);
}
function serial(value: unknown): number {
  if (typeof value !== 'string') fail('an event ID is required');
  try { return lifeSerial(value); } catch { fail('id must be life-<positive serial>'); }
}

/** Both the backend and the native Mod consume this bounded, authored configuration. */
export function parseStoryDefinitions(value: unknown): StoryDefinition[] {
  if (!object(value) || !keys(value, ['version', 'stories']) || value.version !== 1 || !Array.isArray(value.stories)
    || value.stories.length !== STORY_IDS.length) fail('story definitions must cover the three supported stories');
  const seen = new Set<string>();
  return value.stories.map(raw => {
    if (!object(raw) || !member(raw.id, STORY_IDS) || seen.has(raw.id) || raw.owner !== OWNERS[raw.id]
      || raw.kind !== (raw.id === 'gus_parcel' ? 'investigation' : 'project')) fail('invalid story owner, ID or kind');
    seen.add(raw.id);
    const common = ['id', 'kind', 'owner', 'title', 'opening', 'references', 'endings'];
    if (!keys(raw, [...common, ...(raw.kind === 'investigation' ? ['clues', 'site'] : ['observationVenues', 'workVenues', 'choices'])])
      || !text(raw.title, 80) || !text(raw.opening, 500) || !Array.isArray(raw.references) || raw.references.length < 2
      || raw.references.length > 10 || raw.references.some(ref => typeof ref !== 'string'
        || !/^(?:data\/npcs\/[a-z]+|reference\/wiki\/(?:zh|en)\/[A-Za-z]+)\.md$/.test(ref))) fail('invalid story prose or references');
    const choiceIds = raw.id === 'penny_field_notes' ? ['observe', 'read'] : ['open', 'bright'];
    const endingIds = raw.kind === 'investigation' ? ['returned', 'explained'] : ['independent', ...choiceIds];
    if (!Array.isArray(raw.endings) || raw.endings.length !== endingIds.length
      || raw.endings.some(ending => !object(ending) || !keys(ending, ['id', 'title', 'text'])
        || !member(ending.id, endingIds) || !text(ending.title, 100) || !text(ending.text, 1600))
      || new Set(raw.endings.map(ending => ending.id)).size !== endingIds.length) fail('invalid story endings');
    if (raw.kind === 'investigation') {
      const witnesses: Record<string, string | undefined> = { emily_mark: 'emily', pierre_mark: 'pierre', parcel: undefined };
      if (!Array.isArray(raw.clues) || raw.clues.length !== 3 || raw.clues.some(clue => !object(clue)
        || !keys(clue, ['id', 'witness', 'text'], ['id', 'text']) || typeof clue.id !== 'string'
        || !Object.hasOwn(witnesses, clue.id) || clue.witness !== witnesses[clue.id] || !text(clue.text, 500))
        || new Set(raw.clues.map(clue => clue.id)).size !== 3) fail('invalid investigation clues');
      if (!object(raw.site) || !keys(raw.site, ['map', 'x', 'y', 'radius', 'label', 'hint']) || raw.site.map !== 'Town'
        || !integer(raw.site.x, 0, 1000) || !integer(raw.site.y, 0, 1000) || !integer(raw.site.radius, 1, 10)
        || !text(raw.site.label, 80) || !text(raw.site.hint, 500)) fail('invalid investigation site');
    } else {
      const observationMaps = raw.id === 'penny_field_notes' ? ['Forest', 'Town'] : ['Beach', 'Forest'];
      const workMaps = raw.id === 'penny_field_notes' ? ['Trailer', 'Trailer_Big', 'ArchaeologyHouse', 'Town'] : ['ElliottHouse', 'Beach'];
      if (!Array.isArray(raw.observationVenues) || raw.observationVenues.length !== observationMaps.length
        || raw.observationVenues.some(venue => !object(venue) || !keys(venue, ['map', 'label'])
          || !member(venue.map, observationMaps) || !text(venue.label, 80))
        || new Set(raw.observationVenues.map(venue => venue.map)).size !== observationMaps.length
        || !Array.isArray(raw.workVenues) || raw.workVenues.length !== workMaps.length
        || raw.workVenues.some(map => !member(map, workMaps)) || new Set(raw.workVenues).size !== workMaps.length)
        fail('invalid project venues');
      if (!Array.isArray(raw.choices) || raw.choices.length !== choiceIds.length
        || raw.choices.some(choice => !object(choice) || !keys(choice, ['id', 'label', 'text'])
          || !member(choice.id, choiceIds) || !text(choice.label, 80) || !text(choice.text, 500))
        || new Set(raw.choices.map(choice => choice.id)).size !== choiceIds.length) fail('invalid project choices');
    }
    return structuredClone(raw) as unknown as StoryDefinition;
  });
}

export const STORY_DEFINITIONS: readonly StoryDefinition[] = parseStoryDefinitions(
  JSON.parse(readFileSync(new URL('../../data/town/stories.json', import.meta.url), 'utf8')),
);
const DEFINITIONS = new Map(STORY_DEFINITIONS.map(definition => [definition.id, definition]));
export function storyDefinition(id: string): StoryDefinition | undefined { return DEFINITIONS.get(id as StoryId); }
export const STORY_NPCS: readonly string[] = [...new Set(STORY_DEFINITIONS.flatMap(definition =>
  [definition.owner, ...(definition.kind === 'investigation' ? definition.clues.flatMap(clue => clue.witness ? [clue.witness] : []) : [])]))];

export interface StoryEvent {
  id: string;
  npc: string;
  day: number;
  kind: StoryKind;
  storyId: StoryId;
  clueId?: string;
  other?: string;
  venue?: string;
  weather?: StoryWeather;
  minutes?: number;
  choiceId?: string;
  sourceId?: string;
  step?: number;
  outcome?: string;
}
const EXTRA: Record<StoryKind, readonly string[]> = {
  'story.started': [], 'story.clue': ['clueId', 'other'], 'story.observed': ['venue', 'weather', 'minutes'],
  'story.choice': ['choiceId', 'sourceId'], 'story.worked': ['step', 'venue', 'minutes'],
  'story.resolved': ['outcome'], 'story.told': ['sourceId'],
};

/** Native evidence only; free dialogue cannot discover a clue, perform work or return the parcel. */
export function parseStoryEvents(value: unknown): StoryEvent[] {
  if (!Array.isArray(value) || value.length > 32) fail('events must contain at most 32 observations');
  let previous = 0;
  return value.map(raw => {
    if (!object(raw) || !member(raw.kind, STORY_KINDS) || !member(raw.storyId, STORY_IDS)
      || !keys(raw, ['id', 'npc', 'day', 'kind', 'storyId', ...EXTRA[raw.kind]], ['id', 'npc', 'day', 'kind', 'storyId']))
      fail('unknown kind, story or fields');
    const current = serial(raw.id), definition = DEFINITIONS.get(raw.storyId)!;
    if (current <= previous) fail('events must have increasing serials');
    previous = current;
    if (raw.npc !== definition.owner || !integer(raw.day, 1, 1_000_000)) fail('invalid owner or game day');
    if (raw.sourceId !== undefined && serial(raw.sourceId) >= current) fail('source must precede the event');
    if (raw.kind === 'story.clue') {
      if (definition.kind !== 'investigation') fail('only investigations have clues');
      const clue = definition.clues.find(clue => clue.id === raw.clueId);
      if (!clue || raw.other !== clue.witness || raw.other !== undefined && !NPCS.has(raw.other as string)) fail('clue or witness does not belong to this story');
    }
    if (raw.kind === 'story.observed' || raw.kind === 'story.choice' || raw.kind === 'story.worked') {
      if (definition.kind !== 'project') fail('this event requires a project');
      if (raw.kind === 'story.observed' && (!definition.observationVenues.some(venue => venue.map === raw.venue)
        || !member(raw.weather, STORY_WEATHERS) || !integer(raw.minutes, 10, 1440))) fail('invalid observed location, weather or duration');
      if (raw.kind === 'story.choice' && (!definition.choices.some(choice => choice.id === raw.choiceId) || raw.sourceId === undefined))
        fail('choice requires a supported option and its observation source');
      if (raw.kind === 'story.worked' && (!member(raw.step, [1, 2] as const) || !member(raw.venue, definition.workVenues)
        || !integer(raw.minutes, 30, 1440))) fail('invalid native work evidence');
    }
    if (raw.kind === 'story.resolved' && !definition.endings.some(ending => ending.id === raw.outcome)) fail('unsupported outcome');
    if (raw.kind === 'story.told' && raw.sourceId === undefined) fail('telling requires a clue or observation source');
    return structuredClone(raw) as unknown as StoryEvent;
  });
}

/** Preload only the authoritative owner and the actual witness whose own words become a memory. */
export function storyNpcIds(event: StoryEvent): string[] { return event.other ? [event.npc, event.other] : [event.npc]; }

interface Source {
  id: string;
  day: number;
  kind: 'clue' | 'observed';
  clueId?: string;
  venue?: string;
  weather?: StoryWeather;
  minutes?: number;
}
interface Choice { id: string; day: number; choiceId: string; sourceId: string }
interface Work { id: string; day: number; step: number; venue: string; minutes: number }
interface Resolution { id: string; day: number; outcome: string }
interface Progress {
  started: { id: string; day: number };
  sources: Source[];
  choice: Choice | null;
  work: Work[];
  resolution: Resolution | null;
  told: string[];
}
interface Knowledge {
  role: 'owner' | 'witness';
  startedDay: number | null;
  sources: Source[];
  choice: Choice | null;
  work: Work[];
  resolution: Resolution | null;
}
interface StoryState {
  version: 1;
  lastSerial: number;
  updatedDay: number;
  progress: Partial<Record<StoryId, Progress>>;
  knowledge: Partial<Record<StoryId, Knowledge>>;
  recent: { id: string; signature: string }[];
}
const EMPTY_KNOWLEDGE = (): Knowledge => ({ role: 'owner', startedDay: null, sources: [], choice: null, work: [], resolution: null });
function stamp(value: unknown): value is Record<string, unknown> & { id: string; day: number } {
  return object(value) && serial(value.id) > 0 && integer(value.day, 1, 1_000_000);
}
function validSource(value: unknown, definition: StoryDefinition): value is Source {
  if (!stamp(value)) return false;
  const source = value as unknown as Record<string, unknown>;
  if (source.kind === 'clue') return definition.kind === 'investigation' && keys(source, ['id', 'day', 'kind', 'clueId'])
    && definition.clues.some(clue => clue.id === source.clueId);
  return source.kind === 'observed' && definition.kind === 'project'
    && keys(source, ['id', 'day', 'kind', 'venue', 'weather', 'minutes'])
    && definition.observationVenues.some(venue => venue.map === source.venue) && member(source.weather, STORY_WEATHERS)
    && integer(source.minutes, 10, 1440);
}
function validChoice(value: unknown, definition: StoryDefinition): value is Choice | null {
  if (value === null) return true;
  return definition.kind === 'project' && stamp(value) && keys(value, ['id', 'day', 'choiceId', 'sourceId'])
    && definition.choices.some(choice => choice.id === value.choiceId) && serial(value.sourceId) < serial(value.id);
}
function validWork(value: unknown, definition: StoryDefinition): value is Work[] {
  return Array.isArray(value) && value.length <= 2 && value.every((work, index) => definition.kind === 'project'
    && stamp(work) && keys(work, ['id', 'day', 'step', 'venue', 'minutes']) && work.step === index + 1
    && member(work.venue, definition.workVenues) && integer(work.minutes, 30, 1440)
    && (index === 0 || work.day > value[index - 1].day && serial(work.id) > serial(value[index - 1].id)));
}
function validResolution(value: unknown, definition: StoryDefinition): value is Resolution | null {
  return value === null || stamp(value) && keys(value, ['id', 'day', 'outcome'])
    && definition.endings.some(ending => ending.id === value.outcome);
}
function sameFields(left: object | null, right: object | null): boolean {
  if (left === null || right === null) return left === right;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key]);
}
function readState(state: NpcState): StoryState {
  const raw = state.story;
  if (raw === undefined) return { version: 1, lastSerial: 0, updatedDay: 0, progress: {}, knowledge: {}, recent: [] };
  if (!object(raw) || !keys(raw, ['version', 'lastSerial', 'updatedDay', 'progress', 'knowledge', 'recent']) || raw.version !== 1
    || !integer(raw.lastSerial, 0, Number.MAX_SAFE_INTEGER) || !integer(raw.updatedDay, 0, 1_000_000)
    || !object(raw.progress) || !object(raw.knowledge) || !Array.isArray(raw.recent) || raw.recent.length > RECEIPT_LIMIT
    || raw.recent.some(receipt => !object(receipt) || !keys(receipt, ['id', 'signature'])
      || serial(receipt.id) > (raw.lastSerial as number) || typeof receipt.signature !== 'string')) fail('invalid saved story state');
  const lastSerial = raw.lastSerial, updatedDay = raw.updatedDay;
  for (const [id, candidate] of Object.entries(raw.progress)) {
    const definition = storyDefinition(id);
    if (!definition || !object(candidate) || !keys(candidate, ['started', 'sources', 'choice', 'work', 'resolution', 'told'])
      || !stamp(candidate.started) || !keys(candidate.started, ['id', 'day']) || !Array.isArray(candidate.sources)
      || candidate.sources.length > (definition.kind === 'investigation' ? 3 : 1) || !candidate.sources.every(source => validSource(source, definition))
      || new Set(candidate.sources.map(source => source.id)).size !== candidate.sources.length
      || new Set(candidate.sources.map(source => source.clueId ?? source.kind)).size !== candidate.sources.length
      || !validChoice(candidate.choice, definition) || !validWork(candidate.work, definition) || !validResolution(candidate.resolution, definition)
      || !Array.isArray(candidate.told) || candidate.told.length > candidate.sources.length
      || new Set(candidate.told).size !== candidate.told.length)
      fail('invalid saved story progress');
    const progress = candidate as unknown as Progress;
    const evidence = [...progress.sources, ...progress.work, ...(progress.choice ? [progress.choice] : []),
      ...(progress.resolution ? [progress.resolution] : [])];
    if (serial(progress.started.id) > lastSerial || progress.started.day > updatedDay
      || progress.told.some(sourceId => !progress.sources.some(source => source.id === sourceId))
      || evidence.some(source => source.day < progress.started.day || serial(source.id) <= serial(progress.started.id)
        || serial(source.id) > lastSerial || source.day > updatedDay)
      || progress.choice && !progress.sources.some(source => source.kind === 'observed' && source.id === progress.choice!.sourceId
        && source.day <= progress.choice!.day)
      || progress.work[0] && progress.work[0].day <= progress.started.day
      || progress.resolution && [...progress.sources, ...progress.work, ...(progress.choice ? [progress.choice] : [])]
        .some(source => source.day > progress.resolution!.day || serial(source.id) >= serial(progress.resolution!.id))
      || progress.resolution && (definition.kind === 'project'
        ? progress.work.length !== 2 || progress.resolution.outcome !== (progress.choice?.choiceId ?? 'independent')
        : !progress.sources.some(source => source.clueId === 'parcel')
          || progress.resolution.outcome === 'explained' && progress.sources.length !== 3)) fail('inconsistent saved story progress');
  }
  for (const [id, candidate] of Object.entries(raw.knowledge)) {
    const definition = storyDefinition(id);
    if (!definition || !object(candidate) || !keys(candidate, ['role', 'startedDay', 'sources', 'choice', 'work', 'resolution'])
      || !member(candidate.role, ['owner', 'witness'] as const)
      || candidate.startedDay !== null && !integer(candidate.startedDay, 1, raw.updatedDay)
      || !Array.isArray(candidate.sources) || candidate.sources.length > (definition.kind === 'investigation' ? 3 : 1)
      || !candidate.sources.every(source => validSource(source, definition))
      || new Set(candidate.sources.map(source => source.id)).size !== candidate.sources.length
      || !validChoice(candidate.choice, definition) || !validWork(candidate.work, definition) || !validResolution(candidate.resolution, definition)
      || candidate.role === 'witness' && (definition.kind !== 'investigation' || candidate.startedDay !== null
        || candidate.choice !== null || candidate.work.length !== 0 || candidate.resolution !== null
        || candidate.sources.some(source => source.kind !== 'clue' || source.clueId === 'parcel')))
      fail('invalid saved story knowledge');
    const known = candidate as unknown as Knowledge, owned = raw.progress[id] as unknown as Progress | undefined;
    const facts = [...known.sources, ...known.work, ...(known.choice ? [known.choice] : []), ...(known.resolution ? [known.resolution] : [])];
    if (facts.some(fact => fact.day > updatedDay || serial(fact.id) > lastSerial)
      || known.role === 'witness' && (owned !== undefined || known.sources.length !== 1)
      || known.role === 'owner' && (!owned || known.startedDay !== owned.started.day
        || known.sources.length !== owned.told.length
        || known.sources.some(source => !owned.told.includes(source.id) || !owned.sources.some(actual => sameFields(source, actual)))
        || !sameFields(known.choice, owned.choice) || !sameFields(known.resolution, owned.resolution)
        || known.work.length !== owned.work.length || known.work.some((work, index) => !sameFields(work, owned.work[index]!))))
      fail('inconsistent saved story knowledge');
  }
  return structuredClone(raw) as unknown as StoryState;
}
function signature(event: StoryEvent): string { return JSON.stringify(Object.fromEntries(Object.entries(event).sort(([a], [b]) => a.localeCompare(b)))); }
function seen(state: StoryState, event: StoryEvent): boolean {
  const receipt = state.recent.find(receipt => receipt.id === event.id);
  if (receipt && receipt.signature !== signature(event)) fail('an event ID was reused with different content');
  return serial(event.id) <= state.lastSerial;
}
function sourceFact(definition: StoryDefinition, source: Source, ownTestimony = false): string {
  if (source.kind === 'clue' && definition.kind === 'investigation') {
    const clue = definition.clues.find(clue => clue.id === source.clueId)!;
    const name = clue.witness === 'emily' ? '艾米丽' : '皮埃尔';
    return clue.witness && !ownTestimony ? `${name}的当面证词：“${clue.text}”` : clue.text;
  }
  return `第 ${source.day} 天在${VENUES[source.venue!]!}实际观察了 ${source.minutes} 分钟，当时${WEATHER[source.weather!]}。`;
}
function resolutionFact(definition: StoryDefinition, progress: Progress): string {
  const outcome = progress.resolution!.outcome;
  const ending = definition.endings.find(ending => ending.id === outcome)!;
  if (definition.kind === 'investigation') return outcome === 'explained'
    ? `农场主把故事包裹当面归还给我，并结合两份证词核清了备货标记的混淆；“${definition.title}”以“${ending.title}”结束。`
    : `农场主已把故事包裹当面归还给我；“${definition.title}”以“${ending.title}”结束，没有记录为已核清全部标记。`;
  return `我经过两个不同工作日完成了“${definition.title}”的“${ending.title}”版本。${progress.choice
    ? `农场主实际提供过观察，并当面选择了“${definition.choices.find(choice => choice.id === progress.choice!.choiceId)!.label}”。`
    : '这是我独立完成的版本，没有记录农场主的观察建议贡献。'}`;
}

/** Pure projection. Authority is hidden from conversation until the corresponding NPC actually learns it. */
export function storyChanges(events: readonly StoryEvent[], prior: Readonly<Record<string, NpcState>>): NpcChange[] {
  const batch = parseStoryEvents(events), working = new Map<string, StoryState>(), changes = new Map<string, NpcChange>();
  const stateFor = (npc: string) => {
    let state = working.get(npc);
    if (!state) { state = readState(prior[npc] ?? {}); working.set(npc, state); }
    return state;
  };
  const record = (npc: string, state: StoryState, event: StoryEvent, prose?: string, kind: MemoryDraft['kind'] = 'observation') => {
    if (event.day < state.updatedDay) fail('a new observation predates current story state');
    state.lastSerial = serial(event.id); state.updatedDay = event.day;
    state.recent = [...state.recent, { id: event.id, signature: signature(event) }].slice(-RECEIPT_LIMIT);
    let change = changes.get(npc);
    if (!change) { change = { npcId: npc, log: { storyEvents: [] }, memories: [] }; changes.set(npc, change); }
    (change.log!.storyEvents as Json[]).push(structuredClone(event) as unknown as Json);
    if (prose) change.memories!.push({ text: `第 ${event.day} 天：${prose}`, kind, importance: event.kind === 'story.resolved' ? 4 : 3,
      subjects: ['player'], topics: ['story', `story:${event.storyId}`, `story:${event.id}`], visibility: 'private' });
    change.state = { ...(prior[npc] ?? {}), story: structuredClone(state) as unknown as Json };
  };
  for (const event of batch) {
    const definition = DEFINITIONS.get(event.storyId)!, state = stateFor(event.npc);
    const witnessState = event.other ? stateFor(event.other) : undefined;
    const ownerSeen = seen(state, event), witnessSeen = witnessState ? seen(witnessState, event) : true;
    if (ownerSeen && witnessSeen) continue;
    // Multi-NPC observations are committed atomically, so a one-sided replay is corrupted rather than a new clue.
    if (ownerSeen !== witnessSeen && witnessState) fail('inconsistent witness replay');
    if (event.day < state.updatedDay || witnessState && event.day < witnessState.updatedDay) fail('a new observation predates current story state');
    const progress = state.progress[event.storyId];
    const knowledge = state.knowledge[event.storyId] ??= EMPTY_KNOWLEDGE();
    if (event.kind !== 'story.started' && !progress) fail('the story has not started');
    if (progress?.resolution && event.kind !== 'story.told') fail('the story has already resolved');
    let prose: string | undefined, memoryKind: MemoryDraft['kind'] = 'observation';
    switch (event.kind) {
      case 'story.started':
        if (progress) fail('each story can only start once on a save branch');
        state.progress[event.storyId] = { started: { id: event.id, day: event.day }, sources: [], choice: null, work: [], resolution: null, told: [] };
        knowledge.startedDay = event.day;
        prose = definition.kind === 'investigation'
          ? `我当面向农场主说明了“${definition.title}”，调查刚刚开始，尚未找到或归还包裹。`
          : `我当面向农场主提起准备“${definition.title}”的打算，项目刚开始；农场主尚未提供观察建议，我也还没有完成成品。`;
        break;
      case 'story.clue': {
        if (progress!.sources.some(source => source.clueId === event.clueId)) fail('the clue was already obtained');
        const source: Source = { id: event.id, day: event.day, kind: 'clue', clueId: event.clueId! };
        progress!.sources.push(source);
        if (witnessState) {
          const known = witnessState.knowledge[event.storyId] ??= { ...EMPTY_KNOWLEDGE(), role: 'witness' };
          known.sources.push(structuredClone(source));
          record(event.other!, witnessState, event, `农场主当面询问“${definition.title}”，我告诉了自己掌握的这条线索：${sourceFact(definition, source, true)}其他调查进展没有因此告诉我。`);
        }
        break;
      }
      case 'story.observed':
        if (progress!.sources.length) fail('a project keeps only its first actual observation');
        progress!.sources.push({ id: event.id, day: event.day, kind: 'observed', venue: event.venue!, weather: event.weather!, minutes: event.minutes! });
        break;
      case 'story.choice': {
        if (progress!.choice) fail('the project contribution was already chosen');
        const source = progress!.sources.find(source => source.id === event.sourceId && source.kind === 'observed');
        if (!source || source.day > event.day) fail('the choice needs this project actual observation');
        const choice: Choice = { id: event.id, day: event.day, choiceId: event.choiceId!, sourceId: event.sourceId! };
        progress!.choice = choice; knowledge.choice = structuredClone(choice);
        if (!knowledge.sources.some(known => known.id === source.id)) knowledge.sources.push(structuredClone(source));
        if (!progress!.told.includes(source.id)) progress!.told.push(source.id);
        prose = `农场主当面告诉我其观察：${sourceFact(definition, source)}并明确建议“${(definition as ProjectStory).choices.find(choice => choice.id === event.choiceId)!.label}”。建议已经记下，尚不能据此说成品完成。`;
        memoryKind = 'heard';
        break;
      }
      case 'story.worked': {
        const expected = progress!.work.length + 1, previousDay = progress!.work.at(-1)?.day ?? progress!.started.day;
        if (event.step !== expected || event.day <= previousDay) fail('work requires the next stage on a later game day');
        const work: Work = { id: event.id, day: event.day, step: event.step!, venue: event.venue!, minutes: event.minutes! };
        progress!.work.push(work); knowledge.work.push(structuredClone(work));
        prose = `我在${VENUES[event.venue!]!}为“${definition.title}”实际工作了 ${event.minutes} 分钟，完成第 ${event.step} 阶段。${event.step === 1 ? '后续阶段还未完成。' : '两阶段工作已完成，成品结局以另行确认的记录为准。'}`;
        break;
      }
      case 'story.resolved':
        if (definition.kind === 'investigation') {
          if (!progress!.sources.some(source => source.clueId === 'parcel')
            || event.outcome === 'explained' && !['emily_mark', 'pierre_mark'].every(id => progress!.sources.some(source => source.clueId === id)))
            fail('returning needs the acquired parcel; explaining also needs both witnesses');
        } else if (progress!.work.length !== 2 || event.outcome !== (progress!.choice?.choiceId ?? 'independent'))
          fail('project outcome must match two real work stages and the actual contribution');
        progress!.resolution = { id: event.id, day: event.day, outcome: event.outcome! };
        knowledge.resolution = structuredClone(progress!.resolution);
        if (definition.kind === 'investigation') {
          const revealed = progress!.sources.filter(source => source.clueId === 'parcel' || event.outcome === 'explained');
          for (const source of revealed) {
            if (!knowledge.sources.some(known => known.id === source.id)) knowledge.sources.push(structuredClone(source));
            if (!progress!.told.includes(source.id)) progress!.told.push(source.id);
          }
        }
        prose = resolutionFact(definition, progress!);
        break;
      case 'story.told': {
        const source = progress!.sources.find(source => source.id === event.sourceId);
        if (!source || source.day > event.day) fail('telling needs this story existing clue or observation');
        if (progress!.told.includes(source.id)) fail('the source was already told to its owner');
        progress!.told.push(source.id); knowledge.sources.push(structuredClone(source));
        prose = `农场主当面向我汇报第 ${source.day} 天取得的${source.kind === 'clue' ? '线索' : '观察'}：${sourceFact(definition, source)}这是农场主告诉我的，不是我在场亲历。`;
        memoryKind = 'heard';
        break;
      }
    }
    record(event.npc, state, event, prose, memoryKind);
  }
  return [...changes.values()];
}

/** Expose only this character's own known facts; hidden authoritative progress never enters the prompt. */
export function storyContext(state: NpcState, today: number): string | undefined {
  if (!integer(today, 1, 1_000_000)) fail('invalid context day');
  if (state.story === undefined) return undefined;
  const current = readState(state);
  if (!current.lastSerial || current.updatedDay > today) return undefined;
  const lines: string[] = [];
  for (const id of STORY_IDS) {
    const known = current.knowledge[id], definition = DEFINITIONS.get(id)!;
    if (!known) continue;
    const details: string[] = [];
    if (known.startedDay !== null) details.push(`第 ${known.startedDay} 天，我向农场主提起此事`);
    for (const source of known.sources) details.push(known.role === 'witness'
      ? `我当面提供过线索：${sourceFact(definition, source, true)}`
      : `农场主已当面告诉我：${sourceFact(definition, source)}`);
    if (known.choice && definition.kind === 'project') details.push(`农场主明确建议“${definition.choices.find(choice => choice.id === known.choice!.choiceId)!.label}”`);
    if (known.work.length) details.push(`我已在第 ${known.work.map(work => work.day).join('、')} 天分别完成 ${known.work.length} 个实际工作阶段`);
    if (known.resolution) details.push(`第 ${known.resolution.day} 天已结束，结局为“${definition.endings.find(ending => ending.id === known.resolution!.outcome)!.title}”${known.resolution.outcome === 'independent' ? '，由我独立完成，没有玩家建议贡献' : ''}`);
    else if (known.role === 'owner') details.push(definition.kind === 'project' ? '尚未记录成品完成' : '尚未记录包裹归还');
    if (details.length) lines.push(`“${definition.title}”：${details.join('；')}。`);
  }
  return lines.length ? `## 我知道的镇上近况\n${lines.join('\n')}\n只采用这里已知的情况；未汇报的调查、他人的进展和未选结局不作已知。观察题不等于孩子已上课，短文不等于小说出版；不补写未提供的成品内容。` : undefined;
}
