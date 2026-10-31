import type { Emotion } from './dialogue.ts';

/**
 * What each NPC's vanilla portrait sheet can show (Stardew Valley 1.6.15 Content/Portraits, docs/portrait-emotions.md).
 * Frames 0–5 are neutral, $h, $s, $u, $l and $a; vanilla draws frame 0 for an index past the end of the sheet.
 */
const FRAMES: Readonly<Record<string, number>> = {
  dwarf: 1, wizard: 2,
  caroline: 4, evelyn: 4, george: 4, gus: 4, leo: 4, sandy: 4, vincent: 4, willy: 4,
};

/** The startled frame some sheets add after vanilla's six; mod/StardewAgentBridge/VanillaDialogue.cs has the same list. */
export const SURPRISED_FRAMES: Readonly<Record<string, number>> = {
  abigail: 7, alex: 7, demetrius: 6, elliott: 8, emily: 6, haley: 8,
  harvey: 8, leah: 6, maru: 9, penny: 12, sam: 8, shane: 10,
};

/** In the order the rule lists them, each with the frame it needs. */
const STANDARD: readonly (readonly [Emotion, number])[] = [
  ['neutral', 0], ['happy', 1], ['sad', 2], ['blush', 4], ['angry', 5], ['special', 3],
];

/** Vanilla's six, for a prompt built without knowing whose portrait it is. */
export const VANILLA_EMOTIONS: readonly Emotion[] = STANDARD.map(([emotion]) => emotion);

/** The emotions this NPC's portrait can show; an unknown id gets vanilla's six. */
export function emotionsFor(npcId: string): Emotion[] {
  const frames = Object.hasOwn(FRAMES, npcId) ? FRAMES[npcId]! : 6;
  const emotions = STANDARD.filter(([, frame]) => frame < frames).map(([emotion]) => emotion);
  return Object.hasOwn(SURPRISED_FRAMES, npcId) ? [...emotions, 'surprised'] : emotions;
}

export function emotionRule(emotions: readonly Emotion[]): string {
  return `- emotion：说这句话时的表情，取 ${emotions.join('、')} 之一。`;
}
