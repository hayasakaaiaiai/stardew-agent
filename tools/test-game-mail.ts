/** Native mailbox acceptance with fixed packets; the real model and backend use test-game-memory.ts. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { absoluteDay, parseModMessage, PROTOCOL_VERSION } from '../src/bridge/protocol.ts';
import { letterKey } from '../src/agent/letters.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';

const configPath = resolve(process.argv[2]!);
const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')) as {
  RequestId: string; UniqueId: string; SaveFolder: string; SaveDirectory: string; RunDirectory: string; GamePath: string; BackendUrl: string; MailOnly?: boolean;
};
assert.equal(config.MailOnly, true);
assert.equal(config.SaveFolder, `MemoryTest_${config.UniqueId}`);
assert.notEqual(config.UniqueId, '436774213');
assert.equal(resolve(config.SaveDirectory), resolve(process.env.APPDATA!, 'StardewValley/Saves', config.SaveFolder));
const directory = config.RunDirectory;
const json = async (file: string, value: unknown) => { await writeFile(file + '.tmp', JSON.stringify(value, null, 2)); await rename(file + '.tmp', file); };
const roster = new Roster({ directory: resolve(import.meta.dirname, '../data/npcs'), npcIds: SOCIAL_NPCS });
assert.equal((await roster.load()).errors.length, 0);
await json(join(directory, 'gift-catalog.json'), SOCIAL_NPCS.flatMap(id => roster.get(id).gifts.map(gift => gift.item)));
const fixtureLetter = { key: letterKey(config.UniqueId, 'mail-fixture', 'abigail'), npc: 'abigail',
  text: '今天一起做紫色风筝，可别忘啦。附上一片蝙蝠翅膀。', item: '蝙蝠翅膀' };
await json(join(directory, 'fixture-letter.json'), fixtureLetter);
const packets: unknown[] = [];
let loads = 0, talks = 0, saving = 0, saved = 0;
const errors: string[] = [];
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(server, 'listening');
config.BackendUrl = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
await json(configPath, config);
server.on('connection', socket => socket.on('message', data => {
  try {
    const message = parseModMessage(data.toString()); packets.push(message);
    if (message.type === 'hello') { socket.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION })); return; }
    const envelope = { lineageId: message.lineageId, loadNonce: message.loadNonce, seq: message.seq };
    if (message.type === 'save.loaded') {
      loads++;
      socket.send(JSON.stringify({ type: 'save.ready', ...envelope, day: absoluteDay(message.date) }));
      socket.send(JSON.stringify({ type: 'day.letters', ...envelope, seq: 0, letters: [null, 1, 'bad', { text: 7 },
        fixtureLetter,
      ] }));
    } else {
      if (message.type === 'talk.open' || message.type === 'talk.say') talks++;
      if (message.type === 'save.saving') saving++;
      if (message.type === 'save.saved') saved++;
      socket.send(JSON.stringify({ type: 'ack', ...envelope }));
    }
  } catch (error) { errors.push(String(error)); }
}));
interface Report {
  requestId: string; completed: boolean; success: boolean; stage: string; message: string; saveProcessing: boolean; newDay: boolean;
  letterChecks: { label: string; passed: boolean; [key: string]: unknown }[]; elapsedSeconds: number;
}
const game = spawn(join(config.GamePath, 'StardewModdingAPI.exe'), [], { cwd: config.GamePath,
  env: { ...process.env, STARDEW_AGENT_TEST_MEMORY: configPath }, windowsHide: true, stdio: 'ignore' });
let last: Report | undefined, success = false, failure: string | undefined;
const report = async () => {
  try { const value = JSON.parse(await readFile(join(directory, 'game-result.json'), 'utf8')) as Report; if (value.requestId === config.RequestId) last = value; }
  catch { /* The game is loading or replacing its report. */ }
};
try {
  const deadline = Date.now() + 150000;
  let shown = '';
  while (Date.now() < deadline) {
    if (game.exitCode !== null) throw new Error('测试游戏提前退出');
    await report();
    if (last && last.message !== shown) { shown = last.message; console.log(shown); }
    if (last?.completed) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(last?.completed, `信箱检查超时：${last?.stage ?? '未加载'}`);
  assert.ok(last.success, last.message);
  for (const label of ['card-gift-catalog-resolves', 'money-and-object-price-caps', 'duplicates-disabled-and-stale-do-not-add-mail',
    'native-click-claims-exactly-one-0', 'unsaved-item-rolled-back', 'unsaved-body-not-persisted', 'unread-letter-reappears-after-rollback',
    'native-click-claims-exactly-one-1', 'real-sleep-save-completed', 'claimed-item-persists-after-save', 'read-letter-not-redelivered',
    'body-persists-and-reloads-asset', 'letter-listed-in-native-collection', 'collection-title-resolves',
    'native-collection-click-reopens-letter', 'collection-reopen-cannot-claim-again']) assert.ok(last.letterChecks.some(check => check.label === label && check.passed), label);
  assert.ok(last.letterChecks.every(check => check.passed));
  for (const name of ['mail-with-gift', 'mail-after-rollback', 'mail-collection']) assert.ok((await stat(join(directory, name + '.png'))).size > 100);
  assert.equal(loads, 3); assert.equal(talks, 0); assert.equal(saving, 1); assert.equal(saved, 1); assert.deepEqual(errors, []);
  success = true;
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally {
  if (!last?.completed) {
    await json(join(directory, 'control.json'), { requestId: config.RequestId, stage: '', abort: '信箱脚本已停止，请保留证据。' });
    const deadline = Date.now() + 4000;
    while (!last?.completed && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 250)); await report(); }
  }
  if (game.exitCode === null && last?.completed && !last.saveProcessing && !last.newDay) { const exited = once(game, 'exit'); game.kill(); await exited; }
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await json(join(directory, 'mail-packets.json'), packets);
  await json(join(directory, 'result.json'), { success, failure, mode: 'native-mail-with-fixed-packets', requestId: config.RequestId,
    saveFolder: config.SaveFolder, modelCalls: 0, loads, talks, saving, saved, errors, game: last });
}
console.log(JSON.stringify({ success, failure, directory, checks: last?.letterChecks.length, seconds: last?.elapsedSeconds }));
if (!success) process.exitCode = 1;
