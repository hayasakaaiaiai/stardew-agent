import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { parseModMessage, gameMinutes, absoluteDay } from '../src/bridge/protocol.ts';
import { digest } from '../src/validation.ts';
import { connect, deferred, harness, initial, openTalk, sleep, WORLD } from './helpers/bridge.ts';

test('game dialogue remembers saved facts across days and removes raw conversation from the next day', { timeout: 10000 }, async t => {
  const h = await harness(t); const wire = await connect(await h.start());
  wire.send(openTalk()); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住最喜欢紫水晶' }); await wire.until('talk.reply');
  await sleep(wire);
  wire.send(openTalk(2)); await wire.until('talk.reply');
  const prompt = h.fake.sent.at(-1)!;
  assert.match(prompt[0]!.content, /最喜欢紫水晶/);
  assert.match(prompt[0]!.content, /昨天/);
  assert.deepEqual(prompt.slice(1).map(item => item.role), ['user']);
});

test('returning to title discards unsaved facts but retains the last saved memory', { timeout: 10000 }, async t => {
  const h = await harness(t); const server = await h.start(); const wire = await connect(server);
  wire.send(openTalk()); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住存档前的紫水晶' }); await wire.until('talk.reply');
  const commit = await sleep(wire);
  wire.send(openTalk(2)); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住不保存的南瓜约定', date: { ...WORLD.date, day: 2 } }); await wire.until('talk.reply');
  wire.send({ type: 'title.returned' }); await wire.until('ack'); await wire.close();
  const reload = await connect(server, initial('load-2', 2, commit));
  reload.send(openTalk(2)); await reload.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, /存档前的紫水晶/);
  assert.doesNotMatch(JSON.stringify(h.fake.sent.at(-1)), /不保存的南瓜约定/);
});

test('reopening an older game save branches without recalling an abandoned future', { timeout: 10000 }, async t => {
  const h = await harness(t); const server = await h.start(); const wire = await connect(server);
  wire.send(openTalk()); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住第一天的旧约定' }); await wire.until('talk.reply');
  const old = await sleep(wire);
  wire.send(openTalk(2)); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住已经放弃的未来', date: { ...WORLD.date, day: 2 } }); await wire.until('talk.reply');
  await sleep(wire, 'future', 2, old.commitId);
  wire.send({ type: 'title.returned' }); await wire.until('ack'); await wire.close();
  const branch = await connect(server, initial('old-save', 2, old));
  branch.send(openTalk(2)); await branch.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, /第一天的旧约定/);
  assert.doesNotMatch(JSON.stringify(h.fake.sent.at(-1)), /已经放弃的未来/);
  await sleep(branch, 'branch', 2, old.commitId);
});

test('a socket reconnect keeps the same load and current day conversation', { timeout: 10000 }, async t => {
  const h = await harness(t); const server = await h.start(); const wire = await connect(server);
  wire.send(openTalk()); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住今天在杂货店见面' }); await wire.until('talk.reply');
  await wire.close();
  const again = await connect(server, wire.loaded, wire.cursor());
  again.send(openTalk()); await again.until('talk.reply');
  assert.match(JSON.stringify(h.fake.sent.at(-1)), /今天在杂货店见面/);
  assert.ok(h.fake.sent.at(-1)!.some(item => item.role === 'assistant'));
});

test('backend restart restores the latest acknowledged day rather than the original handshake day', { timeout: 10000 }, async t => {
  const h = await harness(t); const first = await h.start(); const wire = await connect(first);
  wire.send(openTalk()); await wire.until('talk.reply'); await sleep(wire);
  wire.send(openTalk(2)); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住重启之前的咖啡', date: { ...WORLD.date, day: 2 } }); await wire.until('talk.reply');
  await h.stop(first);
  const again = await connect(await h.start(), wire.loaded, wire.cursor());
  again.send(openTalk(2)); await again.until('talk.reply');
  assert.match(JSON.stringify(h.fake.sent.at(-1)), /重启之前的咖啡/);
});

test('a SIGKILLed backend restores acknowledged game memory with the same nonce', { timeout: 12000 }, async t => {
  const h = await harness(t);
  const child = fork(new URL('./fixtures/game-bridge.ts', import.meta.url), [h.directory], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const info = await new Promise<{ port: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child failed to start: ${stderr}`)), 4000);
    child.once('message', value => { clearTimeout(timer); resolve(value as { port: number }); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const wire = await connect(info);
  wire.send(openTalk()); await wire.until('talk.reply'); await sleep(wire);
  wire.send(openTalk(2)); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住强制终止前的萤火虫', date: { ...WORLD.date, day: 2 } }); await wire.until('talk.reply');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const again = await connect(await h.start(), wire.loaded, wire.cursor());
  again.send(openTalk(2)); await again.until('talk.reply');
  assert.match(JSON.stringify(h.fake.sent.at(-1)), /强制终止前的萤火虫/);
});

for (const confirmed of [false, true]) test(`confirming checkpoint recovers when the SQL commit is ${confirmed ? 'already confirmed' : 'still prepared'}`, { timeout: 10000 }, async t => {
  const h = await harness(t); const first = await h.start(); const wire = await connect(first);
  wire.send(openTalk()); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住确认窗口里的樱桃' }); await wire.until('talk.reply');
  const commit = { commitId: 'crash-confirm', parentId: null, dayEnded: 1 };
  wire.send({ type: 'save.saving', commit }); await wire.until('ack');
  const path = join(h.directory, 'bridge', digest('farm-1'), `${digest('load-1')}.json`);
  // This is the last durable intent before confirm(); leave SQLite on either side of that operation.
  const intent = JSON.parse(await readFile(path, 'utf8')); intent.phase = 'confirming'; intent.nextDay = 2;
  const saved = { type: 'save.saved', commitId: commit.commitId, date: { ...WORLD.date, day: 2 }, seq: wire.cursor() + 1 };
  if (confirmed) { wire.send(saved); await wire.until('ack'); }
  await h.stop(first); await writeFile(path, JSON.stringify(intent));
  const again = await connect(await h.start(), wire.loaded, wire.cursor());
  again.send(saved); await again.until('ack');
  again.send(openTalk(2)); await again.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, /确认窗口里的樱桃/);
});

test('a title-return intent can be acknowledged after a crash before its acknowledgement checkpoint', { timeout: 10000 }, async t => {
  const h = await harness(t); const first = await h.start(); const wire = await connect(first);
  const title = wire.send({ type: 'title.returned' }); await wire.until('ack'); await h.stop(first);
  const path = join(h.directory, 'bridge', digest('farm-1'), `${digest('load-1')}.json`);
  const intent = JSON.parse(await readFile(path, 'utf8')); intent.receipts = []; intent.lastSeq = 0;
  await writeFile(path, JSON.stringify(intent));
  const again = await connect(await h.start(), wire.loaded, wire.cursor());
  again.send(title); assert.equal((await again.until('ack')).type, 'ack');
});

test('duplicate dialogue requests reuse their durable result and conflicting sequences are rejected', { timeout: 10000 }, async t => {
  const h = await harness(t); const wire = await connect(await h.start());
  const request = wire.send(openTalk()); const first = await wire.until('talk.reply');
  wire.send(request); assert.deepEqual(await wire.until('talk.reply'), first);
  assert.equal(h.fake.sent.length, 1);
  wire.send({ ...request, hearts: 9 });
  assert.match(JSON.stringify(await wire.until('talk.error')), /同一个序号/);
  assert.equal(h.fake.sent.length, 1);
});

test('a durable dialogue receipt recovers if the process stopped before checkpoint replacement', { timeout: 10000 }, async t => {
  const h = await harness(t); const first = await h.start(); const wire = await connect(first);
  const request = wire.send(openTalk()); const reply = await wire.until('talk.reply'); await h.stop(first);
  const path = join(h.directory, 'bridge', digest('farm-1'), `${digest('load-1')}.json`);
  const checkpoint = JSON.parse(await readFile(path, 'utf8'));
  checkpoint.lastSeq = 0; checkpoint.receipts = [];
  await writeFile(path, JSON.stringify(checkpoint));
  const again = await connect(await h.start(), wire.loaded, wire.cursor());
  again.send(request); assert.deepEqual(await again.until('talk.reply'), reply);
  assert.equal(h.fake.sent.length, 1);
});

test('prepared saves survive backend restart and repeated lifecycle events are idempotent', { timeout: 10000 }, async t => {
  const h = await harness(t); const first = await h.start(); const wire = await connect(first);
  wire.send(openTalk()); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住准备保存的苹果' }); await wire.until('talk.reply');
  const commit = { commitId: 'prepared', parentId: null, dayEnded: 1 };
  const prepare = wire.send({ type: 'save.saving', commit }); await wire.until('ack');
  await h.stop(first);
  const again = await connect(await h.start(), wire.loaded, wire.cursor());
  again.send(prepare); await again.until('ack');
  const saved = again.send({ type: 'save.saved', commitId: commit.commitId, date: { ...WORLD.date, day: 2 } }); await again.until('ack');
  again.send(saved); await again.until('ack');
  again.send(openTalk(2)); await again.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, /准备保存的苹果/);
});

test('loading an actual game pointer confirms a prepared commit when Saved was lost', { timeout: 10000 }, async t => {
  const h = await harness(t); const first = await h.start(); const wire = await connect(first);
  wire.send(openTalk()); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住已经写进游戏存档的草莓' }); await wire.until('talk.reply');
  const commit = { commitId: 'lost-saved', parentId: null, dayEnded: 1 };
  wire.send({ type: 'save.saving', commit }); await wire.until('ack'); await h.stop(first);
  const again = await connect(await h.start(), initial('new-game-load', 2, commit));
  again.send(openTalk(2)); await again.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, /已经写进游戏存档的草莓/);
});

test('replayed offline lifecycle events keep their order and do not block game saving', { timeout: 10000 }, async t => {
  const h = await harness(t); const server = await h.start(); const wire = await connect(server);
  wire.send(openTalk()); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住断线前的向日葵' }); await wire.until('talk.reply');
  await wire.close();
  const again = await connect(server, wire.loaded, wire.cursor());
  const from = again.inbox.length;
  again.send({ type: 'save.saving', commit: { commitId: 'offline-save', parentId: null, dayEnded: 1 } });
  again.send({ type: 'save.saved', commitId: 'offline-save', date: { ...WORLD.date, day: 2 } });
  again.send({ type: 'day.started', date: { ...WORLD.date, day: 2 }, weather: 'sunny' });
  again.send(openTalk(2)); await again.until('talk.reply');
  assert.equal(again.inbox.slice(from).filter(item => item.type === 'ack').length, 3);
  assert.match(h.fake.sent.at(-1)![0]!.content, /断线前的向日葵/);
});

test('a repeated acknowledged lifecycle event cannot cancel a newer conversation', { timeout: 10000 }, async t => {
  const h = await harness(t); const wire = await connect(await h.start());
  const started = wire.send({ type: 'day.started', date: WORLD.date, weather: 'sunny' }); await wire.until('ack');
  const entered = deferred(); const release = deferred();
  h.fake.hold(async () => { entered.resolve(); await release.promise; });
  wire.send(openTalk()); await entered.promise;
  wire.send(started); await wire.until('ack');
  release.resolve(); await wire.until('talk.reply');
  assert.equal(h.fake.sent.length, 1);
});

test('cancelling a delayed model request cannot write or display it in the next conversation', { timeout: 10000 }, async t => {
  const h = await harness(t); const wire = await connect(await h.start());
  const entered = deferred(); const release = deferred();
  h.fake.hold(async () => { entered.resolve(); await release.promise; });
  const old = wire.send(openTalk()); await entered.promise;
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack');
  h.fake.hold(); release.resolve();
  wire.send(openTalk()); await wire.until('talk.reply');
  assert.equal(wire.inbox.filter(item => item.type === 'talk.reply' && item.seq === old.seq).length, 0);
  assert.deepEqual(h.fake.sent.at(-1)!.slice(1).map(item => item.role), ['user']);
});

test('saving cancels an unfinished turn without delaying preparation or polluting the saved day', { timeout: 10000 }, async t => {
  const h = await harness(t); const wire = await connect(await h.start());
  const entered = deferred(); const release = deferred();
  h.fake.hold(async () => { entered.resolve(); await release.promise; });
  wire.send(openTalk()); await entered.promise;
  await sleep(wire);
  h.fake.hold(); release.resolve();
  wire.send(openTalk(2)); await wire.until('talk.reply');
  assert.equal(wire.inbox.filter(item => item.type === 'talk.reply').length, 1);
  assert.deepEqual(h.fake.sent.at(-1)!.slice(1).map(item => item.role), ['user']);
});

test('a new nonce discards the previous unsaved load and rejects its late messages', { timeout: 10000 }, async t => {
  const h = await harness(t); const server = await h.start(); const first = await connect(server);
  first.send(openTalk()); await first.until('talk.reply');
  first.send({ type: 'talk.say', npc: 'Abigail', text: '记住未保存的水母' }); await first.until('talk.reply');
  const again = await connect(server, initial('load-2'));
  first.send(openTalk()); assert.equal((await first.until('sync.error')).type, 'sync.error');
  again.send({ ...openTalk(), loadNonce: 'load-1' });
  assert.match(JSON.stringify(await again.until('sync.error')), /当前读档/);
  again.send(openTalk()); await again.until('talk.reply');
  assert.doesNotMatch(JSON.stringify(h.fake.sent.at(-1)), /未保存的水母/);
});

test('two game lineages cannot recall each other and missing pointers do not select latest history', { timeout: 10000 }, async t => {
  const h = await harness(t); const server = await h.start(); const a = await connect(server);
  a.send(openTalk()); await a.until('talk.reply');
  a.send({ type: 'talk.say', npc: 'Abigail', text: '记住第一个农场的秘密' }); await a.until('talk.reply'); await sleep(a);
  const b = await connect(server, initial('b-load', 1, null, 'farm-2'));
  b.send(openTalk()); await b.until('talk.reply');
  assert.doesNotMatch(JSON.stringify(h.fake.sent.at(-1)), /第一个农场的秘密/);
  const noPointer = await connect(server, initial('no-pointer', 2));
  noPointer.send(openTalk(2)); await noPointer.until('talk.reply');
  assert.doesNotMatch(JSON.stringify(h.fake.sent.at(-1)), /第一个农场的秘密/);
});

test('moving a socket to another farm releases its old connection ownership', { timeout: 10000 }, async t => {
  const h = await harness(t); const server = await h.start(); const first = await connect(server);
  first.raw(initial('second-farm-load', 1, null, 'farm-2')); await first.until('save.ready');
  const oldFarm = await connect(server);
  oldFarm.send(openTalk()); await oldFarm.until('talk.reply');
  first.send({ ...openTalk(), lineageId: 'farm-2', loadNonce: 'second-farm-load' });
  await first.until('talk.reply');
  assert.equal(h.fake.sent.length, 2);
});

test('an unavailable game commit falls back only to its explicit known parent', { timeout: 10000 }, async t => {
  const h = await harness(t); const server = await h.start(); const wire = await connect(server);
  wire.send(openTalk()); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住父提交里的蓝莓' }); await wire.until('talk.reply');
  const saved = await sleep(wire);
  const gap = await connect(server, initial('gap-load', 3, { commitId: 'offline-missing', parentId: saved.commitId, dayEnded: 2 }));
  gap.send(openTalk(3)); await gap.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, /父提交里的蓝莓/);
  assert.ok(h.logs.some(line => line.includes('记忆缺口')));
});

test('an unknown commit and unknown parent stop AI rather than guessing a saved branch', { timeout: 10000 }, async t => {
  const h = await harness(t);
  const wire = await connect(await h.start(), initial('missing', 2, { commitId: 'missing', parentId: 'also-missing', dayEnded: 1 }), 0, 'sync.error');
  assert.match(JSON.stringify(wire.inbox), /记忆和父提交均缺失/);
  assert.equal(h.fake.sent.length, 0);
});

test('protocol rejects invalid identities, dates, sequences, pointers, snapshots, and old protocol versions', { timeout: 10000 }, async t => {
  const good = initial();
  for (const bad of [null, [], { ...good, seq: 1 }, { ...good, lineageId: '' }, { ...good, date: { ...good.date, day: 29 } },
    { ...good, date: { ...good.date, time: 1560 } }, { ...good, commit: { commitId: 'bad', parentId: 1, dayEnded: 1 } },
    { ...openTalk(), lineageId: 'a', loadNonce: 'b', seq: -1 }, { ...good, loadNonce: '../x\n' }]) {
    assert.throws(() => parseModMessage(JSON.stringify(bad)));
  }
  // The optional snapshot for the companion robot (docs/companion-device.md §13.2).
  const saving = (snapshot: unknown) => JSON.stringify({ type: 'save.saving', lineageId: 'a', loadNonce: 'b', seq: 1,
    commit: { commitId: 'c', parentId: null, dayEnded: 1 }, snapshot });
  const snapshot = { label: '测试', npcs: { Abigail: { hearts: 4, relation: 'friend' } }, seenEvents: ['14'], world: WORLD };
  assert.deepEqual((parseModMessage(saving(snapshot)) as { snapshot: unknown }).snapshot, snapshot);
  assert.equal((parseModMessage(saving(undefined)) as { snapshot?: unknown }).snapshot, undefined, 'older mods send none');
  for (const bad of [null, { ...snapshot, npcs: { Abigail: { hearts: 15, relation: 'friend' } } },
    { ...snapshot, npcs: { Abigail: { hearts: 4, relation: 'boss' } } }, { ...snapshot, seenEvents: [1] }, { ...snapshot, world: {} },
    { ...snapshot, label: 'x'.repeat(201) }]) {
    assert.throws(() => parseModMessage(saving(bad)), /snapshot|world/);
  }
  assert.equal(absoluteDay({ year: 2, season: 'spring', day: 1 }), 113);
  assert.equal(Math.floor(gameMinutes({ ...WORLD.date, time: 2530 }) / 1440), 1);
  const h = await harness(t); const wire = await connect(await h.start());
  wire.raw({ type: 'hello', protocol: 1, modVersion: 'old' });
  assert.match(JSON.stringify(await wire.until('sync.error')), /协议不一致/);
});
