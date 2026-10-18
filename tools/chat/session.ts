/** Simulates the game's save cycle for the chat CLI (docs/dialogue-prototype.md §13.3). */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentMemory } from '../../src/agent/dialogue-memory.ts';
import type { Season } from '../../src/agent/dialogue.ts';
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
  commitId?: string;
}

type Runtime = Awaited<ReturnType<typeof createRuntime>>;

export class ChatSave {
  private readonly runtime: Runtime;
  private readonly file: string;
  private readonly npcIds: readonly string[];
  private state: SaveState;
  private scope: SaveScope;
  private seq: number;

  private constructor(runtime: Runtime, file: string, npcIds: readonly string[], state: SaveState, scope: SaveScope) {
    this.runtime = runtime;
    this.file = file;
    this.npcIds = npcIds;
    this.state = state;
    this.scope = scope;
    this.seq = this.lastSeq();
  }

  /** Opens `<directory>/<name>.json`, or starts a new save on `startDay` when it is missing or `fresh` is set. */
  static async open(options: { directory: string; name: string; fresh: boolean; startDay: number; npcIds: readonly string[] }) {
    await mkdir(options.directory, { recursive: true });
    const file = join(options.directory, `${options.name}.json`);
    const existing = options.fresh ? undefined
      : await readFile(file, 'utf8').then((text) => JSON.parse(text) as SaveState, () => undefined);
    const state: SaveState = existing ?? {
      lineageId: `${options.name}-${randomUUID()}`, loadNonce: randomUUID(), day: options.startDay, savedDay: options.startDay,
    };
    const runtime = await createRuntime({
      databasePath: join(options.directory, 'memory.sqlite'),
      journalDirectory: join(options.directory, 'scratch'),
      npcIds: options.npcIds,
    });
    try {
      const scope = await ChatSave.load(runtime, state);
      const save = new ChatSave(runtime, file, options.npcIds, state, scope);
      await save.persist();
      return save;
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }

  private static load(runtime: Runtime, state: SaveState): Promise<SaveScope> {
    return runtime.ctx.saves.load({
      lineageId: state.lineageId, loadNonce: state.loadNonce, day: state.day,
      ...(state.commitId ? { commitId: state.commitId } : {}),
    });
  }

  get day(): number {
    return this.state.day;
  }

  /** Exchanges recorded today with this NPC, e.g. recovered after a restart. */
  todayCount(npcId: string): number {
    return this.scope.ledger.currentDay?.overlay(npcId).today.length ?? 0;
  }

  memory(npcId: string, now: () => number): AgentMemory {
    return new AgentMemory(() => this.scope.agent(npcId), { now, nextSeq: () => ++this.seq });
  }

  /** Sleep and save: commit today, then open the next day. */
  async sleep(): Promise<void> {
    const commitId = `${this.state.lineageId}-day${this.state.day}-${randomUUID().slice(0, 8)}`;
    await this.scope.prepare(commitId);
    await this.scope.confirm(commitId);
    this.state = { ...this.state, day: this.state.day + 1, savedDay: this.state.day + 1, commitId };
    await this.persist();
    await this.scope.startDay(this.state.day);
  }

  /** Quit to title without saving and load the last save again: today is discarded. */
  async rollback(): Promise<void> {
    await this.runtime.ctx.saves.returnToTitle(this.state.lineageId);
    this.state = { ...this.state, loadNonce: randomUUID(), day: this.state.savedDay };
    await this.persist();
    this.scope = await ChatSave.load(this.runtime, this.state);
    this.seq = this.lastSeq();
  }

  /** Like the backend stopping: unsaved events stay in the journal and come back on the next open. */
  close(): Promise<void> {
    return this.runtime.close();
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
