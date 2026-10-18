import { createHash } from 'node:crypto';
import type { DayEntry, DaySnapshot, Json, Memory, MemoryDraft, NpcChange } from './types.ts';

export class MemoryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
  }
}

export function requireValue(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new MemoryError(code, message);
}

export function identifier(value: unknown, name: string): asserts value is string {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 200
    && !/[\u0000-\u001f]/u.test(value), 'INVALID_INPUT', `${name} must be a non-empty identifier (max 200 characters)`);
}

export function integer(value: unknown, name: string, min = 0): asserts value is number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= min,
    'INVALID_INPUT', `${name} must be a safe integer >= ${min}`);
}

/** Canonical JSON also rejects values that structuredClone or JSON would silently alter. */
export function canonical(value: unknown): string {
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): Json {
    requireValue(depth <= 30, 'INVALID_INPUT', 'JSON is too deeply nested');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      requireValue(Number.isFinite(item), 'INVALID_INPUT', 'JSON numbers must be finite');
      return item;
    }
    requireValue(typeof item === 'object' && item !== null, 'INVALID_INPUT', 'Expected plain JSON data');
    requireValue(!seen.has(item), 'INVALID_INPUT', 'Circular JSON is not supported');
    seen.add(item);
    try {
      if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
      requireValue(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null,
        'INVALID_INPUT', 'Expected a plain JSON object');
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, visit((item as Record<string, unknown>)[key], depth + 1)]));
    } finally { seen.delete(item); }
  }
  const result = JSON.stringify(visit(value, 0));
  requireValue(result.length <= 1_000_000, 'INVALID_INPUT', 'JSON record exceeds the size limit');
  return result;
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function validateChanges(changes: NpcChange[], allowEmpty = false): void {
  requireValue(Array.isArray(changes) && (allowEmpty || changes.length > 0) && changes.length <= 100,
    'INVALID_INPUT', 'An event needs 1–100 NPC changes');
  const ids = new Set<string>();
  for (const change of changes) {
    identifier(change.npcId, 'npcId');
    requireValue(!ids.has(change.npcId), 'INVALID_INPUT', 'An event can change each NPC only once');
    ids.add(change.npcId);
    for (const value of [change.log, change.state]) {
      if (value !== undefined) requireValue(typeof value === 'object' && value !== null && !Array.isArray(value),
        'INVALID_INPUT', 'State and log must be JSON objects');
    }
    requireValue((change.memories?.length ?? 0) <= 100, 'INVALID_INPUT', 'Too many memories in one change');
    for (const memory of change.memories ?? []) validateMemory(memory);
    for (const id of change.retireMemoryIds ?? []) identifier(id, 'retireMemoryId');
  }
  canonical(changes);
}

function validateMemory(memory: MemoryDraft): void {
  requireValue(typeof memory.text === 'string' && memory.text.trim().length > 0 && memory.text.length <= 8000,
    'INVALID_INPUT', 'Memory text must contain 1–8000 characters');
  if (memory.kind !== undefined) requireValue(['conversation', 'observation', 'heard', 'reflection', 'summary'].includes(memory.kind),
    'INVALID_INPUT', 'Unknown memory kind');
  if (memory.visibility !== undefined) requireValue(['private', 'normal'].includes(memory.visibility), 'INVALID_INPUT', 'Unknown visibility');
  if (memory.importance !== undefined) {
    integer(memory.importance, 'importance');
    requireValue(memory.importance <= 5, 'INVALID_INPUT', 'Importance must be between 0 and 5');
  }
  for (const values of [memory.subjects, memory.topics]) {
    if (values === undefined) continue;
    requireValue(Array.isArray(values) && values.length <= 30, 'INVALID_INPUT', 'Too many memory tags');
    for (const value of values) identifier(value, 'memory tag');
  }
}

export function validateEntry(entry: DayEntry): void {
  integer(entry.seq, 'seq', 1);
  integer(entry.gameTime, 'gameTime');
  validateChanges(entry.changes);
  canonical(entry);
}

export function validateSnapshot(snapshot: DaySnapshot): void {
  identifier(snapshot.lineageId, 'lineageId');
  identifier(snapshot.loadNonce, 'loadNonce');
  identifier(snapshot.baseCommitId, 'baseCommitId');
  integer(snapshot.day, 'day', 1);
  let previous = 0;
  for (const entry of snapshot.entries) {
    validateEntry(entry);
    requireValue(entry.seq > previous, 'INVALID_INPUT', 'Snapshot events must have increasing sequence numbers');
    previous = entry.seq;
  }
}

export function materialize(draft: MemoryDraft, npcId: string, sourceId: string, index: number,
  gameTime: number, commitId: string | null): Memory {
  return {
    id: digest(`${sourceId}\n${npcId}\n${index}`), commitId, npcId, gameTime,
    text: draft.text, kind: draft.kind ?? 'conversation', importance: draft.importance ?? 2,
    subjects: draft.subjects ?? [], topics: draft.topics ?? [], visibility: draft.visibility ?? 'private', sourceId,
  };
}

export function sourceId(snapshot: Pick<DaySnapshot, 'lineageId' | 'loadNonce' | 'day'>, seq: number): string {
  return digest(canonical([snapshot.lineageId, snapshot.loadNonce, snapshot.day, seq]));
}
