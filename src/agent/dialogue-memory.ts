import type { NpcAgent } from './npc.ts';
import type { DialogueMemory, Exchange, MemoryContext, Remembered } from './dialogue.ts';
import type { RecallResult } from '../types.ts';

export interface AgentMemoryOptions {
  /** Absolute game minutes, including the game day (see README). */
  now: () => number;
  /** Next `seq` for this game load, shared by every NPC. */
  nextSeq: () => number;
  /** Recall budget for one dialogue turn; the store defaults (8 items, 4000 chars) are sized for consolidation. */
  limit?: number;
  maxChars?: number;
  /** How many of today's exchanges go back into the prompt; older ones rely on recall. */
  historyTurns?: number;
}

/** Recent memories always get a few slots, since relevance recall returns nothing when no words match. */
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
    this.options = { limit: 6, maxChars: 600, historyTurns: 10, ...options };
  }

  async context(query: string): Promise<MemoryContext> {
    const { limit, maxChars, historyTurns } = this.options;
    const nowGameTime = this.options.now();
    const agent = this.agent();
    const [relevant, recent] = await Promise.all([
      agent.context({ query, nowGameTime, limit, maxChars }),
      agent.context({ nowGameTime, limit: RECENT_SLOTS, maxChars }),
    ]);
    const picked: RecallResult[] = [];
    let chars = 0;
    const head = Math.max(0, limit - RECENT_SLOTS);
    const order = [...relevant.memories.slice(0, head), ...recent.memories, ...relevant.memories.slice(head)];
    for (const memory of order) {
      const length = Array.from(memory.text).length;
      if (picked.length === limit || picked.some((p) => p.id === memory.id) || chars + length > maxChars) continue;
      picked.push(memory);
      chars += length;
    }
    picked.sort((a, b) => a.gameTime - b.gameTime);
    const today = relevant.today.flatMap((entry): Exchange[] => {
      const log = entry.changes[0]?.log;
      return log && typeof log.player === 'string' && typeof log.npc === 'string' ? [{ player: log.player, npc: log.npc }] : [];
    });
    return {
      memories: picked.map((memory) => ({ text: memory.text, when: daysAgo(nowGameTime, memory.gameTime) })),
      today: today.slice(-historyTurns),
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

export function daysAgo(now: number, then: number): string {
  const days = Math.floor(now / 1440) - Math.floor(then / 1440);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}
