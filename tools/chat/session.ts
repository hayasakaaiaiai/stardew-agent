/** Simulates the game's save cycle for the chat CLI (docs/dialogue-prototype.md §13.3). */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Consolidator } from '../../src/agent/consolidation.ts';
import { AgentMemory, type PlayerIdentity } from '../../src/agent/dialogue-memory.ts';
import type { DialogueMemory, Season } from '../../src/agent/dialogue.ts';
import { withMorningPlan } from '../../src/agent/morning.ts';
import { Nightly } from '../../src/agent/nightly.ts';
import { DatabaseLock } from '../../src/companion/locks.ts';
import { CompanionRegistry } from '../../src/companion/registry.ts';
import { type SaveSnapshot, SnapshotStore } from '../../src/companion/snapshot.ts';
import { createRuntime, type SaveScope } from '../../src/index.ts';

const SEASONS: Season[] = ['spring', 'summer', 'fall', 'winter'];

/** Day 1 is spring 1 of year 1; the memory system measures game time in absolute days. */
export function absoluteDay(date: { year: number; season: Season; day: number }): number {
  return (date.year - 1) * 112 + SEASONS.indexOf(date.season) * 28 + date.day;
}

export function dateOf(absolute: number): { year: number; season: Season; day: number } {
  const index = absolute - 1;
  return { year: Math.floor(index / 112) + 1, season: SEASONS[Math.floor(index / 28) % 4]!, day: (index % 28) + 1 };
}

/** "HH:MM" → minutes after midnight. */
export function minutesOf(time: string): number {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** What a game save would carry, plus the load identity the backend needs to recover an unsaved day. */
interface SaveState {
  lineageId: string;
  loadNonce: string;
  /** The day being played. */
  day: number;
  /** The day a reload of the last save starts on. */
  savedDay: number;
  /** What a game save file would point at. */
  commitId?: string;
  /** Where this load continued from: commitId, or a robot session after it (docs/companion-device.md §5.3). */
  headCommitId?: string;
}

/** What the CLI knows about the game state, written with each save for the robot (docs/companion-device.md §5.1). */
export type SaveFacts = Pick<SaveSnapshot, 'label' | 'player' | 'facts' | 'npcs' | 'seenEvents'>;

type Runtime = Awaited<ReturnType<typeof createRuntime>>;

interface Storage {
  runtime: Runtime;
  lock: DatabaseLock;
  registry: CompanionRegistry;
  snapshots: SnapshotStore;
  nightly: Nightly | undefined;
}

export class ChatSave {
  private readonly storage: Storage;
  private readonly file: string;
  private readonly npcIds: readonly string[];
  private state: SaveState;
  private scope: SaveScope;
  private seq: number;
  /** Set when the load continued after a robot session, for the CLI to mention. */
  readonly continuedFromRobot: boolean;

  private constructor(storage: Storage, file: string, npcIds: readonly string[], loaded: { state: SaveState; scope: SaveScope; continued: boolean }) {
    this.storage = storage;
    this.file = file;
    this.npcIds = npcIds;
    this.state = loaded.state;
    this.scope = loaded.scope;
    this.continuedFromRobot = loaded.continued;
    this.seq = this.lastSeq();
  }

  /**
   * Opens `<directory>/<name>.json`, or starts a new save on `startDay` when it is missing or `fresh` is set.
   * With a consolidator, each /sleep is consolidated before the next day starts (docs/nightly-consolidation.md).
   */
  static async open(options: { directory: string; name: string; fresh: boolean; startDay: number; npcIds: readonly string[];
    consolidator?: Consolidator; log?: (line: string) => void }) {
    await mkdir(options.directory, { recursive: true });
    const file = join(options.directory, `${options.name}.json`);
    const existing = options.fresh ? undefined
      : await readFile(file, 'utf8').then((text) => JSON.parse(text) as SaveState, () => undefined);
    const state: SaveState = existing ?? {
      lineageId: `${options.name}-${randomUUID()}`, loadNonce: randomUUID(), day: options.startDay, savedDay: options.startDay,
    };
    // The robot writes the same database from the backend; only one process may hold it.
    const lock = await DatabaseLock.acquire(join(options.directory, 'memory.lock'), '命令行聊天');
    let runtime: Runtime | undefined;
    try {
      runtime = await createRuntime({
        databasePath: join(options.directory, 'memory.sqlite'),
        journalDirectory: join(options.directory, 'scratch'),
        npcIds: options.npcIds,
      });
      const storage = {
        runtime, lock,
        registry: new CompanionRegistry(join(options.directory, 'companion/registry')),
        snapshots: new SnapshotStore(join(options.directory, 'saves')),
        nightly: options.consolidator ? new Nightly({
          store: runtime.ctx.store, consolidator: options.consolidator, npcIds: options.npcIds, ...(options.log ? { log: options.log } : {}),
        }) : undefined,
      };
      const save = new ChatSave(storage, file, options.npcIds, await ChatSave.load(storage, state));
      await save.persist();
      if (save.state.commitId) await storage.nightly?.catchUp(save.state.lineageId, save.state.commitId);
      return save;
    } catch (error) {
      await runtime?.close();
      await lock.release();
      throw error;
    }
  }

  /**
   * Loads from the save's commit, or from the newest robot session after it. A robot session since the last
   * load means a new load: the unsaved day was based on the older head and is dropped, as in the game.
   */
  private static async load(storage: Storage, state: SaveState): Promise<{ state: SaveState; scope: SaveScope; continued: boolean }> {
    const head = state.commitId ? await storage.registry.head(state.lineageId, state.commitId) : undefined;
    const moved = head !== (state.headCommitId ?? state.commitId);
    const next: SaveState = { ...state, ...(moved ? { loadNonce: randomUUID(), day: state.savedDay } : {}), ...(head ? { headCommitId: head } : {}) };
    const scope = await storage.runtime.ctx.saves.load({
      lineageId: next.lineageId, loadNonce: next.loadNonce, day: next.day, ...(head ? { commitId: head } : {}),
    });
    return { state: next, scope, continued: moved && head !== state.commitId };
  }

  get day(): number {
    return this.state.day;
  }

  /** Exchanges recorded today with this NPC, e.g. recovered after a restart. */
  todayCount(npcId: string): number {
    return this.scope.ledger.currentDay?.overlay(npcId).today.length ?? 0;
  }

  memory(npcId: string, now: () => number, player?: () => PlayerIdentity): DialogueMemory {
    const memory = new AgentMemory(() => this.scope.agent(npcId), { now, nextSeq: () => ++this.seq, ...(player ? { player } : {}) });
    return withMorningPlan(memory, { now,
      read: () => this.scope.agent(npcId).context({ nowGameTime: now(), limit: 1, maxChars: 1 }),
    });
  }

  /** Sleep and save: commit today, write the snapshot the robot reads, open the next day, then consolidate the saved one. */
  async sleep(facts: SaveFacts): Promise<void> {
    const { lineageId, day } = this.state;
    const commitId = `${lineageId}-day${day}-${randomUUID().slice(0, 8)}`;
    await this.scope.prepare(commitId);
    await this.scope.confirm(commitId);
    this.state = { ...this.state, day: day + 1, savedDay: day + 1, commitId, headCommitId: commitId };
    await this.persist();
    // The CLI only knows the NPC it is talking to; others keep what earlier saves recorded.
    const previous = await this.storage.snapshots.latestOf(lineageId);
    await this.storage.snapshots.write({
      ...facts, npcs: { ...previous?.npcs, ...facts.npcs },
      lineageId, commitId, dayEnded: day, savedAt: new Date().toISOString(),
    });
    await this.scope.startDay(this.state.day);
    await this.storage.nightly?.run(lineageId, commitId);
  }

  /** Quit to title without saving and load the last save again: today is discarded. */
  async rollback(): Promise<void> {
    await this.storage.runtime.ctx.saves.returnToTitle(this.state.lineageId);
    const loaded = await ChatSave.load(this.storage, { ...this.state, loadNonce: randomUUID(), day: this.state.savedDay });
    this.state = loaded.state;
    this.scope = loaded.scope;
    await this.persist();
    this.seq = this.lastSeq();
  }

  /** Like the backend stopping: unsaved events stay in the journal and come back on the next open. */
  async close(): Promise<void> {
    await this.storage.nightly?.close();
    await this.storage.runtime.close();
    await this.storage.lock.release();
  }

  private lastSeq(): number {
    const day = this.scope.ledger.currentDay;
    if (!day) return 0;
    return Math.max(0, ...this.npcIds.flatMap((id) => day.overlay(id).today.map((entry) => entry.seq)));
  }

  private persist(): Promise<void> {
    return writeFile(this.file, `${JSON.stringify(this.state, null, 2)}\n`);
  }
}
