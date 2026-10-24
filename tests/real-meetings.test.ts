import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type TimedQuote, quotedCallOff, quotedChange, quotedInvite, quotedLater, quotedLaterCallOff, quotedToday } from '../src/agent/meeting-agreement.ts';
import { checkMeet, farInvitation, festivalVenue, MEET_PLACES } from '../src/agent/meetings.ts';
import { connect, harness, openTalk, WORLD } from './helpers/bridge.ts';

// Lines from the real-model run, batch A (docs/test-results/2026-10-23-real-meetings-A.md), all said at one game time.
const summer = (day: number) => 28 + day;
const lines = (time: number, ...said: ['玩家' | 'NPC', string][]): TimedQuote[] =>
  said.map(([speaker, text], index) => ({ id: `${speaker === '玩家' ? 'p' : 'n'}${index}`, speaker, text, time }));

test('today: a yes said as "老地方见", "我肯定到" or "答应你", to a proposal with no "一起" or "见" (real replies)', () => {
  assert.deepEqual(quotedToday(lines(1010, ['玩家', '下午两点一起去墓地走走？'], ['NPC', '墓地？欸，这提议不错。下午两点，老地方见。别迟到啊。']),
    MEET_PLACES, summer(22)), { time: 1400, place: '墓地', soon: false });
  assert.deepEqual(quotedToday(lines(1310, ['玩家', '晚上八点星之果实？我请客。'], ['NPC', '哇，请客？那我肯定到！八点星之果实，我记手腕上了……真记了，橡皮筋都绑好了。']),
    MEET_PLACES, summer(25)), { time: 2000, place: '星之果实餐吧', soon: false });
  assert.deepEqual(quotedToday(lines(1010, ['玩家', '下午有空的话来海边拍照吧？'], ['NPC', '拍照？哈，你倒是会挑。下午的光线正好，我勉强答应你吧。']),
    MEET_PLACES, summer(26)), { time: 1400, place: '海滩', soon: false });
  // A yes only implied is still none, and going alone is no appointment.
  assert.equal(quotedToday(lines(1210, ['玩家', '晚上去山上看星星吧，九点怎么样？'], ['NPC', '哇，真的吗？我正好想试试新调好的寻星镜！不过九点山上有点凉，你记得多穿一件。']),
    MEET_PLACES, summer(27)), null);
  assert.equal(quotedToday(lines(1010, ['玩家', '我下午自己去海边看看吧？'], ['NPC', '好啊。']), MEET_PLACES, summer(22)), null);
  // "可能" about coming still puts it off, and the new words do not agree when negated.
  assert.equal(quotedToday(lines(1010, ['玩家', '下午两点海边见？'], ['NPC', '好啊，不过我可能晚点才到。']), MEET_PLACES, summer(22)), null);
  for (const no of ['这可不是什么好主意。', '我不能答应你，下午有课。', '当然去不了啊，下午有课。']) {
    assert.equal(quotedToday(lines(1010, ['玩家', '下午两点一起去海边？'], ['NPC', no]), MEET_PLACES, summer(22)), null, no);
  }
});

test('later days: "这我可记住了", "当然要去啊", "那说定了", and "可能" about something else (real replies)', () => {
  // Sam's birthday, summer 17, said on summer 15; the conversation names it as the day (meetings.ts lastConversation).
  assert.deepEqual(quotedLater(lines(1010, ['玩家', '第45天下午一起去海边玩吧？'], ['NPC', '真的？第45天下午去海边？哇，兄弟，这我可记住了——别到时候反悔啊！']),
    MEET_PLACES, summer(15)), { day: summer(17), time: 1400, place: '海滩' });
  assert.deepEqual(quotedLater(lines(1010, ['玩家', '冬日星那天一起去吧？'],
    ['NPC', '一起……去冬日星？嗯，当然好呀。那个，我可能会有点不自在，人多的地方……不过和你一起，应该没事。']), MEET_PLACES, 107), { day: 109, time: 900, place: '冬日星盛宴' });
  assert.deepEqual(quotedLater(lines(1510, ['玩家', '后天晚上一起去海边看月光水母？'], ['NPC', '月光水母？当然要去啊。海边那晚最美了，你可别穿一身泥来站我旁边。']),
    MEET_PLACES, summer(26)), { day: summer(28), time: 2200, place: '月光水母起舞' });
  assert.deepEqual(quotedLater(lines(1210, ['玩家', '那就一起去花舞节吧！'], ['NPC', '哦、那说定了啊。我还以为得一个人在那儿乱晃呢……别迟到，我可不等人！']),
    MEET_PLACES, 22), { day: 24, time: 900, place: '花舞节' });
});

test('a move said yes to as "那更好……那就改到……" (real reply)', () => {
  assert.deepEqual(quotedChange(lines(1110, ['玩家', '后天的约改到上午十点行吗？'], ['NPC', '上午十点？那更好，夏天的中午太晒了。那就改到后天上午十点，森林河边。']),
    { day: summer(26), time: 1400, place: '森林河边' }, MEET_PLACES, summer(24)), { day: summer(26), time: 1000, place: '森林河边', by: '玩家' });
});

test('tomorrow\'s appointment from the nightly takes the same yes as today\'s: "……好呀", "*唉*行吧" (real replies)', () => {
  const sources = (...said: ['玩家' | 'NPC', string][]) => said.map(([speaker, text], index) => ({ id: `t${index + 1}`, speaker, text }));
  assert.deepEqual(checkMeet({ time: '10:00', place: '博物馆', sources: ['t2', 't3'] }, sources(['NPC', '啊，小林……又来图书室看书吗？还是……只是路过？'],
    ['玩家', '明天上午十点博物馆见，可以吗？'], ['NPC', '明天上午十点……好呀。正好那时候我在图书室给孩子们上课，不过课前有空。'])), { time: 1000, place: '博物馆' });
  assert.deepEqual(checkMeet({ time: '14:00', place: '海滩', sources: ['t1', 't2', 't3'] }, sources(
    ['NPC', '呃，又是你。……正好，我明天下午有点空。要不要一起去山上湖边走走？就散散步，没别的。'], ['玩家', '可以，不过换个地方吧，去海边怎么样？'],
    ['NPC', '海边？*唉*行吧，反正哪儿都比待在店里强。就是别指望我下水。'])), { time: 1400, place: '海滩' });
});

test('the player\'s own change to an invitation is kept when the reply says it back, and not otherwise', () => {
  const invite = (ask: string, answer: string, reply: string, time: number) => quotedInvite([{ id: 'n0', speaker: 'NPC', text: ask, time },
    { id: 'p1', speaker: '玩家', text: answer, time: time + 10 }, { id: 'n1', speaker: 'NPC', text: reply, time: time + 10 }], MEET_PLACES, summer(18));
  const maru = '嘿，小林！我正绕着山走一圈换换脑子，卡在一个小零件上想不通。对了，你傍晚有空吗？六点镇上的博物馆门口，陪我看看矿石标本怎么样？';
  assert.deepEqual(invite(maru, '好啊，不过能晚一个小时吗？', '当然行，七点就七点。多出来这一小时我正好把那零件再摆弄摆弄。', 1300),
    { day: summer(18), time: 1900, place: '博物馆' });
  assert.equal(invite(maru, '好啊，不过能晚一个小时吗？', '当然行。', 1300), null, 'the new time not said back');
  assert.equal(invite(maru, '好啊，不过五点行吗？', '当然行，七点就七点。', 1300), null, 'said back as another time');
  assert.deepEqual(invite(maru, '好啊，六点见！', '太好了。', 1300), { day: summer(18), time: 1800, place: '博物馆' }, 'the same time again is no change');
  const shane = '呃，又是你。……正好，我明天下午有点空。要不要一起去山上湖边走走？就散散步，没别的。';
  assert.deepEqual(invite(shane, '可以，不过换个地方吧，去海边怎么样？', '海边？*唉*行吧，反正哪儿都比待在店里强。就是别指望我下水。', 1830),
    { day: summer(19), time: 1400, place: '海滩' });
  assert.equal(invite(shane, '可以，不过换个地方吧，去海边怎么样？', '行吧。', 1830), null, 'the new place not said back');
  // Her own "傍晚" in the reply, after "晚点", is the time (the user's call, 2026-10-23).
  assert.deepEqual(invite('嘿，小林。这天气热得人发霉……*唉*对了，这个给你，我在洞里捡的蝙蝠翅膀，够酷吧？那个……晚点要不要一起去湖边走走？',
    '好啊，算我一个！', '真的？那说好了，别放我鸽子啊。傍晚湖边蚊子多，你别嫌我乱叫就行。', 1000), { day: summer(18), time: 1700, place: '山上湖边' });
});

test('a far day is told in a proposal with no "一起" too, so the NPC is asked to turn it down (real lines)', () => {
  assert.match(farInvitation('大后天下午去海边拍照吧？', summer(20))!, /^3 天后/);
  assert.match(farInvitation('这周六晚上去餐吧看比赛？', summer(15))!, /^5 天后/);
  assert.equal(farInvitation('后天下午去海边拍照吧？', summer(20)), undefined);
});

test('a festival the player names gets its day, where it is held and when it starts, on that turn only', { timeout: 15000 }, async t => {
  assert.equal(festivalVenue('明天一起去花舞节吧？', 23), '- 花舞节是明天（周三），在森林河边办，早上 9 点开始。');
  assert.equal(festivalVenue('后天晚上一起去海边看月光水母？', summer(26)), '- 月光水母起舞是后天（周日），在海滩办，晚上 10 点开始。');
  assert.equal(festivalVenue('冬日星那天一起去吧？', 107), '- 冬日星盛宴是后天（周四），在镇广场办，早上 9 点开始。');
  assert.equal(festivalVenue('明天下午海边见？', 23), undefined);
  const h = await harness(t);
  const wire = await connect(await h.start());
  await wire.until('day.meetings', 0);
  const system = () => h.fake.sent.at(-1)![0]!.content;
  const at = (time: number) => ({ ...WORLD.date, time });
  wire.send(openTalk(1)); await wire.until('talk.reply', wire.inbox.length);
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '复活节那天一起去吧？', date: at(610) }); await wire.until('talk.reply', wire.inbox.length);
  assert.match(system(), /- 复活节是春季 13 日（周六），在镇广场办，早上 9 点开始。/);
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '那就说定了。', date: at(620) }); await wire.until('talk.reply', wire.inbox.length);
  assert.doesNotMatch(system(), /复活节是/);
  await wire.close();
});

test('hours read as meant (real replies, batch B): "五点以后" is five, "推迟到九点" from eight at night is nine at night', () => {
  const invite = (ask: string, answer: string, reply: string, time: number) => quotedInvite([{ id: 'n0', speaker: 'NPC', text: ask, time },
    { id: 'p1', speaker: '玩家', text: answer, time: time + 10 }, { id: 'n1', speaker: 'NPC', text: reply, time: time + 10 }], MEET_PLACES, summer(24));
  assert.deepEqual(invite('啊，小林……你来啦。那个，我今天下午五点以后就没事了……要不要一起去海滩走走？', '当然好，我一定到。',
    '真的吗……那说定了。我会提前收拾好，不让你等。是不是有点太兴奋了……', 1000), { day: summer(24), time: 1700, place: '海滩' });
  assert.equal(invite('我下午五点以后有空，三点去海滩走走？', '好啊！', '嗯，说定了。', 1000), null, 'a clock before the hour she is free from');
  const moved = (player: string, npc: string, time: number) => quotedChange(lines(1310, ['玩家', player], ['NPC', npc]),
    { day: summer(15), time, place: '山上湖边' }, MEET_PLACES, summer(13));
  assert.deepEqual(moved('后天的约推迟到九点可以吗？', '九点……行吧。反正那时候天也黑了。', 2000), { day: summer(15), time: 2100, place: '山上湖边', by: '玩家' });
  assert.deepEqual(moved('后天的约提前到九点可以吗？', '行。', 2000), { day: summer(15), time: 900, place: '山上湖边', by: '玩家' });
  assert.deepEqual(moved('后天的约改到八点吧？', '好啊。', 1900), { day: summer(15), time: 2000, place: '山上湖边', by: '玩家' }, 'the nearer one');
});

test('a reply going at another part of the day than the clock is unsure; one naming it for something else is not (batch B)', () => {
  const ask = '嘿，小林。喏，蝙蝠翅膀，我自己弄到的战利品。*唉* 对了……今晚八点，去山上湖边坐会儿？';
  const invite = (answer: string, reply: string) => quotedInvite([{ id: 'n0', speaker: 'NPC', text: ask, time: 1400 },
    { id: 'p1', speaker: '玩家', text: answer, time: 1410 }, { id: 'n1', speaker: 'NPC', text: reply, time: 1410 }], MEET_PLACES, summer(23));
  assert.equal(invite('行啊，不过我更想去海边，可以吗？', '*唉* 海边啊，夏天晒得我头疼……行吧，傍晚去，太阳下山了再去，说好了。'), null);
  assert.deepEqual(invite('行啊，不过我更想去海边，可以吗？', '海边？行吧，八点海边见。'), { day: summer(23), time: 2000, place: '海滩' });
  assert.deepEqual(invite('好啊！', '好，晚上八点湖边见，下午我还有课。'), { day: summer(23), time: 2000, place: '山上湖边' });
});

test('a move by "往后推一个小时" and a call-off by "不去喝了，你别等我" (real lines, batch C)', () => {
  const grave = { day: summer(27), time: 1900, place: '墓地' };
  const moved = (player: string, npc: string) => quotedChange(lines(1110, ['玩家', player], ['NPC', npc]), grave, MEET_PLACES, summer(25));
  assert.deepEqual(moved('后天的约往后推一个小时，八点行吗？', '八点？行啊，天黑透了更带劲。欸，别迟到就行。'), { ...grave, time: 2000, by: '玩家' });
  assert.deepEqual(moved('后天的约往后推一个小时行吗？', '行啊。'), { ...grave, time: 2000, by: '玩家' }, 'no hour said: shifted');
  assert.deepEqual(moved('后天能提前半个小时吗？', '可以呀。'), { ...grave, time: 1830, by: '玩家' });
  assert.equal(moved('后天的约往后推一个小时行吗？', '不行，那太晚了。'), null);
  const saloon = MEET_PLACES['星之果实餐吧']!;
  const off = (player: string) => quotedLaterCallOff(lines(1210, ['玩家', player], ['NPC', '……哦。']), saloon, MEET_PLACES, summer(24), summer(22));
  assert.equal(off('后天的酒我就不去喝了，你别等我。'), '玩家');
  assert.equal(off('后天你别等我。'), '玩家');
  assert.equal(off('后天你先去餐吧，别等我，我晚点到。'), null, 'go ahead, I am coming');
  assert.equal(off('后天我不去换衣服了，直接去餐吧。'), null);
  assert.equal(quotedCallOff(lines(1210, ['玩家', '别等我，你先吃吧。'], ['NPC', '好。']), saloon, MEET_PLACES, summer(22)), null, 'not about the meeting');
});
