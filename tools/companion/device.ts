/**
 * Pretends to be the robot (docs/companion-device.md §10, H1): asks the config endpoint the way the firmware
 * does, connects, and lets you type instead of speak. Each reply is saved as a WAV file.
 *
 *   npm run device
 *   npm run device -- --server http://192.168.1.5:47712 --id 02:00:00:00:00:01
 *
 * A typed line is sent as if spoken; /wav <file> streams a 16 kHz mono 16-bit WAV through speech recognition;
 * /abort cuts in while the NPC talks; /quit leaves.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { FRAME_MS, OpusDecoder, OpusEncoder } from '../../src/companion/opus.ts';
import { OTA_PATH } from '../../src/companion/server.ts';
import { INPUT_RATE, OUTPUT_RATE } from '../../src/companion/voice.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const REPLIES = join(ROOT, '.runtime/companion/replies');

const { values } = parseArgs({
  options: {
    server: { type: 'string', default: 'http://127.0.0.1:47712' },
    id: { type: 'string', default: '02:00:00:00:00:01' },
  },
});

const deviceId = values.id!;
const clientId = randomUUID();
const response = await fetch(`${values.server!.replace(/\/+$/, '')}${OTA_PATH}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Device-Id': deviceId, 'Client-Id': clientId },
  body: JSON.stringify({ application: { name: 'simulator' } }),
});
if (response.status === 403) {
  console.error('这台模拟机器人还没配对：在后端输入 /robot pair，再运行一次。');
  process.exit(1);
}
if (!response.ok) throw new Error(`Config endpoint answered HTTP ${response.status}`);
const config = await response.json() as { websocket: { url: string; token: string } };

const socket = new WebSocket(config.websocket.url, {
  headers: { Authorization: `Bearer ${config.websocket.token}`, 'Protocol-Version': '1', 'Device-Id': deviceId, 'Client-Id': clientId },
});
const decoder = new OpusDecoder(OUTPUT_RATE);
let reply: Buffer[] = [];
let replies = 0;
/** When the player finished speaking, to time the first audio of the answer. */
let spokeAt: number | undefined;
let firstAudioMs: number | undefined;

socket.on('open', () => socket.send(JSON.stringify({
  type: 'hello', version: 1, transport: 'websocket',
  audio_params: { format: 'opus', sample_rate: INPUT_RATE, channels: 1, frame_duration: FRAME_MS },
})));
socket.on('close', (code) => {
  console.log(`（连接已断开 ${code}）`);
  process.exit(0);
});
socket.on('message', (data, binary) => {
  if (binary) {
    if (spokeAt !== undefined && firstAudioMs === undefined) firstAudioMs = Math.round(performance.now() - spokeAt);
    reply.push(decoder.decode(data as Buffer));
    return;
  }
  const message = JSON.parse(String(data)) as { type: string; state?: string; text?: string; emotion?: string };
  if (message.type === 'hello') {
    console.log('已连接。打字就是说话，/wav <文件> 送一段录音，/abort 打断，/quit 退出。');
    socket.send(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
  } else if (message.type === 'stt') console.log(`（识别：${message.text}）`);
  else if (message.type === 'llm') console.log(`（表情：${message.emotion}）`);
  else if (message.type === 'tts' && message.state === 'start') reply = [];
  else if (message.type === 'tts' && message.state === 'sentence_start') console.log(`  ${message.text}`);
  else if (message.type === 'tts' && message.state === 'stop') void saveReply();
});

async function saveReply() {
  const pcm = Buffer.concat(reply);
  reply = [];
  if (!pcm.length) return;
  await mkdir(REPLIES, { recursive: true });
  const file = join(REPLIES, `${String(++replies).padStart(3, '0')}.wav`);
  await writeFile(file, wav(pcm, OUTPUT_RATE));
  const timing = firstAudioMs === undefined ? '' : `，从说完到第一段声音 ${firstAudioMs} ms`;
  console.log(`  （${(pcm.length / 2 / OUTPUT_RATE).toFixed(1)} 秒，${file}${timing}）`);
  spokeAt = undefined;
  firstAudioMs = undefined;
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const input = line.trim();
  if (!input) return;
  if (input === '/quit') socket.close();
  else if (input === '/abort') socket.send(JSON.stringify({ type: 'abort', reason: 'wake_word_detected' }));
  else if (input.startsWith('/wav ')) void stream(input.slice(5).trim()).catch((error: Error) => console.error(error.message));
  else {
    spokeAt = performance.now();
    socket.send(JSON.stringify({ type: 'text', text: input }));
  }
});

/** Sends the file at playback speed, then stops listening so recognition reports the last sentence. */
async function stream(file: string) {
  const pcm = readWav(await readFile(file));
  const encoder = new OpusEncoder(INPUT_RATE);
  const frames = [...encoder.push(pcm), ...encoder.flush()];
  socket.send(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
  const started = performance.now();
  for (const [i, frame] of frames.entries()) {
    socket.send(frame);
    await new Promise((done) => setTimeout(done, Math.max(0, started + (i + 1) * FRAME_MS - performance.now())));
  }
  encoder.close();
  spokeAt = performance.now();
  socket.send(JSON.stringify({ type: 'listen', state: 'stop' }));
  socket.send(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
}

function readWav(file: Buffer): Buffer {
  if (file.toString('ascii', 0, 4) !== 'RIFF' || file.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let format: { channels: number; rate: number; bits: number } | undefined;
  for (let at = 12; at + 8 <= file.length;) {
    const id = file.toString('ascii', at, at + 4);
    const size = file.readUInt32LE(at + 4);
    if (id === 'fmt ') format = { channels: file.readUInt16LE(at + 10), rate: file.readUInt32LE(at + 12), bits: file.readUInt16LE(at + 22) };
    if (id === 'data') {
      if (!format || format.channels !== 1 || format.rate !== INPUT_RATE || format.bits !== 16) {
        throw new Error('需要 16 kHz、单声道、16 位的 WAV，比如：ffmpeg -i in.m4a -ar 16000 -ac 1 -sample_fmt s16 out.wav');
      }
      return file.subarray(at + 8, at + 8 + size);
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('WAV file has no data');
}

function wav(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
