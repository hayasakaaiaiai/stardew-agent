import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSON_HINT, OPENING_LINE, parseOutput, RULES } from '../src/agent/dialogue.ts';
import { FRIENDSHIP_DAY_MAX, FRIENDSHIP_DAY_MIN, friendshipPoints, friendshipSoFar, pointsPerMood } from '../src/agent/friendship.ts';
import type { BackendMessage } from '../src/bridge/protocol.ts';
import type { DayEntry } from '../src/types.ts';
import { connect, harness, initial, openTalk, sleep, WORLD } from './helpers/bridge.ts';

type Reply = Extract<BackendMessage, { type: 'talk.reply' }>;

const friend = (hearts: number) => ({ hearts, relation: 'friend' as const });

test('a stranger’s opinion swings easily and a close friend’s hardly moves; each day stays between −40 and +30', () => {
  assert.equal(FRIENDSHIP_DAY_MIN, -40); assert.equal(FRIENDSHIP_DAY_MAX, 30);
  assert.deepEqual([0, 1, 2, 4, 5, 7, 8, 14].map(hearts => pointsPerMood(friend(hearts)).loss), [20, 20, 15, 15, 10, 10, 5, 5]);
  assert.deepEqual([0, 2, 5, 8].map(hearts => pointsPerMood(friend(hearts)).gain), [20, 15, 10, 5]);
  for (const relation of ['dating', 'engaged', 'married', 'roommate'] as const)
    assert.deepEqual(pointsPerMood({ hearts: 3, relation }), { minHearts: 8, gain: 5, loss: 5 }, relation);
  assert.deepEqual([-2, -1, 0, 1, 2].map(mood => friendshipPoints(mood, 0, friend(5))), [-20, -10, 0, 10, 20]);
  assert.deepEqual([-2, -1, 1, 2].map(mood => friendshipPoints(mood, 0, friend(0))), [-40, -20, 20, 30], '+40 is cut at +30');
  assert.deepEqual([-2, -1, 1, 2].map(mood => friendshipPoints(mood, 0, friend(3))), [-30, -15, 15, 30]);
  assert.deepEqual([-2, -1, 1, 2].map(mood => friendshipPoints(mood, 0, friend(10))), [-10, -5, 5, 10]);
  assert.equal(friendshipPoints(2, 20, friend(5)), 10, 'cut at +30');
  assert.equal(friendshipPoints(1, 30, friend(5)), 0);
  assert.equal(friendshipPoints(-2, 30, friend(5)), -20, 'a bad line still counts after a good day');
  assert.equal(friendshipPoints(-2, -30, friend(5)), -10, 'cut at −40');
  assert.equal(friendshipPoints(9, 0, friend(5)), 20, 'out-of-range moods are clamped');
  const entry = (npcId: string, log: Record<string, unknown>): DayEntry => ({ seq: 1, gameTime: 0, changes: [{ npcId, log: log as never }] });
  assert.equal(friendshipSoFar([entry('abigail', { friendship: 20 }), entry('abigail', { friendship: -10 }), entry('abigail', {}),
    entry('sam', { friendship: 20 }), entry('abigail', { friendship: 'x' })], 'abigail'), 10);
});

test('the model rates the player’s line in mood; anything but an integer from −2 to 2 is 0', () => {
  assert.match(RULES, /\n- mood：这句话让你对玩家好感的变化，-2 到 2：闲聊 0，合心意 1，很感动 2，冒犯 -1，很过分 -2；讨好感、空奉承算 0。\n- end：/);
  assert.match(RULES, /"remember":\[\],"mood":0,"end":false\}/);
  assert.match(JSON_HINT, /remember、mood、end/);
  const mood = (value: unknown) => parseOutput(JSON.stringify({ reply: '嗯。', emotion: 'happy', options: ['一', '二', '三'], remember: [], mood: value, end: false })).meta.mood;
  assert.deepEqual([-2, 1, 2, 3, -3, 1.5, '1', null].map(mood), [-2, 1, 2, 0, 0, 0, 0, 0]);
  assert.equal(parseOutput('{"reply":"嗯。","emotion":"happy","options":["一","二","三"],"remember":[],"end":false}').ok, true,
    'a missing mood changes nothing and is not a format error');
});

test('replies carry capped friendship points; openings and resent turns never add more (at five hearts)', { timeout: 10000 }, async t => {
  const h = await harness(t); const server = await h.start(); const wire = await connect(server);
  const say = async (text: string, npc = 'Abigail', day = 1) => {
    const from = wire.inbox.length;
    const sent = wire.send({ type: 'talk.say', npc, text, date: { ...WORLD.date, day } });
    return { sent, reply: await wire.until('talk.reply', from) as Reply };
  };
  h.fake.mood(2);
  wire.send({ ...openTalk(), hearts: 5 }); assert.equal((await wire.until('talk.reply') as Reply).friendship, 0, 'the model rated the opening 2');
  h.fake.mood(0);
  const first = await say('好感2 你的画真好看');
  assert.equal(first.reply.friendship, 20);
  assert.equal((await say('好感2 还想再看一幅')).reply.friendship, 10, 'cut at +30 for the day');
  assert.equal((await say('好感1 谢谢你')).reply.friendship, 0);
  const rude = await say('好感-2 骗你的，画得真难看');
  assert.equal(rude.reply.friendship, -20);
  let from = wire.inbox.length;
  wire.raw(rude.sent);
  assert.equal((await wire.until('talk.reply', from) as Reply).friendship, -20, 'a resent turn is answered from its receipt');
  assert.equal((await say('好感-2 真的很难看')).reply.friendship, -20, 'the resend was not counted twice: 30 − 20 − 20');
  assert.equal((await say('好感-2 难看死了')).reply.friendship, -20);
  assert.equal((await say('好感-2 最难看')).reply.friendship, -10, 'cut at −40');

  from = wire.inbox.length;
  wire.send({ ...openTalk(1, 'Sam'), hearts: 5 }); await wire.until('talk.reply', from);
  assert.equal((await say('好感2 一起玩吧', 'Sam')).reply.friendship, 20, 'each NPC has its own range');
  assert.ok(h.fake.sent.some(messages => messages.at(-1)!.content.startsWith(OPENING_LINE)));

  const commit = await sleep(wire);
  from = wire.inbox.length;
  wire.send({ ...openTalk(2), hearts: 5 }); await wire.until('talk.reply', from);
  assert.equal((await say('好感2 早上好', 'Abigail', 2)).reply.friendship, 20, 'a new day starts a new range');
  wire.send({ type: 'title.returned' }); await wire.until('ack', wire.inbox.length); await wire.close();

  const reload = await connect(server, initial('load-2', 2, commit));
  reload.send({ ...openTalk(2), hearts: 5 }); await reload.until('talk.reply');
  from = reload.inbox.length;
  reload.send({ type: 'talk.say', npc: 'Abigail', text: '好感2 又见面了', date: { ...WORLD.date, day: 2 } });
  assert.equal((await reload.until('talk.reply', from) as Reply).friendship, 20, 'the unsaved day’s points were discarded with it');
});

test('the same rude line costs a stranger’s friendship four times what it costs a spouse’s', { timeout: 10000 }, async t => {
  const h = await harness(t); const wire = await connect(await h.start());
  const rude = async (npc: string, hearts: number, relation = 'friend') => {
    let from = wire.inbox.length;
    wire.send({ ...openTalk(1, npc), hearts, relation }); await wire.until('talk.reply', from);
    from = wire.inbox.length;
    wire.send({ type: 'talk.say', npc, text: '好感-2 你真讨厌' });
    const reply = await wire.until('talk.reply', from) as Reply;
    from = wire.inbox.length;
    wire.send({ type: 'talk.close', npc }); await wire.until('ack', from);
    return reply.friendship;
  };
  assert.deepEqual([await rude('Sam', 0), await rude('Haley', 3), await rude('Leah', 6), await rude('Alex', 9), await rude('Elliott', 4, 'married')],
    [-40, -30, -20, -10, -10]);
});
