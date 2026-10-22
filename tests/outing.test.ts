import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meetingLine, meetingMemory, outingText, type Outing } from '../src/agent/meetings.ts';
import { parseModMessage } from '../src/bridge/protocol.ts';
import { connect, harness, meetingsSent, openTalk, WORLD } from './helpers/bridge.ts';

const NOTHING = { fish: 0, fishNames: [], escaped: 0, treasures: 0, foraged: 0, artifacts: 0 };
const WALKED: Outing = { ...NOTHING, places: ['海滩'], here: '海滩' };
const FISHED: Outing = { ...NOTHING, places: ['海滩', '鹈鹕镇'], here: '鹈鹕镇', fish: 2, fishNames: ['鲈鱼', '沙丁鱼'] };
const ALL: Outing = { places: ['海滩', '鹈鹕镇', '山区'], here: '山区', fish: 3, fishNames: ['鲈鱼', '沙丁鱼', '鲤鱼'], escaped: 1, treasures: 1, foraged: 4,
  artifacts: 1 };

test('what the NPC saw while together is said as measured in the design, leaving out what did not happen', () => {
  assert.equal(outingText(WALKED), '你一直陪着农场主，现在在海滩');
  assert.equal(outingText(FISHED), '你一直陪着农场主，从海滩到了鹈鹕镇；农场主钓到 2 条鱼（鲈鱼、沙丁鱼）');
  assert.equal(outingText(ALL), '你一直陪着农场主，从海滩到了鹈鹕镇、山区；农场主钓到 3 条鱼（鲈鱼、沙丁鱼、鲤鱼），跑了 1 条，钓到 1 个宝箱，捡了 4 个采集物，挖到 1 件古物');
  // Back where they started: where they went, and where they are.
  assert.equal(outingText({ ...WALKED, places: ['海滩', '鹈鹕镇'], here: '海滩', escaped: 2 }), '你一直陪着农场主，去过海滩、鹈鹕镇，现在在海滩；农场主钓鱼跑了 2 条');
  assert.equal(meetingLine({ time: 1400, place: '海滩' }, 1500, true, undefined, undefined, FISHED),
    '今天 14:00 在海滩见面；你一直陪着农场主，从海滩到了鹈鹕镇；农场主钓到 2 条鱼（鲈鱼、沙丁鱼）');
});

test('the outing is remembered in the NPC’s own words, and only once they met', () => {
  assert.deepEqual(meetingMemory({ time: 1400, place: '海滩', met: true, left: 1530, outing: FISHED }),
    { text: '约好 14:00 在海滩见面，农场主来了，我陪农场主从海滩到了鹈鹕镇，看农场主钓到 2 条鱼（鲈鱼、沙丁鱼）。', importance: 3, kind: 'observation',
      subjects: ['player'], visibility: 'private' });
  assert.equal(meetingMemory({ time: 1400, place: '海滩', met: true, left: 1450, outing: WALKED, calledOff: '玩家' }).text,
    '约好 14:00 在海滩见面，农场主来了，我陪农场主在海滩走了走，后来农场主让我先回去了。');
  assert.equal(meetingMemory({ time: 1400, place: '海滩', met: false, left: 1530, outing: WALKED }).text, '约好 14:00 在海滩见面，我等到 15:30，农场主没来。');
});

test('the Mod reports the outing as names and whole counts', () => {
  const base = { type: 'meet.ended', lineageId: 'farm', loadNonce: 'n', seq: 3, npc: 'Abigail', place: '海滩', time: 1400, left: 1530, met: true,
    date: { year: 1, season: 'spring', day: 2, time: 1530 } };
  assert.deepEqual((parseModMessage(JSON.stringify({ ...base, outing: ALL })) as { outing?: unknown }).outing, ALL);
  assert.ok(parseModMessage(JSON.stringify({ ...openTalk(), lineageId: 'farm', loadNonce: 'n', seq: 4, atMeeting: true, outing: WALKED })));
  for (const outing of [{ ...ALL, places: [] }, { ...ALL, places: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, { ...ALL, here: '' }, { ...ALL, fish: -1 },
    { ...ALL, foraged: 1.5 }, { ...ALL, fish: 1 }, { ...ALL, fishNames: ['a', 'b', 'c', 'd'], fish: 4 }, { ...ALL, places: ['海\n滩'] },
    { ...ALL, artifacts: undefined }, null]) assert.throws(() => parseModMessage(JSON.stringify({ ...base, outing })), JSON.stringify(outing));
});

test('agreed today, the talk while together knows the outing, and the memory keeps it', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const originalChat = h.fake.model.chat.bind(h.fake.model);
  h.fake.model.chat = async (...args: Parameters<typeof originalChat>) => {
    const result = await originalChat(...args);
    const asked = /一起去海边/.test(args[0].at(-1)!.content);
    return asked ? { ...result, content: JSON.stringify({ ...JSON.parse(result.content), reply: '好啊，现在一起去海边吧。' }) } : result;
  };
  const server = await h.start();
  const wire = await connect(server);
  await wire.until('day.meetings', 0);
  const at = (time: number) => ({ ...WORLD.date, time });
  wire.send({ ...openTalk(1), world: { ...WORLD, date: at(1000) } }); await wire.until('talk.reply', wire.inbox.length);
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '现在一起去海边吧？', date: at(1000) }); await wire.until('talk.reply', wire.inbox.length);
  const from = wire.inbox.length;
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack', from);
  const expected = [{ npc: 'abigail', time: 1000, place: '海滩', sameDay: true }];
  assert.deepEqual(await meetingsSent(wire, from, expected), expected);

  const prompt = () => h.fake.sent.at(-1)!.map(message => message.content).join('\n');
  wire.send({ ...openTalk(1), world: { ...WORLD, date: at(1110) }, atMeeting: true, outing: FISHED }); await wire.until('talk.reply', wire.inbox.length);
  assert.match(prompt(), /- 和农场主的约定：今天 10:00 约好马上去海滩见面；你一直陪着农场主，从海滩到了鹈鹕镇；农场主钓到 2 条鱼（鲈鱼、沙丁鱼）/);
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack', wire.inbox.length);
  wire.send({ type: 'meet.ended', npc: 'Abigail', place: '海滩', time: 1000, arrived: 1000, left: 1130, met: true, outing: { ...FISHED, foraged: 3 },
    date: at(1130) });
  await wire.until('ack', wire.inbox.length);
  assert.ok(h.logs.includes('阿比盖尔记下了：约好马上去海滩见面，农场主来了，我陪农场主从海滩到了鹈鹕镇，看农场主钓到 2 条鱼（鲈鱼、沙丁鱼），捡了 3 个采集物。'));
  await wire.close();
});
