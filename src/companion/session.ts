/**
 * One robot session: a save, an NPC, and turns until goodbye (docs/companion-device.md §4–5). Each exchange is
 * recorded once it has been heard; ending the session writes one companion commit after the save.
 */
import { randomUUID } from 'node:crypto';
import { AgentMemory } from '../agent/dialogue-memory.ts';
import {
  type DialogueMemory, type Emotion, type Exchange, type MemoryContext, REAL_WORLD_MARK, type Remembered, runTurn,
  type Season, type Standing, type WorldState,
} from '../agent/dialogue.ts';
import type { createRuntime, SaveScope } from '../index.ts';
import type { ModelClient } from '../services/model/client.ts';
import type { Roster } from '../services/roster/index.ts';
import type { CommitRef, DayEntry } from '../types.ts';
import { COMPANION_PREFIX, type CompanionRegistry, isCompanionCommit } from './registry.ts';
import type { DeviceLink } from './server.ts';
import type { SaveSnapshot } from './snapshot.ts';
import { OUTPUT_RATE, type SpeechServices, type Synthesizer } from './voice.ts';

export type Runtime = Awaited<ReturnType<typeof createRuntime>>;

export const ROBOT_OPENING = '（农场主打开了桌上的小机器人）';
const EMOTIONS = new Set<string>(['neutral', 'happy', 'sad', 'blush', 'angry', 'special']);
const SEASONS: Season[] = ['spring', 'summer', 'fall', 'winter'];
const SEASON_NAMES: Record<Season, string> = { spring: '春季', summer: '夏季', fall: '秋季', winter: '冬季' };
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** Enough to reopen the same load after a crash, so the journal restores what was said. */
export interface SessionIdentity {
  lineageId: string;
  saveCommitId: string;
  npcId: string;
  loadNonce: string;
  headCommitId: string;
}

export interface SessionDeps {
  runtime: Runtime;
  roster: Roster;
  model: ModelClient;
  speech: SpeechServices;
  registry: CompanionRegistry;
  snapshot: SaveSnapshot;
  npcId: string;
  voice: string;
  /** The session finishes after this long without the player saying anything. */
  idleMs: number;
  /** The NPC said goodbye or the player went quiet; the owner then ends the session. */
  onFinish: (reason: 'farewell' | 'idle') => void;
  now?: () => Date;
  log?: (line: string) => void;
  resume?: Pick<SessionIdentity, 'loadNonce' | 'headCommitId'>;
}

interface Turn {
  link: DeviceLink;
  synth: Synthesizer;
  interrupted: boolean;
  /** Audio received for this reply and audio the device had played when cut off. */
  audioMs: number;
  playedMs: number;
}

export class CompanionSession {
  readonly identity: SessionIdentity;
  private readonly deps: SessionDeps;
  private readonly scope: SaveScope;
  private readonly memory: HeardMemory;
  private readonly world: WorldState;
  private readonly standing: Standing;
  private link: DeviceLink | undefined;
  private queue: Promise<void> = Promise.resolve();
  private current: Turn | undefined;
  private greeted: boolean;
  private idle: NodeJS.Timeout | undefined;
  private ending: Promise<string | null> | undefined;

  static async open(deps: SessionDeps): Promise<CompanionSession> {
    const { runtime, snapshot, registry, npcId } = deps;
    const { lineageId } = snapshot;
    const store = runtime.ctx.store;
    await registry.reconcile(lineageId, async (commitId) => {
      const commit = await store.call('getCommit', { lineageId, commitId });
      if (commit?.status === 'prepared') await store.call('confirm', { lineageId, commitId });
      return commit !== null;
    });
    const headCommitId = deps.resume?.headCommitId ?? await registry.head(lineageId, snapshot.commitId);
    const loadNonce = deps.resume?.loadNonce ?? randomUUID();
    const scope = await runtime.ctx.saves.load({ lineageId, loadNonce, day: snapshot.dayEnded, commitId: headCommitId });
    const earlier = await lastTownTalk(runtime, lineageId, snapshot.commitId, npcId);
    return new CompanionSession(deps, scope, { lineageId, saveCommitId: snapshot.commitId, npcId, loadNonce, headCommitId }, earlier);
  }

  private constructor(deps: SessionDeps, scope: SaveScope, identity: SessionIdentity, earlier: MemoryContext['earlier']) {
    this.deps = deps;
    this.scope = scope;
    this.identity = identity;
    const { snapshot, npcId } = deps;
    const today = scope.ledger.currentDay?.overlay(npcId).today ?? [];
    let seq = Math.max(0, ...today.map((entry) => entry.seq));
    // Everything said through the robot belongs to the end of the saved day, like nightly consolidation.
    const gameTime = snapshot.dayEnded * 1440 + 1439;
    const inner = new AgentMemory(() => scope.agent(npcId), { now: () => gameTime, nextSeq: () => ++seq });
    this.memory = new HeardMemory(inner, earlier, () => realWorldLabel(this.now()), today.length);
    this.greeted = today.length > 0;
    this.world = {
      ...gameDate(snapshot.dayEnded), time: '', weather: '', location: '现实世界', player: snapshot.player, facts: snapshot.facts,
    };
    const standing = snapshot.npcs[npcId] ?? { hearts: 0, relation: 'stranger' as const };
    this.standing = { hearts: standing.hearts, relation: standing.relation, seenEvents: new Set(snapshot.seenEvents) };
    this.touch();
  }

  get npcName(): string {
    return this.deps.roster.get(this.deps.npcId).name;
  }

  /** Exchanges recorded in this session, including any recovered after a crash. */
  get exchanges(): number {
    return this.memory.recorded;
  }

  attach(link: DeviceLink): void {
    this.link = link;
    this.touch();
    if (!this.greeted) {
      this.greeted = true;
      this.enqueue(ROBOT_OPENING);
    }
  }

  detach(link: DeviceLink): void {
    if (this.link !== link) return;
    this.interrupt();
    this.link = undefined;
  }

  /** A finished sentence from the player. Talking over the NPC cuts it off. */
  hear(text: string): void {
    if (this.ending) return;
    this.log(`农场主：${text}`);
    this.touch();
    this.interrupt();
    this.enqueue(text);
  }

  /** The player has started speaking: get the model connection ready for when they finish. */
  warm(): void {
    if (!this.ending) this.deps.model.warm();
  }

  interrupt(): void {
    const turn = this.current;
    if (!turn || turn.interrupted) return;
    turn.interrupted = true;
    turn.playedMs = turn.link.playedMs();
    turn.synth.close();
    turn.link.cancelSpeaking();
  }

  /** Waits for the turn in progress, then commits what was said. Null when nothing was. */
  end(): Promise<string | null> {
    this.ending ??= this.finish();
    return this.ending;
  }

  private async finish(): Promise<string | null> {
    clearTimeout(this.idle);
    this.interrupt();
    await this.queue;
    const { lineageId, saveCommitId } = this.identity;
    let commitId: string | null = null;
    if (this.memory.recorded > 0) {
      commitId = `${COMPANION_PREFIX}${randomUUID()}`;
      await this.deps.registry.begin(lineageId, saveCommitId, commitId);
      await this.scope.prepare(commitId);
      await this.scope.confirm(commitId);
      await this.deps.registry.complete(lineageId, saveCommitId, commitId);
    }
    await this.deps.runtime.ctx.saves.returnToTitle(lineageId);
    return commitId;
  }

  private enqueue(playerLine: string): void {
    this.queue = this.queue.then(() => this.turn(playerLine));
  }

  private async turn(playerLine: string): Promise<void> {
    const link = this.link;
    if (!link || this.ending) return;
    const started = performance.now();
    let firstAudioMs: number | null = null;
    const turn: Turn = { link, interrupted: false, audioMs: 0, playedMs: 0, synth: undefined as unknown as Synthesizer };
    // Opened before the model call, so the connection is ready by the first sentence.
    turn.synth = this.deps.speech.synthesize(this.deps.voice, {
      onAudio: (pcm) => {
        if (turn.interrupted) return;
        firstAudioMs ??= Math.round(performance.now() - started);
        turn.audioMs += pcm.length / 2 / OUTPUT_RATE * 1000;
        link.startSpeaking();
        link.audio(pcm);
      },
      onError: (error) => this.log(`语音合成出错：${error.message}`),
    });
    this.current = turn;
    const splitter = new SentenceSplitter();
    const speak = (pieces: string[]) => {
      for (const piece of pieces) {
        link.startSpeaking();
        link.sentence(piece);
        turn.synth.push(piece);
      }
    };
    let raw = '';
    let emotion: Emotion | undefined;
    try {
      const result = await runTurn({ roster: this.deps.roster, model: this.deps.model, memory: this.memory }, {
        npcId: this.deps.npcId, world: this.world, standing: this.standing, playerLine, voice: { now: formatNow(this.now()) },
      }, {
        onContent: (delta) => {
          if (emotion) return;
          raw += delta;
          const match = /"emotion"\s*:\s*"(\w+)"/.exec(raw);
          if (match && EMOTIONS.has(match[1]!)) {
            emotion = match[1] as Emotion;
            if (!turn.interrupted) link.setEmotion(emotion);
          }
        },
        onReply: (text) => { if (!turn.interrupted) speak(splitter.push(text)); },
      });
      if (!turn.interrupted) {
        if (!emotion) link.setEmotion(result.meta.emotion);
        speak(splitter.flush());
        await turn.synth.finish();
        if (!turn.interrupted) await link.stopSpeaking();
      }
      const spoken = turn.interrupted ? spokenPart(result.reply, turn.playedMs / Math.max(turn.audioMs, 1)) : undefined;
      await this.memory.commit(spoken);
      const usage = result.usage
        ? `，输入 ${result.usage.inputTokens}（缓存 ${result.usage.cachedInputTokens ?? '-'}），推理 ${result.usage.reasoningTokens ?? '-'}` : '';
      this.log(`${this.npcName}：${spoken ?? result.reply}  （首字 ${result.timing.firstReplyMs ?? '-'} ms，首音 ${firstAudioMs ?? '-'} ms${usage}）`);
      if (result.meta.end && !turn.interrupted) this.deps.onFinish('farewell');
    } catch (error) {
      this.memory.drop();
      turn.synth.close();
      link.cancelSpeaking();
      this.log(`这一轮失败，没有记下来：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.current = undefined;
      this.touch();
    }
  }

  private touch(): void {
    clearTimeout(this.idle);
    if (this.ending) return;
    this.idle = setTimeout(() => this.deps.onFinish('idle'), this.deps.idleMs);
    this.idle.unref();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }
}

/** Holds each exchange until it has been heard, then records what was actually said. */
class HeardMemory implements DialogueMemory {
  private readonly inner: AgentMemory;
  private readonly earlier: MemoryContext['earlier'];
  private readonly label: () => string;
  private pending: { exchange: Exchange; remembered: Remembered[] } | undefined;
  recorded: number;

  constructor(inner: AgentMemory, earlier: MemoryContext['earlier'], label: () => string, recorded: number) {
    this.inner = inner;
    this.earlier = earlier;
    this.label = label;
    this.recorded = recorded;
  }

  async context(query: string, standing: Standing): Promise<MemoryContext> {
    const context = await this.inner.context(query, standing);
    return this.earlier ? { ...context, earlier: this.earlier } : context;
  }

  async record(exchange: Exchange, remembered: Remembered[]): Promise<void> {
    this.pending = { exchange, remembered };
  }

  /** `spoken` replaces the reply when the player cut it off. */
  async commit(spoken?: string): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    const label = this.label();
    await this.inner.record({ player: pending.exchange.player, npc: spoken ?? pending.exchange.npc },
      pending.remembered.map((item) => ({ ...item, text: `${label}${item.text}` })));
    this.recorded++;
  }

  drop(): void {
    this.pending = undefined;
  }
}

/** The last day in town this NPC talked with the player, up to a week back (docs/companion-device.md §5.1). */
async function lastTownTalk(runtime: Runtime, lineageId: string, saveCommitId: string, npcId: string): Promise<MemoryContext['earlier']> {
  const store = runtime.ctx.store;
  let commitId: string | null = saveCommitId;
  for (let step = 0; commitId && step < 7; step++) {
    const commit: CommitRef | null = await store.call('getCommit', { lineageId, commitId });
    if (!commit) break;
    if (!isCompanionCommit(commit.id)) {
      const { npcs } = await store.call('consolidationInput', { lineageId, commitId: commit.id, npcIds: [npcId] });
      const exchanges = exchangesOf(npcs[0]?.logs ?? []);
      if (exchanges.length) {
        const date = gameDate(commit.dayEnded);
        return { title: `上次在镇上和农场主的对话（第 ${date.year} 年${SEASON_NAMES[date.season]} ${date.day} 日）`, exchanges: exchanges.slice(-10) };
      }
    }
    commitId = commit.parentId;
  }
  return undefined;
}

function exchangesOf(entries: DayEntry[]): Exchange[] {
  return entries.flatMap((entry): Exchange[] => {
    const log = entry.changes[0]?.log;
    return log && typeof log.player === 'string' && typeof log.npc === 'string' ? [{ player: log.player, npc: log.npc }] : [];
  });
}

const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '~', '～']);
const CLAUSE_END = new Set(['，', ',', '、', '：', ':']);
/** A clause this long is synthesized on its own, so the first words come sooner. */
const MIN_CLAUSE = 8;
const speakable = (text: string) => /[\p{L}\p{N}]/u.test(text);

/** Cuts streamed text into pieces worth synthesizing. Punctuation-only leftovers are dropped. */
export class SentenceSplitter {
  private buffer = '';

  push(text: string): string[] {
    const chars = Array.from(this.buffer + text);
    const pieces: string[] = [];
    let start = 0;
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i]!;
      const sentence = SENTENCE_END.has(char) && !SENTENCE_END.has(chars[i + 1] ?? '');
      const clause = CLAUSE_END.has(char) && i + 1 - start >= MIN_CLAUSE;
      if (sentence || clause) {
        pieces.push(chars.slice(start, i + 1).join('').trim());
        start = i + 1;
      }
    }
    this.buffer = chars.slice(start).join('');
    return pieces.filter(speakable);
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return speakable(rest) ? [rest] : [];
  }
}

/** The share of a reply the player heard before cutting in, judged by playback time. */
export function spokenPart(reply: string, fraction: number): string {
  const chars = Array.from(reply);
  const heard = Math.max(0, Math.min(chars.length, Math.floor(chars.length * fraction)));
  return heard >= chars.length ? reply : `${chars.slice(0, heard).join('')}……`;
}

export function gameDate(absolute: number): { year: number; season: Season; day: number } {
  const index = absolute - 1;
  return { year: Math.floor(index / 112) + 1, season: SEASONS[Math.floor(index / 28) % 4]!, day: (index % 28) + 1 };
}

export function formatNow(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日（${WEEKDAYS[date.getDay()]}）${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Starts with REAL_WORLD_MARK, which is how prompts tell these memories apart. */
export function realWorldLabel(date: Date): string {
  return `${REAL_WORLD_MARK} ${date.getMonth() + 1} 月 ${date.getDate()} 日）`;
}
