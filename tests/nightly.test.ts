import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { nightlyConsolidator, NIGHTLY_RULES, parseNightly, type NightlyOutput } from '../src/agent/nightly.ts';
import { runTurn, type WorldState } from '../src/agent/dialogue.ts';
import type { ChatMessage, Completion, ModelClient, StreamHandlers } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';
import { absoluteDay, ChatSave, dateOf, minutesOf } from '../tools/chat/session.ts';
import { connect, deferred, harness, initial, openTalk, sleep, WORLD } from './helpers/bridge.ts';

const START: WorldState = {
  year: 1, season: 'spring', day: 17, time: '15:00', weather: '晴', location: '皮埃尔的杂货店',
  player: { name: '小林', gender: 'female', farm: '晴空' }, facts: {},
};
const standing = { hearts: 4, seenEvents: new Set<string>(), relation: 'friend' as const };

const completion = (content: string): Completion =>
  ({ content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } });

/** Dialogue replies that remember whatever follows “记住”. */
function dialogueModel() {
  const sent: ChatMessage[][] = [];
  const model = {
    async chat(messages: ChatMessage[], handlers: StreamHandlers): Promise<Completion> {
      sent.push(messages);
      const line = messages.at(-1)!.content;
      const remember = line.startsWith('记住') ? [{ text: line.slice(2, line.indexOf('（')), importance: 4 }] : [];
      const content = JSON.stringify({ reply: `好的${sent.length}`, emotion: 'neutral', options: ['a', 'b', 'c'], end: false, remember });
      handlers.onContent?.(content);
      return completion(content);
    },
  } as unknown as ModelClient;
  return { model, sent, system: () => sent.at(-1)![0]!.content };
}

/** Nightly answers in order; an Error is thrown, `gate` holds the call until released or aborted. */
function nightlyModel(answers: (string | Error)[], gate?: Promise<void>) {
  const sent: ChatMessage[][] = [];
  const model = {
    async chat(messages: ChatMessage[], _handlers: StreamHandlers, options: { signal?: AbortSignal }): Promise<Completion> {
      sent.push(messages);
      if (gate) await new Promise<void>((done, fail) => {
        options.signal?.addEventListener('abort', () => fail(options.signal!.reason));
        void gate.then(done);
      });
      const answer = answers[sent.length - 1] ?? '';
      if (answer instanceof Error) throw answer;
      return completion(answer);
    },
  } as unknown as ModelClient;
  return { model, sent, user: (i: number) => sent[i]![1]!.content };
}

const answer = (output: Partial<NightlyOutput>) => JSON.stringify({ memories: [], retire: [], impression: '', plan: '', ...output });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'nightly-'));
  const roster = new Roster({ directory: resolve(import.meta.dirname, '../data/npcs'), npcIds: SOCIAL_NPCS });
  await roster.load();
  const logs: string[] = [];
  const open = (nightly: ModelClient, fresh = false) => ChatSave.open({
    directory, name: 'test', fresh, startDay: absoluteDay(START), npcIds: SOCIAL_NPCS,
    consolidator: nightlyConsolidator({ roster, model: nightly, log: (line) => logs.push(line) }), log: (line) => logs.push(line),
  });
  return { directory, roster, logs, open };
}

function talk(roster: Roster, model: ModelClient, save: ChatSave) {
  const world = () => ({ ...START, ...dateOf(save.day) });
  const memory = save.memory('abigail', () => absoluteDay(world()) * 1440 + minutesOf(START.time), () => START.player);
  return (playerLine: string) => runTurn({ roster, model, memory }, { npcId: 'abigail', world: world(), standing, playerLine });
}

test('nightly output is clipped and defaulted, and unusable shapes are rejected', () => {
  assert.equal(parseNightly('不是 JSON'), undefined);
  assert.equal(parseNightly('{"memories":"一条","impression":"好"}'), undefined);
  assert.equal(parseNightly('{"memories":[],"retire":[]}'), undefined);
  const parsed = parseNightly(`好的：{"memories":[{"text":"${'长'.repeat(100)}","importance":9},{"text":" "},`
    + '{"text":"二","importance":2},{"text":"三"}],"impression":"好人","retire":["m1",2]}')!;
  assert.deepEqual(parsed, {
    memories: [{ text: '长'.repeat(80), importance: 3 }, { text: '二', importance: 2 }], retire: ['m1'], impression: '好人', plan: '',
  });
});

test('a night replaces its notes, retires what the model names, and the next day sees the impression but not the plan', async () => {
  const { directory, roster, open } = await setup();
  const nightly = nightlyModel([
    answer({ memories: [{ text: '玩家说农场太忙，一直没空养宠物', importance: 4 }], impression: '忙碌但真诚的人', plan: '想问她要不要养只猫' }),
    answer({ memories: [{ text: '玩家养了一只紫色小猫叫星糖', importance: 4 }], retire: ['m1', 'm7'], impression: '挺有意思的人', plan: '想看看星糖' }),
  ]);
  const save = await open(nightly.model, true);
  try {
    const dialogue = dialogueModel();
    const say = talk(roster, dialogue.model, save);
    await say('记住玩家还没养宠物');
    await save.sleep();
    const first = nightly.user(0);
    assert.match(first, /## 你是谁\n- 阿比盖尔，二十岁出头，皮埃尔和卡洛琳的独生女/);
    assert.match(first, /第 1 年春季 17 日\n- 农场主：小林（女）\n- 你对农场主的好感：4 心；关系：朋友/);
    assert.match(first, /## 你以前对农场主的印象\n还没有/);
    assert.match(first, /- 农场主：记住玩家还没养宠物.*\n- 你：好的1/);
    assert.match(first, /## 今天当场记下的\n- （重要度 4）玩家还没养宠物/);
    assert.match(first, /## 以前的记忆\n（没有）/);

    await say('你好');
    assert.match(dialogue.system(), /## 你记得的事\n- 你对农场主的整体印象：忙碌但真诚的人\n- （昨天）玩家说农场太忙，一直没空养宠物/);
    assert.doesNotMatch(dialogue.system(), /- （昨天）玩家还没养宠物/, "the day's own note was replaced");
    assert.doesNotMatch(dialogue.system(), /想问她要不要养只猫/, 'the plan stays out of dialogue');

    await say('记住玩家养了紫猫星糖');
    await save.sleep();
    const second = nightly.user(1);
    assert.match(second, /## 你以前对农场主的印象\n忙碌但真诚的人/);
    assert.match(second, /- m1（昨天，重要度 4）玩家说农场太忙，一直没空养宠物/);

    await say('早');
    assert.match(dialogue.system(), /整体印象：挺有意思的人/);
    assert.match(dialogue.system(), /玩家养了一只紫色小猫叫星糖/);
    assert.doesNotMatch(dialogue.system(), /没空养宠物/, 'm1 was retired; the unknown m7 was ignored');
    assert.equal(nightly.sent[0]![0]!.content, NIGHTLY_RULES);
    assert.equal(nightly.sent[1]![0]!.content, NIGHTLY_RULES, 'the system prompt is the same every night, for the prefix cache');
  } finally {
    await save.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an answer that cannot be parsed twice keeps that day as it was, and is not paid for again', async () => {
  const { directory, roster, logs, open } = await setup();
  const nightly = nightlyModel(['不是 JSON', '{"memories":"坏的"}']);
  let save = await open(nightly.model, true);
  try {
    const dialogue = dialogueModel();
    await talk(roster, dialogue.model, save)('记住玩家最喜欢下雨天');
    await save.sleep();
    assert.equal(nightly.sent.length, 2);
    assert.equal(logs.filter((line) => line.includes('无法解析')).length, 2);
    await save.close();
    save = await open(nightly.model);
    assert.equal(nightly.sent.length, 2, 'the commit counts as consolidated');
    await talk(roster, dialogue.model, save)('你好');
    assert.match(dialogue.system(), /- （昨天）玩家最喜欢下雨天/);
    assert.doesNotMatch(dialogue.system(), /整体印象/);
  } finally {
    await save.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a network failure leaves the night for the next load', async () => {
  const { directory, roster, logs, open } = await setup();
  let save = await open(nightlyModel([new TypeError('fetch failed')]).model, true);
  try {
    const dialogue = dialogueModel();
    await talk(roster, dialogue.model, save)('记住玩家下周要去城里');
    await save.sleep();
    assert.ok(logs.some((line) => line.startsWith('夜间整合失败')));
    await save.close();
    const retry = nightlyModel([answer({ memories: [{ text: '玩家下周要进城一趟', importance: 4 }], impression: '常跑来跑去的人' })]);
    save = await open(retry.model);
    assert.equal(retry.sent.length, 1, 'caught up when the save was loaded');
    await talk(roster, dialogue.model, save)('你好');
    assert.match(dialogue.system(), /整体印象：常跑来跑去的人/);
    assert.match(dialogue.system(), /玩家下周要进城一趟/);
  } finally {
    await save.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((done) => setTimeout(done, 10));
  assert.ok(check(), `timed out waiting for ${what}`);
}

test('the game save is acknowledged before its consolidation finishes, and later turns use the result', { timeout: 10000 }, async (t) => {
  const h = await harness(t);
  const gate = deferred();
  const nightly = nightlyModel([answer({ memories: [{ text: '约好明天一起去山上放风筝', importance: 4 }], impression: '会约人玩的人' })], gate.promise);
  const wire = await connect(await h.start(nightlyConsolidator({ roster: h.roster, model: nightly.model })));
  wire.send(openTalk()); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住紫色风筝' }); await wire.until('talk.reply');
  await sleep(wire);
  await until(() => nightly.sent.length === 1, 'the nightly call');
  const user = nightly.user(0);
  assert.match(user, /- 农场主：测试（女）\n- 你对农场主的好感：8 心；关系：朋友/);
  assert.doesNotMatch(user, /农场主：（/, 'the opening stage direction is not a player line');
  assert.match(user, /- 你：回复1\n- 农场主：记住紫色风筝\n- 你：回复2/);

  wire.send(openTalk(2)); await wire.until('talk.reply');
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, /整体印象/, 'still consolidating');
  gate.resolve();
  await until(() => h.logs.some((line) => line.startsWith('夜间整合完成：第 1 天，1 位 NPC')), 'the consolidation');
  const from = wire.inbox.length;
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '还记得吗', date: { ...WORLD.date, day: 2 } }); await wire.until('talk.reply', from);
  const system = h.fake.sent.at(-1)![0]!.content;
  assert.match(system, /- 你对农场主的整体印象：会约人玩的人\n- （昨天）约好明天一起去山上放风筝/);
  assert.doesNotMatch(system, /- （昨天）紫色风筝/);
});

test('a consolidation cut off by stopping the backend runs again when the save is loaded', { timeout: 10000 }, async (t) => {
  const h = await harness(t);
  const held = nightlyModel([], new Promise(() => {}));
  const first = await h.start(nightlyConsolidator({ roster: h.roster, model: held.model }));
  const wire = await connect(first);
  wire.send(openTalk()); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住要去冒险' }); await wire.until('talk.reply');
  const commit = await sleep(wire);
  await until(() => held.sent.length === 1, 'the nightly call');
  await wire.close(); await h.stop(first);
  assert.ok(!h.logs.some((line) => line.startsWith('夜间整合')), 'an aborted consolidation is not reported as a failure');

  const retry = nightlyModel([answer({ memories: [{ text: '玩家说想和我一起去冒险', importance: 5 }], impression: '可靠的同伴' })]);
  const again = await connect(await h.start(nightlyConsolidator({ roster: h.roster, model: retry.model })), initial('load-2', 2, commit));
  await until(() => h.logs.some((line) => line.startsWith('夜间整合完成')), 'the catch-up');
  again.send(openTalk(2)); await again.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, /整体印象：可靠的同伴/);
});
