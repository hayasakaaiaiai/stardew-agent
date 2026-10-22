import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkMeet, meetDraft, MEET_PLACES, meetingLine, meetingMemory, tripText } from '../src/agent/meetings.ts';
import { NIGHTLY_RULES, nightlyConsolidator } from '../src/agent/nightly.ts';
import { parseModMessage } from '../src/bridge/protocol.ts';
import type { ChatMessage, Completion, ModelClient } from '../src/services/model/client.ts';
import { connect, harness, openTalk, sleep, WORLD } from './helpers/bridge.ts';

const FIGHTER = { floor: 35, deepest: 40, kills: 12, fights: true, rescued: false };
const FOLLOWER = { floor: 12, deepest: 12, kills: 0, fights: false, rescued: false };

test('the three dungeon doors are meeting places, each by its own words', () => {
  assert.match(NIGHTLY_RULES, /农场、矿洞、骷髅洞穴、火山之一/);
  const said = (text: string) => [{ id: 't1', speaker: '玩家' as const, text }, { id: 't2', speaker: 'NPC' as const, text: '好啊，说定了。' }];
  const keep = (place: string, text: string) => checkMeet(meetDraft({ time: '10:00', place, sources: ['t1', 't2'] }), said(text));
  assert.deepEqual(keep('矿洞', '明天上午一起下矿吧？'), { time: 1000, place: '矿洞' });
  assert.deepEqual(keep('矿洞', '明天上午矿洞门口见'), { time: 1000, place: '矿洞' });
  assert.deepEqual(keep('骷髅洞穴', '明天上午陪我去骷髅洞穴吧'), { time: 1000, place: '骷髅洞穴' });
  assert.deepEqual(keep('火山', '明天上午去姜岛的火山探险？'), { time: 1000, place: '火山' });
  assert.equal(keep('矿洞', '明天上午山上湖边见'), null, 'the lake is not the mine door');
  assert.equal(keep('火山', '明天上午一起下矿吧？'), null);
  assert.ok(!MEET_PLACES['矿洞']!.test('骷髅洞穴') && !MEET_PLACES['骷髅洞穴']!.test('矿洞'));
});

test('a companion is told where it is and what it did; one who does not fight is told so', () => {
  assert.equal(tripText('矿洞', FIGHTER), '你一直陪着农场主，现在在矿洞第 35 层，最深到过第 40 层，你打倒了 12 只怪物');
  assert.equal(tripText('矿洞', FOLLOWER), '你一直陪着农场主，现在在矿洞第 12 层，你不会打架，只跟在后面');
  assert.equal(tripText('火山', { ...FIGHTER, floor: 0, deepest: 0, kills: 0 }), '你一直陪着农场主，现在在火山入口', 'nothing fought yet');
  const meeting = { time: 1000, place: '矿洞' };
  assert.equal(meetingLine(meeting, 1130, true, undefined, FIGHTER), `今天 10:00 在矿洞见面；${tripText('矿洞', FIGHTER)}`);
  assert.equal(meetingLine(meeting, 1900, true, undefined, FIGHTER), `今天 10:00 在矿洞见面；${tripText('矿洞', FIGHTER)}`,
    'still with the player long after the ninety minutes');
  assert.equal(meetingLine(meeting, 1900, false), undefined, 'gone home once it is over');
});

test('the trip is remembered in the NPC’s voice, a rescue most of all', () => {
  const meeting = { time: 1000, place: '矿洞', met: true, left: 1240 };
  assert.deepEqual(meetingMemory({ ...meeting, trip: FIGHTER }),
    { text: '约好 10:00 在矿洞见面，农场主来了，我陪农场主下到矿洞第 40 层，打倒了 12 只怪物。', importance: 3, kind: 'observation',
      subjects: ['player'], visibility: 'private' });
  const rescued = meetingMemory({ ...meeting, trip: { ...FIGHTER, rescued: true } });
  assert.equal(rescued.text, '约好 10:00 在矿洞见面，农场主来了，我陪农场主下到矿洞第 40 层，打倒了 12 只怪物；农场主晕倒了，我把农场主背了出来。');
  assert.equal(rescued.importance, 4);
  assert.equal(meetingMemory({ ...meeting, place: '骷髅洞穴', trip: { ...FOLLOWER, floor: 0, deepest: 0 } }).text,
    '约好 10:00 在骷髅洞穴见面，农场主来了，我陪农场主进了骷髅洞穴，我不会打架，一直跟在后面。');
});

test('the Mod reports a trip only as whole, consistent counts', () => {
  const base = { type: 'meet.ended', lineageId: 'farm', loadNonce: 'n', seq: 3, npc: 'Abigail', place: '矿洞', time: 1000, left: 1240, met: true,
    date: { year: 1, season: 'spring', day: 2, time: 1240 } };
  assert.deepEqual((parseModMessage(JSON.stringify({ ...base, mine: FIGHTER })) as { mine?: unknown }).mine, FIGHTER);
  for (const mine of [null, [], { ...FIGHTER, floor: 41 }, { ...FIGHTER, kills: -1 }, { ...FIGHTER, deepest: 1.5 }, { ...FIGHTER, fights: 'yes' },
    { floor: 1, deepest: 1, kills: 0, fights: true }, { ...FIGHTER, deepest: 100001 }]) {
    assert.throws(() => parseModMessage(JSON.stringify({ ...base, mine })), JSON.stringify(mine));
  }
  assert.ok(parseModMessage(JSON.stringify({ ...openTalk(), lineageId: 'farm', loadNonce: 'n', seq: 4, atMeeting: true, mine: FOLLOWER })));
  assert.throws(() => parseModMessage(JSON.stringify({ ...openTalk(), lineageId: 'farm', loadNonce: 'n', seq: 4, mine: { ...FOLLOWER, rescued: 1 } })));
});

const nightly = {
  async chat(messages: ChatMessage[]): Promise<Completion> {
    const output = { memories: [{ sources: ['t2'], importance: 3 }], retire: [], impression: '', plan: '明天上午陪农场主下矿', bubbles: [], letter: '',
      gift: false, share: '', meet: { time: '10:00', place: '矿洞', sources: ['t2'] } };
    void messages;
    return { content: JSON.stringify(output), reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
  },
} as unknown as ModelClient;

test('a mine appointment reaches the Mod, the talk underground knows the trip, and the memory keeps it', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const server = await h.start(nightlyConsolidator({ roster: h.roster, model: nightly }));
  const wire = await connect(server);
  wire.send(openTalk(1)); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '明天上午一起下矿吧？' }); await wire.until('talk.reply');
  await sleep(wire);
  for (let i = 0; i < 300 && !h.logs.includes('今天的约定：abigail 10:00 矿洞'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(h.logs.includes('今天的约定：abigail 10:00 矿洞'));
  const prompt = () => h.fake.sent.at(-1)!.map(message => message.content).join('\n');
  wire.send({ ...openTalk(2), world: { ...WORLD, location: '矿井', date: { ...WORLD.date, day: 2, time: 1500 } }, atMeeting: true, mine: FIGHTER });
  await wire.until('talk.reply', wire.inbox.length);
  assert.match(prompt(), /- 和农场主的约定：今天 10:00 在矿洞见面；你一直陪着农场主，现在在矿洞第 35 层，最深到过第 40 层，你打倒了 12 只怪物/);
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack');
  wire.send({ type: 'meet.ended', npc: 'Abigail', place: '矿洞', time: 1000, left: 1520, met: true, mine: { ...FIGHTER, rescued: true },
    date: { ...WORLD.date, day: 2, time: 1520 } });
  await wire.until('ack', wire.inbox.length);
  assert.ok(h.logs.includes('阿比盖尔记下了：约好 10:00 在矿洞见面，农场主来了，我陪农场主下到矿洞第 40 层，打倒了 12 只怪物；农场主晕倒了，我把农场主背了出来。'));
  // One the player never met cannot have gone in with them, whatever the Mod says.
  wire.send({ type: 'meet.ended', npc: 'Sam', place: '矿洞', time: 1000, left: 1130, met: false, mine: FOLLOWER, date: { ...WORLD.date, day: 2, time: 1530 } });
  await wire.until('ack', wire.inbox.length);
  assert.ok(h.logs.includes('山姆记下了：约好 10:00 在矿洞见面，我等到 11:30，农场主没来。'));
  await wire.close();
});
