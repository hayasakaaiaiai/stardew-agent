import { readFileSync } from 'node:fs';
import { lifeSerial } from './life.ts';
import { storyContext } from './town-stories.ts';
import type { Json, MemoryDraft, NpcChange, NpcState } from '../types.ts';

export const LONG_GOAL_IDS = ['penny_learning_book', 'elliott_triptych', 'leah_form_study', 'maru_field_holder',
  'robin_small_space', 'willy_shore_guide', 'linus_light_steps'] as const;
export const LONG_GOAL_KINDS = ['longgoal.started', 'longgoal.observed', 'longgoal.contributed', 'longgoal.choice',
  'longgoal.worked', 'longgoal.completed'] as const;
export type LongGoalId = typeof LONG_GOAL_IDS[number];
export type LongGoalKind = typeof LONG_GOAL_KINDS[number];
type Weather = 'sunny' | 'rain' | 'storm' | 'snow' | 'windy';
type ChapterId = 1 | 2 | 3;
type Outcome = 'default' | 'a' | 'b';
interface ObservationContribution {
  id: 'observation'; kind: 'observation'; venues: { map: string; label: string }[]; minutes: 10; hint: string;
}
interface MaterialContribution { id: 'materials'; kind: 'material'; itemId: string; count: number; label: string; purpose: string }
export interface LongGoalChapter {
  id: ChapterId; title: string; opening: string; contribution: ObservationContribution | MaterialContribution;
  choices: { id: 'a' | 'b'; label: string; text: string }[];
  outputs: { id: Outcome; title: string; text: string }[];
}
export interface LongGoalDefinition {
  id: LongGoalId; owner: string; title: string; opening: string; references: string[]; requiresStory?: string;
  workVenues: string[]; collectionTitle: string; collectionIntro: string; collectionClosing: string; chapters: LongGoalChapter[];
}
interface GoalContract { owner: string; story?: string; work: string[]; observations: (string | null)[]; material?: { itemId: string; count: number } }
const CONTRACTS: Record<LongGoalId, GoalContract> = {
  penny_learning_book: { owner: 'penny', story: 'penny_field_notes', work: ['Trailer', 'Trailer_Big', 'ArchaeologyHouse', 'Town'], observations: ['Town', 'Forest', 'Mountain'] },
  elliott_triptych: { owner: 'elliott', story: 'elliott_short_piece', work: ['ElliottHouse', 'Beach'], observations: ['Beach', 'Town', 'Forest'] },
  leah_form_study: { owner: 'leah', work: ['LeahHouse', 'Forest', 'Beach'], observations: ['Forest', null, 'Beach'], material: { itemId: '(O)388', count: 4 } },
  maru_field_holder: { owner: 'maru', work: ['ScienceHouse', 'Mountain'], observations: ['Mountain', null, 'Town'], material: { itemId: '(O)334', count: 2 } },
  robin_small_space: { owner: 'robin', work: ['ScienceHouse'], observations: ['Town', null, 'Mountain'], material: { itemId: '(O)388', count: 8 } },
  willy_shore_guide: { owner: 'willy', work: ['FishShop', 'Beach'], observations: ['Beach', null, 'Forest'], material: { itemId: '(O)388', count: 4 } },
  linus_light_steps: { owner: 'linus', work: ['Tent', 'Mountain'], observations: ['Mountain', null, 'Forest'], material: { itemId: '(O)388', count: 3 } },
};
const WEATHER: Record<Weather, string> = { sunny: '晴天', rain: '下雨', storm: '雷雨', snow: '下雪', windy: '刮风' };
const VENUES: Record<string, string> = { Town: '镇上', Forest: '森林', Mountain: '山区', Beach: '海滩', Trailer: '拖车屋',
  Trailer_Big: '潘妮家', ArchaeologyHouse: '博物馆', ElliottHouse: '艾利欧特的小屋', LeahHouse: '莉亚的小屋',
  ScienceHouse: '木匠家', FishShop: '鱼店', Tent: '帐篷', FarmHouse: '农舍' };
const SPOUSE_OWNERS = ['penny', 'elliott', 'leah', 'maru'];
const MAX_EVENTS = 19;

function fail(message: string): never { throw new Error(`INVALID_LONG_GOAL_EVENT: ${message}`); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function member<const T extends readonly unknown[]>(value: unknown, values: T): value is T[number] { return values.includes(value); }
function keys(value: Record<string, unknown>, allowed: readonly string[], required = allowed): boolean {
  return Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
}
function prose(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim()
    && !/[\p{C}#$@%{}*^\[\]|]/u.test(value);
}
function serial(value: unknown): number {
  if (typeof value !== 'string') fail('an event ID is required');
  try { return lifeSerial(value); } catch { fail('id must be life-<positive serial>'); }
}
function signature(event: LongGoalEvent): string {
  return JSON.stringify(Object.fromEntries(Object.entries(event).sort(([a], [b]) => a.localeCompare(b))));
}

/** Authored projects are bounded and immutable; configuration cannot invent rewards or arbitrary game actions. */
export function parseLongGoalDefinitions(value: unknown): LongGoalDefinition[] {
  if (!object(value) || !keys(value, ['version', 'goals']) || value.version !== 1 || !Array.isArray(value.goals)
    || value.goals.length !== LONG_GOAL_IDS.length) fail('definitions must cover the seven supported goals');
  const seen = new Set<string>();
  return value.goals.map(raw => {
    if (!object(raw) || !member(raw.id, LONG_GOAL_IDS) || seen.has(raw.id)) fail('invalid or duplicate goal ID');
    const contract = CONTRACTS[raw.id];
    seen.add(raw.id);
    const common = ['id', 'owner', 'title', 'opening', 'references', 'workVenues', 'collectionTitle', 'collectionIntro', 'collectionClosing', 'chapters'];
    if (!keys(raw, [...common, ...(contract.story ? ['requiresStory'] : [])]) || raw.owner !== contract.owner
      || raw.requiresStory !== contract.story || !prose(raw.title, 100) || !prose(raw.opening, 600)
      || !prose(raw.collectionTitle, 100) || !prose(raw.collectionIntro, 800) || !prose(raw.collectionClosing, 800)
      || !Array.isArray(raw.references) || raw.references.length < 2 || raw.references.length > 10
      || raw.references.some(ref => typeof ref !== 'string' || !/^(?:data\/npcs\/[a-z]+|reference\/wiki\/(?:zh|en)\/[A-Za-z]+)\.md$/.test(ref)))
      fail('invalid owner, prerequisite, prose or references');
    if (!Array.isArray(raw.workVenues) || raw.workVenues.length !== contract.work.length
      || raw.workVenues.some(map => !member(map, contract.work)) || new Set(raw.workVenues).size !== contract.work.length)
      fail('invalid work venues');
    if (!Array.isArray(raw.chapters) || raw.chapters.length !== 3) fail('each goal needs three chapters');
    for (const [index, chapter] of raw.chapters.entries()) {
      if (!object(chapter) || !keys(chapter, ['id', 'title', 'opening', 'contribution', 'choices', 'outputs']) || chapter.id !== index + 1
        || !prose(chapter.title, 100) || !prose(chapter.opening, 600) || !object(chapter.contribution)) fail('invalid chapter');
      const contribution = chapter.contribution, map = contract.observations[index];
      if (map !== null) {
        if (!keys(contribution, ['id', 'kind', 'venues', 'minutes', 'hint']) || contribution.id !== 'observation'
          || contribution.kind !== 'observation' || contribution.minutes !== 10 || !prose(contribution.hint, 600)
          || !Array.isArray(contribution.venues) || contribution.venues.length !== 1
          || contribution.venues.some(venue => !object(venue) || !keys(venue, ['map', 'label']) || venue.map !== map || !prose(venue.label, 80)))
          fail('invalid chapter observation');
      } else if (!keys(contribution, ['id', 'kind', 'itemId', 'count', 'label', 'purpose']) || contribution.id !== 'materials'
        || contribution.kind !== 'material' || contribution.itemId !== contract.material!.itemId || contribution.count !== contract.material!.count
        || !prose(contribution.label, 80) || !prose(contribution.purpose, 600)) fail('invalid chapter materials');
      if (!Array.isArray(chapter.choices) || chapter.choices.length !== 2
        || chapter.choices.some(choice => !object(choice) || !keys(choice, ['id', 'label', 'text']) || !member(choice.id, ['a', 'b'])
          || !prose(choice.label, 100) || !prose(choice.text, 600)) || new Set(chapter.choices.map(choice => choice.id)).size !== 2)
        fail('invalid chapter choices');
      if (!Array.isArray(chapter.outputs) || chapter.outputs.length !== 3
        || chapter.outputs.some(output => !object(output) || !keys(output, ['id', 'title', 'text']) || !member(output.id, ['default', 'a', 'b'])
          || !prose(output.title, 100) || !prose(output.text, 1600)) || new Set(chapter.outputs.map(output => output.id)).size !== 3)
        fail('invalid chapter outputs');
    }
    return structuredClone(raw) as unknown as LongGoalDefinition;
  });
}

export const LONG_GOAL_DEFINITIONS: readonly LongGoalDefinition[] = parseLongGoalDefinitions(
  JSON.parse(readFileSync(new URL('../../data/town/long-goals.json', import.meta.url), 'utf8')),
);
const DEFINITIONS = new Map(LONG_GOAL_DEFINITIONS.map(definition => [definition.id, definition]));
export const LONG_GOAL_NPCS: readonly string[] = LONG_GOAL_DEFINITIONS.map(definition => definition.owner);
export function longGoalDefinition(id: string): LongGoalDefinition | undefined { return DEFINITIONS.get(id as LongGoalId); }

export interface LongGoalEvent {
  id: string; npc: string; day: number; kind: LongGoalKind; longGoalId: LongGoalId;
  dependencySourceId?: string; chapterId?: number; contributionId?: string; venue?: string; weather?: Weather; minutes?: number;
  sourceId?: string; itemId?: string; count?: number; choiceId?: string; step?: number; outcome?: string;
}
const BASE = ['id', 'npc', 'day', 'kind', 'longGoalId'];

/** Only native evidence and explicit menu actions may enter this journal. */
export function parseLongGoalEvents(value: unknown): LongGoalEvent[] {
  if (!Array.isArray(value) || value.length > 32) fail('events must contain at most 32 observations');
  let previous = 0;
  return value.map(raw => {
    if (!object(raw) || !member(raw.kind, LONG_GOAL_KINDS) || !member(raw.longGoalId, LONG_GOAL_IDS)) fail('unknown kind or goal ID');
    const current = serial(raw.id), definition = DEFINITIONS.get(raw.longGoalId)!;
    if (current <= previous) fail('events must have increasing serials');
    previous = current;
    if (raw.npc !== definition.owner || !integer(raw.day, 1, 1_000_000)) fail('invalid owner or game day');
    if (raw.kind === 'longgoal.started') {
      if (!keys(raw, [...BASE, ...(definition.requiresStory ? ['dependencySourceId'] : [])])) fail('invalid start fields or prerequisite');
      if (definition.requiresStory && serial(raw.dependencySourceId) >= current) fail('dependency source must precede start');
    } else {
      if (!member(raw.chapterId, [1, 2, 3] as const)) fail('chapter ID must be 1, 2 or 3');
      const chapter = definition.chapters[raw.chapterId - 1]!, contribution = chapter.contribution;
      let extra: string[];
      switch (raw.kind) {
        case 'longgoal.observed':
          extra = ['contributionId', 'venue', 'weather', 'minutes'];
          if (contribution.kind !== 'observation' || raw.contributionId !== contribution.id
            || !contribution.venues.some(venue => venue.map === raw.venue) || !member(raw.weather, Object.keys(WEATHER))
            || !integer(raw.minutes, 10, 1440)) fail('invalid observation evidence');
          break;
        case 'longgoal.contributed':
          extra = contribution.kind === 'observation' ? ['contributionId', 'sourceId'] : ['contributionId', 'itemId', 'count'];
          if (raw.contributionId !== contribution.id || contribution.kind === 'material'
            && (raw.itemId !== contribution.itemId || raw.count !== contribution.count)) fail('invalid contribution or materials');
          break;
        case 'longgoal.choice':
          extra = ['choiceId', 'sourceId'];
          if (!member(raw.choiceId, ['a', 'b'])) fail('unsupported chapter choice');
          break;
        case 'longgoal.worked':
          extra = ['step', 'venue', 'minutes'];
          if (!member(raw.step, [1, 2]) || !integer(raw.minutes, 30, 1440)
            || !member(raw.venue, definition.workVenues) && !(raw.venue === 'FarmHouse' && SPOUSE_OWNERS.includes(definition.owner)))
            fail('invalid work evidence');
          break;
        case 'longgoal.completed':
          extra = ['outcome'];
          if (!member(raw.outcome, ['default', 'a', 'b'])) fail('invalid chapter outcome');
          break;
      }
      if (!keys(raw, [...BASE, 'chapterId', ...extra])) fail('unexpected or missing event fields');
      if (extra.includes('sourceId') && serial(raw.sourceId) >= current) fail('source must precede the event');
    }
    return structuredClone(raw) as unknown as LongGoalEvent;
  });
}

interface Dependency { storyId: string; id: string; day: number }
interface LongGoalState { version: 1; owner: string; dependency: Dependency | null; events: LongGoalEvent[] }
interface ChapterProgress {
  id: ChapterId; opened: { id: string; day: number }; observation: LongGoalEvent | null; contribution: LongGoalEvent | null;
  choice: LongGoalEvent | null; work: LongGoalEvent[]; completed: LongGoalEvent | null;
}
interface Progress { definition: LongGoalDefinition; started: LongGoalEvent; chapters: ChapterProgress[] }
const newChapter = (id: ChapterId, opened: { id: string; day: number }): ChapterProgress =>
  ({ id, opened: { id: opened.id, day: opened.day }, observation: null, contribution: null, choice: null, work: [], completed: null });

function dependencyFromStory(state: NpcState, definition: LongGoalDefinition, started: LongGoalEvent): Dependency {
  // Reuse the existing validator without changing the v1 story schema or its projection semantics.
  if (!object(state.story)) fail('a completed prerequisite story is required');
  try { storyContext(state, started.day); } catch { fail('invalid prerequisite story state'); }
  const progress = state.story.progress;
  const story = object(progress) ? progress[definition.requiresStory!] : undefined;
  const resolution = object(story) ? story.resolution : undefined;
  if (!object(resolution) || typeof resolution.id !== 'string' || !integer(resolution.day, 1, 1_000_000)
    || resolution.id !== started.dependencySourceId || serial(resolution.id) >= serial(started.id) || resolution.day >= started.day)
    fail('the exact prerequisite resolution must precede start on an earlier day');
  return { storyId: definition.requiresStory!, id: resolution.id, day: resolution.day };
}

/** Replay is deliberately bounded: one project per owner, three chapters and at most nineteen events. */
function project(events: readonly LongGoalEvent[], dependency: Dependency | null): Progress {
  const started = events[0];
  if (!started || started.kind !== 'longgoal.started') fail('the project has not started');
  const definition = DEFINITIONS.get(started.longGoalId)!;
  if (definition.requiresStory) {
    if (!dependency || dependency.storyId !== definition.requiresStory || dependency.id !== started.dependencySourceId
      || serial(dependency.id) >= serial(started.id) || dependency.day >= started.day) fail('invalid saved dependency');
  } else if (dependency !== null) fail('an independent project cannot have a dependency');
  const progress: Progress = { definition, started, chapters: [newChapter(1, started)] };
  let previousDay = started.day;
  for (const event of events.slice(1)) {
    if (event.npc !== started.npc || event.longGoalId !== started.longGoalId) fail('one owner state cannot contain another project');
    if (event.day < previousDay) fail('a new event predates current project state');
    previousDay = event.day;
    if (event.kind === 'longgoal.started') fail('each project can only start once');
    const current = progress.chapters.at(-1)!;
    if (current.completed) fail('the project has already completed');
    if (event.chapterId !== current.id) fail('only the current chapter can advance');
    if (event.day < current.opened.day || current.id > 1 && event.day <= current.opened.day)
      fail('later chapters begin on a later game day');
    if (current.work.length === 2 && event.kind !== 'longgoal.completed') fail('the chapter is closed to further contributions and work');
    switch (event.kind) {
      case 'longgoal.observed':
        if (current.observation) fail('the chapter observation was already recorded');
        current.observation = event;
        break;
      case 'longgoal.contributed':
        if (current.contribution) fail('the chapter contribution was already received');
        if (definition.chapters[current.id - 1]!.contribution.kind === 'observation'
          && (!current.observation || current.observation.id !== event.sourceId || current.observation.day > event.day))
          fail('contribution needs this chapter actual observation');
        current.contribution = event;
        break;
      case 'longgoal.choice':
        if (current.choice) fail('the chapter choice was already made');
        if (!current.contribution || current.contribution.id !== event.sourceId || current.contribution.day > event.day)
          fail('choice needs this chapter received contribution');
        current.choice = event;
        break;
      case 'longgoal.worked': {
        const previousWorkDay = current.work.at(-1)?.day ?? current.opened.day;
        if (event.step !== current.work.length + 1 || event.day <= previousWorkDay) fail('work requires the next step on a later game day');
        current.work.push(event);
        break;
      }
      case 'longgoal.completed':
        if (current.work.length !== 2 || event.outcome !== (current.choice?.choiceId ?? 'default'))
          fail('completion needs two actual work days and the selected outcome');
        current.completed = event;
        if (current.id < 3) progress.chapters.push(newChapter((current.id + 1) as ChapterId, event));
        break;
    }
  }
  return progress;
}

function readState(state: NpcState, owner?: string): LongGoalState | undefined {
  const raw = state.longGoal;
  if (raw === undefined) return undefined;
  if (!object(raw) || !keys(raw, ['version', 'owner', 'dependency', 'events']) || raw.version !== 1
    || typeof raw.owner !== 'string' || !LONG_GOAL_NPCS.includes(raw.owner) || owner !== undefined && raw.owner !== owner
    || !Array.isArray(raw.events) || raw.events.length < 1 || raw.events.length > MAX_EVENTS) fail('invalid saved long goal state');
  if (raw.dependency !== null && (!object(raw.dependency) || !keys(raw.dependency, ['storyId', 'id', 'day'])
    || typeof raw.dependency.storyId !== 'string' || !integer(raw.dependency.day, 1, 1_000_000))) fail('invalid saved dependency');
  const events = parseLongGoalEvents(raw.events);
  if (events[0]!.npc !== raw.owner) fail('saved owner does not match the project');
  const dependency = raw.dependency as Dependency | null;
  const progress = project(events, dependency);
  if (dependency && state.story !== undefined) {
    const actual = dependencyFromStory(state, progress.definition, progress.started);
    if (actual.id !== dependency.id || actual.day !== dependency.day || actual.storyId !== dependency.storyId) fail('saved dependency does not match this story branch');
  }
  return { version: 1, owner: raw.owner, dependency: structuredClone(dependency), events };
}

function contributionFact(chapter: LongGoalChapter, progress: ChapterProgress): string | undefined {
  if (!progress.contribution) return undefined;
  if (chapter.contribution.kind === 'material')
    return `农场主已一次交给我 ${chapter.contribution.count} 份${chapter.contribution.label}，用于${chapter.contribution.purpose}`;
  const source = progress.observation!;
  const place = chapter.contribution.venues.find(venue => venue.map === source.venue)!.label;
  return `农场主当面汇报第 ${source.day} 天在${place}、${WEATHER[source.weather!]}时实际观察了 ${source.minutes} 分钟；这是其汇报，不是我在场亲历`;
}

function eventMemory(event: LongGoalEvent, progress: Progress): { text: string; kind: NonNullable<MemoryDraft['kind']> } | undefined {
  const definition = progress.definition;
  if (event.kind === 'longgoal.observed') return undefined;
  if (event.kind === 'longgoal.started') return { text: `我向农场主提起长期打算“${definition.title}”，第 1 章“${definition.chapters[0]!.title}”刚开启，尚未工作或收到贡献。`, kind: 'observation' };
  const current = progress.chapters[event.chapterId! - 1]!, chapter = definition.chapters[current.id - 1]!;
  const name = `“${definition.title}”第 ${current.id} 章“${chapter.title}”`;
  switch (event.kind) {
    case 'longgoal.contributed': return { text: `${name}：${contributionFact(chapter, current)}。只确认这次实际贡献，尚不能说章节完成。`,
      kind: chapter.contribution.kind === 'observation' ? 'heard' : 'observation' };
    case 'longgoal.choice': return { text: `农场主当面为${name}明确选择“${chapter.choices.find(choice => choice.id === event.choiceId)!.label}”。这基于我已收到的本章贡献，尚不能据此说成品完成。`, kind: 'heard' };
    case 'longgoal.worked': return { text: `我在${VENUES[event.venue!]!}为${name}实际工作了 ${event.minutes} 分钟，完成第 ${event.step} 次工作；章节成品以另行完成记录为准。`, kind: 'observation' };
    case 'longgoal.completed': {
      const output = chapter.outputs.find(output => output.id === event.outcome)!;
      return { text: `${name}已形成可阅读稿页“${output.title}”。${contributionFact(chapter, current) ?? '本章没有收到农场主的实际贡献'}。${current.choice
        ? `采用农场主明确选择的“${chapter.choices.find(choice => choice.id === current.choice!.choiceId)!.label}”。`
        : '方向由我自行决定。'}${current.id === 3 ? `三章已完成并合为“${definition.collectionTitle}”。` : `第 ${current.id + 1} 章刚开启，尚未工作。`}稿页不代表原版教学、出版、造物或建筑已经发生。`, kind: 'observation' };
    }
  }
}

/** All changes remain owner-private and are returned only after the complete batch succeeds. */
export function longGoalChanges(events: readonly LongGoalEvent[], prior: Readonly<Record<string, NpcState>>): NpcChange[] {
  const batch = parseLongGoalEvents(events), working = new Map<string, LongGoalState>(), changes = new Map<string, NpcChange>();
  for (const event of batch) {
    let state = working.get(event.npc) ?? readState(prior[event.npc] ?? {}, event.npc);
    if (state) {
      const previous = state.events.find(previous => previous.id === event.id);
      if (previous) {
        if (signature(previous) !== signature(event)) fail('a repeated event changed');
        continue;
      }
      if (serial(event.id) <= serial(state.events.at(-1)!.id)) fail('an unknown old event cannot be inserted');
      state.events.push(event);
    } else {
      if (event.kind !== 'longgoal.started') fail('the project has not started');
      const definition = DEFINITIONS.get(event.longGoalId)!;
      const dependency = definition.requiresStory ? dependencyFromStory(prior[event.npc] ?? {}, definition, event) : null;
      state = { version: 1, owner: event.npc, dependency, events: [event] };
    }
    if (state.events.length > MAX_EVENTS) fail('the project event limit was exceeded');
    const progress = project(state.events, state.dependency);
    working.set(event.npc, state);
    let change = changes.get(event.npc);
    if (!change) { change = { npcId: event.npc, log: { longGoalEvents: [] }, memories: [] }; changes.set(event.npc, change); }
    (change.log!.longGoalEvents as Json[]).push(structuredClone(event) as unknown as Json);
    const memory = eventMemory(event, progress);
    if (memory) change.memories!.push({ text: `第 ${event.day} 天：${memory.text}`, kind: memory.kind,
      importance: event.kind === 'longgoal.completed' ? 4 : 3, subjects: ['player'],
      topics: ['longgoal', `longgoal:${event.longGoalId}`, `longgoal:${event.id}`], visibility: 'private' });
    change.state = { ...(prior[event.npc] ?? {}), longGoal: structuredClone(state) as unknown as Json };
  }
  return [...changes.values()];
}

/** The hidden observation never reaches this whitelist until its owner actually receives the contribution. */
export function longGoalContext(state: NpcState, day: number): string | undefined {
  if (!integer(day, 1, 1_000_000)) fail('invalid context day');
  const saved = readState(state);
  if (!saved || saved.events.at(-1)!.day > day) return undefined;
  const progress = project(saved.events, saved.dependency), definition = progress.definition, current = progress.chapters.at(-1)!;
  const chapter = definition.chapters[current.id - 1]!;
  const details: string[] = [];
  if (current.completed) {
    details.push(`三章已经实际完成，合册为“${definition.collectionTitle}”`);
    for (const completed of progress.chapters) {
      const fact = contributionFact(definition.chapters[completed.id - 1]!, completed);
      if (fact) details.push(`第 ${completed.id} 章：${fact}`);
    }
    if (progress.chapters.every(chapter => !chapter.contribution)) details.push('三章均未收到农场主的实际贡献');
  } else {
    details.push(`已完成 ${current.id - 1}/3 章，当前第 ${current.id} 章“${chapter.title}”`);
    details.push(`本章已实际工作 ${current.work.length}/2 次，尚未记录本章成品完成`);
    details.push(contributionFact(chapter, current) ?? '本章尚未收到农场主的实际贡献');
    details.push(current.choice ? `农场主明确选择“${chapter.choices.find(choice => choice.id === current.choice!.choiceId)!.label}”` : '本章尚无玩家方案选择，我可以自行推进');
  }
  return `## 我的长期目标\n“${definition.title}”：${details.join('；')}。\n只采用已知记录；未汇报观察、他人项目和未选分支不是已知，不补写稿页全文。交料不证明亲手采集或钓获，稿页不等于教学、出版、造物或建筑完成。`;
}
