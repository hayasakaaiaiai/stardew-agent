import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextStop, nextStopsLine, restOfDay, type ScheduleStop } from '../src/agent/schedule.ts';
import { parseModMessage } from '../src/bridge/protocol.ts';
import type { ChatMessage, Completion, ModelClient } from '../src/services/model/client.ts';
import { connect, harness, openTalk, WORLD } from './helpers/bridge.ts';

const stop = (time: number, place: string, sleep = false): ScheduleStop => ({ time, place, sleep });
/** Harvey on a spring Monday, as the Mod reports it: every walk around the clinic is a stop of its own. */
const HARVEY = [stop(700, '哈维的房间'), stop(830, '诊所'), stop(1100, '诊所'), stop(1200, '鹈鹕镇'), stop(1730, '诊所'),
  stop(1840, '哈维的房间'), stop(2200, '哈维的房间', true)];
const SHANE = [stop(1700, '星之果实餐吧'), stop(700, 'Joja超市'), stop(1230, 'Joja超市'), stop(2300, '玛妮的牧场', true)];
const completion = (content: string): Completion =>
  ({ content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } });
async function until(ready: () => boolean) {
  for (let i = 0; i < 200 && !ready(); i++) await new Promise(done => setTimeout(done, 10));
  assert.ok(ready(), 'timed out');
}

test('the rest of the day starts at the stop the NPC is on, with walks around one place merged', () => {
  assert.equal(restOfDay(HARVEY, 1400), '当前：鹈鹕镇；下一站：17:30 诊所；之后：18:40 哈维的房间，22:00 睡觉');
  assert.equal(restOfDay(HARVEY, 600), '下一站：07:00 哈维的房间；之后：08:30 诊所，12:00 鹈鹕镇，17:30 诊所，18:40 哈维的房间，22:00 睡觉',
    'before the first stop, the whole day');
  assert.equal(restOfDay(HARVEY, 2330), '当前：睡觉；下一站：无，今天不再外出');
  assert.equal(restOfDay(SHANE, 1300), '当前：Joja超市；下一站：17:00 星之果实餐吧；之后：23:00 回家睡觉', 'sorted; bed elsewhere is going home');
  assert.equal(restOfDay([], 1300), undefined);
  assert.equal(restOfDay(Array.from({ length: 25 }, (_, i) => stop(600 + i * 10, `地点${i}`)), 900), undefined, 'not a real schedule');
});

test('a rainy day staying home is not a new trip; midnight remains later than the evening', () => {
  const rainy = [stop(900, '皮埃尔的杂货店'), stop(1300, '皮埃尔的杂货店'), stop(2200, '皮埃尔的杂货店', true)];
  assert.equal(restOfDay(rainy, 1400), '当前：皮埃尔的杂货店；下一站：22:00 睡觉（此前不外出）');
  assert.equal(restOfDay(HARVEY, 1730), '当前：诊所；下一站：18:40 哈维的房间；之后：22:00 睡觉');
  const pam = [stop(1200, 'Joja超市'), stop(1600, '星之果实餐吧'), stop(2400, '潘姆家', true)];
  assert.equal(restOfDay(pam, 2300), '当前：星之果实餐吧；下一站：00:00 回家睡觉（此前不外出）');
  assert.equal(restOfDay(pam, 2400), '当前：回家睡觉；下一站：无，今天不再外出');
});

test('scenes get only the next stop', () => {
  assert.equal(nextStop(HARVEY, 1400), '17:30 去诊所');
  assert.equal(nextStop(HARVEY, 1730), '18:40 去哈维的房间', 'a stop that starts now has begun');
  assert.equal(nextStop(HARVEY, 2000), '22:00 睡觉');
  assert.equal(nextStop(SHANE, 1800), '23:00 回家睡觉');
  assert.equal(nextStop(HARVEY, 2200), undefined);
  assert.equal(nextStop([], 900), undefined);
  assert.equal(nextStopsLine([undefined, '17:30 去诊所', '23:00 回家睡觉'], ['a', 'b', 'c']), '- 接下来：b 17:30 去诊所；c 23:00 回家睡觉');
  assert.equal(nextStopsLine([undefined, undefined], ['a', 'b']), undefined);
});

test('schedules are optional on every message that carries them, and checked when present', () => {
  const envelope = { lineageId: 'farm', loadNonce: 'load', seq: 3 };
  const ok = [stop(900, '诊所'), stop(2530, '哈维的房间', true)];
  const messages = (schedule: unknown) => [
    { type: 'talk.open', npc: 'Harvey', hearts: 3, relation: 'friend', seenEvents: [], world: WORLD, schedule },
    { type: 'scene.request', npcs: ['Harvey', 'Maru'], world: WORLD, schedules: { Harvey: schedule } },
    { type: 'ambient.request', npcs: [{ npc: 'Harvey', hearts: 3, relation: 'friend', greeted: false, schedule }], world: WORLD },
    { type: 'town.hour', groups: [['Harvey', 'Maru']], date: WORLD.date, schedules: { Harvey: schedule } },
  ];
  for (const message of [...messages(ok), ...messages([])]) assert.equal(parseModMessage(JSON.stringify({ ...envelope, ...message })).type, message.type);
  for (const message of messages(undefined)) assert.equal(parseModMessage(JSON.stringify({ ...envelope, ...message })).type, message.type, 'older Mods');
  const bad = [null, 'Harvey', [stop(960, '诊所')], [stop(2900, '诊所')], [stop(9.5, '诊所')], [stop(900, '')], [stop(900, '诊\n所')],
    [{ time: 900, place: '诊所' }], [{ time: 900, place: '诊所', sleep: 'yes' }], Array.from({ length: 25 }, (_, i) => stop(600 + i, '诊所'))];
  for (const schedule of bad)
    for (const message of messages(schedule))
      assert.throws(() => parseModMessage(JSON.stringify({ ...envelope, ...message })), /schedule/, `${message.type} ${JSON.stringify(schedule)}`);
  assert.throws(() => parseModMessage(JSON.stringify({ ...envelope, ...messages(ok)[1]!, schedules: { '': ok } })), /schedules/);
});

test('each call is told where its NPCs go next; an NPC without a schedule gets no line', { timeout: 10000 }, async t => {
  const h = await harness(t);
  const scenes: ChatMessage[][] = [];
  const backstage: ChatMessage[][] = [];
  const sceneModel = { async chat(messages: ChatMessage[]) {
    scenes.push(messages);
    return completion(JSON.stringify({ told: [], lines: [] }));
  } } as unknown as ModelClient;
  const backstageModel = { async chat(messages: ChatMessage[]) {
    backstage.push(messages);
    return completion(JSON.stringify({ memories: {} }));
  } } as unknown as ModelClient;
  const server = await h.start(undefined, undefined, sceneModel, { backstageModel });
  const wire = await connect(server);
  const at = (time: number) => ({ ...WORLD, date: { ...WORLD.date, time } });

  let from = wire.inbox.length;
  wire.send({ ...openTalk(1, 'Harvey'), world: at(1400), schedule: HARVEY }); await wire.until('talk.reply', from);
  const system = () => h.fake.sent.at(-1)![0]!.content;
  assert.match(system(), /- 地点：种子商店\n- 今日行程（覆盖平日习惯和先前台词，不另加去处）：当前：鹈鹕镇；下一站：17:30 诊所；之后：18:40 哈维的房间，22:00 睡觉\n/);
  from = wire.inbox.length;
  wire.send({ type: 'talk.say', npc: 'Harvey', text: '晚上去哪？' }); await wire.until('talk.reply', from);
  assert.match(system(), /- 今日行程.+当前：鹈鹕镇/, 'the whole conversation keeps the line');
  wire.send({ type: 'talk.close', npc: 'Harvey' });
  from = wire.inbox.length;
  wire.send({ ...openTalk(1, 'Abigail'), world: at(1400) }); await wire.until('talk.reply', from);
  assert.doesNotMatch(system(), /今日行程/, 'no schedule, no line');

  from = wire.inbox.length;
  wire.send({ type: 'scene.request', npcs: ['Sebastian', 'Abigail'], world: at(1400), schedules: { Sebastian: SHANE } });
  await wire.until('scene.lines', from);
  assert.match(scenes.at(-1)![1]!.content, /\n- 接下来：b 17:00 去星之果实餐吧\n/, 'Abigail is a, and has no schedule');

  from = wire.inbox.length;
  wire.send({ type: 'ambient.request', world: at(1500), npcs: [{ npc: 'Harvey', hearts: 3, relation: 'friend', greeted: false, schedule: HARVEY },
    { npc: 'Maru', hearts: 2, relation: 'friend', greeted: false }] });
  await wire.until('ambient.lines', from);
  assert.match(scenes.at(-1)![1]!.content, /\n- 接下来：a 17:30 去诊所\n/);

  from = wire.inbox.length;
  wire.send({ type: 'town.hour', date: { ...WORLD.date, time: 1900 }, groups: [['Shane', 'Harvey']], places: ['星之果实餐吧'],
    hearts: { Shane: 6, Harvey: 2 }, schedules: { Shane: SHANE, Harvey: HARVEY } });
  await wire.until('ack', from);
  await until(() => backstage.length === 1);
  assert.match(backstage[0]![1]!.content, /\n- 接下来：a 23:00 回家睡觉；b 22:00 睡觉\n/);
});
