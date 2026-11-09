import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseLifeJournal, type LifeJournalEvent } from '../src/agent/life-journal.ts';
import { longGoalDefinition, type LongGoalEvent } from '../src/agent/long-goals.ts';
import type { StoryEvent } from '../src/agent/town-stories.ts';
import type { DayEntry } from '../src/types.ts';
import { connect, deferred, harness, initial, openTalk, sleep } from './helpers/bridge.ts';

type Wire = Awaited<ReturnType<typeof connect>>;
const started: LongGoalEvent = { id: 'life-1', npc: 'leah', day: 1, kind: 'longgoal.started', longGoalId: 'leah_form_study' };
const observed: LongGoalEvent = { ...started, id: 'life-2', kind: 'longgoal.observed', chapterId: 1,
  contributionId: 'observation', venue: 'Forest', weather: 'rain', minutes: 10 };
const contributed: LongGoalEvent = { ...started, id: 'life-3', kind: 'longgoal.contributed', chapterId: 1,
  contributionId: 'observation', sourceId: observed.id };
const choice: LongGoalEvent = { ...started, id: 'life-4', kind: 'longgoal.choice', chapterId: 1, choiceId: 'a', sourceId: contributed.id };
const sync = (events: LifeJournalEvent[], final = true) => ({ type: 'life.sync', events, final });
async function upload(wire: Wire, events: LifeJournalEvent[], final = true) {
  const from = wire.inbox.length, packet = wire.send(sync(events, final));
  await wire.until(final ? 'life.ready' : 'ack', from);
  return packet;
}
async function prompt(wire: Wire, npc: string, day: number, relation = 'friend') {
  const from = wire.inbox.length; wire.send({ ...openTalk(day, npc), relation }); await wire.until('talk.reply', from);
}
async function closeTalk(wire: Wire, npc: string) {
  const from = wire.inbox.length; wire.send({ type: 'talk.close', npc }); await wire.until('ack', from);
}
function records(directory: string, commit: string, npc: string): DayEntry[] {
  const db = new DatabaseSync(join(directory, 'memory.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT entry FROM log WHERE commit_id=? AND npc_id=? ORDER BY seq').all(commit, npc)
    .map(row => JSON.parse(row.entry as string) as DayEntry); }
  finally { db.close(); }
}
function notes(directory: string, commit: string) {
  const db = new DatabaseSync(join(directory, 'memory.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT npc_id,text,visibility FROM memory WHERE commit_id=? ORDER BY rowid').all(commit); }
  finally { db.close(); }
}
const section = (text: string) => {
  const start = text.indexOf('## 我的长期目标');
  return start < 0 ? '' : text.slice(start).split('\n## ').slice(0, 1).join('');
};
function defaultRoute(): LongGoalEvent[] {
  const events: LongGoalEvent[] = [started];
  for (const chapterId of [1, 2, 3]) {
    const day = chapterId * 2;
    events.push({ ...started, id: `life-${events.length + 1}`, day, kind: 'longgoal.worked', chapterId, step: 1, venue: 'LeahHouse', minutes: 30 });
    events.push({ ...started, id: `life-${events.length + 1}`, day: day + 1, kind: 'longgoal.worked', chapterId, step: 2, venue: 'LeahHouse', minutes: 30 });
    events.push({ ...started, id: `life-${events.length + 1}`, day: day + 1, kind: 'longgoal.completed', chapterId, outcome: 'default' });
  }
  return events;
}
const prequel: StoryEvent[] = [
  { id: 'life-1', npc: 'elliott', day: 1, kind: 'story.started', storyId: 'elliott_short_piece' },
  { id: 'life-2', npc: 'elliott', day: 2, kind: 'story.worked', storyId: 'elliott_short_piece', step: 1, venue: 'Beach', minutes: 30 },
  { id: 'life-3', npc: 'elliott', day: 3, kind: 'story.worked', storyId: 'elliott_short_piece', step: 2, venue: 'Beach', minutes: 30 },
  { id: 'life-4', npc: 'elliott', day: 3, kind: 'story.resolved', storyId: 'elliott_short_piece', outcome: 'independent' },
];
const continuation: LongGoalEvent = { id: 'life-5', npc: 'elliott', day: 4, kind: 'longgoal.started', longGoalId: 'elliott_triptych', dependencySourceId: 'life-4' };

test('long-goal capability preserves all earlier protocols and the shared serial', async t => {
  assert.equal(parseLifeJournal([started, observed, contributed, choice]).length, 4);
  assert.throws(() => parseLifeJournal([observed, started]), /increasing serial/);
  const h = await harness(t), wire = await connect(await h.start());
  const hello = wire.inbox.find(message => message.type === 'hello');
  assert.ok(hello?.type === 'hello');
  assert.equal(hello.goalsProtocol, 1); assert.equal(hello.storiesProtocol, 1);
  assert.equal(hello.romanceProtocol, 1); assert.equal(hello.lifeProtocol, 1);
});

test('unreported chapter observations have no owner prompt effect and never reach another NPC', { timeout: 20000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  await upload(wire, [started]); await prompt(wire, 'Leah', 1);
  const baseline = section(h.fake.sent.at(-1)![0]!.content); assert.ok(baseline);
  await closeTalk(wire, 'Leah');
  await upload(wire, [observed]); await prompt(wire, 'Leah', 1);
  assert.equal(section(h.fake.sent.at(-1)![0]!.content), baseline);
  await closeTalk(wire, 'Leah'); await prompt(wire, 'Maru', 1);
  assert.equal(section(h.fake.sent.at(-1)![0]!.content), '');
  const commit = await sleep(wire, 'long-hidden');
  const changes = records(h.directory, commit.commitId, 'leah').flatMap(entry => entry.changes);
  const hidden = changes.find(change => (change.log?.longGoalEvents as unknown as LongGoalEvent[] | undefined)?.some(event => event.kind === 'longgoal.observed'))!;
  assert.equal(hidden.memories?.length ?? 0, 0);
  assert.ok(notes(h.directory, commit.commitId).every(note => note.visibility === 'private'));
});

test('only an explicit contribution unlocks its observation and direction', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  await upload(wire, [started, observed, contributed, choice]); await prompt(wire, 'Leah', 1);
  const summary = section(h.fake.sent.at(-1)![0]!.content);
  assert.match(summary, /雨/);
  assert.ok(summary.includes(longGoalDefinition('leah_form_study')!.chapters[0]!.choices[0]!.label));
  await closeTalk(wire, 'Leah');
  const from = wire.inbox.length;
  wire.send(sync([{ ...choice, id: 'life-5', choiceId: 'b' }])); await wire.until('sync.error', from);
});

test('one batch resolves a prequel before starting its continuation and persists all four namespaces', { timeout: 20000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('long-four', 4));
  await upload(wire, [...prequel, continuation,
    { id: 'life-6', npc: 'elliott', day: 4, kind: 'romance.planned', dateId: 'date-6', dateDay: 4, time: 1000,
      venue: 'Beach', preparation: 'quiet', relation: 'dating', initiator: 'player' },
    { id: 'life-7', npc: 'elliott', day: 4, kind: 'activity.completed', activity: 'forest_walk', minutes: 30, friendship: 0 }]);
  const commit = await sleep(wire, 'long-four-saved', 4);
  const change = records(h.directory, commit.commitId, 'elliott')[0]!.changes.find(entry => entry.npcId === 'elliott')!;
  for (const key of ['lifeState', 'romanceState', 'storyState', 'longGoalState']) assert.ok(change.log?.[key], key);
  assert.equal(change.state, undefined);
  await prompt(wire, 'Elliott', 5, 'dating');
  assert.match(h.fake.sent.at(-1)![0]!.content, /三处风景的旁白/);
});

test('a bad long-goal transition rejects earlier story, romance and life mutations atomically', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('long-reject', 4));
  const from = wire.inbox.length;
  wire.send(sync([...prequel, continuation,
    { id: 'life-6', npc: 'elliott', day: 4, kind: 'romance.planned', dateId: 'date-6', dateDay: 4, time: 1000,
      venue: 'Beach', preparation: 'quiet', relation: 'dating', initiator: 'player' },
    { id: 'life-7', npc: 'elliott', day: 4, kind: 'activity.completed', activity: 'forest_walk', minutes: 30, friendship: 0 },
    { id: 'life-8', npc: 'elliott', day: 4, longGoalId: 'elliott_triptych', kind: 'longgoal.worked', chapterId: 1, step: 2, venue: 'Beach', minutes: 30 }]));
  await wire.until('sync.error', from); await upload(wire, []);
  const commit = await sleep(wire, 'long-reject-saved', 4);
  assert.equal(records(h.directory, commit.commitId, 'elliott').length, 0);
  assert.equal(notes(h.directory, commit.commitId).length, 0);
});

test('a later source cannot unlock an earlier continuation in the same replay batch', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('long-reversed', 4));
  const from = wire.inbox.length;
  wire.send(sync([...prequel.slice(0, 3), { ...continuation, id: 'life-4', dependencySourceId: 'life-5' }, { ...prequel[3]!, id: 'life-5' }]));
  await wire.until('sync.error', from); await upload(wire, []);
  const commit = await sleep(wire, 'long-reversed-saved', 4);
  assert.equal(records(h.directory, commit.commitId, 'elliott').length, 0);
});

test('partial replay and reconnect preserve exactly one copy of each long-goal source', { timeout: 15000 }, async t => {
  const h = await harness(t), server = await h.start(), wire = await connect(server);
  const packet = await upload(wire, [started, observed], false);
  let from = wire.inbox.length; wire.send(openTalk(1, 'Leah')); await wire.until('talk.error', from);
  const cursor = wire.cursor(); await wire.close();
  const resumed = await connect(server, wire.loaded, cursor);
  from = resumed.inbox.length; resumed.raw(packet); await resumed.until('ack', from);
  await upload(resumed, [started, observed, contributed, choice]);
  const commit = await sleep(resumed, 'long-reconnect');
  const events = records(h.directory, commit.commitId, 'leah').flatMap(entry => entry.changes.flatMap(change => change.log?.longGoalEvents ?? []));
  assert.equal(events.length, 4);
});

test('three autonomous chapters survive six actual workdays, saving and a backend restart', { timeout: 25000 }, async t => {
  const h = await harness(t); let server = await h.start(), wire = await connect(server);
  const events = defaultRoute(); let parent: string | null = null;
  for (let day = 1; day <= 7; day++) {
    await upload(wire, events.filter(event => event.day === day));
    const commit = await sleep(wire, `long-six-${day}`, day, parent); parent = commit.commitId;
  }
  await wire.close(); await h.stop(server); server = await h.start();
  wire = await connect(server, initial('long-six-restored', 8, { commitId: parent!, parentId: 'long-six-6', dayEnded: 7 }));
  await upload(wire, events); await prompt(wire, 'Leah', 8);
  const summary = section(h.fake.sent.at(-1)![0]!.content);
  assert.ok(summary.includes(longGoalDefinition('leah_form_study')!.collectionTitle));
  const commit = await sleep(wire, 'long-six-again', 8, parent);
  assert.equal(records(h.directory, commit.commitId, 'leah').flatMap(entry => entry.changes.flatMap(change => change.log?.longGoalEvents ?? [])).length, 0);
});

test('material contribution remains real even when the chapter uses its default direction', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('long-material', 5));
  const prefix = defaultRoute().slice(0, 4);
  const material: LongGoalEvent = { ...started, id: 'life-5', day: 4, kind: 'longgoal.contributed', chapterId: 2,
    contributionId: 'materials', itemId: '(O)388', count: 4 };
  await upload(wire, [...prefix, material,
    { ...started, id: 'life-6', day: 4, kind: 'longgoal.worked', chapterId: 2, step: 1, venue: 'Forest', minutes: 30 },
    { ...started, id: 'life-7', day: 5, kind: 'longgoal.worked', chapterId: 2, step: 2, venue: 'Forest', minutes: 30 },
    { ...started, id: 'life-8', day: 5, kind: 'longgoal.completed', chapterId: 2, outcome: 'default' }]);
  const commit = await sleep(wire, 'long-material-saved', 5);
  assert.ok(notes(h.directory, commit.commitId).some(note => note.npc_id === 'leah' && /4.*木材|木材.*4/.test(String(note.text))));
  assert.ok(notes(h.directory, commit.commitId).every(note => !/亲自砍|自己采集/.test(String(note.text))));
});

test('unsaved contributions roll back and a sibling branch can reuse its serials without stale choices', { timeout: 20000 }, async t => {
  const h = await harness(t), server = await h.start(), wire = await connect(server);
  await upload(wire, [started]); const first = await sleep(wire, 'long-before-choice');
  const attempt = [observed, contributed, choice].map(event => ({ ...event, day: 2 }));
  await upload(wire, attempt);
  let from = wire.inbox.length; wire.send({ type: 'title.returned' }); await wire.until('ack', from); await wire.close();
  const restored = await connect(server, initial('long-sibling', 2, first));
  await upload(restored, [{ ...attempt[0]!, weather: 'windy' }, attempt[1]!, { ...attempt[2]!, choiceId: 'b' }]);
  from = restored.inbox.length;
  restored.send({ ...sync([{ ...started, id: 'life-5', day: 2, kind: 'longgoal.worked', chapterId: 1, step: 1, venue: 'LeahHouse', minutes: 30 }]), loadNonce: wire.loaded.loadNonce });
  await restored.until('sync.error', from); await upload(restored, []);
  const second = await sleep(restored, 'long-sibling-saved', 2, first.commitId);
  const events = records(h.directory, second.commitId, 'leah').flatMap(entry => entry.changes.flatMap(change => change.log?.longGoalEvents ?? [])) as unknown as LongGoalEvent[];
  assert.equal(events.find(event => event.kind === 'longgoal.choice')?.choiceId, 'b');
  assert.equal(events.find(event => event.kind === 'longgoal.observed')?.weather, 'windy');
});

test('private long-goal contributions cannot become public friend gossip', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  await upload(wire, [started, observed, contributed]);
  const from = wire.inbox.length;
  wire.send(sync([{ id: 'life-4', npc: 'leah', day: 1, kind: 'social.shared', other: 'elliott', sourceId: contributed.id }]));
  await wire.until('sync.error', from); await upload(wire, []); await prompt(wire, 'Elliott', 1);
  assert.equal(section(h.fake.sent.at(-1)![0]!.content), '');
});

test('a shared life serial cannot be repurposed across domains or NPCs, including after saved restart', { timeout: 20000 }, async t => {
  const h = await harness(t); let server = await h.start(), wire = await connect(server);
  await upload(wire, [{ id: 'life-1', npc: 'leah', day: 1, kind: 'goal.accepted', goal: 'leah-driftwood-v1' }]);
  let from = wire.inbox.length;
  wire.send(sync([started])); await wire.until('sync.error', from);
  from = wire.inbox.length;
  wire.send(sync([{ ...started, npc: 'maru', longGoalId: 'maru_field_holder' }])); await wire.until('sync.error', from);
  await upload(wire, []); const first = await sleep(wire, 'long-global-serial');
  await wire.close(); await h.stop(server); server = await h.start();
  wire = await connect(server, initial('long-global-restored', 2, first));
  from = wire.inbox.length;
  wire.send(sync([{ ...started, day: 2 }])); await wire.until('sync.error', from);
  await upload(wire, [{ ...started, id: 'life-2', day: 2 }]);
  const second = await sleep(wire, 'long-global-next', 2, first.commitId);
  const events = records(h.directory, second.commitId, 'leah').flatMap(entry => entry.changes.flatMap(change => change.log?.longGoalEvents ?? []));
  assert.equal(events.length, 1);
});

test('late nightly impressions survive later saved long-goal progress', { timeout: 20000 }, async t => {
  const h = await harness(t), entered = deferred(), gate = deferred(); t.after(() => gate.resolve());
  const server = await h.start(async input => {
    if (input.commit.dayEnded !== 1) return [];
    entered.resolve(); await gate.promise;
    return [{ npcId: 'leah', state: { impression: '我觉得农场主尊重我自己的创作节奏。' } }];
  });
  const wire = await connect(server); await prompt(wire, 'Leah', 1); await closeTalk(wire, 'Leah');
  const first = await sleep(wire, 'long-night-before'); await entered.promise;
  await upload(wire, [started, observed, contributed, choice].map(event => ({ ...event, day: 2 })));
  const second = await sleep(wire, 'long-night-after', 2, first.commitId); gate.resolve();
  const db = new DatabaseSync(join(h.directory, 'memory.sqlite'), { readOnly: true });
  try {
    const done = () => db.prepare("SELECT state FROM npc_state WHERE commit_id=? AND npc_id='leah' AND phase='consolidated'").get(first.commitId);
    for (let i = 0; !done() && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(done());
  } finally { db.close(); }
  await wire.close(); const restored = await connect(server, initial('long-night-restored', 3, second));
  await upload(restored, []); await prompt(restored, 'Leah', 3);
  assert.match(h.fake.sent.at(-1)![0]!.content, /尊重我自己的创作节奏/);
  assert.ok(section(h.fake.sent.at(-1)![0]!.content).includes(longGoalDefinition('leah_form_study')!.chapters[0]!.choices[0]!.label));
});
