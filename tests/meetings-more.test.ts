import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type TimedQuote, quotedChange, quotedToday } from '../src/agent/meeting-agreement.ts';
import { MEET_PLACES } from '../src/agent/meetings.ts';
import { connect, harness, meetingsSent, openTalk, WORLD } from './helpers/bridge.ts';

const at = (time: number) => (speaker: '玩家' | 'NPC', text: string, id = speaker + text): TimedQuote => ({ id, speaker, text, time });

test('"一点" is one o’clock only as a time; "早一点", "人少一点", "一点都不" are a little (docs/npc-meetings-more.md §0)', () => {
  const said = (line: string) => quotedToday([at(1000)('玩家', line), at(1000)('NPC', '好啊，说定了。')], MEET_PLACES);
  assert.deepEqual(said('下午一点海边见？'), { time: 1300, place: '海滩', soon: false });
  assert.deepEqual(said('一点海边见？'), { time: 1300, place: '海滩', soon: false });
  assert.deepEqual(said('一点钟一起去海边吧？'), { time: 1300, place: '海滩', soon: false });
  assert.deepEqual(said('一点半海边见？'), { time: 1330, place: '海滩', soon: false });
  for (const line of ['早一点一起去海边吧？', '人少一点的时候一起去海边吧？', '一点都不累，一起去海边吧？']) {
    assert.deepEqual(said(line), { time: 1000, place: '海滩', soon: true }, line);
  }
});

const kept = { day: 39, time: 1400, place: '海滩' };
const pair = (player: string, npc: string, playerFirst = true) => playerFirst
  ? [at(1000)('玩家', player), at(1000)('NPC', npc)] : [at(1000)('NPC', npc), at(1000)('玩家', player)];

test('an appointment is moved by what follows "改成/换到/还是", the rest staying; either side may ask, the other must plainly agree (docs/npc-meetings-more.md §1)', () => {
  const moved = (player: string, npc: string, playerFirst = true) => quotedChange(pair(player, npc, playerFirst), kept, MEET_PLACES, 39);
  assert.deepEqual(moved('三点改成五点吧', '行。'), { day: 39, time: 1700, place: '海滩', by: '玩家' });
  assert.deepEqual(moved('我们别去海边了，改去广场吧？', '好呀。'), { day: 39, time: 1400, place: '镇广场', by: '玩家' });
  assert.deepEqual(moved('今天的改到明天下午吧？', '嗯，明天下午见。'), { day: 40, time: 1400, place: '海滩', by: '玩家' });
  assert.deepEqual(moved('还是去墓地吧？', '可以啊。'), { day: 39, time: 1400, place: '墓地', by: '玩家' });
  assert.deepEqual(moved('好啊！', '我下午要帮妈妈看店，改到傍晚好吗？', false), { day: 39, time: 1700, place: '海滩', by: 'NPC' });
  for (const [player, npc, playerFirst] of [['换个话题吧', '好啊'], ['还是算了吧', '好吧'], ['改成五点吧？', '五点不行，我要看店。'], ['改到下周三吧', '好'],
    ['嗯……我看看吧。', '改到傍晚好吗？', false], ['改成上午九点吧？', '好啊。']] as const) {
    assert.equal(moved(player, npc, playerFirst ?? true), null, `${player}｜${npc}`);
  }
});

test('moved today, the Mod gets the new time and place; moved to tomorrow, today’s says where and a note keeps tomorrow’s', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const replies: Record<string, string> = { '下午两点一起去海边吧？': '好啊，两点海边见。', '下午的约改成五点在广场吧？': '好呀。', '今天的改到明天下午三点吧？': '好，明天见。' };
  const originalChat = h.fake.model.chat.bind(h.fake.model);
  h.fake.model.chat = async (...args: Parameters<typeof originalChat>) => {
    const result = await originalChat(...args);
    const reply = replies[args[0].at(-1)!.content.replace(/（用 json.*$/, '')];
    return reply ? { ...result, content: JSON.stringify({ ...JSON.parse(result.content), reply }) } : result;
  };
  const server = await h.start();
  const wire = await connect(server);
  await wire.until('day.meetings', 0);
  const day = (time: number) => ({ ...WORLD.date, time });
  const converse = async (line: string, time: number) => {
    wire.send({ ...openTalk(1), world: { ...WORLD, date: day(time) } }); await wire.until('talk.reply', wire.inbox.length);
    wire.send({ type: 'talk.say', npc: 'Abigail', text: line, date: day(time) }); await wire.until('talk.reply', wire.inbox.length);
    const from = wire.inbox.length;
    wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack', from);
    return from;
  };
  let from = await converse('下午两点一起去海边吧？', 1000);
  assert.deepEqual(await meetingsSent(wire, from, [{ npc: 'abigail', time: 1400, place: '海滩', sameDay: true }]),
    [{ npc: 'abigail', time: 1400, place: '海滩', sameDay: true }]);
  from = await converse('下午的约改成五点在广场吧？', 1100);
  const moved = [{ npc: 'abigail', time: 1700, place: '镇广场', sameDay: true }];
  assert.deepEqual(await meetingsSent(wire, from, moved), moved);
  assert.ok(h.logs.includes('阿比盖尔今天的约定改到 17:00 镇广场'));
  from = await converse('今天的改到明天下午三点吧？', 1200);
  const off = [{ npc: 'abigail', time: 1700, place: '镇广场', sameDay: true, calledOff: true, movedTo: '明天（周二）15:00 在镇广场' }];
  assert.deepEqual(await meetingsSent(wire, from, off), off);
  const note = '阿比盖尔记下了：约好春季 2 日（周二）15:00 在镇广场见面。';
  for (let i = 0; i < 300 && !h.logs.includes(note); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(h.logs.includes(note) && h.logs.includes('阿比盖尔记下了：约好 17:00 在镇广场见面，后来改到明天（周二）15:00 在镇广场。'),
    h.logs.filter(line => line.includes('阿比盖尔')).join('\n'));
  await wire.close();
});

test('one kept for the day after tomorrow moved to tomorrow: the old day is hidden, the new one kept', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const replies: Record<string, string> = { '后天下午两点一起去海边吧？': '好啊，后天两点海边见。', '后天的改到明天上午十点吧？': '行，明天上午见。' };
  const originalChat = h.fake.model.chat.bind(h.fake.model);
  h.fake.model.chat = async (...args: Parameters<typeof originalChat>) => {
    const result = await originalChat(...args);
    const reply = replies[args[0].at(-1)!.content.replace(/（用 json.*$/, '')];
    return reply ? { ...result, content: JSON.stringify({ ...JSON.parse(result.content), reply }) } : result;
  };
  const server = await h.start();
  const wire = await connect(server);
  await wire.until('day.meetings', 0);
  for (const [line, time] of [['后天下午两点一起去海边吧？', 1000], ['后天的改到明天上午十点吧？', 1100]] as const) {
    wire.send({ ...openTalk(1, 'Sam'), world: { ...WORLD, date: { ...WORLD.date, time } } }); await wire.until('talk.reply', wire.inbox.length);
    wire.send({ type: 'talk.say', npc: 'Sam', text: line, date: { ...WORLD.date, time } }); await wire.until('talk.reply', wire.inbox.length);
    wire.send({ type: 'talk.close', npc: 'Sam' }); await wire.until('ack', wire.inbox.length);
  }
  const notes = ['山姆记下了：约好春季 3 日（周三）14:00 在海滩见面。', '山姆记下了：约好春季 3 日（周三）14:00 在海滩见面，后来改到明天（周二）10:00 在海滩。',
    '山姆记下了：约好春季 2 日（周二）10:00 在海滩见面。'];
  for (let i = 0; i < 300 && !notes.every(note => h.logs.includes(note)); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(notes.every(note => h.logs.includes(note)), h.logs.filter(line => line.includes('山姆')).join('\n'));
  // The talk the next day knows tomorrow's: the old day is gone.
  wire.send({ ...openTalk(1, 'Sam'), world: { ...WORLD, date: { ...WORLD.date, time: 1300 } } }); await wire.until('talk.reply', wire.inbox.length);
  assert.match(h.fake.sent.at(-1)![0]!.content, /- 和农场主的约定：明天（周二）10:00 在海滩见面/);
  await wire.close();
});
