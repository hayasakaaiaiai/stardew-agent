/** One native-game acceptance run for scenes, gifts and friendship. Launch with test-game-social.ps1. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket, WebSocketServer } from 'ws';
import { BridgeServer } from '../src/bridge/server.ts';
import { parseModMessage, PROTOCOL_VERSION } from '../src/bridge/protocol.ts';
import { nightlyConsolidator } from '../src/agent/nightly.ts';
import { ModelClient, modelConfigFromEnv, type ChatMessage, type Completion, type StreamHandlers } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';
import { digest } from '../src/validation.ts';

interface Config {
  RequestId: string; UniqueId: string; SaveFolder: string; SaveDirectory: string;
  RunDirectory: string; GamePath: string; BackendUrl: string; Social: boolean; Offline: boolean; NewParts?: boolean;
}
interface Check { label: string; passed: boolean; points: number; detail?: unknown }
interface Report {
  requestId: string; completed: boolean; success: boolean; stage: string; message: string;
  saveProcessing: boolean; newDay: boolean; elapsedSeconds: number; day: number;
  socialChecks: Check[]; socialReplies: { seq: number; nonce: string; friendship: number; points: number }[];
  socialSceneLines: { npc: string; text: string; visible: string }[];
  nonce: string;
  newPartsChecks: Check[];
  presentDeliveries: { npc: string; name: string; id: string; quality: number; stack: number; before: number; after: number; direct: boolean; nonce: string; day: number }[];
  householdSnapshots: { label: string; world: { flags: { partner: { npc: string; status: string } | null; children: number } } }[];
}
const ROOT = resolve(import.meta.dirname, '..');
const configPath = resolve(process.argv[2]!);
const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')) as Config;
assert.equal(config.Social, true);
assert.equal(config.SaveFolder, `MemoryTest_${config.UniqueId}`);
assert.notEqual(config.UniqueId, '436774213');
assert.equal(resolve(config.SaveDirectory), resolve(process.env.APPDATA!, 'StardewValley/Saves', config.SaveFolder));
const directory = config.RunDirectory;
const json = async (file: string, value: unknown) => { await writeFile(file + '.tmp', JSON.stringify(value, null, 2)); await rename(file + '.tmp', file); };
const log = (line: string) => { console.log(line); void appendFile(join(directory, 'backend.log'), line + '\n'); };
if (!config.Offline) process.loadEnvFile(join(ROOT, '.env'));
const paid = config.Offline ? undefined : new ModelClient(modelConfigFromEnv());
const paidScene = paid ? new ModelClient({ ...paid.config, thinking: 'disabled' }) : undefined;
const calls: { kind: string; real: boolean; messages: ChatMessage[]; content: string; usage: Completion['usage']; timing: Completion['timing'] }[] = [];
let real = false;
let newParts = false;
function model(kind: 'dialogue' | 'scene' | 'nightly'): ModelClient {
  return { async chat(messages: ChatMessage[], handlers: StreamHandlers = {}, options = {}): Promise<Completion> {
    const actual = real && kind !== 'nightly';
    let completion: Completion;
    if (actual) completion = await (kind === 'scene' ? paidScene! : paid!).chat(messages, handlers, options);
    else {
      const last = messages.at(-1)?.content ?? '';
      const content = JSON.stringify(kind === 'scene' ? { lines: [
        { speaker: 'a', text: '今天天气真不错。', emote: 'happy' }, { speaker: 'b', text: '嗯，出去走走吧。', emote: 'music' },
      ] } : kind === 'nightly' ? { memories: [], retire: [], impression: '相处自然。', plan: '', bubbles: [], letter: '', gift: false } : {
        reply: newParts ? '这个给你，今天过得怎么样？' : '嗯，我记得那块紫水晶。', emotion: 'happy', options: ['再聊一会', '说说近况', '听听你的想法'],
        remember: [], mood: Number(/^好感(-?\d)/.exec(last)?.[1] ?? 2), give: newParts, end: false,
      });
      handlers.onContent?.(content);
      completion = { content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 0, totalMs: 0 } };
    }
    const call = { kind, real: actual, messages, content: completion.content, usage: completion.usage, timing: completion.timing };
    calls.push(call); await appendFile(join(directory, 'model-calls.jsonl'), JSON.stringify(call) + '\n');
    return completion;
  } } as ModelClient;
}
const roster = new Roster({ directory: join(ROOT, 'data/npcs'), npcIds: SOCIAL_NPCS });
assert.equal((await roster.load()).errors.length, 0);
const server = await BridgeServer.start({ roster, model: model('dialogue'), sceneModel: model('scene'),
  consolidator: nightlyConsolidator({ roster, model: model('nightly'), log }), memoryDirectory: join(directory, 'memory'), port: 0, log });
const packets: { direction: string; packet: Record<string, unknown>; injected?: string }[] = [];
const errors: string[] = [];
const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(relay, 'listening');
config.BackendUrl = `ws://127.0.0.1:${(relay.address() as { port: number }).port}`;
await json(configPath, config);
let duplicateGift = false;
const upstreams = new Set<WebSocket>();
relay.on('connection', client => {
  const upstream = new WebSocket(`ws://127.0.0.1:${server.port}`); upstreams.add(upstream);
  const waiting: string[] = [];
  upstream.on('open', () => { for (const raw of waiting) upstream.send(raw); });
  client.on('message', data => {
    const raw = data.toString();
    try {
      const packet = parseModMessage(raw); packets.push({ direction: 'mod', packet: packet as unknown as Record<string, unknown> });
      if (upstream.readyState === WebSocket.OPEN) upstream.send(raw); else waiting.push(raw);
      if (packet.type === 'gift.given' && !duplicateGift) {
        duplicateGift = true; packets.push({ direction: 'mod', packet: packet as unknown as Record<string, unknown>, injected: 'same-gift-sequence-replay' });
        if (upstream.readyState === WebSocket.OPEN) upstream.send(raw); else waiting.push(raw);
      }
    } catch (error) { errors.push(String(error)); }
  });
  upstream.on('message', data => {
    const raw = data.toString(), packet = JSON.parse(raw) as Record<string, unknown>;
    packets.push({ direction: 'backend', packet });
    if (packet.type === 'sync.error' || packet.type === 'talk.error') errors.push(JSON.stringify(packet));
    if (client.readyState !== WebSocket.OPEN) return;
    client.send(raw);
    if (packet.type === 'talk.reply') {
      // Exercise the real Mod's request-sequence guard; repeated replies must not apply friendship twice.
      client.send(raw); packets.push({ direction: 'backend', packet, injected: 'same-talk-reply-replay' });
    }
  });
  upstream.on('error', error => errors.push(String(error)));
  client.on('close', () => upstream.close());
});
const gameEnv = { ...process.env, STARDEW_AGENT_TEST_MEMORY: configPath };
delete (gameEnv as NodeJS.ProcessEnv).STARDEW_AGENT_TEST_ABIGAIL;
const game = spawn(join(config.GamePath, 'StardewModdingAPI.exe'), [], { cwd: config.GamePath, env: gameEnv, windowsHide: true, stdio: 'ignore' });
game.on('error', error => errors.push(String(error)));
let last: Report | undefined, success = false, failure: string | undefined;
const report = async () => {
  try { const value = JSON.parse(await readFile(join(directory, 'game-result.json'), 'utf8')) as Report; if (value.requestId === config.RequestId) last = value; }
  catch { /* The game may still be loading or replacing its report. */ }
};
try {
  const deadline = Date.now() + 300000;
  let shown = '';
  while (Date.now() < deadline) {
    if (game.exitCode !== null) throw new Error('测试游戏提前退出');
    await report();
    if (last && last.message !== shown) { shown = last.message; console.log(shown); }
    if (last?.message === 'social-real-ready' && !real) {
      real = true;
      await json(join(directory, 'control.json'), { requestId: config.RequestId, stage: 'social-real-ready' });
    }
    if (last?.message === 'new-parts-fixed-ready' && !newParts) {
      real = false; newParts = true;
      await json(join(directory, 'control.json'), { requestId: config.RequestId, stage: 'new-parts-fixed-ready' });
    }
    if (last?.message === 'new-parts-real-ready' && !real) {
      real = true;
      await json(join(directory, 'control.json'), { requestId: config.RequestId, stage: 'new-parts-real-ready' });
    }
    if (last?.completed) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(last?.completed, `组合检查超时：${last?.stage ?? '未加载'}`);
  assert.ok(last.success, last.message);
  assert.deepEqual(errors, []);
  const required = ['scene-disabled', 'scene-player-outside-eight-tiles', 'scene-npcs-outside-two-tiles', 'scene-menu-blocks',
    'scene-event-blocks', 'scene-ai-talk-blocks', 'scene-first-request', 'scene-native-lines-shown', 'scene-pair-once-daily',
    'scene-fifty-minute-gap-blocks', 'scene-sixty-minute-gap-allows', 'scene-four-daily-cap',
    'gift-native-amethyst-counter', 'gift-mod-detected-and-acknowledged', 'friendship-opening-zero',
    'friendship-disabled-native-zero', 'friendship-mod-positive-defense', 'friendship-mod-negative-defense', 'friendship-positive-cap',
    ...Array.from({ length: 11 }, (_, i) => `friendship-native-delta-${i}`), 'friendship-negative-cap',
    'new-day-resets-caps', 'friendship-real-save-and-reload', 'gift-native-clay-counter', 'friendship-unsaved-negative',
    'friendship-unsaved-rollback', 'gift-counter-and-chat-cap-rollback'];
  if (!config.Offline) required.push('scene-real-model-native-lines', 'friendship-real-opening-zero',
    'gift-real-model-remembers-amethyst', 'friendship-real-positive', 'friendship-real-negative');
  for (const label of required) assert.ok(last.socialChecks.some(check => check.label === label && check.passed), label);
  assert.ok(last.socialChecks.every(check => check.passed));
  assert.ok(last.socialSceneLines.every(line => line.text === line.visible), 'native textAboveHead must match the delivered lines');
  assert.ok((await stat(join(directory, 'social-scene-fixed.png'))).size > 100);
  if (!config.Offline) assert.ok((await stat(join(directory, 'social-scene-real.png'))).size > 100);
  const mod = packets.filter(row => row.direction === 'mod' && !row.injected).map(row => row.packet);
  const gifts = mod.filter(packet => packet.type === 'gift.given');
  assert.equal(gifts.length, 2); assert.equal(gifts[0]!.taste, 'love'); assert.equal(gifts[0]!.item, '紫水晶'); assert.equal(gifts[1]!.item, '粘土');
  assert.equal(mod.filter(packet => packet.type === 'save.loaded').length, config.NewParts ? 6 : 3);
  assert.equal(mod.filter(packet => packet.type === 'save.saved').length, config.NewParts ? 2 : 1);
  const note = '农场主送我紫水晶，我特别喜欢。';
  const prompt = (call: typeof calls[number]) => call.messages[0]!.content;
  assert.ok(calls.some(call => call.kind === 'dialogue' && prompt(call).includes(note)));
  const clayIndex = calls.findIndex(call => call.kind === 'dialogue' && prompt(call).includes('农场主送我粘土'));
  assert.ok(clayIndex >= 0, 'the unsaved clay gift must enter that day’s prompt');
  const rolled = calls.find(call => call.messages.at(-1)?.content.startsWith('好感0 我昨天送了你什么？'));
  assert.ok(rolled); assert.ok(prompt(rolled).includes(note)); assert.ok(!prompt(rolled).includes('农场主送我粘土'));
  assert.equal(prompt(rolled).split(note).length - 1, 1, 'a replayed gift is remembered once');
  const db = new DatabaseSync(join(directory, 'memory/memory.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory WHERE text=?').get(note)!.n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory WHERE text LIKE '%农场主送我粘土%'").get()!.n, 0);
  } finally { db.close(); }
  const replies = packets.filter(row => row.direction === 'backend' && !row.injected && row.packet.type === 'talk.reply');
  assert.equal(last.socialReplies.length, replies.length, 'duplicate replies must never enter Mod application twice');
  for (const row of replies) assert.ok(last.socialReplies.some(reply => reply.seq === row.packet.seq && reply.nonce === row.packet.loadNonce
    && reply.friendship === row.packet.friendship), 'the Mod must apply the backend delta for the matching request');
  assert.ok(calls.filter(call => call.kind === 'scene').every(call => !prompt(call).includes(note)), 'private gifts stay out of NPC small talk');
  if (config.NewParts) {
    const labels = ['present-native-delivery-on-opening', 'present-duplicate-reply-does-not-duplicate-item', 'present-disabled',
      'present-unknown-and-overprice-rejected', 'present-full-inventory-native-debris', 'present-no-second-opening-gift',
      'present-unsaved-item-rollback', 'present-rollback-allows-offer-again', 'present-real-save-reload-persists', 'present-next-day-weekly-cooldown',
      ...['(O)458', '(O)277', '(O)460', '(O)808', '(O)809'].map(id => `special-item-not-ordinary-gift-${id}`),
      ...['single', 'dating-private', 'engaged', 'roommate', 'married-child'].map(label => `public-facts-native-${label}`),
      'public-facts-unsaved-fixture-rollback'];
    if (!config.Offline) labels.push('present-real-model-native-item', 'public-facts-real-pierre', 'present-real-unsaved-rollback');
    for (const label of labels) assert.ok(last.newPartsChecks.some(check => check.label === label && check.passed), label);
    assert.ok(last.newPartsChecks.every(check => check.passed));
    assert.ok(last.presentDeliveries.every(delivery => delivery.quality === 0));
    assert.ok((await stat(join(directory, 'newparts-present.png'))).size > 100);
    const handovers = packets.filter(row => row.direction === 'backend' && !row.injected && typeof row.packet.gift === 'string');
    for (const row of handovers) assert.ok(last.presentDeliveries.some(delivery => !delivery.direct && delivery.nonce === row.packet.loadNonce
      && delivery.name === row.packet.gift), 'a backend handover must have an actual native item receipt');
    const givenDb = new DatabaseSync(join(directory, 'memory/memory.sqlite'), { readOnly: true });
    try { assert.equal(givenDb.prepare("SELECT COUNT(*) AS n FROM memory WHERE npc_id='leah' AND text LIKE '我当面送了农场主%'").get()!.n, 1); }
    finally { givenDb.close(); }
    const checkpoints = await readdir(join(directory, 'memory/bridge', digest(config.UniqueId)));
    assert.deepEqual(checkpoints, [digest(last.nonce) + '.json'], 'new loads prune checkpoints even during actual game reloads');
    if (!config.Offline) {
      const pierre = calls.findLast(call => call.real && call.messages.at(-1)?.content.startsWith('阿比盖尔最近还好吗？'));
      assert.ok(pierre); assert.match(prompt(pierre), /玩家的配偶：阿比盖尔，已搬到玩家的农场/);
      assert.match(prompt(pierre), /玩家的孩子：有 1 个孩子/);
      assert.ok(packets.some(row => row.direction === 'mod' && row.packet.type === 'talk.open' && row.packet.npc === 'Pierre'
        && (row.packet.world as { flags?: { partner?: { status: string }; children?: number } })?.flags?.partner?.status === 'married'));
    }
  }
  success = true;
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally {
  if (!last?.completed) {
    await json(join(directory, 'control.json'), { requestId: config.RequestId, stage: '', abort: '组合脚本已停止，请保留证据。' });
    const deadline = Date.now() + 4000;
    while (!last?.completed && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 250)); await report(); }
  }
  if (game.exitCode === null && last?.completed && !last.saveProcessing && !last.newDay) { const exited = once(game, 'exit'); game.kill(); await exited; }
  for (const client of relay.clients) client.terminate();
  for (const upstream of upstreams) upstream.terminate();
  await new Promise<void>(resolve => relay.close(() => resolve())); await server.close();
  await json(join(directory, 'packets.json'), packets);
  await json(join(directory, 'result.json'), { success, failure, protocol: PROTOCOL_VERSION, mode: 'native-social-combined', offline: config.Offline,
    requestId: config.RequestId, saveFolder: config.SaveFolder, modelCalls: calls.filter(call => call.real).length,
    realCalls: calls.filter(call => call.real).map(({ kind, usage, timing }) => ({ kind, usage, timing })),
    fixedCalls: calls.filter(call => !call.real).length, checks: (last?.socialChecks.length ?? 0) + (last?.newPartsChecks?.length ?? 0), errors, game: last });
}
console.log(JSON.stringify({ success, failure, directory, checks: (last?.socialChecks.length ?? 0) + (last?.newPartsChecks?.length ?? 0), seconds: last?.elapsedSeconds }));
if (!success) process.exitCode = 1;
