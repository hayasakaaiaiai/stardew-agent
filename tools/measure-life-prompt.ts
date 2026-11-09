import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMessages, type PromptInput } from '../src/agent/dialogue.ts';
import { lifeChanges, lifeContext, type LifeEvent } from '../src/agent/life.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS, type NpcState } from '../src/types.ts';

// Pass a separately installed gpt-tokenizer@3.4.0 o200k_base.js; no project dependency or model call.
const [tokenizerPath, outputPath] = process.argv.slice(2);
assert.ok(tokenizerPath && outputPath, 'Usage: node tools/measure-life-prompt.ts /path/to/o200k_base.js output.json');
const { encode } = await import(pathToFileURL(resolve(tokenizerPath)).href) as { encode: (text: string) => number[] };
const roster = new Roster({ directory: resolve(import.meta.dirname, '../data/npcs'), npcIds: SOCIAL_NPCS });
assert.equal((await roster.load()).errors.length, 0);
const standing = { hearts: 8, relation: 'friend' as const, seenEvents: new Set<string>() };
const baseline: PromptInput = {
  npcName: '莉亚', card: roster.render('leah', { ...standing, purpose: 'dialogue' }), standing,
  world: { year: 1, season: 'spring', day: 2, time: '12:00', weather: '晴', location: '森林',
    player: { name: '小林', gender: 'female', farm: '星露' }, facts: {} },
  memory: { summary: '农场主喜欢散步，说话温和。', memories: [] }, history: [], playerLine: '今天过得怎么样？',
};
const tokens = (input: PromptInput) => buildMessages(input).reduce((n, message) => n + encode(message.content).length, 0);
const baseTokens = tokens(baseline);
const goal = 'leah-driftwood-v1';
const accept: LifeEvent = { id: 'life-1', npc: 'leah', day: 1, kind: 'goal.accepted', goal };
const deliver: LifeEvent = { id: 'life-2', npc: 'leah', day: 1, kind: 'goal.delivered', goal, item: '浮木', count: 3 };
const walk: LifeEvent = { id: 'life-3', npc: 'leah', day: 1, kind: 'activity.completed', activity: 'forest_walk', minutes: 30, goal };
const complete: LifeEvent = { id: 'life-4', npc: 'leah', day: 1, kind: 'goal.completed', goal, activity: 'forest_walk', minutes: 30 };
const missed: LifeEvent = { id: 'life-5', npc: 'leah', day: 1, kind: 'activity.missed', minutes: 0 };
const apology: LifeEvent = { id: 'life-6', npc: 'leah', day: 2, kind: 'relationship.apology', sourceId: missed.id };
const repaired: LifeEvent = { id: 'life-7', npc: 'leah', day: 2, kind: 'activity.completed', activity: 'forest_walk', minutes: 30 };
const cases: { name: string; events: LifeEvent[]; day?: number }[] = [
  { name: '没有生活记录', events: [] }, { name: '已接取', events: [accept] },
  { name: '已交料', events: [accept, deliver] }, { name: '已完成', events: [accept, deliver, walk, complete] },
  { name: '仅材料结局', events: [accept, deliver, { id: 'life-4', npc: 'leah', day: 1, kind: 'goal.closed', goal }] },
  { name: '失约', events: [missed] }, { name: '道歉待行动', events: [missed, apology] },
  { name: '实际行动修复', events: [missed, apology, repaired] },
  { name: '未完成目标过三日', events: [accept, deliver], day: 10 },
  { name: '完成后过三日', events: [accept, deliver, walk, complete], day: 10 },
];
const samples = cases.map(sample => {
  // JSON mirrors the actual wire's omission of optional undefined fields.
  const changes = lifeChanges(JSON.parse(JSON.stringify(sample.events)) as LifeEvent[], {});
  const state: NpcState = changes.find(change => change.npcId === 'leah')?.state ?? {};
  const cue = lifeContext(state, sample.day ?? 2);
  const input = { ...baseline, memory: { ...baseline.memory,
    summary: [baseline.memory.summary, cue].filter(Boolean).join('\n') } };
  return { name: sample.name, day: sample.day ?? 2, cue: cue ?? '', cueTokens: cue ? encode(cue).length : 0,
    totalTokens: tokens(input), addedTokens: tokens(input) - baseTokens };
});
const live = '森林散步；有效同行 20 游戏分钟，实际完成计数 0；活动仍在进行，尚未结算，不推断作品或整条目标已完成。';
const liveTokens = tokens({ ...baseline, world: { ...baseline.world, facts: { 当前共同活动: live } } });
await writeFile(outputPath, JSON.stringify({
  measuredOn: '2026-11-09', tokenizer: 'gpt-tokenizer@3.4.0 / o200k_base', modelCalls: 0,
  method: 'Actual lifeContext and buildMessages; sum message content tokens. Same 8-heart Leah card, existing impression and empty retrieval/history. Excludes provider framing, retrieval growth and output. Approximation for DeepSeek, not its billing count.',
  baselineTokens: baseTokens, samples,
  liveActivity: { text: live, totalTokens: liveTokens, addedTokens: liveTokens - baseTokens },
}, null, 2) + '\n');
console.log(JSON.stringify({ baselineTokens: baseTokens, samples: samples.map(({ name, addedTokens }) => ({ name, addedTokens })),
  liveActivityAdded: liveTokens - baseTokens }, null, 2));
