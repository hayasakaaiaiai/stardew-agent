/**
 * Which companion commits follow each save point (docs/companion-device.md §5.3). The save file still points
 * at its own commit, so loading it has to continue from the newest companion commit after it.
 */
import { join } from 'node:path';
import { fileKey, readJson, writeJson } from './snapshot.ts';

/** Companion commits are recognisable by ID, e.g. to skip them when looking for the last talk in town. */
export const COMPANION_PREFIX = 'companion-';

export function isCompanionCommit(commitId: string): boolean {
  return commitId.startsWith(COMPANION_PREFIX);
}

interface RegistryFile {
  lineageId: string;
  /** Save commit → newest companion commit after it. */
  heads: Record<string, string>;
  /** Save commit → companion commit being written; settled by `reconcile` after a crash. */
  pending: Record<string, string>;
}

export class CompanionRegistry {
  private readonly directory: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = directory;
  }

  /** Where memory continues when this save is loaded: the save commit itself, or the newest companion commit. */
  async head(lineageId: string, saveCommitId: string): Promise<string> {
    return (await this.read(lineageId)).heads[saveCommitId] ?? saveCommitId;
  }

  /** Marks the commit before it is written, so a crash in between can be detected. */
  begin(lineageId: string, saveCommitId: string, commitId: string): Promise<void> {
    return this.update(lineageId, (file) => { file.pending[saveCommitId] = commitId; });
  }

  complete(lineageId: string, saveCommitId: string, commitId: string): Promise<void> {
    return this.update(lineageId, (file) => {
      file.heads[saveCommitId] = commitId;
      delete file.pending[saveCommitId];
    });
  }

  /** A pending commit that reached the store becomes the head; one that did not is forgotten. */
  async reconcile(lineageId: string, settle: (commitId: string) => Promise<boolean>): Promise<void> {
    const { pending } = await this.read(lineageId);
    for (const [saveCommitId, commitId] of Object.entries(pending)) {
      if (await settle(commitId)) await this.complete(lineageId, saveCommitId, commitId);
      else await this.update(lineageId, (file) => { delete file.pending[saveCommitId]; });
    }
  }

  private async read(lineageId: string): Promise<RegistryFile> {
    return await readJson<RegistryFile>(this.file(lineageId)) ?? { lineageId, heads: {}, pending: {} };
  }

  private update(lineageId: string, change: (file: RegistryFile) => void): Promise<void> {
    const result = this.chain.then(async () => {
      const file = await this.read(lineageId);
      change(file);
      await writeJson(this.file(lineageId), file);
    });
    this.chain = result.catch(() => {});
    return result;
  }

  private file(lineageId: string): string {
    return join(this.directory, `${fileKey(lineageId)}.json`);
  }
}
