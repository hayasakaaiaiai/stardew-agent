import type { Remembered } from './dialogue.ts';

/** Keep the model's salience decision, but source every fact from the actual current player utterance. */
export function sourceRemembered(playerLine: string, remembered: readonly Remembered[], opening: boolean): Remembered[] {
  if (opening || !playerLine.trim() || remembered.length === 0) return [];
  return [{ text: `农场主说：${JSON.stringify(playerLine)}`, importance: Math.max(...remembered.map(item => item.importance)) }];
}
