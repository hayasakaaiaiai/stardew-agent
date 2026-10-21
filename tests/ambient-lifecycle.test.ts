import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import type { ChatMessage, Completion, ModelClient } from '../src/services/model/client.ts';
import { connect, deferred, harness, initial, sleep, WORLD } from './helpers/bridge.ts';

const greeting = JSON.stringify({ lines: [{ npc: 'a', to: 'farmer', text: '早上好！', emote: 'happy' }] });
const request = (day = 1) => ({ type: 'ambient.request', npcs: [{ npc: 'Pierre', hearts: 3, relation: 'friend', greeted: false }],
  world: { ...WORLD, date: { ...WORLD.date, day } } });
const completion = (content: string): Completion => ({ content, reasoning: '', finishReason: 'stop', usage: null,
  timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } });

test('overlapping slow ambient requests cannot greet the same farmer twice', async t => {
  const h = await harness(t);
  const gates = [deferred(), deferred()];
  let calls = 0;
  const model = { async chat() { const index = calls++; await gates[index]!.promise; return completion(greeting); } } as unknown as ModelClient;
  const server = await h.start(undefined, undefined, model);
  const wire = await connect(server);
  t.after(() => wire.close());
  t.after(() => { for (const gate of gates) gate.resolve(); });
  wire.send(request()); wire.send(request());
  for (let i = 0; calls < 2 && i < 200; i++) await setTimeout(5);
  assert.equal(calls, 2, 'both requests must reach the held model');
  let cursor = wire.inbox.length;
  gates[0]!.resolve();
  const first = await wire.until('ambient.lines', cursor);
  assert.ok(first.type === 'ambient.lines'); assert.equal(first.lines.length, 1);
  cursor = wire.inbox.length;
  gates[1]!.resolve();
  const second = await wire.until('ambient.lines', cursor);
  assert.ok(second.type === 'ambient.lines');
  assert.deepEqual(second.lines, [], 'a reply must recheck greetings returned while its model call was pending');
});

test('ambient greetings and budget survive reannouncement and failed loads, and reset after a real save/day transition', async t => {
  const h = await harness(t);
  const sent: ChatMessage[][] = [];
  const model = { async chat(messages: ChatMessage[]) { sent.push(messages); return completion(greeting); } } as unknown as ModelClient;
  const server = await h.start(undefined, undefined, model);
  const wire = await connect(server);
  t.after(() => wire.close());
  const ask = async (day = 1) => { const cursor = wire.inbox.length; wire.send(request(day)); return wire.until('ambient.lines', cursor); };
  assert.equal((await ask() as { lines: unknown[] }).lines.length, 1);
  let cursor = wire.inbox.length;
  wire.raw(wire.loaded); await wire.until('save.ready', cursor);
  assert.equal((await ask() as { lines: unknown[] }).lines.length, 0, 'same-load announcements retain greetings');
  cursor = wire.inbox.length;
  wire.raw(initial('invalid', 2, { commitId: 'missing', parentId: 'missing-parent', dayEnded: 1 }));
  await wire.until('sync.error', cursor);
  wire.raw(wire.loaded); await wire.until('save.ready');
  assert.equal((await ask() as { lines: unknown[] }).lines.length, 0, 'a rejected load cannot erase the old greeting');
  await sleep(wire);
  assert.equal((await ask(2) as { lines: unknown[] }).lines.length, 1, 'the next day permits one greeting again');
  assert.doesNotMatch(sent.at(-1)![1]!.content, /今天打过招呼/);
});

test('a superseded load never receives ambient output from an older in-flight request', async t => {
  const h = await harness(t);
  const gate = deferred(), entered = deferred();
  const model = { async chat() { entered.resolve(); await gate.promise; return completion(greeting); } } as unknown as ModelClient;
  const server = await h.start(undefined, undefined, model);
  const wire = await connect(server);
  t.after(() => wire.close()); t.after(() => gate.resolve());
  wire.send(request()); await entered.promise;
  let cursor = wire.inbox.length;
  wire.raw(initial('replacement')); await wire.until('save.ready', cursor);
  cursor = wire.inbox.length;
  gate.resolve();
  // A following lifecycle acknowledgement drains socket work after the released completion.
  await setTimeout(25);
  wire.send({ type: 'day.started', date: WORLD.date, weather: WORLD.weather, loadNonce: 'replacement' });
  await wire.until('ack', cursor);
  assert.equal(wire.inbox.slice(cursor).filter(packet => packet.type === 'ambient.lines').length, 0);
});
