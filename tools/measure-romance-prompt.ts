import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMessages, type PromptInput } from '../src/agent/dialogue.ts';
import { ROMANCE_PROFILES, romanceChanges, romanceContext, type RomanceEvent } from '../src/agent/romance.ts';
import { Roster, type Relation } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS, type NpcState } from '../src/types.ts';

// Use an externally installed tokenizer; this probe has no project dependency or model calls.
const [tokenizerPath, outputPath] = process.argv.slice(2);
assert.ok(tokenizerPath && outputPath, 'Usage: node tools/measure-romance-prompt.ts /path/to/o200k_base.js output.json');
const resolvedTokenizer = resolve(tokenizerPath);
const { encode } = await import(pathToFileURL(resolvedTokenizer).href) as { encode: (text: string) => number[] };
const tokenizerPackage = JSON.parse(await readFile(resolve(dirname(resolvedTokenizer), '../../package.json'), 'utf8')) as { name: string; version: string };
assert.equal(tokenizerPackage.name, 'gpt-tokenizer');
const root = resolve(import.meta.dirname, '..');
const roster = new Roster({ directory: resolve(root, 'data/npcs'), npcIds: SOCIAL_NPCS });
const loaded = await roster.load();
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.loaded.length, 34);

const impression = '农场主喜欢散步，说话温和。';
function baseline(relation: Relation): PromptInput {
  const standing = { hearts: 8, relation, seenEvents: new Set<string>() };
  return {
    npcName: '莉亚', card: roster.render('leah', { ...standing, purpose: 'dialogue' }), standing,
    world: { year: 1, season: 'spring', day: 2, time: '14:30', weather: '晴', location: '海滩',
      player: { name: '小林', gender: 'female', farm: '星露' }, facts: {} },
    memory: { summary: impression, memories: [] }, history: [], playerLine: '今天过得怎么样？',
  };
}
const tokens = (input: PromptInput): number => buildMessages(input).reduce((total, message) => total + encode(message.content).length, 0);
function withSummary(input: PromptInput, ...parts: string[]): PromptInput {
  return { ...input, memory: { ...input.memory, summary: [impression, ...parts].filter(Boolean).join('\n') } };
}

const planned: RomanceEvent = { id: 'life-1', npc: 'leah', day: 1, kind: 'romance.planned', dateId: 'date-1',
  dateDay: 2, time: 1700, venue: 'Forest', preparation: 'quiet', relation: 'dating', initiator: 'player' };
const rescheduled: RomanceEvent = { id: 'life-2', npc: 'leah', day: 1, kind: 'romance.rescheduled', dateId: 'date-1',
  dateDay: 2, time: 1400, venue: 'Beach', preparation: 'talk', relation: 'dating', initiator: 'player' };
const started: RomanceEvent = { id: 'life-3', npc: 'leah', day: 2, kind: 'romance.started', dateId: 'date-1',
  time: 1400, venue: 'Beach', relation: 'dating' };
const completed: RomanceEvent = { id: 'life-4', npc: 'leah', day: 2, kind: 'romance.completed', dateId: 'date-1',
  venue: 'Beach', relation: 'dating', weather: 'sunny', minutes: 30, friendship: 0 };
const remembered: RomanceEvent = { id: 'life-5', npc: 'leah', day: 2, kind: 'romance.remembered', dateId: 'date-1',
  sourceId: 'life-4', detail: 'company' };
const revisit: RomanceEvent = { id: 'life-6', npc: 'leah', day: 2, kind: 'romance.planned', dateId: 'date-6',
  dateDay: 3, time: 1400, venue: 'Beach', preparation: 'quiet', relation: 'dating', initiator: 'npc', sourceId: 'life-4' };
const done = [planned, rescheduled, started, completed];
const cases: { name: string; events: RomanceEvent[]; relation: Relation }[] = [
  { name: '没有约会记录', events: [], relation: 'dating' },
  { name: '已确认计划', events: [planned], relation: 'dating' },
  { name: '已改约时间与地点', events: [planned, rescheduled], relation: 'dating' },
  { name: '已出发未完成', events: [planned, rescheduled, started], relation: 'dating' },
  { name: '实际完成约会', events: done, relation: 'dating' },
  { name: '已选择共同回忆', events: [...done, remembered], relation: 'dating' },
  { name: '旧约会但当前是朋友', events: [...done, remembered], relation: 'friend' },
  { name: '旧约会但当前是室友', events: [...done, remembered], relation: 'roommate' },
  { name: '已确认重访计划', events: [...done, remembered, revisit], relation: 'dating' },
  { name: '仅旧计划但当前是朋友', events: [planned], relation: 'friend' },
  { name: '仅旧计划但当前是室友', events: [planned], relation: 'roommate' },
  { name: '旧计划已过期未确认完成', events: [{ ...planned, dateDay: 1 }], relation: 'dating' },
];

// Keep the actual cue when adding all profiles, so this comparison does not remove live facts.
const profilesJson = JSON.stringify(ROMANCE_PROFILES);
const residentProfiles = `## 全部约会资料（仅成本对照）\n${profilesJson}`;
const samples = cases.map(sample => {
  const prior = { leah: { impression } };
  const changes = romanceChanges(sample.events, prior);
  const state: NpcState = changes.find(change => change.npcId === 'leah')?.state ?? prior.leah;
  assert.equal(state.impression, impression);
  const cue = romanceContext(state, 2, sample.relation) ?? '';
  const input = baseline(sample.relation);
  const baselineTokens = tokens(input);
  const totalTokens = tokens(withSummary(input, cue));
  const residentTotalTokens = tokens(withSummary(input, cue, residentProfiles));
  return {
    name: sample.name, day: 2, relation: sample.relation, events: sample.events,
    cue, cueTokens: encode(cue).length, baselineTokens, totalTokens, addedTokens: totalTokens - baselineTokens,
    residentProfilesComparison: { totalTokens: residentTotalTokens, addedOverCurrentSummary: residentTotalTokens - totalTokens },
  };
});

const sourcePaths = ['src/agent/romance.ts', 'src/agent/dialogue.ts', 'data/npcs/leah.md', 'data/romance/profiles.json'];
const sourceSha256 = Object.fromEntries(await Promise.all(sourcePaths.map(async file =>
  [file, createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')])));
const result = {
  measuredOn: '2026-11-09', tokenizer: `${tokenizerPackage.name}@${tokenizerPackage.version} / o200k_base`, modelCalls: 0,
  method: '实际调用 romanceChanges、romanceContext 与 buildMessages，累计每条 message.content 的 o200k token。加载全部 34 张卡后，固定莉亚 8 心、无已看事件、旧印象、春 2 日 14:30 海滩；除历史关系用例外均为 dating。检索与对话历史为空，排除供应商消息封装、后续检索增长与输出；这是 DeepSeek 的近似成本，不是账单 token。',
  baselineMethod: '每例增量以相同当前关系、相同角色卡和场景、没有恋爱摘要的 prompt 为基线；friend 与 roommate 各自重渲染角色卡，避免把关系切换成本误归入恋爱摘要。',
  profilesComparisonMethod: '仅作成本对照：在同一实际摘要之后额外放入整份 12 人 profiles 紧凑 JSON，保留其引用字段。正式实现不常驻此资料；比较不把完整 profiles 当成能代替真实事件摘要的方案。',
  loadedCards: loaded.loaded.length, loadedNpcIds: loaded.loaded, sourceSha256,
  baselineTokens: tokens(baseline('dating')), profileJsonTokens: encode(profilesJson).length, samples,
};
await writeFile(resolve(outputPath), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ baselineTokens: result.baselineTokens, profileJsonTokens: result.profileJsonTokens,
  samples: samples.map(({ name, addedTokens, residentProfilesComparison }) => ({ name, addedTokens,
    residentProfilesExtra: residentProfilesComparison.addedOverCurrentSummary })) }, null, 2));
