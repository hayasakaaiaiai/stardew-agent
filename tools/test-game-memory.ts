/** Real-game acceptance runner. Start with test-game-memory.ps1 to create and back up the disposable save. */
import assert from 'node:assert/strict';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fork, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { JSON_HINT, OPENING_LINE, parseOutput } from '../src/agent/dialogue.ts';
import { morningBlock, morningReply, MORNING_HEADING } from '../src/agent/morning.ts';
import { NIGHTLY_RULES, parseNightly } from '../src/agent/nightly.ts';
import { parseBubbles } from '../src/agent/bubbles.ts';
import { letterFor, letterKey } from '../src/agent/letters.ts';
import type { ChatMessage, Completion } from '../src/services/model/client.ts';

interface Config {
  RequestId: string; SaveFolder: string; UniqueId: string; BackendUrl: string;
  RunDirectory: string; SaveDirectory: string; GamePath: string;
  Nightly?: boolean;
  MorningPlans?: boolean;
}
interface Pointer { Format: number; LineageId: string; CommitId: string; ParentId: string | null; DayEnded: number }
interface Reply { label: string; line: string; reply: string; day: number; nonce: string; hearts: number; generation: number; requestSeq?: number }
interface Report {
  requestId: string; stage: string; message: string; completed: boolean; success: boolean;
  day: number; nonce: string; pointer: Pointer | null; generation: number;
  saveFolder: string; lineageId: string; worldReady: boolean; saveProcessing: boolean; newDay: boolean;
  replies: Reply[]; events: { name: string; day: number }[]; elapsedSeconds: number;
  bubblePackets?: { nonce: string; day: number; npcs: Record<string, unknown> }[];
  letterPackets?: { nonce: string; day: number; letters: unknown[]; stored: Record<string, string> }[];
}
interface RecordedCall {
  messages: ChatMessage[]; content: string; timing: Completion['timing']; usage: Completion['usage'];
  kind?: 'dialogue' | 'nightly'; thinking?: string; startedAt?: string; finishedAt?: string;
}
interface NightState { impression: string; plan: string; day: number; bubbles?: unknown; letter?: { text: string; importance: number; item?: string } | null }
interface StoredMemory { id: string; text: string; importance: number; kind: string; visibility: string }
interface NightEvidence {
  pointer: Pointer; state: NightState; summaries: StoredMemory[]; retired: string[];
  call: RecordedCall; ackObservedBeforeCompletion: boolean;
}

const ROOT = resolve(import.meta.dirname, '..');
const configPath = resolve(process.argv[2] ?? '');
const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')) as Config;
assert.equal(config.SaveFolder, `MemoryTest_${config.UniqueId}`);
assert.notEqual(config.UniqueId, '436774213');
assert.equal(resolve(config.SaveDirectory), resolve(process.env.APPDATA!, 'StardewValley/Saves', config.SaveFolder));
const directory = config.RunDirectory;
const memoryDirectory = join(directory, 'memory');
const calls: RecordedCall[] = [];
const evidence: Record<string, unknown> = {};
const handled = new Set<string>();
const log = (line: string) => {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped); appendFileSync(join(directory, 'backend.log'), stamped + '\n');
};
const json = async (file: string, value: unknown) => {
  await writeFile(file + '.tmp', JSON.stringify(value, null, 2));
  await rename(file + '.tmp', file);
};
const control = (stage: string, abort?: string) => json(join(directory, 'control.json'),
  { requestId: config.RequestId, stage, ...(abort ? { abort } : {}) });
async function start(port = 0) {
  const output = openSync(join(directory, 'backend-process.log'), 'a');
  const child = fork(join(ROOT, 'tools/game-memory-test-backend.ts'), [configPath, String(port)], {
    cwd: ROOT, execArgv: [], windowsHide: true, stdio: ['ignore', output, output, 'ipc'],
  });
  closeSync(output);
  const ready = await new Promise<{ port: number; model: string; pid: number; nightly: boolean }>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('独立后端进程启动超时')); }, 15000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`后端在就绪前退出：${code}`)); });
    child.once('message', message => { clearTimeout(timeout); resolve(message as { port: number; model: string; pid: number; nightly: boolean }); });
  });
  assert.equal(ready.nightly, !!config.Nightly, '独立后端没有启用所需的夜间整合模式');
  let stopped = false;
  return { ...ready, async close() {
    if (stopped) return;
    stopped = true;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error('独立后端进程没有按时退出')); }, 10000);
      child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`后端退出码 ${code}`)); });
      child.send('stop');
    });
  } };
}
async function refreshCalls() {
  const content = await readFile(join(directory, 'model-calls.jsonl'), 'utf8');
  calls.splice(0, calls.length, ...content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as RecordedCall));
}
let server = await start();
config.BackendUrl = `ws://127.0.0.1:${server.port}`;
await json(configPath, config);
const gameEnv: NodeJS.ProcessEnv = { ...process.env, STARDEW_AGENT_TEST_MEMORY: configPath };
delete gameEnv.STARDEW_AGENT_TEST_ABIGAIL;
const game = spawn(join(config.GamePath, 'StardewModdingAPI.exe'), [], {
  cwd: config.GamePath, env: gameEnv, stdio: 'ignore', windowsHide: false,
});
let gameExited = false;
let gameError: Error | undefined;
game.once('exit', () => { gameExited = true; });
game.once('error', error => { gameError = error; });
game.unref();

function reply(report: Report, label: string): Reply {
  const item = report.replies.findLast(item => item.label === label);
  assert.ok(item, `缺少游戏内回复 ${label}`);
  assert.equal(item.hearts, 8);
  return item;
}
function callFor(item: Reply) {
  const call = calls.findLast(call => call.messages.at(-1)?.content === item.line + JSON_HINT
    && (!item.label.startsWith('opening-') || parseOutput(call.content).reply === item.reply
      || (call.messages[0]!.content.includes(MORNING_HEADING) && morningView(call, item) === item.reply)));
  assert.ok(call, `没有找到 ${item.label} 的真实模型调用`);
  return call;
}
function morningView(call: RecordedCall, item: Reply): string {
  const planLine = call.messages[0]!.content.split(MORNING_HEADING)[1]?.split('\n- ')[1]?.split('\n')[0];
  assert.ok(planLine);
  const plan: unknown = JSON.parse(planLine);
  assert.equal(typeof plan, 'string');
  // The prompt already uses today's dates, so a same-day conversion preserves those labels.
  return morningReply(parseOutput(call.content).reply, plan as string, item.day, item.day);
}
function openingAt(report: Report, label: string, state: NightState | undefined, prompted: boolean) {
  if (!config.MorningPlans) return;
  const item = reply(report, `opening-${label}`);
  const call = callFor(item);
  assert.equal(call.messages[0]!.content.includes(MORNING_HEADING), prompted, `${label} 的主动开场触发不正确`);
  if (prompted) {
    assert.ok(state && state.day === item.day - 1);
    assert.ok(call.messages[0]!.content.includes(morningBlock(state.plan, state.day, item.day)), '开场未使用当前分支昨晚的计划');
  }
  const openings = (evidence.morningOpenings ??= []) as unknown[];
  openings.push({ ...item, prompted, usage: call.usage, rawReply: parseOutput(call.content).reply });
}
function openingLog(pointer: Pointer, report: Report, label: string) {
  if (!config.MorningPlans) return;
  const item = reply(report, `opening-${label}`);
  assert.ok(item.requestSeq);
  const row = sql<{ entry: string }>('SELECT entry FROM log WHERE commit_id=? AND npc_id=? AND seq=?',
    pointer.CommitId, 'abigail', String(item.requestSeq))[0];
  assert.ok(row, '成功开场没有随真实存档写入日志');
  const entry = JSON.parse(row.entry) as { changes: { log: { player: string; npc: string }; memories: unknown[] }[] };
  assert.equal(entry.changes[0]!.log.player, OPENING_LINE);
  assert.equal(entry.changes[0]!.log.npc, item.reply);
  assert.deepEqual(entry.changes[0]!.memories, [], 'NPC 主动开场被记成了新的玩家事实');
}
async function bubblesAt(report: Report, state: NightState, label: string) {
  assert.equal(state.day, report.day - 1);
  const lines = parseBubbles(state.bubbles);
  const expected = lines.length ? { abigail: lines } : {};
  const letter = letterFor({ day: state.day, letter: state.letter ?? null }, report.day);
  const expectedLetters = letter ? [{ key: letterKey(config.UniqueId, report.pointer!.CommitId, 'abigail'), npc: 'abigail', text: letter.text,
    ...(letter.item ? { item: letter.item } : {}) }] : [];
  const deadline = Date.now() + 5000;
  do {
    let latest: Report;
    try { latest = JSON.parse(await readFile(join(directory, 'game-result.json'), 'utf8')) as Report; }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    const packet = latest.bubblePackets?.findLast(packet => packet.nonce === report.nonce && packet.day === report.day
      && JSON.stringify(packet.npcs) === JSON.stringify(expected));
    const mail = latest.letterPackets?.findLast(packet => packet.nonce === report.nonce && packet.day === report.day
      && JSON.stringify(packet.letters) === JSON.stringify(expectedLetters));
    if (packet && mail) {
      const deliveries = (evidence.bubbleDeliveries ??= []) as unknown[];
      deliveries.push({ label, ...packet });
      const letters = (evidence.letterDeliveries ??= []) as unknown[];
      letters.push({ label, ...mail });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`${label} 的实际 Mod 没有收到当前分支的气泡和信件`);
}
function sql<T>(query: string, ...parameters: string[]): T[] {
  const db = new DatabaseSync(join(memoryDirectory, 'memory.sqlite'), { readOnly: true });
  try { return db.prepare(query).all(...parameters) as T[]; }
  finally { db.close(); }
}
function saved(report: Report): Pointer {
  const pointer = report.pointer;
  assert.ok(pointer);
  assert.equal(pointer.LineageId, config.UniqueId);
  const rows = sql<{ parent_id: string | null; day_ended: number; status: string }>(
    'SELECT parent_id, day_ended, status FROM commit_node WHERE id=? AND lineage_id=?', pointer.CommitId, config.UniqueId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'confirmed');
  assert.equal(rows[0]!.day_ended, pointer.DayEnded);
  if (pointer.ParentId === null) {
    assert.ok(rows[0]!.parent_id);
    const roots = sql<{ parent_id: string | null; day_ended: number; status: string }>(
      'SELECT parent_id, day_ended, status FROM commit_node WHERE id=? AND lineage_id=?', rows[0]!.parent_id, config.UniqueId);
    assert.deepEqual(roots.map(row => ({ ...row })), [{ parent_id: null, day_ended: 0, status: 'confirmed' }]);
  } else assert.equal(rows[0]!.parent_id, pointer.ParentId);
  assert.equal(report.day, pointer.DayEnded + 1);
  return pointer;
}
async function savePointer(): Promise<Pointer> {
  const xml = await readFile(join(config.SaveDirectory, config.SaveFolder), 'utf8');
  assert.match(xml, new RegExp(`<uniqueIDForThisGame>${config.UniqueId}</uniqueIDForThisGame>`));
  const match = /<item>\s*<key>\s*<string>smapi\/mod-data\/mmj\.stardewagentbridge\/memory-commit<\/string>\s*<\/key>\s*<value>\s*<string>([\s\S]*?)<\/string>\s*<\/value>\s*<\/item>/.exec(xml);
  assert.ok(match, '真实游戏文件没有记忆指针');
  const value = match[1]!.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return JSON.parse(value) as Pointer;
}
function memories(pointer: Pointer) {
  return sql<StoredMemory>('SELECT id, text, importance, kind, visibility FROM memory WHERE commit_id=? AND npc_id=?', pointer.CommitId, 'abigail');
}
async function night(pointer: Pointer): Promise<NightEvidence | undefined> {
  if (!config.Nightly) return undefined;
  const fingerprint = () => sql<{ consolidation_fingerprint: string | null }>(
    'SELECT consolidation_fingerprint FROM commit_node WHERE id=?', pointer.CommitId)[0]!.consolidation_fingerprint;
  const ackObservedBeforeCompletion = fingerprint() === null;
  log(`等待第 ${pointer.DayEnded} 天的真实模型夜间整合完成...`);
  const deadline = Date.now() + 90_000;
  while (fingerprint() === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(fingerprint(), '夜间整合没有在限时内完成，不能把原始记忆当作整合通过');
  const states = sql<{ state: string }>('SELECT state FROM npc_state WHERE commit_id=? AND npc_id=? AND phase=?',
    pointer.CommitId, 'abigail', 'consolidated');
  assert.equal(states.length, 1, '整合未写入 NPC 状态');
  const state = JSON.parse(states[0]!.state) as NightState;
  assert.ok(state.impression?.trim(), '缺少整体印象');
  assert.ok(state.plan?.trim(), '缺少次日计划');
  assert.equal(state.day, pointer.DayEnded);
  const all = memories(pointer);
  const summaries = all.filter(memory => memory.kind === 'summary');
  assert.ok(summaries.length >= 1 && summaries.length <= 2, '整合摘要数量不正确');
  assert.ok(summaries.every(memory => memory.visibility === 'private'));
  const retired = sql<{ memory_id: string }>('SELECT memory_id FROM memory_retire WHERE commit_id=?', pointer.CommitId)
    .map(row => row.memory_id);
  assert.ok(all.filter(memory => memory.kind === 'conversation').every(memory => retired.includes(memory.id)), '当天零碎记忆未退役');
  await refreshCalls();
  const call = calls.findLast(call => call.kind === 'nightly');
  assert.ok(call);
  assert.equal(call.thinking, 'low');
  assert.equal(call.messages[0]!.content, NIGHTLY_RULES);
  assert.match(call.messages[1]!.content, /农场主：记忆验收（[男女]）/);
  assert.match(call.messages[1]!.content, /8 心/);
  const output = parseNightly(call.content);
  assert.ok(output, '整合输出没有有效的原话引用');
  const sourceRows = call.messages[1]!.content.split('## 今天的对话（NPC=你，玩家=农场主）\n')[1]!
    .split('\n\n## 今天当场记下的')[0]!.split('\n');
  const sources = sourceRows.map(line => {
    const match = /^- (t\d+) (NPC|玩家)：(".*")$/.exec(line);
    assert.ok(match, '说话人和原话没有正确隔离');
    return { id: match[1]!, speaker: match[2]!, text: JSON.parse(match[3]!) as string };
  });
  const expected = output.memories.map(memory => {
    assert.ok(memory.sources.every(id => sources.some(source => source.id === id)), '整合引用了不存在的原话');
    return sources.filter(source => memory.sources.includes(source.id))
      .map(source => `${source.speaker === '玩家' ? '农场主说' : '我说'}：${JSON.stringify(source.text)}`).join('\n');
  });
  assert.deepEqual(summaries.map(memory => memory.text).sort(), expected.sort(), '数据库中的摘要必须保留原说话人和完整原话');
  return { pointer, state, summaries, retired, call, ackObservedBeforeCompletion };
}
function impressionAt(item: Reply, state: NightState | undefined) {
  if (!state) return;
  const system = callFor(item).messages[0]!.content;
  assert.ok(system.includes(`你对农场主的整体印象：${state.impression}`), '下一轮没有使用该保存点的整体印象');
  assert.doesNotMatch(system, /## (?:你)?明天的计划|## (?:次日|行动)计划/);
}
async function backupSave(name: string) {
  const target = join(directory, name);
  await mkdir(target);
  for (const file of [config.SaveFolder, 'SaveGameInfo'])
    await copyFile(join(config.SaveDirectory, file), join(target, file));
}
let a: Pointer | undefined;
let b: Pointer | undefined;
let c: Pointer | undefined;
let nightA: NightEvidence | undefined;
let nightB: NightEvidence | undefined;
let nightC: NightEvidence | undefined;
let nightlyCallsAfterB = 0;
let restartNonce = '';
let restartGeneration = 0;
let last: Report | undefined;
let lastMessage = '';
let success = false;
let errorMessage: string | undefined;
try {
  const deadline = Date.now() + 700_000;
  while (Date.now() < deadline) {
    if (gameError) throw gameError;
    let report: Report;
    try { report = JSON.parse(await readFile(join(directory, 'game-result.json'), 'utf8')) as Report; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      assert.ok(!gameExited, '游戏在测试完成前退出');
      await new Promise(resolve => setTimeout(resolve, 300)); continue;
    }
    assert.equal(report.requestId, config.RequestId);
    last = report;
    if (report.message !== lastMessage) { log(report.message); lastMessage = report.message; }
    if (report.completed) {
      assert.ok(report.success, report.message);
      assert.equal(handled.size, 7, '未完成全部证据核验节点');
      success = true; break;
    }
    assert.ok(!gameExited, '游戏在测试完成前退出');
    if (!handled.has(report.stage)) {
      switch (report.stage) {
        case 'saved-a': {
          await refreshCalls();
          a = saved(report);
          assert.deepEqual(await savePointer(), a);
          nightA = await night(a);
          openingAt(report, 'learn-cat', undefined, false);
          if (nightA) {
            await bubblesAt(report, nightA.state, 'A-next-day');
            assert.match(JSON.stringify(nightA.summaries), /星糖/);
            evidence.nightlyA = nightA;
          }
          assert.match(JSON.stringify(memories(a)), /星糖/, '模型没有在实际保存中记下指定信息');
          const initial = reply(report, 'learn-cat');
          assert.equal(a.DayEnded, initial.day);
          await backupSave('save-a');
          evidence.savedA = { pointer: a, memories: memories(a), learned: initial };
          break;
        }
        case 'rollback-ready': {
          await refreshCalls();
          if (nightA) await bubblesAt(report, nightA.state, 'A-rollback');
          openingAt(report, 'ask-cat', nightA?.state, true);
          openingAt(report, 'ask-rollback', nightA?.state, true);
          const nextDay = reply(report, 'ask-cat');
          assert.match(nextDay.reply, /星糖/);
          assert.match(callFor(nextDay).messages[0]!.content, /星糖/);
          impressionAt(nextDay, nightA?.state);
          const rolled = reply(report, 'ask-rollback');
          assert.match(rolled.reply, /星糖/);
          assert.doesNotMatch(rolled.reply, /青岚/);
          assert.match(callFor(rolled).messages[0]!.content, /星糖/);
          assert.doesNotMatch(JSON.stringify(callFor(rolled).messages), /青岚/);
          assert.notEqual(rolled.nonce, nextDay.nonce);
          impressionAt(rolled, nightA?.state);
          assert.deepEqual(await savePointer(), a);
          evidence.crossDay = nextDay; evidence.unsavedRollback = rolled;
          break;
        }
        case 'restart-backend': {
          const learned = reply(report, 'learn-kite');
          restartNonce = report.nonce; restartGeneration = report.generation;
          const port = server.port;
          const oldPid = server.pid;
          await server.close(); server = await start(port);
          assert.notEqual(server.pid, oldPid);
          evidence.restartBefore = { learned, nonce: restartNonce, generation: restartGeneration, oldPid, newPid: server.pid };
          break;
        }
        case 'saved-b': {
          await refreshCalls();
          b = saved(report);
          assert.deepEqual(await savePointer(), b);
          nightB = await night(b);
          openingAt(report, 'ask-restart', nightA?.state, false);
          openingLog(b, report, 'ask-rollback');
          nightlyCallsAfterB = calls.filter(call => call.kind === 'nightly').length;
          if (nightB) {
            await bubblesAt(report, nightB.state, 'B-next-day');
            assert.match(JSON.stringify(nightB.summaries), /紫色/);
            assert.match(JSON.stringify(nightB.summaries), /风筝/);
            evidence.nightlyB = nightB;
          }
          assert.equal(b.ParentId, a!.CommitId);
          assert.match(JSON.stringify(memories(b)), /紫色/);
          assert.match(JSON.stringify(memories(b)), /风筝/);
          const recovered = reply(report, 'ask-restart');
          assert.equal(recovered.nonce, restartNonce);
          assert.ok(recovered.generation > restartGeneration);
          assert.match(recovered.reply, /紫色/);
          assert.match(JSON.stringify(callFor(recovered).messages), /紫色风筝/);
          impressionAt(recovered, nightA?.state);
          await backupSave('save-b');
          evidence.backendRestart = recovered; evidence.savedB = { pointer: b, memories: memories(b) };
          break;
        }
        case 'restore-a': {
          assert.ok(a && b);
          if (config.MorningPlans) {
            await refreshCalls();
            openingAt(report, 'next-plan', nightB?.state, true);
            assert.match(nightB!.state.plan, /风筝/, '夜间计划没有保留专门用于验证的风筝约定');
            assert.match(reply(report, 'opening-next-plan').reply, /风筝/, '实际开场没有提起已确认的风筝约定');
          }
          // The Mod has returned to title and acknowledged its lifecycle queue. Only this run's copy is replaced.
          assert.equal(report.stage, 'restore-a');
          for (const file of [config.SaveFolder, 'SaveGameInfo'])
            await copyFile(join(directory, 'save-a', file), join(config.SaveDirectory, file));
          assert.deepEqual(await savePointer(), a);
          evidence.restoredA = a;
          break;
        }
        case 'fork-loaded': {
          await refreshCalls();
          if (nightA) await bubblesAt(report, nightA.state, 'A-fork-reload');
          openingAt(report, 'ask-fork', nightA?.state, true);
          const fork = reply(report, 'ask-fork');
          assert.match(fork.reply, /星糖/);
          assert.match(callFor(fork).messages[0]!.content, /星糖/);
          assert.doesNotMatch(callFor(fork).messages[0]!.content, /风筝/);
          assert.notEqual(fork.nonce, restartNonce);
          impressionAt(fork, nightA?.state);
          if (nightB) assert.equal(calls.filter(call => call.kind === 'nightly').length,
            nightlyCallsAfterB, '读回已整合旧档时重复调用了整合模型');
          evidence.oldSaveRecall = fork;
          break;
        }
        case 'saved-c': {
          await refreshCalls();
          c = saved(report);
          assert.deepEqual(await savePointer(), c);
          nightC = await night(c);
          openingLog(c, report, 'ask-fork');
          if (nightC) {
            await bubblesAt(report, nightC.state, 'C-next-day');
            assert.match(JSON.stringify(nightC.summaries), /金色/);
            assert.match(JSON.stringify(nightC.summaries), /纸船/);
            assert.doesNotMatch(JSON.stringify(nightC.summaries), /风筝/);
            evidence.nightlyC = nightC;
          }
          assert.equal(c.ParentId, a!.CommitId);
          assert.equal(c.DayEnded, b!.DayEnded);
          assert.notEqual(c.CommitId, b!.CommitId);
          assert.match(JSON.stringify(memories(c)), /金色纸船/);
          assert.doesNotMatch(JSON.stringify(memories(c)), /风筝/);
          assert.equal(report.events.filter(event => event.name === 'Saving').length, 3);
          assert.equal(report.events.filter(event => event.name === 'Saved').length, 3);
          await backupSave('save-c');
          evidence.savedC = { pointer: c, memories: memories(c) };
          evidence.commitTree = sql('SELECT id, parent_id, day_ended, status FROM commit_node WHERE lineage_id=? ORDER BY day_ended,id', config.UniqueId);
          break;
        }
        default:
          await new Promise(resolve => setTimeout(resolve, 300)); continue;
      }
      handled.add(report.stage);
      await json(join(directory, 'evidence.json'), evidence);
      await control(report.stage);
      log('证据核验通过：' + report.stage);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.ok(success, '等待真实游戏验收结果超时');
} catch (error) {
  errorMessage = error instanceof Error ? error.message : String(error);
  await control(last?.stage ?? 'starting', errorMessage);
  log('验收停止：' + errorMessage);
  process.exitCode = 1;
  // Give the in-game watchdog a chance to show its pause message before the backend shuts down.
  await new Promise(resolve => setTimeout(resolve, 1000));
} finally {
  await server.close();
  const terminal = JSON.parse(await readFile(join(directory, 'game-result.json'), 'utf8').catch(() => '{}')) as Partial<Report>;
  // This child was created for a disposable save. Never terminate a user-owned game or an active save operation.
  if (terminal.requestId === config.RequestId && terminal.saveFolder === config.SaveFolder && terminal.completed
      && terminal.saveProcessing === false && terminal.newDay === false && !gameExited) {
    await cp(config.SaveDirectory, join(directory, 'copy-at-exit'), { recursive: true });
    game.kill();
    log('已结束本脚本启动的验收副本进程；副本最终文件已备份。');
  }
  await cp(join(process.env.APPDATA!, 'StardewValley/ErrorLogs/SMAPI-latest.txt'), join(directory, 'SMAPI-latest.txt'));
  await cp(join(config.GamePath, 'Mods/StardewAgentBridge/manifest.json'), join(directory, 'mod-manifest.json'));
  await refreshCalls().catch(() => {});
  const result = { success, requestId: config.RequestId, saveFolder: config.SaveFolder, model: server.model,
    nightlyEnabled: !!config.Nightly, nightlyCalls: calls.filter(call => call.kind === 'nightly').length,
    morningPlansEnabled: !!config.MorningPlans,
    modelCalls: calls.length, checkedStages: [...handled], evidence, game: last, ...(errorMessage ? { error: errorMessage } : {}) };
  await json(join(directory, 'result.json'), result);
  console.log(JSON.stringify({ success, requestId: config.RequestId, modelCalls: calls.length, directory, error: errorMessage }, null, 2));
}
