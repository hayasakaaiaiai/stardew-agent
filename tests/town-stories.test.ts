import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStoryDefinitions, parseStoryEvents, STORY_DEFINITIONS, STORY_IDS, STORY_NPCS,
  storyChanges, storyContext, storyNpcIds, type StoryEvent, type StoryId } from '../src/agent/town-stories.ts';
import type { NpcChange, NpcState } from '../src/types.ts';

type States = Record<string, NpcState>;
const start = (storyId: StoryId = 'gus_parcel', id = 'life-1', day = 10): StoryEvent => ({ id, day, kind: 'story.started', storyId,
  npc: STORY_DEFINITIONS.find(story => story.id === storyId)!.owner });
const clue = (clueId: string, id: string, day = 10): StoryEvent => ({ id, day, npc: 'gus', kind: 'story.clue', storyId: 'gus_parcel', clueId,
  ...(clueId === 'emily_mark' ? { other: 'emily' } : clueId === 'pierre_mark' ? { other: 'pierre' } : {}) });
const observed = (storyId: StoryId = 'penny_field_notes', id = 'life-2', day = 10): StoryEvent => ({ ...start(storyId, id, day),
  kind: 'story.observed', venue: 'Forest', weather: 'rain', minutes: 10 });
const choose = (storyId: StoryId = 'penny_field_notes', id = 'life-3', sourceId = 'life-2', choiceId = 'observe', day = 10): StoryEvent =>
  ({ ...start(storyId, id, day), kind: 'story.choice', sourceId, choiceId });
const work = (storyId: StoryId = 'penny_field_notes', step = 1, id = 'life-4', day = 11): StoryEvent =>
  ({ ...start(storyId, id, day), kind: 'story.worked', step, venue: storyId === 'penny_field_notes' ? 'ArchaeologyHouse' : 'ElliottHouse', minutes: 30 });
const resolved = (storyId: StoryId, outcome: string, id = 'life-6', day = 12): StoryEvent =>
  ({ ...start(storyId, id, day), kind: 'story.resolved', outcome });
const told = (storyId: StoryId, sourceId: string, id: string, day = 10): StoryEvent =>
  ({ ...start(storyId, id, day), kind: 'story.told', sourceId });
function apply(events: StoryEvent[], prior: States = {}): { states: States; changes: NpcChange[] } {
  const changes = storyChanges(events, prior);
  return { states: { ...prior, ...Object.fromEntries(changes.map(change => [change.npcId, change.state!])) }, changes };
}
function memories(changes: NpcChange[], npc: string): string {
  return changes.filter(change => change.npcId === npc).flatMap(change => change.memories ?? []).map(memory => memory.text).join('\n');
}

test('three shared stories have fixed owners, complete branches and known participant IDs', () => {
  assert.deepEqual(new Set(STORY_DEFINITIONS.map(story => story.id)), new Set(STORY_IDS));
  assert.deepEqual(new Set(STORY_NPCS), new Set(['gus', 'emily', 'pierre', 'penny', 'elliott']));
  assert.equal(parseStoryDefinitions({ version: 1, stories: STORY_DEFINITIONS }).length, 3);
  const invalid = structuredClone(STORY_DEFINITIONS);
  invalid[0]!.owner = 'penny';
  assert.throws(() => parseStoryDefinitions({ version: 1, stories: invalid }), /owner/);
  assert.throws(() => parseStoryDefinitions({ version: 2, stories: STORY_DEFINITIONS }), /definitions/);
  assert.throws(() => parseStoryDefinitions({ version: 1, stories: [STORY_DEFINITIONS[0], STORY_DEFINITIONS[0], STORY_DEFINITIONS[1]] }), /owner|ID/);
  const tooWide = structuredClone(STORY_DEFINITIONS);
  const investigation = tooWide.find(story => story.kind === 'investigation')!;
  investigation.site.radius = 11;
  assert.throws(() => parseStoryDefinitions({ version: 1, stories: tooWide }), /site/);
});

test('story batches are bounded, detached, globally ordered and reject unknown fields', () => {
  assert.deepEqual(parseStoryEvents([]), []);
  const raw = [start(), clue('parcel', 'life-2')], parsed = parseStoryEvents(raw);
  raw[0]!.npc = 'penny'; assert.equal(parsed[0]!.npc, 'gus');
  assert.throws(() => parseStoryEvents(Array.from({ length: 33 }, (_, i) => start('gus_parcel', `life-${i + 1}`))), /at most 32/);
  assert.throws(() => parseStoryEvents([start(), start('gus_parcel', 'life-1')]), /increasing serial/);
  assert.throws(() => parseStoryEvents([{ ...start(), id: 'life-01' }]), /positive serial/);
  assert.throws(() => parseStoryEvents([{ ...start(), friendship: 10 }]), /fields/);
  assert.throws(() => parseStoryEvents([{ ...start(), text: 'I finished the story' }]), /fields/);
  assert.throws(() => parseStoryEvents([{ ...start(), kind: 'story.made_up' }]), /kind/);
});

test('events use the exact story owner and cannot cross investigation and project kinds', () => {
  for (const invalid of [null, {}, { ...start(), npc: 'Gus' }, { ...start(), npc: 'emily' }, { ...start(), day: 0 }, { ...start(), storyId: 'unknown' }])
    assert.throws(() => parseStoryEvents([invalid]));
  assert.throws(() => parseStoryEvents([{ ...observed(), storyId: 'gus_parcel', npc: 'gus' }]), /project/);
  assert.throws(() => parseStoryEvents([{ ...clue('parcel', 'life-2'), storyId: 'penny_field_notes', npc: 'penny' }]), /investigations/);
});

test('each clue requires its own witness while the physical parcel has no witness field', () => {
  assert.deepEqual(storyNpcIds(clue('emily_mark', 'life-2')), ['gus', 'emily']);
  assert.deepEqual(storyNpcIds(clue('parcel', 'life-2')), ['gus']);
  assert.throws(() => parseStoryEvents([{ ...clue('emily_mark', 'life-2'), other: 'pierre' }]), /witness/);
  const missing = clue('emily_mark', 'life-2'); delete missing.other;
  assert.throws(() => parseStoryEvents([missing]), /witness/);
  assert.throws(() => parseStoryEvents([{ ...clue('parcel', 'life-2'), other: 'emily' }]), /witness/);
  assert.throws(() => parseStoryEvents([clue('complete_answer', 'life-2')]), /clue/);
});

test('observations require ten real minutes and that project own place and actual weather', () => {
  assert.equal(parseStoryEvents([observed()]).length, 1);
  for (const patch of [{ minutes: 0 }, { minutes: 9 }, { minutes: 1441 }, { minutes: 10.5 }, { venue: 'Beach' }, { weather: 'rainy' }])
    assert.throws(() => parseStoryEvents([{ ...observed(), ...patch }]), /observed/);
  assert.equal(parseStoryEvents([{ ...observed('elliott_short_piece'), venue: 'Beach', weather: 'snow' }]).length, 1);
});

test('choices and work evidence are bounded by the authored project contract', () => {
  assert.throws(() => parseStoryEvents([choose('penny_field_notes', 'life-3', 'life-3')]), /precede/);
  assert.throws(() => parseStoryEvents([choose('penny_field_notes', 'life-3', 'life-2', 'open')]), /supported/);
  for (const patch of [{ step: 0 }, { step: 3 }, { venue: 'Museum' }, { minutes: 29 }, { minutes: 1441 }])
    assert.throws(() => parseStoryEvents([{ ...work(), ...patch }]), /work evidence/);
  assert.equal(parseStoryEvents([{ ...work(), venue: 'Trailer_Big' }]).length, 1);
  assert.throws(() => parseStoryEvents([resolved('gus_parcel', 'independent')]), /outcome/);
});

test('each story must begin explicitly and can begin only once on its save branch', () => {
  assert.throws(() => apply([clue('parcel', 'life-2')]), /not started/);
  const first = apply([start()]);
  assert.throws(() => apply([start('gus_parcel', 'life-2')], first.states), /only start once/);
  assert.match(memories(first.changes, 'gus'), /调查刚刚开始/);
  assert.doesNotMatch(memories(first.changes, 'gus'), /两个圆记号终于分清|空心圆标待转交/);
});

test('finding the parcel updates authority without revealing it to its absent owner', () => {
  const result = apply([start(), clue('parcel', 'life-2')]);
  const cue = storyContext(result.states.gus!, 10)!;
  assert.match(cue, /尚未记录包裹归还/);
  assert.doesNotMatch(cue, /包裹上是空心圆|收货处写着/);
  assert.doesNotMatch(memories(result.changes, 'gus'), /包裹上是空心圆|收货处写着/);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0]!.memories!.length, 1);
});

test('witnesses know only their own actual testimony, not the owner or another witness state', () => {
  const result = apply([start(), clue('emily_mark', 'life-2'), clue('pierre_mark', 'life-3'), clue('parcel', 'life-4')]);
  assert.match(storyContext(result.states.emily!, 10)!, /收货记号是实心圆/);
  assert.doesNotMatch(storyContext(result.states.emily!, 10)!, /我这次用空心圆标待转交|找到的包裹上/);
  assert.match(storyContext(result.states.pierre!, 10)!, /我这次用空心圆标待转交/);
  assert.doesNotMatch(storyContext(result.states.gus!, 10)!, /收货记号是实心圆|我这次用空心圆标待转交|找到的包裹上/);
  assert.equal(storyContext(result.states.leah ?? {}, 10), undefined);
  assert.ok(result.changes.every(change => change.memories!.every(memory => memory.visibility === 'private')));
});

test('telling preserves the named witness as speaker instead of turning first-person testimony into the owner own deed', () => {
  const result = apply([start(), clue('pierre_mark', 'life-2'), told('gus_parcel', 'life-2', 'life-3')]);
  assert.match(storyContext(result.states.gus!, 10)!, /皮埃尔.*证词.*我这次用空心圆/);
  assert.match(memories(result.changes, 'gus'), /皮埃尔.*证词.*我这次用空心圆/);
  const heard = result.changes.find(change => change.npcId === 'gus')!.memories!.at(-1)!;
  assert.equal(heard.kind, 'heard');
  assert.match(heard.text, /不是我在场亲历/);
});

test('direct return needs the actual parcel but does not require claiming the full explanation', () => {
  const result = apply([start(), clue('parcel', 'life-2'), resolved('gus_parcel', 'returned', 'life-3', 10)]);
  assert.match(storyContext(result.states.gus!, 10)!, /包裹回到了酒吧/);
  assert.doesNotMatch(storyContext(result.states.gus!, 10)!, /两个圆记号终于分清了/);
  assert.match(memories(result.changes, 'gus'), /没有记录为已核清全部标记/);
  assert.throws(() => apply([start(), resolved('gus_parcel', 'returned', 'life-2', 10)]), /acquired parcel/);
});

test('explained return needs both witnesses and only then reveals their evidence to the owner', () => {
  assert.throws(() => apply([start(), clue('parcel', 'life-2'), resolved('gus_parcel', 'explained', 'life-3', 10)]), /both witnesses/);
  const result = apply([start(), clue('emily_mark', 'life-2'), clue('pierre_mark', 'life-3'), clue('parcel', 'life-4'),
    resolved('gus_parcel', 'explained', 'life-5', 10)]);
  assert.match(storyContext(result.states.gus!, 10)!, /两个圆记号终于分清了/);
  assert.match(storyContext(result.states.gus!, 10)!, /空心圆.*实心圆|实心圆.*空心圆/);
  assert.doesNotMatch(storyContext(result.states.emily!, 10)!, /第 10 天已结束/);
});

test('completed investigation and already acquired clues cannot produce duplicates or restart', () => {
  assert.throws(() => apply([start(), clue('parcel', 'life-2'), clue('parcel', 'life-3')]), /already obtained/);
  const result = apply([start(), clue('parcel', 'life-2'), resolved('gus_parcel', 'returned', 'life-3', 10)]);
  for (const event of [start('gus_parcel', 'life-4'), clue('emily_mark', 'life-4'), resolved('gus_parcel', 'explained', 'life-4', 10)])
    assert.throws(() => apply([event], result.states), /already resolved/);
});

test('a player observation stays hidden until actually told or contributed to the owner', () => {
  const first = apply([start('penny_field_notes'), observed()]);
  assert.doesNotMatch(storyContext(first.states.penny!, 10)!, /森林|下雨|实际观察/);
  assert.equal(first.changes[0]!.memories!.length, 1);
  const contributed = apply([choose()], first.states);
  assert.match(storyContext(contributed.states.penny!, 10)!, /森林.*10 分钟.*下雨/);
  assert.match(storyContext(contributed.states.penny!, 10)!, /先观察，再想问题/);
  assert.equal(contributed.changes[0]!.memories![0]!.kind, 'heard');
  assert.throws(() => apply([told('penny_field_notes', 'life-2', 'life-4')], contributed.states), /already told/);
});

test('telling an observation first still permits one later contribution without duplicate known sources', () => {
  const result = apply([start('penny_field_notes'), observed(), told('penny_field_notes', 'life-2', 'life-3'), choose('penny_field_notes', 'life-4')]);
  const cue = storyContext(result.states.penny!, 10)!;
  assert.equal(cue.match(/实际观察了 10 分钟/g)?.length, 1);
  assert.throws(() => apply([choose('penny_field_notes', 'life-5')], result.states), /already chosen/);
});

test('both projects support each authored collaborative ending and their independent ending', () => {
  for (const definition of STORY_DEFINITIONS.filter(story => story.kind === 'project')) {
    for (const ending of definition.endings) {
      const cooperative = ending.id !== 'independent';
      const events = [start(definition.id), ...(cooperative ? [observed(definition.id), choose(definition.id, 'life-3', 'life-2', ending.id)] : []),
        work(definition.id), work(definition.id, 2, 'life-5', 12), resolved(definition.id, ending.id)];
      const result = apply(events), cue = storyContext(result.states[definition.owner]!, 12)!;
      assert.match(cue, /第 12 天已结束/);
      assert.ok(cue.includes(ending.title));
      assert.ok(!cue.includes(ending.text), 'complete authored manuscripts must not reside in every prompt');
      assert.equal(result.changes.length, 1);
      if (!cooperative) assert.match(memories(result.changes, definition.owner), /独立完成.*没有记录农场主/);
    }
  }
});

test('work begins no earlier than the next day and the second stage needs another day', () => {
  assert.throws(() => apply([start('penny_field_notes'), work('penny_field_notes', 1, 'life-2', 10)]), /later game day/);
  assert.throws(() => apply([start('penny_field_notes'), work('penny_field_notes', 2, 'life-2', 11)]), /next stage/);
  assert.throws(() => apply([start('penny_field_notes'), work('penny_field_notes', 1, 'life-2', 11), work('penny_field_notes', 2, 'life-3', 11)]), /later game day/);
  const result = apply([start('penny_field_notes'), work('penny_field_notes', 1, 'life-2', 14), work('penny_field_notes', 2, 'life-3', 19),
    resolved('penny_field_notes', 'independent', 'life-4', 19)]);
  assert.match(storyContext(result.states.penny!, 19)!, /第 14、19 天/);
});

test('elapsed days alone never create work, a completed manuscript or player credit', () => {
  const result = apply([start('penny_field_notes')]);
  assert.match(storyContext(result.states.penny!, 99)!, /尚未记录成品完成/);
  assert.throws(() => apply([resolved('penny_field_notes', 'independent', 'life-2', 99)], result.states), /two real work stages/);
  assert.throws(() => apply([start('penny_field_notes'), work(), work('penny_field_notes', 2, 'life-5', 12), resolved('penny_field_notes', 'observe')]), /actual contribution/);
});

test('a project can accept a contribution before resolution and cannot change it afterwards', () => {
  const first = apply([start('penny_field_notes'), work('penny_field_notes', 1, 'life-2', 11), work('penny_field_notes', 2, 'life-3', 12)]);
  const last = apply([observed('penny_field_notes', 'life-4', 12), choose('penny_field_notes', 'life-5', 'life-4', 'read', 12), resolved('penny_field_notes', 'read')], first.states);
  assert.match(storyContext(last.states.penny!, 12)!, /带着问题去核对/);
  assert.throws(() => apply([choose('penny_field_notes', 'life-7', 'life-4', 'observe', 12)], last.states), /already resolved/);
});

test('choices cannot cite another project observation or a work event', () => {
  const result = apply([start('penny_field_notes'), start('elliott_short_piece', 'life-2'), observed('elliott_short_piece', 'life-3')]);
  assert.throws(() => apply([choose('penny_field_notes', 'life-4', 'life-3')], result.states), /this project actual observation/);
  assert.throws(() => apply([start('penny_field_notes'), work('penny_field_notes', 1, 'life-2', 11), choose('penny_field_notes', 'life-3', 'life-2', 'observe', 11)]), /observation/);
});

test('telling accepts only an existing undisclosed clue or observation, never a telling chain or future outcome', () => {
  const result = apply([start(), clue('parcel', 'life-2'), told('gus_parcel', 'life-2', 'life-3')]);
  assert.throws(() => apply([told('gus_parcel', 'life-2', 'life-4')], result.states), /already told/);
  assert.throws(() => apply([told('gus_parcel', 'life-3', 'life-4')], result.states), /existing clue or observation/);
  assert.throws(() => apply([told('gus_parcel', 'life-1', 'life-4')], result.states), /existing clue or observation/);
  assert.throws(() => parseStoryEvents([told('gus_parcel', 'life-5', 'life-4')]), /precede/);
});

test('identical replay is inert and changed retained event IDs are rejected for every involved NPC', () => {
  const events = [start(), clue('emily_mark', 'life-2'), clue('parcel', 'life-3')];
  const result = apply(events);
  assert.deepEqual(storyChanges(events, result.states), []);
  assert.throws(() => storyChanges([{ ...events[1]!, day: 11 }], result.states), /reused with different content/);
  assert.throws(() => storyChanges([events[1]!], { gus: result.states.gus! }), /inconsistent witness replay/);
});

test('a later invalid observation cannot mutate any caller-owned progress or witness state', () => {
  const first = apply([start()]), before = structuredClone(first.states);
  assert.throws(() => apply([clue('emily_mark', 'life-2'), resolved('gus_parcel', 'explained', 'life-3', 10)], first.states));
  assert.deepEqual(first.states, before);
  assert.equal(first.states.emily, undefined);
});

test('rolled-back branches may reuse their native serial without importing another branch choice', () => {
  const before = apply([start('penny_field_notes'), observed()]).states;
  const one = apply([choose()], before).states;
  const two = apply([choose('penny_field_notes', 'life-3', 'life-2', 'read')], before).states;
  assert.match(storyContext(one.penny!, 10)!, /先观察，再想问题/);
  assert.doesNotMatch(storyContext(one.penny!, 10)!, /先读提示，再去核对/);
  assert.match(storyContext(two.penny!, 10)!, /先读提示，再去核对/);
  assert.doesNotMatch(storyContext(before.penny!, 10)!, /农场主明确建议/);
});

test('new backdated observations are rejected while historical source dates remain intact', () => {
  const first = apply([start('penny_field_notes'), observed(), work('penny_field_notes', 1, 'life-3', 12)]);
  assert.throws(() => apply([choose('penny_field_notes', 'life-4', 'life-2', 'observe', 11)], first.states), /predates/);
  const result = apply([choose('penny_field_notes', 'life-4', 'life-2', 'observe', 13)], first.states);
  assert.match(memories(result.changes, 'penny'), /第 13 天.*第 10 天/);
});

test('context keeps source knowledge bounded and never assumes an old save already contained these stories', () => {
  assert.equal(storyContext({}, 10), undefined);
  assert.throws(() => storyContext({}, 0), /context day/);
  const first = apply([start('elliott_short_piece')]);
  assert.equal(storyContext(first.states.elliott!, 9), undefined);
  assert.doesNotMatch(storyContext(first.states.elliott!, 10)!, /没有写完的地址|把地址写完/);
  assert.match(storyContext(first.states.elliott!, 10)!, /短文不等于小说出版/);
});

test('saved projections reject corrupted versions, references, duplicate sources and impossible work', () => {
  const original = apply([start('penny_field_notes'), observed(), choose(), work(), work('penny_field_notes', 2, 'life-5', 12),
    resolved('penny_field_notes', 'observe')]).states.penny!;
  const breakState = (mutate: (raw: any) => void) => {
    const state = structuredClone(original); mutate(state.story);
    assert.throws(() => storyContext(state, 12), /INVALID_STORY_EVENT/);
  };
  breakState(raw => raw.version = 2);
  breakState(raw => raw.progress.unknown = raw.progress.penny_field_notes);
  breakState(raw => raw.progress.penny_field_notes.sources.push(raw.progress.penny_field_notes.sources[0]));
  breakState(raw => raw.progress.penny_field_notes.choice.sourceId = 'life-999');
  breakState(raw => raw.progress.penny_field_notes.work[1].day = 11);
  breakState(raw => raw.progress.penny_field_notes.resolution.outcome = 'independent');
  breakState(raw => raw.knowledge.penny_field_notes.role = 'witness');
  breakState(raw => raw.knowledge.penny_field_notes.sources[0].day = 20);
  breakState(raw => raw.knowledge.penny_field_notes.resolution.outcome = 'independent');
  assert.ok(storyContext(original, 12));
});
