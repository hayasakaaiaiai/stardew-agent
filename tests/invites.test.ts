import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type TimedQuote, quotedInvite } from '../src/agent/meeting-agreement.ts';
import { invitationLine, MEET_PLACES } from '../src/agent/meetings.ts';
import { parseModMessage } from '../src/bridge/protocol.ts';
import { connect, harness, meetingsSent, openTalk, WORLD } from './helpers/bridge.ts';

const DAY = 39; // summer 11, a Thursday
const said = (ask: string, answer: string, reply = '', time = 1000): TimedQuote[] => [
  { id: 'n0', speaker: 'NPC', text: ask, time }, { id: 'p1', speaker: '玩家', text: answer, time: time + 10 },
  ...(reply ? [{ id: 'n1', speaker: 'NPC' as const, text: reply, time: time + 10 }] : []),
];
const read = (quotes: TimedQuote[]) => quotedInvite(quotes, MEET_PLACES, DAY);

test('the line asking the NPC to invite measures as in the design, and from 18:00 it asks for tomorrow only', () => {
  assert.equal(invitationLine(1000), '- 你今天想主动约农场主出去一次：今天晚些时候或明天，从海滩、镇广场、墓地、山上湖边、森林河边、博物馆、星之果实餐吧、杂货店里挑一个合你心意的地方，'
    + '也可以说去农场帮忙或陪农场主下矿，说清几点。自然地问农场主愿不愿意；不答应也没关系，别勉强。');
  assert.match(invitationLine(1800), /^- 你今天想主动约农场主出去一次：明天，从海滩/);
});

test('an invitation said yes to is read whole: the time in its own clause, the day it names, small talk aside (real replies, docs/npc-invites.md §5)', () => {
  assert.deepEqual(read(said('嘿，小林。今天热得我快化了……*唉*，你有空吗？今晚七点，要不要陪我去墓地坐坐？那儿凉快，也安静。', '好啊！')),
    { day: DAY, time: 1900, place: '墓地' });
  assert.deepEqual(read(said('嘿，小林！今天太阳这么猛，正适合去海滩。下午三点，码头见？', '好啊！')), { day: DAY, time: 1500, place: '海滩' });
  assert.deepEqual(read(said('嘿，小林。*唉* 今天热死了……欸，明天你有空吗？我想去山上湖边走走，傍晚六点，你来不来？', '好啊！', '', 1900)),
    { day: DAY + 1, time: 1800, place: '山上湖边' });
  // A greeting is no time, "待一会儿" no day, and a period alone takes its usual hour.
  assert.deepEqual(read(said('小林，晚上好。我正想着明天的事……明天傍晚要不要一起去森林河边走走？我带点吃的。', '好啊！', '太好了。河边傍晚的风很舒服，不是吗？', 1900)),
    { day: DAY + 1, time: 1700, place: '森林河边' });
  assert.deepEqual(read(said('嘿，小林！明天下午两点去海滩待会儿怎么样？', '好啊！', '', 1900)), { day: DAY + 1, time: 1400, place: '海滩' });
  // The reply settles what the opening left open: one of two places, and when; "人少一点" is not one o'clock.
  assert.deepEqual(read(said('……嗨，小林。你晚些时候有空吗？想去海边走走，或者去山上湖边坐坐。', '好啊！', '那就傍晚去海边吧，人少一点，风也凉。', 1400)),
    { day: DAY, time: 1700, place: '海滩' });
  // A deadline is not the time: "下午四点前我都有空" leaves the afternoon.
  assert.deepEqual(read(said('今天下午四点前我都有空……要不要一起去海滩走走？', '好啊！')), { day: DAY, time: 1400, place: '海滩' });
});

test('an invitation is not taken up by a hedge, a no, two days at once, no place, or a time already gone', () => {
  const ask = '小林！今天下午三点，去博物馆转转怎么样？';
  for (const answer of ['嗯……我得看看农场的活儿。', '今天不太行，下次吧。', '好啊，不过得看看农场忙不忙。', '要是有空就去。', '嗯嗯。']) {
    assert.equal(read(said(ask, answer)), null, answer);
  }
  assert.equal(read(said('今天晚些时候或明早，愿意陪我去海边走走吗？黄昏六点怎么样？', '好啊！')), null, 'two days');
  assert.equal(read(said('明天想出去走走。你有空吗？', '好啊！', '那就明天傍晚，铁路那边碰头吧。', 1900)), null, 'no place it can meet at');
  assert.equal(read(said('今天上午九点去海滩吧？', '好啊！', '', 1000)), null, 'already gone');
  assert.equal(read([...said(ask, '好啊！'), { id: 'p2', speaker: '玩家', text: '算了，我还是不去了。', time: 1020 }]), null, 'taken back');
});

test('the Mod marks the opening that asks', () => {
  const base = { ...openTalk(), lineageId: 'farm', loadNonce: 'n', seq: 4 };
  assert.equal((parseModMessage(JSON.stringify({ ...base, invite: true })) as { invite?: boolean }).invite, true);
  assert.throws(() => parseModMessage(JSON.stringify({ ...base, invite: 'yes' })));
});

test('an invitation is withdrawn by the NPC, or replaced by a later agreement in the same conversation', () => {
  const ask = '今天下午三点，一起去海滩走走好吗？';
  assert.equal(read(said(ask, '好啊！', '抱歉，今天我去不了了。')), null);
  assert.equal(read([...said(ask, '好啊！', '三点海滩见。'),
    { id: 'n2', speaker: 'NPC', text: '对了，今天突然有事，我去不了了。', time: 1020 }]), null);
  assert.equal(read(said(ask, '好啊！', '好啊，下午三点博物馆见。')), null, 'Conflicting places cannot silently keep the first one.');
  const changed = [...said(ask, '好啊！', '那就三点海滩见。'),
    { id: 'p2', speaker: '玩家' as const, text: '改成今天下午四点博物馆见吧？', time: 1020 },
    { id: 'n2', speaker: 'NPC' as const, text: '好啊，今天下午四点博物馆见。', time: 1020 }];
  assert.equal(read(changed), null, 'The later exchange must be read by the ordinary agreement check.');
  assert.equal(read(changed.map(quote => quote.id === 'p1' ? { ...quote, text: '好啊，下午三点海滩见。' } : quote)), null);
  assert.equal(read([...said(ask, '好啊，下午三点海滩见。', '好啊，三点海滩见。'),
    { id: 'p2', speaker: '玩家', text: '算了，我今天不去了。', time: 1020 }]), null);
  assert.equal(read([...said(ask, '好啊！', '三点海滩见。'),
    { id: 'p2', speaker: '玩家', text: '还是下午四点吧？', time: 1020 },
    { id: 'n2', speaker: 'NPC', text: '行。', time: 1020 }]), null, 'A changed clock without a settled place must not keep the first clock.');
  assert.equal(read([...said(ask, '好啊，三点海滩见。', '三点海滩见。'),
    { id: 'p2', speaker: '玩家', text: '还是下午四点吧？', time: 1020 },
    { id: 'n2', speaker: 'NPC', text: '行。', time: 1020 }]), null);
  assert.deepEqual(read(said(ask, '好啊，不过改到博物馆吧。', '好啊，三点博物馆见。')),
    { day: DAY, time: 1500, place: '博物馆' });
  assert.equal(read(said(ask, '好啊，不过改到博物馆吧。', '今天下午三点海滩见。')), null, 'Unsettled places cannot retain the old invitation.');
});

test('asked out on the opening, the player says yes and the appointment reaches the Mod; the line is on that turn only', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const originalChat = h.fake.model.chat.bind(h.fake.model);
  h.fake.model.chat = async (...args: Parameters<typeof originalChat>) => {
    const result = await originalChat(...args);
    const asking = args[0][0]!.content.includes('你今天想主动约农场主出去一次：明天') ? '嘿，小林！明天下午三点，一起去山上湖边走走怎么样？'
      : args[0][0]!.content.includes('你今天想主动约农场主') ? '嘿，小林！下午三点，一起去海滩走走怎么样？'
      : /好啊/.test(args[0].at(-1)!.content) ? args[0].some(message => message.role === 'assistant' && message.content.includes('明天下午三点'))
        ? '太好了，明天下午三点山上湖边见！' : '太好了，三点海滩见！' : undefined;
    return asking ? { ...result, content: JSON.stringify({ ...JSON.parse(result.content), reply: asking }) } : result;
  };
  const server = await h.start();
  const wire = await connect(server);
  await wire.until('day.meetings', 0);
  const at = (time: number) => ({ ...WORLD.date, time });
  const system = () => h.fake.sent.at(-1)![0]!.content;
  wire.send({ ...openTalk(1), world: { ...WORLD, date: at(1000) }, invite: true }); await wire.until('talk.reply', wire.inbox.length);
  assert.match(system(), /- 你今天想主动约农场主出去一次：今天晚些时候或明天/);
  assert.ok(h.logs.includes('阿比盖尔开口约农场主'));
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '好啊！', date: at(1010) }); await wire.until('talk.reply', wire.inbox.length);
  assert.doesNotMatch(system(), /你今天想主动约农场主/, 'only on the opening turn');
  const from = wire.inbox.length;
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack', from);
  const expected = [{ npc: 'abigail', time: 1500, place: '海滩', sameDay: true }];
  assert.deepEqual(await meetingsSent(wire, from, expected), expected);
  assert.ok(h.logs.includes('阿比盖尔答应了今天的约定：15:00 海滩'), h.logs.filter(line => line.includes('约定')).join('\n'));

  // Something already agreed: no asking again.
  wire.send({ ...openTalk(1), world: { ...WORLD, date: at(1100) }, invite: true }); await wire.until('talk.reply', wire.inbox.length);
  assert.doesNotMatch(system(), /你今天想主动约农场主/);
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack', wire.inbox.length);

  // Tomorrow's is kept as a note, as one for the day after tomorrow is.
  wire.send({ ...openTalk(1, 'Sam'), world: { ...WORLD, date: at(1900) }, invite: true }); await wire.until('talk.reply', wire.inbox.length);
  assert.match(system(), /- 你今天想主动约农场主出去一次：明天，/);
  wire.send({ type: 'talk.say', npc: 'Sam', text: '好啊！', date: at(1910) }); await wire.until('talk.reply', wire.inbox.length);
  wire.send({ type: 'talk.close', npc: 'Sam' }); await wire.until('ack', wire.inbox.length);
  const note = '山姆记下了：约好春季 2 日（周二）15:00 在山上湖边见面。';
  for (let i = 0; i < 300 && !h.logs.includes(note); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(h.logs.includes(note), h.logs.filter(line => line.includes('山姆')).join('\n'));
  await wire.close();
});
