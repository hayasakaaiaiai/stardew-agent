import type { CommitRef, DaySnapshot } from '../types.ts';
import { identifier, integer, requireValue } from '../validation.ts';
import type { StoreService } from '../services/store/index.ts';
import type { DayTxn } from './day.ts';

export interface LedgerOwner {
  store: StoreService;
  lineageId: string;
  loadNonce: string;
  openDay(head: CommitRef, day: number): Promise<DayTxn>;
  closeDay(removeJournal: boolean): Promise<void>;
}

/** Game-level commits. These are distinct from short-lived SQL transactions. */
export class Ledger {
  head: CommitRef;
  currentDay: DayTxn | undefined;
  private readonly owner: LedgerOwner;
  private chain: Promise<void> = Promise.resolve();
  private preparing: { id: string; snapshot: Promise<DaySnapshot> } | undefined;
  private closed = false;

  constructor(owner: LedgerOwner, head: CommitRef) { this.owner = owner; this.head = head; }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.chain.then(run);
    this.chain = result.then(() => {}, () => {});
    return result;
  }

  startDay(day: number): Promise<void> {
    integer(day, 'day', 1);
    return this.enqueue(async () => {
      requireValue(!this.closed, 'SAVE_CLOSED', 'This save has been unloaded');
      requireValue(!this.currentDay, 'DAY_EXISTS', 'Confirm or discard the current day before starting another');
      requireValue(day >= this.head.dayEnded, 'INVALID_DAY', 'The loaded game day precedes its commit');
      this.currentDay = await this.owner.openDay(this.head, day);
    });
  }

  prepare(commitId: string): Promise<CommitRef> {
    identifier(commitId, 'commitId');
    requireValue(!this.closed && this.currentDay, 'SAVE_CLOSED', 'No open day to save');
    if (this.preparing) requireValue(this.preparing.id === commitId, 'COMMIT_CONFLICT', 'Another commit is already being prepared');
    else this.preparing = { id: commitId, snapshot: this.currentDay.freeze() };
    const preparing = this.preparing;
    // Attach rejection handling immediately, even if an earlier ledger operation is still running.
    void preparing.snapshot.catch(() => {});
    return this.enqueue(async () => this.owner.store.call('prepare', { commitId, snapshot: await preparing.snapshot }));
  }

  confirm(commitId: string): Promise<CommitRef> {
    return this.enqueue(async () => {
      requireValue(!this.closed, 'SAVE_CLOSED', 'This save has been unloaded');
      if (this.head.id === commitId && !this.currentDay) return this.head;
      requireValue(this.preparing?.id === commitId, 'COMMIT_CONFLICT', 'Confirmation does not match the prepared day');
      const commit = await this.owner.store.call('confirm', { lineageId: this.owner.lineageId, commitId });
      this.head = commit;
      await this.owner.closeDay(true);
      this.currentDay = undefined;
      this.preparing = undefined;
      return commit;
    });
  }

  close(discard: boolean): Promise<void> {
    this.closed = true;
    this.currentDay?.stopAccepting();
    return this.enqueue(async () => {
      await this.owner.closeDay(discard);
      this.currentDay = undefined;
    });
  }
}
