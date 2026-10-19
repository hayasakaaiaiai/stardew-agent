/** Opus framing for the xiaozhi protocol: 60 ms mono frames (docs/companion-device.md §2.1). */
import OpusScript from 'opusscript';

export const FRAME_MS = 60;
type Rate = 8000 | 12000 | 16000 | 24000 | 48000;

export class OpusDecoder {
  private readonly codec: OpusScript;

  constructor(rate: Rate) {
    this.codec = new OpusScript(rate, 1);
  }

  /** 16-bit PCM; a corrupt packet yields nothing rather than an error, like a dropped frame. */
  decode(packet: Buffer): Buffer {
    try {
      return Buffer.from(this.codec.decode(packet));
    } catch {
      return Buffer.alloc(0);
    }
  }

  close(): void {
    this.codec.delete();
  }
}

export class OpusEncoder {
  private readonly codec: OpusScript;
  private readonly frameBytes: number;
  private readonly frameSamples: number;
  private rest = Buffer.alloc(0);

  constructor(rate: Rate) {
    this.codec = new OpusScript(rate, 1, OpusScript.Application.VOIP);
    this.frameSamples = rate * FRAME_MS / 1000;
    this.frameBytes = this.frameSamples * 2;
  }

  /** Encodes every whole frame in the 16-bit PCM seen so far; the remainder waits for more. */
  push(pcm: Buffer): Buffer[] {
    this.rest = Buffer.concat([this.rest, pcm]);
    const frames: Buffer[] = [];
    while (this.rest.length >= this.frameBytes) {
      frames.push(Buffer.from(this.codec.encode(this.rest.subarray(0, this.frameBytes), this.frameSamples)));
      this.rest = this.rest.subarray(this.frameBytes);
    }
    return frames;
  }

  /** Pads the remainder with silence into one last frame. */
  flush(): Buffer[] {
    if (!this.rest.length) return [];
    const padded = Buffer.alloc(this.frameBytes);
    this.rest.copy(padded);
    this.rest = Buffer.alloc(0);
    return [Buffer.from(this.codec.encode(padded, this.frameSamples))];
  }

  reset(): void {
    this.rest = Buffer.alloc(0);
  }

  close(): void {
    this.codec.delete();
  }
}

/**
 * Sends frames at playback speed after a short lead, so the device's decode queue never overflows and an
 * interruption leaves little audio already sent.
 */
export class FramePacer {
  private readonly send: (frame: Buffer) => void;
  private readonly lead: number;
  private queue: Buffer[] = [];
  private timer: NodeJS.Timeout | undefined;
  private startedAt = 0;
  private sentInRun = 0;
  private waiters: (() => void)[] = [];
  /** Frames sent since the last `clear`, i.e. roughly what has been played. */
  sent = 0;

  constructor(send: (frame: Buffer) => void, lead = 3) {
    this.send = send;
    this.lead = lead;
  }

  push(frames: Buffer[]): void {
    this.queue.push(...frames);
    if (!this.timer && this.queue.length) this.pump();
  }

  /** Resolves once every queued frame has been sent. */
  drain(): Promise<void> {
    if (!this.queue.length && !this.timer) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  clear(): void {
    this.queue = [];
    clearTimeout(this.timer);
    this.timer = undefined;
    this.sent = 0;
    this.sentInRun = 0;
    this.settle();
  }

  private pump(): void {
    this.timer = undefined;
    if (!this.queue.length) {
      this.sentInRun = 0;
      this.settle();
      return;
    }
    if (this.sentInRun === 0) this.startedAt = performance.now();
    this.send(this.queue.shift()!);
    this.sent++;
    this.sentInRun++;
    // Frames past the lead go out when the device has played the ones before them.
    const due = this.startedAt + Math.max(0, this.sentInRun - this.lead) * FRAME_MS;
    this.timer = setTimeout(() => this.pump(), Math.max(0, due - performance.now()));
  }

  private settle(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
