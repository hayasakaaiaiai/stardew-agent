/**
 * A close NPC may hand the player something from its card when they first talk on a day: the `gift.give` action
 * of design §8 (docs/npc-in-person-gifts.md). The code picks the item and shares the letters' cooldown, so a gift
 * comes at most once a week per NPC however it arrives; the model only decides whether to hand it over.
 */
import { OPENING_LINE, type DialogueMemory } from './dialogue.ts';
import { giftFor } from './letters.ts';
import type { Gift } from '../services/roster/index.ts';
import type { Memory, MemoryDraft, NpcState } from '../types.ts';

/**
 * Marks the note written when something is handed over. The cooldown is read from these notes rather than from
 * NPC state: state is a whole snapshot, and writing one during the day could hide last night's consolidation if it
 * finishes later; the note is saved with the day either way.
 */
export const GIVEN_TOPIC = '当面送礼';

/** Many card gifts are written for the mailbox (“随信寄来”), and money only ever comes as a cheque. */
export function handable(gift: Gift): boolean {
  return !/随信|寄/.test(gift.text) && !/^\d+\s*金$/.test(gift.item);
}

export function givenMemory(item: string): MemoryDraft {
  return { text: `我当面送了农场主${item}。`, importance: 3, kind: 'observation', subjects: ['player'],
    topics: [GIVEN_TOPIC], visibility: 'private' };
}

/** The state `giftFor` sees: the later of a letter's gift and the last thing handed over. */
export function withGivenCooldown(state: NpcState, memories: readonly Pick<Memory, 'topics' | 'gameTime'>[]): NpcState {
  const days = memories.filter(memory => memory.topics.includes(GIVEN_TOPIC)).map(memory => Math.floor(memory.gameTime / 1440));
  if (typeof state.lastGiftDay === 'number') days.push(state.lastGiftDay);
  return days.length ? { ...state, lastGiftDay: Math.max(...days) } : state;
}

/**
 * Offers the day's gift only on the first opening of the day. Not when yesterday's plan leads the opening: that
 * reply is cut down to questions (docs/next-day-plans.md), which would drop the line that hands it over.
 */
export function withInPersonGift(memory: DialogueMemory, options: {
  gifts: readonly Gift[];
  now: () => number;
  /** This NPC's state and its notes marked GIVEN_TOPIC, today's included. */
  read: () => Promise<{ state: NpcState; given: readonly Memory[] }>;
}): DialogueMemory & { offered(): Gift | undefined } {
  let offer: Gift | undefined;
  return {
    offered: () => offer,
    async context(query, standing) {
      offer = undefined;
      const context = await memory.context(query, standing);
      if (query !== OPENING_LINE || context.today?.length || context.replyView) return context;
      const { state, given } = await options.read();
      offer = giftFor(options.gifts, standing, withGivenCooldown(state, given), Math.floor(options.now() / 1440), handable);
      return offer ? { ...context, offer: { item: offer.item, text: offer.text } } : context;
    },
    record: (exchange, remembered) => memory.record(exchange, remembered),
  };
}
