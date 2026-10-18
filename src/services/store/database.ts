import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import type { CommitRef, Consolidation, ConsolidationInput, DayEntry, DaySnapshot, Memory, NpcChange, NpcState, SessionScope, StoreCommands, StoreSearch } from '../../types.ts';
import { rankMemories } from '../../agent/memory.ts';
import { canonical, digest, identifier, materialize, requireValue, sourceId, validateChanges, validateSnapshot } from '../../validation.ts';
import { pathCte, schema } from './schema.ts';
import { ftsQuery, tokenize } from './tokenizer.ts';

type Row = Record<string, SQLOutputValue>;

function commitOf(row: Row): CommitRef {
  return { id: String(row.id), lineageId: String(row.lineage_id), parentId: row.parent_id === null ? null : String(row.parent_id),
    dayEnded: Number(row.day_ended), status: row.status as CommitRef['status'] };
}

function memoryOf(row: Row): Memory {
  return { id: String(row.id), commitId: String(row.commit_id), npcId: String(row.npc_id), gameTime: Number(row.game_time),
    text: String(row.text), kind: row.kind as Memory['kind'], importance: Number(row.importance),
    subjects: JSON.parse(String(row.subjects)) as string[], topics: JSON.parse(String(row.topics)) as string[],
    visibility: row.visibility as Memory['visibility'], sourceId: String(row.source_id) };
}

/** Lives exclusively in the DB Worker; callers never receive a raw connection. */
export class MemoryDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
    requireValue(version === 0 || version === 1, 'SCHEMA_VERSION', `Unsupported database version ${version}`);
    if (version === 0) this.transaction(() => this.db.exec(schema));
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = run();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  root(lineageId: string): CommitRef {
    identifier(lineageId, 'lineageId');
    const id = `root-${digest(lineageId)}`;
    this.transaction(() => {
      this.db.prepare('INSERT INTO lineage(id) VALUES (?) ON CONFLICT DO NOTHING').run(lineageId);
      this.db.prepare(`INSERT INTO commit_node(id, lineage_id, parent_id, day_ended, status, fingerprint)
        VALUES (?, ?, NULL, 0, 'confirmed', 'root') ON CONFLICT DO NOTHING`).run(id, lineageId);
    });
    return this.mustCommit(lineageId, id);
  }

  getCommit(lineageId: string, commitId: string): CommitRef | null {
    identifier(lineageId, 'lineageId');
    identifier(commitId, 'commitId');
    const row = this.db.prepare('SELECT * FROM commit_node WHERE id = ? AND lineage_id = ?').get(commitId, lineageId);
    return row ? commitOf(row) : null;
  }

  private mustCommit(lineageId: string, commitId: string, confirmed = true): CommitRef {
    const commit = this.getCommit(lineageId, commitId);
    requireValue(commit, 'MISSING_COMMIT', 'The requested commit does not exist in this save lineage');
    requireValue(!confirmed || commit.status === 'confirmed', 'UNCONFIRMED_COMMIT', 'Prepared commits are not readable until a game save confirms them');
    return commit;
  }

  prepare(commitId: string, snapshot: DaySnapshot): CommitRef {
    identifier(commitId, 'commitId');
    validateSnapshot(snapshot);
    // Bound individual events, not the sum of every NPC's conversations for a whole day.
    const hash = createHash('sha256').update(canonical({ lineageId: snapshot.lineageId, loadNonce: snapshot.loadNonce,
      baseCommitId: snapshot.baseCommitId, day: snapshot.day }));
    for (const entry of snapshot.entries) hash.update('\n').update(canonical(entry));
    const fingerprint = hash.digest('hex');
    const existing = this.db.prepare('SELECT * FROM commit_node WHERE id = ?').get(commitId);
    if (existing) {
      requireValue(existing.lineage_id === snapshot.lineageId && existing.fingerprint === fingerprint,
        'COMMIT_CONFLICT', 'Commit ID was already used for different data');
      return commitOf(existing);
    }
    const parent = this.mustCommit(snapshot.lineageId, snapshot.baseCommitId);
    requireValue(snapshot.day >= parent.dayEnded && snapshot.day > 0, 'INVALID_DAY', 'A commit cannot precede its parent game day');
    this.transaction(() => {
      this.db.prepare(`INSERT INTO commit_node(id, lineage_id, parent_id, day_ended, status, fingerprint)
        VALUES (?, ?, ?, ?, 'prepared', ?)`).run(commitId, snapshot.lineageId, parent.id, snapshot.day, fingerprint);
      for (const entry of snapshot.entries) {
        const eventId = sourceId(snapshot, entry.seq);
        for (const change of entry.changes) {
          this.db.prepare('INSERT INTO log(commit_id, npc_id, seq, entry) VALUES (?, ?, ?, ?)')
            .run(commitId, change.npcId, entry.seq, canonical({ ...entry, changes: [change] }));
          this.writeChange(snapshot.lineageId, commitId, change, eventId, entry.gameTime, 'day');
        }
      }
    });
    return this.mustCommit(snapshot.lineageId, commitId, false);
  }

  confirm(lineageId: string, commitId: string): CommitRef {
    const commit = this.mustCommit(lineageId, commitId, false);
    if (commit.parentId) this.mustCommit(lineageId, commit.parentId);
    this.db.prepare("UPDATE commit_node SET status = 'confirmed' WHERE id = ? AND lineage_id = ?").run(commitId, lineageId);
    return { ...commit, status: 'confirmed' };
  }

  state(scope: SessionScope): NpcState {
    this.mustCommit(scope.lineageId, scope.headCommitId);
    identifier(scope.npcId, 'npcId');
    const row = this.db.prepare(`${pathCte}
      SELECT s.state FROM npc_state s JOIN path p ON s.commit_id = p.id
      WHERE s.npc_id = ? ORDER BY p.distance, CASE s.phase WHEN 'consolidated' THEN 0 ELSE 1 END LIMIT 1`)
      .get(scope.headCommitId, scope.lineageId, scope.npcId);
    return row ? JSON.parse(String(row.state)) as NpcState : {};
  }

  search(input: StoreSearch): Memory[] {
    const { scope } = input;
    this.mustCommit(scope.lineageId, scope.headCommitId);
    identifier(scope.npcId, 'npcId');
    requireValue(Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 1000,
      'INVALID_INPUT', 'Candidate limit must be 1–1000');
    const query = ftsQuery(input.query);
    const values: SQLInputValue[] = [scope.headCommitId, scope.lineageId, scope.npcId];
    const conditions = [
      'm.npc_id = ?',
      'NOT EXISTS (SELECT 1 FROM memory_retire r JOIN path rp ON r.commit_id = rp.id WHERE r.memory_id = m.id)',
    ];
    if (input.sharedScene) conditions.push("m.visibility = 'normal'");
    if (input.excludeIds?.length) {
      conditions.push('m.id NOT IN (SELECT value FROM json_each(?))');
      values.push(JSON.stringify(input.excludeIds));
    }
    if (input.topics.length) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(m.topics) t WHERE t.value IN (SELECT value FROM json_each(?)))');
      values.push(JSON.stringify(input.topics));
    }
    if (query) { conditions.push('memory_fts MATCH ?'); values.push(query); }
    values.push(input.limit);
    const join = query ? 'JOIN memory_fts ON memory_fts.rowid = m.rowid' : '';
    const order = query ? 'bm25(memory_fts), m.importance DESC, m.game_time DESC, m.id' : 'm.game_time DESC, m.importance DESC, m.id';
    return this.db.prepare(`${pathCte} SELECT m.* FROM memory m JOIN path p ON m.commit_id = p.id
      ${join} WHERE ${conditions.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...values).map(memoryOf);
  }

  context(input: StoreCommands['context']['input']): StoreCommands['context']['output'] {
    // Validate before tokenizing or querying. One worker message also keeps state and memories consistent.
    rankMemories([], input.options);
    const committed = this.search({ scope: input.scope, query: input.options.query ?? '', topics: input.options.topics ?? [],
      sharedScene: input.options.sharedScene ?? false, limit: 200, excludeIds: input.overlay.retired });
    const retired = new Set(input.overlay.retired);
    return { state: input.options.sharedScene ? {} : input.overlay.state ?? this.state(input.scope),
      memories: rankMemories([...committed, ...input.overlay.memories].filter(memory => !retired.has(memory.id)), input.options) };
  }

  validateRetirements(scope: SessionScope, ids: string[]): void {
    this.mustCommit(scope.lineageId, scope.headCommitId);
    for (const id of ids) {
      identifier(id, 'retireMemoryId');
      const target = this.db.prepare(`${pathCte} SELECT m.id FROM memory m JOIN path p ON p.id = m.commit_id
        WHERE m.id = ? AND m.npc_id = ?`).get(scope.headCommitId, scope.lineageId, id, scope.npcId);
      requireValue(target, 'INVALID_RETIREMENT', 'Can only retire this NPC’s memories on the current branch');
    }
  }

  consolidationInput(lineageId: string, commitId: string, npcIds: string[]): ConsolidationInput {
    const commit = this.mustCommit(lineageId, commitId);
    const completed = this.db.prepare('SELECT consolidation_fingerprint FROM commit_node WHERE id = ?').get(commit.id)?.consolidation_fingerprint !== null;
    return { commit, completed, npcs: npcIds.map(npcId => ({
      npcId, state: this.state({ lineageId, headCommitId: commitId, npcId }),
      logs: this.db.prepare('SELECT entry FROM log WHERE commit_id = ? AND npc_id = ? ORDER BY seq').all(commitId, npcId)
        .map(row => JSON.parse(String(row.entry)) as DayEntry),
      memories: this.search({ scope: { lineageId, headCommitId: commitId, npcId }, query: '', topics: [], sharedScene: false, limit: 1000 }),
    })) };
  }

  consolidate(input: Consolidation): void {
    const commit = this.mustCommit(input.lineageId, input.commitId);
    validateChanges(input.changes, true);
    const fingerprint = digest(canonical(input.changes));
    const row = this.db.prepare('SELECT consolidation_fingerprint FROM commit_node WHERE id = ?').get(commit.id);
    if (row?.consolidation_fingerprint !== null) {
      requireValue(row?.consolidation_fingerprint === fingerprint, 'CONSOLIDATION_CONFLICT', 'A completed consolidation cannot be overwritten');
      return;
    }
    this.transaction(() => {
      for (const change of input.changes) this.writeChange(input.lineageId, commit.id, change,
        `consolidation:${commit.id}`, commit.dayEnded * 1440 + 1439, 'consolidated');
      this.db.prepare('UPDATE commit_node SET consolidation_fingerprint = ? WHERE id = ?').run(fingerprint, commit.id);
    });
  }

  private writeChange(lineageId: string, commitId: string, change: NpcChange, eventId: string,
    gameTime: number, phase: 'day' | 'consolidated'): void {
    if (change.state !== undefined) this.db.prepare(`INSERT INTO npc_state(commit_id, npc_id, phase, state)
      VALUES (?, ?, ?, ?) ON CONFLICT(commit_id, npc_id, phase) DO UPDATE SET state = excluded.state`)
      .run(commitId, change.npcId, phase, canonical(change.state));
    for (const [index, draft] of (change.memories ?? []).entries()) {
      const memory = materialize(draft, change.npcId, eventId, index, gameTime, commitId);
      const searchText = tokenize([memory.text, ...memory.subjects, ...memory.topics].join(' ')).join(' ');
      this.db.prepare(`INSERT INTO memory(id, commit_id, npc_id, game_time, text, search_text, kind,
        importance, subjects, topics, visibility, source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(memory.id, commitId, memory.npcId, memory.gameTime, memory.text, searchText, memory.kind,
          memory.importance, JSON.stringify(memory.subjects), JSON.stringify(memory.topics), memory.visibility, memory.sourceId);
    }
    for (const memoryId of change.retireMemoryIds ?? []) {
      // A retirement must never point into another NPC, save, or future branch.
      const target = this.db.prepare(`${pathCte} SELECT m.id FROM memory m JOIN path p ON p.id = m.commit_id
        WHERE m.id = ? AND m.npc_id = ?`).get(commitId, lineageId, memoryId, change.npcId);
      requireValue(target, 'INVALID_RETIREMENT', 'Can only retire this NPC’s memories on the current branch');
      this.db.prepare('INSERT INTO memory_retire(commit_id, memory_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(commitId, memoryId);
    }
  }

  close(): void { this.db.close(); }
}
