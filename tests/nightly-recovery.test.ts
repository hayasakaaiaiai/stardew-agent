import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import { NightlyOutputError, nightlyConsolidator, nightlyPrompt, NIGHTLY_RULES, type NightlyOutput } from '../src/agent/nightly.ts';
import type { ChatMessage, Completion, ModelClient } from '../src/services/model/client.ts';
import { FACTS_FIXTURES, factsInput } from '../tools/nightly/facts-fixtures.ts';
import { connect, deferred, harness, initial, openTalk, sleep } from './helpers/bridge.ts';

const answer = (extra: Partial<NightlyOutput> = {}) => JSON.stringify({ memories: [{ sources: ['t2'], importance: 4 }], retire: [],
  impression: '可靠的朋友', plan: '一起做风筝', bubbles: [{ text: '想做风筝', emote: 'happy' }], letter: '今天一起做风筝，可别忘啦。', gift: false, ...extra });
const bad = answer({ memories: [{ sources: ['t1', 't2', 't3', 't4'], importance: 4 }] });
function model(outputs: string[], gateAt = -1, gate?: Promise<void>) {
  const sent: ChatMessage[][] = [];
  return { sent, client: { async chat(messages: ChatMessage[]): Promise<Completion> {
    sent.push(structuredClone(messages));
    if (sent.length === gateAt) await gate;
    return { content: outputs[sent.length - 1] ?? 'not JSON', reasoning: '', usage: null, finishReason: 'stop',
      timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
  } } as unknown as ModelClient };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), 'the recovery did not reach the expected checkpoint');
}
function database(directory: string, commitId: string) {
  const db = new DatabaseSync(join(directory, 'memory.sqlite'), { readOnly: true });
  try {
    return { fingerprint: db.prepare('SELECT consolidation_fingerprint AS value FROM commit_node WHERE id=?').get(commitId)!.value,
      states: db.prepare("SELECT npc_id FROM npc_state WHERE commit_id=? AND phase='consolidated'").all(commitId),
      retired: db.prepare('SELECT COUNT(*) AS n FROM memory_retire WHERE commit_id=?').get(commitId)!.n };
  } finally { db.close(); }
}
async function converse(wire: Awaited<ReturnType<typeof connect>>, npc = 'Abigail') {
  let from = wire.inbox.length;
  wire.send(openTalk(1, npc)); await wire.until('talk.reply', from);
  from = wire.inbox.length;
  wire.send({ type: 'talk.say', npc, text: '记住一起做风筝' }); await wire.until('talk.reply', from);
  wire.send({ type: 'talk.close', npc }); await wire.until('ack');
}

test('a source-limit error is explained on retry without changing the normal prompt or truncating evidence', async t => {
  const h = await harness(t);
  const input = factsInput(FACTS_FIXTURES[0]!);
  const fake = model([bad, answer()]);
  const prompt = nightlyPrompt(h.roster, input.commit, input.npcs[0]!);
  const changes = await nightlyConsolidator({ roster: h.roster, model: fake.client })(input, new AbortController().signal);
  assert.deepEqual(fake.sent[0], prompt.messages, 'a normal call has no extra token cost');
  assert.equal(fake.sent[1]![0]!.content, NIGHTLY_RULES);
  assert.match(fake.sent[1]![1]!.content, /第 1 条记忆的 sources 引用了 4 条原话，最多 3 条/);
  assert.match(fake.sent[1]![1]!.content, /保留否定与回应，不要截断原话或编造编号/);
  assert.ok(fake.sent[1]![1]!.content.startsWith(prompt.messages[1]!.content));
  assert.equal(changes.length, 1);
});

test('an automatic recovery leaves the failed batch unwritten and delivers nonempty mail only after success', async t => {
  const h = await harness(t);
  const gate = deferred();
  const fake = model([bad, bad, answer()], 3, gate.promise);
  const server = await h.start(nightlyConsolidator({ roster: h.roster, model: fake.client, log: line => h.logs.push(line) }), 10);
  const wire = await connect(server);
  await converse(wire);
  const commit = await sleep(wire);
  await until(() => fake.sent.length === 3);
  assert.deepEqual(database(h.directory, commit.commitId), { fingerprint: null, states: [], retired: 0 });
  assert.ok(h.logs.some(line => line.startsWith('夜间整合待恢复')));
  assert.ok(!h.logs.some(line => line.startsWith('夜间整合完成')));
  assert.ok(!wire.inbox.some(message => message.type === 'day.letters' && message.letters.length));
  const from = wire.inbox.length;
  gate.resolve();
  const packet = await wire.until('day.letters', from);
  assert.equal(packet.type, 'day.letters');
  assert.equal(packet.type === 'day.letters' && packet.letters[0]?.text, '今天一起做风筝，可别忘啦。');
  assert.ok(database(h.directory, commit.commitId).fingerprint);
  assert.equal(h.logs.filter(line => line.startsWith('夜间整合完成')).length, 1);
  assert.equal(fake.sent.length, 3);
  await wire.close();
});

test('the automatic budget stops at four invalid calls and a process restart can recover the pending commit', async t => {
  const h = await harness(t);
  const failed = model([bad, bad, bad, bad]);
  const server = await h.start(nightlyConsolidator({ roster: h.roster, model: failed.client }), 5);
  const wire = await connect(server);
  await converse(wire);
  const commit = await sleep(wire);
  await until(() => h.logs.some(line => line.includes('自动补跑额度已用尽')));
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(failed.sent.length, 4);
  assert.deepEqual(database(h.directory, commit.commitId), { fingerprint: null, states: [], retired: 0 });
  await wire.close(); await h.stop(server);
  const recovered = model([answer()]);
  const again = await connect(await h.start(nightlyConsolidator({ roster: h.roster, model: recovered.client })), initial('recovered', 2, commit));
  await until(() => !!database(h.directory, commit.commitId).fingerprint);
  assert.equal(recovered.sent.length, 1);
  await again.close();
});

test('waiting for recovery does not block another save and closing cancels pending recovery work', async t => {
  const h = await harness(t);
  const failed = model([bad, bad]);
  const good = model([answer()]);
  const broken = nightlyConsolidator({ roster: h.roster, model: failed.client });
  const healthy = nightlyConsolidator({ roster: h.roster, model: good.client });
  const server = await h.start((input, signal) => (input.commit.lineageId === 'farm-1' ? broken : healthy)(input, signal), 5000);
  const first = await connect(server);
  await converse(first); await sleep(first, 'A');
  await until(() => h.logs.some(line => line.startsWith('夜间整合待恢复')));
  const second = await connect(server, initial('other', 1, null, 'other-farm'));
  await converse(second); await sleep(second, 'B');
  await until(() => !!database(h.directory, 'B').fingerprint);
  assert.equal(failed.sent.length, 2, 'the healthy save finishes while the retry is still waiting');
  assert.equal(good.sent.length, 1);
  await first.close(); await second.close(); await h.stop(server);
  await new Promise(resolve => setTimeout(resolve, 5100));
  assert.equal(failed.sent.length, 2, 'closing prevents the scheduled call');
});

test('one invalid NPC cannot partially retire another NPC or stamp the batch completed', async t => {
  const h = await harness(t);
  const healthy = nightlyConsolidator({ roster: h.roster, model: model([answer()]).client });
  const broken = nightlyConsolidator({ roster: h.roster, model: model([bad, bad]).client });
  const server = await h.start((input, signal) => (input.npcs[0]!.npcId === 'abigail' ? healthy : broken)(input, signal));
  const wire = await connect(server);
  await converse(wire); await converse(wire, 'Sam');
  const commit = await sleep(wire);
  await until(() => h.logs.some(line => line.startsWith('夜间整合待恢复')));
  assert.deepEqual(database(h.directory, commit.commitId), { fingerprint: null, states: [], retired: 0 });
  assert.ok(!h.logs.some(line => line.startsWith('夜间整合完成')));
  await wire.close();
});

test('a delayed recovery of a future branch never delivers its letter into a reloaded old save', async t => {
  const h = await harness(t);
  const gate = deferred();
  const first = nightlyConsolidator({ roster: h.roster, model: model([answer()]).client });
  const future = model([bad, bad, answer({ memories: [{ sources: ['t1'], importance: 4 }], letter: '未来分支的来信', impression: '未来分支' })], 3, gate.promise);
  const recover = nightlyConsolidator({ roster: h.roster, model: future.client });
  const server = await h.start((input, signal) => (input.commit.id === 'A' ? first : recover)(input, signal), 5);
  const wire = await connect(server);
  await converse(wire);
  const a = await sleep(wire, 'A');
  await until(() => !!database(h.directory, 'A').fingerprint);
  const from = wire.inbox.length;
  wire.send(openTalk(2)); await wire.until('talk.reply', from);
  await sleep(wire, 'B', 2, a.commitId);
  await until(() => future.sent.length === 3);
  wire.send({ type: 'title.returned' }); await wire.until('ack'); await wire.close();
  const old = await connect(server, initial('old-A', 2, a));
  await old.until('day.letters', 0);
  gate.resolve();
  await until(() => !!database(h.directory, 'B').fingerprint);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(!old.inbox.some(message => message.type === 'day.letters' && JSON.stringify(message.letters).includes('未来分支')));
  assert.ok(old.inbox.some(message => message.type === 'day.letters' && message.letters[0]?.text === '今天一起做风筝，可别忘啦。'));
  await old.close();
});
