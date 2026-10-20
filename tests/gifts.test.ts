import assert from 'node:assert/strict';
import { test } from 'node:test';
import { giftItemName, giftMemory } from '../src/agent/gifts.ts';
import { nightlyConsolidator, type NightlyOutput } from '../src/agent/nightly.ts';
import { parseModMessage } from '../src/bridge/protocol.ts';
import type { ChatMessage, Completion, ModelClient } from '../src/services/model/client.ts';
import { connect, harness, initial, openTalk, sleep, WORLD } from './helpers/bridge.ts';

const gift = (extra: Record<string, unknown> = {}) =>
  ({ type: 'gift.given', npc: 'Abigail', item: '紫水晶', taste: 'love', birthday: false, date: { ...WORLD.date, time: 1200 }, ...extra });
const NOTE = '农场主送我紫水晶，我特别喜欢。';
const count = (text: string, part: string) => text.split(part).length - 1;

test('a gift note comes from a template: what it was, how the NPC took it, and no relative dates', () => {
  assert.deepEqual(giftMemory({ item: '紫水晶', taste: 'love', birthday: false }),
    { text: NOTE, importance: 4, kind: 'observation', subjects: ['player'], visibility: 'private' });
  assert.equal(giftMemory({ item: '紫水晶', taste: 'love', birthday: true }).text, '农场主送我紫水晶当生日礼物，我特别喜欢。');
  assert.equal(giftMemory({ item: '紫水晶', taste: 'love', birthday: true }).importance, 5);
  assert.equal(giftMemory({ item: '粘土', taste: 'hate', birthday: false }).importance, 4, 'strong reactions reach a stranger’s recall');
  assert.equal(giftMemory({ item: '石头', taste: 'neutral', birthday: false }).importance, 2);
  assert.equal(giftMemory({ item: '石头', taste: 'neutral', birthday: true }).text, '农场主送我石头当生日礼物，说不上喜欢不喜欢。');
  assert.equal(giftItemName('  紫水晶^#%  '), '紫水晶');
  assert.equal(giftItemName('「传送图腾：农场」'), '传送图腾：农场');
  assert.equal(giftItemName('$@*'), undefined);
  assert.equal(Array.from(giftItemName('长'.repeat(40))!).length, 30);
});

test('gift.given carries a known taste, a birthday flag and the date', () => {
  const envelope = { lineageId: 'farm-1', loadNonce: 'load-1', seq: 3 };
  assert.equal(parseModMessage(JSON.stringify({ ...gift(), ...envelope })).type, 'gift.given');
  for (const bad of [{ taste: 'wink' }, { birthday: 'no' }, { item: '' }, { date: undefined }])
    assert.throws(() => parseModMessage(JSON.stringify({ ...gift(bad), ...envelope })), /Bad gift\.given/);
});

test('a gift is remembered that day and the next, once even when resent, and only if the day is saved', { timeout: 10000 }, async t => {
  const h = await harness(t); const server = await h.start(); const wire = await connect(server);
  const sent = wire.send(gift()); await wire.until('ack');
  assert.ok(h.logs.includes(`阿比盖尔记下了：${NOTE}`));
  wire.raw(sent); await wire.until('ack', wire.inbox.length);
  wire.send(openTalk()); await wire.until('talk.reply');
  assert.equal(count(h.fake.sent.at(-1)![0]!.content, `（今天）${NOTE}`), 1, 'a resent gift is answered from its receipt');
  const commit = await sleep(wire);

  wire.send(openTalk(2)); await wire.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, new RegExp(`（昨天）${NOTE}`));
  wire.send(gift({ item: '粘土', taste: 'hate', date: { ...WORLD.date, day: 2, time: 900 } })); await wire.until('ack', wire.inbox.length);
  wire.send({ type: 'title.returned' }); await wire.until('ack', wire.inbox.length); await wire.close();

  const reload = await connect(server, initial('load-2', 2, commit));
  reload.send(openTalk(2)); await reload.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, new RegExp(`（昨天）${NOTE}`));
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, /粘土/, 'the unsaved day’s gift is gone with the day');
});

test('a gift that no longer fits the open day is acknowledged without a note and without stopping the AI', { timeout: 10000 }, async t => {
  const h = await harness(t); const wire = await connect(await h.start());
  for (const extra of [{ date: { ...WORLD.date, day: 2 } }, { npc: 'Gunther' }]) {
    const from = wire.inbox.length;
    wire.send(gift(extra)); await wire.until('ack', from);
  }
  assert.ok(!wire.inbox.some(message => message.type === 'sync.error'));
  assert.ok(!h.logs.some(line => line.includes('记下了')));
  wire.send(openTalk()); await wire.until('talk.reply');
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, /农场主送我/);
});

test('the night replaces conversation notes with quotes but keeps the gift note', { timeout: 10000 }, async t => {
  const h = await harness(t);
  const nightly: ChatMessage[][] = [];
  const output: NightlyOutput = { memories: [{ sources: ['t2'], importance: 4 }], retire: [], impression: '大方的人', plan: '',
    bubbles: [], letter: '', gift: false, share: '' };
  const model = { async chat(messages: ChatMessage[]): Promise<Completion> {
    nightly.push(messages);
    return { content: JSON.stringify(output), reasoning: '', usage: null, finishReason: 'stop',
      timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
  } } as unknown as ModelClient;
  const wire = await connect(await h.start(nightlyConsolidator({ roster: h.roster, model })));
  wire.send(openTalk()); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住一起去矿洞' }); await wire.until('talk.reply', wire.inbox.length);
  wire.send(gift({ date: { ...WORLD.date, time: 1300 } })); await wire.until('ack', wire.inbox.length);
  await sleep(wire);
  for (let i = 0; i < 400 && !h.logs.some(line => line.startsWith('夜间整合完成')); i++) await new Promise(done => setTimeout(done, 10));
  const today = nightly[0]![1]!.content.split('## 今天当场记下的\n')[1]!.split('\n\n')[0]!;
  assert.match(today, new RegExp(`^- （重要度 4）${NOTE}$`, 'm'));
  assert.match(today, /^- （重要度 5）一起去矿洞/m);

  wire.send(openTalk(2)); await wire.until('talk.reply', wire.inbox.length);
  const system = h.fake.sent.at(-1)![0]!.content;
  assert.match(system, /（昨天）农场主说："记住一起去矿洞"/);
  assert.match(system, new RegExp(`（昨天）${NOTE}`));
  assert.doesNotMatch(system, /（昨天）一起去矿洞/, 'the conversation note was replaced by its quote');
});
