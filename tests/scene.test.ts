import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseScene, SCENE_RULES, scenePrompt, SCENES_PER_DAY } from '../src/agent/scene.ts';
import type { WorldState } from '../src/agent/dialogue.ts';
import { parseModMessage } from '../src/bridge/protocol.ts';
import type { ChatMessage, Completion, ModelClient } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';
import { connect, harness, WORLD } from './helpers/bridge.ts';

const WORLD_STATE: WorldState = {
  year: 1, season: 'spring', day: 17, time: '17:30', weather: '晴', location: '星之果实餐吧',
  player: { name: '小林', gender: 'female', farm: '晴空' }, facts: { 社区中心: '玩家正在修复，还没修好' },
};

/** Answers every scene with the same lines and counts the calls. */
function sceneModel(content: string) {
  const sent: ChatMessage[][] = [];
  const model = {
    async chat(messages: ChatMessage[]): Promise<Completion> {
      sent.push(messages);
      return { content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
    },
  } as unknown as ModelClient;
  return { model, sent };
}

test('scene lines keep short small talk between the two and drop anything about the player', () => {
  const lines = (items: unknown[]) => JSON.stringify({ lines: items });
  assert.deepEqual(parseScene(lines([
    { speaker: 'a', text: '嘿，潘姆！今天来得挺早啊。', emote: 'happy' },
    { speaker: 'b', text: '农场主今天也来了吧？', emote: 'question' },
    { speaker: 'b', text: '小林那孩子真能干。', emote: 'none' },
    { speaker: 'c', text: '我是谁？', emote: 'none' },
    { speaker: 'b', text: '先来一杯*啤酒*😀', emote: 'wink' },
    { speaker: 'a', text: '一'.repeat(25), emote: 'none' },
  ]), 'gus', 'pam', '小林'), [
    { npc: 'gus', text: '嘿，潘姆！今天来得挺早啊。', emote: 'happy' },
    { npc: 'pam', text: '先来一杯啤酒', emote: 'none' },
  ]);
  assert.deepEqual(parseScene(lines([{ speaker: 'a', text: '嘿。', emote: 'none' }, { speaker: 'b', text: '农场主呢？', emote: 'none' }]), 'gus', 'pam', '小林'),
    [], 'one line left is not a conversation');
  assert.equal(parseScene(lines(Array.from({ length: 6 }, (_, i) => ({ speaker: i % 2 ? 'b' : 'a', text: `第${i}句`, emote: 'none' }))), 'gus', 'pam', '').length, 4);
  assert.deepEqual(parseScene('不是 JSON', 'gus', 'pam', ''), []);
});

test('the scene prompt has both people, how they see each other, and the moment, but nothing private', async () => {
  const roster = new Roster({ directory: resolve(import.meta.dirname, '../data/npcs'), npcIds: SOCIAL_NPCS });
  await roster.load();
  const [system, user] = scenePrompt(roster, 'abigail', 'sebastian', WORLD_STATE);
  assert.equal(system!.content, SCENE_RULES, 'the same for every pair, for the prefix cache');
  assert.match(user!.content, /^## 两个人\n- a：阿比盖尔。二十岁出头[^\n]*说话：口语，句子短/);
  assert.match(user!.content, /- 阿比盖尔眼里的塞巴斯蒂安：从小的好友/);
  assert.match(user!.content, /- 塞巴斯蒂安眼里的阿比盖尔：/);
  assert.match(user!.content, /## 现在\n- 第 1 年春季 17 日 17:30，晴，星之果实餐吧\n- 镇上的情况：社区中心：玩家正在修复，还没修好/);
  assert.doesNotMatch(user!.content, /记得|印象|打算|小林/, 'no memories, impressions, plans or the player');
});

test('the backend answers a scene request once per pair a day, up to the daily budget, and never for unknown NPCs', { timeout: 10000 }, async (t) => {
  const h = await harness(t);
  const scenes = sceneModel(JSON.stringify({ lines: [
    { speaker: 'a', text: '嘿，又来买东西？', emote: 'happy' }, { speaker: 'b', text: '嗯，买点咖啡。', emote: 'none' },
    { speaker: 'a', text: '测试那孩子呢？', emote: 'question' }] }));
  const wire = await connect(await h.start(undefined, undefined, scenes.model));
  let time = 600;
  const ask = async (npcs: [string, string]) => {
    const request = wire.send({ type: 'scene.request', npcs, world: { ...WORLD, date: { ...WORLD.date, time } } });
    const from = wire.inbox.length;
    const reply = await wire.until('scene.lines', from) as unknown as { seq: number; lines: { npc: string; text: string }[] };
    assert.equal(reply.seq, request.seq);
    return reply.lines;
  };
  assert.deepEqual(await ask(['Sebastian', 'Abigail']), [
    { npc: 'abigail', text: '嘿，又来买东西？', emote: 'happy' }, { npc: 'sebastian', text: '嗯，买点咖啡。', emote: 'none' }],
    'the earlier one on the roster opens; the line naming the player (测试) is dropped');
  assert.match(scenes.sent[0]![1]!.content, /- a：阿比盖尔。/);
  assert.ok(h.logs.includes('碰面聊天：阿比盖尔和塞巴斯蒂安，2 句'));
  assert.deepEqual(await ask(['Abigail', 'Sebastian']), [], 'a pair talks once a day');
  assert.deepEqual(await ask(['Gunther', 'Abigail']), [], 'not on the roster');
  assert.deepEqual(await ask(['Abigail', 'Abigail']), []);
  for (const pair of [['Gus', 'Pam'], ['Caroline', 'Jodi'], ['Lewis', 'Marnie']] as [string, string][]) {
    time += 100;
    assert.equal((await ask(pair)).length, 2);
  }
  assert.equal(scenes.sent.length, SCENES_PER_DAY);
  assert.deepEqual(await ask(['Shane', 'Emily']), [], 'the daily budget is spent');
  assert.equal(scenes.sent.length, SCENES_PER_DAY, 'no model call once refused');
  assert.throws(() => parseModMessage(JSON.stringify({ type: 'scene.request', lineageId: 'a', loadNonce: 'b', seq: 1, npcs: ['Gus'], world: WORLD })));
});
