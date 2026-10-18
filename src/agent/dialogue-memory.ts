import type { NpcAgent } from './npc.ts';
import type { DialogueMemory, Exchange, MemoryContext, Remembered, Standing } from './dialogue.ts';
import type { RecallResult } from '../types.ts';

export interface AgentMemoryOptions {
  /** Absolute game minutes, including the game day (see README). */
  now: () => number;
  /** Next `seq` for this game load, shared by every NPC. */
  nextSeq: () => number;
  /** Character budget for recalled memories; the store default (4000) is sized for consolidation. */
  maxChars?: number;
  /** How many of today's exchanges go back into the prompt; older ones rely on recall. */
  historyTurns?: number;
}

/** How much an NPC remembers about the player at a given standing (docs/dialogue-prototype.md §14). */
export interface RecallPolicy {
  limit: number;
  minImportance: number;
  /** Older memories are out of reach; null means no limit. */
  maxDays: number | null;
  tone?: string;
}

const CLOSE = new Set<Standing['relation']>(['dating', 'engaged', 'married', 'roommate']);
const VAGUE = '你和玩家还不熟，这些只是模糊的印象；提起时用“好像”“记不太清”这类说法';
const VIVID = '你很在乎玩家，这些都记得很清楚，合适时可以主动提起';

/** Read-time only: nothing is dropped from storage, so rising hearts bring old memories back. */
export function recallPolicy(standing: Pick<Standing, 'hearts' | 'relation'>): RecallPolicy {
  if (standing.hearts >= 8 || CLOSE.has(standing.relation)) return { limit: 6, minImportance: 1, maxDays: null, tone: VIVID };
  if (standing.hearts >= 5) return { limit: 5, minImportance: 2, maxDays: 28 };
  if (standing.hearts >= 2) return { limit: 3, minImportance: 3, maxDays: 7 };
  return { limit: 2, minImportance: 4, maxDays: 3, tone: VAGUE };
}

/** Candidates fetched before the standing filter, so it still has enough to choose from. */
const RELEVANT_CANDIDATES = 20;
const RECENT_CANDIDATES = 10;
/** Recent memories always get some slots, since relevance recall returns nothing when no words match. */
const RECENT_SLOTS = 3;

/**
 * Backs dialogue with the memory system: recall before the call, one recorded event after it.
 * Takes a lookup rather than a handle, because NPC handles are replaced on every new day and every reload.
 */
export class AgentMemory implements DialogueMemory {
  private readonly agent: () => NpcAgent;
  private readonly options: Required<AgentMemoryOptions>;

  constructor(agent: () => NpcAgent, options: AgentMemoryOptions) {
    this.agent = agent;
    this.options = { maxChars: 600, historyTurns: 10, ...options };
  }

  async context(query: string, standing: Standing): Promise<MemoryContext> {
    const { maxChars, historyTurns } = this.options;
    const policy = recallPolicy(standing);
    const nowGameTime = this.options.now();
    const agent = this.agent();
    const [relevant, recent] = await Promise.all([
      agent.context({ query, nowGameTime, limit: RELEVANT_CANDIDATES, maxChars: 4000 }),
      agent.context({ nowGameTime, limit: RECENT_CANDIDATES, maxChars: 4000 }),
    ]);
    const reachable = (memory: RecallResult) => memory.importance >= policy.minImportance
      && (policy.maxDays === null || dayOf(nowGameTime) - dayOf(memory.gameTime) <= policy.maxDays);
    const relevantOk = relevant.memories.filter(reachable);
    const recentOk = recent.memories.filter(reachable);
    const recentSlots = Math.min(RECENT_SLOTS, Math.ceil(policy.limit / 2));
    const head = policy.limit - recentSlots;
    const picked: RecallResult[] = [];
    let chars = 0;
    for (const memory of [...relevantOk.slice(0, head), ...recentOk, ...relevantOk.slice(head)]) {
      const length = Array.from(memory.text).length;
      if (picked.length === policy.limit || picked.some((p) => p.id === memory.id) || chars + length > maxChars) continue;
      picked.push(memory);
      chars += length;
    }
    picked.sort((a, b) => a.gameTime - b.gameTime);
    // Today's conversation is never filtered: what was just said is always remembered.
    const today = relevant.today.flatMap((entry): Exchange[] => {
      const log = entry.changes[0]?.log;
      return log && typeof log.player === 'string' && typeof log.npc === 'string' ? [{ player: log.player, npc: log.npc }] : [];
    });
    return {
      memories: picked.map((memory) => ({ text: memory.text, when: daysAgo(nowGameTime, memory.gameTime) })),
      today: today.slice(-historyTurns),
      ...(policy.tone ? { tone: policy.tone } : {}),
    };
  }

  async record(exchange: Exchange, remembered: Remembered[]): Promise<void> {
    await this.agent().record({
      seq: this.options.nextSeq(),
      gameTime: this.options.now(),
      log: { player: exchange.player, npc: exchange.npc },
      memories: remembered.map((item) => ({
        text: item.text, importance: item.importance, kind: 'conversation', subjects: ['player'], visibility: 'private',
      })),
    });
  }
}

function dayOf(gameTime: number): number {
  return Math.floor(gameTime / 1440);
}

export function daysAgo(now: number, then: number): string {
  const days = dayOf(now) - dayOf(then);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}
