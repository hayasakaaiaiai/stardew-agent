import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkMeet, meetingFor, meetDraft } from '../src/agent/meetings.ts';

const quotes = (player: string, npc: string) => [{ id: 't1', speaker: '玩家' as const, text: player }, { id: 't2', speaker: 'NPC' as const, text: npc }];
const proposal = (time = '14:00', place = '海滩', sources = ['t1', 't2']) => meetDraft({ time, place, sources });

test('a malformed meeting cannot use inherited object properties or crash nightly consolidation', () => {
  for (const place of ['constructor', 'toString', '__proto__']) {
    assert.equal(checkMeet(proposal('14:00', place), quotes('明天下午海边见。', '好啊，明天下午海边见。')), null);
    assert.equal(meetingFor({ day: 1, meet: { time: 1400, place } }, 2), undefined);
  }
});

test('a proposed or refused trip is never turned into an appointment by a mistaken model', () => {
  for (const [player, npc] of [
    ['明天下午海边见？', '不了，我明天不去海边。'],
    ['明天下午我不去海边。', '那我们改天再说。'],
    ['我想想，还没决定。', '明天下午海边见？'],
    ['今天的天气不错。', '明天下午海边见？'],
    ['如果明天不下雨，下午我才会去海边。', '那到时候再看。'],
    ['明天下午几点去海边我还没想好。', '好，等时间定了再告诉我。'],
    ['明天下午可能去海边见面吧。', '好，那到时候看情况。'],
    ['明天下午海边见这件事我不确定。', '好，决定了再联系。'],
    ['明天下午海边见面？', '我明天下午去海边修船，不用来找我。'],
    ['明天下午海边见面？', '我明天下午在海边，但别来找我。'],
    ['明天下午海边见面？', '我没答应明天下午去海边见面。'],
  ]) assert.equal(checkMeet(proposal(), quotes(player!, npc!)), null, `${player} / ${npc}`);
  assert.equal(checkMeet(proposal('14:00', '海滩', ['t1']), quotes('明天下午一起去海边吧？', '我不去。')), null, 'one-sided invitation only');
  assert.equal(checkMeet(proposal(), [...quotes('明天下午海边见。', '好啊，明天下午海边见。'),
    { id: 't3', speaker: '玩家', text: '明天海边我还是不去了。' }]), null, 'a later explicit cancellation overrides earlier agreement');
});

test('the time and day that move an NPC must match the quoted agreement', () => {
  const agreed = quotes('明天下午14:00海边见。', '好啊，明天下午海边见。');
  assert.equal(checkMeet(proposal('09:00'), agreed), null, 'the model cannot replace afternoon with morning');
  assert.deepEqual(checkMeet(proposal('14:05'), agreed), { time: 1400, place: '海滩' }, 'same ten-minute rounding as the contract');
  assert.equal(checkMeet(proposal(), quotes('明天我不出门，后天下午在海边见。', '好啊，后天海边见。')), null);
  assert.equal(checkMeet(proposal('13:00'), quotes('明天01:00海边见。', '好啊。')), null, '24-hour clock must not become an afternoon appointment');
  assert.deepEqual(checkMeet(proposal('15:00', '博物馆'), quotes('明天三点在博物馆等我。', '好，明天三点博物馆见。')), { time: 1500, place: '博物馆' });
  assert.deepEqual(checkMeet(proposal('15:00', '博物馆'), quotes('明天下午三点在博物馆等我。', '好，明天下午博物馆见。')), { time: 1500, place: '博物馆' });
  assert.equal(checkMeet(proposal('15:00', '博物馆'), quotes('明天下午三点在博物馆等我。', '好，明天早上博物馆见。')), null, 'a conflicting period is not an agreement');
  assert.deepEqual(checkMeet(proposal('19:00', '星之果实餐吧'), quotes('明晚星之果实餐吧见。', '好啊。')), { time: 1900, place: '星之果实餐吧' });
  assert.deepEqual(checkMeet(proposal(), [{ id: 't1', speaker: 'NPC', text: '明天下午在海边见面？' },
    { id: 't2', speaker: '玩家', text: '好啊，我确定参加。' }]), { time: 1400, place: '海滩' });
  for (const acceptance of ['可以啊。', '我可以。', '我愿意。', '行啊！', '好嘞。', '嗯嗯。']) {
    assert.deepEqual(checkMeet(proposal(), quotes('明天下午海边见面？', acceptance)), { time: 1400, place: '海滩' }, acceptance);
  }
});
