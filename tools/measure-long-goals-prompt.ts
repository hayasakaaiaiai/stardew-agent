import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMessages, type PromptInput } from '../src/agent/dialogue.ts';
import { LONG_GOAL_DEFINITIONS, longGoalChanges, longGoalContext, type LongGoalDefinition, type LongGoalEvent } from '../src/agent/long-goals.ts';
import { storyChanges, type StoryEvent, type StoryId } from '../src/agent/town-stories.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS, type NpcState } from '../src/types.ts';

// The external tokenizer is used locally; this script never requests model inference.
const [tokenizerPath, outputPath] = process.argv.slice(2);
assert.ok(tokenizerPath && outputPath, 'Usage: node tools/measure-long-goals-prompt.ts /path/to/o200k_base.js output.json');
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
type Mode = 'default' | 'a' | 'b' | 'contributed';

function priorFor(goal: LongGoalDefinition): Record<string, NpcState> {
  const prior: Record<string, NpcState> = { [goal.owner]: { impression } };
  if (!goal.requiresStory) return prior;
  const base = { npc: goal.owner, storyId: goal.requiresStory as StoryId };
  const workVenue = goal.owner === 'penny' ? 'Town' : 'Beach';
  const story: StoryEvent[] = [
    { ...base, id: 'life-1', day: 1, kind: 'story.started' },
    { ...base, id: 'life-2', day: 2, kind: 'story.worked', step: 1, venue: workVenue, minutes: 30 },
    { ...base, id: 'life-3', day: 3, kind: 'story.worked', step: 2, venue: workVenue, minutes: 30 },
    { ...base, id: 'life-4', day: 3, kind: 'story.resolved', outcome: 'independent' },
  ];
  return { ...prior, ...Object.fromEntries(storyChanges(story, prior).map(change => [change.npcId, change.state!])) };
}

function scenario(goal: LongGoalDefinition, modes: readonly Mode[]): LongGoalEvent[] {
  let serial = 10;
  const base = { npc: goal.owner, longGoalId: goal.id };
  const events: LongGoalEvent[] = [{ ...base, id: `life-${serial++}`, day: 10, kind: 'longgoal.started',
    ...(goal.requiresStory ? { dependencySourceId: 'life-4' } : {}) }];
  for (const chapter of goal.chapters) {
    const opened = 10 + (chapter.id - 1) * 2;
    const contributionDay = chapter.id === 1 ? opened : opened + 1;
    const mode = modes[chapter.id - 1]!, contribution = chapter.contribution;
    const event = (kind: LongGoalEvent['kind'], day: number, fields: Partial<LongGoalEvent>): LongGoalEvent =>
      ({ ...base, id: `life-${serial++}`, chapterId: chapter.id, day, kind, ...fields });
    if (mode !== 'default') {
      let sourceId: string | undefined;
      if (contribution.kind === 'observation') {
        const observation = event('longgoal.observed', contributionDay, { contributionId: contribution.id,
          venue: contribution.venues[0]!.map, weather: 'rain', minutes: 10 });
        sourceId = observation.id; events.push(observation);
      }
      const receipt = event('longgoal.contributed', contributionDay, contribution.kind === 'material'
        ? { contributionId: contribution.id, itemId: contribution.itemId, count: contribution.count }
        : { contributionId: contribution.id, sourceId: sourceId! });
      events.push(receipt);
      if (mode !== 'contributed') events.push(event('longgoal.choice', contributionDay, { choiceId: mode, sourceId: receipt.id }));
    }
    events.push(event('longgoal.worked', opened + 1, { step: 1, venue: goal.workVenues[0]!, minutes: 30 }),
      event('longgoal.worked', opened + 2, { step: 2, venue: goal.workVenues[0]!, minutes: 30 }),
      event('longgoal.completed', opened + 2, { outcome: mode === 'contributed' ? 'default' : mode }));
  }
  return events;
}

function baseline(npc: string, day: number): PromptInput {
  const standing = { hearts: 2, relation: 'friend' as const, seenEvents: new Set<string>() };
  return { npcName: roster.get(npc).name, card: roster.render(npc, { ...standing, purpose: 'dialogue' }), standing,
    world: { year: 1, season: 'spring', day, time: '14:30', weather: '晴', location: '镇上',
      player: { name: '小林', gender: 'female', farm: '星露' }, facts: {} },
    memory: { summary: impression, memories: [] }, history: [], playerLine: '最近的长期打算进展怎样？' };
}
function withSummary(input: PromptInput, ...parts: string[]): PromptInput {
  return { ...input, memory: { ...input.memory, summary: [impression, ...parts].filter(Boolean).join('\n') } };
}
const tokens = (input: PromptInput): number => buildMessages(input).reduce((sum, message) => sum + encode(message.content).length, 0);

// The comparison adds only previously completed, owner-known chapter summaries, never future content.
function retainedChapters(goal: LongGoalDefinition, events: readonly LongGoalEvent[]): string {
  const completed = events.filter(event => event.kind === 'longgoal.completed');
  const allDone = completed.length === 3;
  const rows = completed.map(result => {
    const chapter = goal.chapters[result.chapterId! - 1]!;
    const output = chapter.outputs.find(output => output.id === result.outcome)!;
    const relevant = events.filter(event => event.chapterId === chapter.id);
    const work = relevant.filter(event => event.kind === 'longgoal.worked').map(event => event.day);
    const choice = relevant.find(event => event.kind === 'longgoal.choice');
    const receipt = relevant.find(event => event.kind === 'longgoal.contributed');
    const parts = [`第 ${chapter.id} 章“${chapter.title}”已在第 ${work.join('、')} 天各工作 30 分钟，形成“${output.title}”`,
      choice ? `采用农场主方案“${chapter.choices.find(item => item.id === choice.choiceId)!.label}”` : '方向由我自行决定'];
    // The final production cue already contains all three receipts; avoid counting them twice.
    if (!allDone) {
      if (!receipt) parts.push('本章未收到农场主贡献');
      else if (chapter.contribution.kind === 'material') parts.push(`收到 ${chapter.contribution.count} 份${chapter.contribution.label}`);
      else {
        const source = relevant.find(event => event.id === receipt.sourceId)!;
        parts.push(`农场主汇报第 ${source.day} 天在${chapter.contribution.venues[0]!.label}雨天观察 ${source.minutes} 分钟，并非我亲历`);
      }
    }
    return parts.join('；') + '。';
  });
  return rows.length ? `## 已完成章节摘要（成本对照）\n${rows.join('\n')}` : '';
}

interface Sample { name: string; goal: LongGoalDefinition; events: LongGoalEvent[]; npc?: string }
const cases: Sample[] = [];
for (const goal of LONG_GOAL_DEFINITIONS) {
  const allA = scenario(goal, ['a', 'a', 'a']);
  cases.push({ name: `${goal.owner} 尚未开始`, goal, events: [] },
    { name: `${goal.owner} 刚开启第一章`, goal, events: allA.slice(0, 1) });
  for (const mode of ['default', 'a', 'b', 'contributed'] as const)
    cases.push({ name: `${goal.owner} 三章完成：${mode}`, goal, events: scenario(goal, [mode, mode, mode]) });
}
for (const owner of ['penny', 'leah']) {
  const goal = LONG_GOAL_DEFINITIONS.find(goal => goal.owner === owner)!;
  const path = scenario(goal, ['a', 'b', 'contributed']);
  for (const [index, event] of path.entries()) {
    if (event.kind === 'longgoal.started' || index === path.length - 1) continue;
    cases.push({ name: `${owner} 进行中：第${event.chapterId}章 ${event.kind}${event.step ? ` ${event.step}` : ''}`,
      goal, events: path.slice(0, index + 1) });
  }
}
const leah = LONG_GOAL_DEFINITIONS.find(goal => goal.owner === 'leah')!;
cases.push({ name: '莉亚完成的项目不会自动告诉格斯', goal: leah, npc: 'gus', events: scenario(leah, ['a', 'b', 'default']) });

const samples = cases.map(sample => {
  const npc = sample.npc ?? sample.goal.owner;
  const day = sample.events.at(-1)?.day ?? 10;
  const prior = priorFor(sample.goal);
  prior[npc] ??= { impression };
  const changes = longGoalChanges(sample.events, prior);
  const state = changes.find(change => change.npcId === npc)?.state ?? prior[npc]!;
  assert.equal(state.impression, impression);
  const cue = longGoalContext(state, day) ?? '';
  const archive = npc === sample.goal.owner ? retainedChapters(sample.goal, sample.events) : '';
  const input = baseline(npc, day);
  const baselineTokens = tokens(input), totalTokens = tokens(withSummary(input, cue));
  const retainedTotal = tokens(withSummary(input, cue, archive));
  return { name: sample.name, npc, day, events: sample.events, cue, cueTokens: encode(cue).length,
    baselineTokens, totalTokens, addedTokens: totalTokens - baselineTokens,
    retainedChaptersComparison: { archive, totalTokens: retainedTotal, addedOverCurrent: retainedTotal - totalTokens } };
});
for (const owner of ['penny', 'leah']) {
  const started = samples.find(sample => sample.name === `${owner} 刚开启第一章`)!;
  const unshared = samples.find(sample => sample.name === `${owner} 进行中：第1章 longgoal.observed`)!;
  assert.equal(started.cue, unshared.cue);
  assert.equal(started.totalTokens, unshared.totalTokens);
}
assert.equal(samples.at(-1)!.addedTokens, 0);
const sourcePaths = ['src/agent/long-goals.ts', 'src/agent/town-stories.ts', 'src/agent/dialogue.ts', 'data/town/long-goals.json',
  'tools/measure-long-goals-prompt.ts', ...LONG_GOAL_DEFINITIONS.map(goal => `data/npcs/${goal.owner}.md`)];
const sourceSha256 = Object.fromEntries(await Promise.all(sourcePaths.map(async file =>
  [file, createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')])));
const result = {
  measuredOn: '2026-11-09', tokenizer: `${tokenizerPackage.name}@${tokenizerPackage.version} / o200k_base`, modelCalls: 0,
  method: '直接调用生产 longGoalChanges、longGoalContext、buildMessages；潘妮和艾利欧特以前置 storyChanges 产生的真实状态启动。累计 message.content token，固定2心朋友、未看心事件、当例春季源日14:30镇上、同一句旧印象、空检索与历史。o200k是DeepSeek分词近似，不含API封装和输出。',
  baselineMethod: '同NPC、同日、同关系与场景，不含新长线摘要。前置故事仅用于严格投影验证；本轮增量不重复计入既有故事摘要。',
  comparisonMethod: '方案A为实际生产当前章摘要，全部完成时为合册标题与真实贡献概要。方案B保留A，再附已经完成的各章标题、真实结果、所选方向及工作日期；进行中还保留旧章已汇报的贡献，完结时不重复A已有的贡献。只使用已知事件，不泄露未来章或未选正文。两者信息量不同，不声称语义等价。',
  recommendation: '采用方案A，仅保留当前章与完成数量，完结保留合册及贡献；63篇全文仅在原生回看保存。模型无法凭摘要逐字重述作品。既有检索可能召回新记忆，其额外成本未包括在摘要增量中。',
  loadedCards: loaded.loaded.length, loadedNpcIds: loaded.loaded, sourceSha256, samples,
  totals: { sampleCount: samples.length, minAddedTokens: Math.min(...samples.map(sample => sample.addedTokens)),
    maxAddedTokens: Math.max(...samples.map(sample => sample.addedTokens)),
    maxRetainedExtraTokens: Math.max(...samples.map(sample => sample.retainedChaptersComparison.addedOverCurrent)) },
};
await writeFile(resolve(outputPath), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result.totals, finalCases: samples.filter(sample => sample.name.includes('三章完成')).map(sample =>
  ({ name: sample.name, addedTokens: sample.addedTokens, retainedExtra: sample.retainedChaptersComparison.addedOverCurrent })) }, null, 2));
