import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LifeJournalEvent } from '../src/agent/life-journal.ts';
import type { GoalResultEvent } from '../src/agent/goal-results.ts';
import type { DayEntry } from '../src/types.ts';
import { connect, deferred, harness, initial, openTalk, sleep } from './helpers/bridge.ts';
import { completedPractice, completedProject, reviewPractice } from './helpers/project-practice.ts';

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
function resultEvents(directory: string, commit: string, npc = 'leah') {
  return records(directory, commit, npc).flatMap(entry => entry.changes.flatMap(change => change.log?.goalResultEvents ?? [])) as unknown as GoalResultEvent[];
}
const section = (text: string) => {
  const start = text.indexOf('## 成果实践');
  return start < 0 ? '' : text.slice(start).split('\n## ').slice(0, 1).join('');
};

test('practice capability extends every previous protocol without changing protocol 3', async t => {
  const h = await harness(t), wire = await connect(await h.start());
  const hello = wire.inbox.find(message => message.type === 'hello'); assert.ok(hello?.type === 'hello');
  assert.equal(hello.resultsProtocol, 1); assert.equal(hello.goalsProtocol, 1);
  assert.equal(hello.storiesProtocol, 1); assert.equal(hello.romanceProtocol, 1); assert.equal(hello.lifeProtocol, 1);
});

test('a real collection and its practice can share an atomic sync while preserving separate projections', { timeout: 20000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('result-one-batch', 10));
  const practice = completedPractice();
  await upload(wire, [...completedProject(), ...practice,
    { id: 'life-25', day: 10, npc: 'leah', kind: 'activity.completed', activity: 'forest_walk', minutes: 30, friendship: 0 }]);
  await prompt(wire, 'Leah', 10); assert.ok(section(h.fake.sent.at(-1)![0]!.content));
  await close(wire, 'Leah');
  const saved = await sleep(wire, 'result-atomic-saved', 10);
  const changes = records(h.directory, saved.commitId, 'leah').flatMap(entry => entry.changes);
  const projected = changes.find(change => change.log?.goalResultState)!;
  assert.ok(projected.log?.longGoalState); assert.ok(projected.log?.lifeState); assert.equal(projected.state, undefined);
  assert.equal(resultEvents(h.directory, saved.commitId).length, practice.length);
  assert.ok(notes(h.directory, saved.commitId).filter(note => /实践/.test(String(note.text))).every(note => note.visibility === 'private'));
});

test('an incomplete route rejects its whole batch without accepting project or ordinary life progress', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('result-atomic-reject', 10));
  const practice = completedPractice();
  await rejected(wire, [...completedProject(), practice[0]!, { ...practice.at(-1)!, sourceId: practice[0]!.id },
    { id: 'life-25', day: 10, npc: 'leah', kind: 'activity.completed', activity: 'forest_walk', minutes: 30, friendship: 0 }]);
  await upload(wire, []); const saved = await sleep(wire, 'result-atomic-empty', 10);
  assert.equal(records(h.directory, saved.commitId, 'leah').length, 0);
  assert.equal(notes(h.directory, saved.commitId).length, 0);
});

test('notifications record only an actual chapter and never become a shared-practice memory', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('result-notice', 10));
  await upload(wire, completedProject());
  const notice: GoalResultEvent = { id: 'life-20', day: 10, npc: 'leah', projectId: 'leah_form_study',
    kind: 'goalresult.notified', chapterId: 3, sourceId: 'life-19' };
  await upload(wire, [notice]); await upload(wire, [notice]);
  const saved = await sleep(wire, 'result-notice-saved', 10);
  const change = records(h.directory, saved.commitId, 'leah').flatMap(entry => entry.changes)
    .find(entry => entry.log?.goalResultEvents)!;
  assert.equal(change.memories?.length ?? 0, 0);
  assert.equal(resultEvents(h.directory, saved.commitId).length, 1);
});

test('the global daily reminder limit survives another owner and backend restart', { timeout: 20000 }, async t => {
  const h = await harness(t); let server = await h.start(), wire = await connect(server, initial('result-notice-limit', 10));
  await upload(wire, [...completedProject(), { id: 'life-20', day: 10, npc: 'leah', projectId: 'leah_form_study',
    kind: 'goalresult.notified', chapterId: 3, sourceId: 'life-19' }]);
  const maru = completedProject('maru_field_holder').map(event => ({ ...event, id: `life-${100 + Number(event.id.slice(5))}` }));
  await upload(wire, maru);
  const notice: GoalResultEvent = { id: 'life-120', day: 10, npc: 'maru', projectId: 'maru_field_holder',
    kind: 'goalresult.notified', chapterId: 3, sourceId: 'life-119' };
  await rejected(wire, [notice]); await upload(wire, []);
  const first = await sleep(wire, 'result-notice-limit-first', 10);
  await wire.close(); await h.stop(server); server = await h.start();
  wire = await connect(server, initial('result-notice-limit-restored', 11, first));
  await rejected(wire, [notice]); await upload(wire, [{ ...notice, day: 11 }]);
  const second = await sleep(wire, 'result-notice-limit-second', 11, first.commitId);
  assert.equal(resultEvents(h.directory, second.commitId, 'maru').length, 1);
});

test('finished evidence survives restart and a next-day review without reaching another NPC', { timeout: 25000 }, async t => {
  const h = await harness(t); let server = await h.start(), wire = await connect(server, initial('result-save', 10));
  const practice = completedPractice('willy_shore_guide');
  await upload(wire, [...completedProject('willy_shore_guide'), ...practice]);
  const first = await sleep(wire, 'result-save-first', 10);
  await wire.close(); await h.stop(server); server = await h.start();
  wire = await connect(server, initial('result-restart', 11, first));
  await upload(wire, [...completedProject('willy_shore_guide'), ...practice, reviewPractice(practice, 'b')]);
  await prompt(wire, 'Willy', 11); assert.ok(section(h.fake.sent.at(-1)![0]!.content)); await close(wire, 'Willy');
  await prompt(wire, 'Maru', 11); assert.equal(section(h.fake.sent.at(-1)![0]!.content), ''); await close(wire, 'Maru');
  const second = await sleep(wire, 'result-save-second', 11, first.commitId);
  const events = resultEvents(h.directory, second.commitId, 'willy');
  assert.equal(events.length, 1); assert.equal(events[0]!.kind, 'goalresult.reviewed');
  assert.equal(events[0]!.sourceId, practice.at(-1)!.id); assert.equal(events[0]!.choiceId, 'b');
});

test('same-day review and another project source cannot unlock a result', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('result-source', 10));
  const practice = completedPractice();
  await upload(wire, [...completedProject(), ...practice]);
  await rejected(wire, [reviewPractice(practice, 'a', 10)]);
  await rejected(wire, [{ id: 'life-25', day: 10, npc: 'maru', projectId: 'maru_field_holder', kind: 'goalresult.started', sourceId: 'life-19', choiceId: 'a' }]);
  await upload(wire, []); const saved = await sleep(wire, 'result-source-saved', 10);
  assert.equal(resultEvents(h.directory, saved.commitId).length, practice.length);
  assert.equal(records(h.directory, saved.commitId, 'maru').length, 0);
});

test('partial replay and reconnect do not duplicate checkpoints or completion memories', { timeout: 20000 }, async t => {
  const h = await harness(t), server = await h.start(), wire = await connect(server, initial('result-reconnect', 10));
  const practice = completedPractice();
  const packet = await upload(wire, [...completedProject(), ...practice.slice(0, 2)], false);
  const cursor = wire.cursor(); await wire.close();
  const resumed = await connect(server, wire.loaded, cursor);
  const from = resumed.inbox.length; resumed.raw(packet); await resumed.until('ack', from);
  await upload(resumed, [...completedProject(), ...practice]);
  const saved = await sleep(resumed, 'result-reconnect-saved', 10);
  const events = resultEvents(h.directory, saved.commitId);
  assert.equal(events.length, practice.length); assert.equal(new Set(events.map(event => event.id)).size, practice.length);
});

test('cancelled checkpoints cannot complete a new attempt and old cancelled replays stay idempotent', { timeout: 20000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('result-retry', 10));
  const first = completedPractice().slice(0, 2);
  const cancelled: GoalResultEvent = { id: 'life-22', npc: 'leah', day: 10, projectId: 'leah_form_study',
    kind: 'goalresult.cancelled', attemptId: 'life-20', reason: 'player' };
  await upload(wire, [...completedProject(), ...first, cancelled]);
  const second = completedPractice('leah_form_study', 'b', 10, 23);
  await upload(wire, [second[0]!]);
  await rejected(wire, [{ ...second.at(-1)!, sourceId: first[1]!.id }]);
  await upload(wire, [...first, cancelled, ...second]);
  const saved = await sleep(wire, 'result-retry-saved', 10);
  assert.equal(resultEvents(h.directory, saved.commitId).length, first.length + 1 + second.length);
});

test('saved result serials cannot become ordinary events or rewritten discarded attempts', { timeout: 20000 }, async t => {
  const h = await harness(t); let server = await h.start(), wire = await connect(server, initial('result-serial', 10));
  const practice = completedPractice(); await upload(wire, [...completedProject(), ...practice]);
  const saved = await sleep(wire, 'result-serial-saved', 10);
  await wire.close(); await h.stop(server); server = await h.start();
  wire = await connect(server, initial('result-serial-restart', 11, saved));
  await rejected(wire, [{ id: 'life-20', day: 10, npc: 'leah', kind: 'activity.completed', activity: 'forest_walk', minutes: 30, friendship: 0 }]);
  await rejected(wire, [{ ...practice[1]!, x: 40 }]);
  await upload(wire, []); const second = await sleep(wire, 'result-serial-next', 11, saved.commitId);
  assert.equal(resultEvents(h.directory, second.commitId).length, 0);
});

test('an unsaved completion rolls back and a sibling branch can reuse the actual choices and serials', { timeout: 20000 }, async t => {
  const h = await harness(t), server = await h.start(), wire = await connect(server, initial('result-rollback', 10));
  await upload(wire, completedProject()); const first = await sleep(wire, 'result-before', 10);
  await upload(wire, completedPractice('leah_form_study', 'a', 11));
  const from = wire.inbox.length; wire.send({ type: 'title.returned' }); await wire.until('ack', from); await wire.close();
  const restored = await connect(server, initial('result-sibling', 11, first));
  await upload(restored, completedPractice('leah_form_study', 'b', 11));
  const second = await sleep(restored, 'result-after', 11, first.commitId);
  const events = resultEvents(h.directory, second.commitId);
  assert.equal(events.find(event => event.kind === 'goalresult.completed')!.choiceId, 'b');
  assert.equal(events.filter(event => event.kind === 'goalresult.started').length, 1);
});

test('practice results cannot be published as ordinary friend gossip', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('result-private', 10));
  const practice = completedPractice(); await upload(wire, [...completedProject(), ...practice]);
  await rejected(wire, [{ id: 'life-25', day: 10, npc: 'leah', kind: 'social.shared', other: 'elliott', sourceId: practice.at(-1)!.id }]);
  await upload(wire, []); await prompt(wire, 'Elliott', 10);
  assert.equal(section(h.fake.sent.at(-1)![0]!.content), '');
});

test('late nightly impression updates remain intact when a result is saved later', { timeout: 25000 }, async t => {
  const h = await harness(t), entered = deferred(), gate = deferred(); t.after(() => gate.resolve());
  const server = await h.start(async input => {
    if (input.commit.dayEnded !== 10) return [];
    entered.resolve(); await gate.promise;
    return [{ npcId: 'leah', state: { impression: '我愿意和农场主比较不同角度的感受。' } }];
  });
  const wire = await connect(server, initial('result-night', 10));
  await upload(wire, completedProject()); await prompt(wire, 'Leah', 10); await close(wire, 'Leah');
  const first = await sleep(wire, 'result-night-first', 10); await entered.promise;
  await upload(wire, completedPractice('leah_form_study', 'a', 11));
  const second = await sleep(wire, 'result-night-second', 11, first.commitId); gate.resolve();
  const db = new DatabaseSync(join(h.directory, 'memory.sqlite'), { readOnly: true });
  try {
    const done = () => db.prepare("SELECT state FROM npc_state WHERE commit_id=? AND npc_id='leah' AND phase='consolidated'").get(first.commitId);
    for (let i = 0; !done() && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(done());
  } finally { db.close(); }
  await wire.close(); const restored = await connect(server, initial('result-night-restored', 12, second));
  await upload(restored, []); await prompt(restored, 'Leah', 12);
  assert.match(h.fake.sent.at(-1)![0]!.content, /比较不同角度的感受/);
  assert.ok(section(h.fake.sent.at(-1)![0]!.content));
});
