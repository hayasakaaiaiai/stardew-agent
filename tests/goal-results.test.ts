import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GOAL_RESULT_DEFINITIONS, GOAL_RESULT_IDS, GOAL_RESULT_KINDS, GOAL_RESULT_NPCS, goalResultChanges, goalResultContext,
  goalResultDefinition, parseGoalResultDefinitions, parseGoalResultEvents, type GoalResultEvent } from '../src/agent/goal-results.ts';
import { lifeJournalChanges } from '../src/agent/life-journal.ts';
import { type LongGoalEvent, type LongGoalId } from '../src/agent/long-goals.ts';
import type { NpcChange, NpcState } from '../src/types.ts';
import { completedPractice, completedProject, reviewPractice } from './helpers/project-practice.ts';

type States = Record<string, NpcState>;
const def = (projectId: LongGoalId = 'leah_form_study') => goalResultDefinition(projectId)!;
function prerequisite(projectId: LongGoalId = 'leah_form_study', chapter = 3): States {
  const events = completedProject(projectId).filter(event => Number(event.id.slice(5)) <= 10 + chapter * 3);
  return Object.fromEntries(lifeJournalChanges(events, {}).map(change => [change.npcId, change.state!]));
}
function apply(events: GoalResultEvent[], prior: States = prerequisite()): { states: States; changes: NpcChange[] } {
  const changes = goalResultChanges(events, prior);
  return { states: { ...prior, ...Object.fromEntries(changes.map(change => [change.npcId, change.state!])) }, changes };
}
const route = (projectId: LongGoalId = 'leah_form_study') => completedPractice(projectId);
const start = (projectId: LongGoalId = 'leah_form_study', id = 'life-20', day = 10): GoalResultEvent => ({
  id, npc: def(projectId).owner, projectId, day, kind: 'goalresult.started', sourceId: 'life-19', choiceId: 'a',
});
const notice = (chapterId = 3, id = 'life-20', day = 10, projectId: LongGoalId = 'leah_form_study'): GoalResultEvent => ({
  id, day, npc: def(projectId).owner, projectId, kind: 'goalresult.notified', chapterId, sourceId: `life-${10 + chapterId * 3}`,
});
const cancel = (attemptId = 'life-20', id = 'life-25', day = 10, reason: GoalResultEvent['reason'] = 'player', projectId: LongGoalId = 'leah_form_study'): GoalResultEvent => ({
  id, day, npc: def(projectId).owner, projectId, kind: 'goalresult.cancelled', attemptId, reason: reason!,
});
const memory = (changes: NpcChange[]) => changes.flatMap(change => change.memories ?? []).map(entry => entry.text).join('\n');
function saved(states: States, owner = 'leah') {
  return states[owner]!.goalResult as unknown as {
    version: number; owner: string; projectId: LongGoalId; watermark: number; sources: LongGoalEvent[]; events: GoalResultEvent[];
  };
}

test('the shared definition has seven distinct practices and the exact fourteen native checkpoints', () => {
  assert.deepEqual(new Set(GOAL_RESULT_DEFINITIONS.map(definition => definition.projectId)), new Set(GOAL_RESULT_IDS));
  assert.deepEqual(new Set(GOAL_RESULT_NPCS), new Set(['penny', 'elliott', 'leah', 'maru', 'robin', 'willy', 'linus']));
  assert.equal(GOAL_RESULT_KINDS.length, 6);
  assert.equal(GOAL_RESULT_DEFINITIONS.flatMap(definition => definition.checkpoints).length, 14);
  assert.equal(parseGoalResultDefinitions({ version: 1, practices: GOAL_RESULT_DEFINITIONS }).length, 7);
  assert.equal(goalResultDefinition('unknown'), undefined);
});

test('definitions reject changed owners, routes, durations, checkpoints and unsafe authored text', () => {
  const input = JSON.parse(JSON.stringify({ version: 1, practices: GOAL_RESULT_DEFINITIONS }));
  for (const patch of [{ owner: 'gus' }, { projectId: 'invented' }, { venue: 'Town' }, { mode: 'fishing' }, { minutes: 20 },
    { title: 'bad$command' }, { opening: 'bad\ntext' }, { references: ['https://invented.example'] }, { reward: 1 }]) {
    const changed = structuredClone(input); Object.assign(changed.practices[0], patch);
    assert.throws(() => parseGoalResultDefinitions(changed), /INVALID_GOAL_RESULT_EVENT/);
  }
  const duplicate = structuredClone(input); duplicate.practices[1] = duplicate.practices[0];
  assert.throws(() => parseGoalResultDefinitions(duplicate), /duplicate/);
  const wrongPoint = structuredClone(input); wrongPoint.practices[0].checkpoints[1].point = 3;
  assert.throws(() => parseGoalResultDefinitions(wrongPoint), /checkpoints/);
  const wrongChoice = structuredClone(input); wrongChoice.practices[0].finishChoices[1].id = 'a';
  assert.throws(() => parseGoalResultDefinitions(wrongChoice), /choices/);
  assert.throws(() => parseGoalResultDefinitions({ ...input, version: 2 }), /definitions/);
});

test('event parser bounds batches, detaches inputs and enforces shared ordered serials', () => {
  assert.deepEqual(parseGoalResultEvents([]), []);
  const input = [start()], parsed = parseGoalResultEvents(input); input[0]!.npc = 'robin';
  assert.equal(parsed[0]!.npc, 'leah');
  assert.throws(() => parseGoalResultEvents(Array.from({ length: 33 }, (_, i) => start('leah_form_study', `life-${100 + i}`))), /at most 32/);
  assert.throws(() => parseGoalResultEvents([start(), start()]), /increasing serial/);
  for (const patch of [{ id: 'life-01' }, { npc: 'Leah' }, { npc: 'robin' }, { day: 0 }, { day: 1.5 }, { kind: 'activity.completed' },
    { friendship: 5 }, { item: 'wood' }, { longGoalId: 'leah_form_study' }, { choiceId: 'other' }, { sourceId: 'life-20' }])
    assert.throws(() => parseGoalResultEvents([{ ...start(), ...patch }]), /INVALID_GOAL_RESULT_EVENT/);
  const missing = start(); delete missing.sourceId;
  assert.throws(() => parseGoalResultEvents([missing]), /fields/);
});

test('checkpoint parser requires exact map, positions, clock, weather and actual counters', () => {
  const point = route()[1]!;
  for (const patch of [{ venue: 'Town' }, { x: -1 }, { y: 501 }, { x: 1.5 }, { point: 0 }, { point: 4 }, { time: 850 },
    { time: 1260 }, { time: 2210 }, { time: 1015 }, { weather: 'rainy' }, { minutes: 0 }, { minutes: 15 }, { minutes: 100 },
    { count: 1 }, { count: -1 }, { count: 1000 }, { attemptId: point.id }, { sourceId: 'life-19' }])
    assert.throws(() => parseGoalResultEvents([{ ...point, ...patch }]), /INVALID_GOAL_RESULT_EVENT/);
  for (const projectId of ['willy_shore_guide', 'linus_light_steps'] as const)
    assert.throws(() => parseGoalResultEvents([{ ...route(projectId)[1]!, count: 0 }]), /action count/);
});

test('completion and cancellation fields cannot introduce extra evidence or unknown reasons', () => {
  const completion = route().at(-1)!;
  for (const patch of [{ minutes: 20 }, { minutes: 95 }, { count: 1 }, { sourceId: completion.id }, { weather: 'rain' }, { choiceId: 'default' }])
    assert.throws(() => parseGoalResultEvents([{ ...completion, ...patch }]), /INVALID_GOAL_RESULT_EVENT/);
  assert.throws(() => parseGoalResultEvents([{ ...cancel(), reason: 'expired' }]), /reason/);
  assert.throws(() => parseGoalResultEvents([{ ...notice(), chapterId: 0 }]), /chapter/);
});

test('a practice needs this owner exact third completed chapter, in source order and not in the future', () => {
  assert.throws(() => apply([start()], {}), /completed long-goal chapter/);
  assert.throws(() => apply([start()], prerequisite('leah_form_study', 2)), /exact completed chapter/);
  assert.throws(() => apply([{ ...start(), sourceId: 'life-16' }]), /exact completed chapter/);
  assert.throws(() => apply([start('leah_form_study', 'life-20', 9)]), /exact completed chapter/);
  assert.throws(() => apply([start()], { leah: prerequisite('robin_small_space').robin! }), /another owner/);
  const first = apply([start()]);
  assert.equal(first.changes.length, 1); assert.equal(first.changes[0]!.npcId, 'leah');
  assert.match(memory(first.changes), /尚未完成/);
  assert.throws(() => apply([start('leah_form_study', 'life-21')], first.states), /overwritten/);
});

test('ordinary life and romance completions cannot substitute for project or checkpoint evidence', () => {
  assert.throws(() => apply([start()], { leah: { life: { recent: [{ id: 'life-19', kind: 'activity.completed' }] } } }), /completed long-goal/);
  const beforeFinish = apply(route().slice(0, -1));
  assert.throws(() => apply([{ ...route().at(-1)!, sourceId: 'life-19' }], beforeFinish.states), /exact last source/);
  assert.throws(() => apply([{ ...route().at(-1)!, attemptId: 'life-18' }], beforeFinish.states), /another attempt/);
});

test('notices expose no new memory or prompt and only notify the latest completed chapter', () => {
  const first = apply([notice(1, 'life-14', 6)], prerequisite('leah_form_study', 1));
  assert.deepEqual(first.changes[0]!.memories, []);
  assert.equal(goalResultContext(first.states.leah!, 6), undefined);
  const later = completedProject().filter(event => Number(event.id.slice(5)) > 13)
    .map(event => ({ ...event, id: `life-${Number(event.id.slice(5)) + 10}` }));
  const progressed = lifeJournalChanges(later, first.states);
  const advanced = { leah: { ...first.states.leah!, ...progressed.find(change => change.npcId === 'leah')!.state } };
  assert.throws(() => apply([{ ...notice(2, 'life-30', 10), sourceId: 'life-26' }], advanced), /latest unnotified/);
  const latest = apply([{ ...notice(3, 'life-30', 10), sourceId: 'life-29' }], advanced);
  assert.throws(() => apply([{ ...notice(3, 'life-31', 11), sourceId: 'life-29' }], latest.states), /latest unnotified/);
  assert.doesNotThrow(() => apply([{ ...start('leah_form_study', 'life-31', 10), sourceId: 'life-29' }], latest.states));
});

test('a backdated notice cannot conceal a newer chapter already preceding it in the global journal', () => {
  assert.throws(() => apply([notice(1, 'life-20', 6)]), /latest unnotified/);
  assert.throws(() => apply([notice(3, 'life-20', 9)]), /exact completed chapter/);
});

test('only one notice is accepted globally per actual reminder day, including another owner saved earlier', () => {
  const priors = { ...prerequisite(), ...prerequisite('robin_small_space') };
  const first = apply([notice()], priors);
  assert.throws(() => apply([notice(3, 'life-21', 10, 'robin_small_space')], first.states), /globally per day/);
  assert.throws(() => apply([notice(), notice(3, 'life-21', 10, 'robin_small_space')], priors), /globally per day/);
  assert.doesNotThrow(() => apply([notice(3, 'life-21', 11, 'robin_small_space')], first.states));
  assert.deepEqual(goalResultChanges([notice()], first.states), []);
});

test('all seven practices support each plan, point, finish and review choice without exposing whole scripts', () => {
  for (const projectId of GOAL_RESULT_IDS) for (const pointChoice of ['a', 'b'] as const) for (const plan of ['a', 'b'] as const)
    for (const finish of ['a', 'b'] as const) for (const reviewChoice of ['a', 'b'] as const) {
      const events = completedPractice(projectId, pointChoice);
      events[0]!.choiceId = plan; events.at(-1)!.choiceId = finish;
      const result = apply([...events, reviewPractice(events, reviewChoice)], prerequisite(projectId));
      const owner = def(projectId).owner, cue = goalResultContext(result.states[owner]!, 11)!;
      assert.ok(cue.includes(def(projectId).finishChoices.find(choice => choice.id === finish)!.label));
      assert.ok(cue.includes(def(projectId).reviewChoices.find(choice => choice.id === reviewChoice)!.label));
      assert.match(cue, /未再次行动/);
      assert.ok(!cue.includes(def(projectId).opening));
      assert.ok(!cue.includes(def(projectId).receiptIntro));
      assert.equal(result.changes.length, 1);
      assert.ok(result.changes[0]!.memories!.every(entry => entry.visibility === 'private'));
    }
});

test('checkpoints must stay on the current attempt and game day and cannot be reordered or repeated', () => {
  const events = route(), first = apply([events[0]!]);
  assert.throws(() => apply([events[2]!], first.states), /configured order/);
  assert.throws(() => apply([{ ...events[1]!, day: 11 }], first.states), /attempt day/);
  assert.throws(() => apply([{ ...events[1]!, attemptId: 'life-19' }], first.states), /another attempt/);
  const point = apply([events[1]!], first.states);
  assert.throws(() => apply([{ ...events[1]!, id: 'life-22' }], point.states), /configured order/);
  assert.throws(() => apply([events[1]!], prerequisite()), /not started/);
});

test('checkpoint clock differences must support the actual accumulated minutes', () => {
  const events = route();
  assert.throws(() => apply([events[0]!, { ...events[1]!, time: 900 }]), /earliest start/);
  assert.throws(() => apply([events[0]!, { ...events[1]!, minutes: 80 }]), /earliest start/);
  const first = apply(events.slice(0, 2));
  for (const patch of [{ minutes: 10 }, { time: 1010 }, { minutes: 90, time: 1020 }])
    assert.throws(() => apply([{ ...events[2]!, ...patch }], first.states), /elapsed interval/);
  assert.doesNotThrow(() => apply([{ ...events[2]!, minutes: 30, time: 1030 }], first.states));
});

test('Penny, Elliott and Maru need six tiles between their two real record points', () => {
  for (const projectId of ['penny_learning_book', 'elliott_triptych', 'maru_field_holder'] as const) {
    const events = route(projectId), first = apply(events.slice(0, 2), prerequisite(projectId));
    assert.throws(() => apply([{ ...events[2]!, x: 15, y: 10 }], first.states), /required route/);
    assert.doesNotThrow(() => apply([{ ...events[2]!, x: 16, y: 10 }], first.states));
  }
});

test('Leah must use three pairwise distinct viewpoints rather than returning near an earlier point', () => {
  const events = route(), first = apply(events.slice(0, 3));
  assert.throws(() => apply([{ ...events[3]!, x: 10, y: 11 }], first.states), /required route/);
  assert.throws(() => apply([{ ...events[3]!, x: 20, y: 15 }], first.states), /required route/);
  assert.doesNotThrow(() => apply([{ ...events[3]!, x: 20, y: 16 }], first.states));
});

test('Robin must walk out and return within three tiles of the actual starting point', () => {
  const events = route('robin_small_space'), prior = prerequisite('robin_small_space');
  assert.throws(() => apply([events[0]!, events[1]!, { ...events[2]!, x: 15 }], prior), /required route/);
  const outward = apply(events.slice(0, 3), prior);
  assert.throws(() => apply([{ ...events[3]!, x: 14, y: 10 }], outward.states), /required route/);
  assert.doesNotThrow(() => apply([{ ...events[3]!, x: 13, y: 10 }], outward.states));
});

test('Willy needs actual caught fish and completion cannot lower a recorded catch count', () => {
  const events = route('willy_shore_guide'), prior = prerequisite('willy_shore_guide');
  assert.throws(() => apply([events[0]!, { ...events[1]!, count: 0 }], prior), /action count/);
  const point = apply([events[0]!, { ...events[1]!, count: 2 }], prior);
  assert.throws(() => apply([events[2]!], point.states), /actual actions/);
  assert.doesNotThrow(() => apply([{ ...events[2]!, count: 2 }], point.states));
});

test('Linus records the checkpoint choice separately from finish choice and b requires a second real item', () => {
  const events = completedPractice('linus_light_steps', 'b'), prior = prerequisite('linus_light_steps');
  const point = apply(events.slice(0, -1), prior);
  assert.throws(() => apply([{ ...events.at(-1)!, count: 1, choiceId: 'a' }], point.states), /actual actions/);
  const finished = apply([{ ...events.at(-1)!, choiceId: 'a' }], point.states);
  assert.match(goalResultContext(finished.states.linus!, 10)!, /采集 2 件/);
});

test('all checkpoints and a new explicit completion are required even after enough real minutes', () => {
  const events = route(), incomplete = apply(events.slice(0, 3));
  assert.throws(() => apply([{ ...events.at(-1)!, sourceId: events[2]!.id }], incomplete.states), /every checkpoint/);
  const ready = apply(events.slice(0, -1));
  assert.match(goalResultContext(ready.states.leah!, 10)!, /3\/3 个实际点，尚未完成/);
  assert.throws(() => apply([{ ...events.at(-1)!, sourceId: events[2]!.id }], ready.states), /exact last source/);
  assert.throws(() => apply([{ ...events.at(-1)!, day: 11 }], ready.states), /attempt day/);
  assert.throws(() => apply([{ ...events.at(-1)!, minutes: 20 }], ready.states), /actual minutes/);
});

test('completion cannot go below the minutes actually recorded at the final checkpoint', () => {
  const events = route(); events[3] = { ...events[3]!, time: 1040, minutes: 40 };
  const ready = apply(events.slice(0, -1));
  assert.throws(() => apply([events.at(-1)!], ready.states), /actual actions/);
  assert.doesNotThrow(() => apply([{ ...events.at(-1)!, minutes: 40 }], ready.states));
});

test('ordinary cancellation is same-day while load and interruption can close a stale attempt later', () => {
  const first = apply(route().slice(0, 2));
  assert.throws(() => apply([cancel('life-20', 'life-25', 11)], first.states), /attempt day/);
  for (const reason of ['load', 'interrupted'] as const) {
    const ended = apply([cancel('life-20', 'life-25', 11, reason)], first.states);
    assert.match(goalResultContext(ended.states.leah!, 11)!, /未完成/);
    assert.doesNotMatch(memory(ended.changes), /已经完成|已形成回执/);
  }
  const expired = goalResultContext(first.states.leah!, 11)!;
  assert.match(expired, /已过期，不能继续/);
});

test('cancelled attempts cannot contribute old checkpoints to a new retry', () => {
  const first = apply([...route().slice(0, 2), cancel()]);
  assert.throws(() => apply([{ ...route()[2]!, id: 'life-26' }], first.states), /already ended/);
  const retry = apply([start('leah_form_study', 'life-30', 11)], first.states);
  assert.equal(saved(retry.states).watermark, 25);
  assert.equal(saved(retry.states).events.length, 1);
  assert.throws(() => apply([{ ...route()[1]!, id: 'life-31', day: 11 }], retry.states), /another attempt/);
  assert.doesNotThrow(() => apply([{ ...route()[1]!, id: 'life-31', day: 11, attemptId: 'life-30' }], retry.states));
});

test('compacted retries reject old and unknown IDs unless the bridge first verifies their global signatures', () => {
  const first = apply([...route().slice(0, 2), cancel()]), retry = apply([start('leah_form_study', 'life-30', 11)], first.states);
  assert.throws(() => goalResultChanges([start()], retry.states), /global signature verification/);
  assert.throws(() => goalResultChanges([start('leah_form_study', 'life-23', 10)], retry.states), /global signature verification/);
  assert.throws(() => goalResultChanges([start('leah_form_study', 'life-29', 10)], retry.states), /unknown old event/);
  assert.deepEqual(goalResultChanges([start('leah_form_study', 'life-30', 11)], retry.states), []);
});

test('retry compaction keeps reminder receipts and does not grow with cancelled attempts', () => {
  let current = apply([notice(), start('leah_form_study', 'life-21'), cancel('life-21', 'life-22')]).states;
  for (let i = 0; i < 100; i++) {
    const serial = 30 + i * 2, day = 11 + i;
    current = apply([start('leah_form_study', `life-${serial}`, day), cancel(`life-${serial}`, `life-${serial + 1}`, day)], current).states;
    assert.equal(saved(current).events.length, 3);
  }
  assert.deepEqual(goalResultChanges([notice()], current), []);
  assert.throws(() => goalResultChanges([{ ...notice(), day: 9 }], current), /repeated event changed/);
  assert.equal(goalResultContext(current.leah!, 110)?.includes('旧记录点不可用于新尝试'), true);
});

test('finished practice cannot be cancelled, retried or given another checkpoint', () => {
  const first = apply(route());
  assert.throws(() => apply([cancel('life-20', 'life-25')], first.states), /already ended/);
  assert.throws(() => apply([start('leah_form_study', 'life-25')], first.states), /overwritten/);
  assert.throws(() => apply([{ ...route()[1]!, id: 'life-25' }], first.states), /already ended/);
});

test('review occurs exactly once on a later day and names this actual completion', () => {
  const events = route(), finished = apply(events);
  assert.throws(() => apply([reviewPractice(events, 'a', 10)], finished.states), /later day/);
  assert.throws(() => apply([{ ...reviewPractice(events), sourceId: events[3]!.id }], finished.states), /completed practice/);
  const reviewed = apply([reviewPractice(events)], finished.states);
  assert.equal(reviewed.changes[0]!.memories![0]!.kind, 'heard');
  assert.match(memory(reviewed.changes), /不是再次完成活动/);
  assert.throws(() => apply([{ ...reviewPractice(events), id: 'life-26', day: 12 }], reviewed.states), /once/);
  const noFinish = apply(events.slice(0, -1));
  assert.throws(() => apply([reviewPractice(events)], noFinish.states), /completed practice/);
});

test('complete sources and facts survive serialization and replay without duplicate memories', () => {
  const events = [...route(), reviewPractice(route())], first = apply(events);
  const restored = JSON.parse(JSON.stringify(first.states)) as States;
  assert.deepEqual(goalResultChanges(events, restored), []);
  assert.equal(goalResultContext(restored.leah!, 100), goalResultContext(first.states.leah!, 100));
  const reordered = Object.fromEntries(Object.entries(events[1]!).reverse()) as unknown as GoalResultEvent;
  assert.deepEqual(goalResultChanges([reordered], restored), []);
  assert.throws(() => goalResultChanges([{ ...events[1]!, weather: 'rain' }], restored), /repeated event changed/);
});

test('saved envelopes, sources, routes and terminal references are revalidated', () => {
  const first = apply([...route(), reviewPractice(route())]);
  const mutations: ((states: States) => void)[] = [
    states => { saved(states).version = 2; }, states => { saved(states).owner = 'robin'; },
    states => { saved(states).projectId = 'robin_small_space'; }, states => { saved(states).watermark = 1000; },
    states => { saved(states).events = []; }, states => { saved(states).sources = []; },
    states => { saved(states).sources[0]!.outcome = 'a'; }, states => { saved(states).events[1]!.x = 500; saved(states).events[2]!.x = 500; },
    states => { saved(states).events[4]!.sourceId = 'life-21'; }, states => { saved(states).events[5]!.day = 10; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(first.states); mutate(changed);
    assert.throws(() => goalResultContext(changed.leah!, 11), /INVALID_GOAL_RESULT_EVENT/);
  }
  const extra = structuredClone(first.states); (extra.leah!.goalResult as Record<string, unknown>).reward = 100;
  assert.throws(() => goalResultContext(extra.leah!, 11), /saved practice state/);
});

test('saved owner state cannot migrate to another NPC and summaries do not read another namespace', () => {
  const first = apply([start()]);
  assert.throws(() => goalResultChanges([start('robin_small_space', 'life-21')], { robin: first.states.leah! }), /saved practice state/);
  assert.equal(goalResultContext({ longGoal: first.states.leah!.longGoal! }, 10), undefined);
  assert.equal(goalResultContext({}, 10), undefined);
});

test('failed batches do not mutate prior state or return partial notices and practice facts', () => {
  const prior = prerequisite(), untouched = structuredClone(prior);
  assert.throws(() => apply([start(), route().at(-1)!], prior), /every checkpoint/);
  assert.deepEqual(prior, untouched);
  const active = apply([start()]), copy = structuredClone(active.states);
  assert.throws(() => apply([route()[1]!, { ...route()[2]!, x: 10, y: 10 }], active.states), /required route/);
  assert.deepEqual(active.states, copy);
});

test('restoring a branch checkpoint permits a new choice and keeps abandoned choices out of current state', () => {
  const checkpoint = prerequisite(), original = apply([start()], checkpoint);
  const alternate = apply([{ ...start(), choiceId: 'b' }], structuredClone(checkpoint));
  assert.equal(saved(original.states).events[0]!.choiceId, 'a');
  assert.equal(saved(alternate.states).events[0]!.choiceId, 'b');
  assert.ok(goalResultContext(alternate.states.leah!, 10)!.includes(def().planChoices.find(choice => choice.id === 'b')!.label));
  assert.equal(checkpoint.leah!.goalResult, undefined);
});

test('new projections preserve unrelated state, hide future evidence and keep prompt boundaries concise', () => {
  const prior = prerequisite(); prior.leah!.impression = '原有印象'; prior.leah!.plan = ['原有计划'];
  const result = apply([start()], prior);
  assert.equal(result.states.leah!.impression, '原有印象'); assert.deepEqual(result.states.leah!.plan, ['原有计划']);
  assert.equal(goalResultContext(result.states.leah!, 9), undefined);
  assert.throws(() => goalResultContext(result.states.leah!, 0), /context day/);
  assert.match(goalResultContext(result.states.leah!, 10)!, /^## 成果实践/);
  assert.doesNotMatch(goalResultContext(result.states.leah!, 10)!, /receiptIntro|checkpoint|attemptId/);
});
