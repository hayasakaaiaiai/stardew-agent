/**
 * Two NPCs chatting where the player can overhear (docs/npc-chat.md). Only the one public share each NPC chose
 * last night can become a listener's memory after the Mod confirms display (docs/npc-news.md).
 */
import { BUBBLE_EMOTES, type BubbleEmote, cleanBubbleText } from './bubbles.ts';
import { SEASONS, type WorldState } from './dialogue.ts';
import { type NewsItem, newsLine } from './news.ts';
import { firstSentence } from './nightly.ts';
import type { ChatMessage, Thinking } from '../services/model/client.ts';
import type { Roster } from '../services/roster/index.ts';

/**
 * Every model call reasons at `high` by the user's choice (2026-10-20). Against `disabled`: about twice the output
 * and 0.6 s slower, same quality in the measured scenes (docs/legacy-cleanup.md §3).
 */
export const SCENE_THINKING: Thinking = 'high';
/** The Mod enforces these too; the backend checks them again for its own budget. */
export const SCENES_PER_DAY = 4;
export const SCENE_GAP_MINUTES = 60;
const MAX_LINES = 4;
const MAX_CHARS = 24;

/** The same for every pair, so the day's scenes share the cached prefix. */
export const SCENE_RULES = `# 镇上碰面

你们是《星露谷物语》里鹈鹕镇的两位居民，在镇上碰到了，随口聊几句。农场主就在不远处，能看到你们头顶冒出的话。下面给出两个人是谁、彼此的关系和现在的情况。

## 怎么写
- 写 2–4 句，两人轮流说，第一句由 a 开口。每句不超过 20 字，口语，像路上碰见时的寒暄和闲聊，符合各自的说话风格和彼此的关系。
- 只聊日常小事：天气、吃的、手头的活、镇上大家都知道的事。不聊农场主（下面给出的“想说的事”除外），不聊心事、秘密和恋爱，不提还没发生的事。
- 有“想说的事”的人可以像说新鲜事一样提一句，只说给出的内容，不添油加醋；说了就在 told 里写上这个人（a 或 b）。
- 不编造别的居民的经历和秘密；不确定的事不说。
- emote 从 happy、heart、question、exclamation、sad、music、none 里选一个配合这句话。

## 输出格式
只输出一个 JSON 对象，例如：
{"lines":[{"speaker":"a","text":"……","emote":"none"},{"speaker":"b","text":"……","emote":"happy"}],"told":[]}`;

export const SCENE_HINT = '（用 json 回复，字段齐全：lines、told）';

export interface SceneLine {
  /** NPC id. */
  npc: string;
  text: string;
  emote: BubbleEmote;
}

/** `a` opens. Only the card's identity and speaking style, plus what each card says about the other. */
/** What each of the two can tell the other, its own or heard first-hand (docs/npc-news.md, docs/offscreen-news.md). */
export type SceneNews = Partial<Record<'a' | 'b', NewsItem>>;

export function scenePrompt(roster: Roster, a: string, b: string, world: WorldState, news: SceneNews = {}): ChatMessage[] {
  const [first, second] = [roster.get(a), roster.get(b)];
  const person = (label: string, card: typeof first) => `- ${label}：${card.name}。${firstSentence(card.identity)}说话：${firstSentence(card.style)}`;
  const relations = ([[first, b, second.name], [second, a, first.name]] as const).flatMap(([card, other, name]) => {
    const text = card.relationships.find((relation) => relation.id === other)?.text;
    return text ? [`- ${card.name}眼里的${name}：${text}`] : [];
  });
  const facts = Object.entries(world.facts).map(([key, value]) => `${key}：${value}`);
  const told = (['a', 'b'] as const).flatMap(label => news[label]
    ? [`- ${label}（${(label === 'a' ? first : second).name}）：${newsLine(news[label]!, (id) => roster.get(id).name)}`] : []);
  const user = [
    `## 两个人\n${person('a', first)}\n${person('b', second)}`,
    ...(relations.length ? [`## 关系\n${relations.join('\n')}`] : []),
    [`## 现在`, `- 第 ${world.year} 年${SEASONS[world.season]} ${world.day} 日 ${world.time}，${world.weather}，${world.location}`,
      ...(facts.length ? [`- 镇上的情况：${facts.join('；')}`] : []),
      // Only news brings the player up; without this the model guesses “他” (docs/npc-news.md §4).
      ...(told.length ? [`- 农场主：${world.player.name}（${world.player.gender === 'female' ? '女' : '男'}）`] : [])].join('\n'),
    ...(told.length ? [`## 想说的事\n${told.join('\n')}`] : []),
    SCENE_HINT,
  ].join('\n\n');
  return [{ role: 'system', content: SCENE_RULES }, { role: 'user', content: user }];
}

/**
 * Keeps lines that are safe to show: cleaned of game commands, short, from one of the two, and never about the
 * player unless the speaker had news to tell. Fewer than two lines is not a conversation, so nothing is shown.
 * `told` lists the NPC ids that passed their news on and still have a line on screen.
 */
export function parseScene(content: string, a: string, b: string, playerName: string, news: SceneNews = {}):
  { lines: SceneLine[]; told: string[] } {
  const none = { lines: [], told: [] };
  let data: unknown;
  try { data = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)); } catch { return none; }
  const { lines, told } = (data ?? {}) as { lines?: unknown; told?: unknown };
  if (!Array.isArray(lines)) return none;
  const kept = lines.flatMap((item): SceneLine[] => {
    const { speaker, text, emote } = (item ?? {}) as Record<string, unknown>;
    const npc = speaker === 'a' ? a : speaker === 'b' ? b : undefined;
    const clean = typeof text === 'string' ? cleanBubbleText(text) : '';
    const aboutPlayer = clean.includes('农场主') || (playerName !== '' && clean.includes(playerName));
    if (!npc || !clean || Array.from(clean).length > MAX_CHARS || (aboutPlayer && !news[speaker as 'a' | 'b'])) return [];
    return [{ npc, text: clean, emote: BUBBLE_EMOTES.includes(emote as BubbleEmote) ? emote as BubbleEmote : 'none' }];
  }).slice(0, MAX_LINES);
  if (kept.length < 2) return none;
  const tellers = (['a', 'b'] as const).filter(label => news[label] && Array.isArray(told) && told.includes(label))
    .map(label => label === 'a' ? a : b).filter(npc => kept.some(line => line.npc === npc));
  return { lines: kept, told: tellers };
}
