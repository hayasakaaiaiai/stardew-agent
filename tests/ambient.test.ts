import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { AMBIENT_CALLS_PER_DAY, AMBIENT_RULES, type AmbientPerson, ambientPrompt, parseAmbient } from '../src/agent/ambient.ts';
import type { WorldState } from '../src/agent/dialogue.ts';
import { parseModMessage } from '../src/bridge/protocol.ts';
import type { ChatMessage, Completion, ModelClient } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';
import { connect, harness, initial, WORLD } from './helpers/bridge.ts';

const WORLD_STATE: WorldState = {
  year: 1, season: 'spring', day: 18, time: '10:00', weather: '下雨', location: '皮埃尔的杂货店',
  player: { name: '小林', gender: 'female', farm: '晴空' }, facts: { 社区中心: '玩家正在修复，还没修好' },
};
const SHOP: AmbientPerson[] = [
  { id: 'pierre', hearts: 3, relation: 'friend', greeted: false },
  { id: 'caroline', hearts: 1, relation: 'friend', greeted: true },
  { id: 'abigail', hearts: 0, relation: 'stranger', greeted: false },
];

/** Answers every call with the same content and keeps what was sent. */
function ambientModel(content: string) {
  const sent: ChatMessage[][] = [];
  const model = {
    async chat(messages: ChatMessage[]): Promise<Completion> {
      sent.push(messages);
      return { content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
    },
  } as unknown as ModelClient;
  return { model, sent };
}

test('ambient lines keep the first usable line per person, one greeting a day, and nothing about the player behind their back', () => {
  const lines = (items: unknown[]) => JSON.stringify({ lines: items });
  assert.deepEqual(parseAmbient(lines([
    { npc: 'a', to: 'farmer', text: '欢迎光临，小林！', emote: 'happy' },
    { npc: 'a', to: 'self', text: '下雨天客人少。', emote: 'none' },
    { npc: 'b', to: 'farmer', text: '哦哦，淋湿了吧？', emote: 'question' },
    { npc: 'b', to: 'a', text: '农场主人真不错。', emote: 'none' },
    { npc: 'b', to: 'b', text: '小林又来了。', emote: 'none' },
    { npc: 'b', to: 'a', text: '亲爱的，*门口*垫子收了吗？😀', emote: 'wink' },
    { npc: 'e', to: 'self', text: '我是谁？', emote: 'none' },
    { npc: 'c', to: 'x', text: '一'.repeat(25), emote: 'none' },
    { npc: 'c', to: 'x', text: '唉，下雨哪儿也去不了。', emote: 'sad' },
  ]), SHOP, '小林'), [
    { npc: 'pierre', to: 'farmer', text: '欢迎光临，小林！', emote: 'happy' },
    { npc: 'caroline', to: 'pierre', text: '亲爱的，门口垫子收了吗？', emote: 'none' },
    { npc: 'abigail', to: 'self', text: '唉，下雨哪儿也去不了。', emote: 'sad' },
  ], 'a greeting may name the player; Caroline already greeted, so only her line to Pierre stays');
  const many = [...SHOP, { id: 'gus', hearts: 4, relation: 'friend', greeted: false }, { id: 'pam', hearts: 2, relation: 'friend', greeted: false }] as AmbientPerson[];
  assert.equal(parseAmbient(lines(['a', 'b', 'c', 'd', 'e'].map(npc => ({ npc, to: 'self', text: '嗯。', emote: 'none' }))), many, '小林').length, 4);
  assert.deepEqual(parseAmbient('不是 JSON', SHOP, '小林'), []);
  assert.deepEqual(parseAmbient('{"lines":"嗯"}', SHOP, '小林'), []);
});

test('the ambient prompt has each person, how they stand with the farmer, and the moment, but nothing private', async () => {
  const roster = new Roster({ directory: resolve(import.meta.dirname, '../data/npcs'), npcIds: SOCIAL_NPCS });
  await roster.load();
  const [system, user] = ambientPrompt(roster, SHOP, WORLD_STATE);
  assert.equal(system!.content, AMBIENT_RULES, 'the same for every call, for the prefix cache');
  assert.match(user!.content, /^## 在场的人\n- a：皮埃尔。[^\n]*说话：[^\n]*和农场主：3 心，朋友\n/);
  assert.match(user!.content, /\n- b：卡洛琳。[^\n]*和农场主：1 心，朋友，今天打过招呼\n/);
  assert.match(user!.content, /\n- c：阿比盖尔。[^\n]*和农场主：还没打过交道\n/);
  assert.equal(user!.content.match(/今天打过招呼/g)?.length, 1);
  assert.match(user!.content, /- 皮埃尔眼里的卡洛琳：/);
  assert.match(user!.content, /- 阿比盖尔眼里的皮埃尔：/);
  assert.match(user!.content, /## 现在\n- 第 1 年春季 18 日 10:00，下雨，皮埃尔的杂货店\n- 镇上的情况：社区中心：玩家正在修复，还没修好\n- 农场主：小林（女），就在附近/);
  assert.doesNotMatch(user!.content, /记得|印象|打算|计划/, 'no memories, impressions or plans');
});

test('the backend answers ambient requests up to the daily budget, never greets twice, and starts over on a new load', { timeout: 10000 }, async (t) => {
  const h = await harness(t);
  const ambient = ambientModel(JSON.stringify({ lines: [
    { npc: 'a', to: 'farmer', text: '欢迎光临！', emote: 'happy' },
    { npc: 'b', to: 'self', text: '测试那孩子又来了。', emote: 'none' },
    { npc: 'b', to: 'a', text: '亲爱的，喝口茶吧。', emote: 'happy' }] }));
  const server = await h.start(undefined, undefined, ambient.model);
  let wire = await connect(server);
  const npc = (name: string, greeted = false) => ({ npc: name, hearts: 3, relation: 'friend', greeted });
  const ask = async (npcs: unknown[], date = WORLD.date) => {
    const request = wire.send({ type: 'ambient.request', npcs, world: { ...WORLD, date } });
    const from = wire.inbox.length;
    const reply = await wire.until('ambient.lines', from) as unknown as { seq: number; lines: { npc: string; to: string; text: string }[] };
    assert.equal(reply.seq, request.seq);
    return reply.lines;
  };
  assert.deepEqual(await ask([npc('Pierre'), npc('Caroline')]), [
    { npc: 'pierre', to: 'farmer', text: '欢迎光临！', emote: 'happy' },
    { npc: 'caroline', to: 'pierre', text: '亲爱的，喝口茶吧。', emote: 'happy' }], 'the line naming the player (测试) behind her back is dropped');
  assert.match(ambient.sent[0]![1]!.content, /- a：皮埃尔。[^\n]*和农场主：3 心，朋友\n/);
  assert.ok(h.logs.includes('同图：皮埃尔、卡洛琳，2 句，打招呼：皮埃尔'));

  assert.deepEqual((await ask([npc('Pierre'), npc('Caroline')])).map(line => line.npc), ['caroline'],
    'the backend remembers Pierre greeted even though the Mod did not report it');
  assert.match(ambient.sent[1]![1]!.content, /- a：皮埃尔。[^\n]*今天打过招呼/);

  const calls = ambient.sent.length;
  assert.deepEqual(await ask([npc('Gunther')]), [], 'not on the roster');
  assert.deepEqual(await ask([npc('Pierre'), npc('Pierre')]), [], 'the same NPC twice');
  assert.deepEqual(await ask([npc('Pierre')], { ...WORLD.date, day: 2 }), [], 'not the loaded day');
  assert.equal(ambient.sent.length, calls, 'no model call once refused');

  while (ambient.sent.length < AMBIENT_CALLS_PER_DAY) await ask([npc('Gus')]);
  assert.deepEqual(await ask([npc('Gus')]), [], 'the daily budget is spent');
  assert.equal(ambient.sent.length, AMBIENT_CALLS_PER_DAY);

  await wire.close();
  wire = await connect(server, initial('load-2'));
  assert.equal((await ask([npc('Pierre')])).length, 1, 'a new load starts the day over');
  assert.doesNotMatch(ambient.sent.at(-1)![1]!.content, /今天打过招呼/);

  const bad = (npcs: unknown) => () => parseModMessage(JSON.stringify({ type: 'ambient.request', lineageId: 'a', loadNonce: 'b', seq: 1, npcs, world: WORLD }));
  assert.throws(bad([]));
  assert.throws(bad(['Pierre']));
  assert.throws(bad([{ ...npc('Pierre'), relation: 'boss' }]));
  assert.throws(bad([{ ...npc('Pierre'), greeted: 'no' }]));
  assert.throws(bad(Array.from({ length: 5 }, () => npc('Pierre'))));
});
