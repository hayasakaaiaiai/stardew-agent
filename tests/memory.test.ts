import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createRuntime, consolidateCommit, SOCIAL_NPCS } from '../src/index.ts';
import type { DayEntry } from '../src/types.ts';
import { digest } from '../src/validation.ts';

const now = { nowGameTime: 5000 };

async function fixture(npcIds: readonly string[] = ['abigail', 'sebastian']) {
  const directory = await mkdtemp(join(tmpdir(), 'stardew-agent-test-'));
  const config = { databasePath: join(directory, 'memory.sqlite'), journalDirectory: join(directory, 'scratch'), npcIds };
  const runtime = await createRuntime(config);
  return { directory, config, runtime, async close() { await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}

function entry(seq: number, npcId: string, text: string): DayEntry {
  return { seq, gameTime: 1440 + seq, changes: [{ npcId, memories: [{ text }] }] };
}

test('all social NPCs share one runtime while maintaining distinct sessions', async () => {
  const f = await fixture(SOCIAL_NPCS);
  try {
    const save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'load-1', day: 1 });
    assert.equal(save.agents.size, 34);
    const workerId = f.runtime.ctx.store.workerId;
    await Promise.all(SOCIAL_NPCS.map((npcId, index) => save.agent(npcId).record({
      seq: index + 1, gameTime: 1500 + index, state: { mood: npcId },
      memories: [{ text: `这是 ${npcId} 的独立记忆`, topics: ['测试'] }],
    })));
    const contexts = await Promise.all(SOCIAL_NPCS.map(npcId => save.agent(npcId).context({ ...now, topics: ['测试'] })));
    for (const [index, context] of contexts.entries()) {
      assert.equal(context.state.mood, SOCIAL_NPCS[index]);
      assert.equal(context.memories.length, 1);
      assert.equal(context.memories[0]!.npcId, SOCIAL_NPCS[index]);
    }
    assert.equal(f.runtime.ctx.store.workerId, workerId);
    await save.prepare('all-npcs'); await save.confirm('all-npcs');
    await save.startDay(2);
    assert.equal(save.agents.size, 34);
    assert.equal((await save.agent('wizard').context(now)).state.mood, 'wizard');
  } finally { await f.close(); }
});

test('an unsaved conversation and both NPCs’ derived state roll back together', async () => {
  const f = await fixture();
  try {
    let save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'first', day: 1 });
    const rootId = save.ledger.head.id;
    await save.record({ seq: 1, gameTime: 1500, changes: [
      { npcId: 'abigail', state: { mood: 'happy', plans: ['晚上去海边'] }, memories: [{ text: '我告诉 Sebastian 一个秘密' }] },
      { npcId: 'sebastian', state: { mood: 'curious' }, memories: [{ text: 'Abigail 告诉我一个秘密', kind: 'heard' }] },
    ] });
    const oldAgent = save.agent('abigail');
    assert.equal((await oldAgent.context(now)).state.mood, 'happy');
    await f.runtime.ctx.saves.returnToTitle('farm');
    assert.equal(oldAgent.signal.aborted, true);
    save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'second', day: 1, commitId: rootId });
    for (const npc of ['abigail', 'sebastian']) {
      const context = await save.agent(npc).context(now);
      assert.deepEqual(context.state, {});
      assert.deepEqual(context.memories, []);
    }
    assert.throws(() => oldAgent.record({ seq: 2, gameTime: 1600, memories: [{ text: '迟到结果' }] }), /frozen|unloaded/);
  } finally { await f.close(); }
});

test('confirmed days persist, raw logs are scoped, and caller mutations cannot alter history', async () => {
  const f = await fixture();
  try {
    let save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'one', day: 1 });
    const event = entry(1, 'abigail', '玩家喜欢海边');
    const recorded = save.record(event);
    event.changes[0]!.memories![0]!.text = '调用方后来改了这段文字';
    await recorded;
    await save.prepare('C1'); await save.confirm('C1');
    save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'two', day: 2, commitId: 'C1' });
    const context = await save.agent('abigail').context({ ...now, query: '海边' });
    assert.equal(context.memories[0]!.text, '玩家喜欢海边');
    assert.equal(context.memories[0]!.commitId, 'C1');
    assert.deepEqual(context.today, []);
    const input = await f.runtime.ctx.store.call('consolidationInput', { lineageId: 'farm', commitId: 'C1', npcIds: ['abigail', 'sebastian'] });
    assert.equal(input.npcs[0]!.logs.length, 1);
    assert.equal(input.npcs[1]!.logs.length, 0);
    context.memories[0]!.text = '调用方篡改返回值';
    assert.equal((await save.agent('abigail').recall({ ...now, query: '海边' }))[0]!.text, '玩家喜欢海边');
  } finally { await f.close(); }
});

test('restoring an old game save creates a branch and never recalls the abandoned future', async () => {
  const f = await fixture();
  try {
    let save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'original', day: 1 });
    await save.record(entry(1, 'abigail', '共同的海边经历'));
    await save.prepare('C1'); await save.confirm('C1'); await save.startDay(2);
    await save.record(entry(2, 'abigail', '原来分支里去过矿洞'));
    await save.prepare('C2'); await save.confirm('C2');
    save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'replay', day: 2, commitId: 'C1' });
    assert.deepEqual(await save.agent('abigail').recall({ ...now, query: '矿洞' }), []);
    await save.record(entry(1, 'abigail', '新的分支里去了森林'));
    await save.prepare('C2-new'); await save.confirm('C2-new');
    save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'new-branch', day: 3, commitId: 'C2-new' });
    assert.equal((await save.agent('abigail').recall({ ...now, query: '森林' })).length, 1);
    assert.deepEqual(await save.agent('abigail').recall({ ...now, query: '矿洞' }), []);
    save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'old-branch', day: 3, commitId: 'C2' });
    assert.equal((await save.agent('abigail').recall({ ...now, query: '矿洞' })).length, 1);
    assert.deepEqual(await save.agent('abigail').recall({ ...now, query: '森林' }), []);
  } finally { await f.close(); }
});

test('two loaded lineages and their NPC handles remain isolated', async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all(['farm-a', 'farm-b'].map(lineageId => f.runtime.ctx.saves.load({ lineageId, loadNonce: 'same-nonce', day: 1 })));
    await Promise.all([a!.record(entry(1, 'abigail', '只有甲存档认识海边朋友')), b!.record(entry(1, 'abigail', '只有乙存档认识矿洞朋友'))]);
    assert.deepEqual(await a!.agent('abigail').recall({ ...now, query: '矿洞' }), []);
    assert.deepEqual(await b!.agent('abigail').recall({ ...now, query: '海边' }), []);
    assert.deepEqual(await a!.agent('sebastian').recall(now), []);
    await a!.prepare('farm-a-C1'); await a!.confirm('farm-a-C1');
    await assert.rejects(f.runtime.ctx.saves.load({ lineageId: 'farm-b', loadNonce: 'bad-pointer', day: 2, commitId: 'farm-a-C1' }));
  } finally { await f.close(); }
});

test('Chinese two-character recall, topic filters, privacy, and output budgets apply before results leave the store', async () => {
  const f = await fixture();
  try {
    const save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'search', day: 1 });
    await save.record({ seq: 1, gameTime: 1500, changes: [{ npcId: 'abigail', memories: [
      { text: '玩家邀请我明天去海边散步', topics: ['邀约'], importance: 5 },
      { text: '海边今天有很多贝壳', visibility: 'normal', topics: ['观察'] },
      { text: '另一个私人话题', importance: 5 },
    ] }] });
    const pending = await save.agent('abigail').recall({ ...now, query: '海边' });
    assert.equal(pending.length, 2);
    await save.prepare('search-C1'); await save.confirm('search-C1'); await save.startDay(2);
    const committed = await save.agent('abigail').recall({ ...now, query: '海边' });
    assert.deepEqual(committed.map(item => item.id), pending.map(item => item.id));
    const shared = await save.agent('abigail').recall({ ...now, query: '海边', sharedScene: true, limit: 1 });
    assert.equal(shared.length, 1); assert.equal(shared[0]!.visibility, 'normal');
    const topic = await save.agent('abigail').recall({ ...now, topics: ['邀约'] });
    assert.equal(topic.length, 1); assert.equal(topic[0]!.importance, 5);
    assert.deepEqual(await save.agent('abigail').recall({ ...now, maxChars: 1 }), []);
    assert.deepEqual(await save.agent('abigail').recall({ ...now, query: '" NOT * : ;' }), []);
    await assert.rejects(save.agent('abigail').recall({ ...now, limit: 5000 }), /budget/);
  } finally { await f.close(); }
});

test('prepare is a synchronous admission barrier and confirmation cannot outrun queued preparation', async () => {
  const f = await fixture();
  try {
    const save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'freeze', day: 1 });
    const admitted = save.record(entry(1, 'abigail', '存档之前已接收的事件'));
    const prepare = save.prepare('freeze-C1');
    assert.equal(save.agent('abigail').signal.aborted, true);
    assert.throws(() => save.record(entry(2, 'abigail', '存档之后才返回的模型结果')), /frozen/);
    const confirm = save.confirm('freeze-C1');
    await Promise.all([admitted, prepare, confirm]);
    await save.startDay(2);
    assert.equal((await save.agent('abigail').recall(now)).length, 1);
    assert.equal(save.agent('abigail').signal.aborted, false);
    assert.equal((await save.confirm('freeze-C1').catch(() => null)), null);
  } finally { await f.close(); }
});

test('prepared data is readable only if the actual game save points to that commit', async () => {
  const f = await fixture();
  try {
    let save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'prepare', day: 1 });
    const rootId = save.ledger.head.id;
    await save.record(entry(1, 'abigail', '存档临界点的记忆'));
    await save.prepare('maybe-saved');
    await assert.rejects(f.runtime.ctx.store.call('state', { lineageId: 'farm', headCommitId: 'maybe-saved', npcId: 'abigail' }), /Prepared/);
    save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'game-not-saved', day: 1, commitId: rootId });
    assert.deepEqual(await save.agent('abigail').recall(now), []);
    save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'game-did-save', day: 2, commitId: 'maybe-saved' });
    assert.equal(save.ledger.head.status, 'confirmed');
    assert.equal((await save.agent('abigail').recall(now)).length, 1);
  } finally { await f.close(); }
});

test('event replays are idempotent and divergent/out-of-order replays are rejected', async () => {
  const f = await fixture();
  try {
    const save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'dedupe', day: 1 });
    const original = entry(2, 'abigail', '只记一次的事情');
    await save.record(original); await save.record(original);
    await assert.rejects(save.record(entry(2, 'abigail', '同一个序号不同内容')), /different/);
    await assert.rejects(save.record(entry(1, 'abigail', '过期的未接收事件')), /increasing/);
    assert.equal((await save.agent('abigail').recall(now)).length, 1);
    await save.prepare('dedupe-C1'); await save.prepare('dedupe-C1');
    assert.throws(() => save.prepare('different-id'), /already/);
    await save.confirm('dedupe-C1');
    await save.confirm('dedupe-C1');
  } finally { await f.close(); }
});

test('retirements are versioned, and cannot hide another NPC’s memory', async () => {
  const f = await fixture();
  try {
    let save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'retire', day: 1 });
    await save.record(entry(1, 'abigail', '逐渐不再想起的海边经历'));
    await save.prepare('retire-C1'); await save.confirm('retire-C1'); await save.startDay(2);
    const memory = (await save.agent('abigail').recall(now))[0]!;
    await assert.rejects(save.agent('sebastian').record({ seq: 2, gameTime: 3000, retireMemoryIds: [memory.id] }), /this NPC/);
    await save.agent('abigail').record({ seq: 2, gameTime: 3000, retireMemoryIds: [memory.id] });
    assert.deepEqual(await save.agent('abigail').recall(now), []);
    await save.prepare('retire-C2'); await save.confirm('retire-C2');
    save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'before-retirement', day: 2, commitId: 'retire-C1' });
    assert.equal((await save.agent('abigail').recall(now)).length, 1);
    save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'after-retirement', day: 3, commitId: 'retire-C2' });
    assert.deepEqual(await save.agent('abigail').recall(now), []);
  } finally { await f.close(); }
});

test('consolidation is immutable and its input and results stay on the source branch', async () => {
  const f = await fixture();
  try {
    let save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'consolidate', day: 1 });
    const rootId = save.ledger.head.id;
    await save.record(entry(1, 'abigail', '第一天一起去过海边'));
    await save.prepare('summary-C1'); await save.confirm('summary-C1'); await save.startDay(2);
    await save.record(entry(2, 'abigail', '第二天才发生的未来经历'));
    const input = await f.runtime.ctx.store.call('consolidationInput', { lineageId: 'farm', commitId: 'summary-C1', npcIds: ['abigail'] });
    assert.equal(input.npcs[0]!.logs.length, 1);
    assert.equal(JSON.stringify(input).includes('未来经历'), false);
    const output = { lineageId: 'farm', commitId: 'summary-C1', changes: [{ npcId: 'abigail',
      state: { mood: 'happy', plans: ['以后还想去海边'] }, memories: [{ text: '我与玩家因海边散步更亲近', kind: 'summary' as const }] }] };
    await f.runtime.ctx.store.call('consolidate', output);
    await f.runtime.ctx.store.call('consolidate', output);
    await assert.rejects(f.runtime.ctx.store.call('consolidate', { ...output, changes: [{ npcId: 'abigail', state: { mood: 'different' } }] }), /overwritten/);
    save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'same-C1', day: 2, commitId: 'summary-C1' });
    assert.equal((await save.agent('abigail').context(now)).state.mood, 'happy');
    assert.deepEqual(await save.agent('abigail').recall({ ...now, query: '未来经历' }), []);
    save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'before-C1', day: 1, commitId: rootId });
    assert.deepEqual((await save.agent('abigail').context(now)).state, {});
    assert.deepEqual(await save.agent('abigail').recall(now), []);
  } finally { await f.close(); }
});

test('one invalid NPC change rolls back the entire SQL commit, including its FTS index', async () => {
  const f = await fixture();
  try {
    const root = await f.runtime.ctx.store.call('root', 'farm');
    const snapshot = { lineageId: 'farm', loadNonce: 'atomic', baseCommitId: root.id, day: 1, entries: [{ seq: 1, gameTime: 1500, changes: [
      { npcId: 'abigail', memories: [{ text: '不该半提交的海边记忆' }] },
      { npcId: 'sebastian', retireMemoryIds: ['nonexistent-memory'] },
    ] }] };
    await assert.rejects(f.runtime.ctx.store.call('prepare', { commitId: 'invalid-C1', snapshot }), /this NPC/);
    assert.equal(await f.runtime.ctx.store.call('getCommit', { lineageId: 'farm', commitId: 'invalid-C1' }), null);
    const scope = { lineageId: 'farm', headCommitId: root.id, npcId: 'abigail' };
    assert.deepEqual(await f.runtime.ctx.store.call('search', { scope, query: '海边', topics: [], sharedScene: false, limit: 8 }), []);
  } finally { await f.close(); }
});

test('a reconnect in the same running game retains its open session and pending events', async () => {
  const f = await fixture();
  try {
    const input = { lineageId: 'farm', loadNonce: 'reconnect', day: 1 };
    const first = await f.runtime.ctx.saves.load(input);
    await first.record(entry(1, 'abigail', '重连之前聊过海边'));
    const second = await f.runtime.ctx.saves.load(input);
    assert.equal((await second.agent('abigail').recall(now)).length, 1);
    assert.equal(first.agent('abigail').signal.aborted, false);
  } finally { await f.close(); }
});

test('a shared scene cannot receive private state or raw private dialogue through context', async () => {
  const f = await fixture();
  try {
    const save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'private-context', day: 1 });
    await save.agent('abigail').record({ seq: 1, gameTime: 1500,
      state: { privateWorry: '我的秘密不能告诉 Sebastian' }, log: { playerSaid: '另一个秘密' },
      memories: [{ text: '不能透露的私人记忆' }, { text: '公开的海边观察', visibility: 'normal' }] });
    const shared = await save.agent('abigail').context({ ...now, sharedScene: true });
    assert.deepEqual(shared.state, {}); assert.deepEqual(shared.today, []);
    assert.equal(shared.memories.length, 1);
    assert.equal(JSON.stringify(shared).includes('秘密'), false);
  } finally { await f.close(); }
});

test('a full day can exceed one megabyte without failing only when it is time to save', async () => {
  const f = await fixture();
  try {
    const save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'long-day', day: 1 });
    for (let seq = 1; seq <= 70; seq++) await save.agent('abigail').record({ seq, gameTime: 1500 + seq,
      log: { text: '完整对话'.repeat(1900) }, memories: [{ text: '值得保留的经历'.repeat(1000) }] });
    await save.prepare('long-C1'); await save.confirm('long-C1'); await save.startDay(2);
    assert.equal((await save.agent('abigail').recall({ ...now, maxChars: 100_000, limit: 50 })).length > 0, true);
  } finally { await f.close(); }
});

test('the consolidation adapter skips completed commits and rejects a late cancelled result', async () => {
  const f = await fixture();
  try {
    const save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'adapter', day: 1 });
    await save.record(entry(1, 'abigail', '已保存的日常对话'));
    await save.prepare('adapter-C1'); await save.confirm('adapter-C1');
    const request = { lineageId: 'farm', commitId: 'adapter-C1', npcIds: ['abigail'] };
    const controller = new AbortController();
    let resolveModel!: (value: []) => void;
    let modelStarted!: () => void;
    const started = new Promise<void>(resolve => { modelStarted = resolve; });
    const pending = consolidateCommit(f.runtime.ctx.store, request, async () => {
      modelStarted();
      return new Promise<[]>(resolve => { resolveModel = resolve; });
    }, controller.signal);
    await started;
    controller.abort(new Error('Game session closed')); resolveModel([]);
    await assert.rejects(pending, /closed/);
    let calls = 0;
    const model = async () => { calls++; return []; };
    await consolidateCommit(f.runtime.ctx.store, request, model);
    await consolidateCommit(f.runtime.ctx.store, request, model);
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test('the consolidation model sees only one NPC’s private history at a time', async () => {
  const f = await fixture();
  try {
    const save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'private-summary', day: 1 });
    await save.record({ seq: 1, gameTime: 1500, changes: [
      { npcId: 'abigail', log: { secret: '阿比盖尔的私人担忧' } },
      { npcId: 'sebastian', log: { secret: '塞巴斯蒂安的私人担忧' } },
    ] });
    await save.prepare('private-summary-C1'); await save.confirm('private-summary-C1');
    const seen: string[] = [];
    await consolidateCommit(f.runtime.ctx.store, { lineageId: 'farm', commitId: 'private-summary-C1', npcIds: ['abigail', 'sebastian'] }, async input => {
      assert.equal(input.npcs.length, 1);
      const npc = input.npcs[0]!;
      const hidden = npc.npcId === 'abigail' ? '塞巴斯蒂安的私人担忧' : '阿比盖尔的私人担忧';
      assert.equal(JSON.stringify(input).includes(hidden), false);
      seen.push(npc.npcId);
      return [{ npcId: npc.npcId, state: { mood: 'calm' } }];
    });
    assert.deepEqual(seen, ['abigail', 'sebastian']);
  } finally { await f.close(); }
});

test('a different base commit or game day cannot recover an old pending journal with the same nonce', async () => {
  const f = await fixture();
  let next: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    const save = await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'same-nonce', day: 1 });
    await save.record(entry(1, 'abigail', '不同日期不该恢复的内容'));
    await f.runtime.close();
    next = await createRuntime(f.config);
    const loaded = await next.ctx.saves.load({ lineageId: 'farm', loadNonce: 'same-nonce', day: 2 });
    assert.deepEqual(await loaded.agent('abigail').recall(now), []);
  } finally { await next?.close(); await f.close(); }
});

test('a killed backend recovers only the same load, tolerates a torn tail, and deduplicates retransmission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stardew-agent-crash-'));
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  const child = fork(new URL('./fixtures/crash-writer.ts', import.meta.url), [directory], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  try {
    const ready = await Promise.race([
      once(child, 'message').then(([message]) => message as { baseCommitId: string }),
      once(child, 'exit').then(([code]) => { throw new Error(`Crash fixture exited early (${String(code)}): ${stderr}`); }),
    ]);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const scratch = join(directory, 'scratch');
    const [folder] = await readdir(scratch);
    const [filename] = await readdir(join(scratch, folder!));
    const journalPath = join(scratch, folder!, filename!);
    await appendFile(journalPath, '{"seq":2,"partial":');
    const config = { databasePath: join(directory, 'memory.sqlite'), journalDirectory: scratch, npcIds: ['abigail', 'sebastian'] };
    runtime = await createRuntime(config);
    let save = await runtime.ctx.saves.load({ lineageId: 'crash-farm', loadNonce: 'same-running-game', day: 1, commitId: ready.baseCommitId });
    assert.equal((await save.agent('abigail').recall({ ...now, query: '海边' })).length, 1);
    const original = entry(1, 'abigail', '进程崩溃之前聊过海边');
    await save.record(original);
    assert.equal((await save.agent('abigail').recall(now)).length, 1);
    assert.equal((await readFile(journalPath, 'utf8')).includes('partial'), false);
    await runtime.close();
    runtime = await createRuntime(config);
    save = await runtime.ctx.saves.load({ lineageId: 'crash-farm', loadNonce: 'a-new-game-load', day: 1, commitId: ready.baseCommitId });
    assert.deepEqual(await save.agent('abigail').recall(now), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a new load after a backend restart deletes the journals of that save’s other loads, and nothing else', async () => {
  const f = await fixture();
  let next: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    await (await f.runtime.ctx.saves.load({ lineageId: 'farm', loadNonce: 'before-restart', day: 1 })).record(entry(1, 'abigail', '重启前没保存的'));
    await (await f.runtime.ctx.saves.load({ lineageId: 'other-farm', loadNonce: 'still-running', day: 1 })).record(entry(1, 'abigail', '另一个存档的'));
    await f.runtime.close();
    const farm = join(f.config.journalDirectory, digest('farm'));
    await writeFile(join(farm, 'notes.txt'), '不是日志');
    assert.deepEqual((await readdir(farm)).sort(), [`${digest('before-restart')}.jsonl`, 'notes.txt'].sort());

    next = await createRuntime(f.config);
    const fresh = await next.ctx.saves.load({ lineageId: 'farm', loadNonce: 'after-restart', day: 1 });
    assert.deepEqual(await fresh.agent('abigail').recall(now), []);
    assert.deepEqual((await readdir(farm)).sort(), [`${digest('after-restart')}.jsonl`, 'notes.txt'].sort());
    const other = await next.ctx.saves.load({ lineageId: 'other-farm', loadNonce: 'still-running', day: 1 });
    assert.equal((await other.agent('abigail').recall(now)).length, 1, 'another save’s pending day is untouched and still recovers');
  } finally { await next?.close(); await f.close(); }
});
