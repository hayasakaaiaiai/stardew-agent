/** Native Mod acceptance using deterministic bubble packets; the actual backend is covered by bubbles.test.ts. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { absoluteDay, parseModMessage, PROTOCOL_VERSION } from '../src/bridge/protocol.ts';

const configPath = resolve(process.argv[2]!);
const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')) as {
  RequestId: string; UniqueId: string; SaveFolder: string; SaveDirectory: string; RunDirectory: string; GamePath: string; BackendUrl: string; BubblesOnly?: boolean;
};
assert.equal(config.BubblesOnly, true);
assert.equal(config.SaveFolder, `MemoryTest_${config.UniqueId}`);
assert.notEqual(config.UniqueId, '436774213');
assert.equal(resolve(config.SaveDirectory), resolve(process.env.APPDATA!, 'StardewValley/Saves', config.SaveFolder));
const directory = config.RunDirectory;
const json = async (file: string, value: unknown) => {
  await writeFile(file + '.tmp', JSON.stringify(value, null, 2)); await rename(file + '.tmp', file);
};
const packets: unknown[] = [];
let loads = 0, talkRequests = 0, saves = 0;
const errors: string[] = [];
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(server, 'listening');
config.BackendUrl = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
await json(configPath, config);
server.on('connection', socket => socket.on('message', data => {
  try {
    const message = parseModMessage(data.toString());
    packets.push(message);
    if (message.type === 'hello') { socket.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION })); return; }
    const envelope = { lineageId: message.lineageId, loadNonce: message.loadNonce, seq: message.seq };
    if (message.type === 'save.loaded') {
      loads++;
      socket.send(JSON.stringify({ type: 'save.ready', ...envelope, day: absoluteDay(message.date) }));
      socket.send(JSON.stringify({ type: 'day.bubbles', ...envelope, seq: 0, npcs: { abigail: [
        { text: '风筝该用什么纸呢？', emote: 'exclamation' }, { text: '得把材料凑齐才行。', emote: 'music' },
      ] } }));
    } else {
      if (message.type === 'talk.open' || message.type === 'talk.say') talkRequests++;
      if (message.type === 'save.saving' || message.type === 'save.saved') saves++;
      socket.send(JSON.stringify({ type: 'ack', ...envelope }));
    }
  } catch (error) { errors.push(String(error)); }
}));
interface Report {
  requestId: string; completed: boolean; success: boolean; stage: string; message: string; saveProcessing: boolean; newDay: boolean;
  bubbleChecks: { label: string; passed: boolean; [key: string]: unknown }[];
  elapsedSeconds: number;
}
const game = spawn(join(config.GamePath, 'StardewModdingAPI.exe'), [], { cwd: config.GamePath,
  env: { ...process.env, STARDEW_AGENT_TEST_MEMORY: configPath }, windowsHide: true, stdio: 'ignore' });
let last: Report | undefined, success = false, failure: string | undefined;
const report = async () => {
  try {
    const current = JSON.parse(await readFile(join(directory, 'game-result.json'), 'utf8')) as Report;
    if (current.requestId === config.RequestId) last = current;
  } catch { /* The Mod may still be loading, or atomically replacing its report. */ }
};
try {
  const deadline = Date.now() + 120000;
  let shown = '';
  while (Date.now() < deadline) {
    if (game.exitCode !== null) throw new Error('测试游戏提前退出');
    await report();
    if (last && last.message !== shown) { shown = last.message; console.log(shown); }
    if (last?.completed) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(last?.completed, `游戏气泡检查超时：${last?.stage ?? '未加载'}`);
  assert.ok(last.success, last.message);
  for (const label of ['disabled', 'outside-six-tiles', 'menu-blocks', 'event-blocks', 'ai-conversation-blocks', 'no-unlisted-npc',
    'first-at-five-tiles', 'fifty-minute-cooldown', 'second-at-sixty-minutes', 'no-third-or-repeat', 'reload-clears-consumed-state', 'reload-shows-first-again']) {
    assert.ok(last.bubbleChecks.some(check => check.label === label && check.passed), `没有通过：${label}`);
  }
  assert.ok(last.bubbleChecks.every(check => check.passed), JSON.stringify(last.bubbleChecks.filter(check => !check.passed)));
  for (const name of ['bubble-first', 'bubble-second', 'bubble-reload']) assert.ok((await stat(join(directory, name + '.png'))).size > 100);
  assert.equal(loads, 2);
  assert.equal(talkRequests, 0);
  assert.equal(saves, 0);
  assert.deepEqual(errors, []);
  success = true;
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally {
  if (!last?.completed) {
    await json(join(directory, 'control.json'), { requestId: config.RequestId, stage: '', abort: '气泡检查已停止，请保留证据。' });
    const deadline = Date.now() + 4000;
    while (!last?.completed && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 250)); await report(); }
  }
  if (game.exitCode === null && last?.completed && !last.saveProcessing && !last.newDay) {
    const exited = once(game, 'exit'); game.kill(); await exited;
  }
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await writeFile(join(directory, 'bubble-packets.json'), JSON.stringify(packets, null, 2));
  await json(join(directory, 'result.json'), { success, failure, mode: 'native-mod-with-deterministic-packets',
    requestId: config.RequestId, saveFolder: config.SaveFolder, modelCalls: 0, loads, talkRequests, saves, errors, game: last });
  await appendFile(join(directory, 'backend.log'), JSON.stringify({ success, failure, loads, talkRequests, saves }) + '\n');
}
console.log(JSON.stringify({ success, failure, directory, checks: last?.bubbleChecks.length, seconds: last?.elapsedSeconds }));
if (!success) process.exitCode = 1;
