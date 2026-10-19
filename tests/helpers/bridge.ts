import { resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { BridgeServer } from '../../src/bridge/server.ts';
import { PROTOCOL_VERSION, type BackendMessage, type LoadedSave, type SavePointer, type WorldSnapshot } from '../../src/bridge/protocol.ts';
import type { ChatMessage, Completion, ModelClient, StreamHandlers } from '../../src/services/model/client.ts';
import { Roster } from '../../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../../src/types.ts';

export const WORLD: WorldSnapshot = { date: { year: 1, season: 'spring', day: 1, time: 600 }, weather: 'sunny', location: '种子商店',
  flags: { communityCenter: 'pending', busRepaired: false, understandsDwarves: false, pamHouse: false, islandOpen: false, leoMoved: false } };
export function initial(nonce = 'load-1', day = 1, commit: SavePointer | null = null, lineageId = 'farm-1'): LoadedSave {
  return { type: 'save.loaded', lineageId, loadNonce: nonce, seq: 0, player: { name: '测试', gender: 'female', farm: '测试' },
    date: { ...WORLD.date, day }, commit };
}
export const openTalk = (day = 1, npc = 'Abigail') => ({ type: 'talk.open', npc, hearts: 8, relation: 'friend', seenEvents: [], world: { ...WORLD, date: { ...WORLD.date, day } } });

export function fakeModel() {
  const sent: ChatMessage[][] = [];
  let hold: (() => Promise<void>) | undefined;
  const model = { async chat(messages: ChatMessage[], handlers: StreamHandlers): Promise<Completion> {
    sent.push(messages);
    await hold?.();
    const last = messages.at(-1)!.content;
    const remember = last.startsWith('记住') ? [{ text: last.slice(2), importance: 5 }] : [];
    const content = JSON.stringify({ reply: `回复${sent.length}`, emotion: 'happy', options: ['一', '二', '三'], remember, end: false });
    handlers.onContent?.(content);
    return { content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
  } } as unknown as ModelClient;
  return { model, sent, hold: (run?: () => Promise<void>) => { hold = run; } };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

export async function connect(server: { port: number }, loaded = initial(), startSeq = 0, expect: 'save.ready' | 'sync.error' = 'save.ready') {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const inbox: BackendMessage[] = [];
  const waiters = new Set<() => void>();
  socket.on('message', bytes => { inbox.push(JSON.parse(bytes.toString()) as BackendMessage); for (const wake of waiters) wake(); });
  let seq = startSeq;
  const raw = (value: unknown) => socket.send(JSON.stringify(value));
  const send = (message: Record<string, unknown>) => {
    const value = { lineageId: loaded.lineageId, loadNonce: loaded.loadNonce,
      ...(message.type === 'talk.say' ? { date: loaded.date } : {}), ...message, seq: message.seq as number ?? ++seq };
    seq = Math.max(seq, value.seq);
    raw(value); return value;
  };
  const until = async (type: BackendMessage['type'], from = inbox.length): Promise<BackendMessage> => {
    const found = () => inbox.find((item, index) => index >= from && item.type === type);
    const existing = found(); if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(wake); reject(new Error(`Timed out waiting for ${type}: ${JSON.stringify(inbox.slice(from))}`)); }, 4000);
      const wake = () => { const item = found(); if (item) { clearTimeout(timer); waiters.delete(wake); resolve(item); } };
      waiters.add(wake);
    });
  };
  raw({ type: 'hello', protocol: PROTOCOL_VERSION, modVersion: 'test' }); await until('hello');
  raw(loaded); await until(expect);
  const close = async () => {
    if (socket.readyState === socket.CLOSED) return;
    const done = new Promise<void>(resolve => socket.once('close', () => resolve()));
    socket.close(); await done;
  };
  return { socket, inbox, raw, send, until, close, cursor: () => seq, loaded };
}

export async function harness(t: TestContext) {
  const directory = await mkdtemp(resolve(tmpdir(), 'stardew-game-memory-'));
  const roster = new Roster({ directory: resolve(import.meta.dirname, '../../data/npcs'), npcIds: SOCIAL_NPCS });
  await roster.load();
  const fake = fakeModel();
  const servers: BridgeServer[] = [];
  const logs: string[] = [];
  const start = async () => {
    const server = await BridgeServer.start({ roster, model: fake.model, memoryDirectory: directory, port: 0, log: line => logs.push(line) });
    servers.push(server); return server;
  };
  const stop = async (server: BridgeServer) => { servers.splice(servers.indexOf(server), 1); await server.close(); };
  t.after(async () => { for (const server of servers) await server.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, fake, start, stop, logs };
}

export async function sleep(wire: Awaited<ReturnType<typeof connect>>, commitId = 'saved-day-1', dayEnded = 1, parentId: string | null = null) {
  const commit = { commitId, parentId, dayEnded };
  wire.send({ type: 'save.saving', commit }); await wire.until('ack');
  wire.send({ type: 'save.saved', commitId, date: { ...WORLD.date, day: dayEnded + 1 } }); await wire.until('ack');
  wire.send({ type: 'day.started', date: { ...WORLD.date, day: dayEnded + 1 }, weather: 'sunny' }); await wire.until('ack');
  return commit;
}
