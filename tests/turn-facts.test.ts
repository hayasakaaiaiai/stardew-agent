import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { OPENING_LINE, runTurn, type Remembered, type WorldState } from '../src/agent/dialogue.ts';
import type { ModelClient } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';
import { connect, harness, initial, openTalk, sleep, WORLD } from './helpers/bridge.ts';

const world: WorldState = { year: 1, season: 'spring', day: 18, time: '10:00', weather: '晴', location: '农舍',
  player: { name: '小林', gender: 'female', farm: '晴空' }, facts: {} };
async function turn(playerLine: string, remember: unknown[]) {
  const roster = new Roster({ directory: resolve(import.meta.dirname, '../data/npcs'), npcIds: SOCIAL_NPCS }); await roster.load();
  let stored: Remembered[] = [];
  const model = { async chat() { return { content: JSON.stringify({ reply: '嗯，知道了。', emotion: 'neutral',
    options: ['老虎哪里凶了，很帅', '我已经养了猫', '再见'], remember, end: false }),
    reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } }; } } as unknown as ModelClient;
  const result = await runTurn({ roster, model, memory: { async context() { return { memories: [] }; },
    async record(_exchange, remembered) { stored = remembered; } } },
  { npcId: 'abigail', world, standing: { hearts: 8, relation: 'friend', seenEvents: new Set<string>() }, playerLine });
  return { result, stored };
}
test('strings and objects cannot turn paraphrased unchosen options into remembered facts', async () => {
  const line = '你画的那幅画真好看，我很喜欢。';
  const { result, stored } = await turn(line, ['农场主喜欢我画的老虎，还说不觉得凶', { text: '小林已经养了猫', importance: 5 }]);
  assert.deepEqual(stored, [{ text: `农场主说：${JSON.stringify(line)}`, importance: 5 }]);
  assert.deepEqual(result.meta.remember, stored);
  assert.doesNotMatch(JSON.stringify(stored), /老虎|不觉得凶|养了猫/);
});
test('remembered source keeps negations, conditions and the entire uncompleted plan', async () => {
  const line = '我明天不去墓地，也还没养猫。如果后天下雨就不去海边；我还没有做纸船。';
  const { stored } = await turn(line, [{ text: '玩家已经在海边放了纸船', importance: 4 }]);
  assert.deepEqual(stored, [{ text: `农场主说：${JSON.stringify(line)}`, importance: 4 }]);
});
test('openings and empty remember lists never create new player facts', async () => {
  assert.deepEqual((await turn(OPENING_LINE, ['玩家答应明天见面'])).stored, []);
  assert.deepEqual((await turn('你好', [])).stored, []);
});

test('the exact source survives a real save and backend restart while a later unsaved quote rolls back', { timeout: 15000 }, async t => {
  const h = await harness(t);
  h.fake.model.chat = async messages => {
    h.fake.sent.push(messages);
    return { content: JSON.stringify({ reply: '嗯。', emotion: 'neutral', options: ['老虎很帅', '我养了猫', '再见'],
      remember: ['农场主喜欢老虎，还说不凶', { text: '农场主已经养了猫', importance: 4 }], end: false }),
      reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
  };
  const first = await h.start(), wire = await connect(first);
  const line = '你画的那幅画真好看，我很喜欢。', quoted = `农场主说：${JSON.stringify(line)}`;
  wire.send(openTalk()); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: line }); await wire.until('talk.reply');
  wire.send(openTalk()); await wire.until('talk.reply');
  assert.ok(h.fake.sent.at(-1)![0]!.content.includes(quoted));
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, /农场主喜欢老虎|农场主已经养了猫/);
  const commit = await sleep(wire); await wire.close(); await h.stop(first);
  const restored = await connect(await h.start(), initial('restored', 2, commit));
  restored.send(openTalk(2)); await restored.until('talk.reply');
  assert.ok(h.fake.sent.at(-1)![0]!.content.includes(quoted));
  const unsaved = '如果下雨我就不去海边，我还没有做纸船。';
  restored.send({ type: 'talk.say', npc: 'Abigail', text: unsaved, date: { ...WORLD.date, day: 2 } }); await restored.until('talk.reply');
  restored.send({ type: 'title.returned' }); await restored.until('ack'); await restored.close();
  const rolled = await connect(await h.start(), initial('rolled', 2, commit));
  rolled.send(openTalk(2)); await rolled.until('talk.reply');
  assert.ok(h.fake.sent.at(-1)![0]!.content.includes(quoted));
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, /还没有做纸船|农场主喜欢老虎|农场主已经养了猫/);
  await rolled.close();
});
