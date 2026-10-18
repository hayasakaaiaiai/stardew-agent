import { Worker } from 'node:worker_threads';
import { Context, Service } from 'cordis';
import type { StoreCommands } from '../../types.ts';
import { MemoryError } from '../../validation.ts';

declare module 'cordis' { interface Context { store: StoreService } }

export interface StoreConfig { databasePath: string }

/** One Worker/connection for every save and NPC. Calls are serialized by its message queue. */
export class StoreService extends Service {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly ready: Promise<void>;
  private nextId = 0;
  private closing = false;
  private failure: Error | undefined;

  constructor(ctx: Context, config: StoreConfig) {
    super(ctx, 'store');
    const file = import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js';
    // Source TS runs natively on Node 24. Do not forward parent-only flags (stdin/test-runner flags in particular).
    this.worker = new Worker(new URL(file, import.meta.url), { workerData: { path: config.databasePath }, execArgv: [] });
    this.ready = new Promise<void>((resolve, reject) => {
      this.worker.on('message', (message: { ready?: boolean; id: number; ok: boolean; value: unknown; error: { code: string; message: string } }) => {
        if (message.ready) { resolve(); return; }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new MemoryError(message.error.code, message.error.message));
      });
      this.worker.on('error', error => { this.fail(error); reject(error); });
      this.worker.on('exit', code => {
        if (!this.closing || code !== 0) {
          const error = new MemoryError('WORKER_EXIT', `Database Worker exited with code ${code}`);
          this.fail(error); reject(error);
        }
      });
    });
    ctx.effect(() => () => this.shutdown());
  }

  async [Service.init](): Promise<void> { await this.ready; }

  get workerId(): number { return this.worker.threadId; }

  private fail(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async call<K extends keyof StoreCommands>(operation: K, input: StoreCommands[K]['input']): Promise<StoreCommands[K]['output']> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.closing && operation !== 'close') throw new MemoryError('STORE_CLOSED', 'The memory store is closing');
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as StoreCommands[K]['output']), reject });
      try { this.worker.postMessage({ id, operation, input }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  private async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try { if (!this.failure) await this.call('close', null); }
    finally { await this.worker.terminate(); }
  }
}
