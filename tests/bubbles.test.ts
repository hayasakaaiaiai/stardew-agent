import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Bubble, bubblesFor, parseBubbles, safeBubble } from '../src/agent/bubbles.ts';
import type { Consolidator } from '../src/agent/consolidation.ts';
import type { BackendMessage } from '../src/bridge/protocol.ts';
import { connect, deferred, harness, initial, openTalk, sleep } from './helpers/bridge.ts';

test('bubbles reject completed off-screen actions, including the earlier bamboo-delivery failure', () => {
  for (const text of ['竹条扛来了。', '材料我带来了。', '纸船折出来了。', '去墓地转了一圈。', '材料找了一半。', '风筝备齐了。']) {
    assert.equal(safeBubble(text), undefined, text);
  }
  for (const text of ['得把材料凑齐才行。', '要是我爸不过敏就好了', '矿洞的事，他会答应吗？', '纸船，慢慢来就好。']) {
    assert.equal(safeBubble(text), text);
  }
});

test('a short “太……了” is a feeling, not a claim; anything longer between them is still refused', () => {
  for (const text of ['这太阳也太晒了，得躲一躲。', '太好了！', '这阵子也太累了吧', '太晚了，回家吧']) assert.equal(safeBubble(text), text);
  for (const text of ['太阳下山了。', '太快做完了。', '书架修好了，潘妮该开心了吧', '太晒了，东西我带来了。']) assert.equal(safeBubble(text), undefined, text);
});

test('bubble parsing isolates malformed values, enforces Unicode limits, and revalidates stored states', () => {
  for (const value of [null, 1, false, {}, '[]', [null, 0, 'bad', { text: {} }, { emote: 'happy' }]]) assert.deepEqual(parseBubbles(value), []);
  const line = { text: '紫'.repeat(24), emote: 'bad' };
  assert.deepEqual(parseBubbles([line]), [{ ...line, emote: 'none' }]);
  assert.deepEqual(parseBubbles([{ ...line, text: '紫'.repeat(25) }]), []);
  assert.equal(safeBubble('  矿洞\n 要不要去？^#$@%{}*[]|😺  '), '矿洞 要不要去？');
  assert.deepEqual(bubblesFor({ day: 1, bubbles: [{ text: '带来了竹条', emote: 'happy' }] }, 2), []);
  assert.deepEqual(bubblesFor({ day: 1, bubbles: [{ text: '想做风筝', emote: 'happy' }] }, 3), []);
});

const bubbleMessage = (value: BackendMessage) => {
  assert.equal(value.type, 'day.bubbles');
  return (value as Extract<BackendMessage, { type: 'day.bubbles' }>).npcs;
};

test('an older asynchronous bubble read cannot replace a newer packet or cross a day change', async t => {
  const h = await harness(t);
  const server = await h.start();
  const old = deferred();
  const latest = { abigail: [{ text: '想做风筝', emote: 'happy' as const }] };
  let read = () => old.promise.then(() => ({ bubbles: {} as Record<string, Bubble[]>, letters: [], approach: {}, meetings: [] }));
  const save = { initial: { lineageId: 'farm' }, loadNonce: 'current', closed: false, head: 'A', day: 2, today: () => read() };
  const packets: BackendMessage[] = [];
  const session = { save, todayRevision: 0, send: (message: BackendMessage) => packets.push(message) };
  const sender = server as unknown as { sendToday(value: typeof session): Promise<void> };
  const first = sender.sendToday(session);
  read = async () => ({ bubbles: latest, letters: [], approach: {}, meetings: [] });
  await sender.sendToday(session);
  old.resolve(); await first;
  assert.equal(packets.length, 4, 'the slower old empty packet must be dropped');
  assert.deepEqual(bubbleMessage(packets[0]!), latest);
  const another = deferred();
  read = () => another.promise.then(() => ({ bubbles: latest, letters: [], approach: {}, meetings: [] }));
  const pending = sender.sendToday(session);
  save.day = 3;
  another.resolve(); await pending;
  assert.equal(packets.length, 4, 'a packet from the previous day must be dropped');
});

test('bubble delivery is read-only and follows the NPC, save branch, reload, and backend restart', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const consolidate: Consolidator = async input => input.npcs.map(npc => ({ npcId: npc.npcId,
    state: { day: input.commit.dayEnded, bubbles: [{ text: `${npc.npcId}分支${input.commit.id}`, emote: 'question' }] },
  }));
  let server = await h.start(consolidate);
  let wire = await connect(server);
  const say = async (npc: string, day: number) => {
    const from = wire.inbox.length;
    wire.send(openTalk(day, npc)); await wire.until('talk.reply', from);
  };
  await say('Abigail', 1); await say('Sam', 1);
  const a = await sleep(wire, 'A');
  const waitBubble = async (from: number, expected: string) => {
    for (let i = 0; i < 300; i++) {
      const found = wire.inbox.slice(from).find(item => item.type === 'day.bubbles' && JSON.stringify(item.npcs).includes(expected));
      if (found) return bubbleMessage(found);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Expected bubbles were not delivered');
  };
  const aBubbles = await waitBubble(0, 'abigail分支A');
  assert.deepEqual(Object.keys(aBubbles).sort(), ['abigail', 'sam']);
  const counts = () => {
    const db = new DatabaseSync(join(h.directory, 'memory.sqlite'), { readOnly: true });
    try { return ['memory', 'log', 'commit_node'].map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n); }
    finally { db.close(); }
  };
  const before = counts();
  const modelCalls = h.fake.sent.length;
  const cursor = wire.cursor();
  await wire.close(); await h.stop(server);
  server = await h.start(consolidate);
  wire = await connect(server, initial(), cursor);
  assert.deepEqual(await waitBubble(0, 'abigail分支A'), aBubbles);
  assert.deepEqual(counts(), before, 'delivering bubbles must not create memories, logs, or commits');
  assert.equal(h.fake.sent.length, modelCalls, 'daytime bubble delivery must not call the dialogue model');
  await say('Abigail', 2);
  const from = wire.inbox.length;
  const b = await sleep(wire, 'B', 2, a.commitId);
  assert.ok((await waitBubble(from, 'abigail分支B')).abigail);
  assert.ok(!bubbleMessage(wire.inbox.findLast(item => item.type === 'day.bubbles')!).sam, 'Sam had no new consolidation');
  wire.send({ type: 'title.returned' }); await wire.until('ack'); await wire.close();
  wire = await connect(server, initial('fork-A', 2, a));
  assert.deepEqual(await waitBubble(0, 'abigail分支A'), aBubbles, 'an old save must not inherit B bubbles');
  assert.ok(!JSON.stringify(wire.inbox).includes('abigail分支B'));
  wire.send({ type: 'title.returned' }); await wire.until('ack'); await wire.close();
  wire = await connect(server, initial('other-farm', 1, null, 'farm-2'));
  assert.deepEqual(bubbleMessage(await wire.until('day.bubbles', 0)), {});
  assert.notEqual(a.commitId, b.commitId);
  await wire.close();
});
