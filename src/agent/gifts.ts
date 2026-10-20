/**
 * Gifts the player gives, remembered by the NPC that got them (docs/npc-gifts.md). The vanilla game already
 * changes friendship and shows its reaction; this only writes a note, from a template, without a model call.
 */
import type { MemoryDraft } from '../types.ts';

/** The game's own taste for the item, so the note never contradicts the vanilla reaction. */
export const GIFT_TASTES = ['love', 'like', 'neutral', 'dislike', 'hate'] as const;
export type GiftTaste = typeof GIFT_TASTES[number];

export interface GivenGift {
  /** The item's display name in the game language. */
  item: string;
  taste: GiftTaste;
  birthday: boolean;
}

const FEELINGS: Record<GiftTaste, string> = {
  love: '我特别喜欢', like: '我挺喜欢', neutral: '说不上喜欢不喜欢', dislike: '我不太喜欢', hate: '我很讨厌这东西',
};
/** Strong reactions reach even a barely known NPC's recall threshold of 4 (docs/dialogue-prototype.md §14). */
const IMPORTANCE: Record<GiftTaste, number> = { love: 4, like: 3, neutral: 2, dislike: 3, hate: 4 };
const MAX_ITEM_CHARS = 30;
/** Characters the game reads as commands in dialogue (docs/game-bridge.md §4.2), and quote marks. */
const COMMANDS = /[\^#$@%{}*[\]|「」"“”]/g;

/** Undefined when nothing printable is left. */
export function giftItemName(name: string): string | undefined {
  const clean = name.replace(COMMANDS, '').replace(/\s+/g, ' ').trim();
  return clean ? Array.from(clean).slice(0, MAX_ITEM_CHARS).join('') : undefined;
}

/** No relative dates in the text: recall adds “今天 / 3 天前” itself. The shortest wording measured (§4). */
export function giftMemory(gift: GivenGift): MemoryDraft {
  return {
    text: `农场主送我${gift.item}${gift.birthday ? '当生日礼物' : ''}，${FEELINGS[gift.taste]}。`,
    importance: Math.min(5, IMPORTANCE[gift.taste] + (gift.birthday ? 1 : 0)),
    kind: 'observation', subjects: ['player'], visibility: 'private',
  };
}
