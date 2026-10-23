import assert from 'node:assert/strict';
import { test } from 'node:test';
import { festivalDay, festivalOn, namedDays, type TimedQuote, quotedChange, quotedDecline, quotedLater, quotedToday } from '../src/agent/meeting-agreement.ts';
import { festivalClash, laterMeetings, laterNote, meetingLine, meetingMemory, MEET_PLACES, moodLine, stoodUpTopics, tripText, turnedDownNote, upcomingLine, visitLine, visitMemory } from '../src/agent/meetings.ts';
import { parseModMessage } from '../src/bridge/protocol.ts';
import { connect, harness, meetingsSent, openTalk, WORLD } from './helpers/bridge.ts';

const at = (time: number) => (speaker: '玩家' | 'NPC', text: string, id = speaker + text): TimedQuote => ({ id, speaker, text, time });

test('stored evening festival appointments survive reading while ordinary late or festival-day meetings stay invalid', () => {
  const restored = (day: number, time: number, place: string) => laterMeetings([{ topics: laterNote({ day, time, place }).topics!, gameTime: 1 }]);
  assert.deepEqual(restored(56, 2200, '月光水母起舞'), [{ day: 56, time: 2200, place: '月光水母起舞' }]);
  assert.deepEqual(restored(83, 2200, '万灵节'), [{ day: 83, time: 2200, place: '万灵节' }]);
  assert.deepEqual(restored(24, 900, '花舞节'), [{ day: 24, time: 900, place: '花舞节' }]);
  assert.deepEqual(restored(55, 2200, '月光水母起舞'), []);
  assert.deepEqual(restored(56, 900, '月光水母起舞'), []);
  assert.deepEqual(restored(55, 2200, '海滩'), []);
  assert.deepEqual(restored(56, 1400, '海滩'), []);
});

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

const kept = { day: 40, time: 1400, place: '海滩' }; // summer 12 (the 11th is the Luau)
const pair = (player: string, npc: string, playerFirst = true) => playerFirst
  ? [at(1000)('玩家', player), at(1000)('NPC', npc)] : [at(1000)('NPC', npc), at(1000)('玩家', player)];

test('an appointment is moved by what follows "改成/换到/还是", the rest staying; either side may ask, the other must plainly agree (docs/npc-meetings-more.md §1)', () => {
  const moved = (player: string, npc: string, playerFirst = true) => quotedChange(pair(player, npc, playerFirst), kept, MEET_PLACES, 40);
  assert.deepEqual(moved('三点改成五点吧', '行。'), { day: 40, time: 1700, place: '海滩', by: '玩家' });
  assert.deepEqual(moved('我们别去海边了，改去广场吧？', '好呀。'), { day: 40, time: 1400, place: '镇广场', by: '玩家' });
  assert.deepEqual(moved('今天的改到明天下午吧？', '嗯，明天下午见。'), { day: 41, time: 1400, place: '海滩', by: '玩家' });
  assert.deepEqual(moved('还是去墓地吧？', '可以啊。'), { day: 40, time: 1400, place: '墓地', by: '玩家' });
  assert.deepEqual(moved('好啊！', '我下午要帮妈妈看店，改到傍晚好吗？', false), { day: 40, time: 1700, place: '海滩', by: 'NPC' });
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

test('stood up, the NPC minds three days, turned down one; only a plain no counts as turning it down (docs/npc-meetings-more.md §2)', () => {
  const stood = { topics: stoodUpTopics(39, { time: 1400, place: '海滩' }, 1530) };
  assert.equal(moodLine([stood], 41), '- 前天约好 14:00 在海滩见面，农场主没来（你等到 15:30），你还记着；这几天农场主再约你，答不答应看你自己。');
  assert.equal(moodLine([stood], 43), undefined, 'over after three days');
  const down = { topics: turnedDownNote(41).topics! };
  assert.equal(moodLine([down], 42), '- 昨天你开口约农场主出去，农场主当场说不行，没约成。');
  assert.equal(moodLine([down], 43), undefined);
  assert.match(moodLine([down, stood], 41)!, /^- 前天约好/, 'being stood up weighs more');
  const answer = (text: string) => quotedDecline([at(1000)('NPC', '下午三点一起去海滩吧？'), at(1000)('玩家', text)]);
  assert.ok(answer('今天不太行，下次吧。') && answer('不了，我要忙农场。') && answer('没空。'));
  assert.ok(!answer('嗯……我得看看农场的活儿。') && !answer('我考虑一下。') && !answer('好啊！'));
  assert.equal(quotedDecline([at(1000)('NPC', '你好，今天天气不错。'), at(1000)('玩家', '今天不行。')]), false,
    'An invitation hint without an actual invitation cannot become a rejection memory.');
});

test('the talks after being stood up or turned down carry that line', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const originalChat = h.fake.model.chat.bind(h.fake.model);
  h.fake.model.chat = async (...args: Parameters<typeof originalChat>) => {
    const result = await originalChat(...args);
    const asking = args[0][0]!.content.includes('你今天想主动约农场主') ? '下午三点一起去海滩走走吧？' : undefined;
    return asking ? { ...result, content: JSON.stringify({ ...JSON.parse(result.content), reply: asking }) } : result;
  };
  const server = await h.start();
  const wire = await connect(server);
  await wire.until('day.meetings', 0);
  const day = (time: number) => ({ ...WORLD.date, time });
  const system = () => h.fake.sent.at(-1)![0]!.content;
  wire.send({ type: 'meet.ended', npc: 'Abigail', place: '海滩', time: 1400, left: 1530, met: false, stoodUp: true, date: day(1530) });
  await wire.until('ack', wire.inbox.length);
  wire.send({ ...openTalk(1), world: { ...WORLD, date: day(1600) } }); await wire.until('talk.reply', wire.inbox.length);
  assert.match(system(), /- 今天约好 14:00 在海滩见面，农场主没来（你等到 15:30），你还记着/);
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack', wire.inbox.length);
  wire.send({ ...openTalk(1, 'Sam'), world: { ...WORLD, date: day(1000) }, invite: true }); await wire.until('talk.reply', wire.inbox.length);
  wire.send({ type: 'talk.say', npc: 'Sam', text: '今天不太行，下次吧。', date: day(1010) }); await wire.until('talk.reply', wire.inbox.length);
  wire.send({ type: 'talk.close', npc: 'Sam' }); await wire.until('ack', wire.inbox.length);
  wire.send({ ...openTalk(1, 'Sam'), world: { ...WORLD, date: day(1100) } }); await wire.until('talk.reply', wire.inbox.length);
  assert.match(system(), /- 今天你开口约农场主出去，农场主当场说不行，没约成。/);
  assert.doesNotMatch(system(), /农场主没来/, 'only the one stood up minds that');
  await wire.close();
});

test('a festival names its day and is the place that day; nowhere else is agreed on it (docs/npc-meetings-more.md §3)', () => {
  assert.deepEqual(quotedLater(pair('月光水母那天一起在海边看水母吧？', '好啊，月光水母起舞那天一起去。'), MEET_PLACES, 54),
    { day: 56, time: 2200, place: '月光水母起舞' });
  assert.deepEqual(quotedLater(pair('冬日星那天一起去吧？', '好啊，一起去冬日星盛宴。'), MEET_PLACES, 107),
    { day: 109, time: 900, place: '冬日星盛宴' });
  assert.equal(quotedLater(pair('去年冬日星那天我们一起去吧？', '好啊。'), MEET_PLACES, 107), null);
  // Spring 22 is a Monday; the Flower Dance is spring 24, the Moonlight Jellies summer 28 at 22:00.
  assert.equal(festivalDay('花舞节', 22), 24);
  assert.equal(festivalDay('花舞节', 25), 24 + 112, 'next year once it is past');
  assert.equal(festivalOn(24), '花舞节');
  assert.equal(festivalOn(25), undefined);
  assert.deepEqual(namedDays('花舞节那天', 22), [24]);
  const said = (player: string, npc: string, time = 1000) => [at(time)('玩家', player), at(time)('NPC', npc)];
  assert.deepEqual(quotedLater(said('花舞节那天一起去吧？', '好啊，花舞节见。'), MEET_PLACES, 22), { day: 24, time: 900, place: '花舞节' });
  assert.deepEqual(quotedToday(said('一起去花舞节吧？', '好啊，走吧。'), MEET_PLACES, 24), { time: 900, place: '花舞节', soon: false });
  assert.deepEqual(quotedToday(said('今晚一起去看月光水母吧？', '好啊，晚上海边见。', 1500), MEET_PLACES, 56), { time: 2200, place: '月光水母起舞', soon: false },
    'the beach is where the jellies are');
  assert.equal(festivalClash('月光水母那天一起去海边吧？', 54), undefined, 'where the festival is held');
  assert.deepEqual(quotedToday(said('今晚一起去看月光水母吧？', '好啊，一起去。', 1500), MEET_PLACES, 56), { time: 2200, place: '月光水母起舞', soon: false });
  assert.equal(quotedLater(said('花舞节那天在海边见？', '好啊。'), MEET_PLACES, 22), null, 'an ordinary place on a festival day');
  assert.equal(quotedToday(said('下午两点海边见？', '好啊，两点见。'), MEET_PLACES, 24), null, 'nor today, on the festival');
  assert.equal(festivalClash('花舞节那天下午一起去海边吧？', 22), '- 农场主说的春季 24 日（周三）是花舞节，在森林河边办，大家都要去节日，普通地方约不了；要约就约一起去花舞节。');
  assert.equal(festivalClash('后天下午一起去海边吧？', 22), festivalClash('花舞节那天下午一起去海边吧？', 22));
  assert.equal(festivalClash('花舞节那天一起去吧？', 22), undefined, 'going together is fine');
  assert.equal(festivalClash('明天下午一起去海边吧？', 22), undefined, 'not a festival day');
  const dance = { time: 900, place: '花舞节' };
  assert.equal(meetingLine(dance, 1000, true), '今天一起去花舞节，现在就在这里碰面了');
  assert.equal(meetingLine(dance, 1000, false), '今天一起去花舞节');
  assert.equal(meetingMemory({ ...dance, met: false, left: 2200 }).text, '约好一起去花舞节，农场主没来。');
  assert.equal(meetingMemory({ ...dance, met: true, left: 1400 }).text, '约好一起去花舞节，农场主来了。');
  assert.equal(upcomingLine([{ ...dance, day: 24 }], 22), '后天（周三）一起去花舞节');
  assert.equal(moodLine([{ topics: stoodUpTopics(24, dance, 2200) }], 25), '- 昨天约好一起去花舞节，农场主没来，你还记着；这几天农场主再约你，答不答应看你自己。');
});

test('"你生日那天" said to the NPC names its birthday', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const originalChat = h.fake.model.chat.bind(h.fake.model);
  h.fake.model.chat = async (...args: Parameters<typeof originalChat>) => {
    const result = await originalChat(...args);
    const asked = /生日那天/.test(args[0].at(-1)!.content);
    return asked ? { ...result, content: JSON.stringify({ ...JSON.parse(result.content), reply: '好啊，那天下午海边见。' }) } : result;
  };
  const server = await h.start();
  const wire = await connect(server);
  await wire.until('day.meetings', 0);
  wire.send({ ...openTalk(1), birthday: { season: 'spring', day: 3 } }); await wire.until('talk.reply', wire.inbox.length);
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '你生日那天下午一起去海边吧？', date: { ...WORLD.date, time: 1000 } }); await wire.until('talk.reply', wire.inbox.length);
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack', wire.inbox.length);
  const note = '阿比盖尔记下了：约好春季 3 日（周三）14:00 在海滩见面。';
  for (let i = 0; i < 300 && !h.logs.includes(note); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(h.logs.includes(note), h.logs.filter(line => line.includes('阿比盖尔')).join('\n'));
  await wire.close();
});

test('come to help unasked: the talk on the farm says so, and the memory keeps it without an appointment (docs/npc-meetings-more.md §5)', { timeout: 15000 }, async t => {
  const helped = { watered: 120, harvested: 35, fed: 0, ponds: 0 };
  assert.equal(visitLine(helped), '你今天没约就自己来农场主的农场帮忙；你来了以后已经浇了 120 格水、收了 35 个作物放进农舍门口的箱子');
  assert.equal(visitMemory(helped, false).text, '我没约就去了农场主的农场帮忙，浇了 120 格水、收了 35 个作物放进农舍门口的箱子；农场主不在。');
  const h = await harness(t);
  const server = await h.start();
  const wire = await connect(server);
  await wire.until('day.meetings', 0);
  const day = (time: number) => ({ ...WORLD.date, time });
  wire.send({ ...openTalk(1), world: { ...WORLD, date: day(1000) }, atMeeting: true, helped, visit: true }); await wire.until('talk.reply', wire.inbox.length);
  const system = h.fake.sent.at(-1)![0]!.content;
  assert.match(system, /- 你今天没约就自己来农场主的农场帮忙；你来了以后已经浇了 120 格水/);
  assert.doesNotMatch(system, /和农场主的约定/);
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack', wire.inbox.length);
  wire.send({ type: 'meet.ended', npc: 'Abigail', place: '农场', time: 900, arrived: 900, left: 1030, met: true, helped, surprise: true, date: day(1030) });
  await wire.until('ack', wire.inbox.length);
  assert.ok(h.logs.includes('阿比盖尔记下了：我没约就去了农场主的农场帮忙，浇了 120 格水、收了 35 个作物放进农舍门口的箱子；农场主来了。'));
  await wire.close();
});

test('the stones it broke underground are said in the talk and kept in the memory; an older Mod sends none (docs/npc-meetings-more.md §6)', () => {
  const trip = { floor: 35, deepest: 40, kills: 12, fights: true, rescued: false, mined: 23 };
  assert.equal(tripText('矿洞', trip), '你一直陪着农场主，现在在矿洞第 35 层，最深到过第 40 层，你打倒了 12 只怪物，你帮农场主敲碎了 23 块石头');
  assert.equal(tripText('矿洞', { ...trip, mined: 0 }), '你一直陪着农场主，现在在矿洞第 35 层，最深到过第 40 层，你打倒了 12 只怪物');
  assert.equal(meetingMemory({ time: 1000, place: '矿洞', met: true, left: 1500, trip }).text,
    '约好 10:00 在矿洞见面，农场主来了，我陪农场主下到矿洞第 40 层，打倒了 12 只怪物，帮农场主敲碎了 23 块石头。');
  const base = { type: 'meet.ended', lineageId: 'farm', loadNonce: 'n', seq: 3, npc: 'Abigail', place: '矿洞', time: 1000, left: 1500, met: true,
    date: { year: 1, season: 'spring', day: 2, time: 1500 } };
  assert.deepEqual((parseModMessage(JSON.stringify({ ...base, mine: trip })) as { mine?: unknown }).mine, trip);
  const { mined: _, ...older } = trip;
  assert.ok(parseModMessage(JSON.stringify({ ...base, mine: older })));
  for (const mined of [-1, 1.5, '3']) assert.throws(() => parseModMessage(JSON.stringify({ ...base, mine: { ...trip, mined } })), String(mined));
});
