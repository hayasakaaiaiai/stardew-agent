/** Paid probes of the actual nightly consolidation path; every attempt, including failures, is preserved. */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nightlyConsolidator } from '../src/agent/nightly.ts';
import { approachHearts } from '../src/agent/approach.ts';
import { ModelClient, modelConfigFromEnv, type ChatMessage, type ChatModel, type Completion } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS, type ConsolidationInput, type RecallResult } from '../src/types.ts';

const root = resolve(import.meta.dirname, '..');
const farmOnly = process.argv.includes('--farm');
const mineOnly = process.argv.includes('--mine');
if (farmOnly && mineOnly) throw new Error('Choose either --farm or --mine.');
const args = process.argv.slice(2).filter(arg => arg !== '--farm' && arg !== '--mine');
const replay = args[0] === '--replay' ? args[1] : undefined;
if (args.length && (!replay || args.length !== 2)) throw new Error('Usage: node tools/test-actions-content.ts [--farm|--mine] [--replay <calls.jsonl>]');
const recordings = replay ? (await readFile(resolve(replay), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Completion & { messages: ChatMessage[] }) : undefined;
if (!recordings) process.loadEnvFile(join(root, '.env'));
const output = join(root, '.runtime', (farmOnly ? 'farm' : mineOnly ? 'mine' : 'actions') + '-content-' + (replay ? 'replay-' : '') + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output);
const roster = new Roster({ directory: join(root, 'data/npcs'), npcIds: SOCIAL_NPCS }); await roster.load();
const client = recordings ? undefined : new ModelClient({ ...modelConfigFromEnv(), thinking: 'high' });
let calls = 0;
const model: ChatModel = { async chat(messages, handlers, options) {
  const recorded = recordings?.[calls];
  if (recordings && (!recorded || JSON.stringify(recorded.messages) !== JSON.stringify(messages))) throw new Error('录制样本的 prompt 与当前请求不一致。');
  const completion = recorded ?? await client!.chat(messages, handlers, options); calls++;
  await appendFile(join(output, 'calls.jsonl'), JSON.stringify({ messages, ...completion, thinking: 'high', real: !recordings }) + '\n');
  return completion;
} };
const ordinaryFixtures = [
  { id: 'beach-afternoon', npc: 'abigail', player: '明天下午一起去海边钓鱼吧？', reply: '好啊，那就明天下午海边见。', meet: { time: 1400, place: '海滩' } },
  { id: 'pub-evening', npc: 'shane', player: '明晚在星之果实餐吧见面？', reply: '行，明晚餐吧见。', meet: { time: 1900, place: '星之果实餐吧' } },
  { id: 'museum-three', npc: 'penny', player: '明天下午三点在博物馆等我。', reply: '好，明天下午三点博物馆见。', meet: { time: 1500, place: '博物馆' } },
  { id: 'npc-invites', npc: 'abigail', player: '好啊，明天早上墓地见，我确定参加。', reply: '嗯，那我们明早墓地见。', meet: { time: 900, place: '墓地' } },
  { id: 'refused', npc: 'haley', player: '明天下午我不去海边了，别等我。', reply: '好吧，那就不约了。', meet: null, noApproach: true },
  { id: 'undecided', npc: 'sam', player: '明天下午海边见这件事，我还没决定，想想再说。', reply: '行，那等你决定了再约。', meet: null },
  { id: 'day-after-tomorrow', npc: 'abigail', player: '后天下午海边见？', reply: '好啊，后天下午海边见。', meet: null },
  { id: 'no-time', npc: 'penny', player: '明天一起去博物馆吧，几点还没想好。', reply: '好，时间定了再告诉我。', meet: null },
  { id: 'unsupported-place', npc: 'leah', player: '明天下午两点在我家见面吧？', reply: '好，明天下午两点你家见。', meet: null },
  { id: 'own-plan', npc: 'willy', player: '明天下午你要做什么？', reply: '我明天下午自己去海边修船，不用来找我。', meet: null, noApproach: true },
] as const;
const farmFixtures = [
  { id: 'farm-water-morning', npc: 'abigail', player: '明天上午来农场帮我浇浇水好吗？', reply: '好啊，明天上午我去农场帮你浇水。', meet: { time: 1000, place: '农场' } },
  { id: 'farm-harvest-field', npc: 'leah', player: '明天上午来田里帮我收成熟的作物吧？', reply: '没问题，明天上午我来帮忙。', meet: { time: 1000, place: '农场' } },
  { id: 'farm-visit-afternoon', npc: 'penny', player: '明天下午来农场看看鸡，我们在门口见。', reply: '好，明天下午我来农场。', meet: { time: 1400, place: '农场' } },
  { id: 'farm-refused', npc: 'haley', player: '明天上午来农场帮忙好吗？', reply: '不行，我明天不来农场。', meet: null },
  { id: 'farm-conditional', npc: 'sam', player: '如果明天上午有空，你来农场帮我浇水吧。', reply: '还不确定，到时候再说。', meet: null },
  { id: 'farm-no-time', npc: 'leah', player: '明天来农场帮我收作物吧，几点还没想好。', reply: '好，时间定了再告诉我。', meet: null },
] as const;
const mineFixtures = [
  { id: 'mine-morning', npc: 'abigail', player: '明天上午一起下矿吧？', reply: '好啊，明天上午矿洞门口见。', meet: { time: 1000, place: '矿洞' } },
  { id: 'mine-exact-time', npc: 'sebastian', player: '明天下午两点在矿洞门口等我，一起下矿。', reply: '好，明天下午两点矿洞门口见。', meet: { time: 1400, place: '矿洞' } },
  { id: 'skull-companion', npc: 'kent', player: '明天上午陪我去沙漠的骷髅洞穴吧？', reply: '行，明天上午我陪你，骷髅洞穴门口见。', meet: { time: 1000, place: '骷髅洞穴' } },
  { id: 'volcano-companion', npc: 'abigail', player: '明天中午去姜岛的火山探险？', reply: '好啊，明天中午火山口见。', meet: { time: 1200, place: '火山' } },
  { id: 'mine-no-time', npc: 'haley', player: '明天一起去矿洞吧，几点还没定。', reply: '好，时间定了再告诉我。', meet: null },
  { id: 'mine-refused', npc: 'emily', player: '明天上午一起下矿吧？', reply: '不行，我明天不去矿洞。', meet: null },
  { id: 'mine-day-after', npc: 'sam', player: '后天上午一起下矿吧？', reply: '好啊，后天上午矿洞见。', meet: null },
  { id: 'mine-own-plan', npc: 'sebastian', player: '明天上午你去干什么？', reply: '我自己去矿洞，别来找我。', meet: null, noApproach: true },
] as const;
const fixtures = farmOnly ? farmFixtures : mineOnly ? mineFixtures : ordinaryFixtures;
const results = [];
for (const repeat of [1, 2]) for (const fixture of fixtures) {
  const input: ConsolidationInput = { commit: { id: `probe-${fixture.id}-${repeat}`, lineageId: 'probe', parentId: 'root', dayEnded: 1, status: 'confirmed' },
    completed: false, npcs: [{ npcId: fixture.npc, state: {}, memories: [], logs: [{ seq: 1, gameTime: 1 * 1440 + 800, changes: [{ npcId: fixture.npc,
      log: { player: fixture.player, npc: fixture.reply, standing: { hearts: 6, relation: 'friend' }, playerInfo: { name: '小林', gender: 'female' } } }] }] }] };
  let result: Record<string, unknown>;
  try {
    const changes = await nightlyConsolidator({ roster, model })(input, new AbortController().signal);
    const change = changes.find(change => change.npcId === fixture.npc)!;
    const memories = (change.memories ?? []).map((memory, index) => ({ id: `m${index}`, commitId: input.commit.id, npcId: fixture.npc, gameTime: 1 * 1440 + 1439,
      text: memory.text, kind: memory.kind ?? 'conversation', importance: memory.importance, subjects: memory.subjects ?? [], topics: [], visibility: 'private', sourceId: 'probe', score: 1 } as RecallResult));
    const hearts = approachHearts({ state: change.state ?? {}, memories, today: [] }, 2);
    const passed = JSON.stringify(change.state?.meet ?? null) === JSON.stringify(fixture.meet)
      && (!('noApproach' in fixture) || hearts === undefined);
    result = { id: fixture.id, repeat, passed, expected: fixture.meet, state: change.state, hearts, memories };
  } catch (error) { result = { id: fixture.id, repeat, passed: false, error: String(error) }; }
  results.push(result); await appendFile(join(output, 'results.jsonl'), JSON.stringify(result) + '\n');
  console.log(JSON.stringify(result));
}
const passed = results.filter(row => row.passed).length;
await writeFile(join(output, 'result.json'), JSON.stringify({ output, passed, total: results.length, calls, realCalls: recordings ? 0 : calls, replay, results }, null, 2));
console.log(JSON.stringify({ output, passed, total: results.length, calls, realCalls: recordings ? 0 : calls }));
if (passed !== results.length) process.exitCode = 1;
