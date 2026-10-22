import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkMeet, meetDraft, meetingFor, meetingLeave, meetingLine, meetingMemory } from '../src/agent/meetings.ts';
import { NIGHTLY_HINT, NIGHTLY_RULES, nightlyConsolidator, parseNightly } from '../src/agent/nightly.ts';
import { type BackendMessage, parseModMessage } from '../src/bridge/protocol.ts';
import type { ChatMessage, Completion, ModelClient } from '../src/services/model/client.ts';
import { connect, harness, initial, openTalk, sleep, WORLD } from './helpers/bridge.ts';

const SOURCES = [
  { id: 't1', speaker: 'NPC' as const, text: '嘿，今天店里好闷。' },
  { id: 't2', speaker: '玩家' as const, text: '明天下午一起去海边钓鱼吧？' },
  { id: 't3', speaker: 'NPC' as const, text: '好啊，那就明天下午海边见。' },
  { id: 't4', speaker: '玩家' as const, text: '后天上午在博物馆等我。' },
];
const draft = (change: Record<string, unknown> = {}) => meetDraft({ time: '14:00', place: '海滩', sources: ['t2', 't3'], ...change });

test('the nightly rules ask for an appointment, and a broken one never rejects the night', () => {
  assert.match(NIGHTLY_RULES, /- meet：农场主明确答应明天在某个时段、某个地点和你见面才写，否则 null。/);
  assert.match(NIGHTLY_RULES, /"seek":false,"meet":null,/);
  assert.match(NIGHTLY_HINT, /seek、meet、bubbles/);
  const meet = (value: unknown) => parseNightly(JSON.stringify({ memories: [], impression: '好', plan: '', meet: value }))!.meet;
  assert.deepEqual(meet({ time: '14:00', place: '海滩', sources: ['t2', 't2', 't3'] }), { time: '14:00', place: '海滩', sources: ['t2', 't3'] });
  for (const value of [null, undefined, 'null', [], { time: 1400, place: '海滩', sources: ['t2'] }, { time: '14:00', place: '海滩', sources: [] },
    { time: '14:00', place: '海滩', sources: [2] }, { time: '14:00', place: '海滩', sources: ['t1', 't2', 't3', 't4', 't5'] }]) {
    assert.equal(meet(value), null, JSON.stringify(value));
  }
});

test('an appointment is kept only when the quoted lines show tomorrow, a time, the place and the player', () => {
  assert.deepEqual(checkMeet(draft(), SOURCES), { time: 1400, place: '海滩' });
  assert.deepEqual(checkMeet(draft({ time: '14:05' }), SOURCES), { time: 1400, place: '海滩' }, 'rounded down to ten minutes');
  const never: Record<string, unknown>[] = [
    { sources: ['t9'] }, { sources: ['t1', 't3'] }, { sources: ['t4'] }, { place: '博物馆' }, { place: '你家' },
    { time: '7:30' }, { time: '21:10' }, { time: '14:75' }, { time: '下午' },
  ];
  for (const change of never) assert.equal(checkMeet(draft(change), SOURCES), null, JSON.stringify(change));
  assert.equal(checkMeet(draft({ sources: ['t2'] }), [{ id: 't2', speaker: '玩家', text: '明天去海边吧' }]), null, 'no time of day was said');
  assert.equal(checkMeet(null, SOURCES), null);
});

test('only yesterday’s appointment counts, and the NPC waits ninety minutes but not past 22:00', () => {
  assert.deepEqual(meetingFor({ day: 31, meet: { time: 1400, place: '海滩' } }, 32), { time: 1400, place: '海滩' });
  for (const state of [{ day: 30, meet: { time: 1400, place: '海滩' } }, { day: 31, meet: null }, { day: 31, meet: { time: 1405, place: '海滩' } },
    { day: 31, meet: { time: 1400, place: '你家' } }, { day: 31, meet: { time: '1400', place: '海滩' } }, { day: 31 }]) {
    assert.equal(meetingFor(state, 32), undefined, JSON.stringify(state));
  }
  assert.deepEqual([1400, 950, 1950, 2100].map(meetingLeave), [1530, 1120, 2120, 2200]);
  const meeting = { time: 1400, place: '海滩' };
  assert.equal(meetingLine(meeting, 900, false), '今天 14:00 在海滩见面');
  assert.equal(meetingLine(meeting, 1410, true), '今天 14:00 在海滩见面，现在就在这里碰面了');
  assert.equal(meetingLine(meeting, 1540, true), undefined, 'over once it has left');
  assert.equal(meetingLine(undefined, 900, false), undefined);
  assert.deepEqual(meetingMemory({ ...meeting, met: true, left: 1530 }),
    { text: '约好 14:00 在海滩见面，农场主来了。', importance: 2, kind: 'observation', subjects: ['player'], visibility: 'private' });
  assert.equal(meetingMemory({ ...meeting, met: false, left: 1530 }).text, '约好 14:00 在海滩见面，我等到 15:30，农场主没来。');
});

test('the Mod reports how an appointment went with valid times only', () => {
  const base = { type: 'meet.ended', lineageId: 'farm', loadNonce: 'n', seq: 3, npc: 'Abigail', place: '海滩', time: 1400, left: 1530, met: true,
    date: { year: 1, season: 'spring', day: 2, time: 1530 } };
  assert.equal(parseModMessage(JSON.stringify(base)).type, 'meet.ended');
  for (const change of [{ time: 1475 }, { left: -10 }, { met: 'yes' }, { place: '' }, { npc: undefined }]) {
    assert.throws(() => parseModMessage(JSON.stringify({ ...base, ...change })), JSON.stringify(change));
  }
  assert.throws(() => parseModMessage(JSON.stringify({ ...openTalk(), lineageId: 'farm', loadNonce: 'n', seq: 4, atMeeting: 1 })));
});

const nightly = {
  async chat(messages: ChatMessage[]): Promise<Completion> {
    const abigail = messages[1]!.content.includes('- 阿比盖尔，');
    const output = { memories: [{ sources: ['t2'], importance: 3 }], retire: [], impression: '', plan: '明天下午海边钓鱼', bubbles: [], letter: '',
      gift: false, share: '', meet: abigail ? { time: '14:00', place: '海滩', sources: ['t2', 't3'] } : { time: '14:00', place: '海滩', sources: ['t1'] } };
    return { content: JSON.stringify(output), reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
  },
} as unknown as ModelClient;

type Meetings = Extract<BackendMessage, { type: 'day.meetings' }>;

test('inherited place names are acknowledged without recording a fictional meeting', async t => {
  const h = await harness(t), server = await h.start(), wire = await connect(server);
  try {
    for (const place of ['constructor', 'toString', '__proto__', '你家']) {
      const cursor = wire.inbox.length;
      wire.send({ type: 'meet.ended', npc: 'Abigail', place, time: 1400, left: 1530, met: false, date: { ...WORLD.date, time: 1530 } });
      await wire.until('ack', cursor);
    }
    assert.equal(h.logs.filter(line => line.includes('记下了：约好')).length, 0);
  } finally { await wire.close(); }
});

test('an appointment reaches the Mod and the talk, and how it went is remembered with the day', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const agreement = { async chat(messages: ChatMessage[]): Promise<Completion> {
    h.fake.sent.push(messages);
    return { content: JSON.stringify({ reply: '好啊，那就明天下午海边见。', emotion: 'happy', options: ['一', '二', '三'], remember: [], mood: 0, end: false }),
      reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
  } };
  const server = await h.start(nightlyConsolidator({ roster: h.roster, model: nightly }), undefined, undefined, { model: agreement });
  let wire = await connect(server);
  for (const npc of ['Abigail', 'Sam']) {
    wire.send(openTalk(1, npc)); await wire.until('talk.reply');
    wire.send({ type: 'talk.say', npc, text: '明天下午一起去海边钓鱼吧？' }); await wire.until('talk.reply');
  }
  const commit = await sleep(wire);
  const meetings = () => wire.inbox.filter((item): item is Meetings => item.type === 'day.meetings').map(item => item.meetings);
  for (let i = 0; i < 300 && !meetings().some(list => list.length); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(meetings().at(-1), [{ npc: 'abigail', time: 1400, place: '海滩' }], "Sam's quote was his own line, not the player's");
  assert.ok(h.logs.includes('今天的约定：abigail 14:00 海滩'));

  const at = (time: number, atMeeting?: boolean) => ({ ...openTalk(2), world: { ...WORLD, date: { ...WORLD.date, day: 2, time } },
    ...(atMeeting === undefined ? {} : { atMeeting }) });
  const prompt = () => h.fake.sent.at(-1)!.map(message => message.content).join('\n');
  wire.send(at(900)); await wire.until('talk.reply', wire.inbox.length);
  assert.match(prompt(), /- 和农场主的约定：今天 14:00 在海滩见面\n/);
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack');
  wire.send(at(1410, true)); await wire.until('talk.reply', wire.inbox.length);
  assert.match(prompt(), /- 和农场主的约定：今天 14:00 在海滩见面，现在就在这里碰面了/);
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack');

  const ended = { type: 'meet.ended', npc: 'Abigail', place: '海滩', time: 1400, left: 1530, met: false, date: { ...WORLD.date, day: 2, time: 1530 } };
  const sent = wire.send(ended); await wire.until('ack', wire.inbox.length);
  wire.send({ ...ended, seq: sent.seq }); await wire.until('ack', wire.inbox.length);
  assert.equal(h.logs.filter(line => line === '阿比盖尔记下了：约好 14:00 在海滩见面，我等到 15:30，农场主没来。').length, 1, 'a resent report is written once');
  wire.send(at(1600)); await wire.until('talk.reply', wire.inbox.length);
  assert.doesNotMatch(prompt(), /和农场主的约定/, 'over once the NPC has left');
  assert.match(prompt(), /约好 14:00 在海滩见面，我等到 15:30，农场主没来。/);

  wire.send({ type: 'title.returned' }); await wire.until('ack'); await wire.close();
  wire = await connect(server, initial('load-2', 2, commit));
  for (let i = 0; i < 300 && !meetings().length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(meetings().at(-1), [{ npc: 'abigail', time: 1400, place: '海滩' }], 'a reload brings the appointment back');
  wire.send(at(1600)); await wire.until('talk.reply', wire.inbox.length);
  assert.doesNotMatch(prompt(), /农场主没来/, 'an unsaved report rolls back with the day');
  await wire.close();
});
