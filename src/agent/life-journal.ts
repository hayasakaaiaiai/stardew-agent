import { lifeChanges, LIFE_KINDS, lifeSerial, parseLifeEvents, type LifeEvent } from './life.ts';
import { romanceChanges, ROMANCE_KINDS, parseRomanceEvents, type RomanceEvent } from './romance.ts';
import { storyChanges, STORY_KINDS, parseStoryEvents, type StoryEvent } from './town-stories.ts';
import type { Json, NpcChange, NpcState } from '../types.ts';

export type LifeJournalEvent = LifeEvent | RomanceEvent | StoryEvent;

/** All domains use the same durable native serial, so validate order before splitting a batch. */
export function parseLifeJournal(value: unknown): LifeJournalEvent[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('INVALID_LIFE_EVENT: events must contain at most 32 observations');
  let previous = 0;
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.id !== 'string')
      throw new Error('INVALID_LIFE_EVENT: observation and id are required');
    const serial = lifeSerial(raw.id);
    if (serial <= previous) throw new Error('INVALID_LIFE_EVENT: events must have increasing serials');
    previous = serial;
    if ((LIFE_KINDS as readonly unknown[]).includes(raw.kind)) return parseLifeEvents([raw])[0]!;
    if ((ROMANCE_KINDS as readonly unknown[]).includes(raw.kind)) return parseRomanceEvents([raw])[0]!;
    if ((STORY_KINDS as readonly unknown[]).includes(raw.kind)) return parseStoryEvents([raw])[0]!;
    throw new Error('INVALID_LIFE_EVENT: unknown kind');
  });
}

/** Project all private namespaces before returning one atomic change per NPC to the save bridge. */
export function lifeJournalChanges(events: readonly LifeJournalEvent[], prior: Readonly<Record<string, NpcState>>): NpcChange[] {
  const batch = parseLifeJournal(events);
  const ordinary = batch.filter((event): event is LifeEvent => (LIFE_KINDS as readonly string[]).includes(event.kind));
  const romance = batch.filter((event): event is RomanceEvent => event.kind.startsWith('romance.'));
  const stories = batch.filter((event): event is StoryEvent => event.kind.startsWith('story.'));
  const groups = [
    ['life', lifeChanges(ordinary, prior)],
    ['romance', romanceChanges(romance, prior)],
    ['story', storyChanges(stories, prior)],
  ] as const;
  const merged = new Map<string, NpcChange>();
  for (const [namespace, changes] of groups) for (const change of changes) {
    const existing = merged.get(change.npcId);
    merged.set(change.npcId, {
      npcId: change.npcId,
      state: { ...existing?.state, [namespace]: change.state![namespace]! },
      log: { ...existing?.log, ...change.log },
      memories: [...(existing?.memories ?? []), ...(change.memories ?? [])],
    });
  }
  return [...merged.values()];
}

/** The game has already applied these changes; record the same shared daily budget in native event order. */
export function journalFreshEvents(change: NpcChange): (LifeEvent | RomanceEvent)[] {
  return [...(change.log?.lifeEvents as Json[] | undefined ?? []), ...(change.log?.romanceEvents as Json[] | undefined ?? [])]
    .map(event => event as unknown as LifeEvent | RomanceEvent).sort((a, b) => lifeSerial(a.id) - lifeSerial(b.id));
}
