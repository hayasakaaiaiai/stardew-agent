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
import { SCENE_THINKING } from '../src/agent/scene.ts';
import { ModelClient, modelConfigFromEnv, type ChatMessage, type Completion, type StreamHandlers, type Thinking } from '../src/services/model/client.ts';
import { ModelGateway } from '../src/services/model/gateway.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';
import { digest } from '../src/validation.ts';
import { socialContentProbes } from './social-content-probes.ts';
import { AMBIENT_RULES } from '../src/agent/ambient.ts';
import { ambientContentProbes } from './ambient-content-probes.ts';

interface Config {
  RequestId: string; UniqueId: string; SaveFolder: string; SaveDirectory: string;
  RunDirectory: string; GamePath: string; BackendUrl: string; Social: boolean; Offline: boolean; NewParts?: boolean; AmbientOnly?: boolean;
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
  townChecks: Check[]; townPackets: { seq: number; time: number; groups: string[][]; nonce: string; day: number }[]; townHours: number[];
  ambientChecks: Check[]; ambientShown: { npc: string; to: string; text: string; visible: string; tick: number; nonce: string }[];
  ambientPackets: { seq: number; time: number; npcs: { npc: string }[]; nonce: string }[];
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
const paidScene = paid ? new ModelClient({ ...paid.config, thinking: SCENE_THINKING }) : undefined;
const paidNightly = paid ? new ModelClient({ ...paid.config, thinking: NIGHTLY_THINKING }) : undefined;
const calls: { kind: string; real: boolean; thinking: Thinking | null; messages: ChatMessage[]; content: string; usage: Completion['usage']; timing: Completion['timing']; probe?: boolean }[] = [];
let real = false;
let newParts = false;
let news = false;
let newsLive = false;
let town = false;
let ambientLive = false;
let ambientMemory: unknown;
let newsSnapshot: Record<string, unknown>[] = [];
let townQuietCalls = 0;
const townGates = new Set<string>();
const TOWN_PUBLIC = '我给自己的蓝色风筝取名云尾，你可以跟朋友们说。';
const THANKS = '谢谢你上次帮我的忙。';
const STRING_LINE = '我答应周末给文森特做蓝色风筝。';
const STRING_SUMMARY = '记忆验收说周末会给文森特做蓝色风筝。';
const STRING_NOTE = `农场主说：${JSON.stringify(STRING_LINE)}`;
const HEARD_WIND = /(?:阿比盖尔跟我说|格斯跟我说，阿比盖尔说过)：["“][^\n]+云尾/;
const PUBLIC_CAT = '我养的小猫叫星糖，你可以跟朋友们说。';
const SECRET = '这是秘密，别告诉别人：我其实很怕黑。';
const SHARE = '记忆验收养的小猫叫星糖。';
const HEARD = /阿比盖尔跟我说：["“][^\n]+星糖/;
function model(kind: 'dialogue' | 'scene' | 'nightly'): ModelClient {
  return { async chat(messages: ChatMessage[], handlers: StreamHandlers = {}, options = {}): Promise<Completion> {
    const last = messages.at(-1)?.content ?? '';
    const text = messages.map(message => message.content).join('\n');
    const isAmbient = messages[0]?.content === AMBIENT_RULES;
    const actual = isAmbient ? ambientLive && !config.Offline : town ? !config.Offline && (kind === 'nightly' ? last.includes(TOWN_PUBLIC) || last.includes(THANKS)
      : kind === 'dialogue' && (last.startsWith(TOWN_PUBLIC) || last.startsWith(THANKS) || HEARD_WIND.test(messages[0]!.content)))
      : news ? newsLive && (kind === 'nightly' ? last.includes(PUBLIC_CAT) || last.includes(SECRET)
      : kind === 'scene' ? last.includes('## 想说的事') : last.startsWith(PUBLIC_CAT) || last.startsWith(SECRET) || HEARD.test(text))
      : real && kind !== 'nightly';
    let completion: Completion;
    const client = kind === 'scene' ? paidScene : kind === 'nightly' ? paidNightly : paid;
    if (actual) completion = await client!.chat(messages, handlers, options);
    else {
      const content = JSON.stringify(isAmbient ? { lines: ['a', 'b', 'c', 'd'].map((npc, index) => ({ npc,
        to: index === 0 ? 'farmer' : 'self', text: index === 0 ? '早上好，欢迎光临！' : '今天风很轻。', emote: index === 0 ? 'happy' : 'none' })) }
        : kind === 'scene' ? { lines: [
        { speaker: 'a', text: '今天天气真不错。', emote: 'happy' }, { speaker: 'b', text: '嗯，出去走走吧。', emote: 'music' },
        ...(news && last.includes('## 想说的事') ? [{ speaker: 'a', text: '记忆验收的小猫叫星糖。', emote: 'happy' }] : []),
      ], told: news && last.includes('## 想说的事') ? ['a'] : [] } : kind === 'nightly' ? {
        memories: [], retire: [], impression: '相处自然。', plan: '', bubbles: [], letter: '', gift: false,
        share: town ? last.includes(TOWN_PUBLIC) ? '记忆验收的蓝色风筝叫云尾。' : last.includes(THANKS) ? '记忆验收特地来谢我帮忙。' : ''
          : news && last.includes(PUBLIC_CAT) && last.includes('## 你是谁\n- 阿比盖尔') ? SHARE : '',
      } : {
        reply: town ? HEARD_WIND.test(messages[0]!.content) ? '格斯跟我说，你的蓝色风筝叫云尾。'
          : messages[0]!.content.includes(STRING_NOTE) ? '你答应给文森特做蓝色风筝。' : '我还没听说呢。'
          : news ? HEARD.test(text) ? '阿比盖尔跟我说，你的小猫叫星糖。' : '嗯，今天过得怎么样？'
          : newParts ? '这个给你，今天过得怎么样？' : '嗯，我记得那块紫水晶。', emotion: 'happy', options: ['再聊一会', '说说近况', '听听你的想法'],
        remember: town && last.startsWith(STRING_LINE) ? [STRING_SUMMARY, '再聊一会'] : [],
        mood: town ? 0 : Number(/^好感(-?\d)/.exec(last)?.[1] ?? 2), give: newParts, end: false,
      });
      handlers.onContent?.(content);
      completion = { content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 0, totalMs: 0 } };
    }
    const call = { kind: isAmbient ? 'ambient' : kind, real: actual, thinking: actual ? client!.config.thinking : null, messages, content: completion.content, usage: completion.usage, timing: completion.timing };
    calls.push(call); await appendFile(join(directory, 'model-calls.jsonl'), JSON.stringify(call) + '\n');
    return completion;
  } } as ModelClient;
}
const roster = new Roster({ directory: join(ROOT, 'data/npcs'), npcIds: SOCIAL_NPCS });
assert.equal((await roster.load()).errors.length, 0);
const gateway = new ModelGateway();
const server = await BridgeServer.start({ roster, model: gateway.lane('dialogue', model('dialogue')), sceneModel: gateway.lane('nearby', model('scene')), gateway,
  consolidator: nightlyConsolidator({ roster, model: gateway.lane('nightly', model('nightly')), log }), memoryDirectory: join(directory, 'memory'), port: 0, log });
const packets: { direction: string; packet: Record<string, unknown>; injected?: string }[] = [];
const errors: string[] = [];
const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(relay, 'listening');
config.BackendUrl = `ws://127.0.0.1:${(relay.address() as { port: number }).port}`;
await json(configPath, config);
let duplicateGift = false;
const replayedScenes = new Set<string>();
const replayedTown = new Set<string>();
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
      if (packet.type === 'town.hour') {
        const key = `${packet.loadNonce}/${packet.seq}`;
        if (!replayedTown.has(key)) {
          replayedTown.add(key);
          packets.push({ direction: 'mod', packet: packet as unknown as Record<string, unknown>, injected: 'same-town-hour-replay' });
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
    if (packet.type === 'ambient.lines') {
      client.send(raw); packets.push({ direction: 'backend', packet, injected: 'same-ambient-reply-replay' });
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
  const deadline = Date.now() + 900000;
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
    if (last?.message === 'town-fixed-ready' && !town) {
      const db = new DatabaseSync(join(directory, 'memory/memory.sqlite'), { readOnly: true });
      try { newsSnapshot = db.prepare("SELECT npc_id, text, kind, visibility FROM memory WHERE kind='heard'").all(); }
      finally { db.close(); }
      await json(join(directory, 'news-before-town.json'), newsSnapshot);
      town = true; newsLive = false;
      await json(join(directory, 'control.json'), { requestId: config.RequestId, stage: 'town-fixed-ready' });
    }
    if (last?.message === 'town-night-ready' && last.pointer && !townGates.has(last.message)) {
      const db = new DatabaseSync(join(directory, 'memory/memory.sqlite'), { readOnly: true });
      try {
        const commit = db.prepare('SELECT consolidation_fingerprint AS done FROM commit_node WHERE id=?').get(last.pointer.CommitId);
        if (commit?.done) {
          const rows = db.prepare("SELECT npc_id, state FROM npc_state WHERE commit_id=? AND phase='consolidated'").all(last.pointer.CommitId);
          const state = (id: string) => JSON.parse(rows.find(row => row.npc_id === id)?.state as string ?? '{}') as { share?: string };
          assert.match(state('abigail').share ?? '', /云尾/);
          assert.equal(state('harvey').share ?? '', '', 'thanks alone are not news');
          const note = db.prepare('SELECT importance FROM memory WHERE npc_id=? AND text=?').get('jodi', STRING_NOTE);
          assert.equal(note?.importance, 3, 'a string memory must persist at importance 3');
          assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory WHERE text=?').get('再聊一会')!.n, 0, 'unchosen string option is discarded');
          await json(join(directory, 'town-night-states.json'), rows.map(row => ({ npc: row.npc_id, state: JSON.parse(row.state as string) })));
          townQuietCalls = calls.length;
          townGates.add(last.message);
          await json(join(directory, 'control.json'), { requestId: config.RequestId, stage: last.message });
        }
      } finally { db.close(); }
    }
    if (last?.message === 'town-spread-ready' && !townGates.has(last.message)) {
      assert.ok(calls.slice(townQuietCalls).every(call => !call.real), 'offscreen propagation makes no paid model calls');
      assert.deepEqual(calls.slice(townQuietCalls).map(call => call.kind), ['dialogue', 'dialogue', 'dialogue'],
        'only the intentional Jodi open/question and Maru open call the model; the four hours add none');
      const scratch = join(directory, 'memory/scratch');
      const files = (await readdir(scratch, { recursive: true })).filter(file => file.endsWith('.jsonl'));
      const entries = (await Promise.all(files.map(file => readFile(join(scratch, file), 'utf8'))))
        .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line) as { changes?: { npcId: string; log?: { heard?: { origin: string; from: string; share: string; hand: number }[] } }[] }));
      const transfers = entries.flatMap(entry => (entry.changes ?? []).flatMap(change => (change.log?.heard ?? [])
        .filter(item => item.share.includes('云尾')).map(item => ({ listener: change.npcId, ...item }))));
      assert.deepEqual(transfers.map(item => [item.listener, item.from, item.hand]).sort(),
        [['gus', 'abigail', 1], ['leah', 'abigail', 1], ['pam', 'gus', 2], ['sam', 'gus', 2]],
        'no third hand, no invisible or out-of-range listener, and the superseded Jodi hour writes nothing');
      await json(join(directory, 'town-unsaved-transfers.json'), transfers);
      await json(join(directory, 'town-spread-packets.json'), packets.filter(row => row.packet.type === 'town.hour'));
      townGates.add(last.message);
      await json(join(directory, 'control.json'), { requestId: config.RequestId, stage: last.message });
    }
    if (last?.message === 'town-final-ready' && !townGates.has(last.message)) {
      if (!config.Offline) {
        const samples = await socialContentProbes(roster, async (kind, messages) => {
          const client = kind === 'dialogue' ? paid! : paidScene!;
          const completion = await client.chat(messages, {}, { json: true });
          const call = { kind, real: true, probe: true, thinking: client.config.thinking, messages,
            content: completion.content, usage: completion.usage, timing: completion.timing };
          calls.push(call); await appendFile(join(directory, 'model-calls.jsonl'), JSON.stringify({ ...call, probe: true }) + '\n');
          return completion;
        });
        await json(join(directory, 'content-probes.json'), samples);
        log(`额外内容样本：${samples.length} 次，格式有效 ${samples.filter(sample => sample.valid).length}；语义保留原文复核。`);
      }
      townGates.add(last.message);
      await json(join(directory, 'control.json'), { requestId: config.RequestId, stage: last.message });
    }
    if (last?.message === 'ambient-fixed-ready' && !townGates.has(last.message)) {
      const db = new DatabaseSync(join(directory, 'memory/memory.sqlite'), { readOnly: true });
      try { ambientMemory = db.prepare('SELECT * FROM memory ORDER BY id').all(); } finally { db.close(); }
      await json(join(directory, 'ambient-memory-before.json'), ambientMemory);
      townGates.add(last.message);
      await json(join(directory, 'control.json'), { requestId: config.RequestId, stage: last.message });
    }
    if (last?.message === 'ambient-live-ready' && !ambientLive) {
      ambientLive = true;
      await json(join(directory, 'control.json'), { requestId: config.RequestId, stage: last.message });
    }
    if (last?.message.startsWith('ambient-late-ready-') && !townGates.has(last.message)
      && packets.some(row => row.direction === 'backend' && row.packet.type === 'ambient.lines'
        && row.packet.seq === last!.ambientPackets.at(-1)?.seq && row.packet.loadNonce === last!.nonce)) {
      townGates.add(last.message);
      await json(join(directory, 'control.json'), { requestId: config.RequestId, stage: last.message });
    }
    if (last?.message === 'ambient-content-ready' && !townGates.has(last.message)
      && packets.some(row => row.direction === 'backend' && row.packet.type === 'ambient.lines'
        && row.packet.seq === last!.ambientPackets.at(-1)?.seq && row.packet.loadNonce === last!.nonce)) {
      if (!config.Offline) {
        const samples = await ambientContentProbes(roster, async (kind, messages) => {
          const client = kind === 'dialogue' ? paid! : paidScene!;
          const completion = await client.chat(messages, {}, { json: true });
          const call = { kind, real: true, probe: true, thinking: client.config.thinking, messages,
            content: completion.content, usage: completion.usage, timing: completion.timing };
          calls.push(call); await appendFile(join(directory, 'model-calls.jsonl'), JSON.stringify(call) + '\n');
          return completion;
        });
        await json(join(directory, 'ambient-content-probes.json'), samples);
        log(`新功能内容样本：${samples.length} 次，格式有效 ${samples.filter(sample => sample.valid).length}；保留原文复核。`);
      }
      const db = new DatabaseSync(join(directory, 'memory/memory.sqlite'), { readOnly: true });
      try {
        const after = db.prepare('SELECT * FROM memory ORDER BY id').all();
        assert.deepEqual(after, ambientMemory, 'ambient lines must never create, retire or modify memories');
        await json(join(directory, 'ambient-memory-after.json'), after);
      } finally { db.close(); }
      townGates.add(last.message);
      await json(join(directory, 'control.json'), { requestId: config.RequestId, stage: last.message });
    }
    if (last?.completed) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(last?.completed, `组合检查超时：${last?.stage ?? '未加载'}`);
  assert.ok(last.success, last.message);
  assert.deepEqual(errors, []);
  if (!config.AmbientOnly) {
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
  const disabledGifts = mod.filter(packet => packet.type === 'talk.open' && packet.inPersonGifts === false);
  assert.ok(disabledGifts.length > 0);
  for (const open of disabledGifts) {
    const reply = packets.find(row => row.direction === 'backend' && row.packet.type === 'talk.reply'
      && row.packet.seq === open.seq && row.packet.loadNonce === open.loadNonce);
    assert.ok(reply, 'a disabled-gift opening must still receive its normal reply');
    assert.equal(reply.packet.gift, undefined, 'the disabled native setting must prevent a backend gift offer');
  }
  const gifts = mod.filter(packet => packet.type === 'gift.given');
  assert.equal(gifts.length, 2); assert.equal(gifts[0]!.taste, 'love'); assert.equal(gifts[0]!.item, '紫水晶'); assert.equal(gifts[1]!.item, '粘土');
  assert.equal(mod.filter(packet => packet.type === 'save.loaded').length, config.NewParts ? 11 : 3);
  assert.equal(mod.filter(packet => packet.type === 'save.saved').length, config.NewParts ? 6 : 1);
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
    {
      const heard = newsSnapshot;
      assert.equal(heard.length, 1, 'replayed scene.shown and rollback must leave exactly one saved heard memory');
      assert.equal(heard[0]!.npc_id, 'sebastian'); assert.equal(heard[0]!.visibility, 'normal');
      assert.match(heard[0]!.text as string, HEARD);
    }
    const scenes = calls.filter(call => call.kind === 'scene' && !call.probe && call.messages[1]!.content.includes('## 想说的事'));
    assert.equal(scenes.length, 4, 'public news is offered in two interrupted scenes and before/after rollback, never for the secret or on the third day');
    assert.ok(scenes.every(call => !call.messages[1]!.content.includes('怕黑')));
    for (const name of ['news-listener.png', 'news-scene.png']) assert.ok((await stat(join(directory, name))).size > 100);
    const townLabels = ['town-zero-heart-native-recall', 'town-disabled', 'town-indoor-far-apart-native-event',
      'town-outdoor-six-tiles-transitive-group', 'town-third-hand-hour-acknowledged', 'town-player-location-excluded',
      'town-defers-during-native-talk', 'town-newest-pending-hour-replaces-older', 'town-sends-after-dialogue-close',
      'town-second-hand-native-recall', 'town-reload-clears-pending', 'town-rollback-allows-news-again',
      'town-new-day-clears-pending', 'town-second-hand-save-reload-native-recall', 'town-expired-hour-acknowledged'];
    for (const label of townLabels) assert.ok(last.townChecks.some(check => check.label === label && check.passed), label);
    assert.ok(last.townChecks.every(check => check.passed));
    const hours = mod.filter(packet => packet.type === 'town.hour');
    assert.equal(hours.length, 7, 'four unsaved hours, two repeated after rollback, and one expired hour');
    assert.equal(last.townPackets.length, hours.length, 'every native town send reaches the relay exactly once');
    const groups = (index: number) => hours[index]!.groups as string[][];
    assert.deepEqual(groups(0), [['Abigail', 'Gus']]);
    assert.deepEqual(groups(1), [['Gus', 'Pam', 'Sam']], 'six-tile links join transitively; invisible and seven-tile NPCs are absent');
    assert.deepEqual(groups(2), [['Pam', 'Leah']]);
    assert.deepEqual(groups(3), [['Abigail', 'Leah']], 'the latest pending hour replaces the earlier Jodi group');
    for (const [index, hour] of hours.entries()) {
      const names = [...new Set((hour.groups as string[][]).flat())].sort();
      assert.equal((hour.places as string[]).length, (hour.groups as string[][]).length, 'every group names its place (docs/scheduler.md §4.1)');
      assert.ok((hour.places as string[]).every(place => place.length > 0), 'places are the game\'s display names');
      if (index === hours.length - 1) {
        assert.ok(!('hearts' in hour) && !('weather' in hour), 'BackstageScenes off sends no hearts, so no backstage scene');
        continue;
      }
      assert.deepEqual(Object.keys(hour.hearts as Record<string, number>).sort(), names, 'backstage hearts for exactly the NPCs in the groups');
      assert.ok(Object.values(hour.hearts as Record<string, number>).every(value => Number.isInteger(value) && value >= 0 && value <= 14));
      assert.ok(['sunny', 'rain', 'storm', 'snow', 'windy'].includes(hour.weather as string));
    }
    const windQuestions = calls.filter(call => call.kind === 'dialogue' && call.messages.at(-1)?.content.startsWith('最近有人告诉你我给蓝色风筝'));
    assert.equal(windQuestions.length, 3);
    assert.match(windQuestions[0]!.messages[0]!.content, HEARD_WIND);
    assert.doesNotMatch(windQuestions[1]!.messages[0]!.content, HEARD_WIND, 'unsaved offscreen news rolls back');
    assert.match(windQuestions[2]!.messages[0]!.content, HEARD_WIND, 'second-hand news survives save and reload');
    const zero = calls.find(call => call.kind === 'dialogue' && call.messages.at(-1)?.content.startsWith('你还记得我答应文森特'));
    assert.ok(zero?.messages[0]!.content.includes(STRING_NOTE));
    assert.ok(mod.some(packet => packet.type === 'talk.open' && packet.npc === 'Jodi' && packet.hearts === 0));
    const finalDb = new DatabaseSync(join(directory, 'memory/memory.sqlite'), { readOnly: true });
    try {
      const wind = finalDb.prepare("SELECT npc_id, text, importance, visibility FROM memory WHERE kind='heard' AND text LIKE '%云尾%'").all();
      assert.equal(wind.length, 2, 'rollback and duplicate town.hour leave one first-hand and one second-hand memory');
      assert.deepEqual(wind.map(row => [row.npc_id, row.importance]).sort(), [['gus', 3], ['pam', 2]]);
      assert.ok(wind.every(row => row.visibility === 'normal'));
      assert.equal(finalDb.prepare("SELECT COUNT(*) AS n FROM memory WHERE npc_id='pam' AND text LIKE '我当面送了农场主%'").get()!.n, 0,
        'the disabled gift setting must not create Pam’s phantom gift memory');
      await json(join(directory, 'town-saved-memories.json'), wind);
    } finally { finalDb.close(); }
    assert.ok((await stat(join(directory, 'town-listener-pam.png'))).size > 100);
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
  }
  assert.ok(last.ambientChecks.length >= 30 && last.ambientChecks.every(check => check.passed), 'all native ambient checks must pass');
  assert.ok(last.ambientShown.every(line => line.text === line.visible), 'native ambient text must match its delivered line');
  const greeters = last.ambientShown.filter(line => line.to === 'farmer').map(line => `${line.nonce}/${line.npc}`);
  assert.equal(new Set(greeters).size, greeters.length, 'no NPC may actually greet twice in one native load, even after replayed replies');
  const ambientRequests = packets.filter(row => row.direction === 'mod' && row.packet.type === 'ambient.request');
  assert.equal(ambientRequests.length, last.ambientPackets.length);
  assert.deepEqual(last.ambientPackets[0]!.npcs.map(person => person.npc), ['Pierre', 'Caroline', 'Abigail', 'Gus']);
  assert.deepEqual(last.ambientPackets[1]!.npcs.map(person => person.npc), ['Pam']);
  assert.ok((await stat(join(directory, 'ambient-fixed.png'))).size > 100);
  if (!config.Offline) assert.ok((await stat(join(directory, 'ambient-real.png'))).size > 100);
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
    fixedCalls: calls.filter(call => !call.real).length, checks: (last?.socialChecks.length ?? 0) + (last?.newPartsChecks?.length ?? 0) + (last?.newsChecks?.length ?? 0) + (last?.townChecks?.length ?? 0) + (last?.ambientChecks?.length ?? 0), errors, game: last });
}
console.log(JSON.stringify({ success, failure, directory, checks: (last?.socialChecks.length ?? 0) + (last?.newPartsChecks?.length ?? 0) + (last?.newsChecks?.length ?? 0) + (last?.townChecks?.length ?? 0) + (last?.ambientChecks?.length ?? 0), seconds: last?.elapsedSeconds }));
if (!success) process.exitCode = 1;
