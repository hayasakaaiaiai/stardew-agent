import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { AgentMemory, daysAgo, recallPolicy } from '../src/agent/dialogue-memory.ts';
import type { NpcAgent } from '../src/agent/npc.ts';
import type { Memory } from '../src/types.ts';
import { JSON_HINT, runTurn, type WorldState } from '../src/agent/dialogue.ts';
import type { ChatMessage, Completion, ModelClient, StreamHandlers } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';
import { absoluteDay, ChatSave, dateOf, minutesOf } from '../tools/chat/session.ts';

const START: WorldState = {
  year: 1, season: 'spring', day: 17, time: '15:00', weather: '晴', location: '皮埃尔的杂货店',
  player: { name: '小林', gender: 'female', farm: '晴空' }, facts: {},
};
const standing = { hearts: 4, seenEvents: new Set<string>(), relation: 'friend' as const };

/** Replies in order; each reply may ask the NPC to remember something. */
function fakeModel(replies: { reply: string; remember?: string }[]) {
  const sent: ChatMessage[][] = [];
  const model = {
    async chat(messages: ChatMessage[], handlers: StreamHandlers): Promise<Completion> {
      sent.push(messages);
      const next = replies[sent.length - 1] ?? { reply: '嗯。' };
      const content = JSON.stringify({
        reply: next.reply, emotion: 'neutral', options: ['a', 'b', 'c'], end: false,
        remember: next.remember ? [{ text: next.remember, importance: 4 }] : [],
      });
      handlers.onContent?.(content);
      return { content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
    },
  } as unknown as ModelClient;
  return { model, sent, system: (i: number) => sent[i]![0]!.content, turns: (i: number) => sent[i]!.slice(1) };
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'chat-memory-'));
  const roster = new Roster({ directory: resolve(import.meta.dirname, '../data/npcs'), npcIds: SOCIAL_NPCS });
  await roster.load();
  const open = (fresh: boolean) => ChatSave.open({ directory, name: 'test', fresh, startDay: absoluteDay(START), npcIds: SOCIAL_NPCS });
  return { directory, roster, open };
}

function talk(roster: Roster, model: ModelClient, save: ChatSave) {
  const world = () => ({ ...START, ...dateOf(save.day) });
  const memory = save.memory('abigail', () => absoluteDay(world()) * 1440 + minutesOf(START.time));
  return (playerLine: string) => runTurn({ roster, model, memory }, { npcId: 'abigail', world: world(), standing, playerLine });
}

test('date helpers round-trip and label days relative to now', () => {
  for (const day of [1, 28, 29, 112, 113, 300]) assert.equal(absoluteDay(dateOf(day)), day);
  assert.deepEqual(dateOf(113), { year: 2, season: 'spring', day: 1 });
  assert.equal(minutesOf('15:30'), 930);
  assert.equal(daysAgo(10 * 1440 + 600, 10 * 1440 + 5), '今天');
  assert.equal(daysAgo(10 * 1440 + 600, 9 * 1440 + 1300), '昨天');
  assert.equal(daysAgo(10 * 1440, 7 * 1440), '3 天前');
});

test('a turn is recorded, then shows up as history and memory in the next prompt', async () => {
  const { directory, roster, open } = await setup();
  const save = await open(true);
  try {
    const fake = fakeModel([{ reply: '下雨天最好了。', remember: '玩家说她最喜欢下雨天' }, { reply: '对吧？' }]);
    const say = talk(roster, fake.model, save);
    await say('我最喜欢下雨天');
    await say('你记得我喜欢什么吗？');
    assert.deepEqual(fake.turns(1).map((m) => [m.role, m.content.replace(JSON_HINT, '')]), [
      ['user', '我最喜欢下雨天'], ['assistant', '{"reply":"下雨天最好了。"}'], ['user', '你记得我喜欢什么吗？'],
    ]);
    assert.match(fake.system(1), /## 你记得的事\n- （今天）玩家说她最喜欢下雨天/);
    assert.equal(save.todayCount('abigail'), 2);
  } finally {
    await save.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('after sleeping, yesterday is remembered but no longer part of the conversation', async () => {
  const { directory, roster, open } = await setup();
  const save = await open(true);
  try {
    const fake = fakeModel([{ reply: '好呀。', remember: '玩家答应带紫水晶来' }, { reply: '嘿。' }]);
    const say = talk(roster, fake.model, save);
    await say('明天我给你带紫水晶');
    await save.sleep();
    assert.equal(save.day, absoluteDay(START) + 1);
    await say('早上好');
    assert.match(fake.system(1), /- （昨天）玩家答应带紫水晶来/);
    assert.deepEqual(fake.turns(1).map((m) => m.role), ['user'], 'yesterday’s exchange is not replayed');
  } finally {
    await save.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rolling back discards today but keeps everything up to the last save', async () => {
  const { directory, roster, open } = await setup();
  const save = await open(true);
  try {
    const fake = fakeModel([
      { reply: '嗯。', remember: '玩家说喜欢青蛙' },
      { reply: '真的？', remember: '玩家说要搬去城里' },
      { reply: '嘿。' },
    ]);
    const say = talk(roster, fake.model, save);
    await say('我喜欢青蛙');
    await save.sleep();
    await say('我要搬去城里了');
    await save.rollback();
    assert.equal(save.day, absoluteDay(START) + 1, 'reloads the day after the last save');
    assert.equal(save.todayCount('abigail'), 0);
    await say('早');
    assert.match(fake.system(2), /玩家说喜欢青蛙/);
    assert.doesNotMatch(fake.system(2), /搬去城里/);
  } finally {
    await save.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('closing and reopening the same save restores today, and sequence numbers keep increasing', async () => {
  const { directory, roster, open } = await setup();
  try {
    const first = await open(true);
    const day = first.day;
    await talk(roster, fakeModel([{ reply: '嘿。', remember: '玩家今天来过' }]).model, first)('你好');
    await first.close();

    const second = await open(false);
    try {
      assert.equal(second.day, day);
      assert.equal(second.todayCount('abigail'), 1, 'the unsaved exchange came back from the journal');
      const fake = fakeModel([{ reply: '又见面了。' }]);
      await talk(roster, fake.model, second)('我又来了');
      assert.equal(second.todayCount('abigail'), 2, 'a new event was accepted after the recovered one');
      assert.deepEqual(fake.turns(0).map((m) => m.role), ['user', 'assistant', 'user']);
    } finally {
      await second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('how much an NPC remembers about the player depends on hearts and relation', async () => {
  const now = 100 * 1440 + 900;
  const memory = (id: string, importance: number, days: number): Memory => ({
    id, commitId: 'c', npcId: 'abigail', gameTime: now - days * 1440, text: id, kind: 'conversation',
    importance, subjects: ['player'], topics: [], visibility: 'private', sourceId: id,
  });
  const stored = [memory('重要的近事', 5, 2), memory('小事', 2, 1), memory('十天前的事', 4, 10), memory('上一季的事', 3, 40)];
  const agent = {
    async context() {
      return {
        state: {}, memories: stored.map((m) => ({ ...m, score: 1 })),
        today: [{ seq: 1, gameTime: now, changes: [{ npcId: 'abigail', log: { player: '早', npc: '嘿。' } }] }],
      };
    },
  } as unknown as NpcAgent;
  const recall = new AgentMemory(() => agent, { now: () => now, nextSeq: () => 1 });
  const at = async (hearts: number, relation: 'friend' | 'dating' = 'friend') =>
    recall.context('', { hearts, relation, seenEvents: new Set() });

  assert.deepEqual((await at(0)).memories.map((m) => m.text), ['重要的近事'], '0 hearts: only important things from the last 3 days');
  assert.deepEqual((await at(3)).memories.map((m) => m.text), ['重要的近事'], '2–4 hearts: importance ≥ 3 within a week');
  assert.deepEqual((await at(6)).memories.map((m) => m.text), ['十天前的事', '重要的近事', '小事'], '5–7 hearts: a season back');
  assert.deepEqual((await at(9)).memories.length, 4, '8+ hearts: everything');
  assert.deepEqual((await at(1, 'dating')).memories.length, 4, 'dating counts as the closest tier');

  assert.match((await at(0)).tone ?? '', /模糊/);
  assert.equal((await at(3)).tone, undefined);
  assert.match((await at(9)).tone ?? '', /记得很清楚/);
  assert.deepEqual((await at(0)).today, [{ player: '早', npc: '嘿。' }], 'today’s conversation is never filtered');

  assert.deepEqual(recallPolicy({ hearts: 4, relation: 'friend' }), { limit: 3, minImportance: 3, maxDays: 7 });
  assert.equal(recallPolicy({ hearts: 0, relation: 'friend' }).minImportance, 3, 'plans and promises reach even a stranger');
  assert.equal(recallPolicy({ hearts: 0, relation: 'roommate' }).maxDays, null);
});
