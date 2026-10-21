import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { BACKSTAGE_RULES, backstageHour, backstagePrompt, parseBackstage, pickBackstage } from '../src/agent/backstage.ts';
import type { WorldState } from '../src/agent/dialogue.ts';
import { nightlyConsolidator } from '../src/agent/nightly.ts';
import { parseModMessage } from '../src/bridge/protocol.ts';
import type { ChatMessage, Completion, ModelClient } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';
import { connect, deferred, harness, initial, openTalk, sleep, WORLD } from './helpers/bridge.ts';

const SHARE = '测试送了我一块紫水晶，颜色特别漂亮。';
const DANCED = '花舞节上农场主邀请我跳舞，我们一起跳了。';
const SAW_DANCE = '花舞节上我看到农场主和阿比盖尔跳了舞。';
const SOUP = '格斯说汤又做多了，我们笑他手太大方';
const NAMES: Record<string, string> = { pam: '潘姆', gus: '格斯', shane: '谢恩', emily: '艾米丽', abigail: '阿比盖尔', sebastian: '塞巴斯蒂安' };
const name = (id: string) => NAMES[id] ?? id;
const person = (id: string, hearts: number, hasNews = false) => ({ id, hearts, hasNews });
const completion = (content: string): Completion =>
  ({ content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } });
const settle = () => new Promise(done => setTimeout(done, 50));
async function until(ready: () => boolean) {
  for (let i = 0; i < 200 && !ready(); i++) await new Promise(done => setTimeout(done, 10));
  assert.ok(ready(), 'timed out');
}

test('a scene needs two people without one today, one of them 5 hearts or more; at most the closest 3, news first among equals', () => {
  const none = new Set<string>();
  assert.equal(pickBackstage([{ place: '餐吧', people: [person('pam', 4), person('gus', 4)] }], none), undefined, 'remembered for nothing');
  assert.equal(pickBackstage([{ place: '餐吧', people: [person('pam', 6), person('gus', 4)] }], new Set(['gus'])), undefined, 'one left is no scene');
  assert.deepEqual(pickBackstage([{ place: '餐吧', people: [person('pam', 6), person('gus', 4), person('shane', 5),
    person('emily', 4, true), person('clint', 2)] }], none), { place: '餐吧', ids: ['pam', 'shane', 'emily'] });
  assert.deepEqual(pickBackstage([{ place: '餐吧', people: [person('pam', 9), person('gus', 2), person('shane', 8)] }], new Set(['pam'])),
    { place: '餐吧', ids: ['shane', 'gus'] }, 'who had a scene today is left out before counting');
});

test('groups with news go first, then the closest, then the larger', () => {
  const quiet = { place: '诊所', people: [person('harvey', 9), person('maru', 2)] };
  const news = { place: '杂货店', people: [person('pierre', 5), person('caroline', 1, true)] };
  const closer = { place: '木匠店', people: [person('robin', 10), person('demetrius', 3)] };
  const larger = { place: '镇长家', people: [person('lewis', 10), person('marnie', 1), person('jodi', 0)] };
  assert.equal(pickBackstage([quiet, news, closer], new Set())?.place, '杂货店');
  assert.equal(pickBackstage([quiet, closer], new Set())?.place, '木匠店');
  assert.equal(pickBackstage([closer, larger], new Set())?.place, '镇长家');
});

test('scenes start from 07:00 to 23:00, so each result still has an hour to be written in', () => {
  assert.deepEqual([600, 650, 700, 1800, 2300, 2310, 2400].map(backstageHour), [false, false, true, true, true, false, false]);
});

test('the prompt names who is there, what their cards say of each other, and only what each may tell of the farmer', async () => {
  const roster = new Roster({ directory: resolve(import.meta.dirname, '../data/npcs'), npcIds: SOCIAL_NPCS });
  await roster.load();
  const world: WorldState = { year: 1, season: 'spring', day: 3, time: '18:00', weather: '下雨', location: '星之果实餐吧',
    player: { name: '测试', gender: 'female', farm: '测试' }, facts: {} };
  const [system, user] = backstagePrompt(roster, [
    { id: 'pam', news: [{ origin: 'pam', share: SHARE, hand: 1 }, { origin: 'abigail', share: '阿比的事。', hand: 2 }], festivals: [DANCED] },
    { id: 'gus', news: [{ origin: 'pam', share: SHARE, hand: 2 }], festivals: [] },
    { id: 'shane', news: [], festivals: [SAW_DANCE] },
  ], '星之果实餐吧', world);
  assert.equal(system!.content, BACKSTAGE_RULES);
  const content = user!.content;
  for (const [letter, id] of [['a', 'pam'], ['b', 'gus'], ['c', 'shane']] as const)
    assert.ok(content.includes(`- ${letter}：${roster.get(id).name}。`), letter);
  const present = ['pam', 'gus', 'shane'];
  const relations = present.flatMap(id => roster.get(id).relationships.flatMap(({ id: other, text }) =>
    other && other !== id && present.includes(other) ? [`- ${roster.get(id).name}眼里的${roster.get(other).name}：${text}`] : []));
  assert.ok(relations.length > 0, 'the cards say something about each other');
  for (const line of relations) assert.ok(content.includes(line), line);
  assert.match(content, new RegExp(`## 记得的农场主的事\\n- 潘姆：${SHARE}\\n- 潘姆：阿比盖尔说过："阿比的事。"\\n- 谢恩：${SAW_DANCE}\\n\\n`),
    'two per person, and news heard from someone present only once');
  assert.match(content, /## 现在\n- 第 1 年春季 3 日 18:00，下雨，星之果实餐吧\n- 农场主：测试（女），不在这里/);
  const [, quiet] = backstagePrompt(roster, [{ id: 'pam', news: [], festivals: [] }, { id: 'gus', news: [], festivals: [] }], '', world);
  assert.match(quiet!.content, /## 记得的农场主的事\n（没有）/);
});

test('each person keeps one line, prefixed in code with the real place and company; an unusable line drops only itself', () => {
  const ids = ['pam', 'gus', 'shane'];
  const notes = parseBackstage(`好的：${JSON.stringify({ memories: { a: SOUP, b: '我们约好周六一起去钓鱼', c: '#潘姆又讲起她开巴士的日子[' } })}`,
    ids, '星之果实餐吧', name);
  assert.deepEqual(notes.map(note => [note.npcId, note.memory.text]), [
    ['pam', `在星之果实餐吧和格斯、谢恩聊天：${SOUP}`],
    ['shane', '在星之果实餐吧和潘姆、格斯聊天：潘姆又讲起她开巴士的日子']]);
  assert.deepEqual(notes[0]!.memory, { text: `在星之果实餐吧和格斯、谢恩聊天：${SOUP}`, importance: 2, kind: 'observation',
    subjects: ['gus', 'shane'], topics: ['backstage'], visibility: 'normal' });
  const forty = '一'.repeat(40);
  assert.deepEqual(parseBackstage(JSON.stringify({ memories: { a: forty, b: `${forty}二`, c: 3 } }), ids, '', name).map(note => note.memory.text),
    [`在镇上和格斯、谢恩聊天：${forty}`], 'up to 40 characters; no place means the town');
  for (const bad of ['不是 JSON', '{"memories":["a"]}', '{"memories":null}', '{}', '{"memories":{"a":" "}}'])
    assert.deepEqual(parseBackstage(bad, ids, '餐吧', name), [], bad);
});

test('town.hour may carry each group’s place, everyone’s hearts and the weather', () => {
  const hour = (extra: Record<string, unknown>) => JSON.stringify({ type: 'town.hour', lineageId: 'farm', loadNonce: 'load', seq: 4,
    date: WORLD.date, groups: [['Gus', 'Pam']], ...extra });
  assert.equal(parseModMessage(hour({})).type, 'town.hour', 'older Mods send groups only');
  assert.equal(parseModMessage(hour({ places: ['星之果实餐吧'], hearts: { Gus: 0, Pam: 14 }, weather: 'rain' })).type, 'town.hour');
  for (const bad of [{ places: [] }, { places: ['餐吧', '诊所'] }, { places: [3] }, { places: ['餐\n吧'] }])
    assert.throws(() => parseModMessage(hour(bad)), /places/, JSON.stringify(bad));
  for (const bad of [{ hearts: { Gus: 15 } }, { hearts: { Gus: -1 } }, { hearts: { Gus: 2.5 } }, { hearts: [3] }, { hearts: null }, { hearts: { '': 3 } }])
    assert.throws(() => parseModMessage(hour(bad)), /hearts/, JSON.stringify(bad));
  assert.throws(() => parseModMessage(hour({ weather: 'fog' })), /weather/);
});

test('a group away from the player chats once an hour; each remembers it from the next hour, with the day', { timeout: 20000 }, async t => {
  const h = await harness(t);
  const calls: ChatMessage[][] = [];
  let reply = JSON.stringify({ memories: { a: SOUP, b: '潘姆又讲起她开巴士的日子', c: '我们约好明天一起去钓鱼' } });
  let hold: Promise<void> | undefined;
  const backstageModel = { async chat(messages: ChatMessage[]) { calls.push(messages); await hold; return completion(reply); } } as unknown as ModelClient;
  const server = await h.start(undefined, undefined, undefined, { backstageModel });
  let wire = await connect(server);
  const hour = async (time: number, groups: string[][], hearts: Record<string, number> | undefined) => {
    const from = wire.inbox.length;
    const sent = wire.send({ type: 'town.hour', date: { ...WORLD.date, time }, groups, places: groups.map(() => '星之果实餐吧'),
      ...(hearts ? { hearts, weather: 'rain' } : {}) });
    await wire.until('ack', from);
    return sent;
  };
  const remembered = () => h.logs.filter(line => /^后台场景：.+记下了：/.test(line));

  await hour(1800, [['Pam', 'Gus', 'Shane', 'Emily']], undefined); await settle();
  assert.equal(calls.length, 0, 'without hearts the Mod has backstage scenes off');
  await hour(1900, [['Pam', 'Gus']], { Pam: 4, Gus: 4 }); await settle();
  assert.equal(calls.length, 0, 'nobody close to the player');
  const scene = await hour(2000, [['Pam', 'Gus', 'Shane', 'Emily'], ['Leah', 'Elliott']], { Pam: 8, Gus: 3, Shane: 6, Emily: 2, Leah: 5, Elliott: 0 });
  await until(() => h.logs.some(line => line.startsWith('后台场景：星之果实餐吧，')));
  assert.equal(calls.length, 1);
  assert.match(calls[0]![1]!.content, /- a：潘姆。.*\n- b：谢恩。.*\n- c：格斯。/);
  assert.doesNotMatch(calls[0]![1]!.content, /艾米丽/, 'the three closest');
  assert.match(calls[0]![1]!.content, /20:00，下雨，星之果实餐吧/);
  assert.ok(h.logs.includes('后台场景：星之果实餐吧，潘姆、谢恩、格斯，2 条等下一个整点写入'), 'the promise is dropped');
  assert.deepEqual(remembered(), [], 'not written under an hour that has already gone');
  let from = wire.inbox.length;
  wire.raw(scene); await wire.until('ack', from); await settle();
  assert.equal(calls.length, 1, 'a resent hour starts nothing, though Leah and Elliott could still talk');

  await hour(2100, [['Emily', 'Gus']], { Emily: 9, Gus: 3 }); await settle();
  assert.deepEqual(remembered(), [`后台场景：潘姆记下了：在星之果实餐吧和谢恩、格斯聊天：${SOUP}`,
    '后台场景：谢恩记下了：在星之果实餐吧和潘姆、格斯聊天：潘姆又讲起她开巴士的日子']);
  assert.equal(calls.length, 1, 'Gus already had a scene today, so Emily is alone');
  from = wire.inbox.length;
  wire.send(openTalk(1, 'Pam')); await wire.until('talk.reply', from);
  assert.ok(h.fake.sent.at(-1)![0]!.content.includes(`在星之果实餐吧和谢恩、格斯聊天：${SOUP}`));

  // A result that comes back after the player left for the title screen is never written.
  const release = deferred(); hold = release.promise;
  reply = JSON.stringify({ memories: { a: '海莉说照片洗出来了', b: '亚历克斯又在练球' } });
  await hour(2200, [['Haley', 'Alex']], { Haley: 6, Alex: 5 }); await until(() => calls.length === 2);
  from = wire.inbox.length;
  wire.send({ type: 'title.returned' }); await wire.until('ack', from); await wire.close();
  release.resolve(); await settle();
  assert.ok(h.logs.every(line => !line.startsWith('后台场景：星之果实餐吧，海莉')), 'nothing waits for the next hour');

  wire = await connect(server, initial('load-2'));
  from = wire.inbox.length;
  wire.send(openTalk(1, 'Pam')); await wire.until('talk.reply', from);
  assert.ok(!h.fake.sent.at(-1)![0]!.content.includes(SOUP), 'the unsaved day took the scene with it');
  await hour(2300, [['Abigail', 'Sebastian']], { Abigail: 2, Sebastian: 2 });
  assert.equal(remembered().length, 2, 'the earlier load’s result is gone');
});

test('at most one scene an hour and six a day, a fresh count for every load', { timeout: 20000 }, async t => {
  const h = await harness(t);
  let calls = 0;
  const backstageModel = { async chat() { calls++; return completion(JSON.stringify({ memories: { a: '聊了聊天气', b: '聊了聊天气' } })); } } as unknown as ModelClient;
  const server = await h.start(undefined, undefined, undefined, { backstageModel });
  let wire = await connect(server);
  const pairs = [['Abigail', 'Sebastian'], ['Sam', 'Penny'], ['Leah', 'Elliott'], ['Haley', 'Alex'], ['Maru', 'Harvey'], ['Emily', 'Shane'], ['Pam', 'Gus']];
  const hearts = Object.fromEntries(pairs.flat().map(npc => [npc, 6]));
  const hour = async (time: number, groups: string[][]) => {
    const from = wire.inbox.length;
    wire.send({ type: 'town.hour', date: { ...WORLD.date, time }, groups, places: groups.map(() => '镇上'), hearts, weather: 'sunny' });
    await wire.until('ack', from); await settle();
  };
  await hour(1100, [pairs[0]!, pairs[1]!]);
  assert.equal(calls, 1, 'one group an hour');
  for (let i = 1; i <= 5; i++) { await hour(1100 + i * 100, [pairs[i]!]); await until(() => calls === i + 1); }
  await hour(1700, [pairs[6]!]);
  assert.equal(calls, 6, 'the seventh pair waits for tomorrow');
  assert.equal(h.logs.filter(line => line.startsWith('后台场景：镇上，')).length, 6);

  wire.send({ type: 'title.returned' }); await wire.until('ack', wire.inbox.length); await wire.close();
  wire = await connect(server, initial('load-2'));
  await hour(600, [pairs[6]!]);
  assert.equal(calls, 6, 'not before 07:00');
  await hour(2300, [pairs[6]!]);
  assert.equal(calls, 7, 'the reload replays the day with a fresh count; 23:00 is the last hour');
  await hour(2400, [pairs[5]!]);
  assert.equal(calls, 7, 'none after 23:00');
});

test('scenes are told only news that may go on and the last week’s festivals, never older scenes', { timeout: 30000 }, async t => {
  const h = await harness(t);
  const nightly = { async chat() { return completion(JSON.stringify({ memories: [], retire: [], impression: '大方', plan: '', bubbles: [],
    letter: '', gift: false, share: SHARE })); } } as unknown as ModelClient;
  const prompts: string[] = [];
  const backstageModel = { async chat(messages: ChatMessage[]) {
    prompts.push(messages[1]!.content);
    return completion(JSON.stringify({ memories: { a: `第${prompts.length}次闲聊`, b: `第${prompts.length}次闲聊` } }));
  } } as unknown as ModelClient;
  const server = await h.start(nightlyConsolidator({ roster: h.roster, model: nightly }), undefined, undefined, { backstageModel });
  const wire = await connect(server);
  const known = (index: number) => /## 记得的农场主的事\n([^#]*)\n\n/.exec(prompts[index]!)![1];
  wire.send(openTalk()); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '记住我的秘密基地在矿洞旁边' }); await wire.until('talk.reply', wire.inbox.length);
  wire.send({ type: 'festival.ended', festival: 'spring24', npcs: ['Abigail', 'Sebastian', 'Lewis'], dance: 'Abigail', santa: null,
    contest: null, grange: null, soup: null, date: { ...WORLD.date, time: 2200 } });
  await wire.until('ack', wire.inbox.length);
  let commit = await sleep(wire);
  for (let i = 0; i < 400 && !h.logs.some(line => line.startsWith('夜间整合完成')); i++) await new Promise(done => setTimeout(done, 10));
  const hour = async (day: number, time: number, groups: string[][], hearts: Record<string, number>) => {
    const before = prompts.length;
    const from = wire.inbox.length;
    wire.send({ type: 'town.hour', date: { ...WORLD.date, day, time }, groups, places: groups.map(() => '酒吧'), hearts });
    await wire.until('ack', from);
    for (let i = 0; i < 100 && prompts.length === before && hearts && Object.values(hearts).some(value => value >= 5); i++) await settle();
  };

  await hour(2, 800, [['Abigail', 'Gus']], { Abigail: 2, Gus: 2 });
  await hour(2, 900, [['Gus', 'Pam']], { Gus: 2, Pam: 2 });
  assert.equal(prompts.length, 0, 'news spreads in code first: Gus first-hand, Pam second-hand');
  await hour(2, 1000, [['Gus', 'Sebastian']], { Gus: 6, Sebastian: 2 });
  assert.equal(known(0), `- 格斯：阿比盖尔说过："${SHARE}"\n- 塞巴斯蒂安：${SAW_DANCE}`);
  await hour(2, 1100, [['Pam', 'Abigail']], { Pam: 6, Abigail: 2 });
  assert.equal(known(1), `- 阿比盖尔：${SHARE}\n- 阿比盖尔：${DANCED}`, 'second-hand news stops; private notes never come');
  assert.ok(prompts.every(prompt => !prompt.includes('秘密基地') && !prompt.includes('跟我说')));

  commit = await sleep(wire, 'saved-day-2', 2, commit.commitId);
  await hour(3, 1000, [['Gus', 'Sebastian']], { Gus: 6, Sebastian: 2 });
  assert.equal(known(2), `- 塞巴斯蒂安：${SAW_DANCE}`, 'yesterday’s scene and its news are not told again');
  for (let day = 3; day <= 8; day++) commit = await sleep(wire, `saved-day-${day}`, day, commit.commitId);
  await hour(9, 1000, [['Gus', 'Sebastian']], { Gus: 6, Sebastian: 2 });
  assert.equal(known(3), '（没有）', 'the festival is more than a week old');
});
