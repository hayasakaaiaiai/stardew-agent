/**
 * Speech recognition and synthesis (docs/companion-device.md §7): Alibaba Cloud Model Studio (DashScope) over
 * WebSocket, or silence when no key is configured so the rest can still be tried by typing.
 */
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

/** What recognition takes and synthesis returns: mono 16-bit PCM. */
export const INPUT_RATE = 16000;
export const OUTPUT_RATE = 24000;

export interface RecognizerHandlers {
  onPartial?: (text: string) => void;
  /** A finished sentence; the service decides where sentences end. */
  onSentence: (text: string) => void;
  onError: (error: Error) => void;
}

export interface Recognizer {
  /** INPUT_RATE PCM. Audio written before the task starts is held until it does. */
  write(pcm: Buffer): void;
  /** Resolves once the last sentence has been reported. */
  finish(): Promise<void>;
  close(): void;
}

export interface SynthesizerHandlers {
  /** OUTPUT_RATE PCM. */
  onAudio: (pcm: Buffer) => void;
  onError: (error: Error) => void;
}

export interface Synthesizer {
  /** Text may arrive in pieces; the service holds incomplete sentences until they end. */
  push(text: string): void;
  /** Resolves once all audio has been delivered. */
  finish(): Promise<void>;
  close(): void;
}

export interface SpeechServices {
  readonly name: string;
  recognize(handlers: RecognizerHandlers): Recognizer;
  synthesize(voice: string, handlers: SynthesizerHandlers): Synthesizer;
}

export interface DashScopeConfig {
  apiKey: string;
  url: string;
  asrModel: string;
  ttsModel: string;
  /** Silence that ends a sentence; the service default (1300 ms) feels slow in conversation. */
  sentenceSilenceMs: number;
  /** A hotword list created in the console, e.g. for NPC and place names. */
  vocabularyId?: string;
}

/** Undefined when DASHSCOPE_API_KEY is missing. */
export function dashScopeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DashScopeConfig | undefined {
  const apiKey = env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) return undefined;
  const vocabularyId = env.DASHSCOPE_VOCABULARY_ID?.trim();
  return {
    apiKey,
    url: env.DASHSCOPE_WS_URL?.trim() || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    asrModel: env.DASHSCOPE_ASR_MODEL?.trim() || 'paraformer-realtime-v2',
    ttsModel: env.DASHSCOPE_TTS_MODEL?.trim() || 'cosyvoice-v3-flash',
    sentenceSilenceMs: Number(env.NPC_VOICE_SILENCE_MS ?? 700),
    ...(vocabularyId ? { vocabularyId } : {}),
  };
}

interface ServerEvent {
  header: { event: string; task_id: string; error_code?: string; error_message?: string };
  payload: { output?: { sentence?: { text: string; sentence_end: boolean; heartbeat?: boolean } } };
}

/**
 * One duplex task on its own connection: run-task, wait for task-started, then messages in order.
 * Everything sent before the task starts is queued, so callers never wait on the handshake.
 */
class DashScopeTask {
  private readonly socket: WebSocket;
  private readonly taskId = randomUUID();
  private queue: (string | Buffer)[] = [];
  private started = false;
  private closed = false;
  private finished: { resolve: () => void; reject: (error: Error) => void } | undefined;

  constructor(config: DashScopeConfig, payload: object, handlers: {
    onEvent: (event: ServerEvent) => void;
    onAudio?: (data: Buffer) => void;
    onError: (error: Error) => void;
  }) {
    this.socket = new WebSocket(config.url, { headers: { Authorization: `Bearer ${config.apiKey}` } });
    const fail = (error: Error) => {
      if (this.closed) return;
      this.close();
      if (this.finished) this.finished.reject(error);
      else handlers.onError(error);
    };
    this.socket.on('open', () => this.socket.send(this.command('run-task', payload)));
    this.socket.on('error', fail);
    this.socket.on('close', () => fail(new Error('DashScope connection closed')));
    this.socket.on('message', (data, binary) => {
      if (binary) {
        handlers.onAudio?.(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        return;
      }
      const event = JSON.parse(String(data)) as ServerEvent;
      switch (event.header.event) {
        case 'task-started':
          this.started = true;
          for (const item of this.queue.splice(0)) this.socket.send(item);
          break;
        case 'task-failed':
          fail(new Error(`DashScope ${event.header.error_code ?? 'error'}: ${event.header.error_message ?? ''}`));
          break;
        case 'task-finished':
          this.finished?.resolve();
          this.close();
          break;
        default:
          handlers.onEvent(event);
      }
    });
  }

  send(item: string | Buffer): void {
    if (this.closed) return;
    if (this.started) this.socket.send(item);
    else this.queue.push(item);
  }

  command(action: 'run-task' | 'continue-task' | 'finish-task', payload: object): string {
    return JSON.stringify({ header: { action, task_id: this.taskId, streaming: 'duplex' }, payload });
  }

  finish(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const done = new Promise<void>((resolve, reject) => { this.finished = { resolve, reject }; });
    this.send(this.command('finish-task', { input: {} }));
    return done;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.removeAllListeners('close');
    this.socket.terminate();
  }
}

export class DashScopeSpeech implements SpeechServices {
  readonly name: string;
  private readonly config: DashScopeConfig;

  constructor(config: DashScopeConfig) {
    this.config = config;
    this.name = `百炼（${config.asrModel} / ${config.ttsModel}）`;
  }

  recognize(handlers: RecognizerHandlers): Recognizer {
    const { config } = this;
    const task = new DashScopeTask(config, {
      task_group: 'audio', task: 'asr', function: 'recognition', model: config.asrModel, input: {},
      parameters: {
        format: 'pcm', sample_rate: INPUT_RATE, language_hints: ['zh'],
        max_sentence_silence: config.sentenceSilenceMs,
        ...(config.vocabularyId ? { vocabulary_id: config.vocabularyId } : {}),
      },
    }, {
      onEvent: (event) => {
        const sentence = event.payload.output?.sentence;
        if (!sentence || sentence.heartbeat) return;
        if (sentence.sentence_end) { if (sentence.text.trim()) handlers.onSentence(sentence.text.trim()); }
        else handlers.onPartial?.(sentence.text);
      },
      onError: handlers.onError,
    });
    return { write: (pcm) => task.send(pcm), finish: () => task.finish(), close: () => task.close() };
  }

  synthesize(voice: string, handlers: SynthesizerHandlers): Synthesizer {
    const task = new DashScopeTask(this.config, {
      task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: this.config.ttsModel, input: {},
      parameters: { text_type: 'PlainText', voice, format: 'pcm', sample_rate: OUTPUT_RATE, volume: 50, rate: 1, pitch: 1 },
    }, { onEvent: () => {}, onAudio: handlers.onAudio, onError: handlers.onError });
    return {
      push: (text) => { if (text) task.send(task.command('continue-task', { input: { text } })); },
      finish: () => task.finish(),
      close: () => task.close(),
    };
  }
}

/**
 * No speech service: typed input only, and each line "spoken" as silence of about the time it would take
 * (5 characters a second), so pacing and interruption behave as with real audio.
 */
export class SilentSpeech implements SpeechServices {
  readonly name = '无语音（只能打字，回答是静音）';

  recognize(handlers: RecognizerHandlers): Recognizer {
    queueMicrotask(() => handlers.onError(new Error('Speech recognition needs DASHSCOPE_API_KEY')));
    return { write: () => {}, finish: async () => {}, close: () => {} };
  }

  synthesize(_voice: string, handlers: SynthesizerHandlers): Synthesizer {
    let closed = false;
    return {
      push: (text) => {
        const samples = Math.round(Array.from(text).length / 5 * OUTPUT_RATE);
        if (!closed && samples) handlers.onAudio(Buffer.alloc(samples * 2));
      },
      finish: async () => {},
      close: () => { closed = true; },
    };
  }
}
