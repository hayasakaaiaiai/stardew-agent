/**
 * News one NPC passes to another when they chat in town (docs/npc-news.md, design §7.5): the NPC itself decides at
 * night what it would tell others, and whoever hears it remembers “A told me …” with A as the source.
 */
import type { MemoryDraft, NpcState } from '../types.ts';

const MAX_CHARS = 30;
/** Characters the game reads as commands in on-screen text (docs/game-bridge.md §4.2). */
const COMMANDS = /[\^#$@%{}*[\]|]/g;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
/** It is told the day after it was written, so relative days would be a day off. */
const UNSAFE = /今天|明天|昨天|前天|后天|今晚|昨晚|昨夜|刚才/;

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

/**
 * What the listener keeps: the teller's own words, quoted so that “我” stays the teller's, and taken from the
 * night's output, never from the line shown on screen.
 */
export function heardMemory(teller: { id: string; name: string }, share: string): MemoryDraft {
  return { text: `${teller.name}跟我说：${JSON.stringify(share)}`, importance: 3, kind: 'heard', subjects: ['player', teller.id],
    visibility: 'normal' };
}
