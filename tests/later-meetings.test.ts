import assert from 'node:assert/strict';
import { test } from 'node:test';
import { namedDays, quotedCallOff, quotedLater, quotedLaterCallOff, quotedToday, type TimedQuote } from '../src/agent/meeting-agreement.ts';
import { dayLabel, farInvitation, laterCallOffNote, laterMeetings, laterNote, MEET_PLACES, upcomingLine } from '../src/agent/meetings.ts';
import { resolve } from 'node:path';
import { nightlyConsolidator } from '../src/agent/nightly.ts';
import type { Completion, ModelClient } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { type ConsolidationInput, SOCIAL_NPCS } from '../src/types.ts';
import { connect, harness, meetingsSent, openTalk, sleep, WORLD } from './helpers/bridge.ts';

const THURSDAY = 39; // summer 11
const talk = (...lines: string[]): TimedQuote[] => lines.map((text, i) => ({ id: `q${i}`, speaker: i % 2 ? 'NPC' : '玩家', text, time: 1000 }));

test('days are named by Stardew’s calendar: 28-day seasons, each from a Monday', () => {
  const days = (text: string) => namedDays(text, THURSDAY);
  assert.deepEqual(days('后天'), [41]);
  assert.deepEqual(days('大后天'), [42]);
  assert.deepEqual(days('明天'), [40]);
  assert.deepEqual(days('周六下午'), [41]);
  assert.deepEqual(days('星期四'), [39], 'today');
  assert.deepEqual(days('周一'), [43], 'the next one');
  assert.deepEqual(days('下周三'), [45]);
  assert.deepEqual(days('15号'), [43]);
  assert.deepEqual(days('3号'), [0], 'past this season: cannot be told');
  assert.deepEqual(days('下周一起去钓鱼'), [], 'next week together, not next Monday');
  assert.equal(dayLabel(41), '夏季 13 日（周六）');
  assert.equal(dayLabel(41, THURSDAY), '后天（周六）');
  assert.equal(dayLabel(40, THURSDAY), '明天（周五）');
});

test('an appointment for the day after tomorrow, or a weekday that close, is kept; tomorrow’s alone stays the nightly’s', () => {
  // Real replies from docs/npc-later-meetings.md §3.
  const later = (...lines: string[]) => quotedLater(talk(...lines), MEET_PLACES, THURSDAY);
  assert.deepEqual(later('周六下午两点海边见？', '海边？好呀，我很久没去听海浪了。周六下午两点，我会去的。'), { day: 41, time: 1400, place: '海滩' });
  assert.deepEqual(later('后天晚上一起去星之果实餐吧？', '嘿，这主意不错！餐吧的披萨我惦记好久了。后天晚上我肯定到。'), { day: 41, time: 1900, place: '星之果实餐吧' });
  assert.deepEqual(later('周五上午来我农场帮忙浇水吧？', '嘿，明天上午？行啊！浇水正好练练臂力，我就当加练了。'), { day: 40, time: 1000, place: '农场' },
    '“明天” in the reply is the Friday named');
  assert.deepEqual(later('周六晚上八点海边见？', '好啊，八点见。'), { day: 41, time: 2000, place: '海滩' }, 'a bare hour follows the evening said');
  assert.deepEqual(later('后天上午陪我下矿吧？', '好啊。', '那就后天再去。', '嗯。'), { day: 41, time: 1000, place: '矿洞' },
    'naming the same day again moves nothing');
  for (const lines of [
    ['后天上午陪我下矿吧？', '好啊。', '改明天吧。', '好。'],
    ['明天下午两点海边见？', '好啊。'],
    ['大后天下午海边见？', '好啊。'],
    ['下周三下午一起去海边吧？', '好啊。'],
    ['后天我要去镇上买东西。', '后天……嗯，我那天应该有空。'],
    ['后天一起去海边吧？', '哦哦，去海边呀！好呀好呀，我最喜欢海风了。'],
    ['后天下午陪我下矿？', '下矿？呃……那里面又黑又脏，出来头发里全是灰。你自己去吧。'],
    ['周五上午来我农场帮忙浇水吧？', '嘿，行啊！不过我得先把上午的训练做完，练完就过去。'],
  ]) assert.equal(later(...lines), null, lines.join(' / '));
  assert.equal(quotedToday(talk('周六下午两点海边见？', '好啊，两点见。'), MEET_PLACES, THURSDAY), null, 'Saturday is not today');
  assert.deepEqual(quotedToday(talk('周六下午两点海边见？', '好啊，两点见。'), MEET_PLACES, 41), { time: 1400, place: '海滩', soon: false }, 'unless it is');
  assert.deepEqual(quotedToday(talk('下午两点博物馆见，带你看个新化石？', '新化石？哇，我肯定来！不过周四我在诊所上班……两点我应该能溜出来。'),
    MEET_PLACES, THURSDAY), { time: 1400, place: '博物馆', soon: false }, 'today’s weekday is today');
});

test('another day’s call-off leaves today’s alone, and takes back the one it names', () => {
  const lines = talk('周六不去海边了。', '这样啊，没关系。');
  assert.equal(quotedCallOff(lines, MEET_PLACES['海滩']!, MEET_PLACES, THURSDAY), null);
  assert.equal(quotedLaterCallOff(lines, MEET_PLACES['海滩']!, MEET_PLACES, 41, THURSDAY), '玩家');
  assert.equal(quotedLaterCallOff(talk('明天不去农场了。', '好吧。'), MEET_PLACES['农场']!, MEET_PLACES, 40, THURSDAY), '玩家');
  assert.equal(quotedLaterCallOff(lines, MEET_PLACES['海滩']!, MEET_PLACES, 40, THURSDAY), null, 'another day named');
  assert.equal(quotedLaterCallOff(talk('今天不去海边了。', '好。'), MEET_PLACES['海滩']!, MEET_PLACES, 41, THURSDAY), null);
});

test('an invitation further ahead is turned down this turn; a near one or a mere mention is not', () => {
  const far = (text: string) => farInvitation(text, THURSDAY);
  assert.equal(far('下周三下午一起去海边吧？'), '6 天后的夏季 17 日（周三）');
  assert.equal(far('大后天上午陪我下矿吧？'), '3 天后的夏季 14 日（周日）');
  assert.equal(far('15号晚上星之果实餐吧见？'), '4 天后的夏季 15 日（周一）');
  assert.equal(far('下个月一起去森林河边走走吧？'), '下个月');
  assert.equal(far('下周一起去钓鱼吧'), '下周');
  for (const text of ['后天上午陪我下矿吧？', '周六一起去海边吧', '明天下午海边见？', '下周三是不是孩子们考试？', '现在陪我下矿吧？'])
    assert.equal(far(text), undefined, text);
});

test('notes keep an appointment by day; the latest note for a day decides', () => {
  const at = (note: ReturnType<typeof laterNote>, gameTime: number) => ({ topics: note.topics!, gameTime });
  const beach = { day: 41, time: 1400, place: '海滩' };
  assert.equal(laterNote(beach).text, '约好夏季 13 日（周六）14:00 在海滩见面。');
  assert.equal(laterCallOffNote(beach, 'NPC').text, '约好夏季 13 日（周六）14:00 在海滩见面，后来我跟农场主说去不了了。');
  const mine = { day: 40, time: 1000, place: '矿洞' };
  assert.deepEqual(laterMeetings([at(laterNote(beach), 10), at(laterNote(mine), 11)]), [mine, beach]);
  assert.deepEqual(laterMeetings([at(laterNote(beach), 10), at(laterCallOffNote(beach, '玩家'), 20)]), []);
  assert.equal(upcomingLine([mine, beach], THURSDAY), '明天（周五）10:00 在矿洞见面');
  assert.equal(upcomingLine([beach], 41), undefined, 'today’s is today’s line');
});

test('an appointment two days ahead is kept through the nights, shown to the NPC, and reaches the Mod on the day', { timeout: 20000 }, async t => {
  const h = await harness(t);
  const replies: Record<string, string> = {
    '周三上午陪我下矿吧？': '好啊，周三上午矿洞门口见。', '周三下午两点海边见？': '好啊，周三下午两点我会去的。',
    '明天不去海边了。': '这样啊……没关系。', '下周三下午一起去海边吧？': '下周三太远了，到时候再约吧。',
  };
  const originalChat = h.fake.model.chat.bind(h.fake.model);
  h.fake.model.chat = async (...args: Parameters<typeof originalChat>) => {
    const result = await originalChat(...args);
    const line = Object.keys(replies).find(key => args[0].at(-1)!.content.startsWith(key));
    return line ? { ...result, content: JSON.stringify({ ...JSON.parse(result.content), reply: replies[line] }) } : result;
  };
  const server = await h.start();
  const wire = await connect(server);
  const system = () => String(h.fake.sent.at(-1)![0]!.content);
  const converse = async (npc: string, day: number, lines: string[]) => {
    wire.send({ ...openTalk(day, npc), world: { ...WORLD, date: { ...WORLD.date, day, time: 1000 } } }); await wire.until('talk.reply', wire.inbox.length);
    for (const text of lines) {
      wire.send({ type: 'talk.say', npc, text, date: { ...WORLD.date, day, time: 1000 } }); await wire.until('talk.reply', wire.inbox.length);
    }
    wire.send({ type: 'talk.close', npc }); await wire.until('ack', wire.inbox.length);
  };
  // Spring 1 is a Monday.
  await converse('Abigail', 1, ['周三上午陪我下矿吧？']);
  assert.ok(h.logs.includes('阿比盖尔记下了：约好春季 3 日（周三）10:00 在矿洞见面。'));
  await converse('Sam', 1, ['周三下午两点海边见？']);
  assert.ok(h.logs.includes('山姆记下了：约好春季 3 日（周三）14:00 在海滩见面。'));
  await converse('Leah', 1, ['下周三下午一起去海边吧？']);
  assert.match(system(), /- 农场主约的是9 天后的春季 10 日（周三），太远了/);
  assert.ok(!h.logs.some(line => line.startsWith('莉亚记下了')), 'turned down, and too far to keep anyway');
  wire.send({ ...openTalk(1), world: { ...WORLD, date: { ...WORLD.date, time: 1100 } } }); await wire.until('talk.reply', wire.inbox.length);
  assert.match(system(), /- 和农场主的约定：后天（周三）10:00 在矿洞见面/);
  assert.doesNotMatch(system(), /太远了/, 'only for the turn that asked');
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack', wire.inbox.length);
  const a = await sleep(wire, 'A', 1);

  await converse('Sam', 2, ['明天不去海边了。']);
  assert.ok(h.logs.includes('山姆记下了：约好春季 3 日（周三）14:00 在海滩见面，后来农场主说不去了。'));
  const from = wire.inbox.length;
  await sleep(wire, 'B', 2, a.commitId);
  const expected = [{ npc: 'abigail', time: 1000, place: '矿洞' }];
  assert.deepEqual(await meetingsSent(wire, from, expected), expected);
  await wire.close();
});

test('the nightly model cannot retire a note that keeps an appointment', async () => {
  const roster = new Roster({ directory: resolve(import.meta.dirname, '../data/npcs'), npcIds: SOCIAL_NPCS });
  await roster.load();
  const commit = { id: 'night', lineageId: 'later', parentId: 'root', dayEnded: 2, status: 'confirmed' as const };
  const older = (id: string, gameTime: number, text: string, topics: string[]) => ({ id, commitId: 'before', npcId: 'abigail', gameTime, text,
    kind: 'observation' as const, importance: 3, subjects: ['player'], topics, visibility: 'private' as const, sourceId: id });
  const input: ConsolidationInput = { commit, completed: false, npcs: [{ npcId: 'abigail', state: {},
    logs: [{ seq: 1, gameTime: 2 * 1440 + 600, changes: [{ npcId: 'abigail', log: { player: '你好', npc: '嗨。' } }] }],
    memories: [older('kept', 1 * 1440 + 600, laterNote({ day: 3, time: 1000, place: '矿洞' }).text, laterNote({ day: 3, time: 1000, place: '矿洞' }).topics!),
      older('plain', 1 * 1440 + 700, '农场主说喜欢紫水晶。', [])] }] };
  const model = { async chat(): Promise<Completion> {
    const content = JSON.stringify({ memories: [], retire: ['m1', 'm2'], impression: '', plan: '' });
    return { content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
  } } as unknown as ModelClient;
  const [change] = await nightlyConsolidator({ roster, model })(input, new AbortController().signal);
  assert.deepEqual(change!.retireMemoryIds, ['plain']);
});
