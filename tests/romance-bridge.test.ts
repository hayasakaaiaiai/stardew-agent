import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LifeEvent } from '../src/agent/life.ts';
import { parseLifeJournal, type LifeJournalEvent } from '../src/agent/life-journal.ts';
import type { RomanceEvent } from '../src/agent/romance.ts';
import { parseModMessage } from '../src/bridge/protocol.ts';
import type { DayEntry } from '../src/types.ts';
import { connect, deferred, harness, initial, openTalk, sleep } from './helpers/bridge.ts';

const plan: RomanceEvent = { id: 'life-1', npc: 'leah', day: 1, kind: 'romance.planned', dateId: 'date-1',
  dateDay: 1, time: 1000, venue: 'Forest', preparation: 'quiet', relation: 'dating', initiator: 'player' };
const start: RomanceEvent = { id: 'life-2', npc: 'leah', day: 1, kind: 'romance.started', dateId: 'date-1',
  relation: 'dating', venue: 'Forest', time: 1000 };
const finish: RomanceEvent = { id: 'life-3', npc: 'leah', day: 1, kind: 'romance.completed', dateId: 'date-1',
  relation: 'dating', venue: 'Forest', weather: 'sunny', minutes: 30, friendship: 0 };
const remember: RomanceEvent = { id: 'life-4', npc: 'leah', day: 1, kind: 'romance.remembered', dateId: 'date-1',
  sourceId: 'life-3', detail: 'company' };
const accepted: LifeEvent = { id: 'life-5', npc: 'leah', day: 1, kind: 'goal.accepted', goal: 'leah-driftwood-v1' };
const sync = (events: LifeJournalEvent[], final = true) => ({ type: 'life.sync', events, final });
type Wire = Awaited<ReturnType<typeof connect>>;
async function upload(wire: Wire, events: LifeJournalEvent[], final = true) {
  const from = wire.inbox.length;
  const packet = wire.send(sync(events, final));
  await wire.until(final ? 'life.ready' : 'ack', from);
  return packet;
}
async function prompt(wire: Wire, day: number, relation: string, npc = 'Leah') {
  const from = wire.inbox.length;
  wire.send({ ...openTalk(day, npc), relation });
  await wire.until('talk.reply', from);
}
async function closeTalk(wire: Wire, npc = 'Leah') {
  const from = wire.inbox.length;
  wire.send({ type: 'talk.close', npc }); await wire.until('ack', from);
}
function logs(directory: string, commit: string, npc = 'leah') {
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

test('the shared journal enforces global serial order across both domains and romantic live snapshots require a partner', () => {
  assert.equal(parseLifeJournal([plan, start, finish, remember, accepted]).length, 5);
  assert.throws(() => parseLifeJournal([accepted, plan]), /increasing serial/);
  assert.throws(() => parseLifeJournal([plan, { ...accepted, id: plan.id }]), /increasing serial/);
  const frame = { lineageId: 'farm-1', loadNonce: 'load-1', seq: 1, ...openTalk(),
    lifeActivity: { activity: 'romantic_date', minutes: 10, count: 0 } };
  for (const relation of ['friend', 'roommate', 'stranger'])
    assert.throws(() => parseModMessage(JSON.stringify({ ...frame, relation })), /romantic relationship/);
  for (const relation of ['dating', 'engaged', 'married'])
    assert.equal(parseModMessage(JSON.stringify({ ...frame, relation })).type, 'talk.open');
});

test('one mixed batch persists both namespaces without writing whole NPC state or invoking the model', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  const hello = wire.inbox.find(message => message.type === 'hello');
  assert.equal(hello?.type === 'hello' && hello.romanceProtocol, 1);
  await upload(wire, [plan, start, finish, remember, accepted]);
  assert.equal(h.fake.sent.length, 0);
  const commit = await sleep(wire, 'romance-mixed');
  const entries = logs(h.directory, commit.commitId);
  const change = entries[0]!.changes.find(item => item.npcId === 'leah')!;
  assert.ok(change.log?.lifeState);
  assert.ok(change.log?.romanceState);
  assert.equal(change.state, undefined);
  assert.ok(memories(h.directory, commit.commitId).every(memory => memory.npc_id === 'leah' && memory.visibility === 'private'));
  await prompt(wire, 2, 'dating');
  assert.match(h.fake.sent.at(-1)![0]!.content, /浮木/);
  assert.match(h.fake.sent.at(-1)![0]!.content, /约会|相伴|相处/);
});

test('a bad romance transition rejects an otherwise valid ordinary life event in the same batch', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  const from = wire.inbox.length;
  wire.send(sync([{ ...accepted, id: 'life-1' }, { ...finish, id: 'life-2' }]));
  await wire.until('sync.error', from);
  await upload(wire, []);
  const commit = await sleep(wire, 'romance-atomic-reject');
  assert.equal(memories(h.directory, commit.commitId).length, 0);
  assert.equal(logs(h.directory, commit.commitId).length, 0);
});

test('romance completion cannot be used as a public friend-sharing source', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  await upload(wire, [plan, start, finish, remember]);
  const from = wire.inbox.length;
  wire.send(sync([{ id: 'life-5', npc: 'leah', day: 1, kind: 'social.shared', sourceId: finish.id, other: 'elliott' }]));
  await wire.until('sync.error', from);
  await upload(wire, []);
  await prompt(wire, 1, 'friend', 'Elliott');
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, /date-1|第 1 天.*约会|我们的约会|两人的回忆/);
  const commit = await sleep(wire, 'romance-private');
  assert.equal(logs(h.directory, commit.commitId, 'elliott').filter(entry => entry.changes.some(change => change.log?.romanceState)).length, 0);
});

test('partial romance replay blocks dialogue and reconnects with the same source only once', { timeout: 15000 }, async t => {
  const h = await harness(t), server = await h.start(), wire = await connect(server);
  const packet = await upload(wire, [plan], false);
  let from = wire.inbox.length;
  wire.send({ ...openTalk(1, 'Leah'), relation: 'dating' }); await wire.until('talk.error', from);
  const cursor = wire.cursor(); await wire.close();
  const resumed = await connect(server, wire.loaded, cursor);
  from = resumed.inbox.length; resumed.raw(packet); await resumed.until('ack', from);
  await upload(resumed, [plan, start, finish, remember]);
  const commit = await sleep(resumed, 'romance-reconnect');
  const events = logs(h.directory, commit.commitId).flatMap(entry => entry.changes.flatMap(change => change.log?.romanceEvents ?? []));
  assert.equal(events.length, 4);
});

test('saved romance replays after backend restart without duplicate memories and keeps source dates', { timeout: 20000 }, async t => {
  const h = await harness(t); let server = await h.start(); let wire = await connect(server);
  await upload(wire, [plan, start, finish, remember]);
  const first = await sleep(wire, 'romance-first');
  const original = memories(h.directory, first.commitId);
  assert.ok(original.some(memory => String(memory.text).includes('第 1 天')));
  await wire.close(); await h.stop(server);
  server = await h.start(); wire = await connect(server, initial('romance-restored', 2, first));
  await upload(wire, [plan, start, finish, remember]);
  await prompt(wire, 2, 'married');
  assert.match(h.fake.sent.at(-1)![0]!.content, /第 1 天/);
  const second = await sleep(wire, 'romance-next', 2, first.commitId);
  assert.equal(logs(h.directory, second.commitId).flatMap(entry => entry.changes.flatMap(change => change.log?.romanceEvents ?? [])).length, 0);
  assert.equal(memories(h.directory, second.commitId).filter(memory => String(memory.text).includes('第 1 天')).length, 0);
});

test('a rolled-back date may reuse its branch serial and a stale load cannot cancel the new branch', { timeout: 20000 }, async t => {
  const h = await harness(t), server = await h.start(), wire = await connect(server);
  const first = await sleep(wire, 'romance-before');
  const secondDay = { ...plan, day: 2, dateDay: 2 };
  await upload(wire, [secondDay]);
  let from = wire.inbox.length;
  wire.send({ type: 'title.returned' }); await wire.until('ack', from); await wire.close();
  const reload = await connect(server, initial('romance-sibling', 2, first));
  await upload(reload, [{ ...secondDay, venue: 'Beach', preparation: 'talk' }]);
  from = reload.inbox.length;
  reload.send({ ...sync([{ id: 'life-2', npc: 'leah', day: 2, kind: 'romance.cancelled', dateId: 'date-1', reason: 'player' }]), loadNonce: wire.loaded.loadNonce });
  await reload.until('sync.error', from);
  await upload(reload, []);
  await prompt(reload, 2, 'dating');
  assert.match(h.fake.sent.at(-1)![0]!.content, /海滩/);
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, /已经.*森林.*30/);
});

test('relationship loss cancels future plans and roommate dialogue has only historical romance cues', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  await upload(wire, [plan, start, finish, remember]);
  const later: RomanceEvent = { ...plan, id: 'life-5', dateId: 'date-5', dateDay: 2, sourceId: finish.id };
  await upload(wire, [later]);
  await upload(wire, [{ id: 'life-6', npc: 'leah', day: 1, kind: 'romance.cancelled', dateId: 'date-5', reason: 'relationship' }]);
  await prompt(wire, 1, 'roommate');
  const text = h.fake.sent.at(-1)![0]!.content;
  assert.match(text, /过去|过往|历史/);
  assert.doesNotMatch(text, /待赴约|待出发|约会计划：.*第 2 天/);
  await closeTalk(wire);
  await prompt(wire, 1, 'friend', 'Penny');
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, /第 1 天.*30.*约会|date-1/);
});

test('romance and ordinary life share one ordered friendship budget and an excessive mixed batch is atomic', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  const ordinary: LifeEvent = { id: 'life-4', npc: 'leah', day: 1, kind: 'activity.completed', activity: 'forest_walk', minutes: 30, friendship: 20 };
  let from = wire.inbox.length;
  wire.send(sync([plan, start, { ...finish, friendship: 20 }, ordinary])); await wire.until('sync.error', from);
  await upload(wire, [plan, start, { ...finish, friendship: 20 }, { ...ordinary, friendship: 10 }]);
  await prompt(wire, 1, 'dating');
  from = wire.inbox.length;
  wire.send({ type: 'talk.say', npc: 'Leah', text: '好感2 今天真开心' });
  const reply = await wire.until('talk.reply', from);
  assert.equal(reply.type === 'talk.reply' && reply.friendship, 0);
  const commit = await sleep(wire, 'romance-budget');
  const native = logs(h.directory, commit.commitId).filter(entry => entry.changes.some(change => change.log?.romanceState));
  assert.equal(native.length, 1);
});

test('late nightly consolidation remains visible after next-day romance has already been saved', { timeout: 20000 }, async t => {
  const h = await harness(t), entered = deferred(), gate = deferred();
  t.after(() => gate.resolve());
  const server = await h.start(async input => {
    if (input.commit.dayEnded !== 1) return [];
    entered.resolve(); await gate.promise;
    return [{ npcId: 'leah', state: { impression: '我欣赏农场主认真倾听的样子。' } }];
  });
  const wire = await connect(server);
  await prompt(wire, 1, 'dating'); await closeTalk(wire);
  const first = await sleep(wire, 'romance-night-before'); await entered.promise;
  await upload(wire, [{ ...plan, day: 2, dateDay: 2 }, { ...start, day: 2 }, { ...finish, day: 2 }, { ...remember, day: 2 }]);
  const second = await sleep(wire, 'romance-night-after', 2, first.commitId);
  gate.resolve();
  const db = new DatabaseSync(join(h.directory, 'memory.sqlite'), { readOnly: true });
  try {
    const done = () => db.prepare("SELECT state FROM npc_state WHERE commit_id=? AND npc_id='leah' AND phase='consolidated'").get(first.commitId);
    for (let i = 0; !done() && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(done());
  } finally { db.close(); }
  await prompt(wire, 3, 'dating');
  assert.match(h.fake.sent.at(-1)![0]!.content, /我欣赏农场主认真倾听的样子/);
  assert.match(h.fake.sent.at(-1)![0]!.content, /第 2 天/);
  await wire.close();
  const reload = await connect(server, initial('romance-night-restored', 3, second));
  await upload(reload, [{ ...plan, day: 2, dateDay: 2 }, { ...start, day: 2 }, { ...finish, day: 2 }, { ...remember, day: 2 }]);
  await prompt(reload, 3, 'dating');
  assert.match(h.fake.sent.at(-1)![0]!.content, /我欣赏农场主认真倾听的样子/);
});
