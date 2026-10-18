export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type NpcState = { [key: string]: Json };

export interface MemoryDraft {
  text: string;
  kind?: 'conversation' | 'observation' | 'heard' | 'reflection' | 'summary';
  importance?: number;
  subjects?: string[];
  topics?: string[];
  visibility?: 'private' | 'normal';
}

export interface NpcChange {
  npcId: string;
  log?: NpcState;
  state?: NpcState;
  memories?: MemoryDraft[];
  retireMemoryIds?: string[];
}

/** One atomic event, possibly witnessed by several NPCs. seq is per game load. */
export interface DayEntry {
  seq: number;
  /** Absolute game minutes, including the game day; not wall-clock time or HHMM. */
  gameTime: number;
  changes: NpcChange[];
}

export interface DayIdentity {
  lineageId: string;
  loadNonce: string;
  baseCommitId: string;
  day: number;
}

export interface DaySnapshot extends DayIdentity {
  entries: DayEntry[];
}

export interface CommitRef {
  id: string;
  lineageId: string;
  parentId: string | null;
  dayEnded: number;
  status: 'prepared' | 'confirmed';
}

export interface SessionScope {
  lineageId: string;
  headCommitId: string;
  npcId: string;
}

export interface Memory {
  id: string;
  commitId: string | null;
  npcId: string;
  gameTime: number;
  text: string;
  kind: NonNullable<MemoryDraft['kind']>;
  importance: number;
  subjects: string[];
  topics: string[];
  visibility: 'private' | 'normal';
  sourceId: string;
}

export interface RecallOptions {
  query?: string;
  topics?: string[];
  /** Shared scenes are allowed to retrieve normal memories only. */
  sharedScene?: boolean;
  nowGameTime: number;
  limit?: number;
  maxChars?: number;
}

export interface RecallResult extends Memory {
  score: number;
}

export interface NpcContext {
  state: NpcState;
  memories: RecallResult[];
  today: DayEntry[];
}

export interface Consolidation {
  lineageId: string;
  commitId: string;
  changes: NpcChange[];
}

export interface ConsolidationInput {
  commit: CommitRef;
  completed: boolean;
  npcs: { npcId: string; state: NpcState; logs: DayEntry[]; memories: Memory[] }[];
}

export interface StoreSearch {
  scope: SessionScope;
  query: string;
  topics: string[];
  sharedScene: boolean;
  limit: number;
  excludeIds?: string[];
}

export interface StoreCommands {
  root: { input: string; output: CommitRef };
  getCommit: { input: { lineageId: string; commitId: string }; output: CommitRef | null };
  prepare: { input: { commitId: string; snapshot: DaySnapshot }; output: CommitRef };
  confirm: { input: { lineageId: string; commitId: string }; output: CommitRef };
  state: { input: SessionScope; output: NpcState };
  search: { input: StoreSearch; output: Memory[] };
  context: {
    input: { scope: SessionScope; options: RecallOptions; overlay: { state?: NpcState; memories: Memory[]; retired: string[] } };
    output: Pick<NpcContext, 'state' | 'memories'>;
  };
  validateRetirements: { input: { scope: SessionScope; ids: string[] }; output: void };
  consolidationInput: { input: { lineageId: string; commitId: string; npcIds: string[] }; output: ConsolidationInput };
  consolidate: { input: Consolidation; output: void };
  close: { input: null; output: void };
}

export const SOCIAL_NPCS = [
  'abigail', 'alex', 'elliott', 'emily', 'haley', 'harvey', 'leah', 'maru',
  'penny', 'sam', 'sebastian', 'shane', 'caroline', 'clint', 'demetrius',
  'dwarf', 'evelyn', 'george', 'gus', 'jas', 'jodi', 'kent', 'krobus', 'leo',
  'lewis', 'linus', 'marnie', 'pam', 'pierre', 'robin', 'sandy', 'vincent',
  'willy', 'wizard',
] as const;
