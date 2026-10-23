/** Uses yesterday's plan only on the first successful opening of this game day (docs/next-day-plans.md). */
import { OPENING_LINE, type DialogueMemory } from './dialogue.ts';
import type { DayEntry, NpcContext, NpcState } from '../types.ts';

export const MORNING_HEADING = '## 这次开场想提起的事';

const DAY_OFFSETS: Record<string, number> = { 大前天: -3, 前天: -2, 昨天: -1, 今天: 0, 明天: 1, 后天: 2, 大后天: 3 };
const DAY_LABELS: Record<number, string> = { [-2]: '前天', [-1]: '昨天', 0: '今天', 1: '明天', 2: '后天', 3: '大后天' };

/** Render dates from the saved plan's day, without changing the plan or the original quoted evidence. */
function datedPlan(plan: string, yesterday: number, today: number): string {
  return plan.replace(/大前天|大后天|前天|昨天|今天|明天|后天/g, word => {
    const day = yesterday + DAY_OFFSETS[word]!;
    const label = DAY_LABELS[day - today];
    return label ? `${label}（第${day}天）` : `第${day}天`;
  });
}

export const MORNING_FALLBACK = '昨天说起的事，你现在有什么想法？';
const QUESTIONS = ['聊聊昨天的事吧', '你有什么想法？', '先聊点别的吧'];

/** Keep short questions, never a generated account of the NPC's off-screen actions. */
export function morningReply(reply: string, plan: string, yesterday: number, today: number): string {
  if (!reply.trim()) return '';
  const dates = new Set(datedPlan(plan, yesterday, today).match(/大前天|大后天|前天|昨天|今天|明天|后天/g) ?? []);
  const safe = (line: string) => {
    if (/[我咱俺]|已|昨晚|昨夜|刚才|现成|(?:拿|带|扛|送).{0,4}(?:来|到)/.test(line)) return false;
    // Perfect-aspect particles are accepted only in an explicit question about whether something happened.
    if (/[了过]/.test(line.replace(/(?:了|过)(?:吗|没(?:有)?)/g, ''))) return false;
    return (line.match(/大后天|后天|明天/g) ?? []).every(word => dates.has(word));
  };
  const questions = (reply.match(/[^。.!！；;\n？?]+[？?]/g) ?? []).flatMap(sentence => {
    const clauses = sentence.split(/[，,：:]|—+|…+/).map(line => line.trim()).filter(line => line && safe(line));
    return clauses.at(-1)?.match(/[？?]$/) ? [clauses.join('，')] : [];
  });
  const result = questions.slice(0, 2).join('');
  return result && Array.from(result).length <= 80 ? result : MORNING_FALLBACK;
}

export function morningBlock(plan: string, yesterday: number, today: number): string {
  return `${MORNING_HEADING}\n今天是第${today}天。以下计划的日期已由程序从昨晚换算成今天的视角，按标注日期说，别照搬昨天原话里的相对日期。自然地先提起或询问，别等玩家先问。计划只是你的意向，不证明玩家同意；先核对“你记得的事”的原话，双方明确答应才能说约好了，未答复只询问，已拒绝不再当共同安排。历史原话只证明说过，不证明执行过；即使昨天答应今天备料或带来，也不能当作已做。本次只向玩家询问意向、安排或进展，不作任何已执行的行动陈述，也不编造物品、风力等未知细节。\n- ${JSON.stringify(datedPlan(plan, yesterday, today))}`;
}

/** Yesterday's plan if it can open today's first conversation: written last night, non-empty and short. */
export function morningPlan(state: NpcState, today: number): string | undefined {
  const plan = state.plan;
  if (!Number.isSafeInteger(state.day) || state.day !== today - 1 || typeof plan !== 'string' || !plan.trim()
    || Array.from(plan).length > 100) return undefined;
  return plan;
}

/**
 * Whether today's part of the day already has a conversation turn. Gifts, news heard, festivals and backstage scenes
 * are written there too, and none of them means the NPC has spoken to the player.
 */
export function talkedToday(entries: readonly DayEntry[]): boolean {
  return entries.some(entry => entry.changes.some(change => typeof change.log?.player === 'string'));
}

/** These are the complete utterances written by the source-grounded nightly consolidator. */
export function grounded(text: string): boolean {
  return text.split('\n').every(line => {
    const match = /^(?:农场主说|我说)：(.+)$/.exec(line);
    if (!match) return false;
    try {
      const quote: unknown = JSON.parse(match[1]!);
      return typeof quote === 'string' && quote.trim() !== '';
    } catch { return false; }
  });
}

/** No consumed flag: a successful exchange in the existing day journal is the only record of use. */
export function withMorningPlan(memory: DialogueMemory, options: {
  now: () => number;
  read: () => Promise<Pick<NpcContext, 'state' | 'today'>>;
  /** This opening asks the player out instead; the plan waits (docs/npc-invites.md). */
  skip?: boolean;
}): DialogueMemory {
  let prompted = false;
  return {
    async context(query, standing) {
      prompted = false;
      const context = await memory.context(query, standing);
      if (options.skip || query !== OPENING_LINE || context.today?.length
        || !context.memories.some(item => item.when === '昨天' && grounded(item.text))) return context;
      const { state, today } = await options.read();
      const day = Math.floor(options.now() / 1440);
      const sourcePlan = morningPlan(state, day);
      if (talkedToday(today) || sourcePlan === undefined) return context;
      prompted = true;
      const plan = morningBlock(sourcePlan, day - 1, day);
      return { ...context, summary: [context.summary, plan].filter(Boolean).join('\n\n'),
        replyView: (reply, meta) => ({ reply: morningReply(reply, sourcePlan, day - 1, day),
          meta: { ...meta, options: [...QUESTIONS], remember: [] } }),
      };
    },
    record(exchange, remembered) {
      // The NPC is bringing up existing facts; its opening is not a new statement by the player.
      return memory.record(exchange, prompted && exchange.player === OPENING_LINE ? [] : remembered);
    },
  };
}
