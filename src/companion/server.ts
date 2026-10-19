/**
 * The xiaozhi device protocol (docs/companion-device.md §2.1): an HTTP config endpoint the firmware asks for
 * its WebSocket address, and the WebSocket carrying Opus audio and JSON messages. Devices must be paired.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';
import type { Emotion } from '../agent/dialogue.ts';
import { FRAME_MS, FramePacer, OpusDecoder, OpusEncoder } from './opus.ts';
import { readJson, writeJson } from './snapshot.ts';
import { INPUT_RATE, OUTPUT_RATE } from './voice.ts';

export const OTA_PATH = '/xiaozhi/ota/';
export const WS_PATH = '/xiaozhi/v1/';

/** The firmware's names for its built-in faces; H3 replaces the pictures, not the names. */
const DEVICE_EMOTIONS: Record<Emotion, string> = {
  neutral: 'neutral', happy: 'happy', sad: 'sad', blush: 'embarrassed', angry: 'angry', special: 'surprised',
};

/** What a session sends to the device; implemented by DeviceConnection. */
export interface DeviceLink {
  showUserText(text: string): void;
  setEmotion(emotion: Emotion): void;
  /** Idempotent: the first call of a reply starts speaking. */
  startSpeaking(): void;
  /** The sentence about to be heard, shown on screen. */
  sentence(text: string): void;
  /** OUTPUT_RATE PCM. */
  audio(pcm: Buffer): void;
  /** Resolves once everything queued has been sent. */
  stopSpeaking(): Promise<void>;
  /** Drops what has not been sent yet. */
  cancelSpeaking(): void;
  /** Roughly how much of the current reply the device has played. */
  playedMs(): number;
  close(): void;
}

/** What the device sends; whoever owns the connection sets it. */
export interface DeviceHandler {
  listen(state: 'start' | 'stop' | 'detect'): void;
  /** INPUT_RATE PCM. */
  audio(pcm: Buffer): void;
  /** Typed input from the simulator (tools/companion/device.ts); real firmware never sends it. */
  text(text: string): void;
  abort(): void;
  closed(): void;
}

interface DevicesFile {
  token: string;
  devices: string[];
}

/** Only paired devices get the token. Pairing admits the next unknown device within a short window. */
export class DevicePairing {
  private readonly file: string;
  private data: DevicesFile = { token: '', devices: [] };
  private openUntil = 0;

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    this.data = await readJson<DevicesFile>(this.file) ?? { token: randomBytes(24).toString('base64url'), devices: [] };
    await writeJson(this.file, this.data);
  }

  get token(): string {
    return this.data.token;
  }

  get pairing(): boolean {
    return Date.now() < this.openUntil;
  }

  open(ms: number): void {
    this.openUntil = Date.now() + ms;
  }

  allowed(deviceId: string): boolean {
    return this.data.devices.includes(deviceId);
  }

  /** Known devices pass; an unknown one is added only while pairing is open, which then closes. */
  async admit(deviceId: string): Promise<'known' | 'paired' | 'denied'> {
    if (this.allowed(deviceId)) return 'known';
    if (!this.pairing) return 'denied';
    this.data.devices.push(deviceId);
    this.openUntil = 0;
    await writeJson(this.file, this.data);
    return 'paired';
  }
}

export class DeviceConnection implements DeviceLink {
  readonly deviceId: string;
  readonly sessionId = randomUUID();
  handler: DeviceHandler | undefined;
  private readonly socket: WebSocket;
  private readonly decoder = new OpusDecoder(INPUT_RATE);
  private readonly encoder = new OpusEncoder(OUTPUT_RATE);
  private readonly pacer: FramePacer;
  private speaking = false;
  private ready = false;

  constructor(socket: WebSocket, deviceId: string, onReady: (connection: DeviceConnection) => void) {
    this.socket = socket;
    this.deviceId = deviceId;
    this.pacer = new FramePacer((frame) => { if (socket.readyState === socket.OPEN) socket.send(frame); });
    socket.on('message', (data, binary) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (binary) {
        const pcm = this.decoder.decode(buffer);
        if (pcm.length && this.ready) this.handler?.audio(pcm);
        return;
      }
      let message: { type?: string; state?: string; text?: string };
      try { message = JSON.parse(buffer.toString()); } catch { return; }
      if (message.type === 'hello') {
        this.send({
          type: 'hello', transport: 'websocket', session_id: this.sessionId,
          audio_params: { format: 'opus', sample_rate: OUTPUT_RATE, channels: 1, frame_duration: FRAME_MS },
        });
        if (!this.ready) { this.ready = true; onReady(this); }
      } else if (!this.ready) {
        return;
      } else if (message.type === 'listen' && (message.state === 'start' || message.state === 'stop' || message.state === 'detect')) {
        this.handler?.listen(message.state);
      } else if (message.type === 'abort') {
        this.handler?.abort();
      } else if (message.type === 'text' && typeof message.text === 'string' && message.text.trim()) {
        this.handler?.text(message.text.trim());
      }
    });
    socket.on('close', () => {
      this.pacer.clear();
      this.decoder.close();
      this.encoder.close();
      this.handler?.closed();
    });
  }

  showUserText(text: string): void {
    this.send({ type: 'stt', text });
  }

  setEmotion(emotion: Emotion): void {
    this.send({ type: 'llm', emotion: DEVICE_EMOTIONS[emotion], text: '' });
  }

  startSpeaking(): void {
    if (this.speaking) return;
    this.speaking = true;
    this.send({ type: 'tts', state: 'start' });
  }

  sentence(text: string): void {
    this.send({ type: 'tts', state: 'sentence_start', text });
  }

  audio(pcm: Buffer): void {
    this.pacer.push(this.encoder.push(pcm));
  }

  async stopSpeaking(): Promise<void> {
    this.pacer.push(this.encoder.flush());
    await this.pacer.drain();
    this.endSpeaking();
  }

  cancelSpeaking(): void {
    this.encoder.reset();
    this.pacer.clear();
    this.endSpeaking();
  }

  playedMs(): number {
    return this.pacer.sent * FRAME_MS;
  }

  close(): void {
    this.socket.close();
  }

  private endSpeaking(): void {
    if (this.speaking) this.send({ type: 'tts', state: 'stop' });
    this.speaking = false;
    this.pacer.sent = 0;
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify({ session_id: this.sessionId, ...message }));
  }
}

export interface DeviceServerOptions {
  /** 0 picks a free port (tests). */
  port: number;
  /** Devices are on the LAN, so the default listens on every interface. */
  host?: string;
  pairing: DevicePairing;
  onConnection: (connection: DeviceConnection) => void;
  log?: (line: string) => void;
}

export class DeviceServer {
  private readonly options: DeviceServerOptions;
  private readonly http: Server;
  private readonly sockets = new WebSocketServer({ noServer: true });
  /** Unknown devices already reported, so a retrying device does not flood the log. */
  private readonly reported = new Set<string>();

  private constructor(options: DeviceServerOptions, http: Server) {
    this.options = options;
    this.http = http;
    http.on('request', (request, response) => void this.request(request, response));
    http.on('upgrade', (request, socket, head) => {
      const deviceId = header(request, 'device-id');
      const authorized = header(request, 'authorization') === `Bearer ${options.pairing.token}`;
      if (!request.url?.startsWith(WS_PATH) || !authorized || !options.pairing.allowed(deviceId)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (ws) => {
        new DeviceConnection(ws, deviceId, options.onConnection);
      });
    });
  }

  static async start(options: DeviceServerOptions): Promise<DeviceServer> {
    const http = createServer();
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(options.port, options.host ?? '0.0.0.0', () => resolve());
    });
    return new DeviceServer(options, http);
  }

  get port(): number {
    return (this.http.address() as AddressInfo).port;
  }

  close(): Promise<void> {
    for (const client of this.sockets.clients) client.terminate();
    this.http.closeAllConnections();
    return new Promise((resolve) => this.http.close(() => resolve()));
  }

  /** The firmware's version check: answer with the WebSocket address and token, and no firmware update. */
  private async request(request: IncomingMessage, response: ServerResponse): Promise<void> {
    request.resume();
    if (!request.url?.startsWith(OTA_PATH)) {
      response.writeHead(404).end();
      return;
    }
    const deviceId = header(request, 'device-id');
    const admitted = deviceId ? await this.options.pairing.admit(deviceId) : 'denied';
    if (admitted === 'denied') {
      if (deviceId && !this.reported.has(deviceId)) {
        this.reported.add(deviceId);
        this.options.log?.(`新设备 ${deviceId} 请求连接：在后端输入 /robot pair，再重启机器人`);
      }
      response.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'device not paired' }));
      return;
    }
    if (admitted === 'paired') this.options.log?.(`设备 ${deviceId} 已配对`);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      websocket: { url: `ws://${request.headers.host}${WS_PATH}`, token: this.options.pairing.token, version: 1 },
      server_time: { timestamp: Date.now(), timezone_offset: -new Date().getTimezoneOffset() },
    }));
  }
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}
