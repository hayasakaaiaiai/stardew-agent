import assert from 'node:assert/strict';
import { test } from 'node:test';
import { helpedText, meetingLine, meetingMemory } from '../src/agent/meetings.ts';
import { parseModMessage } from '../src/bridge/protocol.ts';

const CHORES = { watered: 0, harvested: 0, fed: 0, ponds: 0 };
const ANIMALS = { ...CHORES, collected: 6, milked: 2, sheared: 1, petted: 9, truffles: 1 };

test('the animals tended are said like the other chores, and what was not done is left out', () => {
  assert.equal(helpedText(ANIMALS), '捡了 6 个鸡舍里的产品放进箱子、挤了 2 只动物的奶、剪了 1 只羊的毛、摸了 9 只动物、捡了 1 个松露');
  assert.equal(helpedText({ watered: 120, harvested: 0, fed: 8, ponds: 0, collected: 0, milked: 0, sheared: 0, petted: 4, truffles: 0 }),
    '浇了 120 格水、给动物添了 8 份干草、摸了 4 只动物');
  assert.equal(helpedText({ ...CHORES, collected: 0, milked: 0, sheared: 0, petted: 0, truffles: 0 }), '农场里没什么要干的活');
  assert.equal(meetingLine({ time: 1000, place: '农场' }, 1030, true, { ...CHORES, petted: 9 }), '今天 10:00 在农场见面，现在就在这里碰面了；你来了以后已经摸了 9 只动物');
  assert.equal(meetingMemory({ time: 1000, place: '农场', met: true, left: 1130, helped: { ...CHORES, milked: 2 } }).text,
    '约好 10:00 在农场见面，我挤了 2 只动物的奶，农场主来了。');
});

test('the Mod reports the animals tended as whole counts, and an older Mod without them still parses', () => {
  const base = { type: 'meet.ended', lineageId: 'farm', loadNonce: 'n', seq: 3, npc: 'Abigail', place: '农场', time: 1000, left: 1130, met: true,
    date: { year: 1, season: 'spring', day: 2, time: 1130 } };
  assert.deepEqual((parseModMessage(JSON.stringify({ ...base, helped: ANIMALS })) as { helped?: unknown }).helped, ANIMALS);
  assert.deepEqual((parseModMessage(JSON.stringify({ ...base, helped: CHORES })) as { helped?: unknown }).helped, CHORES);
  for (const helped of [{ ...ANIMALS, collected: -1 }, { ...ANIMALS, milked: 1.5 }, { ...ANIMALS, petted: '9' }, { ...ANIMALS, truffles: 100001 },
    { ...ANIMALS, sheared: null }]) assert.throws(() => parseModMessage(JSON.stringify({ ...base, helped })), JSON.stringify(helped));
});
