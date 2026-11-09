import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LifeEvent } from '../src/agent/life.ts';
import { parseLifeJournal, type LifeJournalEvent } from '../src/agent/life-journal.ts';
import type { RomanceEvent } from '../src/agent/romance.ts';
import type { StoryEvent } from '../src/agent/town-stories.ts';
import type { DayEntry } from '../src/types.ts';
import { connect, deferred, harness, initial, openTalk, sleep } from './helpers/bridge.ts';

const started: StoryEvent = { id: 'life-1', npc: 'gus', day: 1, kind: 'story.started', storyId: 'gus_parcel' };
const witness: StoryEvent = { ...started, id: 'life-2', kind: 'story.clue', clueId: 'emily_mark', other: 'emily' };
const found: StoryEvent = { ...started, id: 'life-3', kind: 'story.clue', clueId: 'parcel' };
const returned: StoryEvent = { ...started, id: 'life-4', kind: 'story.resolved', outcome: 'returned' };
const project: StoryEvent = { id: 'life-1', npc: 'penny', day: 1, kind: 'story.started', storyId: 'penny_field_notes' };
const work1: StoryEvent = { ...project, id: 'life-2', day: 2, kind: 'story.worked', step: 1, venue: 'Town', minutes: 30 };
const work2: StoryEvent = { ...project, id: 'life-3', day: 3, kind: 'story.worked', step: 2, venue: 'ArchaeologyHouse', minutes: 30 };
const independent: StoryEvent = { ...project, id: 'life-4', day: 3, kind: 'story.resolved', outcome: 'independent' };
const ordinary: LifeEvent = { id: 'life-10', npc: 'leah', day: 1, kind: 'goal.accepted', goal: 'leah-driftwood-v1' };
type Wire = Awaited<ReturnType<typeof connect>>;
const sync = (events: LifeJournalEvent[], final = true) => ({ type: 'life.sync', events, final });
async function upload(wire: Wire, events: LifeJournalEvent[], final = true) {
  const from = wire.inbox.length, packet = wire.send(sync(events, final));
  await wire.until(final ? 'life.ready' : 'ack', from);
  return packet;
}
async function prompt(wire: Wire, npc: string, day: number, relation = 'friend') {
  const from = wire.inbox.length;
  wire.send({ ...openTalk(day, npc), relation }); await wire.until('talk.reply', from);
}
async function closeTalk(wire: Wire, npc: string) {
  const from = wire.inbox.length;
  wire.send({ type: 'talk.close', npc }); await wire.until('ack', from);
}
function logs(directory: string, commit: string, npc: string): DayEntry[] {
  const db = new DatabaseSync(join(directory, 'memory.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT entry FROM log WHERE commit_id=? AND npc_id=? ORDER BY seq').all(commit, npc)
    .map(row => JSON.parse(row.entry as string) as DayEntry); }
  finally { db.close(); }
}
function memories(directory: string, commit: string) {
  const db = new DatabaseSync(join(directory, 'memory.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT npc_id,text,visibility FROM memory WHERE commit_id=? ORDER BY rowid').all(commit); }
  finally { db.close(); }
}
const content = JSON.parse(readFileSync(new URL('../data/town/stories.json', import.meta.url), 'utf8')) as {
  stories: { id: string; clues?: { id: string; text: string }[] }[];
};
const clueText = (id: string) => content.stories.find(story => story.id === 'gus_parcel')!.clues!.find(clue => clue.id === id)!.text;

test('story capability and mixed serial validation retain earlier life and romance protocols', async t => {
  assert.equal(parseLifeJournal([started, witness, found, returned, ordinary]).length, 5);
  assert.throws(() => parseLifeJournal([ordinary, started]), /increasing serial/);
  assert.throws(() => parseLifeJournal([started, { ...ordinary, id: started.id }]), /increasing serial/);
  const h = await harness(t), wire = await connect(await h.start());
  const hello = wire.inbox.find(message => message.type === 'hello');
  assert.equal(hello?.type === 'hello' && hello.storiesProtocol, 1);
  assert.equal(hello?.type === 'hello' && hello.romanceProtocol, 1);
  assert.equal(hello?.type === 'hello' && hello.lifeProtocol, 1);
});

test('an owner cannot read unreported evidence while a witness recalls only their own testimony', { timeout: 20000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  await upload(wire, [started, witness, found]);
  assert.equal(h.fake.sent.length, 0);
  await prompt(wire, 'Gus', 1);
  assert.ok(!h.fake.sent.at(-1)!.some(message => message.content.includes(clueText('emily_mark'))));
  assert.ok(!h.fake.sent.at(-1)!.some(message => message.content.includes(clueText('parcel'))));
  await closeTalk(wire, 'Gus');
  await prompt(wire, 'Emily', 1);
  assert.ok(h.fake.sent.at(-1)!.some(message => message.content.includes(clueText('emily_mark'))));
  assert.ok(!h.fake.sent.at(-1)!.some(message => message.content.includes(clueText('parcel'))));
  await closeTalk(wire, 'Emily');
  await prompt(wire, 'Pierre', 1);
  assert.ok(!h.fake.sent.at(-1)!.some(message => message.content.includes(clueText('emily_mark'))));
  const commit = await sleep(wire, 'story-witness-boundaries');
  const notes = memories(h.directory, commit.commitId);
  assert.ok(notes.filter(note => String(note.text).includes(clueText('emily_mark'))).every(note => note.npc_id === 'emily'));
  assert.ok(notes.every(note => note.visibility === 'private'));
});

test('telling an actual clue explicitly unlocks only that source for its owner', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  await upload(wire, [started, witness, found, { ...started, id: 'life-4', kind: 'story.told', sourceId: witness.id }]);
  await prompt(wire, 'Gus', 1);
  assert.ok(h.fake.sent.at(-1)!.some(message => message.content.includes(clueText('emily_mark'))));
  assert.ok(!h.fake.sent.at(-1)!.some(message => message.content.includes(clueText('parcel'))));
  await closeTalk(wire, 'Gus');
  const from = wire.inbox.length;
  wire.send(sync([{ ...started, id: 'life-5', kind: 'story.told', sourceId: witness.id }]));
  await wire.until('sync.error', from);
});

test('a bad story transition atomically rejects ordinary life changes in the same batch', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  const from = wire.inbox.length;
  wire.send(sync([{ ...ordinary, id: 'life-1' }, { ...returned, id: 'life-2' }])); await wire.until('sync.error', from);
  await upload(wire, []);
  const commit = await sleep(wire, 'story-atomic-reject');
  assert.equal(memories(h.directory, commit.commitId).length, 0);
  assert.equal(logs(h.directory, commit.commitId, 'leah').length, 0);
  assert.equal(logs(h.directory, commit.commitId, 'gus').length, 0);
});

test('one NPC can persist three domains together without replacing whole NPC state', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  const story: StoryEvent = { ...project, npc: 'elliott', storyId: 'elliott_short_piece' };
  const plan: RomanceEvent = { id: 'life-2', npc: 'elliott', day: 1, kind: 'romance.planned', dateId: 'date-2',
    dateDay: 1, time: 1000, venue: 'Beach', preparation: 'quiet', relation: 'dating', initiator: 'player' };
  const activity: LifeEvent = { id: 'life-3', npc: 'elliott', day: 1, kind: 'activity.completed', activity: 'forest_walk', minutes: 30, friendship: 0 };
  await upload(wire, [story, plan, activity]);
  const commit = await sleep(wire, 'story-three-domains');
  const change = logs(h.directory, commit.commitId, 'elliott')[0]!.changes.find(entry => entry.npcId === 'elliott')!;
  assert.ok(change.log?.lifeState && change.log?.romanceState && change.log?.storyState);
  assert.equal(change.state, undefined);
  await prompt(wire, 'Elliott', 2, 'dating');
  const system = h.fake.sent.at(-1)![0]!.content;
  assert.match(system, /短文/);
  assert.match(system, /约会/);
  assert.match(system, /散步/);
});

test('partial story replay blocks talk and reconnect replays sources only once', { timeout: 15000 }, async t => {
  const h = await harness(t), server = await h.start(), wire = await connect(server);
  const packet = await upload(wire, [started, witness], false);
  let from = wire.inbox.length;
  wire.send(openTalk(1, 'Gus')); await wire.until('talk.error', from);
  const cursor = wire.cursor(); await wire.close();
  const resumed = await connect(server, wire.loaded, cursor);
  from = resumed.inbox.length; resumed.raw(packet); await resumed.until('ack', from);
  await upload(resumed, [started, witness, found, returned]);
  const commit = await sleep(resumed, 'story-reconnect');
  const events = logs(h.directory, commit.commitId, 'gus').flatMap(entry => entry.changes.flatMap(change => change.log?.storyEvents ?? []));
  assert.equal(events.length, 4);
});

test('independent projects require two actual work days and survive saved backend restart', { timeout: 20000 }, async t => {
  const h = await harness(t); let server = await h.start(), wire = await connect(server);
  await upload(wire, [project]);
  const first = await sleep(wire, 'story-project-start');
  await upload(wire, [work1]);
  const second = await sleep(wire, 'story-project-work', 2, first.commitId);
  await upload(wire, [work2, independent]);
  const third = await sleep(wire, 'story-project-finish', 3, second.commitId);
  const original = logs(h.directory, third.commitId, 'penny').flatMap(entry => entry.changes.flatMap(change => change.log?.storyEvents ?? []));
  assert.equal(original.length, 2);
  await wire.close(); await h.stop(server);
  server = await h.start(); wire = await connect(server, initial('story-project-restart', 4, third));
  await upload(wire, [project, work1, work2, independent]);
  await prompt(wire, 'Penny', 4);
  assert.match(h.fake.sent.at(-1)![0]!.content, /独立|自己|自行/);
  const fourth = await sleep(wire, 'story-project-again', 4, third.commitId);
  assert.equal(logs(h.directory, fourth.commitId, 'penny').flatMap(entry => entry.changes.flatMap(change => change.log?.storyEvents ?? [])).length, 0);
});

test('unobserved cross-day advancement and future work are rejected without making a finished project', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  await upload(wire, [project]);
  let from = wire.inbox.length;
  wire.send(sync([work1])); await wire.until('sync.error', from);
  const first = await sleep(wire, 'story-no-work');
  from = wire.inbox.length;
  wire.send(sync([{ ...independent, id: 'life-2', day: 2 }])); await wire.until('sync.error', from);
  await upload(wire, [work1]);
  from = wire.inbox.length;
  wire.send(sync([{ ...work2, day: 2 }])); await wire.until('sync.error', from);
  await upload(wire, []);
  const second = await sleep(wire, 'story-one-work', 2, first.commitId);
  const events = logs(h.directory, second.commitId, 'penny').flatMap(entry => entry.changes.flatMap(change => change.log?.storyEvents ?? []));
  assert.equal(events.length, 1);
});

test('uncommitted contribution choices roll back and a stale load cannot affect the sibling branch', { timeout: 20000 }, async t => {
  const h = await harness(t), server = await h.start(), wire = await connect(server);
  await upload(wire, [project]);
  const first = await sleep(wire, 'story-before-contribution');
  const observation: StoryEvent = { ...project, id: 'life-2', day: 2, kind: 'story.observed', venue: 'Forest', weather: 'rain', minutes: 10 };
  const choice: StoryEvent = { ...project, id: 'life-3', day: 2, kind: 'story.choice', choiceId: 'observe', sourceId: observation.id };
  await upload(wire, [observation, choice]);
  let from = wire.inbox.length;
  wire.send({ type: 'title.returned' }); await wire.until('ack', from); await wire.close();
  const restored = await connect(server, initial('story-sibling', 2, first));
  await upload(restored, [{ ...observation, venue: 'Town', weather: 'sunny' }, { ...choice, choiceId: 'read' }]);
  from = restored.inbox.length;
  restored.send({ ...sync([{ ...work1, id: 'life-4' }]), loadNonce: wire.loaded.loadNonce });
  await restored.until('sync.error', from);
  await upload(restored, []);
  const second = await sleep(restored, 'story-sibling-saved', 2, first.commitId);
  const events = logs(h.directory, second.commitId, 'penny').flatMap(entry => entry.changes.flatMap(change => change.log?.storyEvents ?? [])) as unknown as StoryEvent[];
  assert.equal(events.find(event => event.kind === 'story.choice')?.choiceId, 'read');
  assert.equal(events.find(event => event.kind === 'story.observed')?.weather, 'sunny');
});

test('a story clue is not an ordinary public gossip source', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  await upload(wire, [started, witness]);
  const from = wire.inbox.length;
  wire.send(sync([{ id: 'life-3', npc: 'emily', day: 1, kind: 'social.shared', sourceId: witness.id, other: 'sandy' }]));
  await wire.until('sync.error', from);
  await upload(wire, []);
  await prompt(wire, 'Sandy', 1);
  assert.ok(!h.fake.sent.at(-1)!.some(message => message.content.includes(clueText('emily_mark'))));
});

test('late nightly impressions survive later saved story progress and a reload', { timeout: 20000 }, async t => {
  const h = await harness(t), entered = deferred(), gate = deferred();
  t.after(() => gate.resolve());
  const server = await h.start(async input => {
    if (input.commit.dayEnded !== 1) return [];
    entered.resolve(); await gate.promise;
    return [{ npcId: 'gus', state: { impression: '我觉得农场主处理事情很仔细。' } }];
  });
  const wire = await connect(server);
  await prompt(wire, 'Gus', 1); await closeTalk(wire, 'Gus');
  const first = await sleep(wire, 'story-night-before'); await entered.promise;
  const events = [started, witness, found, returned].map(event => ({ ...event, day: 2 }));
  await upload(wire, events);
  const second = await sleep(wire, 'story-night-after', 2, first.commitId);
  gate.resolve();
  const db = new DatabaseSync(join(h.directory, 'memory.sqlite'), { readOnly: true });
  try {
    const done = () => db.prepare("SELECT state FROM npc_state WHERE commit_id=? AND npc_id='gus' AND phase='consolidated'").get(first.commitId);
    for (let i = 0; !done() && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(done());
  } finally { db.close(); }
  await wire.close();
  const restored = await connect(server, initial('story-night-restored', 3, second));
  await upload(restored, events); await prompt(restored, 'Gus', 3);
  const text = h.fake.sent.at(-1)![0]!.content;
  assert.match(text, /我觉得农场主处理事情很仔细/);
  assert.match(text, /归还/);
});
