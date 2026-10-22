import assert from 'node:assert/strict';
import { test } from 'node:test';
import { namedDays, quotedCallOff, quotedLater, quotedLaterCallOff, quotedToday, type TimedQuote } from '../src/agent/meeting-agreement.ts';
import { farInvitation, MEET_PLACES } from '../src/agent/meetings.ts';

const talk = (...lines: string[]): TimedQuote[] => lines.map((text, i) => ({ id: `r${i}`, speaker: i % 2 ? 'NPC' : '玩家', text, time: 1000 }));

test('future clocks inherit the explicit period without moving tomorrow morning into tonight', () => {
  assert.deepEqual(quotedLater(talk('后天晚上八点星之果实餐吧见？', '好啊，八点星之果实餐吧见。'), MEET_PLACES, 39),
    { day: 41, time: 2000, place: '星之果实餐吧' });
  assert.deepEqual(quotedLater(talk('后天上午八点矿洞见？', '好啊，八点矿洞见。'), MEET_PLACES, 39), { day: 41, time: 800, place: '矿洞' });
});

test('a next-season date must not be booked as a near date in this season', () => {
  const lines = talk('下个月28号下午两点海边见？', '好啊，两点海边见。');
  assert.equal(quotedLater(lines, MEET_PLACES, 26), null);
  assert.ok(farInvitation(lines[0]!.text, 26), 'a far invitation needs the refusal hint');
});

test('a numeric date can name today', () => {
  assert.deepEqual(namedDays('11号', 39), [39]);
  assert.deepEqual(quotedToday(talk('11号下午两点海边见？', '好啊，两点海边见。'), MEET_PLACES, 39), { time: 1400, place: '海滩', soon: false });
  assert.deepEqual(namedDays('下个月1号', 27), [29]);
  assert.deepEqual(namedDays('下月1号', 111), [113], 'the 28-day calendar also crosses the year');
  assert.deepEqual(quotedLater(talk('下个月1号上午八点矿洞见？', '好啊，八点矿洞见。'), MEET_PLACES, 27),
    { day: 29, time: 800, place: '矿洞' });
});

test('explicitly cancelling another place does not cancel this appointment', () => {
  const lines = talk('后天不去海边了。', '好吧。');
  assert.equal(quotedLaterCallOff(lines, MEET_PLACES['矿洞']!, MEET_PLACES, 41, 39), null);
  assert.equal(quotedLaterCallOff(lines, MEET_PLACES['海滩']!, MEET_PLACES, 41, 39), '玩家');
  assert.equal(quotedCallOff(talk('今天不去海边了。', '好吧。'), MEET_PLACES['矿洞']!, MEET_PLACES, 39), null);
});

test('a date in a later clause is not made today by the preamble saying today', () => {
  assert.equal(quotedCallOff(talk('今天说一下，后天不去海边了。', '好吧。'), MEET_PLACES['海滩']!, MEET_PLACES, 39), null);
  assert.equal(quotedCallOff(talk('今天不去海边了，后天再约。', '好吧。'), MEET_PLACES['海滩']!, MEET_PLACES, 39), '玩家');
});
