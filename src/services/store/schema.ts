export const schema = `
CREATE TABLE lineage (id TEXT PRIMARY KEY) STRICT;
CREATE TABLE commit_node (
  id TEXT PRIMARY KEY,
  lineage_id TEXT NOT NULL REFERENCES lineage(id),
  parent_id TEXT REFERENCES commit_node(id),
  day_ended INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'confirmed')),
  fingerprint TEXT NOT NULL,
  consolidation_fingerprint TEXT
) STRICT;
CREATE INDEX commit_parent ON commit_node(parent_id);
CREATE TABLE npc_state (
  commit_id TEXT NOT NULL REFERENCES commit_node(id),
  npc_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('day', 'consolidated')),
  state TEXT NOT NULL,
  PRIMARY KEY (commit_id, npc_id, phase)
) STRICT;
CREATE TABLE log (
  commit_id TEXT NOT NULL REFERENCES commit_node(id),
  npc_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  entry TEXT NOT NULL,
  PRIMARY KEY (commit_id, npc_id, seq)
) STRICT;
CREATE TABLE memory (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  commit_id TEXT NOT NULL REFERENCES commit_node(id),
  npc_id TEXT NOT NULL,
  game_time INTEGER NOT NULL,
  text TEXT NOT NULL,
  search_text TEXT NOT NULL,
  kind TEXT NOT NULL,
  importance INTEGER NOT NULL,
  subjects TEXT NOT NULL,
  topics TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'normal')),
  source_id TEXT NOT NULL
) STRICT;
CREATE INDEX memory_scope ON memory(commit_id, npc_id);
CREATE TABLE memory_retire (
  commit_id TEXT NOT NULL REFERENCES commit_node(id),
  memory_id TEXT NOT NULL REFERENCES memory(id),
  PRIMARY KEY (commit_id, memory_id)
) STRICT;
CREATE VIRTUAL TABLE memory_fts USING fts5(search_text, content='memory', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER memory_insert AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
PRAGMA user_version = 1;
`;

/** The head is checked separately. Paths are never inferred from dates or latest writes. */
export const pathCte = `WITH RECURSIVE path(id, parent_id, distance) AS (
  SELECT id, parent_id, 0 FROM commit_node WHERE id = ? AND lineage_id = ?
  UNION ALL
  SELECT c.id, c.parent_id, p.distance + 1 FROM commit_node c JOIN path p ON c.id = p.parent_id
)`;
