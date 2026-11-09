import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LONG_GOAL_DEFINITIONS, LONG_GOAL_IDS, LONG_GOAL_KINDS, LONG_GOAL_NPCS, longGoalChanges, longGoalContext,
  longGoalDefinition, parseLongGoalDefinitions, parseLongGoalEvents, type LongGoalDefinition, type LongGoalEvent, type LongGoalId } from '../src/agent/long-goals.ts';
import { storyChanges, type StoryEvent, type StoryId } from '../src/agent/town-stories.ts';
import type { NpcChange, NpcState } from '../src/types.ts';

type States = Record<string, NpcState>;
const definition = (id: LongGoalId = 'leah_form_study') => longGoalDefinition(id)!;
const start = (id: LongGoalId = 'leah_form_study', serial = 10, day = 10): LongGoalEvent => ({
  id: `life-${serial}`, npc: definition(id).owner, day, kind: 'longgoal.started', longGoalId: id,
  ...(definition(id).requiresStory ? { dependencySourceId: 'life-4' } : {}),
});
const event = (kind: LongGoalEvent['kind'], chapterId = 1, serial = 11, day = 10, id: LongGoalId = 'leah_form_study',
  fields: Partial<LongGoalEvent> = {}): LongGoalEvent => ({
  id: `life-${serial}`, npc: definition(id).owner, day, kind, longGoalId: id, chapterId, ...fields,
});
const observed = (chapterId = 1, serial = 11, day = 10, id: LongGoalId = 'leah_form_study'): LongGoalEvent => {
  const contribution = definition(id).chapters[chapterId - 1]!.contribution;
  assert.equal(contribution.kind, 'observation');
  return event('longgoal.observed', chapterId, serial, day, id,
    { contributionId: 'observation', venue: contribution.venues[0]!.map, weather: 'rain', minutes: 10 });
};
const contributed = (chapterId = 1, serial = 12, day = 10, id: LongGoalId = 'leah_form_study', sourceId = 'life-11'): LongGoalEvent => {
  const contribution = definition(id).chapters[chapterId - 1]!.contribution;
  return event('longgoal.contributed', chapterId, serial, day, id, contribution.kind === 'observation'
    ? { contributionId: 'observation', sourceId }
    : { contributionId: 'materials', itemId: contribution.itemId, count: contribution.count });
};
const choice = (chapterId = 1, serial = 13, day = 10, id: LongGoalId = 'leah_form_study', choiceId = 'a', sourceId = 'life-12'): LongGoalEvent =>
  event('longgoal.choice', chapterId, serial, day, id, { choiceId, sourceId });
const work = (chapterId = 1, step = 1, serial = 14, day = 11, id: LongGoalId = 'leah_form_study'): LongGoalEvent =>
  event('longgoal.worked', chapterId, serial, day, id, { step, venue: definition(id).workVenues[0]!, minutes: 30 });
const completed = (chapterId = 1, serial = 16, day = 12, id: LongGoalId = 'leah_form_study', outcome = 'default'): LongGoalEvent =>
  event('longgoal.completed', chapterId, serial, day, id, { outcome });
function prerequisite(id: LongGoalId): States {
  const owner = definition(id).owner, storyId = definition(id).requiresStory as StoryId | undefined;
  if (!storyId) return {};
  const base = { npc: owner, storyId };
  const events: StoryEvent[] = [
    { ...base, id: 'life-1', day: 1, kind: 'story.started' },
    { ...base, id: 'life-2', day: 2, kind: 'story.worked', step: 1, venue: owner === 'penny' ? 'Town' : 'Beach', minutes: 30 },
    { ...base, id: 'life-3', day: 3, kind: 'story.worked', step: 2, venue: owner === 'penny' ? 'Town' : 'Beach', minutes: 30 },
    { ...base, id: 'life-4', day: 3, kind: 'story.resolved', outcome: 'independent' },
  ];
  return Object.fromEntries(storyChanges(events, {}).map(change => [change.npcId, change.state!]));
}
function apply(events: LongGoalEvent[], prior: States = {}): { states: States; changes: NpcChange[] } {
  const changes = longGoalChanges(events, prior);
  return { states: { ...prior, ...Object.fromEntries(changes.map(change => [change.npcId, change.state!])) }, changes };
}
function memory(changes: NpcChange[]): string { return changes.flatMap(change => change.memories ?? []).map(entry => entry.text).join('\n'); }
function path(id: LongGoalId, outcome: 'default' | 'a' | 'b' = 'default', giveWithoutChoice = false): LongGoalEvent[] {
  const events = [start(id)];
  let serial = 11, openedDay = 10;
  for (let chapter = 1; chapter <= 3; chapter++) {
    if (outcome !== 'default' || giveWithoutChoice) {
      const day = chapter === 1 ? openedDay : openedDay + 1;
      let sourceId = '';
      if (definition(id).chapters[chapter - 1]!.contribution.kind === 'observation') {
        const observation = observed(chapter, serial++, day, id);
        events.push(observation); sourceId = observation.id;
      }
      const receipt = contributed(chapter, serial++, day, id, sourceId);
      events.push(receipt);
      if (outcome !== 'default') events.push(choice(chapter, serial++, day, id, outcome, receipt.id));
    }
    events.push(work(chapter, 1, serial++, openedDay + 1, id), work(chapter, 2, serial++, openedDay + 2, id),
      completed(chapter, serial++, openedDay + 2, id, outcome));
    openedDay += 2;
  }
  return events;
}
function stateData(states: States, owner = 'leah') {
  return states[owner]!.longGoal as unknown as { version: number; owner: string; dependency: { storyId: string; id: string; day: number } | null; events: LongGoalEvent[] };
}

test('seven fixed projects contain twenty-one chapters and sixty-three readable results', () => {
  assert.deepEqual(new Set(LONG_GOAL_DEFINITIONS.map(goal => goal.id)), new Set(LONG_GOAL_IDS));
  assert.deepEqual(new Set(LONG_GOAL_NPCS), new Set(['penny', 'elliott', 'leah', 'maru', 'robin', 'willy', 'linus']));
  assert.equal(LONG_GOAL_KINDS.length, 6);
  assert.equal(LONG_GOAL_DEFINITIONS.flatMap(goal => goal.chapters).length, 21);
  assert.equal(LONG_GOAL_DEFINITIONS.flatMap(goal => goal.chapters.flatMap(chapter => chapter.outputs)).length, 63);
  assert.equal(parseLongGoalDefinitions({ version: 1, goals: LONG_GOAL_DEFINITIONS }).length, 7);
  assert.equal(longGoalDefinition('unknown'), undefined);
});

test('definitions reject changed identities, prerequisites, venues, chapter order and game actions', () => {
  const mutate = (fn: (goals: LongGoalDefinition[]) => void) => {
    const goals = [...structuredClone(LONG_GOAL_DEFINITIONS)]; fn(goals);
    assert.throws(() => parseLongGoalDefinitions({ version: 1, goals }), /INVALID_LONG_GOAL_EVENT/);
  };
  mutate(goals => { goals[0]!.owner = 'elliott'; });
  mutate(goals => { goals[0]!.requiresStory = 'gus_parcel'; });
  mutate(goals => { goals[2]!.requiresStory = 'penny_field_notes'; });
  mutate(goals => { goals[0]!.workVenues = ['Museum']; });
  mutate(goals => { goals[0]!.chapters.reverse(); });
  mutate(goals => { goals[0]!.title = 'bad$command'; });
  mutate(goals => { goals[0]!.references = ['https://invented.example']; });
  mutate(goals => { goals[0]!.chapters[0]!.outputs.pop(); });
  mutate(goals => { goals[0]!.chapters[0]!.choices[1]!.id = 'a'; });
  const duplicate = [...structuredClone(LONG_GOAL_DEFINITIONS)]; duplicate[1] = duplicate[0]!;
  assert.throws(() => parseLongGoalDefinitions({ version: 1, goals: duplicate }), /duplicate/);
  assert.throws(() => parseLongGoalDefinitions({ version: 2, goals: LONG_GOAL_DEFINITIONS }), /definitions/);
});

test('authored observation and material requirements cannot be weakened by configuration', () => {
  const raw = JSON.parse(JSON.stringify({ version: 1, goals: LONG_GOAL_DEFINITIONS }));
  for (const patch of [{ count: 3 }, { itemId: '(O)169' }, { kind: 'gift' }, { id: 'wood' }]) {
    const altered = structuredClone(raw); Object.assign(altered.goals[2].chapters[1].contribution, patch);
    assert.throws(() => parseLongGoalDefinitions(altered), /materials/);
  }
  for (const patch of [{ minutes: 0 }, { venues: [{ map: 'Beach', label: '海滩' }] }, { hint: 'bad\ntext' }]) {
    const altered = structuredClone(raw); Object.assign(altered.goals[2].chapters[0].contribution, patch);
    assert.throws(() => parseLongGoalDefinitions(altered), /observation/);
  }
});

test('event batches are detached, ordered, bounded and exact-field validated', () => {
  assert.deepEqual(parseLongGoalEvents([]), []);
  const input = [start()], copy = parseLongGoalEvents(input); input[0]!.npc = 'gus';
  assert.equal(copy[0]!.npc, 'leah');
  assert.throws(() => parseLongGoalEvents(Array.from({ length: 33 }, (_, i) => start('leah_form_study', i + 1))), /at most 32/);
  assert.throws(() => parseLongGoalEvents([start(), start()]), /increasing serial/);
  for (const patch of [{ id: 'life-01' }, { npc: 'Leah' }, { npc: 'robin' }, { day: 0 }, { day: 1.5 }, { longGoalId: 'unknown' },
    { friendship: 1 }, { text: 'done' }, { kind: 'goal.started' }, { chapterId: 1 }, { dependencySourceId: 'life-1' }])
    assert.throws(() => parseLongGoalEvents([{ ...start(), ...patch }]), /INVALID_LONG_GOAL_EVENT/);
});

test('observations require the exact chapter place, weather and sufficient real time', () => {
  for (const patch of [{ chapterId: 2 }, { chapterId: 4 }, { venue: 'Town' }, { weather: 'rainy' }, { minutes: 9 }, { minutes: 1441 },
    { contributionId: 'materials' }, { sourceId: 'life-1' }, { itemId: '(O)388' }])
    assert.throws(() => parseLongGoalEvents([{ ...observed(), ...patch }]), /INVALID_LONG_GOAL_EVENT/);
  assert.equal(parseLongGoalEvents([{ ...observed(), weather: 'snow', minutes: 20 }]).length, 1);
});

test('observation reporting and material delivery accept disjoint exact fields', () => {
  assert.equal(parseLongGoalEvents([contributed()]).length, 1);
  const material = contributed(2, 20, 13);
  assert.equal(parseLongGoalEvents([material]).length, 1);
  for (const patch of [{ itemId: '(O)334' }, { count: 3 }, { count: 5 }, { sourceId: 'life-11' }, { contributionId: 'observation' }])
    assert.throws(() => parseLongGoalEvents([{ ...material, ...patch }]), /INVALID_LONG_GOAL_EVENT/);
  for (const patch of [{ sourceId: 'life-12' }, { sourceId: 'life-13' }, { itemId: '(O)388' }, { count: 4 }])
    assert.throws(() => parseLongGoalEvents([{ ...contributed(), ...patch }]), /INVALID_LONG_GOAL_EVENT/);
  const missing = contributed(); delete missing.sourceId;
  assert.throws(() => parseLongGoalEvents([missing]), /fields/);
});

test('work accepts native verified spouse venues only for the four marriage candidates', () => {
  for (const id of LONG_GOAL_IDS) {
    const value = { ...work(1, 1, 14, 11, id), venue: 'FarmHouse' };
    if (['penny', 'elliott', 'leah', 'maru'].includes(definition(id).owner)) assert.equal(parseLongGoalEvents([value]).length, 1);
    else assert.throws(() => parseLongGoalEvents([value]), /work evidence/);
  }
  for (const patch of [{ step: 0 }, { step: 3 }, { minutes: 29 }, { minutes: 1441 }, { venue: 'Hospital' }])
    assert.throws(() => parseLongGoalEvents([{ ...work(), ...patch }]), /work evidence/);
  assert.throws(() => parseLongGoalEvents([{ ...choice(), choiceId: 'open' }]), /choice/);
  assert.throws(() => parseLongGoalEvents([{ ...completed(), outcome: 'independent' }]), /outcome/);
});

test('all projects start explicitly once and only their owner receives changes', () => {
  for (const id of LONG_GOAL_IDS) {
    const result = apply([start(id)], prerequisite(id));
    assert.deepEqual(result.changes.map(change => change.npcId), [definition(id).owner]);
    assert.throws(() => apply([start(id, 11, 11)], result.states), /only start once/);
    assert.equal(longGoalContext(result.states.gus ?? {}, 10), undefined);
  }
  assert.throws(() => apply([observed()]), /not started/);
});

test('Penny and Elliott require the exact earlier resolution and cannot begin that same day', () => {
  for (const id of ['penny_learning_book', 'elliott_triptych'] as const) {
    assert.throws(() => apply([start(id)]), /prerequisite/);
    const prior = prerequisite(id), owner = definition(id).owner;
    assert.throws(() => apply([{ ...start(id), dependencySourceId: 'life-3' }], prior), /exact prerequisite/);
    assert.throws(() => apply([start(id, 10, 3)], prior), /earlier day/);
    assert.throws(() => apply([start(id, 3, 4)], prior), /precede/);
    const missing = start(id); delete missing.dependencySourceId;
    assert.throws(() => apply([missing], prior), /prerequisite/);
    const result = apply([start(id, 10, 4)], prior);
    assert.deepEqual(stateData(result.states, owner).dependency, { storyId: definition(id).requiresStory, id: 'life-4', day: 3 });
  }
});

test('an incomplete or corrupted predecessor cannot be presented as a completed story', () => {
  const prior = prerequisite('penny_learning_book');
  const story = prior.penny!.story as Record<string, unknown>;
  const progress = story.progress as Record<string, Record<string, unknown>>;
  progress.penny_field_notes!.resolution = null;
  assert.throws(() => apply([start('penny_learning_book')], prior), /prerequisite/);
  assert.throws(() => apply([start('penny_learning_book')], { penny: { story: { version: 1, progress: {} } } }), /prerequisite/);
});

test('hidden observations alter neither owner prompt nor retrievable memory until reported', () => {
  const first = apply([start()]), before = longGoalContext(first.states.leah!, 10);
  const hidden = apply([observed()], first.states);
  assert.equal(longGoalContext(hidden.states.leah!, 10), before);
  assert.deepEqual(hidden.changes[0]!.memories, []);
  assert.equal((hidden.changes[0]!.log!.longGoalEvents as unknown[]).length, 1);
  const heard = apply([contributed()], hidden.states), cue = longGoalContext(heard.states.leah!, 10)!;
  assert.match(cue, /当面汇报.*下雨.*10 分钟/);
  assert.match(cue, /不是我在场亲历/);
  assert.equal(heard.changes[0]!.memories![0]!.kind, 'heard');
  assert.ok(heard.changes[0]!.memories!.every(entry => entry.visibility === 'private'));
});

test('a choice needs a received contribution rather than an unreported or unrelated observation', () => {
  const hidden = apply([start(), observed()]);
  assert.throws(() => apply([choice(1, 13, 10, 'leah_form_study', 'a', 'life-11')], hidden.states), /received contribution/);
  assert.throws(() => apply([contributed(1, 12, 10, 'leah_form_study', 'life-5')], hidden.states), /actual observation/);
  const received = apply([contributed()], hidden.states);
  assert.throws(() => apply([choice(1, 13, 10, 'leah_form_study', 'a', 'life-11')], received.states), /received contribution/);
  const chosen = apply([choice()], received.states);
  assert.match(longGoalContext(chosen.states.leah!, 10)!, new RegExp(definition().chapters[0]!.choices[0]!.label));
  assert.throws(() => apply([choice(1, 14)], chosen.states), /already made/);
  assert.throws(() => apply([contributed(1, 14)], received.states), /already received/);
  assert.throws(() => apply([observed(1, 14)], hidden.states), /already recorded/);
});

test('all sixty-three chapter results follow actual work and the exact chosen direction', () => {
  let outputs = 0;
  for (const id of LONG_GOAL_IDS) for (const outcome of ['default', 'a', 'b'] as const) {
    const events = path(id, outcome), result = apply(events, prerequisite(id)), content = memory(result.changes);
    for (const chapter of definition(id).chapters) {
      const output = chapter.outputs.find(output => output.id === outcome)!;
      assert.ok(content.includes(output.title));
      assert.ok(!content.includes(output.text), 'full manuscripts do not become permanent event memories');
      outputs++;
    }
    const cue = longGoalContext(result.states[definition(id).owner]!, 16)!;
    assert.ok(cue.includes(definition(id).collectionTitle));
    assert.match(cue, /三章已经实际完成/);
    assert.ok(definition(id).chapters.every(chapter => chapter.outputs.every(output => !cue.includes(output.text))));
    assert.equal(stateData(result.states, definition(id).owner).events.length, events.length);
    assert.ok(events.length <= 19);
    assert.deepEqual(events.filter(event => event.kind === 'longgoal.worked').map(event => event.day), [11, 12, 13, 14, 15, 16]);
  }
  assert.equal(outputs, 63);
});

test('NPCs finish all chapters without player participation and elapsed days alone never finish work', () => {
  const first = apply([start()]);
  assert.match(longGoalContext(first.states.leah!, 999)!, /已实际工作 0\/2 次/);
  assert.throws(() => apply([completed(1, 11, 999)], first.states), /two actual work days/);
  const finished = apply(path('leah_form_study'));
  assert.match(longGoalContext(finished.states.leah!, 16)!, /三章均未收到农场主的实际贡献/);
  assert.doesNotMatch(memory(finished.changes), /农场主当面汇报|已一次交给我/);
});

test('default outputs keep credit for actual contributions when the player did not select a plan', () => {
  const result = apply(path('maru_field_holder', 'default', true)), content = memory(result.changes);
  assert.match(content, /2 份铜锭/);
  assert.match(content, /方向由我自行决定/);
  assert.doesNotMatch(content, /本章没有收到农场主的实际贡献|完全独立完成/);
  assert.match(longGoalContext(result.states.maru!, 16)!, /第 2 章.*2 份铜锭/);
  assert.doesNotMatch(content, /亲手打造了铜锭|已经造出/);
});

test('each work step needs another actual day and chapters cannot be skipped', () => {
  for (const bad of [work(1, 1, 11, 10), work(1, 2, 11, 11), work(2, 1, 11, 11)])
    assert.throws(() => apply([start(), bad]), /later game day|next step|current chapter/);
  assert.throws(() => apply([start(), work(1, 1, 11, 11), work(1, 2, 12, 11)]), /later game day/);
  const first = apply([start(), work(1, 1, 11, 11), work(1, 2, 12, 12), completed(1, 13, 12)]);
  assert.match(longGoalContext(first.states.leah!, 12)!, /已完成 1\/3 章，当前第 2 章/);
  for (const bad of [contributed(2, 14, 12), work(2, 1, 14, 12)])
    assert.throws(() => apply([bad], first.states), /later game day/);
  assert.throws(() => apply([work(3, 1, 14, 13)], first.states), /current chapter/);
});

test('later chapter observations and choices cannot reuse earlier chapter evidence', () => {
  const id = 'penny_learning_book';
  const first = apply([start(id), observed(1, 11, 10, id), contributed(1, 12, 10, id), choice(1, 13, 10, id),
    work(1, 1, 14, 11, id), work(1, 2, 15, 12, id), completed(1, 16, 12, id, 'a')], prerequisite(id));
  assert.throws(() => apply([observed(2, 17, 12, id)], first.states), /later game day/);
  assert.throws(() => apply([contributed(2, 17, 13, id, 'life-11')], first.states), /actual observation/);
  assert.throws(() => apply([choice(2, 17, 13, id, 'a', 'life-12')], first.states), /received contribution/);
  const next = apply([observed(2, 17, 13, id), contributed(2, 18, 13, id, 'life-17')], first.states);
  assert.throws(() => apply([choice(2, 19, 13, id, 'a', 'life-12')], next.states), /received contribution/);
});

test('the second work step closes contribution and choice windows before completion', () => {
  const ready = apply([start(), observed(), contributed(), work(1, 1, 14, 11), work(1, 2, 15, 12)]);
  for (const bad of [choice(1, 16, 12), observed(1, 16, 12), contributed(1, 16, 12), work(1, 2, 16, 13)])
    assert.throws(() => apply([bad], ready.states), /closed/);
  assert.throws(() => apply([completed(1, 16, 12, 'leah_form_study', 'a')], ready.states), /selected outcome/);
  assert.doesNotThrow(() => apply([completed(1, 16, 12)], ready.states));
});

test('only the current chapter enters the prompt while completed pages stay in durable records', () => {
  const events = path('leah_form_study', 'a'), boundary = events.findIndex(event => event.kind === 'longgoal.completed');
  const first = apply(events.slice(0, boundary + 1)), cue = longGoalContext(first.states.leah!, 12)!;
  assert.ok(cue.includes(definition().chapters[1]!.title));
  assert.ok(!cue.includes(definition().chapters[0]!.choices[0]!.label));
  assert.ok(!cue.includes(definition().chapters[2]!.title));
  assert.match(cue, /本章尚未收到农场主的实际贡献/);
  assert.equal(stateData(first.states).events.filter(event => event.kind === 'longgoal.completed').length, 1);
});

test('completed goals reject new actions and cannot be restarted', () => {
  const finished = apply(path('leah_form_study'));
  for (const bad of [start('leah_form_study', 50, 17), observed(3, 50, 17), work(3, 1, 50, 17), completed(3, 50, 17)])
    assert.throws(() => apply([bad], finished.states), /completed|only start once/);
});

test('identical full replay is inert, including reordered object keys, while changed duplicates fail', () => {
  const events = path('leah_form_study', 'a'), result = apply(events);
  assert.deepEqual(longGoalChanges(events, result.states), []);
  const reordered = Object.fromEntries(Object.entries(events[0]!).reverse()) as unknown as LongGoalEvent;
  assert.deepEqual(longGoalChanges([reordered], result.states), []);
  assert.throws(() => longGoalChanges([{ ...events[0]!, day: 9 }], result.states), /repeated event changed/);
  const observation = events.find(event => event.kind === 'longgoal.observed')!;
  assert.throws(() => longGoalChanges([{ ...observation, weather: 'snow' }], result.states), /repeated event changed/);
  assert.throws(() => longGoalChanges([start('leah_form_study', 1, 1)], result.states), /old event/);
});

test('restoring an earlier branch allows a different later choice without leaking the abandoned branch', () => {
  const checkpoint = apply([start(), observed(), contributed()]);
  const original = apply([choice()], checkpoint.states);
  const branch = apply([choice(1, 13, 10, 'leah_form_study', 'b')], structuredClone(checkpoint.states));
  const a = definition().chapters[0]!.choices.find(choice => choice.id === 'a')!.label;
  const b = definition().chapters[0]!.choices.find(choice => choice.id === 'b')!.label;
  assert.ok(longGoalContext(original.states.leah!, 10)!.includes(a));
  assert.ok(longGoalContext(branch.states.leah!, 10)!.includes(b));
  assert.ok(!longGoalContext(branch.states.leah!, 10)!.includes(a));
  assert.equal(stateData(checkpoint.states).events.length, 3);
});

test('completion cannot silently replace an accepted player direction with default or the other branch', () => {
  const ready = apply([start(), observed(), contributed(), choice(), work(1, 1, 14, 11), work(1, 2, 15, 12)]);
  for (const outcome of ['default', 'b'])
    assert.throws(() => apply([completed(1, 16, 12, 'leah_form_study', outcome)], ready.states), /selected outcome/);
  const valid = apply([completed(1, 16, 12, 'leah_form_study', 'a')], ready.states);
  assert.match(longGoalContext(valid.states.leah!, 12)!, /当前第 2 章/);
});

test('a stored owner namespace cannot be reused as another NPC project state', () => {
  const leah = apply([start()]).states.leah!;
  assert.throws(() => longGoalChanges([start('robin_small_space', 11)], { robin: leah }), /saved long goal state/);
  assert.equal(longGoalContext({ story: leah.story ?? null }, 10), undefined);
});

test('all retained receipts survive serialization and reloading', () => {
  const id = 'penny_learning_book', events = path(id, 'b'), first = apply(events, prerequisite(id));
  const restored = JSON.parse(JSON.stringify(first.states)) as States;
  assert.deepEqual(longGoalChanges(events, restored), []);
  assert.equal(longGoalContext(restored.penny!, 16), longGoalContext(first.states.penny!, 16));
  assert.equal(stateData(restored, 'penny').events.length, 19);
});

test('invalid saved envelopes, owners and event chains are rejected rather than repaired', () => {
  const first = apply([start(), observed(), contributed(), choice()]);
  const variants: ((states: States) => void)[] = [
    states => { stateData(states).version = 2; },
    states => { stateData(states).owner = 'robin'; },
    states => { stateData(states).events = []; },
    states => { stateData(states).events[1]!.npc = 'robin'; },
    states => { stateData(states).events[2]!.sourceId = 'life-1'; },
    states => { stateData(states).events[3]!.sourceId = 'life-11'; },
    states => { stateData(states).events[3]!.day = 9; },
    states => { stateData(states).events[3]!.chapterId = 3; },
    states => { stateData(states).dependency = { storyId: 'penny_field_notes', id: 'life-1', day: 1 }; },
  ];
  for (const mutate of variants) {
    const altered = structuredClone(first.states); mutate(altered);
    assert.throws(() => longGoalContext(altered.leah!, 10), /INVALID_LONG_GOAL_EVENT/);
    assert.throws(() => longGoalChanges([work()], altered), /INVALID_LONG_GOAL_EVENT/);
  }
  const extra = structuredClone(first.states); (extra.leah!.longGoal as Record<string, unknown>).reward = 100;
  assert.throws(() => longGoalContext(extra.leah!, 10), /saved long goal/);
});

test('saved dependency receipts must match the exact predecessor branch when it is present', () => {
  const first = apply([start('penny_learning_book')], prerequisite('penny_learning_book'));
  const altered = structuredClone(first.states); stateData(altered, 'penny').dependency!.day = 2;
  assert.throws(() => longGoalContext(altered.penny!, 10), /story branch/);
  const wrongSource = structuredClone(first.states); stateData(wrongSource, 'penny').dependency!.id = 'life-3';
  assert.throws(() => longGoalContext(wrongSource.penny!, 10), /saved dependency/);
  const noStory: NpcState = { longGoal: first.states.penny!.longGoal! };
  assert.ok(longGoalContext(noStory, 10), 'a validated saved dependency is enough when unrelated story context is not loaded');
});

test('an invalid final action produces no partial changes or mutation of the supplied states', () => {
  const first = apply([start()]), before = structuredClone(first.states);
  assert.throws(() => apply([observed(), contributed(), choice(), completed(1, 14, 10)], first.states), /two actual work days/);
  assert.deepEqual(first.states, before);
  const valid = apply([observed(), contributed(), choice()], first.states);
  assert.notDeepEqual(valid.states, first.states);
  assert.deepEqual(first.states, before);
});

test('multiple owners progress independently and invalid later owners do not return partial results', () => {
  const first = apply([start('leah_form_study', 10), start('robin_small_space', 11)]);
  assert.deepEqual(first.changes.map(change => change.npcId), ['leah', 'robin']);
  const second = apply([work(1, 1, 12, 11, 'robin_small_space'), work(1, 1, 13, 11)], first.states);
  assert.match(longGoalContext(second.states.leah!, 11)!, /工作 1\/2/);
  assert.match(longGoalContext(second.states.robin!, 11)!, /工作 1\/2/);
  assert.throws(() => apply([work(1, 2, 14, 12), completed(1, 15, 12, 'robin_small_space')], second.states), /two actual work days/);
});

test('unrelated NPC state is preserved and absent or future goals do not enter context', () => {
  const prior = { leah: { impression: '原有印象', plans: ['原有计划'], life: { kept: true } } };
  const result = apply([start()], prior);
  assert.equal(result.states.leah!.impression, '原有印象');
  assert.deepEqual(result.states.leah!.plans, ['原有计划']);
  assert.deepEqual(result.states.leah!.life, { kept: true });
  assert.equal(longGoalContext({}, 10), undefined);
  assert.equal(longGoalContext(result.states.leah!, 9), undefined);
  assert.throws(() => longGoalContext(result.states.leah!, 0), /context day/);
});
