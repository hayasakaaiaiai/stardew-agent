import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMessages, type PromptInput } from '../src/agent/dialogue.ts';
import { STORY_DEFINITIONS, storyChanges, storyContext, type StoryEvent } from '../src/agent/town-stories.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS, type NpcState } from '../src/types.ts';

// The tokenizer stays outside the project; this measurement makes no model requests.
const [tokenizerPath, outputPath] = process.argv.slice(2);
assert.ok(tokenizerPath && outputPath, 'Usage: node tools/measure-town-stories-prompt.ts /path/to/o200k_base.js output.json');
const resolvedTokenizer = resolve(tokenizerPath);
const { encode } = await import(pathToFileURL(resolvedTokenizer).href) as { encode: (text: string) => number[] };
const tokenizerPackage = JSON.parse(await readFile(resolve(dirname(resolvedTokenizer), '../../package.json'), 'utf8')) as { name: string; version: string };
assert.equal(tokenizerPackage.name, 'gpt-tokenizer');
const root = resolve(import.meta.dirname, '..');
const roster = new Roster({ directory: resolve(root, 'data/npcs'), npcIds: SOCIAL_NPCS });
const loaded = await roster.load();
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.loaded.length, 34);
const impression = '农场主愿意认真听我说话。';

function baseline(npc: string, day: number): PromptInput {
  const standing = { hearts: 2, relation: 'friend' as const, seenEvents: new Set<string>() };
  return {
    npcName: roster.get(npc).name, card: roster.render(npc, { ...standing, purpose: 'dialogue' }), standing,
    world: { year: 1, season: 'spring', day, time: '14:30', weather: '晴', location: '镇上',
      player: { name: '小林', gender: 'female', farm: '星露' }, facts: {} },
    memory: { summary: impression, memories: [] }, history: [], playerLine: '最近在忙些什么？',
  };
}
function withSummary(input: PromptInput, ...parts: string[]): PromptInput {
  return { ...input, memory: { ...input.memory, summary: [impression, ...parts].filter(Boolean).join('\n') } };
}
const tokens = (input: PromptInput): number => buildMessages(input).reduce((sum, message) => sum + encode(message.content).length, 0);

const started: StoryEvent = { id: 'life-1', npc: 'gus', day: 1, kind: 'story.started', storyId: 'gus_parcel' };
const emily: StoryEvent = { id: 'life-2', npc: 'gus', day: 1, kind: 'story.clue', storyId: 'gus_parcel', clueId: 'emily_mark', other: 'emily' };
const pierre: StoryEvent = { id: 'life-3', npc: 'gus', day: 1, kind: 'story.clue', storyId: 'gus_parcel', clueId: 'pierre_mark', other: 'pierre' };
const found: StoryEvent = { id: 'life-4', npc: 'gus', day: 1, kind: 'story.clue', storyId: 'gus_parcel', clueId: 'parcel' };
const investigation = [started, emily, pierre, found];
const told: StoryEvent = { id: 'life-5', npc: 'gus', day: 1, kind: 'story.told', storyId: 'gus_parcel', sourceId: found.id };
const explained: StoryEvent = { id: 'life-5', npc: 'gus', day: 1, kind: 'story.resolved', storyId: 'gus_parcel', outcome: 'explained' };
const returned: StoryEvent = { ...explained, outcome: 'returned' };

function project(npc: 'penny' | 'elliott', choiceId: string): StoryEvent[] {
  const storyId = npc === 'penny' ? 'penny_field_notes' : 'elliott_short_piece';
  const venue = npc === 'penny' ? 'Forest' : 'Beach';
  const workVenue = npc === 'penny' ? 'ArchaeologyHouse' : 'ElliottHouse';
  return [
    { id: 'life-1', npc, storyId, day: 1, kind: 'story.started' },
    { id: 'life-2', npc, storyId, day: 1, kind: 'story.observed', venue, weather: 'rain', minutes: 10 },
    { id: 'life-3', npc, storyId, day: 1, kind: 'story.choice', choiceId, sourceId: 'life-2' },
    { id: 'life-4', npc, storyId, day: 2, kind: 'story.worked', step: 1, venue: workVenue, minutes: 30 },
    { id: 'life-5', npc, storyId, day: 3, kind: 'story.worked', step: 2, venue: workVenue, minutes: 30 },
    { id: 'life-6', npc, storyId, day: 3, kind: 'story.resolved', outcome: choiceId },
  ];
}
function independent(npc: 'penny' | 'elliott'): StoryEvent[] {
  const source = project(npc, npc === 'penny' ? 'observe' : 'open');
  return [source[0]!, { ...source[3]!, id: 'life-2' }, { ...source[4]!, id: 'life-3' },
    { ...source[5]!, id: 'life-4', outcome: 'independent' }];
}
const penny = project('penny', 'observe');
const cases: { name: string; npc: string; day: number; events: StoryEvent[] }[] = [
  { name: '格斯尚未开始调查', npc: 'gus', day: 1, events: [] },
  { name: '格斯已提出调查', npc: 'gus', day: 1, events: [started] },
  { name: '问过艾米丽但尚未告诉格斯', npc: 'gus', day: 1, events: [started, emily] },
  { name: '艾米丽仅知道自己给出的证词', npc: 'emily', day: 1, events: investigation },
  { name: '皮埃尔仅知道自己给出的证词', npc: 'pierre', day: 1, events: investigation },
  { name: '全部线索及包裹尚未汇报给格斯', npc: 'gus', day: 1, events: investigation },
  { name: '当面告诉格斯包裹线索', npc: 'gus', day: 1, events: [...investigation, told] },
  { name: '直接归还而未解释两份证词', npc: 'gus', day: 1, events: [...investigation, returned] },
  { name: '核清标记后归还', npc: 'gus', day: 1, events: [...investigation, explained] },
  { name: '调查结束也不自动告诉艾米丽', npc: 'emily', day: 1, events: [...investigation, explained] },
  { name: '潘妮已提出准备观察题', npc: 'penny', day: 1, events: penny.slice(0, 1) },
  { name: '玩家实地观察但尚未告诉潘妮', npc: 'penny', day: 1, events: penny.slice(0, 2) },
  { name: '潘妮收到真实观察和明确建议', npc: 'penny', day: 1, events: penny.slice(0, 3) },
  { name: '潘妮完成首日实际工作', npc: 'penny', day: 2, events: penny.slice(0, 4) },
  { name: '潘妮完成两日工作但结局尚未记录', npc: 'penny', day: 3, events: penny.slice(0, 5) },
  { name: '潘妮独立完成基础练习页', npc: 'penny', day: 3, events: independent('penny') },
  { name: '潘妮完成先观察版练习页', npc: 'penny', day: 3, events: penny },
  { name: '潘妮完成先阅读版练习页', npc: 'penny', day: 3, events: project('penny', 'read') },
  { name: '艾利欧特独立完成练笔', npc: 'elliott', day: 3, events: independent('elliott') },
  { name: '艾利欧特完成留白版短文', npc: 'elliott', day: 3, events: project('elliott', 'open') },
  { name: '艾利欧特完成明朗版短文', npc: 'elliott', day: 3, events: project('elliott', 'bright') },
];

const definitionsJson = JSON.stringify({ version: 1, stories: STORY_DEFINITIONS });
const residentDefinitions = `## 全部故事资料（仅成本对照，不能用于正式提示）\n${definitionsJson}`;
const samples = cases.map(sample => {
  const people = [...new Set([sample.npc, ...sample.events.flatMap(event => [event.npc, ...(event.other ? [event.other] : [])])])];
  const prior: Record<string, NpcState> = Object.fromEntries(people.map(npc => [npc, { impression }]));
  const changes = storyChanges(sample.events, prior);
  const state = changes.find(change => change.npcId === sample.npc)?.state ?? prior[sample.npc]!;
  assert.equal(state.impression, impression);
  const cue = storyContext(state, sample.day) ?? '';
  const input = baseline(sample.npc, sample.day);
  const baselineTokens = tokens(input), totalTokens = tokens(withSummary(input, cue));
  const residentTotalTokens = tokens(withSummary(input, cue, residentDefinitions));
  return { name: sample.name, npc: sample.npc, day: sample.day, events: sample.events, cue,
    cueTokens: encode(cue).length, baselineTokens, totalTokens, addedTokens: totalTokens - baselineTokens,
    residentDefinitionsComparison: { totalTokens: residentTotalTokens, addedOverCurrentSummary: residentTotalTokens - totalTokens } };
});

// Unshared evidence must have zero prompt effect on the owner, even though the journal contains it.
assert.equal(samples[1]!.cue, samples[2]!.cue);
assert.equal(samples[1]!.cue, samples[5]!.cue);
assert.equal(samples[3]!.cue, samples[9]!.cue);
assert.equal(samples[10]!.cue, samples[11]!.cue);
const sourcePaths = ['src/agent/town-stories.ts', 'src/agent/dialogue.ts', 'data/town/stories.json',
  ...['gus', 'emily', 'pierre', 'penny', 'elliott'].map(npc => `data/npcs/${npc}.md`)];
const sourceSha256 = Object.fromEntries(await Promise.all(sourcePaths.map(async file =>
  [file, createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')])));
const result = {
  measuredOn: '2026-11-09', tokenizer: `${tokenizerPackage.name}@${tokenizerPackage.version} / o200k_base`, modelCalls: 0,
  method: '直接调用生产 storyChanges、storyContext 与 buildMessages，累计各 message.content 的 o200k token。加载全部34张卡，固定2心朋友、未看心事件、旧印象、当例春季源日14:30镇上；检索与对话历史为空。不含供应商消息封装、后续检索增长与输出，是DeepSeek分词近似，不是账单。',
  baselineMethod: '每例使用相同NPC、当前关系、日期和场景，没有故事摘要的实际prompt作基线；不同NPC的卡片成本不混算为功能增量。',
  definitionsComparisonMethod: '仅作输入成本对照：保留实际摘要，再额外放入三故事完整JSON。正式实现禁止常驻该配置，因为其中含未发现证词和未完成成品；此对照不作为可部署替代方案。',
  loadedCards: loaded.loaded.length, loadedNpcIds: loaded.loaded, sourceSha256,
  definitionsJsonTokens: encode(definitionsJson).length, samples,
};
await writeFile(resolve(outputPath), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ definitionsJsonTokens: result.definitionsJsonTokens,
  samples: samples.map(({ name, npc, baselineTokens, addedTokens, residentDefinitionsComparison }) =>
    ({ name, npc, baselineTokens, addedTokens, residentDefinitionsExtra: residentDefinitionsComparison.addedOverCurrentSummary })) }, null, 2));
