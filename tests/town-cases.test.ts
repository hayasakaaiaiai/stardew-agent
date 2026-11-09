import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOWN_CASE_IDS, TOWN_CASE_DEFINITIONS, TOWN_CASE_NPCS, townCaseDefinition, parseTownCaseDefinitions,
  type TownCaseId } from '../src/agent/town-cases.ts';
import { ALL_STORY_IDS, ALL_STORY_NPCS, STORY_IDS, STORY_DEFINITIONS, STORY_NPCS, parseStoryEvents,
  storyChanges, storyContext, storyDefinition, storyNpcIds, type StoryEvent } from '../src/agent/town-stories.ts';
import { parseLifeJournal, lifeJournalChanges } from '../src/agent/life-journal.ts';
import type { NpcChange, NpcState } from '../src/types.ts';

type States = Record<string, NpcState>;
const caseId: TownCaseId = 'caroline_route_notes';
const start = (storyId: TownCaseId = caseId, id = 'life-1', day = 20): StoryEvent =>
  ({ id, npc: townCaseDefinition(storyId)!.owner, day, kind: 'story.started', storyId });
const clue = (storyId: TownCaseId = caseId, index = 0, id = 'life-2', day = 20): StoryEvent => {
  const source = townCaseDefinition(storyId)!.clues[index]!;
  return { ...start(storyId, id, day), kind: 'story.clue', clueId: source.id, other: source.witness };
};
function inspect(storyId: TownCaseId = caseId, index = 0, id = 'life-4', day = 20): StoryEvent {
  const point = townCaseDefinition(storyId)!.inspections[index]!;
  const event: StoryEvent = { ...start(storyId, id, day), kind: 'story.inspected', clueId: point.id,
    venue: point.venue, x: 2, y: 3, time: 1200, minutes: 10 };
  if (point.mode === 'site') {
    Object.assign(event, { x: point.site.x, y: point.site.y, weather: 'rain' });
    if (point.after) event.sourceId = 'life-4';
  } else if (point.mode === 'sample') Object.assign(event, { itemId: point.itemId, count: 1 });
  else Object.assign(event, { subject: point.subject, subjectX: 5, subjectY: 7, time: index === 0 ? 1000 : 1800 });
  return event;
}
const told = (storyId: TownCaseId, sourceId: string, id = 'life-7', day = 21): StoryEvent =>
  ({ ...start(storyId, id, day), kind: 'story.told', sourceId });
const resolve = (storyId: TownCaseId = caseId, outcome = 'a', id = 'life-6', day = 21): StoryEvent =>
  ({ ...start(storyId, id, day), kind: 'story.resolved', outcome });
const evidence = (storyId: TownCaseId = caseId): StoryEvent[] => [start(storyId), clue(storyId), clue(storyId, 1, 'life-3'),
  inspect(storyId), inspect(storyId, 1, 'life-5', storyId === 'evelyn_blank_record' ? 21 : 20)];
function apply(events: StoryEvent[], prior: States = {}): { states: States; changes: NpcChange[] } {
  const changes = storyChanges(events, prior);
  return { states: { ...prior, ...Object.fromEntries(changes.map(change => [change.npcId, change.state!])) }, changes };
}
const memory = (changes: NpcChange[], npc: string) => changes.filter(change => change.npcId === npc)
  .flatMap(change => change.memories ?? []).map(value => value.text).join('\n');

test('the four fixed cases join the story lookup while legacy exports remain the same three stories', () => {
  assert.equal(STORY_IDS.length, 3); assert.equal(STORY_DEFINITIONS.length, 3); assert.equal(STORY_NPCS.length, 5);
  assert.equal(ALL_STORY_IDS.length, 7); assert.equal(TOWN_CASE_DEFINITIONS.length, 4);
  assert.deepEqual(new Set(TOWN_CASE_DEFINITIONS.map(value => value.id)), new Set(TOWN_CASE_IDS));
  for (const definition of TOWN_CASE_DEFINITIONS) {
    assert.equal(storyDefinition(definition.id), definition);
    for (const npc of [definition.owner, ...definition.clues.map(clue => clue.witness)]) {
      assert.ok(ALL_STORY_NPCS.includes(npc)); assert.ok(TOWN_CASE_NPCS.includes(npc));
    }
  }
  assert.equal(townCaseDefinition('gus_parcel'), undefined);
});

test('authored definitions are detached and cannot change identities, actors or fixed native checks', () => {
  const input = { version: 1, cases: structuredClone(TOWN_CASE_DEFINITIONS) };
  const parsed = parseTownCaseDefinitions(input); input.cases[0]!.title = '另一个标题';
  assert.notEqual(parsed[0]!.title, input.cases[0]!.title);
  const invalid = (mutate: (cases: any[]) => void) => {
    const cases = structuredClone(TOWN_CASE_DEFINITIONS) as any[]; mutate(cases);
    assert.throws(() => parseTownCaseDefinitions({ version: 1, cases }), /INVALID_TOWN_CASE/);
  };
  invalid(cases => cases.pop()); invalid(cases => cases[1] = cases[0]);
  invalid(cases => cases[0].owner = 'jodi'); invalid(cases => cases[0].kind = 'investigation');
  invalid(cases => cases[0].clues[0].witness = 'caroline'); invalid(cases => cases[0].clues[1].id = 'witness_a');
  invalid(cases => cases[0].inspections[0].site.radius = 6); invalid(cases => cases[0].inspections[1].venue = 'Town');
  invalid(cases => cases[0].inspections[1].site.x = 67); invalid(cases => cases[0].inspections[0].minutes = 0);
  invalid(cases => cases[1].inspections[0].itemId = '(O)334'); invalid(cases => cases[1].inspections[0].count = 2);
  invalid(cases => cases[2].inspections[1].laterDay = false); invalid(cases => delete cases[2].inspections[1].after);
  invalid(cases => cases[3].inspections[0].subject = 'shane'); invalid(cases => cases[3].inspections[1].from = 900);
  invalid(cases => cases[0].endings[0].id = 'independent'); invalid(cases => cases[0].endings[0].reward = 10);
});

test('case prose and citations are bounded and cannot inject game control text', () => {
  for (const mutate of [
    (cases: any[]) => { cases[0].title = '#剧情'; },
    (cases: any[]) => { cases[0].opening = ' '.repeat(1000); },
    (cases: any[]) => { cases[0].references.pop(); },
    (cases: any[]) => { cases[0].references[4] = 'data/npcs/gus.md'; },
    (cases: any[]) => { cases[0].references[5] = 'reference/wiki/zh/Gus.md'; },
    (cases: any[]) => { cases[0].references.push('https://example.com'); },
  ]) {
    const cases = structuredClone(TOWN_CASE_DEFINITIONS) as any[]; mutate(cases);
    assert.throws(() => parseTownCaseDefinitions({ version: 1, cases }), /INVALID_TOWN_CASE/);
  }
});

test('case events retain bounded batches, exact owners and private native evidence kinds', () => {
  for (const definition of TOWN_CASE_DEFINITIONS) assert.equal(parseStoryEvents(evidence(definition.id)).length, 5);
  assert.throws(() => parseStoryEvents([{ ...start(), npc: 'jodi' }]), /owner/);
  assert.throws(() => parseStoryEvents([{ ...start(), friendship: 10 }]), /fields/);
  assert.throws(() => parseStoryEvents([{ ...start(), kind: 'story.worked', step: 1, minutes: 30, venue: 'Town' }]), /project/);
  assert.throws(() => parseStoryEvents([{ ...start(), kind: 'story.observed', minutes: 10, venue: 'Town', weather: 'rain' }]), /project/);
  assert.throws(() => parseStoryEvents([{ ...inspect(), storyId: 'gus_parcel', npc: 'gus' }]), /new cases/);
  assert.throws(() => parseStoryEvents([{ ...resolve(), outcome: 'explained' }]), /outcome/);
  assert.equal(parseLifeJournal([start(), inspect()])[1]!.kind, 'story.inspected');
});

test('each new witness clue requires that exact witness and cannot masquerade as an inspection', () => {
  assert.deepEqual(storyNpcIds(clue()), ['caroline', 'pierre']);
  for (const patch of [{ other: 'jodi' }, { other: undefined }, { clueId: 'square' }, { clueId: 'parcel' }])
    assert.throws(() => parseStoryEvents([{ ...clue(), ...patch }]), /witness/);
  assert.throws(() => parseStoryEvents([{ ...inspect(), other: 'pierre' }]), /fields/);
  assert.throws(() => parseStoryEvents([{ ...inspect(), clueId: 'witness_a' }]), /inspected/);
});

test('site checks validate actual position, exact duration, clock and weather', () => {
  assert.equal(parseStoryEvents([{ ...inspect(), x: 53, y: 72, time: 2200 }]).length, 1);
  for (const patch of [{ venue: 'Forest' }, { x: 54, y: 72 }, { x: -1 }, { y: 501 }, { x: 50.5 },
    { minutes: 9 }, { minutes: 20 }, { time: 599 }, { time: 1260 }, { time: 1205 }, { time: 2210 },
    { weather: 'rainy' }, { weather: undefined }, { itemId: '(O)378' }, { sourceId: 'life-1' }])
    assert.throws(() => parseStoryEvents([{ ...inspect(), ...patch }]), /inspected/);
});

test('sample checks accept exactly one real qualified ore and never acquire weather or consumption claims', () => {
  for (const index of [0, 1]) assert.equal(parseStoryEvents([inspect('clint_sample_labels', index)]).length, 1);
  const sample = inspect('clint_sample_labels');
  for (const patch of [{ itemId: '(O)334' }, { itemId: '378' }, { itemId: '(O)380' }, { count: 0 }, { count: 2 },
    { venue: 'Town' }, { weather: 'rain' }, { subject: 'clint' }, { consumed: true }])
    assert.throws(() => parseStoryEvents([{ ...sample, ...patch }]), /inspected|fields/);
});

test('presence requires actual subject coordinates, eight-tile range and ten minutes inside the allowed window', () => {
  const presence = inspect('marnie_two_contexts');
  assert.deepEqual(storyNpcIds(presence), ['marnie']);
  for (const time of [910, 1600]) assert.equal(parseStoryEvents([{ ...presence, time, x: 5, y: 7, subjectX: 13 }]).length, 1);
  for (const patch of [{ time: 900 }, { time: 1610 }, { subject: 'shane' }, { subject: undefined },
    { subjectX: -1 }, { subjectY: 501 }, { subjectX: 20 }, { weather: 'sunny' }, { other: 'marnie' }])
    assert.throws(() => parseStoryEvents([{ ...presence, ...patch }]), /inspected|fields/);
  const saloon = inspect('marnie_two_contexts', 1);
  assert.throws(() => parseStoryEvents([{ ...saloon, time: 1700 }]), /inspected/);
  assert.equal(parseStoryEvents([{ ...saloon, time: 1710 }]).length, 1);
});

test('Evelyn return needs the exact earlier-day first observation and accepts matching weather', () => {
  const storyId = 'evelyn_blank_record';
  const first = apply([start(storyId), inspect(storyId)]);
  const returned = inspect(storyId, 1, 'life-5', 21);
  assert.equal(apply([returned], first.states).changes.length, 1);
  for (const patch of [{ day: 20 }, { sourceId: 'life-1' }, { sourceId: 'life-3' }])
    assert.throws(() => apply([{ ...returned, ...patch }], first.states), /exact first source/);
  assert.throws(() => parseStoryEvents([{ ...returned, sourceId: 'life-5' }]), /precede/);
  assert.throws(() => parseStoryEvents([{ ...returned, sourceId: undefined }]), /inspected/);
  assert.throws(() => apply([start(storyId), returned]), /exact first source/);
  assert.throws(() => parseStoryEvents([{ ...inspect(storyId), sourceId: 'life-1' }]), /inspected/);
});

test('cases only begin explicitly and acquired evidence cannot be recorded twice or reused after resolution', () => {
  assert.throws(() => apply([inspect()]), /not started/);
  const first = apply([start(), inspect()]);
  assert.throws(() => apply([start(caseId, 'life-5')], first.states), /only start once/);
  assert.throws(() => apply([inspect(caseId, 0, 'life-5')], first.states), /already obtained/);
  const closed = apply([...evidence(), resolve()]);
  for (const event of [start(caseId, 'life-7', 21), inspect(caseId, 0, 'life-7', 21), resolve(caseId, 'b', 'life-7')])
    assert.throws(() => apply([event], closed.states), /already resolved/);
});

test('hidden field checks and interviews leave the owner summary unchanged until a report', () => {
  for (const definition of TOWN_CASE_DEFINITIONS) {
    const before = apply([start(definition.id)]), after = apply(evidence(definition.id));
    assert.equal(storyContext(before.states[definition.owner]!, 21), storyContext(after.states[definition.owner]!, 21));
    assert.equal(after.changes.find(change => change.npcId === definition.owner)!.memories!.length, 1);
    assert.doesNotMatch(memory(after.changes, definition.owner), /晴天|下雨|背包|一直在八格/);
    assert.ok(after.changes.every(change => change.memories!.every(memory => memory.visibility === 'private')));
  }
});

test('witnesses learn only their own words and never the other interview, inspections or final result', () => {
  for (const definition of TOWN_CASE_DEFINITIONS) {
    const result = apply([...evidence(definition.id), resolve(definition.id)]);
    for (const [index, witness] of definition.clues.entries()) {
      const context = storyContext(result.states[witness.witness]!, 21)!;
      assert.ok(context.includes(witness.text));
      assert.ok(!context.includes(definition.clues[1 - index]!.text));
      assert.ok(!context.includes(definition.endings[0]!.title));
      assert.doesNotMatch(context, /实际核验了|第 21 天已结束/);
    }
  }
});

test('explicit reports publish one exact local source with attribution and cannot follow telling chains', () => {
  const first = apply(evidence());
  const result = apply([told(caseId, 'life-2')], first.states);
  assert.match(storyContext(result.states.caroline!, 21)!, /皮埃尔的当面证词/);
  assert.doesNotMatch(storyContext(result.states.caroline!, 21)!, /乔迪的当面证词|实际核验了/);
  assert.match(memory(result.changes, 'caroline'), /不是我在场亲历/);
  assert.throws(() => apply([told(caseId, 'life-2', 'life-8')], result.states), /already told/);
  assert.throws(() => apply([told(caseId, 'life-7', 'life-8')], result.states), /existing clue or observation/);
  const withField = apply([told(caseId, 'life-4', 'life-8')], result.states);
  assert.match(storyContext(withField.states.caroline!, 21)!, /第 20 天 12:00.*镇广场.*下雨/);
  assert.doesNotMatch(storyContext(withField.states.caroline!, 21)!, /森林河边的起点参照/);
});

test('sample and presence reports describe only their actual evidence and do not disclose unrelated state', () => {
  for (const storyId of ['clint_sample_labels', 'marnie_two_contexts'] as const) {
    const result = apply([...evidence(storyId), told(storyId, 'life-4')]);
    const context = storyContext(result.states[townCaseDefinition(storyId)!.owner]!, 21)!;
    assert.match(context, storyId === 'clint_sample_labels' ? /一份铜矿石.*没有消耗或交付/ : /玛妮本人同图且一直在八格范围内/);
    assert.doesNotMatch(context, /当时下雨|当时晴天|已完成采矿|已营业/);
  }
});

test('every ending requires all four actual sources and never resolves from dialogue or partial evidence', () => {
  for (const definition of TOWN_CASE_DEFINITIONS) for (const ending of definition.endings) {
    for (let missing = 1; missing < 5; missing++) {
      const events = evidence(definition.id).filter((_, index) => index !== missing);
      assert.throws(() => apply([...events, resolve(definition.id, ending.id)]));
    }
    assert.throws(() => apply([start(definition.id), resolve(definition.id, ending.id)]), /both witnesses and both inspections/);
  }
});

test('all eight endings publish the four sources once while keeping full prose out of prompts', () => {
  for (const definition of TOWN_CASE_DEFINITIONS) for (const ending of definition.endings) {
    const result = apply([...evidence(definition.id), resolve(definition.id, ending.id)]);
    const context = storyContext(result.states[definition.owner]!, 21)!;
    assert.ok(context.includes(ending.title)); assert.ok(!context.includes(ending.text));
    assert.ok(!context.includes(definition.endings.find(other => other.id !== ending.id)!.title));
    assert.equal(context.match(/实际核验了 10 分钟/g)?.length, 2);
    assert.match(memory(result.changes, definition.owner), /两份证词与两次实际核验/);
    assert.throws(() => apply([told(definition.id, 'life-4')], result.states), /already told/);
  }
});

test('reporting before resolution preserves one copy of each known source', () => {
  const result = apply([...evidence(), told(caseId, 'life-4', 'life-6'), resolve(caseId, 'a', 'life-7')]);
  assert.equal(storyContext(result.states.caroline!, 21)!.match(/镇广场的起点参照实际核验/g)?.length, 1);
});

test('one witness may know two cases without importing either owner or the other witnesses', () => {
  const result = apply([start(), clue(caseId, 1), start('marnie_two_contexts', 'life-3'), clue('marnie_two_contexts', 1, 'life-4')]);
  const context = storyContext(result.states.jodi!, 20)!;
  assert.ok(context.includes(townCaseDefinition(caseId)!.clues[1]!.text));
  assert.ok(context.includes(townCaseDefinition('marnie_two_contexts')!.clues[1]!.text));
  assert.doesNotMatch(context, /皮埃尔的当面证词|尚未结案/);
});

test('a new case can share witnesses with the old parcel without changing their role or legacy progress', () => {
  const result = apply([
    { id: 'life-1', npc: 'gus', day: 20, kind: 'story.started', storyId: 'gus_parcel' },
    { id: 'life-2', npc: 'gus', day: 20, kind: 'story.clue', storyId: 'gus_parcel', clueId: 'emily_mark', other: 'emily' },
    start('clint_sample_labels', 'life-3'), clue('clint_sample_labels', 0, 'life-4'),
  ]);
  const context = storyContext(result.states.emily!, 20)!;
  assert.match(context, /收货记号是实心圆/);
  assert.ok(context.includes(townCaseDefinition('clint_sample_labels')!.clues[0]!.text));
  assert.doesNotMatch(storyContext(result.states.clint!, 20)!, /收货记号是实心圆/);
});

test('a case report cannot cite another case, another owner or an unrelated story source', () => {
  const result = apply([start(), inspect(), start('clint_sample_labels', 'life-5'), inspect('clint_sample_labels', 0, 'life-6')]);
  assert.throws(() => apply([told(caseId, 'life-6')], result.states), /this story existing/);
  assert.throws(() => apply([told('clint_sample_labels', 'life-4')], result.states), /this story existing/);
  assert.throws(() => apply([told('clint_sample_labels', 'life-6')], { clint: result.states.caroline! }), /another NPC/);
});

test('identical replay is inert but changed payloads and one-sided witness replay are rejected', () => {
  const events = [...evidence(), resolve()], result = apply(events);
  assert.deepEqual(storyChanges(events, result.states), []);
  assert.throws(() => storyChanges([{ ...events[3]!, weather: 'sunny' }], result.states), /reused with different content/);
  assert.throws(() => storyChanges([events[1]!], { caroline: result.states.caroline! }), /inconsistent witness replay/);
});

test('failed mixed projections do not mutate any supplied namespace or produce a partial witness change', () => {
  const first = apply([start()]), before = structuredClone(first.states);
  assert.throws(() => lifeJournalChanges([clue(), resolve(caseId, 'a', 'life-3', 20)], first.states), /both witnesses/);
  assert.deepEqual(first.states, before);
  assert.throws(() => apply([inspect(caseId, 0, 'life-2', 19)], first.states), /predates/);
});

test('saved projections reject forged field facts, evidence kinds, missing knowledge and unresolved provenance', () => {
  const result = apply([...evidence('clint_sample_labels'), resolve('clint_sample_labels')]);
  const invalid = (mutate: (raw: any) => void) => {
    const state = structuredClone(result.states.clint!); mutate(state.story);
    assert.throws(() => storyContext(state, 21), /INVALID_STORY_EVENT/);
  };
  invalid(raw => raw.progress.clint_sample_labels.sources[2].itemId = '(O)334');
  invalid(raw => raw.progress.clint_sample_labels.sources[2].count = 2);
  invalid(raw => raw.progress.clint_sample_labels.sources[2].weather = 'rain');
  invalid(raw => raw.progress.clint_sample_labels.sources[2].kind = 'clue');
  invalid(raw => raw.progress.clint_sample_labels.sources[2].day = 22);
  invalid(raw => raw.progress.clint_sample_labels.told.pop());
  invalid(raw => delete raw.knowledge.clint_sample_labels);
  invalid(raw => raw.knowledge.clint_sample_labels.role = 'witness');
  invalid(raw => raw.knowledge.clint_sample_labels.sources[2].itemId = '(O)380');
  const witness = structuredClone(result.states.emily!);
  (witness.story as any).knowledge.clint_sample_labels.sources = (result.states.clint!.story as any).progress.clint_sample_labels.sources.slice(2, 3);
  assert.throws(() => storyContext(witness, 21), /saved story knowledge/);
});

test('saved Evelyn return cannot cite another source or be moved onto the first observation day', () => {
  const original = apply([...evidence('evelyn_blank_record'), resolve('evelyn_blank_record')]).states.evelyn!;
  for (const patch of [{ sourceId: 'life-2' }, { sourceId: 'life-5' }, { day: 20 }]) {
    const state = structuredClone(original), raw = state.story as any;
    Object.assign(raw.progress.evelyn_blank_record.sources[3], patch);
    Object.assign(raw.knowledge.evelyn_blank_record.sources[3], patch);
    assert.throws(() => storyContext(state, 21), /saved story/);
  }
});

test('save serialization and rollback preserve exact sources while allowing a different later branch ending', () => {
  const base = apply(evidence()).states;
  const restored = JSON.parse(JSON.stringify(base)) as States;
  const first = apply([resolve(caseId, 'a')], restored), second = apply([resolve(caseId, 'b')], restored);
  const definition = townCaseDefinition(caseId)!;
  assert.ok(storyContext(first.states.caroline!, 21)!.includes(definition.endings[0]!.title));
  assert.ok(storyContext(second.states.caroline!, 21)!.includes(definition.endings[1]!.title));
  assert.doesNotMatch(storyContext(restored.caroline!, 21)!, /第 21 天已结束/);
  assert.equal(storyContext({}, 21), undefined);
  assert.equal(storyContext(first.states.caroline!, 19), undefined);
});
