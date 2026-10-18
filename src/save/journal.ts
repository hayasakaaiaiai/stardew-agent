import { mkdir, open, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { DayEntry, DayIdentity } from '../types.ts';
import { canonical, digest, requireValue, validateEntry } from '../validation.ts';

interface Header extends DayIdentity { format: 1 }

/** Separate from SQLite WAL: this journal recovers an uncommitted game day. */
export class DayJournal {
  readonly path: string;
  private handle: FileHandle | undefined;

  private constructor(path: string, handle: FileHandle) { this.path = path; this.handle = handle; }

  static async open(directory: string, identity: DayIdentity): Promise<{ journal: DayJournal; entries: DayEntry[] }> {
    // Never use game-supplied identifiers as filesystem paths.
    const folder = join(directory, digest(identity.lineageId));
    const path = join(folder, `${digest(identity.loadNonce)}.jsonl`);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const header: Header = { format: 1, ...identity };
    let text: string | undefined;
    try { text = await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let entries: DayEntry[] = [];
    if (text !== undefined) {
      const end = text.lastIndexOf('\n') + 1;
      requireValue(end > 0, 'CORRUPT_JOURNAL', 'The day journal header is incomplete');
      const complete = text.slice(0, end);
      const lines = complete.trimEnd().split('\n');
      let oldHeader: Header;
      try { oldHeader = JSON.parse(lines[0]!) as Header; }
      catch { throw new Error('The day journal header is invalid JSON'); }
      requireValue(oldHeader.format === 1, 'JOURNAL_VERSION', 'Unsupported day journal format');
      if (canonical(oldHeader) === canonical(header)) {
        entries = lines.slice(1).map(line => {
          const entry = JSON.parse(line) as DayEntry;
          validateEntry(entry);
          return entry;
        });
        for (let index = 1; index < entries.length; index++) requireValue(entries[index]!.seq > entries[index - 1]!.seq,
          'CORRUPT_JOURNAL', 'Day journal sequences are not increasing');
        if (end !== text.length) await truncate(path, Buffer.byteLength(complete));
      } else {
        // A matching nonce alone is insufficient: the day and base commit must also match.
        text = undefined;
      }
    }
    if (text === undefined) await writeFile(path, `${canonical(header)}\n`, { mode: 0o600 });
    return { journal: new DayJournal(path, await open(path, 'a')), entries };
  }

  async append(entry: DayEntry): Promise<void> {
    requireValue(this.handle, 'JOURNAL_CLOSED', 'The day journal is closed');
    await this.handle.appendFile(`${canonical(entry)}\n`);
    // An acknowledged event is recoverable after process loss, not just after a timer flush.
    await this.handle.sync();
  }

  async flush(): Promise<void> { await this.handle?.sync(); }

  async close(remove = false): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    await handle?.close();
    if (remove) await rm(this.path, { force: true });
  }
}
