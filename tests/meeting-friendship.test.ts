import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseModMessage } from '../src/bridge/protocol.ts';
import { connect, harness, openTalk, WORLD } from './helpers/bridge.ts';

const ended = (extra: Record<string, unknown>) => ({ type: 'meet.ended', lineageId: 'farm', loadNonce: 'n', seq: 3, npc: 'Abigail', place: '海滩',
  time: 1400, left: 1530, met: true, date: { ...WORLD.date, time: 1530 }, ...extra });

test('the Mod reports what an appointment changed in friendship, within the day’s range only', () => {
  assert.equal((parseModMessage(JSON.stringify(ended({ friendship: 20 }))) as { friendship?: number }).friendship, 20);
  assert.equal((parseModMessage(JSON.stringify(ended({ met: false, friendship: -40 }))) as { friendship?: number }).friendship, -40);
  for (const friendship of [31, -41, 1.5, '20', null]) assert.throws(() => parseModMessage(JSON.stringify(ended({ friendship }))), String(friendship));
});

test('friendship from an appointment counts against the day’s range for later conversations', { timeout: 15000 }, async t => {
  const h = await harness(t);
  h.fake.mood(2);
  const server = await h.start();
  const wire = await connect(server);
  const at = (time: number) => ({ ...WORLD.date, time });
  const chat = async (npc: string, time: number) => {
    wire.send({ ...openTalk(1, npc), world: { ...WORLD, date: at(time) } }); await wire.until('talk.reply', wire.inbox.length);
    wire.send({ type: 'talk.say', npc, text: '你今天真好看。', date: at(time) });
    const reply = await wire.until('talk.reply', wire.inbox.length) as { friendship: number };
    wire.send({ type: 'talk.close', npc }); await wire.until('ack', wire.inbox.length);
    return reply.friendship;
  };
  // 8 hearts: a "very moved" line is worth 40, cut to the day's +30.
  assert.equal(await chat('Sam', 1000), 30);
  wire.send({ type: 'meet.ended', npc: 'Abigail', place: '海滩', time: 1400, left: 1530, met: true, friendship: 20, date: at(1530) });
  await wire.until('ack', wire.inbox.length);
  assert.ok(h.logs.includes('阿比盖尔记下了：约好 14:00 在海滩见面，农场主来了。'));
  assert.equal(await chat('Abigail', 1600), 10, 'the 20 the meeting gave was not counted');
  await wire.close();
});
