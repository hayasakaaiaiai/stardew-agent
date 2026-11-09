import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMessages, type PromptInput } from '../src/agent/dialogue.ts';
import { goalResultContext, GOAL_RESULT_DEFINITIONS, type GoalResultDefinition, type GoalResultEvent } from '../src/agent/goal-results.ts';
import { lifeJournalChanges, type LifeJournalEvent } from '../src/agent/life-journal.ts';
import { longGoalContext } from '../src/agent/long-goals.ts';
import { storyContext } from '../src/agent/town-stories.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS, type NpcState } from '../src/types.ts';
import { completedPractice, completedProject, reviewPractice } from '../tests/helpers/project-practice.ts';

// Use an external local tokenizer; no model request or runtime dependency is involved.
const [tokenizerPath, outputPath] = process.argv.slice(2);
assert.ok(tokenizerPath && outputPath, 'Usage: node tools/measure-goal-results-prompt.ts /path/to/o200k_base.js output.json');
const resolvedTokenizer = resolve(tokenizerPath);
const { encode } = await import(pathToFileURL(resolvedTokenizer).href) as { encode: (text: string) => number[] };
const tokenizerPackage = JSON.parse(await readFile(resolve(dirname(resolvedTokenizer), '../../package.json'), 'utf8')) as { name: string; version: string };
assert.equal(tokenizerPackage.name, 'gpt-tokenizer');
const root = resolve(import.meta.dirname, '..');
const roster = new Roster({ directory: resolve(root, 'data/npcs'), npcIds: SOCIAL_NPCS });
const loaded = await roster.load(); assert.deepEqual(loaded.errors, []); assert.equal(loaded.loaded.length, 34);
const impression = '农场主愿意认真听我说话。';
interface Sample { name: string; definition: GoalResultDefinition; events: LifeJournalEvent[]; day: number; npc?: string }
const cases: Sample[] = [];
for (const definition of GOAL_RESULT_DEFINITIONS) {
  const project = completedProject(definition.projectId), practice = completedPractice(definition.projectId);
  const base = { definition, day: 10 };
  cases.push({ ...base, name: `${definition.owner} 无项目`, events: [] },
    { ...base, name: `${definition.owner} 合册完成尚未实践`, events: project },
    { ...base, name: `${definition.owner} 合册提醒`, events: [...project, { id: 'life-20', npc: definition.owner,
      projectId: definition.projectId, day: 10, kind: 'goalresult.notified', chapterId: 3, sourceId: 'life-19' }] });
  for (let index = 0; index < practice.length; index++) cases.push({ ...base, name: `${definition.owner} ${practice[index]!.kind} ${index}`,
    events: [...project, ...practice.slice(0, index + 1)] });
  for (const choice of ['a', 'b'] as const) {
    const route = completedPractice(definition.projectId, choice);
    cases.push({ ...base, name: `${definition.owner} 回访 ${choice}`, day: 11, events: [...project, ...route, reviewPractice(route, choice)] });
  }
  const cancel: GoalResultEvent = { id: 'life-22', day: 10, npc: definition.owner, projectId: definition.projectId,
    kind: 'goalresult.cancelled', attemptId: 'life-20', reason: 'player' };
  const cancelled = [...project, ...practice.slice(0, 2), cancel];
  cases.push({ ...base, name: `${definition.owner} 中途取消`, events: cancelled },
    { ...base, name: `${definition.owner} 取消后重试`, events: [...cancelled, completedPractice(definition.projectId, 'b', 10, 23)[0]!] },
    { ...base, name: `${definition.owner} 完成不会告诉格斯`, events: [...project, ...practice], npc: 'gus' });
}

function baseline(npc: string, day: number, summary: string): PromptInput {
  const standing = { hearts: 8, relation: 'friend' as const, seenEvents: new Set<string>() };
  return { npcName: roster.get(npc).name, card: roster.render(npc, { ...standing, purpose: 'dialogue' }), standing,
    world: { year: 1, season: 'spring', day, time: '14:30', weather: '晴', location: '镇上',
      player: { name: '小林', gender: 'female', farm: '星露' }, facts: {} },
    memory: { summary, memories: [] }, history: [], playerLine: '上次的成果还能一起试试吗？' };
}
const tokens = (input: PromptInput): number => buildMessages(input).reduce((sum, message) => sum + encode(message.content).length, 0);
function rules(definition: GoalResultDefinition): string {
  return `## 成果实践完整说明（成本对照）\n${definition.title}：${definition.opening}\n目的地：${definition.venueLabel}；需要 ${definition.minutes} 分钟。\n`
    + definition.planChoices.map(choice => `${choice.label}：${choice.text}`).join('\n') + '\n'
    + definition.checkpoints.map(point => `${point.title}：${point.prompt}\n${point.choices.map(choice => `${choice.label}：${choice.text}`).join('\n')}`).join('\n') + '\n'
    + definition.finishChoices.map(choice => `${choice.label}：${choice.text}`).join('\n') + '\n'
    + definition.reviewChoices.map(choice => `${choice.label}：${choice.text}`).join('\n');
}
const samples = cases.map(sample => {
  const states: Record<string, NpcState> = {};
  for (const change of lifeJournalChanges(sample.events, {})) states[change.npcId] = change.state!;
  const npc = sample.npc ?? sample.definition.owner, state = states[npc] ?? {};
  const prior = [impression, storyContext(state, sample.day), longGoalContext(state, sample.day)].filter(Boolean).join('\n');
  const added = goalResultContext(state, sample.day) ?? '';
  const before = tokens(baseline(npc, sample.day, prior));
  const after = tokens(baseline(npc, sample.day, [prior, added].filter(Boolean).join('\n')));
  const full = added ? tokens(baseline(npc, sample.day, [prior, added, rules(sample.definition)].join('\n'))) : after;
  if (sample.npc || !sample.events.length) assert.equal(after - before, 0, sample.name);
  return { name: sample.name, npc, day: sample.day, priorTokens: before, productionTokens: after, addedTokens: after - before,
    withFullRulesTokens: full, fullRulesExtraTokens: full - after, summary: added };
});
const files = ['src/agent/goal-results.ts', 'src/agent/long-goals.ts', 'src/agent/town-stories.ts', 'src/agent/life-journal.ts',
  'src/agent/dialogue.ts', 'src/agent/dialogue-prompt.ts', 'src/bridge/memory.ts', 'data/town/goal-results.json',
  'tests/helpers/project-practice.ts', 'tools/measure-goal-results-prompt.ts'];
const hashes: Record<string, string> = {};
for (const path of files) {
  try { hashes[path] = createHash('sha256').update(await readFile(resolve(root, path))).digest('hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
for (const npc of SOCIAL_NPCS) {
  const path = `data/npcs/${npc}.md`;
  hashes[path] = createHash('sha256').update(await readFile(resolve(root, path))).digest('hex');
}
const nonzero = samples.filter(sample => sample.addedTokens !== 0);
const report = { format: 1, date: '2026-11-09', tokenizer: { name: tokenizerPackage.name, version: tokenizerPackage.version,
  encoding: 'o200k_base', approximation: 'DeepSeek token成本的本地近似；未调用真实模型' }, cardsLoaded: loaded.loaded.length,
  scope: '实际 buildMessages 内容字符分词的新增摘要差值；不含 API 封装、输出、历史及检索记忆增长。全规则对照额外附带菜单内容，不是实用配置。',
  sampleCount: samples.length, addedTokens: { zeroCases: samples.length - nonzero.length,
    min: Math.min(...nonzero.map(sample => sample.addedTokens)), max: Math.max(...nonzero.map(sample => sample.addedTokens)) },
  fullRulesExtraTokens: { min: Math.min(...nonzero.map(sample => sample.fullRulesExtraTokens)), max: Math.max(...nonzero.map(sample => sample.fullRulesExtraTokens)) },
  hashes, samples };
await writeFile(resolve(outputPath), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ sampleCount: report.sampleCount, cardsLoaded: report.cardsLoaded, addedTokens: report.addedTokens,
  fullRulesExtraTokens: report.fullRulesExtraTokens, sourceHashes: Object.keys(hashes).length }, null, 2));
