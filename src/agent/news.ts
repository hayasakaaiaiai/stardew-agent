/**
 * News one NPC passes to another (docs/npc-news.md, docs/offscreen-news.md, design §7.5): the NPC itself decides at
 * night what it would tell others, and whoever hears it remembers “A told me …” with A as the source. Whoever heard it
 * first-hand may pass it on once more; it only travels on the day after the night that wrote it.
 */
import type { DayEntry, MemoryDraft, NpcState } from '../types.ts';

const MAX_CHARS = 30;
/** Characters the game reads as commands in on-screen text (docs/game-bridge.md §4.2). */
const COMMANDS = /[\^#$@%{}*[\]|]/g;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
/** It is told the day after it was written, so relative days would be a day off. */
const UNSAFE = /今天|明天|昨天|前天|后天|今晚|昨晚|昨夜|刚才/;
/** The NPC who decided to tell it is the first hand; whoever heard it from them is the second and last. */
export const MAX_HANDS = 2;

/** One piece of news as someone can tell it: whose news it is, their words, and how many tellers from them. */
export interface NewsItem { origin: string; share: string; hand: 1 | 2 }
/** What a listener heard, as written in its day log. */
export interface HeardLog extends NewsItem { from: string }
export interface Transfer { listener: string; from: string; item: NewsItem }
/** What an NPC can tell today, and whose news it already knows (its own included). */
export interface Gossip { tellable: NewsItem[]; known: ReadonlySet<string> }

/** Undefined when it must not be passed on; the text is cleaned, never rewritten. */
export function safeShare(text: string): string | undefined {
  const clean = text.replace(COMMANDS, '').replace(EMOJI, '').replace(/\s+/g, ' ').trim();
  if (!clean || Array.from(clean).length > MAX_CHARS || UNSAFE.test(clean)) return undefined;
  return clean;
}

/** Only the day after the night that wrote it, like bubbles (docs/npc-bubbles.md). */
export function shareFor(state: NpcState, today: number): string | undefined {
  return state.day === today - 1 && typeof state.share === 'string' ? safeShare(state.share) : undefined;
}

function isHeard(value: unknown): value is HeardLog {
  const item = value as Partial<HeardLog> | null;
  return !!item && typeof item.origin === 'string' && typeof item.from === 'string' && typeof item.share === 'string'
    && (item.hand === 1 || item.hand === 2);
}

/** Everything this NPC heard today, from its own day log. */
export function heardToday(entries: readonly DayEntry[], npcId: string): HeardLog[] {
  return entries.flatMap((entry) => {
    const heard = entry.changes.find((change) => change.npcId === npcId)?.log?.heard;
    return Array.isArray(heard) ? (heard as unknown[]).filter(isHeard) : [];
  });
}

/** Its own news first, then what it heard first-hand; second-hand news goes no further. */
export function gossipOf(npcId: string, share: string | undefined, heard: readonly HeardLog[]): Gossip {
  const tellable: NewsItem[] = [
    ...(share ? [{ origin: npcId, share, hand: 1 as const }] : []),
    ...heard.filter((item) => item.hand < MAX_HANDS).map((item) => ({ origin: item.origin, share: item.share, hand: 2 as const })),
  ];
  return { tellable, known: new Set([npcId, ...heard.map((item) => item.origin)]) };
}

/** The first thing `from` can tell `to` that `to` does not know yet. */
export function newsFor(from: Gossip | undefined, to: Gossip | undefined): NewsItem | undefined {
  return from?.tellable.find((item) => !to?.known.has(item.origin));
}

/**
 * Who learns what when these groups spend an hour together. Tellers only use what they knew before the hour, so
 * news moves at most one teller per hour; a listener takes each origin's news once, first-hand before second-hand.
 */
export function spread(groups: readonly (readonly string[])[], people: Readonly<Record<string, Gossip>>): Transfer[] {
  const known = new Map(Object.entries(people).map(([id, gossip]) => [id, new Set(gossip.known)]));
  const transfers: Transfer[] = [];
  for (const group of groups) {
    const offers = group.flatMap((from) => (people[from]?.tellable ?? []).map((item) => ({ from, item })))
      .sort((x, y) => x.item.hand - y.item.hand);
    for (const { from, item } of offers) {
      for (const listener of group) {
        const knows = known.get(listener);
        if (listener === from || !knows || knows.has(item.origin)) continue;
        knows.add(item.origin);
        transfers.push({ listener, from, item });
      }
    }
  }
  return transfers;
}

/** How a teller passes it on in a scene: their own words, or whose words they are repeating. */
export function newsLine(item: NewsItem, name: (id: string) => string): string {
  return item.hand === 1 ? JSON.stringify(item.share) : `${name(item.origin)}说过：${JSON.stringify(item.share)}`;
}

/**
 * What the listener keeps: the original words, quoted so that “我” stays the origin's, and taken from the night's
 * output, never from a line shown on screen. Second-hand news is less certain, so it matters less.
 */
export function heardMemory(transfer: Transfer, name: (id: string) => string): MemoryDraft {
  const { from, item } = transfer;
  return item.hand === 1
    ? { text: `${name(from)}跟我说：${JSON.stringify(item.share)}`, importance: 3, kind: 'heard', subjects: ['player', from], visibility: 'normal' }
    : { text: `${name(from)}跟我说，${name(item.origin)}说过：${JSON.stringify(item.share)}`, importance: 2, kind: 'heard',
      subjects: ['player', item.origin, from], visibility: 'normal' };
}
