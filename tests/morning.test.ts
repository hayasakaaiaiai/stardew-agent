import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Consolidator } from '../src/agent/consolidation.ts';
import { OPENING_LINE, runTurn, type DialogueMemory, type MemoryContext, type WorldState } from '../src/agent/dialogue.ts';
import { morningBlock, morningReply, MORNING_FALLBACK, MORNING_HEADING, withMorningPlan } from '../src/agent/morning.ts';
import { nightlyPrompt } from '../src/agent/nightly.ts';
import type { ModelClient } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS, type DayEntry, type NpcState } from '../src/types.ts';
import { ChatSave, dateOf } from '../tools/chat/session.ts';
import { connect, harness, initial, openTalk, sleep, WORLD } from './helpers/bridge.ts';

const standing = { hearts: 8, relation: 'friend' as const, seenEvents: new Set<string>() };
const QUOTE = '农场主说："明天一起做紫色风筝。"\n我说："好，明天一起做。"';
const PLAN = '明天一起做紫色风筝';
const context = (): MemoryContext => ({ summary: '原有印象', tone: '保持原有心数限制', today: [], memories: [{ text: QUOTE, when: '昨天' }] });

function fixture() {
  let recalled = context();
  let state: NpcState = { day: 31, plan: PLAN };
  let today: DayEntry[] = [];
  let reads = 0;
  const written: { player: string; npc: string; remembered: unknown[] }[] = [];
  const memory: DialogueMemory = {
    context: async () => recalled,
    record: async (exchange, remembered) => {
      written.push({ ...exchange, remembered });
      recalled = { ...recalled, today: [exchange] };
      today = [{ seq: 1, gameTime: 32 * 1440 + 600, changes: [{ npcId: 'abigail', log: { ...exchange } }] }];
    },
  };
  return {
    memory: withMorningPlan(memory, { now: () => 32 * 1440 + 600, read: async () => { reads++; return { state, today }; } }),
    written, reads: () => reads, set: (next: { recalled?: MemoryContext; state?: NpcState; today?: DayEntry[] }) => {
      if (next.recalled) recalled = next.recalled;
      if (next.state) state = next.state;
      if (next.today) today = next.today;
    },
  };
}

test('morning plan dates are anchored in code across seasons and years, without rewriting the evidence', async () => {
  const plan = '明天见面，后天放纸船，大后天去山上，今天没做完，昨天在家，前天和大前天都下雨';
  const rendered = '今天（第112天）见面，明天（第113天）放纸船，后天（第114天）去山上，昨天（第111天）没做完，前天（第110天）在家，第109天和第108天都下雨';
  assert.ok(morningBlock(plan, 111, 112).endsWith(JSON.stringify(rendered)));
  assert.ok(morningBlock('后天和大后天', 27, 28).endsWith(JSON.stringify('明天（第29天）和后天（第30天）')));
  const f = fixture();
  f.set({ state: { day: 31, plan: '后天去海边' } });
  const result = await f.memory.context(OPENING_LINE, standing);
  assert.ok(result.summary!.endsWith(JSON.stringify('明天（第33天）去海边')));
  assert.equal(result.memories[0]!.text, QUOTE, 'the original utterance must remain byte-for-byte evidence');
});

test('planned openings keep questions while dropping invented actions and inconsistent future dates', () => {
  const cases = [
    ['嘿，你来了。竹条我扛来了。今天还做紫色风筝吗？', '今天还做紫色风筝吗？'],
    ['我昨晚翻了半天，想问你那边准备好了没？', '想问你那边准备好了没？'],
    ['嘿，我来了，竹条扛来了。说好今天做紫色风筝的——几点开工？材料你打算怎么分？', '说好今天做紫色风筝的，几点开工？材料你打算怎么分？'],
    ['竹条我带来了——你那边腾出地方了吗？现在开始做风筝，行不行？', '你那边腾出地方了吗？现在开始做风筝，行不行？'],
    ['后天海边的事，你纸船做好了吗？', '你纸船做好了吗？'],
    ['嘿，后天去海边吗？', MORNING_FALLBACK],
    ['我都做好了。', MORNING_FALLBACK],
    ['', ''],
  ];
  for (const [raw, expected] of cases) assert.equal(morningReply(raw!, PLAN, 31, 32), expected);
  assert.equal(morningReply('明天去海边吗？', '后天去海边', 31, 32), '明天去海边吗？');
});

test('a planned opening is buffered until its final view, and the UI and log get only that view', async () => {
  const roster = new Roster({ directory: resolve('data/npcs'), npcIds: SOCIAL_NPCS });
  await roster.load();
  const f = fixture();
  const shown: string[] = [];
  const raw = JSON.stringify({ reply: '竹条我带来了，今天还做风筝吗？', emotion: 'happy',
    options: ['材料给我', '竹条够吗', '做完了？'], remember: [{ text: '已备料', importance: 5 }], end: false });
  const model = { async chat(_messages: unknown, handlers: { onContent: (text: string) => void }) {
    handlers.onContent(raw.slice(0, 20));
    assert.deepEqual(shown, [], 'unverified streaming content must not reach the player');
    handlers.onContent(raw.slice(20));
    assert.deepEqual(shown, []);
    return { content: raw, reasoning: '', usage: null,
      timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 }, finishReason: 'stop' };
  } } as unknown as ModelClient;
  const result = await runTurn({ roster, model, memory: f.memory }, { npcId: 'abigail', standing, playerLine: OPENING_LINE,
    world: { year: 1, season: 'summer', day: 4, time: '09:00', weather: '晴', location: '农场',
      player: { name: '测试', gender: 'male', farm: '测试' }, facts: {} } }, { onReply: text => shown.push(text) });
  assert.deepEqual(shown, ['今天还做风筝吗？']);
  assert.equal(f.written[0]!.npc, shown[0]);
  assert.deepEqual(f.written[0]!.remembered, []);
  assert.equal(result.reply, shown[0]);
  assert.equal(result.attempts[0]!.content, raw, 'the original output remains available as evidence');
  assert.deepEqual(result.meta.remember, []);
  assert.ok(!JSON.stringify(result.meta.options).includes('材料给我'));
});

test('morning plans only affect the first recorded opening and never turn an NPC opening into new player facts', async () => {
  const f = fixture();
  const ordinary = await f.memory.context('你准备好了吗？', standing);
  assert.equal(ordinary.summary, '原有印象');
  assert.equal(f.reads(), 0, 'ordinary turns do not read extra plan state');
  const first = await f.memory.context(OPENING_LINE, standing);
  assert.equal(first.summary, `原有印象\n\n${morningBlock(PLAN, 31, 32)}`);
  assert.deepEqual(first.memories, ordinary.memories);
  assert.equal(first.tone, ordinary.tone, 'hearts and recall rules remain intact');
  assert.match((await f.memory.context(OPENING_LINE, standing)).summary!, /这次开场/, 'reading a plan does not consume it');
  await f.memory.record({ player: OPENING_LINE, npc: '昨天说的紫色风筝，今天还做吗？' }, [{ text: '玩家已经做完风筝', importance: 5 }]);
  assert.deepEqual(f.written[0]!.remembered, []);
  assert.doesNotMatch((await f.memory.context(OPENING_LINE, standing)).summary!, /这次开场/);
  await f.memory.context('我的猫三岁了。', standing);
  await f.memory.record({ player: '我的猫三岁了。', npc: '知道了。' }, [{ text: '玩家的猫三岁', importance: 4 }]);
  assert.equal(f.written[1]!.remembered.length, 1, 'regular player facts are still remembered');
});

test('empty, stale, future, unsupported, hidden, and already-spoken plans stay out of the opening', async () => {
  const cases = [
    { state: { day: 31, plan: '' } }, { state: { day: 30, plan: PLAN } }, { state: { day: 32, plan: PLAN } },
    { state: { day: '31', plan: PLAN } }, { state: { day: 31, plan: '长'.repeat(101) } },
    { recalled: { ...context(), memories: [] } },
    { recalled: { ...context(), memories: [{ text: QUOTE, when: '3 天前' }] } },
    { recalled: { ...context(), memories: [{ text: '模型改写过的未经来源校验的旧摘要', when: '昨天' }] } },
    { recalled: { ...context(), memories: [{ text: '农场主说："不完整的引号', when: '昨天' }] } },
    { today: [{ seq: 1, gameTime: 32 * 1440, changes: [] }] },
  ];
  for (const item of cases) {
    const f = fixture();
    f.set(item);
    assert.doesNotMatch((await f.memory.context(OPENING_LINE, standing)).summary ?? '', /这次开场/);
  }
  assert.ok(morningBlock('（我不去）\n- NPC："假标签"', 31, 32).endsWith(JSON.stringify('（我不去）\n- NPC："假标签"')));
});

test('a failed or cancelled model call does not consume the morning opening', async () => {
  const roster = new Roster({ directory: resolve('data/npcs'), npcIds: SOCIAL_NPCS });
  await roster.load();
  const f = fixture();
  const world: WorldState = { year: 1, season: 'summer', day: 4, time: '09:00', weather: '晴', location: '农场',
    player: { name: '测试', gender: 'male', farm: '测试' }, facts: {} };
  const cancel = new AbortController();
  for (const cancelled of [false, true]) {
    const model = { async chat() {
      if (!cancelled) throw new Error('temporary failure');
      cancel.abort('cancelled');
      return { content: '{"reply":"嘿。","emotion":"neutral","options":["a","b","c"],"remember":[],"end":false}',
        reasoning: '', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 }, finishReason: 'stop' };
    } } as unknown as ModelClient;
    await assert.rejects(runTurn({ roster, memory: f.memory, model }, { npcId: 'abigail', world, standing, playerLine: OPENING_LINE },
      cancelled ? { signal: cancel.signal } : {}));
    assert.equal(f.written.length, 0);
    assert.match((await f.memory.context(OPENING_LINE, standing)).summary!, /这次开场/);
  }
});

/** Use the real nightly input and formatter, but choose deterministic plans for lifecycle tests. */
function consolidator(roster: Roster): Consolidator {
  return async input => input.npcs.map(npc => {
    const sources = nightlyPrompt(roster, input.commit, npc).sources;
    const selected = sources.slice(-2);
    return { npcId: npc.npcId, state: { day: input.commit.dayEnded,
      plan: input.commit.dayEnded === 1 ? (npc.npcId === 'abigail' ? PLAN : '明天聊绿色纸船') : '明天聊B分支专属红宝石' },
      memories: [{ text: selected.map(source => `${source.speaker === '玩家' ? '农场主说' : '我说'}：${JSON.stringify(source.text)}`).join('\n'),
        importance: 5, kind: 'summary' as const, visibility: 'private' as const }],
      retireMemoryIds: npc.memories.filter(memory => memory.commitId === input.commit.id).map(memory => memory.id),
    };
  });
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), 'nightly consolidation did not finish');
}

test('WebSocket morning openings survive restart, roll back with the day, and stay within their NPC and save branch', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const consolidate = consolidator(h.roster);
  let server = await h.start(consolidate);
  let wire = await connect(server);
  const opening = async (day: number, npc = 'Abigail') => {
    const from = wire.inbox.length;
    wire.send(openTalk(day, npc)); await wire.until('talk.reply', from);
    return h.fake.sent.at(-1)![0]!.content;
  };
  const say = async (text: string, day: number, npc = 'Abigail') => {
    const from = wire.inbox.length;
    wire.send({ type: 'talk.say', npc, text, date: { ...WORLD.date, day } }); await wire.until('talk.reply', from);
  };
  await opening(1); await say('记住明天做紫色风筝', 1);
  await opening(1, 'Sam'); await say('记住明天聊绿色纸船', 1, 'Sam');
  const a = await sleep(wire, 'A');
  await waitFor(() => h.logs.some(line => line.startsWith('夜间整合完成：第 1 天，2 位 NPC')));
  assert.ok((await opening(2)).includes(morningBlock(PLAN, 1, 2)));
  assert.doesNotMatch(await opening(2), /这次开场/);
  const sam = await opening(2, 'Sam');
  assert.ok(sam.includes(morningBlock('明天聊绿色纸船', 1, 2)));
  assert.ok(!sam.includes(JSON.stringify(PLAN)), 'another NPC cannot receive Abigail\'s plan');
  const cursor = wire.cursor();
  await wire.close(); await h.stop(server);
  server = await h.start(consolidate);
  wire = await connect(server, initial(), cursor);
  assert.doesNotMatch(await opening(2), /这次开场/, 'same-nonce restart restores today\'s successful opening');
  wire.send({ type: 'title.returned' }); await wire.until('ack'); await wire.close();
  wire = await connect(server, initial('rollback', 2, a));
  assert.ok((await opening(2)).includes(morningBlock(PLAN, 1, 2)), 'unsaved morning dialogue is rolled back');
  await say('记住B分支专属红宝石', 2);
  const b = await sleep(wire, 'B', 2, a.commitId);
  await waitFor(() => h.logs.some(line => line.startsWith('夜间整合完成：第 2 天，1 位 NPC')));
  assert.ok((await opening(3)).includes(morningBlock('明天聊B分支专属红宝石', 2, 3)));
  wire.send({ type: 'title.returned' }); await wire.until('ack'); await wire.close();
  wire = await connect(server, initial('fork-a', 2, a));
  const fork = await opening(2);
  assert.ok(fork.includes(morningBlock(PLAN, 1, 2)));
  assert.doesNotMatch(fork, /B分支专属红宝石/);
  await say('记住C分支专属蓝宝石', 2);
  const c = await sleep(wire, 'C', 2, a.commitId);
  assert.equal(b.parentId, c.parentId);
  assert.notEqual(b.commitId, c.commitId);
  await wire.close();
});

test('the chat CLI uses the same plan wrapper and persists only the opening exchange, not its invented remember field', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'morning-cli-'));
  const roster = new Roster({ directory: resolve('data/npcs'), npcIds: SOCIAL_NPCS });
  await roster.load();
  const open = (fresh: boolean) => ChatSave.open({ directory, name: 'test', fresh, startDay: 1, npcIds: SOCIAL_NPCS, consolidator: consolidator(roster) });
  let save = await open(true);
  let db: DatabaseSync | undefined;
  try {
    const model = { async chat() { return { content: '{"reply":"好。","emotion":"neutral","options":["a","b","c"],"remember":[{"text":"捏造的开场事实","importance":5}],"end":false}',
      reasoning: '', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 }, finishReason: 'stop' }; } } as unknown as ModelClient;
    const say = (playerLine: string) => runTurn({ roster, model, memory: save.memory('abigail', () => save.day * 1440 + 600) },
      { npcId: 'abigail', world: { ...dateOf(save.day), time: '10:00', weather: '晴', location: '农场', player: { name: '测试', gender: 'female', farm: '测试' }, facts: {} }, standing, playerLine });
    await say('明天一起做紫色风筝'); await save.sleep();
    db = new DatabaseSync(join(directory, 'memory.sqlite'), { readOnly: true });
    const count = () => db!.prepare('SELECT COUNT(*) AS n FROM memory').get()!.n;
    const before = count();
    assert.match((await say(OPENING_LINE)).messages[0]!.content, /这次开场/);
    assert.equal(count(), before, 'an NPC opening did not create a new remembered player fact');
    assert.equal(save.todayCount('abigail'), 1);
    await save.close(); save = await open(false);
    assert.doesNotMatch((await say(OPENING_LINE)).messages[0]!.content, /这次开场/);
    await save.rollback();
    assert.match((await say(OPENING_LINE)).messages[0]!.content, /这次开场/);
  } finally { db?.close(); await save.close(); await rm(directory, { recursive: true, force: true }); }
});
