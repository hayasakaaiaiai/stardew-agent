import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type FestivalResults, festivalMemories } from '../src/agent/festivals.ts';
import { nightlyConsolidator, type NightlyOutput } from '../src/agent/nightly.ts';
import { parseModMessage } from '../src/bridge/protocol.ts';
import type { ChatMessage, Completion, ModelClient } from '../src/services/model/client.ts';
import { connect, harness, initial, openTalk, sleep, WORLD } from './helpers/bridge.ts';

const NAMES: Record<string, string> = { abigail: '阿比盖尔', sebastian: '塞巴斯蒂安', lewis: '刘易斯', willy: '威利', penny: '潘妮', pam: '潘姆' };
const name = (id: string) => NAMES[id] ?? id;
const none = { dance: null, santa: null, contest: null, grange: null, soup: null };
const results = (extra: Partial<FestivalResults>): FestivalResults => ({ festival: 'spring24', present: [], ...none, ...extra });
const rows = (found: ReturnType<typeof festivalMemories>) => found.map(note => `${note.npcId} ${note.memory.importance} ${note.memory.text}`);
const ended = (extra: Record<string, unknown> = {}) => ({ type: 'festival.ended', festival: 'spring24', npcs: ['Abigail', 'Sebastian', 'Lewis'],
  ...none, dance: 'Abigail', date: { ...WORLD.date, time: 2200 }, ...extra });
const DANCED = '花舞节上农场主邀请我跳舞，我们一起跳了。';
const SAW_DANCE = '花舞节上我看到农场主和阿比盖尔跳了舞。';

test('the dance partner remembers dancing, and everyone else who was there saw it', () => {
  assert.deepEqual(rows(festivalMemories(results({ present: ['abigail', 'sebastian', 'lewis', 'sebastian'], dance: 'abigail' }), name)), [
    `abigail 4 ${DANCED}`, `sebastian 2 ${SAW_DANCE}`, `lewis 2 ${SAW_DANCE}`]);
  const [partner, onlooker] = festivalMemories(results({ present: ['abigail', 'sebastian'], dance: 'abigail' }), name);
  assert.deepEqual(partner!.memory, { text: DANCED, importance: 4, kind: 'observation', subjects: ['player'], topics: ['festival'], visibility: 'normal' });
  assert.deepEqual(onlooker!.memory.subjects, ['player', 'abigail']);
  assert.deepEqual(rows(festivalMemories(results({ present: ['sebastian'], dance: 'abigail' }), name)),
    [`abigail 4 ${DANCED}`, `sebastian 2 ${SAW_DANCE}`], 'the partner remembers even if the Mod missed her among the actors');
  assert.deepEqual(festivalMemories(results({ present: ['abigail', 'sebastian'] }), name), [], 'no dance, no memory: being there is not remembered');
});

test('the secret gift exchange is remembered only by the two people in it', () => {
  assert.deepEqual(rows(festivalMemories(results({ festival: 'winter25', present: ['penny', 'lewis', 'pam'],
    santa: { recipient: 'penny', giver: 'lewis' } }), name)), [
    'penny 3 冬日星盛宴上农场主抽到给我送礼，送了我礼物。', 'lewis 3 冬日星盛宴上我抽到给农场主送礼，礼物送到了。']);
});

test('contest results: everyone there knows who won; the NPC winner says “I”', () => {
  const here = ['abigail', 'lewis', 'pam'];
  assert.deepEqual(rows(festivalMemories(results({ festival: 'spring13', present: here, contest: 'player' }), name)),
    here.map(id => `${id} 2 复活节上我看到农场主赢了彩蛋大寻宝。`));
  assert.deepEqual(rows(festivalMemories(results({ festival: 'spring13', present: here, contest: 'npc' }), name)), [
    'abigail 2 复活节上我赢了彩蛋大寻宝，农场主没赢。', 'lewis 2 复活节上我看到阿比盖尔赢了彩蛋大寻宝，农场主没赢。', 'pam 2 复活节上我看到阿比盖尔赢了彩蛋大寻宝，农场主没赢。']);
  assert.deepEqual(rows(festivalMemories(results({ festival: 'winter8', present: ['willy', 'pam'], contest: 'npc' }), name)), [
    'willy 2 冰雪节上我赢了钓鱼比赛，农场主没赢。', 'pam 2 冰雪节上我看到威利赢了钓鱼比赛，农场主没赢。']);
  assert.deepEqual(rows(festivalMemories(results({ festival: 'winter8', present: ['willy'], contest: 'player' }), name)),
    ['willy 2 冰雪节上我看到农场主赢了钓鱼比赛。']);
});

test('the grange: a place or none for everyone there; the mayor’s shorts are his own in his memory', () => {
  const at = (grange: FestivalResults['grange']) => rows(festivalMemories(results({ festival: 'fall16', present: ['lewis', 'pam'], grange }), name));
  assert.deepEqual(at(1), ['lewis 2 星露谷展览会上我看到农场主的展台得了第一名。', 'pam 2 星露谷展览会上我看到农场主的展台得了第一名。']);
  assert.deepEqual(at(3)[1], 'pam 2 星露谷展览会上我看到农场主的展台得了第三名。');
  assert.deepEqual(at(4)[1], 'pam 2 星露谷展览会上我看到农场主的展台没评上名次。');
  assert.deepEqual(at('shorts'), ['lewis 3 星露谷展览会上农场主在展台里摆了我的紫色短裤。', 'pam 3 星露谷展览会上我看到农场主在展台里摆了镇长的紫色短裤。']);
});

test('the soup: what the governor said, never who spoiled it', () => {
  const at = (soup: number) => rows(festivalMemories(results({ festival: 'summer11', present: ['lewis', 'pam'], soup }), name));
  assert.deepEqual(at(0), ['lewis 3 夏威夷宴会上我看到州长喝了汤，说太难喝，当场晕了过去。', 'pam 3 夏威夷宴会上我看到州长喝了汤，说太难喝，当场晕了过去。']);
  assert.equal(at(4)[1], 'pam 2 夏威夷宴会上我看到州长喝了汤，说从没喝过这么好喝的汤。');
  assert.equal(at(5)[1], 'pam 2 夏威夷宴会上我看到州长喝了汤，说味道淡了，好像少了一个人的材料。');
  assert.deepEqual(at(6), ['lewis 3 夏威夷宴会的汤里有我的紫色短裤，州长气坏了。', 'pam 3 夏威夷宴会上我看到汤里有镇长的紫色短裤，州长气坏了。']);
  for (let soup = 0; soup <= 6; soup++) assert.doesNotMatch(at(soup).join(), /农场主/);
});

test('festival.ended needs every result field, null or in range', () => {
  const envelope = { lineageId: 'farm-1', loadNonce: 'load-1', seq: 3 };
  assert.equal(parseModMessage(JSON.stringify({ ...ended(), ...envelope })).type, 'festival.ended');
  for (const good of [{ festival: 'winter25', dance: null, santa: { recipient: 'Penny', giver: 'Lewis' } }, { grange: 'shorts' }, { grange: 4 },
    { soup: 0 }, { soup: 6 }, { contest: 'npc' }, { npcs: [] }])
    assert.equal(parseModMessage(JSON.stringify({ ...ended(good), ...envelope })).type, 'festival.ended', JSON.stringify(good));
  for (const bad of [{ festival: 'summer28' }, { npcs: 'Abigail' }, { npcs: [''] }, { dance: undefined }, { dance: 7 },
    { santa: { recipient: 'Penny' } }, { santa: 'Penny' }, { contest: 'Sam' }, { grange: 0 }, { grange: '1' }, { soup: 7 }, { soup: 1.5 },
    { soup: undefined }, { date: undefined }])
    assert.throws(() => parseModMessage(JSON.stringify({ ...ended(bad), ...envelope })), /Bad festival\.ended/, JSON.stringify(bad));
});

test('a festival is remembered by those there, once even when resent, and kept only if the day is saved', { timeout: 10000 }, async t => {
  const h = await harness(t); const server = await h.start(); const wire = await connect(server);
  const sent = wire.send(ended()); await wire.until('ack');
  assert.ok(h.logs.includes(`节日：阿比盖尔记下了：${DANCED}`));
  assert.ok(h.logs.includes(`节日：塞巴斯蒂安记下了：${SAW_DANCE}`));
  wire.raw(sent); await wire.until('ack', wire.inbox.length);
  assert.equal(h.logs.filter(line => line.startsWith('节日：')).length, 3, 'a resent message is answered from its receipt');
  wire.send(openTalk()); await wire.until('talk.reply');
  assert.equal(h.fake.sent.at(-1)![0]!.content.split(`（今天）${DANCED}`).length - 1, 1);
  wire.send(openTalk(1, 'Sebastian')); await wire.until('talk.reply', wire.inbox.length);
  assert.match(h.fake.sent.at(-1)![0]!.content, new RegExp(`（今天）${SAW_DANCE}`));
  const commit = await sleep(wire);

  wire.send(openTalk(2)); await wire.until('talk.reply', wire.inbox.length);
  assert.match(h.fake.sent.at(-1)![0]!.content, new RegExp(`（昨天）${DANCED}`));
  wire.send(ended({ festival: 'winter25', dance: null, santa: { recipient: 'Abigail', giver: 'Lewis' }, date: { ...WORLD.date, day: 2, time: 2200 } }));
  await wire.until('ack', wire.inbox.length);
  assert.ok(h.logs.some(line => line.includes('冬日星盛宴上农场主抽到给我送礼')));
  wire.send({ type: 'title.returned' }); await wire.until('ack', wire.inbox.length); await wire.close();

  const reload = await connect(server, initial('load-2', 2, commit));
  reload.send(openTalk(2)); await reload.until('talk.reply');
  assert.match(h.fake.sent.at(-1)![0]!.content, new RegExp(`（昨天）${DANCED}`));
  assert.doesNotMatch(h.fake.sent.at(-1)![0]!.content, /冬日星盛宴/, 'the unsaved day’s festival is gone with the day');
});

test('only the result of this festival counts; unknown names, absent NPCs and other days write nothing', { timeout: 10000 }, async t => {
  const h = await harness(t); const wire = await connect(await h.start());
  for (const extra of [
    { festival: 'fall16' },
    { dance: 'Gunther' },
    { date: { ...WORLD.date, day: 2, time: 2200 } },
    { festival: 'winter25', dance: null, santa: { recipient: 'Abigail', giver: 'Marlon' } },
    { festival: 'summer11', dance: null, npcs: ['Marlon', 'Governor'], soup: 3 },
  ]) {
    const from = wire.inbox.length;
    wire.send(ended(extra)); await wire.until('ack', from);
  }
  assert.ok(!wire.inbox.some(message => message.type === 'sync.error'));
  assert.ok(!h.logs.some(line => line.includes('记下了')), h.logs.join('\n'));
  wire.send(ended({ festival: 'summer11', dance: null, npcs: ['Pam', 'Marlon'], soup: 3 })); await wire.until('ack', wire.inbox.length);
  assert.deepEqual(h.logs.filter(line => line.startsWith('节日：')), ['节日：潘姆记下了：夏威夷宴会上我看到州长喝了汤，夸汤很好喝。']);
});

test('the night keeps festival notes as they are', { timeout: 10000 }, async t => {
  const h = await harness(t);
  const nightly: ChatMessage[][] = [];
  const output: NightlyOutput = { memories: [{ sources: ['t2'], importance: 4 }], retire: [], impression: '会跳舞', plan: '',
    bubbles: [], letter: '', gift: false, share: '' };
  const model = { async chat(messages: ChatMessage[]): Promise<Completion> {
    nightly.push(messages);
    return { content: JSON.stringify(output), reasoning: '', usage: null, finishReason: 'stop',
      timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
  } } as unknown as ModelClient;
  const wire = await connect(await h.start(nightlyConsolidator({ roster: h.roster, model })));
  wire.send(openTalk()); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住下次还一起跳' }); await wire.until('talk.reply', wire.inbox.length);
  wire.send(ended()); await wire.until('ack', wire.inbox.length);
  await sleep(wire);
  for (let i = 0; i < 400 && !h.logs.some(line => line.startsWith('夜间整合完成')); i++) await new Promise(done => setTimeout(done, 10));
  assert.match(nightly[0]![1]!.content, new RegExp(`^- （重要度 4）${DANCED}$`, 'm'));

  wire.send(openTalk(2)); await wire.until('talk.reply', wire.inbox.length);
  const system = h.fake.sent.at(-1)![0]!.content;
  assert.match(system, new RegExp(`（昨天）${DANCED}`));
  assert.doesNotMatch(system, /（昨天）下次还一起跳/, 'the conversation note was replaced by its quote');
});
