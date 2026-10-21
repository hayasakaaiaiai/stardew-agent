import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { BridgeServer } from '../src/bridge/server.ts';
import type { ChatModel, Completion, Usage } from '../src/services/model/client.ts';
import { ModelGateway, QueueExpired, type Tier } from '../src/services/model/gateway.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';
import { connect, deferred, fakeModel, openTalk, sleep } from './helpers/bridge.ts';

const done = (usage: Usage | null = null): Completion => ({ content: '{}', reasoning: '', finishReason: 'stop', usage,
  timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } });

/** A model whose calls stay open until released, recording the order they reached it. */
function held() {
  const started: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const model: ChatModel = { async chat(messages) {
    const name = messages[0]!.content;
    started.push(name);
    const gate = deferred(); gates.set(name, gate);
    await gate.promise;
    if (name.startsWith('坏')) throw new Error('HTTP 500');
    return done({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 60, reasoningTokens: null });
  } };
  const release = (name: string) => gates.get(name)!.resolve();
  return { model, started, release };
}
const ask = (gateway: ModelGateway, tier: Tier, model: ChatModel, name: string, signal?: AbortSignal) =>
  gateway.lane(tier, model).chat([{ role: 'user', content: name }], {}, signal ? { signal } : {});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('queued requests start by tier, dialogue first, and in arrival order within a tier', async () => {
  const gateway = new ModelGateway({ maxConcurrent: 1 });
  const { model, started, release } = held();
  const first = ask(gateway, 'background', model, '后台1');
  await tick();
  const rest = [ask(gateway, 'background', model, '后台2'), ask(gateway, 'nightly', model, '夜间'), ask(gateway, 'nearby', model, '附近1'),
    ask(gateway, 'nearby', model, '附近2'), ask(gateway, 'dialogue', model, '对话')];
  for (const name of ['后台1', '对话', '附近1', '附近2', '夜间']) { release(name); await tick(); }
  release('后台2');
  await Promise.all([first, ...rest]);
  assert.deepEqual(started, ['后台1', '对话', '附近1', '附近2', '夜间', '后台2']);
});

test('at most 3 calls besides dialogue run at once, so the player is never stuck behind them', async () => {
  const gateway = new ModelGateway();
  const { model, started, release } = held();
  const others = ['附近1', '附近2', '夜间', '后台'].map(name => ask(gateway, name === '夜间' ? 'nightly' : name === '后台' ? 'background' : 'nearby', model, name));
  await tick();
  assert.deepEqual(started, ['附近1', '附近2', '夜间']);
  const talk = ask(gateway, 'dialogue', model, '对话');
  await tick();
  assert.deepEqual(started, ['附近1', '附近2', '夜间', '对话']);
  release('对话'); await talk;
  assert.deepEqual(started.length, 4, 'a finished dialogue frees only a dialogue slot');
  release('附近1'); await tick();
  assert.deepEqual(started.at(-1), '后台');
  for (const name of ['附近2', '夜间', '后台']) release(name);
  await Promise.all(others);
});

test('the total limit caps dialogue too', async () => {
  const gateway = new ModelGateway({ maxConcurrent: 2 });
  const { model, started, release } = held();
  const calls = ['对话1', '对话2', '对话3'].map(name => ask(gateway, 'dialogue', model, name));
  await tick();
  assert.deepEqual(started, ['对话1', '对话2']);
  for (const name of started.slice()) release(name);
  await tick(); release('对话3');
  await Promise.all(calls);
});

test('a request that waits too long is dropped without being sent; dialogue and nightly wait as long as it takes', async () => {
  const gateway = new ModelGateway({ maxNonDialogue: 1, maxWaitMs: { nearby: 30, background: 30 } });
  const { model, started, release } = held();
  const busy = ask(gateway, 'nightly', model, '夜间1');
  await tick();
  const late = ask(gateway, 'nearby', model, '附近');
  const later = ask(gateway, 'background', model, '后台');
  const patient = ask(gateway, 'nightly', model, '夜间2');
  await assert.rejects(late, QueueExpired);
  await assert.rejects(later, /排队 0 秒还没轮到，放弃这次后台请求/);
  release('夜间1'); await busy; await tick();
  release('夜间2'); await patient;
  assert.deepEqual(started, ['夜间1', '夜间2']);
  const usage = gateway.usage();
  assert.equal(usage.nearby.expired, 1); assert.equal(usage.background.expired, 1);
  assert.equal(usage.nearby.calls, 0); assert.equal(usage.nightly.calls, 2);
});

test('a request cancelled while queued leaves the queue; an already cancelled one is never queued', async () => {
  const gateway = new ModelGateway({ maxConcurrent: 1 });
  const { model, started, release } = held();
  const busy = ask(gateway, 'dialogue', model, '对话1');
  await tick();
  const cancel = new AbortController();
  const cancelled = ask(gateway, 'dialogue', model, '对话2', cancel.signal);
  const next = ask(gateway, 'nearby', model, '附近');
  cancel.abort(new Error('玩家关掉了对话'));
  await assert.rejects(cancelled, /玩家关掉了对话/);
  await assert.rejects(ask(gateway, 'dialogue', model, '对话3', cancel.signal), /玩家关掉了对话/);
  release('对话1'); await busy; await tick();
  release('附近'); await next;
  assert.deepEqual(started, ['对话1', '附近']);
  assert.equal(gateway.usage().dialogue.calls, 1);
});

test('model errors reach the caller unchanged and free the slot', async () => {
  const gateway = new ModelGateway({ maxConcurrent: 1 });
  const { model, started, release } = held();
  const bad = ask(gateway, 'nearby', model, '坏的');
  const next = ask(gateway, 'nearby', model, '附近');
  await tick(); release('坏的');
  await assert.rejects(bad, /HTTP 500/);
  await tick(); release('附近'); await next;
  assert.deepEqual(started, ['坏的', '附近']);
  assert.equal(gateway.usage().nearby.failed, 1);
  assert.equal(gateway.usage().nearby.calls, 2);
});

test('usage adds up by tier, is reported in one line and starts again from zero', async () => {
  const gateway = new ModelGateway();
  const usage = (input: number, cached: number | null, output: number): ChatModel => ({ async chat() {
    return done({ inputTokens: input, outputTokens: output, cachedInputTokens: cached, reasoningTokens: null }); } });
  for (let i = 0; i < 3; i++) await ask(gateway, 'dialogue', usage(12_000, 9_000, 1_000), '对话');
  await ask(gateway, 'nearby', usage(500, null, 90), '附近');
  await ask(gateway, 'nightly', { async chat() { return done(null); } }, '夜间');
  assert.equal(gateway.report(12),
    '第 12 天模型用量：对话 3 次 输入 36,000（缓存 27,000）输出 3,000；附近 1 次 输入 500（缓存 0）输出 90；夜间（前一晚）1 次 输入 0（缓存 0）输出 0');
  assert.equal(gateway.report(13), '第 13 天模型用量：没有调用');
  assert.equal(gateway.usage().dialogue.calls, 0);
});

test('the backend logs the usage once per new save, not for a repeated save notice', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'stardew-gateway-'));
  const roster = new Roster({ directory: resolve(import.meta.dirname, '../data/npcs'), npcIds: SOCIAL_NPCS });
  await roster.load();
  const gateway = new ModelGateway();
  const logs: string[] = [];
  const server = await BridgeServer.start({ roster, model: gateway.lane('dialogue', fakeModel().model), gateway, memoryDirectory: directory, port: 0,
    log: line => logs.push(line) });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const wire = await connect(server);
  wire.send(openTalk()); await wire.until('talk.reply');
  const commit = await sleep(wire);
  wire.send({ type: 'save.saved', commitId: commit.commitId, date: { ...wire.loaded.date, day: 2 } }); await wire.until('ack', wire.inbox.length);
  assert.deepEqual(logs.filter(line => line.includes('模型用量')), ['第 1 天模型用量：对话 1 次 输入 0（缓存 0）输出 0']);
  await wire.close();
});
