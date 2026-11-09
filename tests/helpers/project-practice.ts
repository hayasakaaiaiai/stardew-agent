import { longGoalDefinition, type LongGoalEvent, type LongGoalId } from '../../src/agent/long-goals.ts';
import type { GoalResultEvent } from '../../src/agent/goal-results.ts';
import type { LifeJournalEvent } from '../../src/agent/life-journal.ts';
import type { StoryEvent, StoryId } from '../../src/agent/town-stories.ts';

/** Real predecessor work and six distinct project workdays, without invented contributions. */
export function completedProject(projectId: LongGoalId = 'leah_form_study'): LifeJournalEvent[] {
  const goal = longGoalDefinition(projectId)!;
  const prefix: StoryEvent[] = goal.requiresStory ? [
    { id: 'life-1', npc: goal.owner, day: 1, kind: 'story.started', storyId: goal.requiresStory as StoryId },
    { id: 'life-2', npc: goal.owner, day: 2, kind: 'story.worked', storyId: goal.requiresStory as StoryId, step: 1, venue: goal.owner === 'penny' ? 'Town' : 'Beach', minutes: 30 },
    { id: 'life-3', npc: goal.owner, day: 3, kind: 'story.worked', storyId: goal.requiresStory as StoryId, step: 2, venue: goal.owner === 'penny' ? 'Town' : 'Beach', minutes: 30 },
    { id: 'life-4', npc: goal.owner, day: 3, kind: 'story.resolved', storyId: goal.requiresStory as StoryId, outcome: 'independent' },
  ] : [];
  const base = { npc: goal.owner, longGoalId: projectId };
  const events: LongGoalEvent[] = [{ ...base, id: 'life-10', day: 4, kind: 'longgoal.started',
    ...(goal.requiresStory ? { dependencySourceId: 'life-4' } : {}) }];
  for (const chapter of goal.chapters) {
    const serial = 11 + (chapter.id - 1) * 3, day = 5 + (chapter.id - 1) * 2;
    events.push({ ...base, id: `life-${serial}`, day, kind: 'longgoal.worked', chapterId: chapter.id, step: 1, venue: goal.workVenues[0]!, minutes: 30 },
      { ...base, id: `life-${serial + 1}`, day: day + 1, kind: 'longgoal.worked', chapterId: chapter.id, step: 2, venue: goal.workVenues[0]!, minutes: 30 },
      { ...base, id: `life-${serial + 2}`, day: day + 1, kind: 'longgoal.completed', chapterId: chapter.id, outcome: 'default' });
  }
  return [...prefix, ...events];
}

export function completedPractice(projectId: LongGoalId = 'leah_form_study', choiceId: 'a' | 'b' = 'a', day = 10,
  serial = 20): GoalResultEvent[] {
  const goal = longGoalDefinition(projectId)!;
  const walk = !['willy', 'linus'].includes(goal.owner);
  const points = ['leah', 'robin'].includes(goal.owner) ? 3 : walk ? 2 : 1;
  const venue = ({ penny: 'Forest', elliott: 'Beach', leah: 'Forest', maru: 'Mountain', robin: 'Town', willy: 'Beach', linus: 'Forest' } as Record<string, string>)[goal.owner]!;
  const base = { npc: goal.owner, projectId, day };
  const attemptId = `life-${serial++}`;
  const events: GoalResultEvent[] = [{ ...base, id: attemptId, kind: 'goalresult.started', sourceId: 'life-19', choiceId }];
  for (let point = 1; point <= points; point++) {
    const [x, y] = point === 1 ? [10, 10] : point === 2 ? [20, 10] : goal.owner === 'robin' ? [11, 10] : [20, 20];
    events.push({ ...base, id: `life-${serial++}`, kind: 'goalresult.checkpoint', attemptId, point, venue, x: x!, y: y!,
      time: 1000 + point * 10, weather: 'windy', minutes: walk ? point * 10 : 20, count: walk ? 0 : 1, choiceId });
  }
  const sourceId = events.at(-1)!.id;
  events.push({ ...base, id: `life-${serial}`, kind: 'goalresult.completed', attemptId, sourceId, minutes: walk ? 30 : 20,
    count: walk ? 0 : goal.owner === 'linus' && choiceId === 'b' ? 2 : 1, choiceId });
  return events;
}

export function reviewPractice(events: readonly GoalResultEvent[], choiceId: 'a' | 'b' = 'a', day?: number): GoalResultEvent {
  const completion = events.at(-1)!;
  return { id: `life-${Number(completion.id.slice(5)) + 1}`, npc: completion.npc, projectId: completion.projectId,
    day: day ?? completion.day + 1, kind: 'goalresult.reviewed', sourceId: completion.id, choiceId };
}
