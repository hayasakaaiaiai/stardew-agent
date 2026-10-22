import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { digest } from '../src/validation.ts';
import { connect, harness, initial, openTalk, sleep, WORLD } from './helpers/bridge.ts';

const DANCED = '花舞节上农场主邀请我跳舞，我们一起跳了。';
const SAW_DANCE = '花舞节上我看到农场主和阿比盖尔跳了舞。';
const SOUP = '夏威夷宴会上我看到州长喝了汤，夸汤很好喝。';
const festival = (extra: Record<string, unknown> = {}) => ({ type: 'festival.ended', festival: 'spring24',
  npcs: ['Abigail', 'Sebastian', 'Lewis'], dance: 'Abigail', santa: null, contest: null, grange: null, soup: null,
  date: { ...WORLD.date, time: 2200 }, ...extra });

test('festival receipts survive a killed backend even when the checkpoint is behind the durable day journal', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stardew-festival-recovery-'));
  const children: ChildProcess[] = [];
  const start = async () => {
    const child = fork(resolve(import.meta.dirname, 'fixtures/cleanup-backend.ts'), [directory],
      { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    children.push(child);
    const ready = await Promise.race([
      once(child, 'message').then(([value]) => value as { port: number }),
      once(child, 'exit').then(([code]) => { throw new Error(`Festival fixture exited: ${code}`); }),
    ]);
    return { child, port: ready.port };
  };
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const first = await start();
  const loaded = initial('festival-crash');
  const wire = await connect(first, loaded);
  const checkpoint = join(directory, 'bridge', digest(loaded.lineageId), digest(loaded.loadNonce) + '.json');
  const before = await readFile(checkpoint, 'utf8');
  const sent = wire.send(festival()); await wire.until('ack');
  const exited = once(first.child, 'exit'); first.child.kill('SIGKILL'); await exited;
  // Model a crash after the day journal fsync but before its matching checkpoint replacement.
  await writeFile(checkpoint, before);
  const journalPath = join(directory, 'scratch', digest(loaded.lineageId), digest(loaded.loadNonce) + '.jsonl');
  const journal = await readFile(journalPath, 'utf8');
  const rows = journal.trimEnd().split('\n').slice(1).map(line => JSON.parse(line) as { changes: { npcId: string }[] });
  assert.equal(rows.length, 1, 'the entire festival is one atomic day event');
  assert.deepEqual(rows[0]!.changes.map(change => change.npcId).sort(), ['abigail', 'lewis', 'sebastian']);
  const resumed = await connect(await start(), loaded, wire.cursor());
  const from = resumed.inbox.length;
  resumed.raw(sent); await resumed.until('ack', from);
  assert.equal(await readFile(journalPath, 'utf8'), journal, 'replay after process loss must not duplicate any NPC note');
  resumed.send(openTalk()); await resumed.until('talk.reply');
  assert.ok(!resumed.inbox.some(message => message.type === 'sync.error'));
  const commit = await sleep(resumed, 'festival-crash-saved');
  assert.equal(commit.dayEnded, 1, 'the recovered festival must still allow saving');
  await resumed.close();
});

test('an altered festival replay is rejected without replacing any of the original witnesses', { timeout: 10000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  const sent = wire.send(festival()); await wire.until('ack');
  let from = wire.inbox.length;
  wire.raw({ ...sent, dance: 'Sebastian' });
  const error = await wire.until('sync.error', from);
  assert.equal(error.type, 'sync.error');
  if (error.type === 'sync.error') assert.match(error.message, /同一个序号/);
  from = wire.inbox.length; wire.raw(sent); await wire.until('ack', from);
  wire.send(openTalk()); await wire.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, new RegExp(DANCED));
  assert.equal(h.logs.filter(line => line.startsWith('节日：')).length, 3);
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack');
  wire.send(openTalk(1, 'Sebastian')); await wire.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, new RegExp(SAW_DANCE));
});

test('saved festival witnesses survive restart and a sibling save never inherits a future festival', { timeout: 15000 }, async t => {
  const h = await harness(t), first = await h.start(), wire = await connect(first);
  wire.send(festival()); await wire.until('ack');
  const danceSave = await sleep(wire, 'dance-save');
  wire.send(festival({ festival: 'summer11', dance: null, soup: 3, date: { ...WORLD.date, day: 2, time: 2200 } }));
  await wire.until('ack');
  await sleep(wire, 'future-soup-save', 2, danceSave.commitId);
  await wire.close(); await h.stop(first);
  const server = await h.start();
  const sibling = await connect(server, initial('sibling-branch', 2, danceSave));
  for (const [npc, wanted] of [['Abigail', DANCED], ['Sebastian', SAW_DANCE], ['Lewis', SAW_DANCE]]) {
    const from = sibling.inbox.length;
    sibling.send(openTalk(2, npc)); await sibling.until('talk.reply', from);
    const prompt = h.fake.sent.at(-1)![0]!.content;
    assert.equal(prompt.split(wanted!).length - 1, 1, `${npc}: saved festival appears exactly once`);
    assert.doesNotMatch(prompt, /州长喝了汤|夏威夷宴会/, `${npc}: no memory from the future branch`);
    sibling.send({ type: 'talk.close', npc }); await sibling.until('ack');
  }
  const newSave = await sleep(sibling, 'sibling-save', 2, danceSave.commitId);
  await sibling.close();
  const reloaded = await connect(server, initial('sibling-reloaded', 3, newSave));
  reloaded.send(openTalk(3, 'Sebastian')); await reloaded.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, new RegExp(SAW_DANCE));
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, /夏威夷宴会/);
});

test('a late festival during save preparation is acknowledged without changing the frozen day', { timeout: 10000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  wire.send(festival()); await wire.until('ack');
  const commit = { commitId: 'frozen-festival', parentId: null, dayEnded: 1 };
  wire.send({ type: 'save.saving', commit }); await wire.until('ack');
  const late = wire.send(festival({ festival: 'summer11', dance: null, soup: 3 })); await wire.until('ack');
  const from = wire.inbox.length; wire.raw(late); await wire.until('ack', from);
  wire.send({ type: 'save.saved', commitId: commit.commitId, date: { ...WORLD.date, day: 2 } }); await wire.until('ack');
  wire.send({ type: 'day.started', date: { ...WORLD.date, day: 2 }, weather: 'sunny' }); await wire.until('ack');
  wire.send(openTalk(2)); await wire.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, new RegExp(DANCED));
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, /夏威夷宴会/);
  assert.ok(!wire.inbox.some(message => message.type === 'sync.error'));
});

test('a new load rejects the previous festival packet and discards all its unsaved witnesses', { timeout: 10000 }, async t => {
  const h = await harness(t), server = await h.start(), wire = await connect(server);
  const stale = wire.send(festival()); await wire.until('ack');
  await wire.close();
  const next = await connect(server, initial('rollback-festival'));
  const from = next.inbox.length; next.raw(stale); await next.until('sync.error', from);
  next.send(openTalk()); await next.until('talk.reply');
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, /花舞节/);
  next.send({ type: 'talk.close', npc: 'Abigail' }); await next.until('ack');
  next.send(festival({ festival: 'summer11', dance: null, soup: 3 })); await next.until('ack');
  next.send(openTalk()); await next.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, new RegExp(SOUP));
});

test('mixed-case duplicate witnesses create only one memory each across reconnects', { timeout: 10000 }, async t => {
  const h = await harness(t), server = await h.start(), wire = await connect(server);
  const packet = wire.send(festival({ npcs: ['Abigail', 'ABIGAIL', 'abigail', 'Sebastian', 'SEBASTIAN', 'Gunther'] }));
  await wire.until('ack');
  const cursor = wire.cursor(); await wire.close();
  const reconnected = await connect(server, wire.loaded, cursor);
  const from = reconnected.inbox.length; reconnected.raw(packet); await reconnected.until('ack', from);
  assert.equal(h.logs.filter(line => line.startsWith('节日：')).length, 2);
  for (const [npc, note] of [['Abigail', DANCED], ['Sebastian', SAW_DANCE]]) {
    reconnected.send(openTalk(1, npc)); await reconnected.until('talk.reply');
    assert.equal(h.fake.sent.at(-1)![0]!.content.split(note!).length - 1, 1);
    reconnected.send({ type: 'talk.close', npc }); await reconnected.until('ack');
  }
});
