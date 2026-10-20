import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelClient, Completion } from '../src/services/model/client.ts';
import { connect, harness, WORLD } from './helpers/bridge.ts';

test('scene requests enforce a game-hour cooldown and reject dates outside the loaded day', async t => {
  const h = await harness(t);
  let calls = 0;
  const sceneModel = { async chat(): Promise<Completion> {
    calls++;
    return { content: JSON.stringify({ lines: [{ speaker: 'a', text: '天气真好。' }, { speaker: 'b', text: '嗯，出去走走。' }] }),
      reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 0, totalMs: 0 } };
  } } as unknown as ModelClient;
  const wire = await connect(await h.start(undefined, undefined, sceneModel));
  const ask = async (npcs: string[], time: number, day = 1) => {
    const from = wire.inbox.length;
    wire.send({ type: 'scene.request', npcs, world: { ...WORLD, date: { ...WORLD.date, day, time } } });
    return (await wire.until('scene.lines', from) as { lines: unknown[] }).lines;
  };
  assert.equal((await ask(['Abigail', 'Sebastian'], 600)).length, 2);
  assert.deepEqual(await ask(['Gus', 'Pam'], 650), [], '50 game minutes are not an hour');
  assert.equal(calls, 1, 'a refused scene must not call the model or consume the pair');
  assert.equal((await ask(['Gus', 'Pam'], 700)).length, 2);
  assert.deepEqual(await ask(['Caroline', 'Jodi'], 800, 2), [], 'a different game date cannot spend today’s budget');
  assert.equal(calls, 2);
  assert.equal((await ask(['Caroline', 'Jodi'], 800)).length, 2);
});
