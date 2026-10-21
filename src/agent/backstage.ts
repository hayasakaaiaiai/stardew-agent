/**
 * NPCs who spend an hour together away from the player chat, and each remembers one thing from it
 * (docs/scheduler.md §4). One call for the whole group, without reasoning; nobody sees the talk itself.
 */
import { cleanBubbleText } from './bubbles.ts';
import { SEASONS, type WorldState } from './dialogue.ts';
import { firstSentence } from './nightly.ts';
import { newsLine, type NewsItem } from './news.ts';
import type { ChatMessage, Thinking } from '../services/model/client.ts';
import type { Roster } from '../services/roster/index.ts';
import type { MemoryDraft } from '../types.ts';

/** Reasoning made the output 20 times longer for about the same memories (docs/scheduler.md §4.6). */
export const BACKSTAGE_THINKING: Thinking = 'disabled';
export const BACKSTAGE_PER_DAY = 6;
/** Importance-2 memories are recalled from 5 hearts up, so without such an NPC the scene would be remembered for nothing. */
export const BACKSTAGE_MIN_HEARTS = 5;
export const BACKSTAGE_TOPIC = 'backstage';
/** Recent enough to still be talked about. */
export const FESTIVAL_DAYS = 7;
const MAX_PEOPLE = 3;
/** Each result is written at the next hour, and from 23:00 on there may be none before the player sleeps (§4.5). */
const FIRST_TIME = 700;
const LAST_TIME = 2300;
const KNOWN_PER_PERSON = 2;
/** The rules ask for 30; without reasoning half go a little over, all within 40 (§4.6). */
const MAX_CHARS = 40;
/** NPC schedules come from the game, so a plan made here would never happen. */
const PROMISE = /约好|约了|说好|一起去/;
const LETTERS = ['a', 'b', 'c'] as const;

/** The same for every call, so the day's calls share the cached prefix. */
export const BACKSTAGE_RULES = `# 玩家不在的时候

你们是《星露谷物语》里鹈鹕镇的几位居民，此刻待在同一个地方，农场主不在。你们随便聊了一会儿。下面给出每个人是谁、彼此的关系、各自记得的农场主的事和现在的情况。

## 要写的
- 不用写出对话。只写每个人从这次闲聊里记住的一件事，用他自己的口吻，不超过 30 字，比如“格斯说汤又做多了，我们笑他手太大方”。两人以上说的是同一段闲聊，内容要对得上。
- 聊各自手头的事、这个地方、彼此、镇上的日常。说话符合各自的身份和性格。
- 农场主只能聊下面写到的事，不编农场主没做过、没说过的事；没写到就不聊农场主。
- 不约时间地点，不说之后要一起去哪、做什么；不提还没发生的事；不编造不在场居民的秘密和经历；不写“今天、明天、昨天”。

## 输出格式
只输出一个 JSON 对象，用每个人的字母，例如：
{"memories":{"a":"……","b":"……"}}`;

export const BACKSTAGE_HINT = '（用 json 回复，字段齐全：memories）';

export interface BackstageCandidate {
  /** The group's location as the game names it. */
  place: string;
  people: { id: string; hearts: number; hasNews: boolean }[];
}

export interface BackstagePick { place: string; ids: string[] }

export interface BackstagePerson {
  id: string;
  /** News it may pass on (own and first-hand only, docs/npc-news.md). */
  news: readonly NewsItem[];
  /** Its recent festival memories, newest first. */
  festivals: readonly string[];
}

export interface BackstageNote { npcId: string; memory: MemoryDraft }

export function backstageHour(time: number): boolean {
  return time >= FIRST_TIME && time <= LAST_TIME;
}

/**
 * The fast path (§4.2): no model call unless a group still has two people who have not had a scene today, one of them
 * close to the player. At most 3 per scene, the closest, news first among equals; then groups with news, closer, larger.
 */
export function pickBackstage(groups: readonly BackstageCandidate[], joined: ReadonlySet<string>): BackstagePick | undefined {
  const ready = groups.flatMap(group => {
    const people = group.people.filter(person => !joined.has(person.id))
      .sort((x, y) => y.hearts - x.hearts || Number(y.hasNews) - Number(x.hasNews)).slice(0, MAX_PEOPLE);
    return people.length >= 2 && people[0]!.hearts >= BACKSTAGE_MIN_HEARTS ? [{ place: group.place, people }] : [];
  });
  const news = (group: typeof ready[number]) => Number(group.people.some(person => person.hasNews));
  ready.sort((x, y) => news(y) - news(x) || y.people[0]!.hearts - x.people[0]!.hearts || y.people.length - x.people.length);
  const best = ready[0];
  return best && { place: best.place, ids: best.people.map(person => person.id) };
}

/** Each card's identity and speaking style, what the cards say about each other, and only what may be told of the farmer. */
export function backstagePrompt(roster: Roster, people: readonly BackstagePerson[], place: string, world: WorldState): ChatMessage[] {
  const cards = people.map(person => roster.get(person.id));
  const name = (id: string) => roster.has(id) ? roster.get(id).name : id;
  const lines = cards.map((card, i) => `- ${LETTERS[i]}：${card.name}。${firstSentence(card.identity)}说话：${firstSentence(card.style)}`);
  const relations = cards.flatMap(card => cards.flatMap(other => {
    const text = other === card ? undefined : card.relationships.find(relation => relation.id === other.id)?.text;
    return text ? [`- ${card.name}眼里的${other.name}：${text}`] : [];
  }));
  // News heard from someone else in the group is listed once, by whoever comes first.
  const told = new Set<string>();
  const known = people.flatMap((person, i) => [
    ...person.news.filter(item => !told.has(item.origin) && told.add(item.origin))
      .map(item => item.hand === 1 ? item.share : newsLine(item, name)),
    ...person.festivals,
  ].slice(0, KNOWN_PER_PERSON).map(text => `- ${cards[i]!.name}：${text}`));
  const user = [
    `## 在场的人\n${lines.join('\n')}`,
    ...(relations.length ? [`## 关系\n${relations.join('\n')}`] : []),
    `## 记得的农场主的事\n${known.length ? known.join('\n') : '（没有）'}`,
    [`## 现在`, `- 第 ${world.year} 年${SEASONS[world.season]} ${world.day} 日 ${world.time}，${world.weather ? `${world.weather}，` : ''}${place}`,
      `- 农场主：${world.player.name}（${world.player.gender === 'female' ? '女' : '男'}），不在这里`].join('\n'),
    BACKSTAGE_HINT,
  ].join('\n\n');
  return [{ role: 'system', content: BACKSTAGE_RULES }, { role: 'user', content: user }];
}

/**
 * One note per person whose line is usable; code, not the model, says where and with whom. A dropped line does not
 * affect the others'.
 */
export function parseBackstage(content: string, ids: readonly string[], place: string, name: (id: string) => string): BackstageNote[] {
  let data: unknown;
  try { data = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)); } catch { return []; }
  const memories = (data as { memories?: unknown } | null)?.memories;
  if (!memories || typeof memories !== 'object' || Array.isArray(memories)) return [];
  return ids.flatMap((npcId, i): BackstageNote[] => {
    const value = (memories as Record<string, unknown>)[LETTERS[i]!];
    const text = typeof value === 'string' ? cleanBubbleText(value) : '';
    if (!text || Array.from(text).length > MAX_CHARS || PROMISE.test(text)) return [];
    const others = ids.filter(id => id !== npcId);
    return [{ npcId, memory: { text: `在${place || '镇上'}和${others.map(name).join('、')}聊天：${text}`, importance: 2,
      kind: 'observation', subjects: others, topics: [BACKSTAGE_TOPIC], visibility: 'normal' } }];
  });
}
