/** Unified native social acceptance with save/rollback, heart tiers and NPC news. Launch with test-game-social.ps1. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket, WebSocketServer } from 'ws';
import { BridgeServer } from '../src/bridge/server.ts';
import { parseModMessage, PROTOCOL_VERSION } from '../src/bridge/protocol.ts';
import { NIGHTLY_THINKING, nightlyConsolidator } from '../src/agent/nightly.ts';
import { ModelClient, modelConfigFromEnv, type ChatMessage, type Completion, type StreamHandlers, type Thinking } from '../src/services/model/client.ts';
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
  pointer: { CommitId: string } | null;
  replies: { label: string; line: string; nonce: string }[];
  newPartsChecks: Check[];
  newsChecks: Check[]; newsReports: number[];
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
const paidNightly = paid ? new ModelClient({ ...paid.config, thinking: NIGHTLY_THINKING }) : undefined;
const calls: { kind: string; real: boolean; thinking: Thinking | null; messages: ChatMessage[]; content: string; usage: Completion['usage']; timing: Completion['timing'] }[] = [];
let real = false;
let newParts = false;
let news = false;
let newsLive = false;
const PUBLIC_CAT = '我养的小猫叫星糖，你可以跟朋友们说。';
const SECRET = '这是秘密，别告诉别人：我其实很怕黑。';
const SHARE = '记忆验收养的小猫叫星糖。';
const HEARD = /阿比盖尔跟我说：["“][^\n]+星糖/;
function model(kind: 'dialogue' | 'scene' | 'nightly'): ModelClient {
  return { async chat(messages: ChatMessage[], handlers: StreamHandlers = {}, options = {}): Promise<Completion> {
    const last = messages.at(-1)?.content ?? '';
    const text = messages.map(message => message.content).join('\n');
    const actual = news ? newsLive && (kind === 'nightly' ? last.includes(PUBLIC_CAT) || last.includes(SECRET)
      : kind === 'scene' ? last.includes('## 想说的事') : last.startsWith(PUBLIC_CAT) || last.startsWith(SECRET) || HEARD.test(text))
      : real && kind !== 'nightly';
    let completion: Completion;
    const client = kind === 'scene' ? paidScene : kind === 'nightly' ? paidNightly : paid;
    if (actual) completion = await client!.chat(messages, handlers, options);
    else {
      const content = JSON.stringify(kind === 'scene' ? { lines: [
        { speaker: 'a', text: '今天天气真不错。', emote: 'happy' }, { speaker: 'b', text: '嗯，出去走走吧。', emote: 'music' },
        ...(news && last.includes('## 想说的事') ? [{ speaker: 'a', text: '记忆验收的小猫叫星糖。', emote: 'happy' }] : []),
      ], told: news && last.includes('## 想说的事') ? ['a'] : [] } : kind === 'nightly' ? {
        memories: [], retire: [], impression: '相处自然。', plan: '', bubbles: [], letter: '', gift: false,
        share: news && last.includes(PUBLIC_CAT) && last.includes('## 你是谁\n- 阿比盖尔') ? SHARE : '',
      } : {
        reply: news ? HEARD.test(text) ? '阿比盖尔跟我说，你的小猫叫星糖。' : '嗯，今天过得怎么样？'
          : newParts ? '这个给你，今天过得怎么样？' : '嗯，我记得那块紫水晶。', emotion: 'happy', options: ['再聊一会', '说说近况', '听听你的想法'],
        remember: [], mood: Number(/^好感(-?\d)/.exec(last)?.[1] ?? 2), give: newParts, end: false,
      });
      handlers.onContent?.(content);
      completion = { content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 0, totalMs: 0 } };
    }
    const call = { kind, real: actual, thinking: actual ? client!.config.thinking : null, messages, content: completion.content, usage: completion.usage, timing: completion.timing };
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
const replayedScenes = new Set<string>();
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
      if (packet.type === 'scene.shown') {
        const key = `${packet.loadNonce}/${packet.seq}`;
        if (!replayedScenes.has(key)) {
          replayedScenes.add(key);
          packets.push({ direction: 'mod', packet: packet as unknown as Record<string, unknown>, injected: 'same-scene-shown-replay' });
          if (upstream.readyState === WebSocket.OPEN) upstream.send(raw); else waiting.push(raw);
        }
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
  const deadline = Date.now() + 420000;
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
    if (last?.message === 'news-fixed-ready' && !news) {
      real = false; newParts = false; news = true;
      await json(join(directory, 'control.json'), { requestId: config.RequestId, stage: 'news-fixed-ready' });
    }
    if (last?.message === 'news-learn-ready') {
      newsLive = !config.Offline;
      await json(join(directory, 'control.json'), { requestId: config.RequestId, stage: 'news-learn-ready' });
    }
    if (last?.message === 'news-night-ready' && last.pointer) {
      const stateDb = new DatabaseSync(join(directory, 'memory/memory.sqlite'), { readOnly: true });
      try {
        const commit = stateDb.prepare('SELECT consolidation_fingerprint AS done FROM commit_node WHERE id=?').get(last.pointer.CommitId);
        if (commit?.done) {
          const rows = stateDb.prepare("SELECT npc_id, state FROM npc_state WHERE commit_id=? AND phase='consolidated'").all(last.pointer.CommitId);
          const state = (id: string) => JSON.parse(rows.find(row => row.npc_id === id)?.state as string ?? '{}') as { share?: string };
          assert.match(state('abigail').share ?? '', /星糖/, 'the public fact must get a real nightly share');
          assert.equal(state('harvey').share ?? '', '', 'a secret-only conversation must not become news');
          assert.ok(!rows.some(row => /怕黑/.test((JSON.parse(row.state as string) as { share?: string }).share ?? '')));
          await json(join(directory, 'news-night-states.json'), rows.map(row => ({ npc: row.npc_id, state: JSON.parse(row.state as string) })));
          await json(join(directory, 'control.json'), { requestId: config.RequestId, stage: 'news-night-ready' });
        }
      } finally { stateDb.close(); }
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
  assert.equal(mod.filter(packet => packet.type === 'save.loaded').length, config.NewParts ? 8 : 3);
  assert.equal(mod.filter(packet => packet.type === 'save.saved').length, config.NewParts ? 4 : 1);
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
  assert.ok(calls.filter(call => call.kind === 'scene').every(call => call.messages.every(message => !message.content.includes(note))),
    'private gifts stay out of NPC small talk unless deliberately selected as public news');
  if (config.NewParts) {
    const newsLabels = [...Array.from({ length: 11 }, (_, i) => [`heart-${i}-native-standing`, `heart-${i}-gain`, `heart-${i}-loss`]).flat(),
      'news-departed-listener-not-confirmed', 'news-confirmation-waits-for-dialogue-close',
      'news-confirmed-after-last-line-and-dialogue-close', 'news-listener-native-recall', 'news-secret-ordinary-scene-shown',
      'news-map-change-not-confirmed',
      'news-reload-scene-confirmed', 'news-second-listener-native-recall', 'news-saved-reload-native-recall', 'news-third-day-ordinary-scene-shown'];
    for (const label of newsLabels) assert.ok(last.newsChecks.some(check => check.label === label && check.passed), label);
    assert.ok(last.newsChecks.every(check => check.passed));
    const labelled = (label: string) => {
      const record = last!.replies.find(row => row.label === label);
      assert.ok(record, label);
      const packet = mod.find(row => row.type === 'talk.say' && row.text === record.line && row.loadNonce === record.nonce);
      assert.ok(packet, label);
      // Each matching player line is logged in model call order too, including the two copies across reload.
      return calls.filter(call => call.kind === 'dialogue' && call.messages.at(-1)?.content.startsWith(packet.text as string));
    };
    const questions = labelled('news-listener-before-rollback');
    assert.equal(questions.length, 4);
    assert.match(questions[0]!.messages[0]!.content, HEARD);
    assert.doesNotMatch(questions[1]!.messages[0]!.content, /阿比盖尔跟我说/, 'an unsaved heard memory must roll back');
    assert.match(questions[2]!.messages[0]!.content, HEARD);
    assert.match(questions[3]!.messages[0]!.content, HEARD, 'heard words must survive a real save and reload');
    const hearsDb = new DatabaseSync(join(directory, 'memory/memory.sqlite'), { readOnly: true });
    try {
      const heard = hearsDb.prepare("SELECT npc_id, text, kind, visibility FROM memory WHERE kind='heard'").all();
      assert.equal(heard.length, 1, 'replayed scene.shown and rollback must leave exactly one saved heard memory');
      assert.equal(heard[0]!.npc_id, 'sebastian'); assert.equal(heard[0]!.visibility, 'normal');
      assert.match(heard[0]!.text as string, HEARD);
    } finally { hearsDb.close(); }
    const scenes = calls.filter(call => call.kind === 'scene' && call.messages[1]!.content.includes('## 想说的事'));
    assert.equal(scenes.length, 4, 'public news is offered in two interrupted scenes and before/after rollback, never for the secret or on the third day');
    assert.ok(scenes.every(call => !call.messages[1]!.content.includes('怕黑')));
    for (const name of ['news-listener.png', 'news-scene.png']) assert.ok((await stat(join(directory, name))).size > 100);
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
  try { await writeFile(join(directory, 'smapi-log.txt'), await readFile(join(process.env.APPDATA!, 'StardewValley/ErrorLogs/SMAPI-latest.txt'))); }
  catch { /* Native reports and wire evidence remain authoritative when SMAPI has no local log. */ }
  for (const client of relay.clients) client.terminate();
  for (const upstream of upstreams) upstream.terminate();
  await new Promise<void>(resolve => relay.close(() => resolve())); await server.close();
  await json(join(directory, 'packets.json'), packets);
  await json(join(directory, 'result.json'), { success, failure, protocol: PROTOCOL_VERSION, mode: 'native-social-combined', offline: config.Offline,
    requestId: config.RequestId, saveFolder: config.SaveFolder, modelCalls: calls.filter(call => call.real).length,
    realCalls: calls.filter(call => call.real).map(({ kind, thinking, usage, timing }) => ({ kind, thinking, usage, timing })),
    fixedCalls: calls.filter(call => !call.real).length, checks: (last?.socialChecks.length ?? 0) + (last?.newPartsChecks?.length ?? 0) + (last?.newsChecks?.length ?? 0), errors, game: last });
}
console.log(JSON.stringify({ success, failure, directory, checks: (last?.socialChecks.length ?? 0) + (last?.newPartsChecks?.length ?? 0) + (last?.newsChecks?.length ?? 0), seconds: last?.elapsedSeconds }));
if (!success) process.exitCode = 1;
