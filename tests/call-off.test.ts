import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotedCallOff, type TimedQuote } from '../src/agent/meeting-agreement.ts';
import { MEET_PLACES, meetingLine, meetingMemory, todayMeeting } from '../src/agent/meetings.ts';
import type { DayEntry, NpcState } from '../src/types.ts';
import { connect, harness, openTalk, WORLD } from './helpers/bridge.ts';

const talk = (...lines: string[]): TimedQuote[] => lines.map((text, i) => ({ id: `q${i}`, speaker: i % 2 ? 'NPC' : '玩家', text, time: 1100 }));
const off = (place: string, ...lines: string[]) => quotedCallOff(talk(...lines), MEET_PLACES[place]!, MEET_PLACES);

test('taking today’s appointment back, or sending the NPC home, is read from plain words only', () => {
  // Real replies from docs/npc-call-off.md §3.
  assert.equal(off('海滩', '今天下午的约定取消吧，我临时有事。', '取消了？*唉*……我本来还想着在海边捡点浮木呢。没事，你的事要紧。'), '玩家');
  assert.equal(off('海滩', '抱歉，我今天下午不去海边了。', '哦……这样啊。没关系，我自己去海边走走也好。'), '玩家');
  assert.equal(off('矿洞', '下矿……还是算了吧，那下面又热又挤。', '好吧。'), '玩家');
  assert.equal(off('森林河边', '下午森林那边我去不了了，抱歉。', '没关系。'), '玩家');
  assert.equal(off('矿洞', '我改主意了，今天不下矿了。', '呃……行吧。我在这站了半天，你就这么一句。'), '玩家');
  assert.equal(off('农场', '谢谢你帮忙，今天就到这儿吧。', '嘿，活儿干完了？行吧，我正好回去补几组俯卧撑。改天再叫我。'), '玩家');
  assert.equal(off('矿洞', '你先回去吧，我自己再往下走走。', '欸，才第12层你就让我回去？我看你是想甩开我自己去冒险吧。'), '玩家');
  assert.equal(off('海滩', '下午还去海边吗？', '说实话……我今天去不了了，诊所那边走不开。'), 'NPC');
  for (const lines of [
    ['下午还去海边吗？', '当然去，两点在海滩见。'],
    ['我可能会晚一点到海边。', '没关系，海又不会跑掉。'],
    ['我先走了，下午见。', '好，下午两点海滩见。'],
    ['改天再聊吧。', '好。对了，两点海滩见，我可没忘。'],
    ['你今天看起来很累，下午要是去不了就说一声。', '*唉* 是有点……下午的海滩我还想去，让我歇一会儿就好。'],
    ['累了吗？要不要先回去？', '回去？才到12层呢。'],
    ['如果下雨，今天就不去海边了。', '好。'],
    ['算了，我回农场了。', '好。'],
    ['明天我没法去海边了。', '那就后天吧。'],
    ['你不来了吗？', '来啊。'],
  ]) assert.equal(off('海滩', ...lines), null, lines.join(' / '));
  assert.equal(off('矿洞', '你先回去吧，我自己再往下走走。', '欸，凭什么让我先走？都到十二层了，再往下一点点嘛。'), null, 'it says it is staying');
  assert.equal(off('矿洞', '你先回去吧。', '凭什么？再往下一点点嘛。', '真的，你先回去吧，下面太危险了。', '……好吧，那我先回去了。'), '玩家', 'until the player insists');
  assert.equal(off('海滩', '今天下午不去海边了。', '这样啊。', '开玩笑的，还是去吧！', '你真是的……好啊，两点见。'), null, 'taken up again');
});

test('the NPC remembers who took it back, being sent home, and coming late', () => {
  const beach = { time: 1400, place: '海滩' };
  assert.equal(meetingMemory({ ...beach, calledOff: '玩家', met: false, left: 0 }).text, '约好 14:00 在海滩见面，后来农场主说不去了。');
  assert.equal(meetingMemory({ ...beach, calledOff: 'NPC', met: false, left: 0 }).text, '约好 14:00 在海滩见面，后来我跟农场主说去不了了。');
  assert.equal(meetingMemory({ ...beach, calledOff: '玩家', sentHome: true, met: true, left: 1450 }).text, '约好 14:00 在海滩见面，农场主来了，后来农场主让我先回去了。');
  assert.equal(meetingMemory({ time: 1000, place: '矿洞', soon: true, calledOff: '玩家', met: true, left: 1130,
    trip: { floor: 12, deepest: 15, kills: 6, fights: true, rescued: false } }).text,
  '约好马上去矿洞见面，农场主来了，我陪农场主下到矿洞第 15 层，打倒了 6 只怪物，后来农场主让我先回去了。');
  assert.equal(meetingMemory({ ...beach, sameDay: true, arrived: 1510, met: false, left: 1640 }).text, '约好 14:00 在海滩见面，我 15:10 才到，我等到 16:40，农场主没来。');
  const logged = (log: NpcState): DayEntry => ({ seq: 2, gameTime: 0, changes: [{ npcId: 'leah', log }] });
  const called = todayMeeting(beach, [logged({ meetCalledOff: { by: '玩家', met: false } })], 'leah');
  assert.deepEqual(called, { ...beach, calledOff: '玩家' });
  assert.equal(meetingLine(called, 1100, false), undefined, 'not talked of as still on');
  assert.deepEqual(todayMeeting(beach, [logged({ meetCalledOff: { by: 'NPC', met: true } })], 'leah'), { ...beach, calledOff: 'NPC', sentHome: true });
});

test('a later conversation calls the appointment off at once; sending company home waits for the Mod’s report', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const replies: Record<string, string> = {
    '现在陪我下矿吧？': '……好啊，走吧。', '今天不去矿洞了。': '这样啊……好吧。', '现在一起去海边吧？': '……好啊，走吧。',
    '你先回去吧。': '凭什么？再往下一点点嘛。', '真的，你先回去吧。': '……好吧，那我先回去了。',
  };
  const originalChat = h.fake.model.chat.bind(h.fake.model);
  h.fake.model.chat = async (...args: Parameters<typeof originalChat>) => {
    const result = await originalChat(...args);
    const line = Object.keys(replies).find(key => args[0].at(-1)!.content.startsWith(key));
    return line ? { ...result, content: JSON.stringify({ ...JSON.parse(result.content), reply: replies[line] }) } : result;
  };
  const server = await h.start();
  const wire = await connect(server);
  const at = (time: number) => ({ ...WORLD.date, time });
  const converse = async (npc: string, time: number, lines: string[], atMeeting = false) => {
    wire.send({ ...openTalk(1, npc), world: { ...WORLD, date: at(time) }, ...(atMeeting ? { atMeeting: true } : {}) });
    await wire.until('talk.reply', wire.inbox.length);
    for (const text of lines) { wire.send({ type: 'talk.say', npc, text, date: at(time) }); await wire.until('talk.reply', wire.inbox.length); }
    const from = wire.inbox.length;
    wire.send({ type: 'talk.close', npc }); await wire.until('ack', from);
    return from;
  };
  await converse('Abigail', 1000, ['现在陪我下矿吧？']);
  const from = await converse('Abigail', 1030, ['今天不去矿洞了。']);
  const sent = await wire.until('day.meetings', from) as { meetings: unknown[] };
  assert.deepEqual(sent.meetings, [{ npc: 'abigail', time: 1000, place: '矿洞', sameDay: true, calledOff: true }]);
  assert.ok(h.logs.includes('阿比盖尔今天在矿洞的约定取消了：农场主说不去了'));
  assert.ok(h.logs.includes('阿比盖尔记下了：约好马上去矿洞见面，后来农场主说不去了。'));
  await converse('Abigail', 1040, ['现在陪我下矿吧？']);
  assert.equal(h.logs.filter(line => line.startsWith('阿比盖尔答应了')).length, 1, 'called off for today means none again today');

  // Together at the place: the first “go home” is refused, the second taken; the Mod then reports the meeting.
  await converse('Sam', 1100, ['现在一起去海边吧？']);
  await converse('Sam', 1230, ['你先回去吧。'], true);
  assert.ok(!h.logs.some(line => line.startsWith('山姆被农场主送回去了')), 'sent home though it said it was staying');
  await converse('Sam', 1240, ['你先回去吧。', '真的，你先回去吧。'], true);
  assert.ok(h.logs.includes('山姆被农场主送回去了（海滩）'));
  assert.ok(!h.logs.some(line => line.startsWith('山姆记下了')), 'remembered before the Mod said how it went');
  wire.send({ type: 'meet.ended', npc: 'Sam', place: '海滩', time: 1220, left: 1240, met: true, date: at(1240) });
  await wire.until('ack', wire.inbox.length);
  assert.ok(h.logs.includes('山姆记下了：约好马上去海滩见面，农场主来了，后来农场主让我先回去了。'));
  await wire.close();
});
