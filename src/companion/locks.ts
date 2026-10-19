import { open, readFile, rm } from 'node:fs/promises';

/** The game and the robot never hold the same save line at once (docs/companion-device.md §5.4). */
export type LockOwner = 'game' | 'companion';

export class SaveLocks {
  private readonly held = new Map<string, LockOwner>();

  holder(lineageId: string): LockOwner | undefined {
    return this.held.get(lineageId);
  }

  /** Returns the release function; throws when the other side holds the save. */
  acquire(lineageId: string, owner: LockOwner): () => void {
    const current = this.held.get(lineageId);
    if (current && current !== owner) throw new Error(`Save ${lineageId} is held by the ${current}`);
    this.held.set(lineageId, owner);
    return () => { if (this.held.get(lineageId) === owner) this.held.delete(lineageId); };
  }
}

/**
 * One process at a time per memory database. The CLI and the backend both write it, and the memory system
 * assumes a single writer, so whoever comes second is told who holds it.
 */
export class DatabaseLock {
  private readonly file: string;
  private released = false;

  private constructor(file: string) {
    this.file = file;
  }

  static async acquire(file: string, holder: string): Promise<DatabaseLock> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(file, 'wx');
        await handle.writeFile(JSON.stringify({ pid: process.pid, holder, since: new Date().toISOString() }));
        await handle.close();
        return new DatabaseLock(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = await readFile(file, 'utf8').then((text) => JSON.parse(text) as { pid: number; holder: string }, () => undefined);
        if (owner && alive(owner.pid)) throw new DatabaseBusyError(owner.holder);
        await rm(file, { force: true });
      }
    }
    throw new DatabaseBusyError('unknown');
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await rm(this.file, { force: true });
  }
}

export class DatabaseBusyError extends Error {
  readonly holder: string;

  constructor(holder: string) {
    super(`The memory database is in use by ${holder}`);
    this.holder = holder;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
