import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMessages, offerLine, parseOutput, type WorldState } from '../src/agent/dialogue.ts';
import { GIVEN_TOPIC, givenMemory, handable, withGivenCooldown } from '../src/agent/in-person-gifts.ts';
import { giftFor } from '../src/agent/letters.ts';
import { nightlyConsolidator } from '../src/agent/nightly.ts';
import { parseModMessage, type BackendMessage } from '../src/bridge/protocol.ts';
import type { ChatMessage, Completion, ModelClient } from '../src/services/model/client.ts';
import { connect, harness, initial, openTalk, sleep, WORLD } from './helpers/bridge.ts';

type Reply = Extract<BackendMessage, { type: 'talk.reply' }>;
const OFFER = '可以当面送给玩家的东西';

test('the Mod gift switch removes the offer and cannot create a gift memory or consume its cooldown', async t => {
  const h = await harness(t); h.fake.give(true);
  const server = await h.start(); const wire = await connect(server);
  wire.send({ ...openTalk(), inPersonGifts: false });
  const disabled = await wire.until('talk.reply') as Reply;
  assert.equal(disabled.gift, undefined, 'a model give=true cannot override the disabled Mod setting');
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, new RegExp(OFFER));
  let from = wire.inbox.length;
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '再聊聊吧。' });
  assert.equal((await wire.until('talk.reply', from) as Reply).gift, undefined);
  assert.ok(!h.logs.some(line => line.includes('当面送了')));
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack');
  const commit = await sleep(wire);
  await wire.close(); await h.stop(server);
  const reload = await connect(await h.start(), initial('reenabled', 2, commit));
  from = reload.inbox.length;
  reload.send({ ...openTalk(2), inPersonGifts: true });
  assert.ok((await reload.until('talk.reply', from) as Reply).gift, 'reenabling next day has no false weekly cooldown');
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, /我当面送了农场主/);
  await reload.close();
});

test('the optional gift switch accepts booleans, preserves old clients and rejects malformed settings', () => {
  const raw = { ...openTalk(), lineageId: 'farm', loadNonce: 'load', seq: 1 };
  for (const inPersonGifts of [undefined, false, true]) assert.doesNotThrow(() => parseModMessage(JSON.stringify({ ...raw, inPersonGifts })));
  for (const inPersonGifts of ['false', 0, null]) assert.throws(() => parseModMessage(JSON.stringify({ ...raw, inPersonGifts })));
});

test('only gifts that can be handed over are offered, and handing one over starts the weekly cooldown', () => {
  assert.equal(handable({ item: '紫水晶', text: '在山洞里捡到的。' }), true);
  assert.equal(handable({ item: '铜锭', text: '随信寄来，说是不小心多打了几根。' }), false);
  assert.equal(handable({ item: '500 金', text: '资助玩家买种子。' }), false);
  const note = givenMemory('紫水晶');
  assert.deepEqual(note, { text: '我当面送了农场主紫水晶。', importance: 3, kind: 'observation', subjects: ['player'],
    topics: [GIVEN_TOPIC], visibility: 'private' });
  assert.deepEqual(withGivenCooldown({ plan: 'x' }, [{ topics: [GIVEN_TOPIC], gameTime: 3 * 1440 + 600 }, { topics: [], gameTime: 9 * 1440 }]),
    { plan: 'x', lastGiftDay: 3 });
  assert.deepEqual(withGivenCooldown({ lastGiftDay: 5 }, [{ topics: [GIVEN_TOPIC], gameTime: 3 * 1440 }]), { lastGiftDay: 5 }, 'a later letter gift wins');
  const gifts = [{ item: '紫水晶', text: '捡到的。' }, { item: '樱桃炸弹', text: '婚后，防身。' }, { item: '炸弹', text: '同上，注意安全。' },
    { item: '铜锭', text: '随信寄来。' }];
  const friend = { hearts: 8, relation: 'friend' as const };
  assert.deepEqual([0, 1, 2, 3].map(day => giftFor(gifts, friend, {}, day, handable)?.item), ['紫水晶', '紫水晶', '紫水晶', '紫水晶']);
  assert.deepEqual([0, 1, 2].map(day => giftFor(gifts, { hearts: 10, relation: 'married' }, {}, day, handable)?.item), ['紫水晶', '樱桃炸弹', '炸弹']);
  assert.equal(giftFor(gifts, friend, { lastGiftDay: 1 }, 7, handable), undefined);
  assert.equal(giftFor(gifts, friend, { lastGiftDay: 1 }, 8, handable)?.item, '紫水晶');
});

test('the offer is one line in the current situation, and give is read only as a strict true', () => {
  const world: WorldState = { year: 1, season: 'spring', day: 1, time: '10:00', weather: '晴', location: '杂货店',
    player: { name: '小林', gender: 'female', farm: '晴空' }, facts: {} };
  const card = { stable: '## 角色', gated: '' } as never;
  const standing = { hearts: 8, relation: 'friend' as const, seenEvents: new Set<string>() };
  const offer = { item: '紫水晶', text: '在山洞里捡到的，想让玩家也看看。' };
  const system = (withOffer: boolean) => buildMessages({ npcName: '阿比盖尔', card, world, standing, history: [], playerLine: '嗨',
    memory: { memories: [], ...(withOffer ? { offer } : {}) } })[0]!.content;
  assert.ok(system(true).includes(offerLine(offer) + '\n\n## 你记得的事'));
  assert.equal(offerLine(offer), '- 可以当面送给玩家的东西：紫水晶（在山洞里捡到的，想让玩家也看看。）觉得合适就在台词里自然地递给玩家，JSON 加 "give":true；玩家开口讨要不算理由。');
  assert.doesNotMatch(system(false), new RegExp(OFFER));
  const give = (value: unknown) => parseOutput(JSON.stringify({ reply: '给。', emotion: 'happy', options: ['一', '二', '三'], remember: [], give: value, end: false })).meta.give;
  assert.deepEqual([true, 'true', 1, undefined].map(give), [true, false, false, false]);
});

test('a close NPC hands over the day’s gift once, only at the first opening, and not again for a week', { timeout: 20000 }, async t => {
  const h = await harness(t); const server = await h.start(); const wire = await connect(server);
  const item = giftFor(h.roster.get('abigail').gifts, { hearts: 8, relation: 'friend' }, {}, 1, handable)!.item;
  h.fake.give(true);
  const open = async (day: number, npc = 'Abigail', hearts = 8) => {
    const from = wire.inbox.length;
    wire.send({ ...openTalk(day, npc), hearts });
    return { reply: await wire.until('talk.reply', from) as Reply, system: h.fake.sent.at(-1)![0]!.content };
  };
  const first = await open(1);
  assert.match(first.system, new RegExp(`${OFFER}：${item}（`));
  assert.equal(first.reply.gift, item);
  assert.ok(h.logs.includes(`阿比盖尔当面送了：${item}`));
  let from = wire.inbox.length;
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '谢谢！' });
  const next = await wire.until('talk.reply', from) as Reply;
  assert.equal(next.gift, undefined, 'only the opening offers it');
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, new RegExp(OFFER));
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack', wire.inbox.length);
  assert.equal((await open(1)).reply.gift, undefined, 'a second conversation that day');
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack', wire.inbox.length);
  assert.equal((await open(1, 'Sam', 5)).reply.gift, undefined, 'not at five hearts');
  wire.send({ type: 'talk.close', npc: 'Sam' }); await wire.until('ack', wire.inbox.length);

  // No consolidator here: the cooldown comes from the note saved with the day, not from the night.
  let parent: string | null = null;
  for (let day = 1; day <= 6; day++) parent = (await sleep(wire, `day-${day}`, day, parent)).commitId;
  const later = await open(7);
  assert.match(later.system, new RegExp(`（6 天前）我当面送了农场主${item}。`));
  assert.equal(later.reply.gift, undefined, 'six days later');
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack', wire.inbox.length);
  parent = (await sleep(wire, 'day-7', 7, parent)).commitId;
  const week = await open(8);
  assert.ok(week.reply.gift, 'a week later');
  wire.send({ type: 'title.returned' }); await wire.until('ack', wire.inbox.length); await wire.close();

  const reload = await connect(server, initial('load-2', 8, { commitId: parent!, parentId: 'day-6', dayEnded: 7 }));
  from = reload.inbox.length;
  reload.send(openTalk(8));
  assert.ok((await reload.until('talk.reply', from) as Reply).gift, 'the unsaved gift is gone with the day, so it is offered again');
});

test('a night after an in-person gift writes no gift into the letter', { timeout: 10000 }, async t => {
  const h = await harness(t);
  const nightly: ChatMessage[][] = [];
  const model = { async chat(messages: ChatMessage[]): Promise<Completion> {
    nightly.push(messages);
    return { content: JSON.stringify({ memories: [], retire: [], impression: '', plan: '', bubbles: [], letter: '', gift: false }),
      reasoning: '', usage: null, finishReason: 'stop', timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
  } } as unknown as ModelClient;
  const wire = await connect(await h.start(nightlyConsolidator({ roster: h.roster, model })));
  h.fake.give(true);
  wire.send(openTalk()); assert.ok((await wire.until('talk.reply') as Reply).gift);
  await sleep(wire);
  for (let i = 0; i < 400 && !nightly.length; i++) await new Promise(done => setTimeout(done, 10));
  assert.doesNotMatch(nightly[0]![1]!.content, /可以随信附上的东西/);
  assert.match(nightly[0]![1]!.content, /## 今天当场记下的\n- （重要度 3）我当面送了农场主/);
});
