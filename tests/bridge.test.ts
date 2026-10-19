import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type BackendMessage, type WorldSnapshot } from '../src/bridge/protocol.ts';
import { BridgeServer } from '../src/bridge/server.ts';
import { clock, worldFacts } from '../src/bridge/world.ts';
import type { ChatMessage, Completion, ModelClient, StreamHandlers } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';

const FLAGS = { communityCenter: 'pending', busRepaired: false, understandsDwarves: false, pamHouse: false, islandOpen: false, leoMoved: false } as const;
const WORLD: WorldSnapshot = {
  date: { year: 1, season: 'spring', day: 17, time: 1530 }, weather: 'rain', location: '皮埃尔的杂货店', flags: FLAGS,
};
const ENVELOPE = { lineageId: '123456', loadNonce: 'load-1' };

function fakeModel(fail = false) {
  const sent: ChatMessage[][] = [];
  const model = {
    async chat(messages: ChatMessage[], handlers: StreamHandlers): Promise<Completion> {
      sent.push(messages);
      if (fail) throw new Error('模型挂了');
      const content = JSON.stringify({ reply: `第${sent.length}句。`, emotion: 'happy', options: ['一', '二', '三'], remember: [], end: false });
      for (const chunk of [content.slice(0, 15), content.slice(15)]) handlers.onContent?.(chunk);
      return { content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
    },
  } as unknown as ModelClient;
  return { model, sent };
}

async function setup(fail = false) {
  const roster = new Roster({ directory: resolve(import.meta.dirname, '../data/npcs'), npcIds: SOCIAL_NPCS });
  await roster.load();
  const fake = fakeModel(fail);
  const directory = await mkdtemp(resolve(tmpdir(), 'stardew-bridge-'));
  const server = await BridgeServer.start({ roster, model: fake.model, port: 0, memoryDirectory: directory });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const inbox: BackendMessage[] = [];
  const waiters: (() => void)[] = [];
  socket.on('message', (data) => {
    inbox.push(JSON.parse(data.toString()) as BackendMessage);
    for (const wake of waiters.splice(0)) wake();
  });
  let seq = 0;
  const send = (message: Record<string, unknown>) => socket.send(JSON.stringify({ ...ENVELOPE, seq: ++seq,
    ...(message.type === 'talk.say' ? { date: WORLD.date } : {}), ...message }));
  /** Resolves with every message received up to and including the first matching one after `from`. */
  const until = async (type: BackendMessage['type'], from = inbox.length) => {
    for (;;) {
      const at = inbox.findIndex((m, i) => i >= from && m.type === type);
      if (at >= 0) return inbox.slice(from, at + 1);
      await new Promise<void>((wake) => waiters.push(wake));
    }
  };
  const close = async () => { socket.close(); await server.close(); await rm(directory, { recursive: true, force: true }); };
  send({ type: 'hello', modVersion: '0.1.0', protocol: PROTOCOL_VERSION });
  await until('hello');
  send({ type: 'save.loaded', seq: 0, player: { name: '小林', gender: 'female', farm: '晴空' }, date: WORLD.date, commit: null });
  await until('save.ready');
  return { fake, send, until, inbox, close };
}

const open = (npc = 'Abigail') => ({ type: 'talk.open', npc, hearts: 4, relation: 'friend', seenEvents: ['1'], world: WORLD });

test('a talk streams deltas, then a reply; history builds up and a new day clears it', async () => {
  const { fake, send, until, close } = await setup();
  try {
    send(open());
    const first = await until('talk.reply');
    assert.ok(first.filter((m) => m.type === 'talk.delta').length >= 1);
    assert.equal(first.filter((m) => m.type === 'talk.delta').map((m) => (m as { text: string }).text).join(''), '第1句。');
    assert.deepEqual(first.at(-1), { ...ENVELOPE, seq: 3, type: 'talk.reply', npc: 'Abigail', reply: '第1句。', emotion: 'happy', options: ['一', '二', '三'], end: false });
    const system = fake.sent[0]![0]!.content;
    assert.match(system, /第 1 年春季 17 日（周三）15:30，下雨/);
    assert.match(system, /玩家：小林（女），经营晴空农场/);
    assert.match(system, /巴士：还没修好/);
    assert.doesNotMatch(system, /不提和玩家一起打过游戏/, 'event 1 was seen');

    send({ type: 'talk.say', npc: 'Abigail', text: '你好呀' });
    await until('talk.reply');
    assert.deepEqual(fake.sent[1]!.slice(1).map((m) => m.role), ['user', 'assistant', 'user']);

    send({ type: 'talk.close', npc: 'Abigail' });
    send({ type: 'save.saving', commit: { commitId: 'day17', parentId: null, dayEnded: 17 } });
    send({ type: 'save.saved', commitId: 'day17', date: { ...WORLD.date, day: 18 } });
    send({ type: 'day.started', date: { year: 1, season: 'spring', day: 18, time: 600 }, weather: 'sunny' });
    send({ ...open(), world: { ...WORLD, date: { ...WORLD.date, day: 18 } } });
    await until('talk.reply');
    assert.deepEqual(fake.sent[2]!.slice(1).map((m) => m.role), ['user'], 'yesterday’s talk is gone');
  } finally {
    await close();
  }
});

test('unknown NPCs, talking before opening, and model failures come back as talk.error', async () => {
  const { send, until, close } = await setup();
  try {
    send(open('Gunther'));
    assert.match(JSON.stringify((await until('talk.error')).at(-1)), /没有 Gunther 的角色卡/);
    send({ type: 'talk.say', npc: 'Abigail', text: '你好' });
    assert.match(JSON.stringify((await until('talk.error')).at(-1)), /对话还没有打开/);
  } finally {
    await close();
  }

  const failing = await setup(true);
  try {
    failing.send(open());
    assert.match(JSON.stringify((await failing.until('talk.error')).at(-1)), /模型挂了/);
  } finally {
    await failing.close();
  }
});

test('malformed messages are ignored without dropping the connection', async () => {
  const { send, until, close } = await setup();
  try {
    send({ type: 'talk.open', npc: 'Abigail' });
    send({ type: 'no.such.type' });
    send({ type: 'hello', modVersion: '0.1.0', protocol: PROTOCOL_VERSION });
    await until('hello');
  } finally {
    await close();
  }
});

test('game flags become the world facts the cards depend on', () => {
  assert.equal(clock(1530), '15:30');
  assert.equal(clock(2530), '01:30');
  const year1 = worldFacts(1, FLAGS);
  assert.equal(year1.肯特, '还在前线打仗，第二年春天才回来');
  assert.equal(year1['Joja 超市'], '照常营业');
  assert.equal(year1.雷欧, undefined, 'Leo is unknown until the island opens');
  const later = worldFacts(2, { ...FLAGS, communityCenter: 'restored', busRepaired: true, understandsDwarves: true, islandOpen: true, leoMoved: true });
  assert.equal(later.肯特, '已经退役回家了');
  assert.equal(later['Joja 超市'], '已经关门');
  assert.match(later.谢恩!, /失业/);
  assert.equal(later.玩家会不会矮人语, '会');
  assert.match(later.雷欧!, /树屋/);
  assert.match(worldFacts(1, { ...FLAGS, communityCenter: 'joja' }).社区中心!, /Joja 仓库/);
});
