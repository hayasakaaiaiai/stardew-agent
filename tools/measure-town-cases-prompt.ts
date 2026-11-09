import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMessages, type PromptInput } from '../src/agent/dialogue.ts';
import { TOWN_CASE_DEFINITIONS, type TownCaseDefinition } from '../src/agent/town-cases.ts';
import { storyChanges, storyContext, type StoryEvent } from '../src/agent/town-stories.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS, type NpcState } from '../src/types.ts';
import { caseHistory, reportCaseSource } from '../tests/helpers/town-cases.ts';

// The tokenizer remains outside the repository; this tool never calls a model.
const [tokenizerPath, outputPath] = process.argv.slice(2);
assert.ok(tokenizerPath && outputPath, 'Usage: node tools/measure-town-cases-prompt.ts /path/to/o200k_base.js output.json');
const resolvedTokenizer = resolve(tokenizerPath);
const { encode } = await import(pathToFileURL(resolvedTokenizer).href) as { encode: (text: string) => number[] };
const tokenizerPackage = JSON.parse(await readFile(resolve(dirname(resolvedTokenizer), '../../package.json'), 'utf8')) as { name: string; version: string };
assert.equal(tokenizerPackage.name, 'gpt-tokenizer');
const root = resolve(import.meta.dirname, '..');
const roster = new Roster({ directory: resolve(root, 'data/npcs'), npcIds: SOCIAL_NPCS });
const loaded = await roster.load(); assert.deepEqual(loaded.errors, []); assert.equal(loaded.loaded.length, 34);
const impression = '农场主愿意认真听我说话。';
interface Sample { name: string; npc: string; day: number; events: StoryEvent[]; definitions: readonly TownCaseDefinition[]; prior?: StoryEvent[]; zero?: true }
const cases: Sample[] = [];
for (const definition of TOWN_CASE_DEFINITIONS) {
  const history = caseHistory(definition.id), day = history.at(-1)!.day;
  const base = { npc: definition.owner, definitions: [definition], day };
  cases.push({ ...base, name: `${definition.owner} 尚未开案`, events: [], zero: true },
    { ...base, name: `${definition.owner} 刚开案`, events: history.slice(0, 1) },
    { ...base, name: `${definition.owner} 四份来源均未汇报`, events: history.slice(0, 5) });
  for (let index = 1; index <= 4; index++) cases.push({ ...base, name: `${definition.owner} 单独汇报来源 ${index}`,
    events: [...history.slice(0, 5), reportCaseSource(history, index, 6, day)] });
  cases.push({ ...base, name: `${definition.owner} 四份来源逐一汇报`, events: [...history.slice(0, 5),
    ...[1, 2, 3, 4].map((index, i) => reportCaseSource(history, index, 6 + i, day))] });
  for (const outcome of ['a', 'b'] as const) cases.push({ ...base, name: `${definition.owner} 结案 ${outcome}`, events: caseHistory(definition.id, outcome) });
  for (const clue of definition.clues) cases.push({ ...base, name: `${clue.witness} 只知自己证词`, npc: clue.witness, events: history });
  cases.push({ ...base, name: `${definition.owner} 结案不告知威利`, npc: 'willy', events: history, zero: true });
}
cases.push({ name: '乔迪同时知道两案自己的证词', npc: 'jodi', day: 10,
  definitions: [TOWN_CASE_DEFINITIONS[0]!, TOWN_CASE_DEFINITIONS[3]!],
  events: [...caseHistory(), ...caseHistory('marnie_two_contexts', 'a', 10)] });
const prior: StoryEvent[] = [
  { id: 'life-1', npc: 'gus', day: 9, kind: 'story.started', storyId: 'gus_parcel' },
  { id: 'life-2', npc: 'gus', day: 9, kind: 'story.clue', storyId: 'gus_parcel', clueId: 'pierre_mark', other: 'pierre' },
];
cases.push({ name: '皮埃尔保留旧包裹证词并新增路线证词', npc: 'pierre', day: 10,
  definitions: [TOWN_CASE_DEFINITIONS[0]!], prior, events: [...prior, ...caseHistory('caroline_route_notes', 'a', 10)] });
function stateFor(events: StoryEvent[], npc: string): NpcState {
  return storyChanges(events, {}).find(change => change.npcId === npc)?.state ?? {};
}
function baseline(npc: string, day: number, summary: string): PromptInput {
  const standing = { hearts: 2, relation: 'friend' as const, seenEvents: new Set<string>() };
  return { npcName: roster.get(npc).name, card: roster.render(npc, { ...standing, purpose: 'dialogue' }), standing,
    world: { year: 1, season: 'spring', day, time: '14:30', weather: '晴', location: '镇上',
      player: { name: '小林', gender: 'female', farm: '星露' }, facts: {} },
    memory: { summary, memories: [] }, history: [], playerLine: '镇上的那件事，现在怎么样了？' };
}
const tokens = (input: PromptInput): number => buildMessages(input).reduce((sum, message) => sum + encode(message.content).length, 0);
const combine = (summary?: string) => [impression, summary].filter(Boolean).join('\n');
function fullText(definitions: readonly TownCaseDefinition[]): string {
  return '## 完整案件资料（仅成本对照，含未选内容，不用于生产）\n' + definitions.map(definition =>
    [definition.title, definition.opening, ...definition.clues.map(clue => `${clue.label}：${clue.text}`),
      ...definition.inspections.map(point => `${point.label}：${point.hint}`),
      ...definition.endings.map(ending => `${ending.label}／${ending.title}：${ending.text}`)].join('\n')).join('\n');
}
const samples = cases.map(sample => {
  const beforeSummary = storyContext(stateFor(sample.prior ?? [], sample.npc), sample.day);
  const summary = storyContext(stateFor(sample.events, sample.npc), sample.day) ?? '';
  const before = tokens(baseline(sample.npc, sample.day, combine(beforeSummary)));
  const after = tokens(baseline(sample.npc, sample.day, combine(summary)));
  const full = summary ? tokens(baseline(sample.npc, sample.day, combine(summary) + '\n' + fullText(sample.definitions))) : after;
  if (sample.zero) assert.equal(after - before, 0, sample.name);
  return { name: sample.name, npc: sample.npc, day: sample.day, priorTokens: before, productionTokens: after,
    addedTokens: after - before, withFullTextTokens: full, fullTextExtraTokens: full - after, summary };
});
for (const definition of TOWN_CASE_DEFINITIONS) assert.equal(samples.find(s => s.name === `${definition.owner} 刚开案`)!.summary,
  samples.find(s => s.name === `${definition.owner} 四份来源均未汇报`)!.summary);
const files = ['src/agent/town-cases.ts', 'src/agent/town-stories.ts', 'src/agent/life-journal.ts', 'src/agent/dialogue.ts',
  'src/bridge/memory.ts', 'data/town/cases.json', 'tests/helpers/town-cases.ts',
  'tools/measure-town-cases-prompt.ts', ...SOCIAL_NPCS.map(npc => `data/npcs/${npc}.md`)];
const hashes: Record<string, string> = {};
for (const path of files) hashes[path] = createHash('sha256').update(await readFile(resolve(root, path))).digest('hex');
const nonzero = samples.filter(sample => sample.addedTokens !== 0);
const report = { format: 1, date: '2026-11-09', tokenizer: { name: tokenizerPackage.name, version: tokenizerPackage.version,
  encoding: 'o200k_base', approximation: 'DeepSeek token成本的本地近似；未调用真实模型' }, cardsLoaded: loaded.loaded.length,
  scope: '实际buildMessages内容分词差值；不含API封装、输出、历史和检索增长。旧案共存样本以已含旧证词的prompt为基线。完整资料仅成本反例，含未选结案，不能用于生产。',
  sampleCount: samples.length, addedTokens: { zeroCases: samples.length - nonzero.length,
    min: Math.min(...nonzero.map(sample => sample.addedTokens)), max: Math.max(...nonzero.map(sample => sample.addedTokens)) },
  fullTextExtraTokens: { min: Math.min(...nonzero.map(sample => sample.fullTextExtraTokens)), max: Math.max(...nonzero.map(sample => sample.fullTextExtraTokens)) },
  hashes, samples };
await writeFile(resolve(outputPath), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ sampleCount: report.sampleCount, cardsLoaded: report.cardsLoaded, addedTokens: report.addedTokens,
  fullTextExtraTokens: report.fullTextExtraTokens, sourceHashes: Object.keys(hashes).length }, null, 2));
