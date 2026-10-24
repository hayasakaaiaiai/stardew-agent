import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRuntime } from '../src/index.ts';
import { digest } from '../src/validation.ts';

test('a failed kernel load preserves the active journal until a replacement load succeeds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stardew-load-recovery-'));
  const config = { databasePath: join(directory, 'memory.sqlite'), journalDirectory: join(directory, 'scratch'), npcIds: ['abigail'] };
  let runtime = await createRuntime(config);
  try {
    const identity = { lineageId: 'farm', loadNonce: 'original', day: 1 };
    const original = await runtime.ctx.saves.load(identity);
    await original.agent('abigail').record({ seq: 1, gameTime: 1500,
      memories: [{ text: '坏指针读档之前的未保存约定', importance: 5 }], state: { mood: '期待' } });
    const folder = join(config.journalDirectory, digest(identity.lineageId));
    const journal = join(folder, `${digest(identity.loadNonce)}.jsonl`);
    const before = await readFile(journal, 'utf8');
    await assert.rejects(runtime.ctx.saves.load({ ...identity, loadNonce: 'invalid', commitId: 'missing' }), /missing Agent data/);
    assert.equal(await readFile(journal, 'utf8'), before, 'failed replacement must leave the original bytes recoverable');
    await runtime.close();
    runtime = await createRuntime(config);
    const resumed = await runtime.ctx.saves.load(identity);
    const context = await resumed.agent('abigail').context({ nowGameTime: 1501 });
    assert.equal(context.state.mood, '期待');
    assert.equal(context.memories[0]!.text, '坏指针读档之前的未保存约定');
    await runtime.ctx.saves.load({ ...identity, loadNonce: 'replacement' });
    assert.deepEqual(await readdir(folder), [`${digest('replacement')}.jsonl`], 'successful replacement still discards the old unsaved day');
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
