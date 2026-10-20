/** Lines an NPC mutters over its head the day after a nightly consolidation (docs/npc-bubbles.md). */
import type { NpcState } from '../types.ts';

export const BUBBLE_EMOTES = ['happy', 'heart', 'question', 'exclamation', 'sad', 'music', 'none'] as const;
export type BubbleEmote = typeof BUBBLE_EMOTES[number];

export interface Bubble {
  text: string;
  emote: BubbleEmote;
}

export const MAX_BUBBLES = 2;
const MAX_CHARS = 24;
/** Characters the game reads as commands in on-screen text (docs/game-bridge.md §4.2). */
const COMMANDS = /[\^#$@%{}*[\]|]/g;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
/** Claims of progress made off-screen, and relative days that would be wrong a day later. */
const UNSAFE = /已|昨晚|昨夜|刚才|大前天|前天|昨天|今天|明天|大后天|后天|(?<!就好)了/;

/** Undefined when the line must not be shown; the text is cleaned, never rewritten. */
export function safeBubble(text: string): string | undefined {
  const clean = text.replace(COMMANDS, '').replace(EMOJI, '').replace(/\s+/g, ' ').trim();
  if (!clean || Array.from(clean).length > MAX_CHARS || UNSAFE.test(clean)) return undefined;
  return clean;
}

/** Model output to stored bubbles: unusable lines are dropped, an unknown emote becomes none. */
export function parseBubbles(value: unknown): Bubble[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Bubble[] => {
    const { text, emote } = (item ?? {}) as Record<string, unknown>;
    const safe = typeof text === 'string' ? safeBubble(text) : undefined;
    if (!safe) return [];
    return [{ text: safe, emote: BUBBLE_EMOTES.includes(emote as BubbleEmote) ? emote as BubbleEmote : 'none' }];
  }).slice(0, MAX_BUBBLES);
}

/** Only the day after the night that wrote them, like the morning plan (docs/next-day-plans.md). */
export function bubblesFor(state: NpcState, today: number): Bubble[] {
  if (state.day !== today - 1) return [];
  return parseBubbles(state.bubbles);
}
