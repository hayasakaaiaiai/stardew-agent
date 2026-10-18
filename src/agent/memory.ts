import type { Memory, RecallOptions, RecallResult } from '../types.ts';
import { integer, requireValue } from '../validation.ts';
import { tokenize } from '../services/store/tokenizer.ts';

/** Same tokenizer for committed and uncommitted memories; no LLM call during retrieval. */
export function rankMemories(memories: Memory[], options: RecallOptions): RecallResult[] {
  const limit = options.limit ?? 8;
  const maxChars = options.maxChars ?? 4000;
  integer(options.nowGameTime, 'nowGameTime');
  integer(limit, 'limit', 1); integer(maxChars, 'maxChars', 1);
  requireValue(limit <= 50 && maxChars <= 100_000, 'INVALID_INPUT', 'Recall budget is too large');
  requireValue((options.query?.length ?? 0) <= 2000, 'INVALID_INPUT', 'Recall query is too long');
  requireValue(options.query === undefined || typeof options.query === 'string', 'INVALID_INPUT', 'Recall query must be text');
  if (options.topics !== undefined) requireValue(Array.isArray(options.topics) && options.topics.length <= 30
    && options.topics.every(topic => typeof topic === 'string' && topic.length > 0 && topic.length <= 200),
    'INVALID_INPUT', 'Recall topics must be 1–200 character tags (at most 30)');
  const terms = tokenize(options.query ?? '').slice(0, 32);
  const ranked: RecallResult[] = [];
  for (const memory of memories) {
    if (options.sharedScene && memory.visibility === 'private') continue;
    if (options.topics?.length && !memory.topics.some(topic => options.topics!.includes(topic))) continue;
    const words = new Set(tokenize([memory.text, ...memory.subjects, ...memory.topics].join(' ')));
    const matched = terms.filter(term => words.has(term)).length;
    if (terms.length && !matched) continue;
    const relevance = terms.length ? matched / terms.length : 0;
    const ageInDays = Math.max(0, options.nowGameTime - memory.gameTime) / 1440;
    const score = relevance * 4 + memory.importance / 5 + 1 / (1 + ageInDays);
    ranked.push({ ...memory, score });
  }
  ranked.sort((a, b) => b.score - a.score || b.gameTime - a.gameTime || a.id.localeCompare(b.id));
  let remaining = maxChars;
  const result: RecallResult[] = [];
  for (const memory of ranked) {
    // Character budget, deliberately not advertised as an exact model-token budget.
    const length = Array.from(memory.text).length;
    if (length > remaining) continue;
    result.push(memory); remaining -= length;
    if (result.length === limit) break;
  }
  return result;
}
