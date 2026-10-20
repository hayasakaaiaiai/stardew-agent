/**
 * Owns the device server and at most one robot session (docs/companion-device.md §4–5, §13). The robot uses the
 * game's memory runtime, so the database has one writer. A save a connected game holds is refused, a load the
 * game left behind is taken over, and a session cut short by a crash is committed before the game or the robot
 * opens that save again.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelClient } from '../services/model/client.ts';
import type { Roster } from '../services/roster/index.ts';
import type { PortraitPacks } from './assets.ts';
import { CompanionRegistry } from './registry.ts';
import { type DeviceConnection, type DeviceHandler, DevicePairing, DeviceServer } from './server.ts';
import { CompanionSession, type Runtime, type SessionIdentity } from './session.ts';
import { readJson, type SaveSnapshot, SnapshotStore, writeJson } from './snapshot.ts';
import type { Recognizer, SpeechServices } from './voice.ts';

/** What the robot needs from the game backend (src/bridge/server.ts). */
export interface GameAccess {
  readonly runtime: Runtime;
  /** A connected game has the save loaded. */
  holds(lineageId: string): boolean;
  /** Closes a load the game left behind; rejects while the game is saving it. */
  takeOver(lineageId: string): Promise<void>;
}

export interface CompanionOptions {
  /** The game's memory directory: saves/ holds the snapshots the game writes, companion/ the robot's own files. */
  dataDirectory: string;
  game: GameAccess;
  roster: Roster;
  model: ModelClient;
  speech: SpeechServices;
  /** Called with '' for the voice used when no NPC is chosen. */
  voiceFor: (npcId: string) => string;
  npcIds: readonly string[];
  port: number;
  host?: string;
  /** NPC face packs (docs/companion-device.md §14); without them the robot keeps the firmware's emoji. */
  faces?: PortraitPacks;
  /** Two minutes by default. */
  idleMs?: number;
  log?: (line: string) => void;
}

/** A refusal meant for the person at the terminal, e.g. the game holds the save. */
export class CompanionError extends Error {}

export type EndReason = 'stop' | 'farewell' | 'idle' | 'game';
const REASONS: Record<EndReason, string> = { stop: '手动结束', farewell: '道别', idle: '太久没说话', game: '游戏读了这个存档' };
const HINT = '还没选好要和谁聊，请在电脑上输入 /robot 选一下。';

export class CompanionService {
  readonly snapshots: SnapshotStore;
  readonly pairing: DevicePairing;
  private readonly options: CompanionOptions;
  private readonly registry: CompanionRegistry;
  private server!: DeviceServer;
  private active: CompanionSession | undefined;
  private device: DeviceConnection | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private facesMissingLogged = false;

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
      ...(options.faces ? { faces: (npcId: string) => options.faces!.pack(npcId) } : {}),
      ...(options.host ? { host: options.host } : {}), ...(options.log ? { log: options.log } : {}),
    });
    await service.serial(() => service.recover()).catch((error: unknown) => {
      service.log(`补写上次的机器人聊天失败，下次再试：${error instanceof Error ? error.message : String(error)}`);
    });
    return service;
  }

  get port(): number {
    return this.server.port;
  }

  get session(): CompanionSession | undefined {
    return this.active;
  }

  /** The newest confirmed save point of each game save. */
  saves(): Promise<SaveSnapshot[]> {
    const store = this.options.game.runtime.ctx.store;
    return this.snapshots.latest(async (snapshot) =>
      (await store.call('getCommit', { lineageId: snapshot.lineageId, commitId: snapshot.commitId }))?.status === 'confirmed');
  }

  begin(snapshot: SaveSnapshot, npcId: string): Promise<CompanionSession> {
    return this.serial(() => this.open(snapshot, npcId));
  }

  /** Commits what was said; null when there was no session or nothing was said. */
  stop(reason: EndReason = 'stop'): Promise<string | null> {
    return this.serial(() => this.finish(reason));
  }

  /** Sends the current NPC's face again, e.g. after a download failed. False when no robot is connected. */
  refreshFace(): Promise<boolean> {
    return this.serial(async () => {
      if (!this.device) return false;
      await this.pairing.setFace(this.device.deviceId, undefined);
      await this.present(this.device);
      return true;
    });
  }

  /** The game is loading a save: robot talk on it is committed first, so the game continues from it. */
  gameLoaded(lineageId: string): Promise<void> {
    return this.serial(async () => {
      if (this.active?.identity.lineageId === lineageId) await this.finish('game');
      await this.recover();
    });
  }

  async close(): Promise<void> {
    await this.stop();
    await this.server.close();
  }

  private async open(snapshot: SaveSnapshot, npcId: string): Promise<CompanionSession> {
    if (this.active) throw new CompanionError(`机器人正在和${this.active.npcName}聊天，先输入 /robot stop`);
    await this.recover();
    await this.claim(snapshot.lineageId);
    const session = await CompanionSession.open({
      ...this.sessionDeps(), snapshot, npcId, voice: this.options.voiceFor(npcId),
      onFinish: (reason) => void this.stop(reason),
    });
    await writeJson(this.file('companion/active.json'), session.identity);
    this.active = session;
    if (this.device) await this.present(this.device);
    return session;
  }

  /** Only a save no connected game holds; a load the game left behind is closed first. */
  private async claim(lineageId: string): Promise<void> {
    if (this.options.game.holds(lineageId)) throw new CompanionError('游戏开着这个存档，先回到标题画面');
    try {
      await this.options.game.takeOver(lineageId);
    } catch (error) {
      throw new CompanionError(error instanceof Error ? error.message : String(error));
    }
  }

  private async finish(reason: EndReason): Promise<string | null> {
    const session = this.active;
    if (!session) return null;
    this.active = undefined;
    const commitId = await session.end();
    await rm(this.file('companion/active.json'), { force: true });
    this.log(commitId
      ? `和${session.npcName}的聊天已写回存档：${session.exchanges} 轮（${REASONS[reason]}）`
      : `和${session.npcName}的聊天结束，没有要写回的内容（${REASONS[reason]}）`);
    // The device goes back to idle and reconnects on its wake word.
    this.device?.close();
    return commitId;
  }

  /**
   * A session the backend never finished: reopen its load so the journal restores it, then commit. Left for later
   * while a connected game holds that save, since opening it would discard the game's unsaved day.
   */
  private async recover(): Promise<void> {
    const saved = await readJson<SessionIdentity>(this.file('companion/active.json'));
    if (!saved || this.active || this.options.game.holds(saved.lineageId)) return;
    const snapshot = await this.snapshots.read(saved.lineageId, saved.saveCommitId);
    if (snapshot) {
      await this.claim(saved.lineageId);
      const session = await CompanionSession.open({
        ...this.sessionDeps(), snapshot, npcId: saved.npcId, voice: this.options.voiceFor(saved.npcId),
        onFinish: () => {}, resume: { loadNonce: saved.loadNonce, headCommitId: saved.headCommitId },
      });
      if (await session.end()) this.log(`上次没写回的 ${session.exchanges} 轮聊天已补写进存档`);
    }
    await rm(this.file('companion/active.json'), { force: true });
  }

  private sessionDeps() {
    const { game, roster, model, speech, idleMs = 120_000, log } = this.options;
    return { runtime: game.runtime, roster, model, speech, registry: this.registry, idleMs, ...(log ? { log } : {}) };
  }

  /** One robot at a time: a new connection replaces the old one. */
  private connect(connection: DeviceConnection): void {
    if (this.device && this.device !== connection) this.device.close();
    this.device = connection;
    this.log(`机器人已连接（${connection.deviceId}）`);
    connection.handler = this.handlerFor(connection);
    void this.serial(() => this.present(connection));
  }

  /** Attaches the session, unless the device first has to restart with this NPC's face. */
  private async present(connection: DeviceConnection): Promise<void> {
    const session = this.active;
    if (!session || this.device !== connection) return;
    if (!await this.changeFace(connection, session.identity.npcId, session.npcName)) session.attach(connection);
  }

  /** True when the device was told to download the face and restart; it connects again once done. */
  private async changeFace(connection: DeviceConnection, npcId: string, npcName: string): Promise<boolean> {
    const faces = this.options.faces;
    if (!faces || this.pairing.face(connection.deviceId) === npcId) return false;
    if (!await faces.pack(npcId)) {
      if (!this.facesMissingLogged) this.log('还没有导出头像，机器人先用小智自带的表情（见 docs/companion-device.md §14）');
      this.facesMissingLogged = true;
      return false;
    }
    try {
      await connection.installFace(npcId);
    } catch (error) {
      this.log(`换头像失败，先用原来的表情：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    await this.pairing.setFace(connection.deviceId, npcId);
    this.log(`机器人正在换上${npcName}的头像：它会重启并下载头像包，好了以后说唤醒词继续`);
    return true;
  }

  private handlerFor(connection: DeviceConnection): DeviceHandler {
    let recognizer: Recognizer | undefined;
    let hinted = false;
    const hear = (text: string) => {
      connection.showUserText(text);
      if (this.active) this.active.hear(text);
      else if (!hinted) {
        hinted = true;
        this.hint(connection);
      }
    };
    const listening = () => recognizer ??= this.options.speech.recognize({
      onPartial: () => this.active?.warm(),
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
        if (state === 'detect') this.active?.warm();
        if (state !== 'stop') return;
        const finishing = recognizer;
        recognizer = undefined;
        finishing?.finish().catch((error: Error) => this.log(`语音识别出错：${error.message}`));
      },
      audio: (pcm) => listening().write(pcm),
      text: hear,
      abort: () => this.active?.interrupt(),
      closed: () => {
        recognizer?.close();
        if (this.device === connection) this.device = undefined;
        this.active?.detach(connection);
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
