import { lifeChanges, LIFE_KINDS, lifeSerial, parseLifeEvents, type LifeEvent } from './life.ts';
import { romanceChanges, ROMANCE_KINDS, parseRomanceEvents, type RomanceEvent } from './romance.ts';
import { storyChanges, STORY_KINDS, parseStoryEvents, type StoryEvent } from './town-stories.ts';
import { longGoalChanges, LONG_GOAL_KINDS, parseLongGoalEvents, type LongGoalEvent } from './long-goals.ts';
import { goalResultChanges, GOAL_RESULT_KINDS, parseGoalResultEvents, type GoalResultEvent } from './goal-results.ts';
import type { Json, NpcChange, NpcState } from '../types.ts';

export type LifeJournalEvent = LifeEvent | RomanceEvent | StoryEvent | LongGoalEvent | GoalResultEvent;

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
    if ((LONG_GOAL_KINDS as readonly unknown[]).includes(raw.kind)) return parseLongGoalEvents([raw])[0]!;
    if ((GOAL_RESULT_KINDS as readonly unknown[]).includes(raw.kind)) return parseGoalResultEvents([raw])[0]!;
    throw new Error('INVALID_LIFE_EVENT: unknown kind');
  });
}

/** Project all private namespaces before returning one atomic change per NPC to the save bridge. */
export function lifeJournalChanges(events: readonly LifeJournalEvent[], prior: Readonly<Record<string, NpcState>>): NpcChange[] {
  const batch = parseLifeJournal(events);
  const ordinary = batch.filter((event): event is LifeEvent => (LIFE_KINDS as readonly string[]).includes(event.kind));
  const romance = batch.filter((event): event is RomanceEvent => event.kind.startsWith('romance.'));
  const stories = batch.filter((event): event is StoryEvent => event.kind.startsWith('story.'));
  const longGoals = batch.filter((event): event is LongGoalEvent => event.kind.startsWith('longgoal.'));
  const goalResults = batch.filter((event): event is GoalResultEvent => event.kind.startsWith('goalresult.'));
  const storyProjection = storyChanges(stories, prior);
  // A continuation may follow its prerequisite in this same replay batch. The goal validates source order and day.
  const withStories: Record<string, NpcState> = { ...prior };
  for (const change of storyProjection) withStories[change.npcId] = { ...prior[change.npcId], story: change.state!.story! };
  const longGoalProjection = longGoalChanges(longGoals, withStories);
  const withLongGoals: Record<string, NpcState> = { ...withStories };
  for (const change of longGoalProjection)
    withLongGoals[change.npcId] = { ...withStories[change.npcId], longGoal: change.state!.longGoal! };
  const groups = [
    ['life', lifeChanges(ordinary, prior)],
    ['romance', romanceChanges(romance, prior)],
    ['story', storyProjection],
    ['longGoal', longGoalProjection],
    ['goalResult', goalResultChanges(goalResults, withLongGoals)],
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
