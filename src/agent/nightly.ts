/** Nightly consolidation: the model side of `consolidateCommit`, and when it runs (docs/nightly-consolidation.md). */
import { consolidateCommit, type Consolidator } from './consolidation.ts';
import { daysAgo, type PlayerIdentity } from './dialogue-memory.ts';
import { type Exchange, RELATIONS, SEASONS, type Season, type Standing } from './dialogue.ts';
import { rankMemories } from './memory.ts';
import type { ChatMessage, ModelClient, Thinking } from '../services/model/client.ts';
import type { Roster } from '../services/roster/index.ts';
import type { StoreService } from '../services/store/index.ts';
import type { ConsolidationInput, Memory, NpcChange, NpcState } from '../types.ts';

/** Measured in docs/nightly-consolidation.md §6.2: `disabled` got a fact backwards, `high` was no better. */
export const NIGHTLY_THINKING: Thinking = 'low';

/** The same for every NPC, so the second NPC of a night hits the cached prefix. */
export const NIGHTLY_RULES = `# 睡前回想

你是《星露谷物语》里鹈鹕镇的一位居民。今天结束了，你在睡前回想今天和农场主的来往，整理成以后会记得的事。下面给出你是谁、今天的对话、今天当场记下的事和以前的记忆。

## 要做的
- memories：把今天和农场主的来往压成 1–2 条记忆。它们会替换“今天当场记下的”，所以那里值得记住的都要写进去。用你自己的视角写，每条不超过 60 字，写清楚谁说了什么、约了什么、你的感受。importance 取 1 到 5，按其中最重要的那件事定。
- retire：“以前的记忆”里，和今天的记忆重复、或者被今天的新情况推翻的，写出编号；没有就写 []。
- impression：你对农场主的整体印象，不超过 80 字。只写态度和感受，不写具体的事。在旧印象上改，今天没有新变化就原样写回。
- plan：你明天想做的事、想对农场主说的事，不超过 60 字。不排时间表，但和别人约好的事照写。
- 只写对话里真的出现过的事，不编造；农场主没说过的不要替农场主说。

## 输出格式
只输出一个 JSON 对象，例如：
{"memories":[{"text":"……","importance":3}],"retire":["m3"],"impression":"……","plan":"……"}`;

export const NIGHTLY_HINT = '（用 json 回复，字段齐全：memories、retire、impression、plan）';

const MAX_EXCHANGES = 40;
const OLD_MEMORIES = 10;
const MAX_ATTEMPTS = 2;
const SEASON_ORDER: Season[] = ['spring', 'summer', 'fall', 'winter'];

/** What a dialogue turn writes to the day log (src/agent/dialogue-memory.ts, src/bridge/memory.ts). */
export interface LoggedTurn extends Exchange {
  standing?: Pick<Standing, 'hearts' | 'relation'>;
  playerInfo?: PlayerIdentity;
}

export interface NightlyOutput {
  memories: { text: string; importance: number }[];
  retire: string[];
  impression: string;
  plan: string;
}

/** Undefined when the shape is unusable; over-long text is clipped rather than rejected. */
export function parseNightly(content: string): NightlyOutput | undefined {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end < start) return undefined;
  let data: unknown;
  try { data = JSON.parse(content.slice(start, end + 1)); } catch { return undefined; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const { memories, retire, impression, plan } = data as Record<string, unknown>;
  if (!Array.isArray(memories) || typeof impression !== 'string') return undefined;
  return {
    memories: memories.flatMap((item): NightlyOutput['memories'] => {
      const { text, importance } = (item ?? {}) as Record<string, unknown>;
      if (typeof text !== 'string' || !text.trim()) return [];
      const valid = Number.isInteger(importance) && (importance as number) >= 1 && (importance as number) <= 5;
      return [{ text: clip(text, 80), importance: valid ? importance as number : 3 }];
    }).slice(0, 2),
    retire: Array.isArray(retire) ? retire.filter((id): id is string => typeof id === 'string') : [],
    impression: clip(impression, 120),
    plan: typeof plan === 'string' ? clip(plan, 100) : '',
  };
}

function clip(text: string, max: number): string {
  return Array.from(text.trim()).slice(0, max).join('');
}

type NpcInput = ConsolidationInput['npcs'][number];

/** One NPC's prompt, plus what its output refers to: today's notes and the numbered older memories. */
export function nightlyPrompt(roster: Roster, commit: ConsolidationInput['commit'], npc: NpcInput) {
  const card = roster.get(npc.npcId);
  const turns = npc.logs.flatMap((entry): LoggedTurn[] => {
    const log = entry.changes.find((change) => change.npcId === npc.npcId)?.log;
    return log && typeof log.player === 'string' && typeof log.npc === 'string' ? [log as unknown as LoggedTurn] : [];
  });
  const standing = turns.findLast((turn) => turn.standing)?.standing;
  const player = turns.findLast((turn) => turn.playerInfo)?.playerInfo;
  const now = commit.dayEnded * 1440 + 1439;
  const today = npc.memories.filter((memory) => memory.commitId === commit.id);
  const older = npc.memories.filter((memory) => memory.commitId !== commit.id);
  // Search with what was said today; recent memories fill whatever the search leaves.
  const query = [...today.map((memory) => memory.text), ...turns.map((turn) => turn.player)].join(' ').slice(0, 2000);
  const shown: Memory[] = query.trim() ? rankMemories(older, { query, nowGameTime: now, limit: OLD_MEMORIES, maxChars: 100_000 }) : [];
  for (const memory of [...older].sort((a, b) => b.gameTime - a.gameTime)) {
    if (shown.length >= OLD_MEMORIES) break;
    if (!shown.some((item) => item.id === memory.id)) shown.push(memory);
  }
  shown.sort((a, b) => a.gameTime - b.gameTime);
  const impression = typeof npc.state.impression === 'string' && npc.state.impression ? npc.state.impression : '';

  const user = [
    `## 你是谁\n- ${card.name}，${firstSentence(card.identity)}`,
    ['## 今天', `- ${dateLabel(commit.dayEnded)}`,
      ...(player ? [`- 农场主：${player.name}（${player.gender === 'female' ? '女' : '男'}）`] : []),
      `- 你对农场主的好感：${standing ? `${standing.hearts} 心；关系：${RELATIONS[standing.relation]}` : '未知'}`].join('\n'),
    `## 你以前对农场主的印象\n${impression || '还没有'}`,
    // Stage directions such as OPENING_LINE are not something the player said.
    `## 今天的对话\n${turns.slice(-MAX_EXCHANGES).flatMap((turn) => [
      ...(/^（.*）$/.test(turn.player) ? [] : [`- 农场主：${turn.player}`]), `- 你：${turn.npc}`]).join('\n')}`,
    `## 今天当场记下的\n${today.length ? today.map((memory) => `- （重要度 ${memory.importance}）${memory.text}`).join('\n') : '（没有）'}`,
    `## 以前的记忆\n${shown.length ? shown.map((memory, i) =>
      `- m${i + 1}（${daysAgo(now, memory.gameTime)}，重要度 ${memory.importance}）${memory.text}`).join('\n') : '（没有）'}`,
    NIGHTLY_HINT,
  ].join('\n\n');
  const messages: ChatMessage[] = [{ role: 'system', content: NIGHTLY_RULES }, { role: 'user', content: user }];
  return { messages, today, shown, impression, hasTurns: turns.length > 0 };
}

function firstSentence(text: string): string {
  const end = text.indexOf('。');
  return end < 0 ? clip(text, 80) : text.slice(0, end + 1);
}

function dateLabel(day: number): string {
  const index = day - 1;
  return `第 ${Math.floor(index / 112) + 1} 年${SEASONS[SEASON_ORDER[Math.floor(index / 28) % 4]!]} ${(index % 28) + 1} 日`;
}

/** Network errors propagate, so the whole commit is retried later; a bad answer only leaves this NPC unchanged. */
export function nightlyConsolidator(deps: { roster: Roster; model: ModelClient; log?: (line: string) => void }): Consolidator {
  return async (input, signal) => {
    const npc = input.npcs[0]!;
    const prompt = nightlyPrompt(deps.roster, input.commit, npc);
    if (!prompt.hasTurns) return [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const completion = await deps.model.chat(prompt.messages, {}, { json: true, signal });
      const output = parseNightly(completion.content);
      const usage = completion.usage ? `，输入 ${completion.usage.inputTokens}，输出 ${completion.usage.outputTokens}` : '';
      if (output) {
        deps.log?.(`${npc.npcId} 整合完成${usage}`);
        return [change(npc, prompt, output, input.commit.dayEnded)];
      }
      deps.log?.(`${npc.npcId} 的整合输出无法解析（第 ${attempt} 次）`);
    }
    return [];
  };
}

function change(npc: NpcInput, prompt: ReturnType<typeof nightlyPrompt>, output: NightlyOutput, day: number): NpcChange {
  // Model-facing numbers map back to real ids here; unknown numbers are ignored.
  const retired = output.retire.flatMap((alias) => {
    const memory = /^m(\d+)$/.exec(alias) ? prompt.shown[Number(alias.slice(1)) - 1] : undefined;
    return memory ? [memory.id] : [];
  });
  // Today's notes are only replaced when there is something to replace them with.
  const replaced = output.memories.length ? prompt.today.map((memory) => memory.id) : [];
  const impression = output.impression || prompt.impression;
  const state: NpcState = { ...npc.state, ...(impression ? { impression } : {}), plan: output.plan, day };
  return {
    npcId: npc.npcId, state,
    memories: output.memories.map((memory) => ({
      text: memory.text, importance: memory.importance, kind: 'summary', subjects: ['player'], visibility: 'private',
    })),
    retireMemoryIds: [...new Set([...replaced, ...retired])],
  };
}

/** How many confirmed commits back from the loaded one are checked for a missed consolidation. */
const CATCH_UP = 3;

/**
 * Runs consolidations one at a time in the background. Results only depend on a saved commit, so a reload or
 * return to title never cancels them; closing does, and the next load catches up (docs/nightly-consolidation.md §4).
 */
export class Nightly {
  private readonly store: StoreService;
  private readonly consolidator: Consolidator;
  private readonly npcIds: readonly string[];
  private readonly log: (line: string) => void;
  private readonly stop = new AbortController();
  private readonly queued = new Map<string, Promise<void>>();
  private chain: Promise<void> = Promise.resolve();

  constructor(options: { store: StoreService; consolidator: Consolidator; npcIds: readonly string[]; log?: (line: string) => void }) {
    this.store = options.store;
    this.consolidator = options.consolidator;
    this.npcIds = options.npcIds;
    this.log = options.log ?? (() => {});
  }

  /** Never rejects: a failure is logged and the commit is picked up again by `catchUp`. */
  run(lineageId: string, commitId: string): Promise<void> {
    const key = `${lineageId}\n${commitId}`;
    const existing = this.queued.get(key);
    if (existing) return existing;
    const result = this.chain.then(() => this.consolidate(lineageId, commitId));
    this.queued.set(key, result);
    this.chain = result;
    void result.then(() => this.queued.delete(key));
    return result;
  }

  /** Oldest first, so each night sees the previous night's results. */
  async catchUp(lineageId: string, headId: string): Promise<void> {
    const ids: string[] = [];
    try {
      let commit = await this.store.call('getCommit', { lineageId, commitId: headId });
      while (commit && commit.parentId !== null && ids.length < CATCH_UP) {
        if (commit.status === 'confirmed') ids.unshift(commit.id);
        commit = await this.store.call('getCommit', { lineageId, commitId: commit.parentId });
      }
    } catch (error) {
      this.log(`整合补跑检查失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await Promise.all(ids.map((id) => this.run(lineageId, id)));
  }

  async close(): Promise<void> {
    this.stop.abort('Backend stopping');
    await this.chain;
  }

  private async consolidate(lineageId: string, commitId: string): Promise<void> {
    if (this.stop.signal.aborted) return;
    const started = performance.now();
    let npcs = 0;
    let day = 0;
    const counted: Consolidator = (input, signal) => {
      npcs += 1; day = input.commit.dayEnded;
      return this.consolidator(input, signal);
    };
    try {
      await consolidateCommit(this.store, { lineageId, commitId, npcIds: [...this.npcIds] }, counted, this.stop.signal);
      // A commit that was already consolidated, or had nobody to consolidate, makes no model call and no noise.
      if (npcs) this.log(`夜间整合完成：第 ${day} 天，${npcs} 位 NPC，用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒`);
    } catch (error) {
      if (!this.stop.signal.aborted) this.log(`夜间整合失败，下次读档再试：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
