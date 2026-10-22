import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotedToday, type TimedQuote } from '../src/agent/meeting-agreement.ts';
import { lastConversation, MEET_PLACES, meetingLine, meetingMemory, sameDayMeeting } from '../src/agent/meetings.ts';
import { OPENING_LINE } from '../src/agent/dialogue.ts';
import type { DayEntry } from '../src/types.ts';
import { connect, harness, initial, openTalk, WORLD } from './helpers/bridge.ts';

/** Player and NPC lines in turn, all said at `time`. */
const talk = (time: number, ...lines: string[]): TimedQuote[] =>
  lines.map((text, i) => ({ id: `q${i}`, speaker: i % 2 ? 'NPC' : '玩家', text, time }));
const today = (time: number, ...lines: string[]) => quotedToday(talk(time, ...lines), MEET_PLACES);

test('an appointment agreed for today is found in the conversation, right away when no time is said', () => {
  assert.deepEqual(today(1000, '现在陪我下矿吧？', '欸，真的？现在？*哈*……好啊，我早就想下去看看了。'), { time: 1000, place: '矿洞', soon: true });
  assert.deepEqual(today(1000, '来我农场帮我浇水吧？', '浇水？那可是练手臂的好活儿。行啊小林，我正好把今天的训练改成农场特训。'),
    { time: 1000, place: '农场', soon: true }, '“行啊小林” agrees as plainly as “行啊。”');
  assert.deepEqual(today(1000, '今天下午两点海边见？', '海边？好啊。不过夏天的午后太阳毒，*唉*，我得挑个阴凉地方待着。两点见。'), { time: 1400, place: '海滩', soon: false });
  assert.deepEqual(today(1000, '下午一起去博物馆看看吧？', '那个……好啊，我本来就爱去图书室。上午还得给贾斯和文森特上课，下午见，行吗？'),
    { time: 1400, place: '博物馆', soon: false }, 'the morning under way is not the time meant');
  assert.deepEqual(today(1930, '晚上一起去星之果实餐吧坐坐？', '行吧，我换身衣服就去。'), { time: 1930, place: '星之果实餐吧', soon: true },
    'an evening already under way means now');
  assert.deepEqual(today(1200, '今晚八点星之果实餐吧见？', '嘿，当然去！八点星之果实，我肯定到——说不定还能蹭一口披萨。'),
    { time: 2000, place: '星之果实餐吧', soon: false }, '“八点” after “今晚八点” is the evening too');
  assert.deepEqual(today(1000, '一会儿陪我去海边捡贝壳好吗？', '海边……好呀。不过我得先去给贾斯和文森特上课，十一点开始。要不……早点去，捡完我再去？'),
    { time: 1000, place: '海滩', soon: true }, 'the hour of its own lesson is not the time to meet');
  assert.deepEqual(today(1000, '现在陪我去山上湖边看看吧？', '……好。湖水今天应该很平。'), { time: 1000, place: '山上湖边', soon: true });
  assert.deepEqual(today(1000, '下午三点一起去海边拍照？', '*唉*，总算有人说了句像样的话。那三点沙滩见，别迟到了。'), { time: 1500, place: '海滩', soon: false });
  // Asked, hesitated, then went along in the next line.
  assert.deepEqual(today(1100, '陪我下矿吧？', '下矿？……上次在山洞里被石蟹划的伤还没好利索。*唉* 我这种人还是待在地面上比较合适。', '那就现在出发！',
    '呃……你还真是说走就走。行吧，但我走不快，别指望我帮你打架。'), { time: 1100, place: '矿洞', soon: true }, 'the NPC’s own past does not make it another day');
  assert.deepEqual(today(1000, '下午两点海边见？', '好啊。', '还是三点吧？', '行，三点见。'), null, 'changed afterwards without the place: unsure');
  assert.deepEqual(today(1000, '现在陪我下矿吧？', '好啊。', '我们五点前出来吧。', '嗯，听你的。'), { time: 1000, place: '矿洞', soon: true },
    'a later time that changes nothing');
  assert.deepEqual(today(1000, '下午两点海边见？', '好啊。', '我想想……', '嗯？', '还是三点在海边见吧？', '行，三点见。'), { time: 1500, place: '海滩', soon: false },
    'the latest agreement wins');
});

test('replies that send the player alone, refuse, or put it off are not appointments', () => {
  // Each NPC line was a real reply the first version took for a yes (docs/npc-same-day-meetings.md §3).
  for (const [player, npc] of [
    ['待会儿一起去矿洞吧？', '矿洞啊……我昨晚刚被石蟹划了一下，还疼着呢。*唉* 你找山姆陪你吧。'],
    ['现在陪我下矿吧？', '哈？下矿？*唉* 我才不要钻进那种又黑又脏的洞里，出来头发全是灰。'],
    ['现在陪我下矿吧？', '下矿？呃，那里面又黑又脏，我的头发和衣服全得毁掉。你自己去吧。'],
    ['那就现在出发去矿洞！', '*唉*……你还真不听劝。行吧，我在这儿等你回来。'],
    ['明天上午陪我下矿吧？', '下矿？真的？*嘿*……我去！'],
    ['以后有空陪我下矿吧。', '真的？我一直想下去看看！说好了，别自己去，等我一起。'],
    ['我今天下午要去海边钓鱼。', '去海边啊……真好。钓到鱼记得分我一条，好吗？'],
    ['昨天陪我去海边真开心，对吧？', '是啊，好开心。'],
    ['下午三点在杂货店见？', '好啊。'],
    ['现在陪我去海边还是去矿洞？', '好啊。'],
    ['如果下午有空，一起去海边吧？', '好啊。'],
    ['星之果实餐吧，今天晚上一起去？', '星之果实餐吧？*唉*，总比在家待着强。你打算几点去？'],
    ['一会儿陪我去海边捡贝壳好吗？', '去海边……听起来真好。只是我十点得去给孩子们上课，等课上完，可以吗？'],
    ['陪我下矿吧？', '……再见。'],
  ]) assert.equal(today(1600, player!, npc!), null, `${player} / ${npc}`);
  assert.equal(today(2100, '现在一起去酒吧吧？', '好啊。'), null, 'too late to set off');
  assert.equal(today(600, '7:30在海边见？', '好啊。'), null, 'before 8:00');
  assert.equal(today(1000, '陪我下矿吧？', '好啊！', '算了，今天不去了，改天吧。', '*唉*好吧。'), null, 'taken back in the same conversation');
  assert.equal(today(1000, '待会儿陪我下矿？', '不过你要去的话，我可以陪你走一趟。', '还是算了，你忙吧。', '……行吧。'), null,
    'the player taking it back needs no place');
});

const turn = (seq: number, minute: number, player: string, npc: string): DayEntry =>
  ({ seq, gameTime: 1440 * 2 + minute, changes: [{ npcId: 'abigail', log: { player, npc } }] });

test('only the conversation that just ended is checked, with the time each line was said', () => {
  const entries = [turn(1, 540, OPENING_LINE, '嗨。'), turn(2, 550, '陪我下矿吧？', '好啊。'),
    turn(3, 600, OPENING_LINE, '又是你。'), turn(4, 610, '今天天气真好。', '是啊。')];
  assert.deepEqual(lastConversation(entries, 'abigail').map(quote => [quote.speaker, quote.text, quote.time]),
    [['NPC', '又是你。', 1000], ['玩家', '今天天气真好。', 1010], ['NPC', '是啊。', 1010]], 'the opening line is not the player’s');
  assert.equal(lastConversation([turn(1, 70, '陪我下矿吧？', '好啊。')], 'abigail')[0]!.time, 2510, 'after midnight counts on from 24:00');
  const logged = [{ seq: 5, gameTime: 0, changes: [{ npcId: 'abigail', log: { meetToday: { time: 1000, place: '矿洞', soon: true } } }] }];
  assert.deepEqual(sameDayMeeting(logged, 'abigail'), { time: 1000, place: '矿洞', sameDay: true, soon: true });
  assert.deepEqual(sameDayMeeting([...logged, { seq: 6, gameTime: 0, changes: [{ npcId: 'abigail', log: { meeting: { met: true } } }] }], 'abigail'),
    { time: 1000, place: '矿洞', sameDay: true, soon: true, ended: true });
  assert.equal(sameDayMeeting([{ ...logged[0]!, changes: [{ npcId: 'abigail', log: { meetToday: { time: 1000, place: '你家' } } }] }], 'abigail'), undefined);
});

test('the NPC knows it agreed to go right away, until the Mod reports the appointment over', () => {
  const soon = { time: 1000, place: '矿洞', sameDay: true as const, soon: true as const };
  assert.equal(meetingLine(soon, 1030, false), '今天 10:00 约好马上去矿洞见面');
  assert.equal(meetingLine(soon, 1900, true), '今天 10:00 约好马上去矿洞见面，现在就在这里碰面了', 'it may come late, so ninety minutes mean nothing');
  assert.equal(meetingLine({ ...soon, ended: true }, 1300, false), undefined);
  assert.equal(meetingLine(soon, 2200, false), undefined);
  assert.equal(meetingLine({ time: 1400, place: '海滩', sameDay: true }, 1600, false), '今天 14:00 在海滩见面');
  assert.equal(meetingMemory({ ...soon, met: false, left: 1320 }).text, '约好马上去矿洞见面，我等到 13:20，农场主没来。');
  assert.equal(meetingMemory({ ...soon, met: true, left: 1320, trip: { floor: 3, deepest: 5, kills: 2, fights: true, rescued: false } }).text,
    '约好马上去矿洞见面，农场主来了，我陪农场主下到矿洞第 5 层，打倒了 2 只怪物。');
});

test('agreed in a conversation, the appointment reaches the Mod at once, rolls back unsaved, and is remembered as agreed', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const originalChat = h.fake.model.chat.bind(h.fake.model);
  h.fake.model.chat = async (...args: Parameters<typeof originalChat>) => {
    const result = await originalChat(...args);
    const asked = /陪我下矿|一起去海边/.test(args[0].at(-1)!.content);
    return asked ? { ...result, content: JSON.stringify({ ...JSON.parse(result.content), reply: '……好啊，走吧。' }) } : result;
  };
  const server = await h.start();
  const wire = await connect(server);
  const at = (time: number) => ({ ...WORLD.date, time });
  const converse = async (npc: string, time: number, line: string) => {
    wire.send({ ...openTalk(1, npc), world: { ...WORLD, date: at(time) } }); await wire.until('talk.reply', wire.inbox.length);
    wire.send({ type: 'talk.say', npc, text: line, date: at(time) }); await wire.until('talk.reply', wire.inbox.length);
    const from = wire.inbox.length;
    wire.send({ type: 'talk.close', npc }); await wire.until('ack', from);
    return from;
  };
  const from = await converse('Abigail', 1000, '现在陪我下矿吧？');
  const sent = await wire.until('day.meetings', from) as { meetings: unknown[] };
  assert.deepEqual(sent.meetings, [{ npc: 'abigail', time: 1000, place: '矿洞', sameDay: true }]);
  assert.ok(h.logs.includes('阿比盖尔答应了今天的约定：10:00 说好马上去 矿洞'));
  // One a day: asking again settles nothing new.
  await converse('Abigail', 1030, '现在陪我下矿吧？');
  assert.equal(h.logs.filter(line => line.startsWith('阿比盖尔答应了')).length, 1);

  const prompt = () => h.fake.sent.at(-1)!.map(message => message.content).join('\n');
  wire.send({ ...openTalk(1), world: { ...WORLD, date: at(1150) }, atMeeting: true }); await wire.until('talk.reply', wire.inbox.length);
  assert.match(prompt(), /- 和农场主的约定：今天 10:00 约好马上去矿洞见面，现在就在这里碰面了/);
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack', wire.inbox.length);
  // The Mod moved it to when she could get there; she remembers what was agreed.
  wire.send({ type: 'meet.ended', npc: 'Abigail', place: '矿洞', time: 1150, left: 1320, met: true,
    mine: { floor: 3, deepest: 5, kills: 2, fights: true, rescued: false }, date: at(1320) });
  await wire.until('ack', wire.inbox.length);
  assert.ok(h.logs.includes('阿比盖尔记下了：约好马上去矿洞见面，农场主来了，我陪农场主下到矿洞第 5 层，打倒了 2 只怪物。'));
  wire.send({ ...openTalk(1), world: { ...WORLD, date: at(1400) } }); await wire.until('talk.reply', wire.inbox.length);
  assert.doesNotMatch(prompt(), /和农场主的约定/, 'over once reported');
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack', wire.inbox.length);

  // Three a day in all.
  for (const npc of ['Sam', 'Leah', 'Haley']) await converse(npc, 1500, '现在一起去海边吧？');
  assert.ok(h.logs.includes('山姆答应了今天的约定：15:00 说好马上去 海滩') && h.logs.includes('莉亚答应了今天的约定：15:00 说好马上去 海滩'));
  assert.ok(!h.logs.some(line => line.startsWith('海莉答应了')), 'a fourth appointment was kept');
  await wire.close();

  // Not saved: a new load of the same day has none of them.
  const reloaded = await connect(server, initial('load-2'));
  const list = await reloaded.until('day.meetings', 0) as { meetings: unknown[] };
  assert.deepEqual(list.meetings, []);
  await reloaded.close();
});
