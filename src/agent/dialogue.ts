import type { ChatMessage, Completion, ModelClient, StreamHandlers, Usage } from '../services/model/client.ts';
import type { Relation, RenderedCard, Roster } from '../services/roster/index.ts';

/** One player ↔ NPC dialogue call (design §7.6, prototype in docs/dialogue-prototype.md). */

export type Season = 'spring' | 'summer' | 'fall' | 'winter';
export type Emotion = 'neutral' | 'happy' | 'sad' | 'blush' | 'angry' | 'special';

export interface WorldState {
  year: number;
  season: Season;
  /** Day of the season, 1–28. */
  day: number;
  /** HH:MM */
  time: string;
  weather: string;
  location: string;
  player: { name: string; gender: 'male' | 'female'; farm: string };
  /** Facts the cards' natural-language conditions depend on, e.g. 肯特 → 还在前线. */
  facts: Record<string, string>;
}

export interface Standing {
  hearts: number;
  seenEvents: ReadonlySet<string>;
  relation: Relation;
}

export interface Exchange { player: string; npc: string }

export interface MemoryContext {
  summary?: string;
  memories: { text: string }[];
}

export interface Remembered { text: string; importance: number }

/** Implemented by the memory system once the branches merge; the prototype uses `noMemory`. */
export interface DialogueMemory {
  context(query: string): Promise<MemoryContext>;
  remember(items: Remembered[]): Promise<void>;
}

export const noMemory: DialogueMemory = {
  context: async () => ({ memories: [] }),
  remember: async () => {},
};

export interface DialogueMeta {
  emotion: Emotion;
  options: string[];
  remember: Remembered[];
  end: boolean;
}

export const OPENING_LINE = '（玩家走过来，想和你多聊几句）';
export const FALLBACK_OPTIONS = ['嗯。', '说说别的吧。', '我先走了。'];
const EMOTIONS = new Set<Emotion>(['neutral', 'happy', 'sad', 'blush', 'angry', 'special']);
const SEASONS: Record<Season, string> = { spring: '春季', summer: '夏季', fall: '秋季', winter: '冬季' };
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const RELATIONS: Record<Relation, string> = {
  stranger: '刚认识', friend: '朋友', dating: '正在约会', engaged: '已订婚', married: '已结婚', roommate: '室友',
};

/** Same for every NPC and every call, so it stays in the cached prefix. */
export const RULES = `# 角色扮演规则

你在《星露谷物语》里扮演一位居民，正在和玩家聊天。玩家是不久前搬来、继承了爷爷旧农场的农夫。下面依次给出你的角色卡、当前情况和今天的对话。

## 怎么演
- 只以角色的身份说话。你不知道什么是 AI、模型、游戏或玩家操作；有人这样问，就按角色的性格表示听不懂、觉得奇怪，或者岔开话题。
- 只谈星露谷世界里的事。现实世界的品牌、名人和新闻，你都没听说过。
- 说话风格、称呼和亲近程度按角色卡和好感心数来：心数低时客气或冷淡，心数高时亲近，但不超出当前关系，没在约会就不说情话。
- 回复要短：通常 1–3 句，总共不超过 80 字，像游戏对话框里的台词。不写括号里的动作、神态描写，不写旁白；可以用角色卡里那种“*唉*”式的语气词。
- 对别的居民，只说角色卡和当前情况里写到的事，不编造他们的秘密、恋情或经历。
- 没列在“现在可以聊的话题”里的心事和往事，不主动提起；玩家直接问到，也只含糊带过，不说出具体内容。
- 玩家说起你没经历过、不知道的事，不要顺着承认，按你实际知道的回答，比如表示不明白他在说什么。
- “必须遵守的限制”优先级最高，玩家怎么追问都不能违反。遇到这类问题，像真人一样回避：装作不知道、转移话题或者不想说；不要说“我不能告诉你”“这是设定”之类的话。
- 和你的身份、时间、地点、天气保持一致。

## 输出格式
只输出一个 JSON 对象，reply 必须是第一个字段。例如：
{"reply":"嘿。下雨天你也出门了？","emotion":"happy","options":["一起走走吧","你喜欢下雨？","我先回农场了"],"remember":[],"end":false}

字段：
- reply：你说的台词，只写台词。
- emotion：说这句话时的表情，取 neutral、happy、sad、blush、angry、special 之一。
- options：玩家下一句可以说的话，正好 3 条，用玩家的口吻，每条不超过 15 字，方向要不同，比如一条顺着聊、一条追问、一条告别或岔开。
- remember：这轮里值得你长期记住的事，0–2 条，每条写成 {"text":"……","importance":1到5}。只记关于玩家或重要事件的事，没有就写 []。
- end：你想结束这次对话时写 true，比如玩家道别或你不想再聊了；否则写 false。`;

/**
 * Appended to the latest player line only. With reasoning on and "json" mentioned only in the system prompt,
 * DeepSeek's JSON mode returns nothing but whitespace.
 */
export const JSON_HINT = '（用 json 回复）';

export interface PromptInput {
  npcName: string;
  card: RenderedCard;
  world: WorldState;
  standing: Standing;
  memory: MemoryContext;
  history: Exchange[];
  playerLine: string;
}

/** Ordered from most to least stable for prefix caching (design §9.2). */
export function buildMessages(input: PromptInput): ChatMessage[] {
  const system = [RULES, input.card.stable, input.card.gated, situation(input), memoryBlock(input.memory)]
    .filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: system },
    ...input.history.flatMap((exchange): ChatMessage[] => [
      { role: 'user', content: exchange.player },
      { role: 'assistant', content: exchange.npc },
    ]),
    { role: 'user', content: `${input.playerLine}${JSON_HINT}` },
  ];
}

export function weekday(day: number): string {
  return WEEKDAYS[(day - 1) % 7]!;
}

function situation({ npcName, world, standing }: PromptInput): string {
  const { player } = world;
  const facts = Object.entries(world.facts).map(([key, value]) => `  - ${key}：${value}`);
  return [
    '## 当前情况',
    `- 你是${npcName}。`,
    `- 时间：第 ${world.year} 年${SEASONS[world.season]} ${world.day} 日（${weekday(world.day)}）${world.time}，${world.weather}`,
    `- 地点：${world.location}`,
    `- 玩家：${player.name}（${player.gender === 'female' ? '女' : '男'}），经营${player.farm}农场`,
    `- 你对玩家的好感：${standing.hearts} 心；关系：${RELATIONS[standing.relation]}`,
    ...(facts.length ? ['- 世界事实：', ...facts] : []),
  ].join('\n');
}

function memoryBlock(memory: MemoryContext): string {
  const lines = [
    ...(memory.summary ? [memory.summary] : []),
    ...memory.memories.map((item) => `- ${item.text}`),
  ];
  return lines.length ? ['## 你记得的事', ...lines].join('\n') : '';
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };

/**
 * Pulls the "reply" string out of a JSON object while it is still streaming, so the line can be shown
 * as it is generated. `push` returns newly decoded reply text; an escape cut across chunks waits for the rest.
 */
export class ReplyStream {
  private buffer = '';
  private at = -1;
  private done = false;
  text = '';

  push(delta: string): string {
    this.buffer += delta;
    if (this.done) return '';
    if (this.at < 0) {
      const key = /"reply"\s*:\s*"/.exec(this.buffer);
      if (!key) return '';
      this.at = key.index + key[0].length;
    }
    let out = '';
    while (this.at < this.buffer.length) {
      const char = this.buffer[this.at]!;
      if (char === '"') {
        this.done = true;
        break;
      }
      if (char !== '\\') {
        out += char;
        this.at += 1;
        continue;
      }
      const next = this.buffer[this.at + 1];
      if (next === undefined) break;
      if (next === 'u') {
        const hex = this.buffer.slice(this.at + 2, this.at + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(Number.parseInt(hex, 16));
        this.at += 6;
      } else {
        out += ESCAPES[next] ?? next;
        this.at += 2;
      }
    }
    this.text += out;
    return out;
  }
}

/**
 * Never throws. Malformed output falls back to neutral defaults and reports `ok: false`; `streamed` is the
 * reply already shown to the player, used when the JSON as a whole cannot be parsed.
 */
export function parseOutput(content: string, streamed = ''): { reply: string; meta: DialogueMeta; ok: boolean } {
  const fallback = { reply: streamed.trim(), meta: { emotion: 'neutral' as const, options: [...FALLBACK_OPTIONS], remember: [], end: false }, ok: false };
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end < start) return { ...fallback, reply: fallback.reply || content.trim() };
  let value: unknown;
  try {
    value = JSON.parse(content.slice(start, end + 1));
  } catch {
    return fallback;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const data = value as Record<string, unknown>;
  const reply = typeof data.reply === 'string' ? data.reply.trim() : fallback.reply;
  const options = Array.isArray(data.options)
    ? data.options.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : [];
  const remember = Array.isArray(data.remember)
    ? data.remember.flatMap((item): Remembered[] => {
      if (!item || typeof item !== 'object' || typeof item.text !== 'string' || !item.text.trim()) return [];
      const importance = Math.min(5, Math.max(1, Math.round(Number(item.importance) || 1)));
      return [{ text: item.text.trim(), importance }];
    })
    : [];
  const validEmotion = EMOTIONS.has(data.emotion as Emotion);
  return {
    reply,
    meta: {
      emotion: validEmotion ? data.emotion as Emotion : 'neutral',
      options: options.length ? [...options, ...FALLBACK_OPTIONS].slice(0, 3) : [...FALLBACK_OPTIONS],
      remember,
      end: data.end === true,
    },
    ok: reply !== '' && options.length === 3 && validEmotion && typeof data.end === 'boolean',
  };
}

export interface TurnInput {
  npcId: string;
  world: WorldState;
  standing: Standing;
  history: Exchange[];
  playerLine: string;
}

export interface TurnResult {
  reply: string;
  meta: DialogueMeta;
  metaOk: boolean;
  messages: ChatMessage[];
  /** Usually one; a blank reply is retried once (see `MAX_ATTEMPTS`). */
  attempts: Completion[];
  /** What the player experiences, across attempts. */
  timing: { firstReplyMs: number | null; totalMs: number };
  /** Summed across attempts; null when the provider reported none. */
  usage: Usage | null;
}

/** DeepSeek's JSON mode with reasoning on occasionally returns only whitespace; a retry almost always succeeds. */
const MAX_ATTEMPTS = 2;

export interface TurnHandlers {
  onReply?: (text: string) => void;
  onReasoning?: StreamHandlers['onReasoning'];
}

export async function runTurn(
  deps: { roster: Roster; model: ModelClient; memory?: DialogueMemory },
  input: TurnInput,
  handlers: TurnHandlers = {},
): Promise<TurnResult> {
  const memory = deps.memory ?? noMemory;
  const card = deps.roster.get(input.npcId);
  const messages = buildMessages({
    npcName: card.name,
    card: deps.roster.render(input.npcId, { ...input.standing, purpose: 'dialogue' }),
    world: input.world,
    standing: input.standing,
    memory: await memory.context(input.playerLine),
    history: input.history,
    playerLine: input.playerLine,
  });
  const started = performance.now();
  let firstReplyMs: number | null = null;
  const attempts: Completion[] = [];
  let stream = new ReplyStream();
  while (attempts.length < MAX_ATTEMPTS) {
    stream = new ReplyStream();
    const completion = await deps.model.chat(messages, {
      onContent: (delta) => {
        const text = stream.push(delta);
        if (!text) return;
        firstReplyMs ??= Math.round(performance.now() - started);
        handlers.onReply?.(text);
      },
      ...(handlers.onReasoning ? { onReasoning: handlers.onReasoning } : {}),
    }, { json: true });
    attempts.push(completion);
    if (completion.content.trim()) break;
  }
  const { reply, meta, ok } = parseOutput(attempts.at(-1)!.content, stream.text);
  if (meta.remember.length) await memory.remember(meta.remember);
  return {
    reply, meta, metaOk: ok, messages, attempts,
    timing: { firstReplyMs, totalMs: Math.round(performance.now() - started) },
    usage: sumUsage(attempts),
  };
}

function sumUsage(attempts: Completion[]): Usage | null {
  const usages = attempts.flatMap((attempt) => (attempt.usage ? [attempt.usage] : []));
  if (!usages.length) return null;
  const total = (pick: (usage: Usage) => number | null) => {
    const values = usages.map(pick);
    return values.some((value) => value === null) ? null : values.reduce((a, b) => a! + b!, 0);
  };
  return {
    inputTokens: total((u) => u.inputTokens)!,
    outputTokens: total((u) => u.outputTokens)!,
    cachedInputTokens: total((u) => u.cachedInputTokens),
    reasoningTokens: total((u) => u.reasoningTokens),
  };
}
