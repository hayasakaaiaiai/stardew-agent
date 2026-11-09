import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LifeJournalEvent } from '../src/agent/life-journal.ts';
import { townCaseDefinition } from '../src/agent/town-cases.ts';
import type { StoryEvent } from '../src/agent/town-stories.ts';
import type { DayEntry } from '../src/types.ts';
import { connect, deferred, harness, initial, openTalk, sleep } from './helpers/bridge.ts';
import { caseHistory, reportCaseSource } from './helpers/town-cases.ts';
import { completedProject, completedPractice } from './helpers/project-practice.ts';

type Wire = Awaited<ReturnType<typeof connect>>;
const sync = (events: readonly LifeJournalEvent[], final = true) => ({ type: 'life.sync', events, final });
async function upload(wire: Wire, events: readonly LifeJournalEvent[], final = true) {
  const from = wire.inbox.length, packet = wire.send(sync(events, final));
  await wire.until(final ? 'life.ready' : 'ack', from); return packet;
}
async function rejected(wire: Wire, events: readonly LifeJournalEvent[]) {
  const from = wire.inbox.length; wire.send(sync(events)); await wire.until('sync.error', from);
}
async function prompt(wire: Wire, npc: string, day: number) {
  const from = wire.inbox.length; wire.send(openTalk(day, npc)); await wire.until('talk.reply', from);
}
async function close(wire: Wire, npc: string) {
  const from = wire.inbox.length; wire.send({ type: 'talk.close', npc }); await wire.until('ack', from);
}
const section = (text: string) => {
  const start = text.indexOf('## 我知道的镇上近况');
  return start < 0 ? '' : text.slice(start).split('\n## ').slice(0, 1).join('');
};
function records(directory: string, commit: string, npc: string): DayEntry[] {
  const db = new DatabaseSync(join(directory, 'memory.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT entry FROM log WHERE commit_id=? AND npc_id=? ORDER BY seq').all(commit, npc)
    .map(row => JSON.parse(row.entry as string) as DayEntry); } finally { db.close(); }
}
function notes(directory: string, commit: string) {
  const db = new DatabaseSync(join(directory, 'memory.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT npc_id,text,visibility FROM memory WHERE commit_id=? ORDER BY rowid').all(commit); }
  finally { db.close(); }
}
function storyEvents(directory: string, commit: string, npc: string) {
  return records(directory, commit, npc).flatMap(entry => entry.changes.flatMap(change => change.log?.storyEvents ?? [])) as unknown as StoryEvent[];
}

test('new cases advertise their own capability while every prior protocol stays available', async t => {
  const h = await harness(t), wire = await connect(await h.start());
  const hello = wire.inbox.find(message => message.type === 'hello'); assert.ok(hello?.type === 'hello');
  assert.equal(hello.casesProtocol, 1); assert.equal(hello.storiesProtocol, 1); assert.equal(hello.lifeProtocol, 1);
  assert.equal(hello.romanceProtocol, 1); assert.equal(hello.goalsProtocol, 1); assert.equal(hello.resultsProtocol, 1);
});

test('field notes remain hidden from the owner until an exact source is explicitly reported', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('case-hidden', 10));
  const history = caseHistory();
  await upload(wire, [history[0]!]); await prompt(wire, 'Caroline', 10);
  const before = section(h.fake.sent.at(-1)![0]!.content); assert.ok(before); await close(wire, 'Caroline');
  await upload(wire, history.slice(1, 5)); await prompt(wire, 'Caroline', 10);
  assert.equal(section(h.fake.sent.at(-1)![0]!.content), before); await close(wire, 'Caroline');
  await upload(wire, [reportCaseSource(history, 3, 6)]); await prompt(wire, 'Caroline', 10);
  const after = section(h.fake.sent.at(-1)![0]!.content); assert.notEqual(after, before);
  assert.match(after, /镇广场/); assert.doesNotMatch(after, /下雨|雨天/); await close(wire, 'Caroline');
  const saved = await sleep(wire, 'case-hidden-saved', 10);
  const hidden = records(h.directory, saved.commitId, 'caroline').flatMap(entry => entry.changes)
    .find(change => (change.log?.storyEvents as unknown as StoryEvent[] | undefined)?.some(event => event.kind === 'story.inspected'))!;
  assert.equal(hidden.memories?.length ?? 0, 0);
});

test('a witness knows their own testimony but receives neither other witnesses nor the owner resolution', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('case-witness', 10));
  const history = caseHistory('clint_sample_labels');
  await upload(wire, history.slice(0, 3)); await prompt(wire, 'Emily', 10);
  const before = section(h.fake.sent.at(-1)![0]!.content); assert.ok(before); await close(wire, 'Emily');
  await upload(wire, history.slice(3)); await prompt(wire, 'Emily', 10);
  assert.equal(section(h.fake.sent.at(-1)![0]!.content), before); await close(wire, 'Emily');
  await prompt(wire, 'Clint', 10); assert.match(section(h.fake.sent.at(-1)![0]!.content), /铜矿|铁矿|结案|结束/); await close(wire, 'Clint');
  await prompt(wire, 'Willy', 10); assert.equal(section(h.fake.sent.at(-1)![0]!.content), '');
});

test('missing evidence rejects a mixed batch atomically including unrelated life, romance and project progress', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('case-atomic-bad', 10));
  const incomplete = caseHistory().filter(event => event.clueId !== 'river');
  await rejected(wire, [...incomplete,
    { id: 'life-10', day: 10, npc: 'leah', kind: 'activity.completed', activity: 'forest_walk', minutes: 30, friendship: 0 },
    { id: 'life-11', day: 10, npc: 'leah', kind: 'romance.planned', dateId: 'date-11', dateDay: 10, time: 1000,
      venue: 'Forest', preparation: 'quiet', relation: 'dating', initiator: 'player' },
    { id: 'life-12', day: 10, npc: 'leah', kind: 'longgoal.started', longGoalId: 'leah_form_study' }]);
  await upload(wire, []); const saved = await sleep(wire, 'case-atomic-empty', 10);
  for (const npc of ['caroline', 'pierre', 'jodi', 'leah']) assert.equal(records(h.directory, saved.commitId, npc).length, 0);
  assert.equal(notes(h.directory, saved.commitId).length, 0);
});

test('new investigation evidence coexists with all five existing journal projections in one save', { timeout: 20000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('case-mixed', 10));
  const cases = caseHistory('caroline_route_notes', 'b', 30);
  await upload(wire, [...completedProject(), ...completedPractice(), ...cases,
    { id: 'life-40', day: 10, npc: 'leah', kind: 'activity.completed', activity: 'forest_walk', minutes: 30, friendship: 0 },
    { id: 'life-41', day: 10, npc: 'leah', kind: 'romance.planned', dateId: 'date-41', dateDay: 10, time: 1000,
      venue: 'Forest', preparation: 'quiet', relation: 'dating', initiator: 'player' }]);
  const saved = await sleep(wire, 'case-mixed-saved', 10);
  const leah = records(h.directory, saved.commitId, 'leah').flatMap(entry => entry.changes).find(change => change.log?.goalResultState)!;
  for (const key of ['lifeState', 'romanceState', 'longGoalState', 'goalResultState']) assert.ok(leah.log?.[key]);
  const caroline = records(h.directory, saved.commitId, 'caroline').flatMap(entry => entry.changes).find(change => change.log?.storyState)!;
  assert.equal(caroline.state, undefined); assert.ok(caroline.log?.storyState); assert.equal(storyEvents(h.directory, saved.commitId, 'caroline').length, 6);
});

test('cross-day comparison binds the saved first site after restart and allows identical weather', { timeout: 20000 }, async t => {
  const h = await harness(t); let server = await h.start(), wire = await connect(server, initial('case-days', 10));
  const history = caseHistory('evelyn_blank_record');
  history[4]!.weather = history[3]!.weather!;
  await upload(wire, history.slice(0, 4)); const first = await sleep(wire, 'case-day-first', 10);
  await wire.close(); await h.stop(server); server = await h.start();
  wire = await connect(server, initial('case-days-restored', 11, first));
  await rejected(wire, [{ ...history[4]!, sourceId: history[1]!.id }]);
  await rejected(wire, [{ ...history[4]!, day: 10 }]);
  await upload(wire, history); const second = await sleep(wire, 'case-day-second', 11, first.commitId);
  const events = storyEvents(h.directory, second.commitId, 'evelyn'); assert.equal(events.length, 2);
  assert.equal(events[0]!.sourceId, history[3]!.id); assert.equal(events[0]!.weather, 'sunny');
  assert.equal(events[1]!.kind, 'story.resolved');
});

test('same-person observation rejects a swapped NPC, wrong distance, closed time window and indoor weather', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('case-person', 10));
  const history = caseHistory('marnie_two_contexts'); await upload(wire, history.slice(0, 3));
  for (const patch of [{ subject: 'shane' }, { subjectX: 50 }, { time: 1700 }, { weather: 'sunny' }])
    await rejected(wire, [{ ...history[3]!, ...patch } as StoryEvent]);
  await upload(wire, history.slice(3)); const saved = await sleep(wire, 'case-person-saved', 10);
  assert.equal(storyEvents(h.directory, saved.commitId, 'marnie').length, 6);
  assert.ok(notes(h.directory, saved.commitId).every(note => note.visibility === 'private'));
});

test('sample inspection rejects bars, invented consumption, wrong maps and fields from another evidence mode', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('case-sample', 10));
  const history = caseHistory('clint_sample_labels'); await upload(wire, history.slice(0, 3));
  for (const patch of [{ itemId: '(O)334' }, { count: 0 }, { venue: 'Town' }, { other: 'emily' }, { weather: 'rain' }])
    await rejected(wire, [{ ...history[3]!, ...patch } as StoryEvent]);
  await upload(wire, history.slice(3)); const saved = await sleep(wire, 'case-sample-saved', 10);
  const events = storyEvents(h.directory, saved.commitId, 'clint').filter(event => event.kind === 'story.inspected');
  assert.deepEqual(events.map(event => [event.itemId, event.count]), [['(O)378', 1], ['(O)380', 1]]);
});

test('partial replay and reconnect preserve exactly one copy for each owner and actual witness', { timeout: 20000 }, async t => {
  const h = await harness(t), server = await h.start(), wire = await connect(server, initial('case-reconnect', 10));
  const history = caseHistory(); const packet = await upload(wire, history.slice(0, 4), false);
  const cursor = wire.cursor(); await wire.close(); const resumed = await connect(server, wire.loaded, cursor);
  const from = resumed.inbox.length; resumed.raw(packet); await resumed.until('ack', from);
  await upload(resumed, history); const saved = await sleep(resumed, 'case-reconnect-saved', 10);
  assert.equal(storyEvents(h.directory, saved.commitId, 'caroline').length, 6);
  assert.equal(storyEvents(h.directory, saved.commitId, 'pierre').length, 1);
  assert.equal(storyEvents(h.directory, saved.commitId, 'jodi').length, 1);
});

test('one person can testify in two investigations without receiving either hidden progress', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('case-shared-witness', 10));
  await upload(wire, [...caseHistory(), ...caseHistory('marnie_two_contexts', 'b', 10)]);
  await prompt(wire, 'Jodi', 10); const known = section(h.fake.sent.at(-1)![0]!.content);
  assert.ok(known.includes(townCaseDefinition('caroline_route_notes')!.title));
  assert.ok(known.includes(townCaseDefinition('marnie_two_contexts')!.title));
  assert.doesNotMatch(known, /已结案|结局为|已经结束|17:10|下雨/);
});

test('unsaved evidence and ending roll back; a sibling branch can select another ending using the same serial', { timeout: 20000 }, async t => {
  const h = await harness(t), server = await h.start(), wire = await connect(server, initial('case-rollback', 10));
  const a = caseHistory(); await upload(wire, a.slice(0, 3)); const first = await sleep(wire, 'case-before-ending', 10);
  await upload(wire, a.slice(3).map(event => ({ ...event, day: 11 })));
  const from = wire.inbox.length; wire.send({ type: 'title.returned' }); await wire.until('ack', from); await wire.close();
  const restored = await connect(server, initial('case-rollback-restored', 11, first));
  await upload(restored, caseHistory('caroline_route_notes', 'b').slice(3).map(event => ({ ...event, day: 11 })));
  const second = await sleep(restored, 'case-new-ending', 11, first.commitId);
  assert.equal(storyEvents(h.directory, second.commitId, 'caroline').at(-1)!.outcome, 'b');
});

test('case serials cannot be changed to old parcel or practice facts across a saved restart', { timeout: 20000 }, async t => {
  const h = await harness(t); let server = await h.start(), wire = await connect(server, initial('case-serial', 10));
  const history = caseHistory(); await upload(wire, history); const first = await sleep(wire, 'case-serial-saved', 10);
  await wire.close(); await h.stop(server); server = await h.start();
  wire = await connect(server, initial('case-serial-restored', 11, first));
  await rejected(wire, [{ ...history[3]!, x: 51 }]);
  await rejected(wire, [{ id: 'life-4', npc: 'gus', day: 10, storyId: 'gus_parcel', kind: 'story.clue', clueId: 'parcel' }]);
  await rejected(wire, [{ id: 'life-4', npc: 'leah', day: 10, projectId: 'leah_form_study', kind: 'goalresult.started', sourceId: 'life-3', choiceId: 'a' }]);
  await upload(wire, []); const second = await sleep(wire, 'case-serial-after', 11, first.commitId);
  assert.equal(storyEvents(h.directory, second.commitId, 'caroline').length, 0);
});

test('new private testimony cannot be published to a valid friend as ordinary activity gossip', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('case-private', 10));
  const history = caseHistory('clint_sample_labels'); await upload(wire, history);
  await rejected(wire, [{ id: 'life-7', npc: 'emily', day: 10, kind: 'social.shared', other: 'sandy', sourceId: history[1]!.id }]);
  await upload(wire, []); const saved = await sleep(wire, 'case-private-saved', 10);
  assert.ok(notes(h.directory, saved.commitId).every(note => note.visibility === 'private'));
});

test('late nightly impressions survive independently saved case progress', { timeout: 25000 }, async t => {
  const h = await harness(t), entered = deferred(), gate = deferred(); t.after(() => gate.resolve());
  const server = await h.start(async input => {
    if (input.commit.dayEnded !== 10) return [];
    entered.resolve(); await gate.promise;
    return input.npcs.map(npc => ({ npcId: npc.npcId, state: { impression: npc.npcId === 'caroline'
      ? '农场主愿意耐心核对我没有写清的起点。' : '农场主认真听了我的证词。' } }));
  });
  const wire = await connect(server, initial('case-nightly', 10)), history = caseHistory();
  await upload(wire, history.slice(0, 3)); await prompt(wire, 'Caroline', 10); await close(wire, 'Caroline');
  const first = await sleep(wire, 'case-nightly-first', 10); await entered.promise;
  await upload(wire, history.slice(3).map(event => ({ ...event, day: 11 })));
  const second = await sleep(wire, 'case-nightly-second', 11, first.commitId); gate.resolve();
  const db = new DatabaseSync(join(h.directory, 'memory.sqlite'), { readOnly: true });
  try {
    const done = () => db.prepare("SELECT state FROM npc_state WHERE commit_id=? AND npc_id='caroline' AND phase='consolidated'").get(first.commitId);
    for (let i = 0; !done() && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(done());
  } finally { db.close(); }
  await wire.close(); const restored = await connect(server, initial('case-nightly-restored', 12, second));
  await upload(restored, []); await prompt(restored, 'Caroline', 12);
  assert.match(h.fake.sent.at(-1)![0]!.content, /耐心核对/); assert.ok(section(h.fake.sent.at(-1)![0]!.content).includes('写丢了起点的路线'));
});
