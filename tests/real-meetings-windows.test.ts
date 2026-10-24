import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, harness, openTalk, WORLD } from './helpers/bridge.ts';

// Windows review counterexamples: assert the actual list sent over the bridge, not only the quote parser.
const scenarios = [
  { id: 'relative invitation time conflicts', invite: true, replies: ['今天下午两点博物馆见，要不要一起？', '好，下午四点博物馆见。'], said: ['好啊，不过能晚一个小时吗？'], expected: [] },
  { id: 'explicit morning conflicts with evening', invite: true, replies: ['今天晚上八点海边见，要不要一起？', '好，晚上八点海边见。'], said: ['好啊，不过改到上午八点可以吗？'], expected: [] },
  { id: 'conflicting relative move keeps the original', replies: ['嗨。', '好，今天下午两点海边见。', '嗨。', '好啊，下午五点海边见。'], said: ['今天下午两点一起去海边？', '今天的约往后推一个小时行吗？'], expected: [{ npc: 'abigail', time: 1400, place: '海滩', sameDay: true }] },
  { id: 'a negated good idea creates no appointment', replies: ['嗨。', '这不算好主意。'], said: ['今天下午两点一起去海边？'], expected: [] },
  { id: 'a cancelled meal keeps the explicitly confirmed meeting', replies: ['嗨。', '好，今天下午两点海边见。', '嗨。', '好。'], said: ['今天下午两点一起去海边？', '今天我不去吃了，下午两点海边照常见。'], expected: [{ npc: 'abigail', time: 1400, place: '海滩', sameDay: true }] },
];

for (const scenario of scenarios) test(scenario.id, { timeout: 15000 }, async t => {
  const h = await harness(t);
  const replies = [...scenario.replies];
  h.fake.model.chat = async (_messages, handlers) => {
    const reply = replies.shift();
    assert.notEqual(reply, undefined);
    const content = JSON.stringify({ reply, emotion: 'neutral', options: ['好。'], remember: [], mood: 0, end: false });
    handlers?.onContent?.(content);
    return { content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 0, totalMs: 0 } };
  };
  const wire = await connect(await h.start());
  await wire.until('day.meetings', 0);
  for (const [index, said] of scenario.said.entries()) {
    const date = { ...WORLD.date, time: 1000 + index * 100 };
    let from = wire.inbox.length;
    wire.send({ ...openTalk(1), world: { ...WORLD, date }, ...(scenario.invite ? { invite: true } : {}) });
    await wire.until('talk.reply', from);
    from = wire.inbox.length;
    wire.send({ type: 'talk.say', npc: 'Abigail', text: said, date: { ...date, time: date.time + 10 } });
    await wire.until('talk.reply', from);
    from = wire.inbox.length;
    wire.send({ type: 'talk.close', npc: 'Abigail' });
    await wire.until('ack', from);
  }
  const from = wire.inbox.length;
  wire.raw(wire.loaded);
  await wire.until('save.ready', from);
  const sent = await wire.until('day.meetings', from) as { meetings: unknown[] };
  await wire.close();
  assert.deepEqual(sent.meetings, scenario.expected);
});
