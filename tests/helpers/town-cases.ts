import { townCaseDefinition, type TownCaseId } from '../../src/agent/town-cases.ts';
import type { StoryEvent } from '../../src/agent/town-stories.ts';

/** Two exact witnesses and two distinct kinds of native evidence; no fictional object or reward. */
export function caseHistory(storyId: TownCaseId = 'caroline_route_notes', outcome: 'a' | 'b' = 'a', startSerial = 1, startDay = 10): StoryEvent[] {
  const definition = townCaseDefinition(storyId)!;
  let serial = startSerial;
  const base = { npc: definition.owner, storyId, day: startDay };
  const events: StoryEvent[] = [{ ...base, id: `life-${serial++}`, kind: 'story.started' }];
  for (const clue of definition.clues) events.push({ ...base, id: `life-${serial++}`, kind: 'story.clue', clueId: clue.id, other: clue.witness });
  let firstSource = '';
  for (const [index, point] of definition.inspections.entries()) {
    const event: StoryEvent = { ...base, id: `life-${serial++}`, kind: 'story.inspected', clueId: point.id, venue: point.venue,
      x: 10, y: 10, time: 1000 + index * 100, minutes: 10 };
    if (point.mode === 'site') {
      event.x = point.site.x; event.y = point.site.y; event.weather = index ? 'rain' : 'sunny';
      if (point.after) { event.sourceId = firstSource; event.day = startDay + 1; }
    } else if (point.mode === 'sample') { event.itemId = point.itemId; event.count = 1; }
    else { event.time = point.from + 10; event.subject = point.subject; event.subjectX = 14; event.subjectY = 10; }
    firstSource ||= event.id;
    events.push(event);
  }
  events.push({ ...base, id: `life-${serial}`, day: events.at(-1)!.day, kind: 'story.resolved', outcome });
  return events;
}

export function reportCaseSource(history: readonly StoryEvent[], sourceIndex: number, serial: number, day?: number): StoryEvent {
  const source = history[sourceIndex]!;
  return { id: `life-${serial}`, npc: source.npc, day: day ?? source.day, kind: 'story.told', storyId: source.storyId, sourceId: source.id };
}
