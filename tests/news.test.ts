import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heardMemory, safeShare, shareFor } from '../src/agent/news.ts';
import { NIGHTLY_HINT, NIGHTLY_RULES, nightlyConsolidator, parseNightly } from '../src/agent/nightly.ts';
import { parseScene, SCENE_HINT, SCENE_RULES } from '../src/agent/scene.ts';
import { parseModMessage } from '../src/bridge/protocol.ts';
import type { ChatMessage, Completion, ModelClient } from '../src/services/model/client.ts';
import { connect, harness, initial, openTalk, sleep, WORLD } from './helpers/bridge.ts';

const SHARE = '测试送了我一块紫水晶，颜色特别漂亮。';
const NEWS = { origin: 'abigail', share: SHARE, hand: 1 as const };
const NAMES = (id: string) => ({ abigail: '阿比盖尔', gus: '格斯', pam: '潘姆', sebastian: '塞巴斯蒂安', sam: '山姆' })[id] ?? id;
const completion = (content: string): Completion =>
  ({ content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } });
function model(answer: (messages: ChatMessage[]) => string) {
  const sent: ChatMessage[][] = [];
  return { sent, client: { async chat(messages: ChatMessage[]) { sent.push(messages); return completion(answer(messages)); } } as unknown as ModelClient };
}

test('news is short, has no relative days, lasts one day, and is kept as the teller’s quoted words', () => {
  assert.equal(safeShare(` ${SHARE}^ `), SHARE);
  assert.equal(safeShare('测试说明天要去沙漠。'), undefined, 'told a day later, “明天” would be wrong');
  assert.equal(safeShare('长'.repeat(31)), undefined);
  assert.equal(shareFor({ day: 4, share: SHARE }, 5), SHARE);
  assert.equal(shareFor({ day: 3, share: SHARE }, 5), undefined);
  assert.equal(shareFor({ day: 4, share: '' }, 5), undefined);
  const item = { origin: 'abigail', share: SHARE, hand: 1 as const };
  assert.deepEqual(heardMemory({ listener: 'sebastian', from: 'abigail', item }, NAMES), { text: `阿比盖尔跟我说："${SHARE}"`, importance: 3,
    kind: 'heard', subjects: ['player', 'abigail'], visibility: 'normal' });
});

test('the night decides what to tell others; the scene may tell it and says who did', () => {
  assert.match(NIGHTLY_RULES, /- share：明天碰到别的居民时你愿意说起的一件农场主的事，用你的口吻，不超过 30 字；只写农场主当面说过或做过、不怕人知道的。谁要求保密的、你自己的秘密和心事、普通寒暄都不写；/);
  assert.match(NIGHTLY_HINT, /gift、share）/);
  const night = (share: unknown) => parseNightly(JSON.stringify({ memories: [], impression: '好人', share }))!.share;
  assert.deepEqual([SHARE, '明天一起去矿洞。', 7, undefined].map(night), [SHARE, '', '', '']);
  assert.match(SCENE_RULES, /不聊农场主（下面给出的“想说的事”除外）/);
  assert.match(SCENE_HINT, /lines、told/);
  const lines = (told: unknown, ...items: [string, string][]) => JSON.stringify({ lines: items.map(([speaker, text]) => ({ speaker, text, emote: 'none' })), told });
  const scene = parseScene(lines(['a', 'b'], ['a', '嘿，测试送了我紫水晶！'], ['b', '农场主还挺大方。'], ['b', '真不错。']), 'abigail', 'sebastian', '测试', { a: NEWS });
  assert.deepEqual(scene.lines.map(line => line.text), ['嘿，测试送了我紫水晶！', '真不错。'], 'only the teller may bring up the player');
  assert.deepEqual(scene.told, ['abigail'], 'b had no news to tell');
  assert.deepEqual(parseScene(lines(['a'], ['a', '测试送了我紫水晶！'], ['b', '嗯。']), 'abigail', 'sebastian', '测试', {}).lines.length, 0,
    'without news it is still filtered, leaving too few lines');
  assert.deepEqual(parseScene(lines(['a'], ['b', '早。'], ['b', '天真好。']), 'abigail', 'sebastian', '测试', { a: NEWS }).told, [],
    'a teller with no line on screen told nothing');
});

test('scene.shown names the request and the date', () => {
  const envelope = { lineageId: 'farm', loadNonce: 'load', seq: 4 };
  assert.equal(parseModMessage(JSON.stringify({ type: 'scene.shown', ...envelope, request: 3, date: WORLD.date })).type, 'scene.shown');
  assert.throws(() => parseModMessage(JSON.stringify({ type: 'scene.shown', ...envelope, request: 0, date: WORLD.date })), /request/);
});

test('news written at night is told in a scene the next day, remembered once shown, and rolled back with the day', { timeout: 20000 }, async t => {
  const h = await harness(t);
  const nightly = model(() => JSON.stringify({ memories: [], retire: [], impression: '大方', plan: '', bubbles: [], letter: '', gift: false, share: SHARE }));
  const scenes = model(messages => JSON.stringify({ told: messages[1]!.content.includes('## 想说的事') ? ['a'] : [], lines: [
    { speaker: 'a', text: '嘿，测试送了我紫水晶！', emote: 'happy' }, { speaker: 'b', text: '哦？挺好。', emote: 'none' }] }));
  const server = await h.start(nightlyConsolidator({ roster: h.roster, model: nightly.client }), undefined, scenes.client);
  const wire = await connect(server);
  wire.send(openTalk()); await wire.until('talk.reply');
  const commit = await sleep(wire);
  for (let i = 0; i < 400 && !h.logs.some(line => line.startsWith('夜间整合完成')); i++) await new Promise(done => setTimeout(done, 10));
  const day2 = { ...WORLD, date: { ...WORLD.date, day: 2 } };

  let from = wire.inbox.length;
  const request = wire.send({ type: 'scene.request', npcs: ['Sebastian', 'Abigail'], world: day2 });
  const shown = await wire.until('scene.lines', from) as unknown as { lines: { text: string }[] };
  assert.equal(shown.lines[0]!.text, '嘿，测试送了我紫水晶！');
  assert.match(scenes.sent[0]![1]!.content, new RegExp(`## 想说的事\\n- a（阿比盖尔）："${SHARE}"`));
  assert.match(scenes.sent[0]![1]!.content, /\n- 农场主：测试（女）\n/, 'news brings the player up, so the model needs her gender');
  assert.ok(h.logs.some(line => line.endsWith('阿比盖尔说了新鲜事')));
  const note = `阿比盖尔跟我说："${SHARE}"`;
  from = wire.inbox.length;
  const report = wire.send({ type: 'scene.shown', request: request.seq, date: { ...day2.date, time: 1000 } });
  await wire.until('ack', from);
  assert.ok(h.logs.includes(`塞巴斯蒂安记下了：${note}`));
  from = wire.inbox.length;
  wire.raw(report); await wire.until('ack', from);
  from = wire.inbox.length;
  wire.send(openTalk(2, 'Sebastian')); await wire.until('talk.reply', from);
  const system = h.fake.sent.at(-1)![0]!.content;
  assert.equal(system.split(note).length - 1, 1, 'remembered once although the report was resent');
  assert.doesNotMatch(h.fake.sent.findLast(messages => messages[0]!.content.includes('你是阿比盖尔'))?.[0]?.content ?? '', /跟我说/);

  wire.send({ type: 'title.returned' }); await wire.until('ack', wire.inbox.length); await wire.close();
  const reload = await connect(server, initial('load-2', 2, commit));
  from = reload.inbox.length;
  reload.send(openTalk(2, 'Sebastian')); await reload.until('talk.reply', from);
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, /阿比盖尔跟我说/, 'the unsaved day took what he heard with it');

  await sleep(reload, 'day-2', 2, commit.commitId);
  from = reload.inbox.length;
  reload.send({ type: 'scene.request', npcs: ['Abigail', 'Sam'], world: { ...WORLD, date: { ...WORLD.date, day: 3 } } });
  await reload.until('scene.lines', from);
  assert.doesNotMatch(scenes.sent.at(-1)![1]!.content, /想说的事/, 'news lasts only the day after the night that wrote it');
});
