import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { digest } from '../src/validation.ts';
import { connect, initial, openTalk, WORLD } from './helpers/bridge.ts';

test('cleanup survives a killed process, preserves the same load and other farms, and waits for a successful new load', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stardew-cleanup-recovery-'));
  const children: ChildProcess[] = [];
  const start = async () => {
    const child = fork(resolve(import.meta.dirname, 'fixtures/cleanup-backend.ts'), [directory], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    children.push(child);
    const ready = await Promise.race([
      once(child, 'message').then(([value]) => value as { port: number }),
      once(child, 'exit').then(([code]) => { throw new Error(`Cleanup fixture exited: ${code}`); }),
    ]);
    return { child, port: ready.port };
  };
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await rm(directory, { recursive: true, force: true });
  });
  const first = await start();
  const wire = await connect(first, initial('running-a'));
  wire.send({ type: 'gift.given', npc: 'Abigail', item: '紫水晶', taste: 'love', birthday: false, date: WORLD.date }); await wire.until('ack');
  const other = await connect(first, initial('running-b', 1, null, 'other-farm'));
  other.send({ type: 'gift.given', npc: 'Abigail', item: '蓝莓', taste: 'like', birthday: false, date: WORLD.date }); await other.until('ack');
  const exited = once(first.child, 'exit'); first.child.kill('SIGKILL'); await exited;
  const folder = join(directory, 'scratch', digest('farm-1'));
  const activeJournal = join(folder, digest('running-a') + '.jsonl');
  const content = await readFile(activeJournal, 'utf8');
  const ancient = new Date(Date.now() - 3 * 86400000); await utimes(activeJournal, ancient, ancient);
  await writeFile(join(folder, 'notes.txt'), 'keep this file');
  const checkpoints = join(directory, 'bridge', digest('farm-1'));
  await writeFile(join(checkpoints, 'notes.json'), 'keep this checkpoint note');
  const second = await start();
  const resumed = await connect(second, initial('running-a'), wire.cursor());
  assert.equal(await readFile(activeJournal, 'utf8'), content, 'even a three-day-old journal belongs to a live resumed load');
  resumed.send(openTalk()); await resumed.until('talk.reply');
  const failed = await connect(second, initial('bad-load', 2, { commitId: 'missing', parentId: 'missing-parent', dayEnded: 1 }), 0, 'sync.error');
  assert.ok((await readdir(folder)).includes(digest('running-a') + '.jsonl'), 'a failed game load must not prune the running day');
  assert.equal(await readFile(join(checkpoints, digest('running-a') + '.json'), 'utf8').then(() => true), true);
  await failed.close();
  const from = resumed.inbox.length;
  resumed.send({ type: 'talk.say', npc: 'Abigail', text: '记住读档失败后仍能继续说话' });
  await resumed.until('talk.reply', from);
  assert.match(await readFile(activeJournal, 'utf8'), /读档失败后仍能继续说话/);
  const fresh = await connect(second, initial('fresh-a'));
  assert.deepEqual((await readdir(folder)).sort(), [digest('fresh-a') + '.jsonl', 'notes.txt'].sort());
  assert.deepEqual((await readdir(checkpoints)).sort(), [digest('fresh-a') + '.json', 'notes.json'].sort());
  const otherFolder = join(directory, 'scratch', digest('other-farm'));
  assert.ok((await readdir(otherFolder)).includes(digest('running-b') + '.jsonl'));
  const still = await connect(second, initial('running-b', 1, null, 'other-farm'), other.cursor());
  still.send(openTalk()); await still.until('talk.reply');
  await fresh.close(); await resumed.close(); await still.close();
});
