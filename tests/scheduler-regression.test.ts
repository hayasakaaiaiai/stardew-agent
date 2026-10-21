import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatModel, Completion } from '../src/services/model/client.ts';
import { ModelGateway } from '../src/services/model/gateway.ts';
import { connect, deferred, harness, initial, openTalk, sleep, WORLD } from './helpers/bridge.ts';

const completion = (content = '{}'): Completion => ({ content, reasoning: '', finishReason: 'stop',
  usage: { inputTokens: 123, cachedInputTokens: 45, outputTokens: 67, reasoningTokens: null },
  timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } });
const settle = () => new Promise(resolve => setTimeout(resolve, 100));
async function until(ready: () => boolean) {
  for (let i = 0; i < 300 && !ready(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(ready(), 'timed out waiting for a backstage call');
}
const hour = (time: number, groups = [['Pam', 'Gus']], day = 1) => ({ type: 'town.hour', groups,
  places: groups.map(() => '星之果实餐吧'), hearts: Object.fromEntries(groups.flat().map(npc => [npc, 6])),
  date: { ...WORLD.date, day, time }, weather: 'sunny' });

test('usage from an in-flight call is reported exactly once even across multiple saves', async () => {
  const gateway = new ModelGateway(), started = deferred(), release = deferred();
  const model: ChatModel = { async chat() { started.resolve(); await release.promise; return completion(); } };
  const pending = gateway.lane('background', model).chat([{ role: 'user', content: '后台' }]);
  await started.promise;
  assert.match(gateway.report(1), /后台 1 次 输入 0/);
  assert.equal(gateway.report(2), '第 2 天模型用量：没有调用');
  release.resolve(); await pending;
  assert.deepEqual(gateway.usage().background,
    { calls: 0, inputTokens: 123, cachedInputTokens: 45, outputTokens: 67, expired: 0, failed: 0 });
  assert.match(gateway.report(3), /后台 0 次 输入 123（缓存 45）输出 67/, 'late usage must appear even without a new dispatch');
  assert.equal(gateway.report(4), '第 4 天模型用量：没有调用', 'no duplicate late usage');
});

test('a request failing after a usage report keeps its failure count and releases its slot', async () => {
  const gateway = new ModelGateway({ maxConcurrent: 1 }), started = deferred(), release = deferred();
  const error = new Error('injected model failure');
  const model: ChatModel = { async chat() { started.resolve(); await release.promise; throw error; } };
  const pending = gateway.lane('nearby', model).chat([]);
  await started.promise; gateway.report(1);
  const rejected = assert.rejects(pending, value => value === error);
  release.resolve(); await rejected;
  assert.equal(gateway.usage().nearby.failed, 1, 'late failures must not update a discarded tally');
  assert.match(gateway.report(2), /失败 1 次/);
  await gateway.lane('dialogue', { async chat() { return completion(); } }).chat([]);
  assert.equal(gateway.usage().dialogue.calls, 1);
});

test('reconnecting the same load cannot restart a replayed hour or reuse its participants', { timeout: 15000 }, async t => {
  const h = await harness(t);
  let calls = 0;
  const backstageModel: ChatModel = { async chat() { calls++; return completion(JSON.stringify({ memories: { a: '格斯聊了汤', b: '潘姆聊了巴士' } })); } };
  const server = await h.start(undefined, undefined, undefined, { backstageModel });
  const first = await connect(server);
  const packet = first.send(hour(1000)); await first.until('ack');
  await until(() => h.logs.some(line => line.includes('2 条等下一个整点写入')));
  await first.close();
  const second = await connect(server, first.loaded, first.cursor());
  let from = second.inbox.length; second.raw(packet); await second.until('ack', from); await settle();
  assert.equal(calls, 1, 'a replay after reconnect must not pay for a second scene');
  from = second.inbox.length; second.send(hour(1100)); await second.until('ack', from); await settle();
  assert.equal(calls, 1, 'the same NPCs already joined today before the disconnect');
  assert.equal(h.logs.filter(line => /^后台场景：.+记下了：/.test(line)).length, 2);
});

test('the daily backstage limit survives a reconnect but a new load gets its own budget', { timeout: 15000 }, async t => {
  const h = await harness(t);
  let calls = 0;
  const backstageModel: ChatModel = { async chat() { calls++; return completion(JSON.stringify({ memories: {} })); } };
  const server = await h.start(undefined, undefined, undefined, { backstageModel });
  const first = await connect(server);
  const pairs = [['Abigail', 'Sebastian'], ['Sam', 'Penny'], ['Leah', 'Elliott'], ['Haley', 'Alex'], ['Maru', 'Harvey'], ['Emily', 'Shane'], ['Pam', 'Gus']];
  for (let i = 0; i < 6; i++) {
    const from = first.inbox.length; first.send(hour(800 + i * 100, [pairs[i]!])); await first.until('ack', from);
    await until(() => calls === i + 1);
  }
  await first.close();
  const second = await connect(server, first.loaded, first.cursor());
  let from = second.inbox.length; second.send(hour(1400, [pairs[6]!])); await second.until('ack', from); await settle();
  assert.equal(calls, 6, 'reconnection cannot buy six more background calls');
  const fresh = await connect(server, initial('fresh-budget'));
  from = fresh.inbox.length; fresh.send(hour(800, [pairs[6]!])); await fresh.until('ack', from);
  await until(() => calls === 7);
});

test('a backstage result returning after save cannot leak into the next day and the next day still works', { timeout: 15000 }, async t => {
  const h = await harness(t), release = deferred();
  let calls = 0;
  const backstageModel: ChatModel = { async chat() {
    calls++;
    if (calls === 1) { await release.promise; return completion(JSON.stringify({ memories: { a: '旧日场景不应出现', b: '旧日场景不应出现' } })); }
    return completion(JSON.stringify({ memories: { a: '新日场景正常保留', b: '新日场景正常保留' } }));
  } };
  const server = await h.start(undefined, undefined, undefined, { backstageModel }), wire = await connect(server);
  wire.send(hour(2200)); await wire.until('ack'); await until(() => calls === 1);
  await sleep(wire); release.resolve(); await settle();
  let from = wire.inbox.length; wire.send(hour(800, undefined, 2)); await wire.until('ack', from);
  await until(() => h.logs.some(line => line.includes('2 条等下一个整点写入')));
  from = wire.inbox.length; wire.send(hour(900, undefined, 2)); await wire.until('ack', from);
  from = wire.inbox.length; wire.send(openTalk(2, 'Pam')); await wire.until('talk.reply', from);
  const prompt = h.fake.sent.at(-1)![0]!.content;
  assert.doesNotMatch(prompt, /旧日场景不应出现/);
  assert.match(prompt, /新日场景正常保留/);
  assert.ok(!wire.inbox.some(message => message.type === 'sync.error'));
});
