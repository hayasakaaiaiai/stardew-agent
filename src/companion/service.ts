/**
 * Owns the device server and at most one robot session (docs/companion-device.md §4–5). The memory database
 * is open only while a session runs, so the chat CLI can use it in between; a save the game holds is refused,
 * and a session cut short by a crash is committed on the next start.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime } from '../index.ts';
import type { ModelClient } from '../services/model/client.ts';
import type { Roster } from '../services/roster/index.ts';
import { DatabaseBusyError, DatabaseLock, SaveLocks } from './locks.ts';
import { CompanionRegistry } from './registry.ts';
import { type DeviceConnection, type DeviceHandler, DevicePairing, DeviceServer } from './server.ts';
import { CompanionSession, type Runtime, type SessionIdentity } from './session.ts';
import { readJson, type SaveSnapshot, SnapshotStore, writeJson } from './snapshot.ts';
import type { Recognizer, SpeechServices } from './voice.ts';

export interface CompanionOptions {
  /** Shared with the chat CLI: memory.sqlite, scratch/, saves/ and companion/. */
  dataDirectory: string;
  roster: Roster;
  model: ModelClient;
  speech: SpeechServices;
  /** Called with '' for the voice used when no NPC is chosen. */
  voiceFor: (npcId: string) => string;
  npcIds: readonly string[];
  port: number;
  host?: string;
  /** Two minutes by default. */
  idleMs?: number;
  log?: (line: string) => void;
}

/** A refusal meant for the person at the terminal, e.g. the game holds the save. */
export class CompanionError extends Error {}

export type EndReason = 'stop' | 'farewell' | 'idle' | 'game';
const REASONS: Record<EndReason, string> = { stop: '手动结束', farewell: '道别', idle: '太久没说话', game: '游戏读了这个存档' };
const HINT = '还没选好要和谁聊，请在电脑上输入 /robot 选一下。';

interface Active {
  runtime: Runtime;
  lock: DatabaseLock;
  session: CompanionSession;
  releaseSave: () => void;
}

export class CompanionService {
  readonly snapshots: SnapshotStore;
  readonly pairing: DevicePairing;
  private readonly options: CompanionOptions;
  private readonly registry: CompanionRegistry;
  private readonly locks = new SaveLocks();
  private server!: DeviceServer;
  private active: Active | undefined;
  private device: DeviceConnection | undefined;
  private releaseGame: (() => void) | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(options: CompanionOptions) {
    this.options = options;
    this.snapshots = new SnapshotStore(this.file('saves'));
    this.registry = new CompanionRegistry(this.file('companion/registry'));
    this.pairing = new DevicePairing(this.file('companion/devices.json'));
  }

  static async start(options: CompanionOptions): Promise<CompanionService> {
    const service = new CompanionService(options);
    await service.pairing.load();
    service.server = await DeviceServer.start({
      port: options.port, pairing: service.pairing, onConnection: (connection) => service.connect(connection),
      ...(options.host ? { host: options.host } : {}), ...(options.log ? { log: options.log } : {}),
    });
    return service;
  }

  get port(): number {
    return this.server.port;
  }

  get session(): CompanionSession | undefined {
    return this.active?.session;
  }

  saves(): Promise<SaveSnapshot[]> {
    return this.snapshots.latest();
  }

  begin(snapshot: SaveSnapshot, npcId: string): Promise<CompanionSession> {
    return this.serial(() => this.open(snapshot, npcId));
  }

  /** Commits what was said; null when there was no session or nothing was said. */
  stop(reason: EndReason = 'stop'): Promise<string | null> {
    return this.serial(() => this.finish(reason));
  }

  /** The game loaded a save: a robot session on it is committed first, so the game continues from it. */
  gameLoaded(lineageId: string): Promise<void> {
    return this.serial(async () => {
      if (this.active?.session.identity.lineageId === lineageId) await this.finish('game');
      this.releaseGame?.();
      this.releaseGame = this.locks.acquire(lineageId, 'game');
    });
  }

  gameClosed(): void {
    this.releaseGame?.();
    this.releaseGame = undefined;
  }

  async close(): Promise<void> {
    await this.stop();
    await this.server.close();
  }

  private async open(snapshot: SaveSnapshot, npcId: string): Promise<CompanionSession> {
    if (this.active) throw new CompanionError(`机器人正在和${this.active.session.npcName}聊天，先输入 /robot stop`);
    if (this.locks.holder(snapshot.lineageId) === 'game') throw new CompanionError('游戏开着这个存档，先回到标题画面');
    let lock: DatabaseLock;
    try {
      lock = await DatabaseLock.acquire(this.file('memory.lock'), '后端（机器人）');
    } catch (error) {
      if (error instanceof DatabaseBusyError) throw new CompanionError(`记忆数据库正被${error.holder}使用，先退出它`);
      throw error;
    }
    let runtime: Runtime | undefined;
    try {
      runtime = await createRuntime({
        databasePath: this.file('memory.sqlite'), journalDirectory: this.file('scratch'), npcIds: this.options.npcIds,
      });
      await this.recover(runtime);
      const session = await CompanionSession.open({
        ...this.sessionDeps(runtime), snapshot, npcId, voice: this.options.voiceFor(npcId),
        onFinish: (reason) => void this.stop(reason),
      });
      await writeJson(this.file('companion/active.json'), session.identity);
      const releaseSave = this.locks.acquire(snapshot.lineageId, 'companion');
      this.active = { runtime, lock, session, releaseSave };
      if (this.device) session.attach(this.device);
      return session;
    } catch (error) {
      await runtime?.close();
      await lock.release();
      throw error;
    }
  }

  private async finish(reason: EndReason): Promise<string | null> {
    const active = this.active;
    if (!active) return null;
    this.active = undefined;
    const { session } = active;
    try {
      const commitId = await session.end();
      await rm(this.file('companion/active.json'), { force: true });
      this.log(commitId
        ? `和${session.npcName}的聊天已写回存档：${session.exchanges} 轮（${REASONS[reason]}）`
        : `和${session.npcName}的聊天结束，没有要写回的内容（${REASONS[reason]}）`);
      // The device goes back to idle and reconnects on its wake word.
      this.device?.close();
      return commitId;
    } finally {
      active.releaseSave();
      await active.runtime.close();
      await active.lock.release();
    }
  }

  /** A session the backend never finished: reopen its load so the journal restores it, then commit. */
  private async recover(runtime: Runtime): Promise<void> {
    const saved = await readJson<SessionIdentity>(this.file('companion/active.json'));
    if (!saved) return;
    const snapshot = await this.snapshots.read(saved.lineageId, saved.saveCommitId);
    if (snapshot) {
      const session = await CompanionSession.open({
        ...this.sessionDeps(runtime), snapshot, npcId: saved.npcId, voice: this.options.voiceFor(saved.npcId),
        onFinish: () => {}, resume: { loadNonce: saved.loadNonce, headCommitId: saved.headCommitId },
      });
      if (await session.end()) this.log(`上次没写回的 ${session.exchanges} 轮聊天已补写进存档`);
    }
    await rm(this.file('companion/active.json'), { force: true });
  }

  private sessionDeps(runtime: Runtime) {
    const { roster, model, speech, idleMs = 120_000, log } = this.options;
    return { runtime, roster, model, speech, registry: this.registry, idleMs, ...(log ? { log } : {}) };
  }

  /** One robot at a time: a new connection replaces the old one. */
  private connect(connection: DeviceConnection): void {
    if (this.device && this.device !== connection) this.device.close();
    this.device = connection;
    this.log(`机器人已连接（${connection.deviceId}）`);
    connection.handler = this.handlerFor(connection);
    this.active?.session.attach(connection);
  }

  private handlerFor(connection: DeviceConnection): DeviceHandler {
    let recognizer: Recognizer | undefined;
    let hinted = false;
    const hear = (text: string) => {
      connection.showUserText(text);
      if (this.active) this.active.session.hear(text);
      else if (!hinted) {
        hinted = true;
        this.hint(connection);
      }
    };
    const listening = () => recognizer ??= this.options.speech.recognize({
      onPartial: () => this.active?.session.warm(),
      onSentence: hear,
      onError: (error) => {
        recognizer = undefined;
        // The service drops a task after ~20 s without audio, e.g. while the NPC talks; the next audio reopens it.
        if (!/timeout/i.test(error.message)) this.log(`语音识别出错：${error.message}`);
      },
    });
    return {
      listen: (state) => {
        // The wake word means the player is about to talk.
        if (state === 'detect') this.active?.session.warm();
        if (state !== 'stop') return;
        const finishing = recognizer;
        recognizer = undefined;
        finishing?.finish().catch((error: Error) => this.log(`语音识别出错：${error.message}`));
      },
      audio: (pcm) => listening().write(pcm),
      text: hear,
      abort: () => this.active?.session.interrupt(),
      closed: () => {
        recognizer?.close();
        if (this.device === connection) this.device = undefined;
        this.active?.session.detach(connection);
        this.log('机器人已断开');
      },
    };
  }

  private hint(connection: DeviceConnection): void {
    const synth = this.options.speech.synthesize(this.options.voiceFor(''), {
      onAudio: (pcm) => { connection.startSpeaking(); connection.audio(pcm); },
      onError: () => {},
    });
    connection.startSpeaking();
    connection.sentence(HINT);
    synth.push(HINT);
    void synth.finish().then(() => connection.stopSpeaking(), () => connection.cancelSpeaking());
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.chain.then(run);
    this.chain = result.catch(() => {});
    return result;
  }

  private file(path: string): string {
    return join(this.options.dataDirectory, path);
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}
