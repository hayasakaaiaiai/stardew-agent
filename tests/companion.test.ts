import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import {
  buildMessages, parseOutput, runTurn, VOICE_JSON_HINT, type WorldState,
} from '../src/agent/dialogue.ts';
import { PortraitPacks } from '../src/companion/assets.ts';
import { DatabaseBusyError } from '../src/companion/locks.ts';
import { OpusEncoder } from '../src/companion/opus.ts';
import { CompanionRegistry, isCompanionCommit } from '../src/companion/registry.ts';
import { type DeviceLink, OTA_PATH } from '../src/companion/server.ts';
import { CompanionError, CompanionService } from '../src/companion/service.ts';
import { CompanionSession, SentenceSplitter, spokenPart } from '../src/companion/session.ts';
import { type SaveSnapshot, SnapshotStore, writeJson } from '../src/companion/snapshot.ts';
import { DashScopeSpeech, INPUT_RATE, OUTPUT_RATE, type SpeechServices } from '../src/companion/voice.ts';
import { createRuntime } from '../src/index.ts';
import type { ChatMessage, Completion, ModelClient, StreamHandlers } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';
import { ChatSave } from '../tools/chat/session.ts';
import { writePortraits } from './helpers/faces.ts';

const WORLD: WorldState = {
  year: 1, season: 'spring', day: 17, time: '15:00', weather: '晴', location: '海滩',
  player: { name: '小林', gender: 'female', farm: '晴空' }, facts: {},
};
const FRIEND = { hearts: 4, seenEvents: new Set<string>(), relation: 'friend' as const };

function completion(content: string): Completion {
  return { content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
}

/** The game-mode model used to talk in town before the robot. */
function townModel(replies: string[]) {
  let calls = 0;
  const sent: ChatMessage[][] = [];
  const model = {
    async chat(messages: ChatMessage[], handlers: StreamHandlers): Promise<Completion> {
      sent.push(messages);
      const content = JSON.stringify({ reply: replies[calls++] ?? '嗯。', emotion: 'neutral', options: ['a', 'b', 'c'], remember: [], end: false });
      handlers.onContent?.(content);
      return completion(content);
    },
  } as unknown as ModelClient;
  return { model, sent };
}

/** Voice replies, streamed in small pieces like the real API so emotion and sentences are picked out early. */
function voiceModel(replies: { reply: string; emotion?: string; remember?: string; end?: boolean }[]) {
  const sent: ChatMessage[][] = [];
  let warmed = 0;
  const model = {
    warm() { warmed++; },
    async chat(messages: ChatMessage[], handlers: StreamHandlers): Promise<Completion> {
      sent.push(messages);
      const next = replies[sent.length - 1] ?? { reply: '嗯。' };
      const content = JSON.stringify({
        emotion: next.emotion ?? 'happy', reply: next.reply, end: next.end ?? false,
        remember: next.remember ? [{ text: next.remember, importance: 4 }] : [],
      });
      for (let i = 0; i < content.length; i += 7) handlers.onContent?.(content.slice(i, i + 7));
      return completion(content);
    },
  } as unknown as ModelClient;
  return { model, sent, lastUser: (i: number) => sent[i]!.at(-1)!.content, warmed: () => warmed };
}

/** Each piece of text becomes `msPerPiece` of silence; recognition reports the scripted lines on finish. */
function fakeSpeech(options: { msPerPiece?: number; heard?: string[] } = {}) {
  const pushed: string[] = [];
  const speech: SpeechServices = {
    name: 'fake',
    recognize(handlers) {
      let bytes = 0;
      return {
        write: (pcm) => {
          if (!bytes) handlers.onPartial?.('我');
          bytes += pcm.length;
        },
        finish: async () => {
          const text = options.heard?.shift();
          if (bytes && text) handlers.onSentence(text);
        },
        close: () => {},
      };
    },
    synthesize(_voice, handlers) {
      let closed = false;
      return {
        push: (text) => {
          pushed.push(text);
          if (!closed) handlers.onAudio(Buffer.alloc(Math.round((options.msPerPiece ?? 120) / 1000 * OUTPUT_RATE) * 2));
        },
        finish: async () => {},
        close: () => { closed = true; },
      };
    },
  };
  return { speech, pushed };
}

async function until(check: () => boolean, what: string, timeoutMs = 5000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

interface Message { type: string; state?: string; text?: string; emotion?: string; payload?: { id: number; params: { name: string; arguments: { url?: string } } } }

/** A robot as the firmware behaves: config endpoint first, then the WebSocket and hello. */
async function connectDevice(port: number, deviceId = '02:00:00:00:00:01') {
  const response = await fetch(`http://127.0.0.1:${port}${OTA_PATH}`, { method: 'POST', headers: { 'Device-Id': deviceId } });
  assert.equal(response.status, 200, 'the device is paired');
  const { websocket } = await response.json() as { websocket: { url: string; token: string } };
  const socket = new WebSocket(websocket.url, { headers: { Authorization: `Bearer ${websocket.token}`, 'Device-Id': deviceId } });
  const messages: Message[] = [];
  const frames: Buffer[] = [];
  socket.on('message', (data, binary) => {
    if (binary) frames.push(data as Buffer);
    else messages.push(JSON.parse(String(data)) as Message);
  });
  const closed = once(socket, 'close');
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'hello', version: 1, transport: 'websocket', audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } }));
  await until(() => messages.some((m) => m.type === 'hello'), 'hello');
  const stops = () => messages.filter((m) => m.type === 'tts' && m.state === 'stop').length;
  return { socket, messages, frames, closed, stops, send: (message: object) => socket.send(JSON.stringify(message)) };
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'companion-'));
  const roster = new Roster({ directory: resolve(import.meta.dirname, '../data/npcs'), npcIds: SOCIAL_NPCS });
  await roster.load();
  return { directory, roster, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

/** Talks to Haley in town and saves once per day, as session A. Returns the saves' snapshots, oldest first. */
async function townSave(directory: string, roster: Roster, days = 1): Promise<SaveSnapshot[]> {
  const save = await ChatSave.open({ directory, name: 'town', fresh: true, startDay: 17, npcIds: SOCIAL_NPCS });
  const town = townModel(['今天海滩风好大。', '明天见。']);
  const snapshots = new SnapshotStore(join(directory, 'saves'));
  const saved: SaveSnapshot[] = [];
  try {
    for (let i = 0; i < days; i++) {
      const memory = save.memory('haley', () => save.day * 1440 + 900);
      await runTurn({ roster, model: town.model, memory }, { npcId: 'haley', world: WORLD, standing: FRIEND, playerLine: i ? '早' : '你在拍照吗？' });
      await save.sleep({ label: 'town', player: WORLD.player, facts: {}, npcs: { haley: { hearts: 4, relation: 'friend' } }, seenEvents: [] });
      saved.push((await snapshots.latest())[0]!);
    }
  } finally {
    await save.close();
  }
  return saved;
}

async function startCompanion(directory: string, roster: Roster, model: ModelClient, speech: SpeechServices, idleMs = 60_000,
  faces?: PortraitPacks) {
  const service = await CompanionService.start({
    dataDirectory: directory, roster, model, speech, voiceFor: () => 'voice', npcIds: SOCIAL_NPCS, port: 0, host: '127.0.0.1', idleMs,
    ...(faces ? { faces } : {}),
  });
  service.pairing.open(60_000);
  return service;
}

async function robotLogs(directory: string, snapshot: SaveSnapshot) {
  const commitId = await new CompanionRegistry(join(directory, 'companion/registry')).head(snapshot.lineageId, snapshot.commitId);
  const runtime = await createRuntime({ databasePath: join(directory, 'memory.sqlite'), journalDirectory: join(directory, 'scratch'), npcIds: SOCIAL_NPCS });
  try {
    const { npcs } = await runtime.ctx.store.call('consolidationInput', { lineageId: snapshot.lineageId, commitId, npcIds: ['haley'] });
    return { commitId, logs: npcs[0]!.logs.map((entry) => entry.changes[0]!.log as { player: string; npc: string }) };
  } finally {
    await runtime.close();
  }
}

test('speech is cut at sentences or long clauses, and a cut-off reply keeps the part that was heard', () => {
  const splitter = new SentenceSplitter();
  assert.deepEqual(splitter.push('嘿！你来'), ['嘿！']);
  assert.deepEqual(splitter.push('啦，今天海滩上的风真的好大，'), ['你来啦，今天海滩上的风真的好大，']);
  assert.deepEqual(splitter.push('对吧'), []);
  assert.deepEqual(splitter.flush(), ['对吧']);
  assert.deepEqual(new SentenceSplitter().push('好。'.concat('……')), ['好。……']);
  assert.equal(spokenPart('今天海滩的风好大。', 0.5), '今天海滩……');
  assert.equal(spokenPart('今天海滩的风好大。', 1.2), '今天海滩的风好大。');
});

test('voice prompts put the NPC in the real world, show the last talk in town, and need no options', async () => {
  const { roster, cleanup } = await setup();
  try {
    const messages = buildMessages({
      npcName: '海莉', card: roster.render('haley', { ...FRIEND, purpose: 'dialogue' }), world: WORLD, standing: FRIEND,
      memory: {
        memories: [{ text: '（现实里 10 月 19 日）农场主说下周要考试', when: '今天' }],
        earlier: { title: '上次在镇上和农场主的对话', exchanges: [{ player: '（玩家走过来）', npc: '嗨。' }, { player: '你在拍照吗？', npc: '是呀。' }] },
      },
      history: [], playerLine: '你好', voice: { now: '2026 年 10 月 19 日（周一）21:30' },
    });
    const system = messages[0]!.content;
    assert.match(system, /来到了农场主所在的现实世界/);
    assert.match(system, /现实里的时间：2026 年 10 月 19 日/);
    assert.match(system, /你离开时是第 1 年春季 17 日/);
    assert.match(system, /标着“现实里”的/);
    assert.match(system, /- （现实里 10 月 19 日）农场主说下周要考试/, 'no game-day label on a real-world memory');
    assert.match(system, /- 农场主：你在拍照吗？\n- 你：是呀。/);
    assert.doesNotMatch(system, /农场主：（玩家走过来）/, 'stage directions are not shown as the player speaking');
    assert.ok(messages.at(-1)!.content.endsWith(VOICE_JSON_HINT));
    const parsed = parseOutput('{"emotion":"blush","reply":"真的吗？","remember":[],"end":false}', '', true);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.meta.options, []);
  } finally {
    await cleanup();
  }
});

test('only paired devices get the token, and a wrong token cannot connect', async () => {
  const { directory, roster, cleanup } = await setup();
  const service = await CompanionService.start({
    dataDirectory: directory, roster, model: voiceModel([]).model, speech: fakeSpeech().speech, voiceFor: () => 'voice',
    npcIds: SOCIAL_NPCS, port: 0, host: '127.0.0.1',
  });
  try {
    const ask = (id: string) => fetch(`http://127.0.0.1:${service.port}${OTA_PATH}`, { method: 'POST', headers: { 'Device-Id': id } });
    assert.equal((await ask('aa')).status, 403);
    service.pairing.open(60_000);
    const paired = await ask('aa');
    assert.equal(paired.status, 200);
    const { websocket } = await paired.json() as { websocket: { url: string; token: string } };
    assert.equal((await ask('bb')).status, 403, 'pairing admits one device and closes');
    assert.equal((await ask('aa')).status, 200, 'a paired device stays paired');
    const rejected = new WebSocket(websocket.url, { headers: { Authorization: 'Bearer wrong', 'Device-Id': 'aa' } });
    await assert.rejects(once(rejected, 'open'), /401/);
  } finally {
    await service.close();
    await cleanup();
  }
});

test('a robot session greets, answers with a face, sentences and audio, and writes the talk back to the save on goodbye', async () => {
  const { directory, roster, cleanup } = await setup();
  const [snapshot] = await townSave(directory, roster);
  const voice = voiceModel([
    { reply: '哇，这就是你的世界？好安静。', emotion: 'happy' },
    { reply: '考试？那你可要加油。', emotion: 'special', remember: '农场主说下周要考试' },
    { reply: '好吧，拜拜！', emotion: 'neutral', end: true },
  ]);
  const service = await startCompanion(directory, roster, voice.model, fakeSpeech().speech);
  try {
    const robot = await connectDevice(service.port);
    await service.begin(snapshot!, 'haley');
    await until(() => robot.stops() === 1, 'the greeting');
    const greeting = robot.messages.filter((m) => m.type !== 'hello');
    assert.deepEqual(greeting.map((m) => `${m.type}:${m.state ?? m.emotion ?? ''}`).slice(0, 3), ['llm:happy', 'tts:start', 'tts:sentence_start']);
    assert.ok(robot.frames.length > 0, 'audio was sent');
    const system = voice.sent[0]![0]!.content;
    assert.match(system, /上次在镇上和农场主的对话（第 1 年春季 17 日）\n- 农场主：你在拍照吗？\n- 你：今天海滩风好大。/);

    robot.send({ type: 'text', text: '我下周要考试' });
    await until(() => robot.stops() === 2, 'the answer');
    assert.ok(robot.messages.some((m) => m.type === 'stt' && m.text === '我下周要考试'));
    assert.ok(robot.messages.some((m) => m.type === 'llm' && m.emotion === 'surprised'), 'special maps to a firmware face');
    assert.match(voice.lastUser(1), /^我下周要考试/);

    robot.send({ type: 'text', text: '我要关机啦' });
    await robot.closed;
    await until(() => service.session === undefined, 'the session to end');
  } finally {
    await service.close();
  }
  try {
    const { commitId, logs } = await robotLogs(directory, snapshot!);
    assert.ok(isCompanionCommit(commitId), 'the save continues from a companion commit');
    assert.equal(logs.length, 3);

    // Back in town, Haley remembers what was said through the robot.
    const save = await ChatSave.open({ directory, name: 'town', fresh: false, startDay: 17, npcIds: SOCIAL_NPCS });
    try {
      assert.equal(save.continuedFromRobot, true);
      const town = townModel(['嗯。']);
      const memory = save.memory('haley', () => save.day * 1440 + 900);
      await runTurn({ roster, model: town.model, memory }, { npcId: 'haley', world: WORLD, standing: FRIEND, playerLine: '考试的事你还记得吗' });
      const system = town.sent[0]![0]!.content;
      assert.match(system, /- （现实里 \d+ 月 \d+ 日）农场主说下周要考试/);
      assert.match(system, /标着“现实里”的/);
    } finally {
      await save.close();
    }
  } finally {
    await cleanup();
  }
});

test("a robot with another NPC's face downloads this one and restarts before the NPC talks", async () => {
  const { directory, roster, cleanup } = await setup();
  const [snapshot] = await townSave(directory, roster);
  await writePortraits(join(directory, 'faces'), 'haley');
  const voice = voiceModel([{ reply: '嗨，又见面了。', emotion: 'happy' }]);
  const service = await startCompanion(directory, roster, voice.model, fakeSpeech().speech, 60_000, new PortraitPacks(join(directory, 'faces')));
  try {
    const robot = await connectDevice(service.port);
    const calls = () => robot.messages.filter((m) => m.type === 'mcp').map((m) => m.payload!);
    const answer = (id: number) => robot.send({ type: 'mcp', payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'true' }] } } });
    const begun = service.begin(snapshot!, 'haley');
    await until(() => calls().length === 1, 'the download url');
    const url = calls()[0]!.params.arguments.url!;
    assert.equal(calls()[0]!.params.name, 'self.assets.set_download_url');
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/xiaozhi\/assets\/haley\.bin\?token=/);
    answer(calls()[0]!.id);
    await until(() => calls().length === 2, 'the reboot');
    assert.equal(calls()[1]!.params.name, 'self.reboot');
    answer(calls()[1]!.id);
    await begun;
    assert.equal(voice.sent.length, 0, 'nobody talks to a robot that is restarting');

    const pack = await fetch(url);
    assert.equal(pack.status, 200);
    assert.equal(Number(pack.headers.get('content-length')), (await new PortraitPacks(join(directory, 'faces')).pack('haley'))!.length);
    assert.equal((await fetch(url.replace(/token=.*/, 'token=wrong'))).status, 403);
    assert.equal((await fetch(url.replace('haley', 'abigail'))).status, 404, 'not exported');

    // The firmware restarts, downloads the pack, and connects again on its wake word.
    robot.socket.close();
    await robot.closed;
    const again = await connectDevice(service.port);
    await until(() => again.stops() === 1, 'the greeting');
    assert.equal(again.messages.filter((m) => m.type === 'mcp').length, 0, 'the face is already right');
    assert.ok(again.messages.some((m) => m.type === 'llm' && m.emotion === 'happy'));
  } finally {
    await service.close();
    await cleanup();
  }
});

test('an older save does not see a robot session that happened after it', async () => {
  const { directory, roster, cleanup } = await setup();
  const [older, newer] = await townSave(directory, roster, 2);
  const voice = voiceModel([{ reply: '嗨！', remember: '农场主说最喜欢下雨天' }]);
  const service = await startCompanion(directory, roster, voice.model, fakeSpeech().speech);
  try {
    const robot = await connectDevice(service.port);
    await service.begin(newer!, 'haley');
    await until(() => robot.stops() === 1, 'the greeting');
    assert.ok(await service.stop());
  } finally {
    await service.close();
  }
  try {
    const registry = new CompanionRegistry(join(directory, 'companion/registry'));
    assert.equal(await registry.head(older!.lineageId, older!.commitId), older!.commitId);
    const head = await registry.head(newer!.lineageId, newer!.commitId);
    assert.ok(isCompanionCommit(head));
    const runtime = await createRuntime({ databasePath: join(directory, 'memory.sqlite'), journalDirectory: join(directory, 'scratch'), npcIds: SOCIAL_NPCS });
    try {
      const search = (headCommitId: string) => runtime.ctx.store.call('search', {
        scope: { lineageId: older!.lineageId, headCommitId, npcId: 'haley' }, query: '', topics: [], sharedScene: false, limit: 50,
      });
      assert.ok((await search(head)).some((memory) => memory.text.includes('最喜欢下雨天')));
      assert.ok(!(await search(older!.commitId)).some((memory) => memory.text.includes('最喜欢下雨天')));
    } finally {
      await runtime.close();
    }
  } finally {
    await cleanup();
  }
});

test('cutting in stops the audio and records only the part that was heard', async () => {
  const { directory, roster, cleanup } = await setup();
  const [snapshot] = await townSave(directory, roster);
  const voice = voiceModel([{ reply: '今天海滩的风好大。我差点被吹跑了！' }, { reply: '怎么了？' }]);
  const service = await startCompanion(directory, roster, voice.model, fakeSpeech({ msPerPiece: 3000 }).speech);
  try {
    const robot = await connectDevice(service.port);
    await service.begin(snapshot!, 'haley');
    await until(() => robot.frames.length >= 5, 'the greeting to start playing');
    robot.send({ type: 'abort', reason: 'wake_word_detected' });
    await until(() => robot.stops() === 1, 'speaking to stop');
    const sentBeforeCut = robot.frames.length;
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(robot.frames.length, sentBeforeCut, 'no audio after the cut');
    assert.ok(await service.stop());
  } finally {
    await service.close();
  }
  try {
    const { logs } = await robotLogs(directory, snapshot!);
    assert.ok(logs[0]!.npc.endsWith('……'));
    assert.ok(logs[0]!.npc.length < '今天海滩的风好大。我差点被吹跑了！'.length);
  } finally {
    await cleanup();
  }
});

test('the game loading the save ends the robot session first, and a save the game holds is refused', async () => {
  const { directory, roster, cleanup } = await setup();
  const [snapshot] = await townSave(directory, roster);
  const service = await startCompanion(directory, roster, voiceModel([{ reply: '嗨！' }]).model, fakeSpeech().speech);
  try {
    const robot = await connectDevice(service.port);
    await service.begin(snapshot!, 'haley');
    await until(() => robot.stops() === 1, 'the greeting');
    await service.gameLoaded(snapshot!.lineageId);
    assert.equal(service.session, undefined);
    assert.ok(isCompanionCommit(await new CompanionRegistry(join(directory, 'companion/registry')).head(snapshot!.lineageId, snapshot!.commitId)));
    await assert.rejects(service.begin(snapshot!, 'haley'), (error) => error instanceof CompanionError && /游戏开着这个存档/.test(error.message));
    service.gameClosed();
    await service.begin(snapshot!, 'haley');
  } finally {
    await service.close();
    await cleanup();
  }
});

test('the chat CLI and the robot never hold the memory database at once', async () => {
  const { directory, roster, cleanup } = await setup();
  const [snapshot] = await townSave(directory, roster);
  const service = await startCompanion(directory, roster, voiceModel([]).model, fakeSpeech().speech);
  const open = () => ChatSave.open({ directory, name: 'town', fresh: false, startDay: 17, npcIds: SOCIAL_NPCS });
  try {
    await service.begin(snapshot!, 'haley');
    await assert.rejects(open(), DatabaseBusyError);
    await service.stop();
    const save = await open();
    try {
      await assert.rejects(service.begin(snapshot!, 'haley'), (error) => error instanceof CompanionError && /命令行聊天/.test(error.message));
    } finally {
      await save.close();
    }
  } finally {
    await service.close();
    await cleanup();
  }
});

test('a session cut short by a crash is written back on the next start', async () => {
  const { directory, roster, cleanup } = await setup();
  const [snapshot] = await townSave(directory, roster);
  const registry = new CompanionRegistry(join(directory, 'companion/registry'));
  const runtime = await createRuntime({ databasePath: join(directory, 'memory.sqlite'), journalDirectory: join(directory, 'scratch'), npcIds: SOCIAL_NPCS });
  const session = await CompanionSession.open({
    runtime, roster, model: voiceModel([{ reply: '嗨！', remember: '农场主养了一只猫' }]).model, speech: fakeSpeech().speech,
    registry, snapshot: snapshot!, npcId: 'haley', voice: 'voice', idleMs: 60_000, onFinish: () => {},
  });
  const link: DeviceLink = {
    showUserText: () => {}, setEmotion: () => {}, startSpeaking: () => {}, sentence: () => {}, audio: () => {},
    stopSpeaking: async () => {}, cancelSpeaking: () => {}, playedMs: () => 0, close: () => {},
  };
  session.attach(link);
  await until(() => session.exchanges === 1, 'the greeting to be recorded');
  await writeJson(join(directory, 'companion/active.json'), session.identity);
  // The backend dies: nothing is committed, the journal keeps today.
  await runtime.close();
  assert.equal(await registry.head(snapshot!.lineageId, snapshot!.commitId), snapshot!.commitId);

  const service = await startCompanion(directory, roster, voiceModel([]).model, fakeSpeech().speech);
  try {
    const next = await service.begin(snapshot!, 'haley');
    const head = await registry.head(snapshot!.lineageId, snapshot!.commitId);
    assert.ok(isCompanionCommit(head));
    assert.equal(next.identity.headCommitId, head, 'the new session continues after the recovered one');
  } finally {
    await service.close();
  }
  try {
    const { logs } = await robotLogs(directory, snapshot!);
    assert.equal(logs[0]!.npc, '嗨！');
  } finally {
    await cleanup();
  }
});

test('the session ends by itself when the player goes quiet', async () => {
  const { directory, roster, cleanup } = await setup();
  const [snapshot] = await townSave(directory, roster);
  const service = await startCompanion(directory, roster, voiceModel([{ reply: '嗨！' }]).model, fakeSpeech().speech, 300);
  try {
    const robot = await connectDevice(service.port);
    await service.begin(snapshot!, 'haley');
    await until(() => robot.stops() === 1, 'the greeting');
    // The connection is closed only after the talk has been written back.
    await robot.closed;
    assert.equal(service.session, undefined);
    assert.ok(isCompanionCommit(await new CompanionRegistry(join(directory, 'companion/registry')).head(snapshot!.lineageId, snapshot!.commitId)));
  } finally {
    await service.close();
    await cleanup();
  }
});

test('microphone audio goes through recognition and becomes the player line', async () => {
  const { directory, roster, cleanup } = await setup();
  const [snapshot] = await townSave(directory, roster);
  const voice = voiceModel([{ reply: '嗨！' }, { reply: '欢迎回来。' }]);
  const service = await startCompanion(directory, roster, voice.model, fakeSpeech({ heard: ['我回来了'] }).speech);
  try {
    const robot = await connectDevice(service.port);
    await service.begin(snapshot!, 'haley');
    await until(() => robot.stops() === 1, 'the greeting');
    const encoder = new OpusEncoder(INPUT_RATE);
    robot.send({ type: 'listen', state: 'start', mode: 'auto' });
    for (const frame of encoder.push(Buffer.alloc(INPUT_RATE / 5 * 2))) robot.socket.send(frame);
    encoder.close();
    await new Promise((done) => setTimeout(done, 50));
    robot.send({ type: 'listen', state: 'stop' });
    await until(() => robot.stops() === 2, 'the answer');
    assert.ok(robot.messages.some((m) => m.type === 'stt' && m.text === '我回来了'));
    assert.match(voice.lastUser(1), /^我回来了/);
    assert.ok(voice.warmed() >= 1, 'the model connection is warmed as soon as the player starts speaking');
  } finally {
    await service.close();
    await cleanup();
  }
});

test('the DashScope clients speak the duplex task protocol', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const seen: { auth: string | undefined; commands: { action: string; payload: Record<string, unknown> }[]; audio: number } = { auth: undefined, commands: [], audio: 0 };
  const parameters = (i: number) => seen.commands[i]!.payload.parameters as Record<string, unknown>;
  server.on('connection', (socket, request) => {
    seen.auth = request.headers.authorization;
    let taskId = '';
    let task = '';
    socket.on('message', (data, binary) => {
      if (binary) { seen.audio += (data as Buffer).length; return; }
      const { header, payload } = JSON.parse(String(data)) as { header: { action: string; task_id: string }; payload: Record<string, unknown> };
      seen.commands.push({ action: header.action, payload });
      const event = (name: string, extra: object = {}) => socket.send(JSON.stringify({ header: { task_id: taskId, event: name }, payload: extra }));
      if (header.action === 'run-task') {
        taskId = header.task_id;
        task = String(payload.task);
        event('task-started');
      } else if (header.action === 'continue-task') {
        socket.send(Buffer.alloc(480));
      } else if (header.action === 'finish-task') {
        if (task === 'asr') {
          event('result-generated', { output: { sentence: { text: '你好', sentence_end: false } } });
          event('result-generated', { output: { sentence: { text: '你好呀。', sentence_end: true } } });
        }
        event('task-finished');
      }
    });
  });
  const speech = new DashScopeSpeech({
    apiKey: 'key', url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    asrModel: 'paraformer-realtime-v2', ttsModel: 'cosyvoice-v3-flash', sentenceSilenceMs: 700,
  });
  try {
    const partials: string[] = [];
    const sentences: string[] = [];
    const recognizer = speech.recognize({ onPartial: (text) => partials.push(text), onSentence: (text) => sentences.push(text), onError: (error) => { throw error; } });
    recognizer.write(Buffer.alloc(3200));
    await recognizer.finish();
    assert.equal(seen.auth, 'Bearer key');
    assert.deepEqual(seen.commands.map((c) => c.action), ['run-task', 'finish-task']);
    assert.deepEqual(parameters(0), { format: 'pcm', sample_rate: 16000, language_hints: ['zh'], max_sentence_silence: 700 });
    assert.equal(seen.audio, 3200, 'audio written before task-started is sent after it');
    assert.deepEqual(partials, ['你好']);
    assert.deepEqual(sentences, ['你好呀。']);

    seen.commands = [];
    const audio: Buffer[] = [];
    const synth = speech.synthesize('longanyang', { onAudio: (pcm) => audio.push(pcm), onError: (error) => { throw error; } });
    synth.push('你好。');
    await synth.finish();
    assert.deepEqual(seen.commands.map((c) => c.action), ['run-task', 'continue-task', 'finish-task']);
    assert.equal(parameters(0).voice, 'longanyang');
    assert.deepEqual(seen.commands[1]!.payload, { input: { text: '你好。' } });
    assert.equal(Buffer.concat(audio).length, 480);
  } finally {
    server.close();
  }
});
