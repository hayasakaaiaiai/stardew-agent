/**
 * NPCs near the player each say at most one line about the moment, or greet the farmer once a day
 * (docs/ambient-lines.md). Display only: nobody remembers these lines.
 */
import { BUBBLE_EMOTES, type BubbleEmote, cleanBubbleText } from './bubbles.ts';
import { RELATIONS, SEASONS, type WorldState } from './dialogue.ts';
import { firstSentence } from './nightly.ts';
import type { ChatMessage } from '../services/model/client.ts';
import type { Relation, Roster } from '../services/roster/index.ts';

/** The Mod enforces these too; the backend checks them again for its own budget. */
export const AMBIENT_CALLS_PER_DAY = 12;
const MAX_LINES = 4;
const MAX_CHARS = 24;
const LETTERS = ['a', 'b', 'c', 'd'] as const;
/** Past/completed actions have no game evidence in this display-only request. Keep potential complements and short exclamations. */
const UNSUPPORTED_PROGRESS = /刚(?:刚|才)?|已经|曾经|昨(?:天|晚|夜)|上(?:次|回|周)|完成|做完|刷完|吹跑|(?<!不|得|就好|太[^，。！？、\s]{1,2})了/;

/** The same for every call, so the day's calls share the cached prefix. */
export const AMBIENT_RULES = `# 同一个地方

你们是《星露谷物语》里鹈鹕镇的几位居民，此刻在同一个地方，农场主就在附近，能看到你们头顶冒出的话和表情。下面给出每个人是谁、和农场主熟不熟、彼此的关系和现在的情况。

## 怎么写
- 想开口的人每人最多一句，每句不超过 20 字，口语，符合各自的说话风格。不必人人都说，没什么可说的就不写这个人。
- 说眼前的事：天气、时间、这个地方、手头的活、身边的人。
- 可以自言自语（to 写 self），对在场的某个人说（to 写那个人的字母），或者跟农场主打个招呼（to 写 farmer）。招呼按熟不熟：刚认识时客气或者只点个头，越熟越亲近；没在约会就不说情话。标着“今天打过招呼”的人不再跟农场主打招呼。
- 不聊心事、秘密和恋爱，不提还没发生的事；不编造别的居民的经历和秘密，不确定的事不说。
- emote 从 happy、heart、question、exclamation、sad、music、none 里选一个配合这句话。

## 输出格式
只输出一个 JSON 对象，例如：
{"lines":[{"npc":"a","to":"self","text":"……","emote":"none"},{"npc":"b","to":"farmer","text":"……","emote":"happy"}]}`;

export const AMBIENT_HINT = '（用 json 回复，字段齐全：lines）';

export interface AmbientPerson {
  /** NPC id. */
  id: string;
  hearts: number;
  /** `stranger` means vanilla has no friendship record: they have never spoken. */
  relation: Relation;
  /** Already greeted the farmer today. */
  greeted: boolean;
}

export interface AmbientLine {
  /** NPC id. */
  npc: string;
  /** `self`, `farmer`, or the id of someone else present. */
  to: string;
  text: string;
  emote: BubbleEmote;
}

/** Only each card's identity and speaking style, how they stand with the farmer, and what the cards say about each other. */
export function ambientPrompt(roster: Roster, people: readonly AmbientPerson[], world: WorldState): ChatMessage[] {
  const cards = people.map(person => roster.get(person.id));
  const standing = (person: AmbientPerson) => (person.relation === 'stranger' ? '还没打过交道' : `${person.hearts} 心，${RELATIONS[person.relation]}`)
    + (person.greeted ? '，今天打过招呼' : '');
  const lines = cards.map((card, i) => `- ${LETTERS[i]}：${card.name}。${firstSentence(card.identity)}说话：${firstSentence(card.style)}`
    + `和农场主：${standing(people[i]!)}`);
  const relations = cards.flatMap(card => cards.flatMap(other => {
    const text = other === card ? undefined : card.relationships.find(relation => relation.id === other.id)?.text;
    return text ? [`- ${card.name}眼里的${other.name}：${text}`] : [];
  }));
  const facts = Object.entries(world.facts).map(([key, value]) => `${key}：${value}`);
  const user = [
    `## 在场的人\n${lines.join('\n')}`,
    ...(relations.length ? [`## 关系\n${relations.join('\n')}`] : []),
    [`## 现在`, `- 第 ${world.year} 年${SEASONS[world.season]} ${world.day} 日 ${world.time}，${world.weather}，${world.location}`,
      ...(facts.length ? [`- 镇上的情况：${facts.join('；')}`] : []),
      `- 农场主：${world.player.name}（${world.player.gender === 'female' ? '女' : '男'}），就在附近`].join('\n'),
    AMBIENT_HINT,
  ].join('\n\n');
  return [{ role: 'system', content: AMBIENT_RULES }, { role: 'user', content: user }];
}

/**
 * Keeps lines that are safe to show: cleaned of game commands, short, the first one per person, no second greeting
 * for someone who already greeted the farmer today, and no talk about the player behind their back. The rules ask for
 * the first two, but the model breaks them often enough that only code can be relied on (docs/ambient-lines.md §4.2).
 */
export function parseAmbient(content: string, people: readonly AmbientPerson[], playerName: string): AmbientLine[] {
  let data: unknown;
  try { data = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)); } catch { return []; }
  const lines = (data as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(lines)) return [];
  const byLetter = (value: unknown) => people[LETTERS.indexOf(value as typeof LETTERS[number])];
  const spoken = new Set<string>();
  return lines.flatMap((item): AmbientLine[] => {
    const { npc, to, text, emote } = (item ?? {}) as Record<string, unknown>;
    const speaker = byLetter(npc);
    const clean = typeof text === 'string' ? cleanBubbleText(text) : '';
    if (!speaker || spoken.has(speaker.id) || !clean || Array.from(clean).length > MAX_CHARS || UNSUPPORTED_PROGRESS.test(clean)) return [];
    const listener = to === 'farmer' ? 'farmer' : byLetter(to)?.id;
    const target = listener && listener !== speaker.id ? listener : 'self';
    const aboutPlayer = clean.includes('农场主') || (playerName !== '' && clean.includes(playerName));
    if (target === 'farmer' ? speaker.greeted : aboutPlayer) return [];
    spoken.add(speaker.id);
    return [{ npc: speaker.id, to: target, text: clean, emote: BUBBLE_EMOTES.includes(emote as BubbleEmote) ? emote as BubbleEmote : 'none' }];
  }).slice(0, MAX_LINES);
}
