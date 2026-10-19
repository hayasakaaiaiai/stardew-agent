/**
 * The game state at each save, for the companion robot to use while the game is closed
 * (docs/companion-device.md §5.1). Written by the CLI on /sleep now, by the bridge once M3b syncs saves.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WorldState } from '../agent/dialogue.ts';
import type { Relation } from '../services/roster/index.ts';

export interface SaveSnapshot {
  lineageId: string;
  /** The commit the save file points at, never a companion commit. */
  commitId: string;
  /** Absolute game day the save ended, as in the memory system. */
  dayEnded: number;
  /** Real time the save was written, ISO 8601. */
  savedAt: string;
  /** How the save is listed, e.g. the CLI save name. */
  label: string;
  player: WorldState['player'];
  facts: Record<string, string>;
  /** NPCs not listed count as strangers at 0 hearts. */
  npcs: Record<string, { hearts: number; relation: Relation }>;
  seenEvents: string[];
}

/** IDs come from the game and may hold characters that are not allowed in file names. */
export function fileKey(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 24);
}

/** Write to a temporary file first, so a crash never leaves half a file behind. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export class SnapshotStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  write(snapshot: SaveSnapshot): Promise<void> {
    return writeJson(this.file(snapshot.lineageId, snapshot.commitId), snapshot);
  }

  read(lineageId: string, commitId: string): Promise<SaveSnapshot | undefined> {
    return readJson<SaveSnapshot>(this.file(lineageId, commitId));
  }

  /** The newest snapshot of each save line, newest first. */
  async latest(): Promise<SaveSnapshot[]> {
    const lines = await readdir(this.directory).catch(() => [] as string[]);
    const newest: SaveSnapshot[] = [];
    for (const line of lines) {
      const files = (await readdir(join(this.directory, line)).catch(() => [] as string[])).filter((file) => file.endsWith('.json'));
      const snapshots = (await Promise.all(files.map((file) => readJson<SaveSnapshot>(join(this.directory, line, file)))))
        .filter((snapshot): snapshot is SaveSnapshot => snapshot !== undefined);
      const best = snapshots.sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0];
      if (best) newest.push(best);
    }
    return newest.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  /** The newest snapshot of one save line, to carry over what a new save does not know. */
  async latestOf(lineageId: string): Promise<SaveSnapshot | undefined> {
    return (await this.latest()).find((snapshot) => snapshot.lineageId === lineageId);
  }

  private file(lineageId: string, commitId: string): string {
    return join(this.directory, fileKey(lineageId), `${fileKey(commitId)}.json`);
  }
}
