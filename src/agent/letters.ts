/** A short letter an NPC writes at night, in the player's mailbox the next morning (docs/npc-mail.md). */
import type { Standing } from './dialogue.ts';
import type { Gift } from '../services/roster/index.ts';
import type { NpcState } from '../types.ts';
import { digest } from '../validation.ts';

export interface Letter {
  text: string;
  /** The most important memory of that night, to pick one letter when several NPCs wrote. */
  importance: number;
  /** A gift from the NPC's card, by its name in the game; the Mod finds the item (docs/npc-mail.md §8). */
  item?: string;
}

/** What the Mod puts in the mailbox; the key is stable for one save point. */
export interface DeliveredLetter {
  key: string;
  npc: string;
  text: string;
  item?: string;
}

const MAX_CHARS = 100;
/** Characters the game reads as commands in letters (`^` line break, `@` player name, `%item` …). */
const COMMANDS = /[\^@%#${}*[\]|]/g;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
/**
 * Letters are read the morning after, so “今天/昨天” are right and “明天/后天” are a day off. Claims of progress
 * made off-screen are refused; “就好了” (would be nice) and “……了吗” questions are not claims.
 */
const UNSAFE = /已|昨晚|昨夜|今晚|刚才|大前天|前天|明天|大后天|后天|(?<!就)(?:好|完|齐)了(?![吗没])|(?:扛|带|拿|买|折|削|凑|找|备|弄|做|转)(?:来|回|出|到|成){0,2}了(?![吗没])/;

/** Undefined when the letter must not be sent; one bad sentence stops the whole letter. */
export function safeLetter(text: string): string | undefined {
  const clean = text.replace(COMMANDS, '').replace(EMOJI, '').replace(/\s+/g, ' ').trim();
  if (!clean || Array.from(clean).length > MAX_CHARS || UNSAFE.test(clean)) return undefined;
  return clean;
}

/** Only the morning after the night that wrote it. */
export function letterFor(state: NpcState, today: number): Letter | undefined {
  const letter = state.letter;
  if (state.day !== today - 1 || !letter || typeof letter !== 'object' || Array.isArray(letter)) return undefined;
  const text = typeof letter.text === 'string' ? safeLetter(letter.text) : undefined;
  if (!text) return undefined;
  const item = typeof letter.item === 'string' && letter.item ? { item: letter.item } : {};
  return { text, importance: Number.isInteger(letter.importance) ? letter.importance as number : 0, ...item };
}

/** Gifts only between good friends or closer (docs/npc-mail.md §8). */
export const GIFT_MIN_HEARTS = 6;
/** An NPC sends at most one gift in this many game days. */
export const GIFT_COOLDOWN_DAYS = 7;
const CLOSE = new Set<Standing['relation']>(['dating', 'engaged', 'married', 'roommate']);

/**
 * The one card gift this NPC could enclose tonight. The code picks it, rotating through the card by day, so
 * nothing the player says in a conversation decides what is given; the model only decides whether to enclose it.
 * Lines marked 婚后 (and the 同上 lines after them) need marriage. `usable` narrows the choice afterwards, so a 同上
 * line still follows the line it refers to.
 */
export function giftFor(gifts: readonly Gift[], standing: Pick<Standing, 'hearts' | 'relation'> | undefined,
  state: NpcState, day: number, usable: (gift: Gift) => boolean = () => true): Gift | undefined {
  if (!standing || (standing.hearts < GIFT_MIN_HEARTS && !CLOSE.has(standing.relation))) return undefined;
  if (typeof state.lastGiftDay === 'number' && day - state.lastGiftDay < GIFT_COOLDOWN_DAYS) return undefined;
  const married = standing.relation === 'married' || standing.relation === 'roommate';
  let marriedOnly = false;
  const allowed = gifts.filter((gift) => {
    marriedOnly = gift.text.startsWith('婚后') || (gift.text.startsWith('同上') && marriedOnly);
    return married || !marriedOnly;
  }).filter(usable);
  return allowed.length ? allowed[day % allowed.length] : undefined;
}

/** The game's mail key: the same letter from the same save point is never put in the mailbox twice. */
export function letterKey(lineageId: string, commitId: string, npcId: string): string {
  return `StardewAgent.${digest(`${lineageId}\n${commitId}\n${npcId}`).slice(0, 16)}`;
}
