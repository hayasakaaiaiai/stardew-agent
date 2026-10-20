import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Gossip, gossipOf, heardMemory, newsFor, newsLine, spread } from '../src/agent/news.ts';
import { nightlyConsolidator } from '../src/agent/nightly.ts';
import { parseModMessage } from '../src/bridge/protocol.ts';
import type { ChatMessage, Completion, ModelClient } from '../src/services/model/client.ts';
import { connect, harness, initial, openTalk, sleep, WORLD } from './helpers/bridge.ts';

const SHARE = '测试送了我一块紫水晶，颜色特别漂亮。';
const NAMES = (id: string) => ({ abigail: '阿比盖尔', gus: '格斯', pam: '潘姆', sebastian: '塞巴斯蒂安', sam: '山姆' })[id] ?? id;
const heard = (origin: string, from: string, hand: 1 | 2) => ({ origin, from, share: SHARE, hand });
const completion = (content: string): Completion =>
  ({ content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } });

test('a teller passes its own news and first-hand news; second-hand news stops there', () => {
  const abigail = gossipOf('abigail', SHARE, []);
  assert.deepEqual(abigail.tellable, [{ origin: 'abigail', share: SHARE, hand: 1 }]);
  const gus = gossipOf('gus', undefined, [heard('abigail', 'abigail', 1)]);
  assert.deepEqual(gus.tellable, [{ origin: 'abigail', share: SHARE, hand: 2 }]);
  assert.deepEqual([...gus.known].sort(), ['abigail', 'gus']);
  assert.deepEqual(gossipOf('pam', undefined, [heard('abigail', 'gus', 2)]).tellable, []);
  assert.equal(newsFor(gus, abigail), undefined, 'nobody is told their own news');
  assert.equal(newsLine({ origin: 'abigail', share: SHARE, hand: 2 }, NAMES), `阿比盖尔说过："${SHARE}"`);
  assert.deepEqual(heardMemory({ listener: 'pam', from: 'gus', item: { origin: 'abigail', share: SHARE, hand: 2 } }, NAMES), {
    text: `格斯跟我说，阿比盖尔说过："${SHARE}"`, importance: 2, kind: 'heard', subjects: ['player', 'abigail', 'gus'], visibility: 'normal' });
});

test('an hour together moves news one teller at most, first-hand before second-hand, once per listener', () => {
  const none = (id: string): Gossip => gossipOf(id, undefined, []);
  const people = { abigail: gossipOf('abigail', SHARE, []), gus: none('gus'), pam: none('pam'), sam: none('sam') };
  assert.deepEqual(spread([['abigail', 'gus', 'pam']], people).map(t => [t.listener, t.from, t.item.hand]),
    [['gus', 'abigail', 1], ['pam', 'abigail', 1]], 'everyone in the room hears it from her');
  assert.deepEqual(spread([['gus', 'pam'], ['sam', 'abigail']], people).map(t => [t.listener, t.from]), [['sam', 'abigail']]);
  const later = { ...people, gus: gossipOf('gus', undefined, [heard('abigail', 'abigail', 1)]) };
  assert.deepEqual(spread([['gus', 'pam', 'abigail']], later).map(t => [t.listener, t.from, t.item.hand]), [['pam', 'abigail', 1]],
    'first-hand wins, and nobody hears it twice');
  assert.deepEqual(spread([['gus', 'pam']], later).map(t => [t.listener, t.from, t.item.hand]), [['pam', 'gus', 2]]);
  assert.deepEqual(spread([['pam', 'sam']], { ...later, pam: gossipOf('pam', undefined, [heard('abigail', 'gus', 2)]) }), []);
});

test('town.hour carries groups of at least two names', () => {
  const envelope = { lineageId: 'farm', loadNonce: 'load', seq: 4, date: WORLD.date };
  assert.equal(parseModMessage(JSON.stringify({ type: 'town.hour', ...envelope, groups: [['Gus', 'Pam']] })).type, 'town.hour');
  for (const groups of [[['Gus']], ['Gus'], [['Gus', 7]], [['Gus', '']]])
    assert.throws(() => parseModMessage(JSON.stringify({ type: 'town.hour', ...envelope, groups })), /groups/);
});

test('news spreads off-screen by the hour, one more hand, then into scenes and conversations, and rolls back', { timeout: 20000 }, async t => {
  const h = await harness(t);
  const nightly = { async chat() { return completion(JSON.stringify({ memories: [], retire: [], impression: '大方', plan: '', bubbles: [],
    letter: '', gift: false, share: SHARE })); } } as unknown as ModelClient;
  const scenes: ChatMessage[][] = [];
  const sceneModel = { async chat(messages: ChatMessage[]) {
    scenes.push(messages);
    return completion(JSON.stringify({ told: messages[1]!.content.includes('## 想说的事') ? ['b'] : [], lines: [
      { speaker: 'a', text: '晚上好。', emote: 'none' }, { speaker: 'b', text: '听说测试送了紫水晶。', emote: 'happy' }] }));
  } } as unknown as ModelClient;
  const server = await h.start(nightlyConsolidator({ roster: h.roster, model: nightly }), undefined, sceneModel);
  const wire = await connect(server);
  wire.send(openTalk()); await wire.until('talk.reply');
  const commit = await sleep(wire);
  for (let i = 0; i < 400 && !h.logs.some(line => line.startsWith('夜间整合完成')); i++) await new Promise(done => setTimeout(done, 10));
  const at = (time: number, day = 2) => ({ ...WORLD.date, day, time });
  const hour = async (time: number, groups: string[][], day = 2) => {
    const from = wire.inbox.length;
    const sent = wire.send({ type: 'town.hour', date: at(time, day), groups });
    await wire.until('ack', from);
    return sent;
  };
  const told = (who: string) => h.logs.filter(line => line.startsWith(`镇上传话：${who}记下了：`));

  await hour(1800, [['Abigail', 'Gus']]);
  assert.deepEqual(told('格斯'), [`镇上传话：格斯记下了：阿比盖尔跟我说："${SHARE}"`]);
  const second = await hour(1900, [['Gus', 'Pam'], ['Abigail', 'Leah', 'Unknown']]);
  assert.deepEqual(told('潘姆'), [`镇上传话：潘姆记下了：格斯跟我说，阿比盖尔说过："${SHARE}"`]);
  assert.equal(told('莉亚').length, 1, 'unknown names are ignored, the rest of the group still talks');
  let from = wire.inbox.length;
  wire.raw(second); await wire.until('ack', from);
  await hour(2000, [['Pam', 'Sam'], ['Abigail', 'Gus'], ['Gus', 'Pam']]);
  await hour(2100, [['Abigail', 'Haley']], 3);
  assert.equal(told('潘姆').length, 1, 'a resent hour is answered from its receipt');
  assert.equal(told('山姆').length, 0, 'second-hand news goes no further');
  assert.equal(told('海莉').length, 0, 'an hour from another day changes nothing');
  assert.ok(!wire.inbox.some(message => message.type === 'sync.error'));

  from = wire.inbox.length;
  wire.send(openTalk(2, 'Pam')); await wire.until('talk.reply', from);
  assert.match(h.fake.sent.at(-1)![0]!.content, new RegExp(`格斯跟我说，阿比盖尔说过："${SHARE}"`));

  from = wire.inbox.length;
  const request = wire.send({ type: 'scene.request', npcs: ['Gus', 'Sebastian'], world: { ...WORLD, date: at(2200) } });
  await wire.until('scene.lines', from);
  assert.match(scenes.at(-1)![1]!.content, new RegExp(`## 想说的事\\n- b（格斯）：阿比盖尔说过："${SHARE}"`));
  from = wire.inbox.length;
  wire.send({ type: 'scene.shown', request: request.seq, date: at(2210) }); await wire.until('ack', from);
  assert.ok(h.logs.includes(`塞巴斯蒂安记下了：格斯跟我说，阿比盖尔说过："${SHARE}"`));

  wire.send({ type: 'title.returned' }); await wire.until('ack', wire.inbox.length); await wire.close();
  const reload = await connect(server, initial('load-2', 2, commit));
  from = reload.inbox.length;
  reload.send(openTalk(2, 'Pam')); await reload.until('talk.reply', from);
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, /格斯跟我说/, 'the unsaved day took the gossip with it');
});
