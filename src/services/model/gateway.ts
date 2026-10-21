import type { ChatMessage, ChatModel, ChatOptions, Completion, StreamHandlers } from './client.ts';

/** One queue in front of every model call of the backend process (docs/scheduler.md §3). */

/** In priority order. */
export const TIERS = ['dialogue', 'nearby', 'nightly', 'background'] as const;
export type Tier = typeof TIERS[number];

const TIER_NAMES: Record<Tier, string> = { dialogue: '对话', nearby: '附近', nightly: '夜间', background: '后台' };

export interface GatewayLimits {
  maxConcurrent: number;
  /** All tiers but dialogue together, so the player's next line always finds a free slot. */
  maxNonDialogue: number;
  /** How long a request may wait in the queue before its result is useless; missing tiers wait as long as it takes. */
  maxWaitMs: Partial<Record<Tier, number>>;
}

/** design.md §9.1. Nearby NPCs may have walked away after 20 s; a background scene belongs to one game hour (~43 s). */
export const GATEWAY_LIMITS: GatewayLimits = { maxConcurrent: 6, maxNonDialogue: 3, maxWaitMs: { nearby: 20_000, background: 40_000 } };

export class QueueExpired extends Error {
  constructor(tier: Tier, waitedMs: number) {
    super(`排队 ${Math.round(waitedMs / 1000)} 秒还没轮到，放弃这次${TIER_NAMES[tier]}请求`);
    this.name = 'QueueExpired';
  }
}

export interface TierUsage {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Dropped from the queue without being sent. */
  expired: number;
  /** Sent, then threw, including cancellations. */
  failed: number;
}

interface Waiting { tier: Tier; start: () => void }

const empty = (): Record<Tier, TierUsage> => Object.fromEntries(TIERS.map(tier => [tier, {
  calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, expired: 0, failed: 0 }])) as Record<Tier, TierUsage>;

export class ModelGateway {
  private readonly limits: GatewayLimits;
  private readonly queue: Waiting[] = [];
  private running = 0;
  private runningNonDialogue = 0;
  private tally = empty();

  constructor(limits: Partial<GatewayLimits> = {}) {
    this.limits = { ...GATEWAY_LIMITS, ...limits };
  }

  /** The caller keeps its own client (and so its reasoning level); only the queue is shared. */
  lane(tier: Tier, client: ChatModel): ChatModel {
    return { chat: (messages: ChatMessage[], handlers?: StreamHandlers, options?: ChatOptions) =>
      this.run(tier, () => client.chat(messages, handlers, options), options?.signal) };
  }

  usage(): Record<Tier, TierUsage> {
    return structuredClone(this.tally);
  }

  /** One log line for everything since the last report, then starts counting again. Nightly calls run after the save. */
  report(day: number): string {
    const tally = this.tally;
    this.tally = empty();
    const number = (value: number) => value.toLocaleString('en-US');
    const parts = TIERS.filter(tier => tally[tier].calls > 0).map(tier => {
      const t = tally[tier];
      return `${tier === 'nightly' ? '夜间（前一晚）' : `${TIER_NAMES[tier]} `}${t.calls} 次 输入 ${number(t.inputTokens)}（缓存 ${number(t.cachedInputTokens)}）输出 ${number(t.outputTokens)}`;
    });
    const expired = TIERS.reduce((sum, tier) => sum + tally[tier].expired, 0);
    const failed = TIERS.reduce((sum, tier) => sum + tally[tier].failed, 0);
    if (expired) parts.push(`过期 ${expired} 次`);
    if (failed) parts.push(`失败 ${failed} 次`);
    return `第 ${day} 天模型用量：${parts.length ? parts.join('；') : '没有调用'}`;
  }

  private async run(tier: Tier, call: () => Promise<Completion>, signal: AbortSignal | undefined): Promise<Completion> {
    signal?.throwIfAborted();
    await this.slot(tier, signal);
    const tally = this.tally[tier];
    tally.calls++;
    try {
      const completion = await call();
      if (completion.usage) {
        tally.inputTokens += completion.usage.inputTokens;
        tally.cachedInputTokens += completion.usage.cachedInputTokens ?? 0;
        tally.outputTokens += completion.usage.outputTokens;
      }
      return completion;
    } catch (error) {
      tally.failed++;
      throw error;
    } finally {
      this.running--;
      if (tier !== 'dialogue') this.runningNonDialogue--;
      this.pump();
    }
  }

  /** Resolves once the request holds a slot; a sent request is never interrupted by the gateway. */
  private slot(tier: Tier, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const queued = performance.now();
      const leave = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const entry: Waiting = { tier, start: () => { leave(); resolve(); } };
      const abort = () => { leave(); reject(signal!.reason); };
      const wait = this.limits.maxWaitMs[tier];
      const timer = wait === undefined ? undefined : setTimeout(() => {
        leave();
        this.tally[tier].expired++;
        reject(new QueueExpired(tier, performance.now() - queued));
      }, wait);
      timer?.unref();
      signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(entry);
      this.pump();
    });
  }

  private pump() {
    while (this.running < this.limits.maxConcurrent) {
      const others = this.runningNonDialogue < this.limits.maxNonDialogue;
      const next = TIERS.map(tier => this.queue.find(entry => entry.tier === tier)).find(entry => entry && (entry.tier === 'dialogue' || others));
      if (!next) return;
      this.running++;
      if (next.tier !== 'dialogue') this.runningNonDialogue++;
      next.start();
    }
  }
}
