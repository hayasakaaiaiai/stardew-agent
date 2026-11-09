import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LifeEvent } from '../src/agent/life.ts';
import { parseModMessage } from '../src/bridge/protocol.ts';
import { connect, deferred, harness, initial, openTalk, sleep, WORLD } from './helpers/bridge.ts';

const accepted: LifeEvent = { id: 'life-1', npc: 'leah', day: 1, kind: 'goal.accepted', goal: 'leah-driftwood-v1' };
const delivered: LifeEvent = { id: 'life-2', npc: 'leah', day: 1, kind: 'goal.delivered', goal: 'leah-driftwood-v1', item: '浮木', count: 3 };
const finished: LifeEvent = { id: 'life-3', npc: 'leah', day: 1, kind: 'goal.completed', goal: 'leah-driftwood-v1', activity: 'forest_walk', minutes: 30 };
const sync = (events: LifeEvent[], final = true) => ({ type: 'life.sync', events, final });
type Wire = Awaited<ReturnType<typeof connect>>;
async function upload(wire: Wire, events: LifeEvent[]) {
  const from = wire.inbox.length;
  const sent = wire.send(sync(events));
  await wire.until('life.ready', from);
  return sent;
}
function readState(directory: string, commit: string, npc = 'leah') {
  const db = new DatabaseSync(join(directory, 'memory.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT entry FROM log WHERE commit_id=? AND npc_id=? ORDER BY seq DESC').all(commit, npc);
    for (const row of rows) {
      const entry = JSON.parse(row.entry as string);
      const life = entry.changes.find((change: { npcId: string }) => change.npcId === npc)?.log?.lifeState;
      if (life) return { life };
    }
    return undefined;
  } finally { db.close(); }
}
function countLife(directory: string, commit: string) {
  const db = new DatabaseSync(join(directory, 'memory.sqlite'), { readOnly: true });
  try { return db.prepare("SELECT count(*) AS n FROM memory WHERE commit_id=? AND topics LIKE '%life:%'").get(commit)!.n; }
  finally { db.close(); }
}
function requiredState(directory: string, commit: string, npc = 'leah') {
  const state = readState(directory, commit, npc);
  assert.ok(state, `missing life projection for ${npc} in ${commit}`);
  return state;
}

test('life protocol bounds batches, rejects invented kinds and validates live activity snapshots', () => {
  const env = { lineageId: 'farm-1', loadNonce: 'load-1', seq: 1 };
  assert.equal(parseModMessage(JSON.stringify({ ...env, ...sync([]) })).type, 'life.sync');
  for (const patch of [{ final: 'yes' }, { events: [{ ...accepted, npc: 'Gunther' }] },
    { events: [{ ...accepted, kind: 'inventory.add' }] }, { events: Array(33).fill(accepted) }])
    assert.throws(() => parseModMessage(JSON.stringify({ ...env, ...sync([]), ...patch })));
  assert.equal(parseModMessage(JSON.stringify({ ...env, ...openTalk(1, 'Leah'),
    lifeActivity: { activity: 'forest_walk', minutes: 20, count: 0 } })).type, 'talk.open');
  for (const lifeActivity of [{ activity: 'teleport', minutes: 1, count: 0 }, { activity: 'cooking', minutes: -1, count: 1 }])
    assert.throws(() => parseModMessage(JSON.stringify({ ...env, ...openTalk(), lifeActivity })));
  assert.equal(parseModMessage(JSON.stringify({ ...env, ...openTalk(1, 'Leah'),
    lifeActivity: { activity: 'forest_walk', minutes: 10, count: 0, goal: 'leah-driftwood-v1' } })).type, 'talk.open');
  for (const [npc, goal, activity] of [['Leah', 'invented-goal', 'forest_walk'],
    ['Abigail', 'leah-driftwood-v1', 'forest_walk'], ['Leah', 'leah-driftwood-v1', 'fishing']])
    assert.throws(() => parseModMessage(JSON.stringify({ ...env, ...openTalk(1, npc),
      lifeActivity: { activity, minutes: 10, count: 0, goal } })));
});

test('a partial journal blocks dialogue until the final batch and only changes the intended NPC', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  wire.send(sync([accepted], false)); await wire.until('ack');
  const from = wire.inbox.length;
  wire.send(openTalk(1, 'Leah')); await wire.until('talk.error', from);
  assert.equal(h.fake.sent.length, 0);
  await upload(wire, [delivered]);
  wire.send(openTalk(1, 'Leah')); await wire.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, /浮木/);
  assert.match(h.fake.sent.at(-1)![0]!.content, /第 1 天/);
  wire.send({ type: 'talk.close', npc: 'Leah' }); await wire.until('ack');
  wire.send(openTalk(1, 'Abigail')); await wire.until('talk.reply');
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, /最近相处|共同目标的当前事实|实际交给我 3 块浮木/);
});

test('journal replay after backend restart does not duplicate trust or completed memories', { timeout: 20000 }, async t => {
  const h = await harness(t); let server = await h.start(); let wire = await connect(server);
  await upload(wire, [accepted, delivered, finished]);
  const commit = await sleep(wire, 'life-save');
  const before = requiredState(h.directory, commit.commitId);
  assert.ok(before.life);
  assert.equal(countLife(h.directory, commit.commitId), 3);
  await wire.close(); await h.stop(server);
  server = await h.start(); wire = await connect(server, initial('life-new-load', 2, commit));
  await upload(wire, [accepted, delivered, finished]);
  const afterCommit = await sleep(wire, 'life-save-2', 2, commit.commitId);
  assert.equal(countLife(h.directory, afterCommit.commitId), 0);
  const after = readState(h.directory, afterCommit.commitId);
  assert.equal(after, undefined, 'unchanged inherited state is not rewritten on replay');
  wire.send(openTalk(3, 'Leah')); await wire.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, /实际共同经历|浮木/);
});

test('a day-end goal cannot send its trailing completion after save preparation', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  await upload(wire, [accepted, delivered]);
  wire.send(sync([{ id: 'life-3', npc: 'leah', day: 1, kind: 'activity.completed',
    goal: accepted.goal!, activity: 'forest_walk', minutes: 30, count: 0 }]));
  // This is the old native order: Saving overtook the completion waiting for the first batch's ACK.
  wire.send({ type: 'save.saving', commit: { commitId: 'life-premature-save', parentId: null, dayEnded: 1 } });
  wire.send(sync([{ ...finished, id: 'life-4' }]));
  const error = await wire.until('sync.error');
  assert.equal(error.type, 'sync.error');
  assert.match(error.message, /生活记录等待当前存档准备就绪/);
});

test('flushing day-end life batches before saving preserves the complete goal on reload', { timeout: 15000 }, async t => {
  const h = await harness(t), server = await h.start(), wire = await connect(server);
  await upload(wire, [accepted, delivered]);
  // A save flush sends both batches in wire order without waiting for either ACK.
  wire.send(sync([{ id: 'life-3', npc: 'leah', day: 1, kind: 'activity.completed',
    goal: accepted.goal!, activity: 'forest_walk', minutes: 30, count: 0 }]));
  wire.send(sync([{ ...finished, id: 'life-4' }]));
  const commit = await sleep(wire, 'life-flushed-save');
  assert.equal(requiredState(h.directory, commit.commitId).life.goals[accepted.goal!].phase, 'completed');
  assert.equal(countLife(h.directory, commit.commitId), 4);
  assert.equal(wire.inbox.filter(message => message.type === 'sync.error').length, 0);
  await wire.close();
  const restored = await connect(server, initial('life-flushed-reload', 2, commit));
  await upload(restored, [accepted, delivered,
    { id: 'life-3', npc: 'leah', day: 1, kind: 'activity.completed', goal: accepted.goal!,
      activity: 'forest_walk', minutes: 30, count: 0 }, { ...finished, id: 'life-4' }]);
  const next = await sleep(restored, 'life-flushed-next', 2, commit.commitId);
  assert.equal(countLife(h.directory, next.commitId), 0);
});

test('unsaved life state rolls back and sibling branches may reuse the rolled-back native serial', { timeout: 20000 }, async t => {
  const h = await harness(t), server = await h.start(); const wire = await connect(server);
  await upload(wire, [accepted]); const base = await sleep(wire, 'life-base');
  await upload(wire, [{ ...delivered, day: 2 }]);
  wire.send({ type: 'title.returned' }); await wire.until('ack'); await wire.close();
  const reload = await connect(server, initial('life-branch-b', 2, base));
  await upload(reload, [accepted]);
  reload.send(openTalk(2, 'Leah')); await reload.until('talk.reply');
  const prompt = h.fake.sent.at(-1)![0]!.content;
  assert.doesNotMatch(prompt, /实际交给我 3 块浮木/);
  reload.send({ type: 'talk.close', npc: 'Leah' }); await reload.until('ack');
  await upload(reload, [{ id: 'life-2', npc: 'leah', day: 2, kind: 'goal.closed', goal: 'leah-driftwood-v1' }]);
  const branch = await sleep(reload, 'life-branch', 2, base.commitId);
  assert.equal(requiredState(h.directory, branch.commitId).life.lastSerial, 2);
});

test('offline saved journal restores source dates and rejects future facts without partial writes', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start(), initial('offline', 2));
  const from = wire.inbox.length;
  wire.send(sync([accepted, { ...delivered, day: 3 }])); await wire.until('sync.error', from);
  await upload(wire, [accepted, delivered]);
  wire.send(openTalk(2, 'Leah')); await wire.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, /第 1 天/);
  const commit = await sleep(wire, 'offline-recovered', 2);
  assert.equal(countLife(h.directory, commit.commitId), 2);
});

test('a native activity snapshot is present while it is in progress and is not a completed memory', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  await upload(wire, []);
  wire.send({ ...openTalk(1, 'Leah'), lifeActivity: { activity: 'forest_walk', minutes: 20, count: 0 } });
  await wire.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, /当前共同活动.*森林散步.*20.*仍在进行/);
  const commit = await sleep(wire, 'life-live-snapshot');
  assert.equal(countLife(h.directory, commit.commitId), 0);
});

test('friends hear a sourced event atomically and replay cannot turn it into their own experience', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  const event: LifeEvent = { id: 'life-1', npc: 'leah', kind: 'activity.completed', activity: 'forest_walk', minutes: 30, day: 1 };
  const heard: LifeEvent = { id: 'life-2', npc: 'leah', kind: 'social.shared', other: 'elliott', sourceId: 'life-1', day: 1 };
  await upload(wire, [event, heard]);
  await upload(wire, [event, heard]);
  wire.send(openTalk(1, 'Elliott')); await wire.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, /转述|不是我亲历/);
  const commit = await sleep(wire, 'life-shared');
  assert.equal(requiredState(h.directory, commit.commitId, 'leah').life.lastSerial, 2);
  assert.equal(requiredState(h.directory, commit.commitId, 'elliott').life.lastSerial, 2);
  assert.equal(countLife(h.directory, commit.commitId), 3);
});

test('native life friendship shares the dialogue cap, but restored yesterday points do not spend today budget', { timeout: 20000 }, async t => {
  const h = await harness(t), server = await h.start(), wire = await connect(server);
  await upload(wire, [{ id: 'life-1', npc: 'leah', day: 1, kind: 'activity.completed', activity: 'forest_walk', minutes: 30, friendship: 20 }]);
  wire.send(openTalk(1, 'Leah')); await wire.until('talk.reply');
  let from = wire.inbox.length;
  wire.send({ type: 'talk.say', npc: 'Leah', text: '好感2 谢谢陪我散步' });
  let reply = await wire.until('talk.reply', from);
  assert.equal(reply.type === 'talk.reply' && reply.friendship, 10);
  const commit = await sleep(wire, 'life-hearts');
  await wire.close(); await h.stop(server);
  const restored = await connect(await h.start(), initial('life-heart-reload', 2, commit));
  await upload(restored, [{ id: 'life-1', npc: 'leah', day: 1, kind: 'activity.completed', activity: 'forest_walk', minutes: 30, friendship: 20 }]);
  restored.send(openTalk(2, 'Leah')); await restored.until('talk.reply');
  from = restored.inbox.length;
  restored.send({ type: 'talk.say', npc: 'Leah', text: '好感2 谢谢你', date: { ...restored.loaded.date } });
  reply = await restored.until('talk.reply', from);
  assert.equal(reply.type === 'talk.reply' && reply.friendship, 30);
});

test('late nightly impressions remain visible after a next-day life observation is recorded and saved', { timeout: 20000 }, async t => {
  const h = await harness(t), gate = deferred(), entered = deferred();
  const server = await h.start(async input => {
    if (input.commit.dayEnded !== 1) return [];
    entered.resolve(); await gate.promise;
    return input.npcs.map(npc => ({ npcId: npc.npcId, state: { ...npc.state,
      impression: '我仍清楚记得农场主愿意认真听我的创作想法。', plan: '明天想聊聊树的形状。', day: 1 } }));
  });
  t.after(() => gate.resolve());
  const wire = await connect(server);
  wire.send(openTalk(1, 'Leah')); await wire.until('talk.reply');
  const first = await sleep(wire, 'life-nightly-before');
  await entered.promise;
  await upload(wire, [{ id: 'life-1', npc: 'leah', day: 2, kind: 'activity.completed', activity: 'forest_walk', minutes: 30 }]);
  const second = await sleep(wire, 'life-nightly-after', 2, first.commitId);
  gate.resolve();
  const db = new DatabaseSync(join(h.directory, 'memory.sqlite'), { readOnly: true });
  try {
    const complete = () => db.prepare("SELECT state FROM npc_state WHERE commit_id=? AND npc_id='leah' AND phase='consolidated'").get(first.commitId);
    for (let attempt = 0; !complete() && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(complete(), 'the delayed nightly result really committed');
  } finally { db.close(); }
  wire.send(openTalk(3, 'Leah')); await wire.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, /我仍清楚记得农场主愿意认真听我的创作想法/);
  assert.match(h.fake.sent.at(-1)![0]!.content, /实际共同经历/);
  await wire.close();
  const reload = await connect(server, initial('life-nightly-reload', 3, second));
  await upload(reload, [{ id: 'life-1', npc: 'leah', day: 2, kind: 'activity.completed', activity: 'forest_walk', minutes: 30 }]);
  reload.send(openTalk(3, 'Leah')); await reload.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, /我仍清楚记得农场主愿意认真听我的创作想法/);
});

test('a malformed life packet returns a load-scoped error and blocks dialogue until a valid final probe', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  let from = wire.inbox.length;
  const sent = wire.send({ ...sync([]), events: [{ ...accepted, kind: 'inventory.add' }] });
  const error = await wire.until('sync.error', from);
  assert.equal(error.type === 'sync.error' && error.seq, sent.seq);
  assert.equal(error.type === 'sync.error' && error.loadNonce, wire.loaded.loadNonce);
  from = wire.inbox.length;
  wire.send(openTalk(1, 'Leah')); await wire.until('talk.error', from);
  assert.equal(h.fake.sent.length, 0);
  await upload(wire, []);
  from = wire.inbox.length;
  wire.send(openTalk(1, 'Leah')); await wire.until('talk.reply', from);
  const commit = await sleep(wire, 'life-protocol-error');
  assert.equal(countLife(h.directory, commit.commitId), 0);
  assert.equal(readState(h.directory, commit.commitId), undefined);
});

test('conflicting receipts and stale-load life packets cannot mutate the active journal', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  const acceptedPacket = await upload(wire, [accepted]);
  let from = wire.inbox.length;
  wire.raw({ ...acceptedPacket, events: [delivered] });
  const conflict = await wire.until('sync.error', from);
  assert.match(conflict.type === 'sync.error' ? conflict.message : '', /同一个序号/);
  from = wire.inbox.length;
  wire.send({ ...sync([delivered]), loadNonce: 'older-load' });
  await wire.until('sync.error', from);
  await upload(wire, [delivered]);
  const commit = await sleep(wire, 'life-conflict');
  assert.equal(countLife(h.directory, commit.commitId), 2);
  assert.equal(requiredState(h.directory, commit.commitId).life.goals['leah-driftwood-v1'].phase, 'delivered');
});

test('a missing social source rolls back the whole batch and duplicate sharing with a new serial adds no memory', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  const invalid: LifeEvent = { id: 'life-2', npc: 'leah', day: 1, kind: 'social.shared', other: 'elliott', sourceId: 'life-1' };
  let from = wire.inbox.length;
  wire.send(sync([accepted, invalid])); await wire.until('sync.error', from);
  const source: LifeEvent = { id: 'life-1', npc: 'leah', day: 1, kind: 'activity.completed', activity: 'forest_walk', minutes: 30 };
  await upload(wire, [source, invalid]);
  await upload(wire, [{ ...invalid, id: 'life-3' }]);
  const commit = await sleep(wire, 'life-social-errors');
  assert.equal(countLife(h.directory, commit.commitId), 3);
  assert.equal(requiredState(h.directory, commit.commitId).life.lastSerial, 3);
  assert.equal(requiredState(h.directory, commit.commitId, 'elliott').life.lastSerial, 3);
  assert.deepEqual(requiredState(h.directory, commit.commitId).life.goals, {}, 'the rejected batch never accepted the goal');
});

test('a real appointment miss, explicit apology, and observed activity repair trust without duplicating vanilla points', { timeout: 20000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  let from = wire.inbox.length;
  wire.send({ type: 'meet.ended', npc: 'Leah', place: '海滩', time: 1400, arrived: 1400, left: 1530,
    met: false, stoodUp: true, friendship: -5, date: { ...WORLD.date, time: 1530 } });
  await wire.until('ack', from);
  const missed: LifeEvent = { id: 'life-1', npc: 'leah', day: 1, kind: 'activity.missed', minutes: 0 };
  const apology: LifeEvent = { id: 'life-2', npc: 'leah', day: 1, kind: 'relationship.apology', sourceId: 'life-1' };
  await upload(wire, [missed]);
  from = wire.inbox.length;
  wire.send(openTalk(1, 'Leah')); await wire.until('talk.reply', from);
  assert.match(h.fake.sent.at(-1)![0]!.content, /当前心情：失落/);
  from = wire.inbox.length;
  wire.send({ type: 'talk.close', npc: 'Leah' }); await wire.until('ack', from);
  await upload(wire, [apology]);
  from = wire.inbox.length;
  wire.send(openTalk(1, 'Leah')); await wire.until('talk.reply', from);
  assert.match(h.fake.sent.at(-1)![0]!.content, /关系修复还要看之后的实际行动/);
  from = wire.inbox.length;
  wire.send({ type: 'talk.close', npc: 'Leah' }); await wire.until('ack', from);
  const activity: LifeEvent = { id: 'life-3', npc: 'leah', day: 1, kind: 'activity.completed', activity: 'forest_walk', minutes: 30, friendship: 20 };
  await upload(wire, [activity]);
  await upload(wire, [missed, apology, activity]);
  from = wire.inbox.length;
  wire.send(openTalk(1, 'Leah')); await wire.until('talk.reply', from);
  assert.match(h.fake.sent.at(-1)![0]!.content, /当前心情：释然/);
  from = wire.inbox.length;
  wire.send({ type: 'talk.say', npc: 'Leah', text: '好感2 谢谢愿意再和我一起散步' });
  const reply = await wire.until('talk.reply', from);
  assert.equal(reply.type === 'talk.reply' && reply.friendship, 15, '−5 original miss +20 activity leaves +15 to the shared +30 cap');
  const commit = await sleep(wire, 'life-real-repair');
  const state = requiredState(h.directory, commit.commitId).life;
  assert.equal(state.trust, 0);
  assert.deepEqual(state.grievances, []);
  assert.equal(countLife(h.directory, commit.commitId), 3);
});

test('an excessive native friendship batch fails atomically and can be recovered without duplicate credit', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  const activity: LifeEvent = { id: 'life-1', npc: 'leah', day: 1, kind: 'activity.completed', activity: 'forest_walk', minutes: 30, friendship: 30 };
  let from = wire.inbox.length;
  wire.send(sync([activity, { ...activity, id: 'life-2' }]));
  const error = await wire.until('sync.error', from);
  assert.match(error.type === 'sync.error' ? error.message : '', /好感超过当天/);
  await upload(wire, [activity]);
  from = wire.inbox.length;
  wire.send(openTalk(1, 'Leah')); await wire.until('talk.reply', from);
  from = wire.inbox.length;
  wire.send({ type: 'talk.say', npc: 'Leah', text: '好感2 真开心' });
  const reply = await wire.until('talk.reply', from);
  assert.equal(reply.type === 'talk.reply' && reply.friendship, 0);
  const commit = await sleep(wire, 'life-budget-error');
  assert.equal(countLife(h.directory, commit.commitId), 1);
  assert.equal(requiredState(h.directory, commit.commitId).life.lastSerial, 1);
});

test('reconnection during a partial journal resumes the same load without duplicate state', { timeout: 15000 }, async t => {
  const h = await harness(t), server = await h.start(), wire = await connect(server);
  const from = wire.inbox.length;
  const packet = wire.send(sync([accepted], false)); await wire.until('ack', from);
  const cursor = wire.cursor(); await wire.close();
  const reconnected = await connect(server, wire.loaded, cursor);
  const replayStart = reconnected.inbox.length;
  reconnected.raw(packet); await reconnected.until('ack', replayStart);
  await upload(reconnected, [accepted, delivered]);
  const commit = await sleep(reconnected, 'life-partial-reconnect');
  assert.equal(countLife(h.directory, commit.commitId), 2);
  assert.equal(requiredState(h.directory, commit.commitId).life.lastSerial, 2);
});

test('a later negative delta cannot hide an intermediate native friendship limit violation', { timeout: 15000 }, async t => {
  const h = await harness(t), wire = await connect(await h.start());
  const events: LifeEvent[] = [
    { id: 'life-1', npc: 'leah', day: 1, kind: 'activity.completed', activity: 'forest_walk', minutes: 30, friendship: 30 },
    { id: 'life-2', npc: 'leah', day: 1, kind: 'activity.completed', activity: 'fishing', minutes: 20, count: 1, friendship: 30 },
    { id: 'life-3', npc: 'leah', day: 1, kind: 'activity.missed', minutes: 0, friendship: -30 },
  ];
  let from = wire.inbox.length;
  wire.send(sync(events));
  const error = await wire.until('sync.error', from);
  assert.match(error.type === 'sync.error' ? error.message : '', /好感超过当天/);
  await upload(wire, []);
  from = wire.inbox.length;
  wire.send(openTalk(1, 'Leah')); await wire.until('talk.reply', from);
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, /## 最近相处/);
  const commit = await sleep(wire, 'life-intermediate-budget-error');
  assert.equal(countLife(h.directory, commit.commitId), 0);
  assert.equal(readState(h.directory, commit.commitId), undefined, 'no partial projection survives a rejected batch');
});
