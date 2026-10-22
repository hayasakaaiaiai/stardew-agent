/** Native disposable-save acceptance for festivals, backstage scenes, schedules and NPC actions. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket, WebSocketServer } from 'ws';
import { BridgeServer } from '../src/bridge/server.ts';
import { parseModMessage, PROTOCOL_VERSION } from '../src/bridge/protocol.ts';
import { BACKSTAGE_THINKING } from '../src/agent/backstage.ts';
import { nightlyConsolidator } from '../src/agent/nightly.ts';
import { nextStop, type ScheduleStop } from '../src/agent/schedule.ts';
import { ModelClient, modelConfigFromEnv, type ChatModel, type ChatMessage, type ChatOptions, type Completion, type StreamHandlers } from '../src/services/model/client.ts';
import { ModelGateway } from '../src/services/model/gateway.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';
import { digest } from '../src/validation.ts';
import { runActions, runActionEdges, runActionTiming, runActionRender, runActionQueue, runActionPlaces, runActionIncoming, type ActionState } from './game-actions.ts';
import { runFarmChores, runFarmVisits, runFarmSave, type FarmState } from './game-farm-help.ts';
import { runMineCore, runMineRescue, runMineEdges, runMineWorlds, runMineSave, type MineState } from './game-mine-companion.ts';
import { runSameDay, runSameDayEdges } from './game-same-day-meetings.ts';
import { runCallOff, runArrivalProbe } from './game-call-off.ts';
import { runFarmAnimals } from './game-farm-animals.ts';
import { runMeetingFriendship, runFriendshipBoundaries, runSpouseFriendship } from './game-meeting-friendship.ts';
import { runLaterMeetings } from './game-later-meetings.ts';

interface Config { RequestId: string; UniqueId: string; SaveFolder: string; SaveDirectory: string; RunDirectory: string; GamePath: string; BackendUrl: string; World: boolean; Offline: boolean; Section: string }
interface Npc { id: string; name: string; location: string; x: number; y: number; ignoreScheduleToday: boolean; controller: boolean; temporary: boolean; queued: number; destroys: boolean; schedule: ScheduleStop[] | null }
export interface State { ready: boolean; canChat: boolean; time: number; nonce: string; generation: number; location: string; weather: string; npcs: Npc[] | null; actions?: ActionState; farm?: FarmState; mine?: MineState; player?: { x: number; y: number; facing: number } | null;
  festival: { id: string; isFestival: boolean; actors: string[]; schedules: Record<string, unknown>; dance: string | null; soup: number | null; grangeScore: number; giver: string | null } | null;
  native: Record<string, unknown> | null; reply: { npc: string; text: string } | null; minigame: string | null }
interface Command { id: number; operation: string; completed: boolean; success: boolean; error?: string; state: State }
interface Report { requestId: string; completed: boolean; success: boolean; message: string; elapsedSeconds: number; saveProcessing: boolean; newDay: boolean;
  worldCommand: Command | null; events: { name: string }[]; nonce: string; generation: number; day: number }
type Kind = 'dialogue' | 'nearby' | 'nightly' | 'background';
const ROOT = resolve(import.meta.dirname, '..');
const configPath = resolve(process.argv[2]!);
const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')) as Config;
assert.equal(config.World, true); assert.equal(config.SaveFolder, `MemoryTest_${config.UniqueId}`); assert.notEqual(config.UniqueId, '436774213');
assert.ok(['all', 'schedules', 'backstage', 'festivals', 'content', 'fair-return', 'actions', 'actions-edge', 'actions-timing', 'actions-checks', 'actions-places', 'actions-incoming', 'farm-help', 'farm-chores', 'farm-visits', 'farm-save', 'mine', 'mine-core', 'mine-rescue', 'mine-edges', 'mine-worlds', 'mine-dungeons', 'mine-save', 'same-day', 'same-day-core', 'same-day-edges', 'call-off', 'call-off-arrival', 'call-off-arrival-save', 'farm-animals', 'meeting-spouses', 'meeting-friendship', 'later-meetings', 'friendship-boundaries'].includes(config.Section), 'Unknown native world test section.');
assert.equal(resolve(config.SaveDirectory), resolve(process.env.APPDATA!, 'StardewValley/Saves', config.SaveFolder));
assert.ok(resolve(config.RunDirectory).startsWith(resolve(ROOT, '.runtime') + '\\'));
const directory = config.RunDirectory;
await mkdir(join(directory, 'sources'));
for (const file of ['tools/test-game-world.ts', 'tools/game-actions.ts', 'tools/game-farm-help.ts', 'tools/game-mine-companion.ts', 'tools/game-same-day-meetings.ts', 'tools/game-call-off.ts', 'tools/game-farm-animals.ts', 'tools/game-meeting-friendship.ts', 'tools/game-later-meetings.ts', 'mod/StardewAgentBridge/AnimalTest.cs', 'mod/StardewAgentBridge/MineCompanion.cs', 'mod/StardewAgentBridge/MineTest.cs', 'mod/StardewAgentBridge/FarmHelp.cs', 'mod/StardewAgentBridge/FarmVisits.cs', 'mod/StardewAgentBridge/FarmTest.cs', 'tools/prepare-world-fixture.ps1', 'src/agent/schedule.ts', 'src/agent/dialogue.ts', 'src/agent/dialogue-facts.ts',
  'src/agent/approach.ts', 'src/agent/meetings.ts', 'src/agent/meeting-agreement.ts', 'src/agent/nightly.ts', 'mod/StardewAgentBridge/ActionTest.cs', 'mod/StardewAgentBridge/Approach.cs', 'mod/StardewAgentBridge/Meetings.cs',
  'mod/StardewAgentBridge/SaveSync.cs', 'mod/StardewAgentBridge/ModEntry.cs', 'mod/StardewAgentBridge/Friendship.cs',
  'src/bridge/server.ts', 'src/bridge/protocol.ts', 'src/bridge/memory.ts', 'mod/StardewAgentBridge/ModConfig.cs', 'mod/StardewAgentBridge/GameState.cs',
  'mod/StardewAgentBridge/WorldTest.cs', 'mod/StardewAgentBridge/MemoryTest.cs', 'mod/StardewAgentBridge/Festivals.cs'])
  await copyFile(join(ROOT, file), join(directory, 'sources', file.split('/').at(-1)!));
const json = async (file: string, value: unknown) => {
  await writeFile(file + '.tmp', JSON.stringify(value, null, 2));
  for (let attempt = 0; ; attempt++) {
    try { await rename(file + '.tmp', file); return; }
    catch (error) {
      if (attempt >= 7 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
};
const checks: { label: string; passed: boolean; detail?: unknown; scope: 'technical' | 'content' }[] = [];
function check(label: string, passed: unknown, detail?: unknown) {
  checks.push({ label, passed: !!passed, detail, scope: 'technical' });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}`);
  assert.ok(passed, `${label}: ${JSON.stringify(detail)}`);
}
function contentCheck(label: string, passed: boolean, detail: unknown) {
  checks.push({ label, passed, detail, scope: 'content' });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label} (content; remaining native checks continue)`);
}
const logs: string[] = [], errors: string[] = [];
const log = (line: string) => { logs.push(line); console.log(line); void appendFile(join(directory, 'backend.log'), line + '\n'); };
if (!config.Offline) process.loadEnvFile(join(ROOT, '.env'));
const paid = config.Offline ? undefined : new ModelClient(modelConfigFromEnv());
const paidBackstage = paid ? new ModelClient({ ...paid.config, thinking: BACKSTAGE_THINKING }) : undefined;
const calls: { kind: Kind; real: boolean; messages: ChatMessage[]; content: string; usage: Completion['usage']; timing: Completion['timing']; thinking: string | null }[] = [];
const starts: { kind: Kind; time: number; held: boolean }[] = [];
const reports: { day: number; usage: ReturnType<ModelGateway['usage']>; line: string }[] = [];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
let heldBackstage: ReturnType<typeof deferred> | undefined;
let actionSeedNight = false;
let actionSeedFarm = false;
let actionSeedMine = '';
let actionTodayReply = '';
let actionTodayMood = 0;
const seedNight = (enabled: boolean, farm = false, mine = '') => { actionSeedNight = enabled; actionSeedFarm = farm; actionSeedMine = mine; };
const fixed = (content: unknown): Completion => ({ content: JSON.stringify(content), reasoning: '', finishReason: 'stop',
  usage: { inputTokens: 120, cachedInputTokens: 60, outputTokens: 20, reasoningTokens: null }, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } });
function model(kind: Kind): ChatModel {
  return { async chat(messages: ChatMessage[], handlers: StreamHandlers = {}, options: ChatOptions = {}) {
    starts.push({ kind, time: Date.now(), held: !!heldBackstage });
    if (kind === 'background') await heldBackstage?.promise;
    const real = !config.Offline && (kind === 'dialogue' || kind === 'background') && !actionSeedNight;
    let result: Completion;
    if (real) result = await (kind === 'background' ? paidBackstage! : paid!).chat(messages, handlers, options);
    else {
      const text = messages.map(message => message.content).join('\n');
      const schedule = /今日行程[^\n]*?）：([^\n]+)/.exec(text)?.[1] ?? '';
      const remembered = /- （(?:今天|昨天|\d+ 天前)）([^\n]+)/.exec(text)?.[1] ?? '';
      result = fixed(kind === 'background' ? { memories: { a: '格斯说汤的味道不错。', b: '潘姆说巴士站的风很大。', c: '我们聊了餐吧的天气。' } }
        : kind === 'nightly' ? { memories: actionSeedNight ? [{ sources: ['t2', 't3'], importance: 4 }] : [], retire: [], impression: '',
          plan: actionSeedNight ? actionSeedMine ? `想问农场主上午一起去${actionSeedMine}的事` : actionSeedFarm ? '想问农场主上午来农场帮忙的事' : '想问农场主下午在海滩见面的事' : '', seek: actionSeedNight,
          meet: actionSeedNight ? { time: actionSeedFarm || actionSeedMine ? '09:00' : '14:00', place: actionSeedMine || (actionSeedFarm ? '农场' : '海滩'), sources: ['t2', 't3'] } : null, bubbles: [], letter: '', gift: false, share: '' }
        : kind === 'nearby' ? { lines: [] }
        : { reply: actionTodayReply || (actionSeedNight && actionSeedMine ? `好啊，明天上午一起探险，${actionSeedMine}门口见。`
          : actionSeedNight && actionSeedFarm ? '好啊，明天上午我来农场帮你浇水。'
          : actionSeedNight && messages.at(-1)!.content.includes('明天下午') ? '好啊，那就明天下午14:00在海滩见。'
          : remembered || (schedule ? `我的安排是：${schedule}` : '我还没有确定安排。')), emotion: 'neutral', options: ['继续聊', '换个话题', '再见'], remember: [], mood: actionTodayMood, end: false });
      handlers.onContent?.(result.content);
    }
    const call = { kind, real, messages, content: result.content, usage: result.usage, timing: result.timing, thinking: real ? (kind === 'background' ? paidBackstage! : paid!).config.thinking : null };
    calls.push(call); await appendFile(join(directory, 'model-calls.jsonl'), JSON.stringify(call) + '\n');
    return result;
  } };
}
const roster = new Roster({ directory: join(ROOT, 'data/npcs'), npcIds: SOCIAL_NPCS }); assert.equal((await roster.load()).errors.length, 0);
const gateway = new ModelGateway();
const ordinaryReport = gateway.report.bind(gateway);
gateway.report = day => { const usage = gateway.usage(), line = ordinaryReport(day); reports.push({ day, usage, line }); return line; };
const options = { roster, model: gateway.lane('dialogue', model('dialogue')), sceneModel: gateway.lane('nearby', model('nearby')),
  backstageModel: gateway.lane('background', model('background')), gateway,
  consolidator: nightlyConsolidator({ roster, model: gateway.lane('nightly', model('nightly')), log }), memoryDirectory: join(directory, 'memory'), port: 0, log };
let server = await BridgeServer.start(options);
const packets: { direction: 'mod' | 'backend'; packet: Record<string, unknown>; injected?: string }[] = [];
const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(relay, 'listening');
const upstreams = new Set<WebSocket>();
let dropNextHourAck = false;
let hourAckToDrop: { seq: number; nonce: string } | undefined;
relay.on('connection', client => {
  const upstream = new WebSocket(`ws://127.0.0.1:${server.port}`); upstreams.add(upstream);
  const waiting: string[] = [];
  const forward = (raw: string) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(raw); else waiting.push(raw); };
  upstream.on('open', () => { for (const raw of waiting) upstream.send(raw); });
  client.on('message', data => {
    const raw = data.toString();
    try {
      const parsed = parseModMessage(raw), packet = parsed as unknown as Record<string, unknown>;
      packets.push({ direction: 'mod', packet });
      if (parsed.type === 'town.hour' && dropNextHourAck) { dropNextHourAck = false; hourAckToDrop = { seq: parsed.seq, nonce: parsed.loadNonce }; }
      forward(raw);
      if (parsed.type === 'festival.ended' || parsed.type === 'meet.ended') {
        packets.push({ direction: 'mod', packet, injected: 'replay-identical-' + parsed.type }); forward(raw);
      }
    } catch (error) { errors.push(String(error)); }
  });
  upstream.on('message', data => {
    const raw = data.toString(), packet = JSON.parse(raw) as Record<string, unknown>;
    packets.push({ direction: 'backend', packet });
    if (packet.type === 'sync.error' || packet.type === 'talk.error') errors.push(JSON.stringify(packet));
    if (hourAckToDrop && packet.type === 'ack' && packet.seq === hourAckToDrop.seq && packet.loadNonce === hourAckToDrop.nonce) {
      packets.push({ direction: 'backend', packet, injected: 'drop-ack-and-disconnect' }); hourAckToDrop = undefined;
      client.terminate(); return;
    }
    if (client.readyState === WebSocket.OPEN) client.send(raw);
  });
  upstream.on('error', error => { if (!String(error).includes('ECONNREFUSED')) errors.push(String(error)); });
  upstream.on('close', () => { upstreams.delete(upstream); if (client.readyState === WebSocket.OPEN) client.terminate(); });
  client.on('close', () => upstream.close());
});
config.BackendUrl = `ws://127.0.0.1:${(relay.address() as { port: number }).port}`; await json(configPath, config);
async function fixture(season: string, day: number, rain = false, year = 1) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'tools/prepare-world-fixture.ps1'), '-ConfigPath', configPath,
    '-Season', season, '-Day', String(day), '-Year', String(year), ...(rain ? ['-Rain'] : [])];
  const child = spawn('powershell.exe', args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
  const [code] = await once(child, 'exit'); assert.equal(code, 0, output);
  console.log(output.trim());
}
await fixture('spring', 1);
const gameEnv: NodeJS.ProcessEnv = { ...process.env, STARDEW_AGENT_TEST_MEMORY: configPath }; delete gameEnv.STARDEW_AGENT_TEST_ABIGAIL;
const game = spawn(join(config.GamePath, 'StardewModdingAPI.exe'), ['--mods-path', join(directory, 'mods')], { cwd: config.GamePath, env: gameEnv, windowsHide: true, stdio: 'ignore' });
game.on('error', error => errors.push(String(error)));
let last: Report | undefined, success = false, technicalSuccess = false, failure: string | undefined, commandId = 0;
async function report() {
  try { const value = JSON.parse(await readFile(join(directory, 'game-result.json'), 'utf8')) as Report; if (value.requestId === config.RequestId) last = value; }
  catch { /* Atomic report replacement or game startup. */ }
}
async function wait(ready: () => boolean, label: string, ms = 180000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (game.exitCode !== null) throw new Error(`Game exited during ${label}: ${game.exitCode}`);
    await report();
    if (last?.completed && !last.success) throw new Error(last.message);
    if (ready()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${label}; ${last?.message}; ${JSON.stringify(last?.worldCommand)}`);
}
async function rpc(operation: string, args: Record<string, unknown> = {}): Promise<State> {
  const id = ++commandId;
  await json(join(directory, 'control.json'), { requestId: config.RequestId, world: { id, operation, args } });
  await wait(() => !!(last?.worldCommand?.id === id && last.worldCommand.completed) || operation === 'finish' && last?.completed === true, operation);
  if (operation === 'finish') return last!.worldCommand!.state;
  const result = last!.worldCommand!;
  await appendFile(join(directory, 'commands.jsonl'), JSON.stringify({ id, operation, args, result }) + '\n');
  assert.equal(result.success, true, `${operation}: ${result.error}`);
  return result.state;
}
async function chapter(season: string, day: number, rain = false, year = 1) {
  await rpc('title'); await fixture(season, day, rain, year); const state = await rpc('load');
  check(`load-${season}${day}-${year}-${rain ? 'rain' : 'sun'}`, state.ready && state.canChat, state);
  return state;
}
const modPackets = (type: string, from = 0) => packets.slice(from).filter(row => row.direction === 'mod' && !row.injected && row.packet.type === type).map(row => row.packet);
const latestDialogue = () => calls.findLast(call => call.kind === 'dialogue')!;
async function meetingEntries() {
  const journal = join(directory, 'memory/scratch', digest(config.UniqueId), digest(last!.nonce) + '.jsonl');
  const rows = (await readFile(journal, 'utf8')).trim().split('\n').slice(1)
    .map(line => JSON.parse(line) as { changes: { log?: { meeting?: unknown } }[] });
  return rows.filter(row => row.changes.some(change => change.log?.meeting)).length;
}
async function say(npc: string, text: string, label: string) {
  await rpc('talk-open', { npc }); const state = await rpc('talk-say', { text, label });
  check(label + '-native-reply', !!state.reply?.text, state.reply);
  return state;
}
async function close() { await rpc('talk-close'); }
const bgStarts = () => starts.filter(start => start.kind === 'background').length;
const bgWrites = () => logs.filter(line => /^后台场景：.+记下了：/.test(line));
const counts = () => { const db = new DatabaseSync(join(directory, 'memory/memory.sqlite'), { readOnly: true }); try { return db.prepare('SELECT npc_id,text,topics FROM memory').all(); } finally { db.close(); } };
async function stagePair(first: string, second: string, map = 'Saloon') {
  await rpc('place', { npc: first, map, x: 5, y: 5, hearts: 6 }); await rpc('place', { npc: second, map, x: 6, y: 5, hearts: 6 });
}
async function schedules() {
  let state = await rpc('snapshot');
  const harvey = state.npcs!.find(npc => npc.id === 'Harvey')!;
  const route = harvey.schedule?.find(stop => !stop.sleep && stop.place.includes('诊所'));
  if (route) {
    for (const earlier of harvey.schedule!.filter(stop => stop.time < route.time)) await rpc('route', { npc: 'Harvey', time: earlier.time });
    state = await rpc('route', { npc: 'Harvey', time: route.time });
    const arrived = state.npcs!.find(npc => npc.id === 'Harvey')!;
    check('schedule-native-route-arrival', arrived.location === state.native?.target && !arrived.controller, { route, arrived });
    await rpc('warp', { map: arrived.location, x: 8, y: 8 });
    await rpc('capture', { name: 'schedule-route.png' });
  } else check('schedule-harvey-has-clinic-route', false, harvey);
  const records: Record<string, ScheduleStop[] | null>[] = [];
  for (const rain of [false, true]) {
    if (rain) await chapter('spring', 1, true);
    state = await rpc('clock', { time: 1400 });
    check('schedule-weather-' + rain, state.weather === (rain ? 'rain' : 'sunny'), state.weather);
    const sample: Record<string, ScheduleStop[] | null> = {};
    for (const id of ['Harvey', 'Abigail', 'Pam', 'Shane']) {
      const npc = state.npcs!.find(npc => npc.id === id)!; sample[id] = npc.schedule;
      check(`schedule-${id}-${rain}-native-data`, !!npc.schedule?.length, npc);
      const before = packets.length;
      const reply = await say(id, '你待会儿要去哪儿？', `schedule-${id}-${rain}`);
      const open = modPackets('talk.open', before)[0]!;
      check(`schedule-${id}-${rain}-wire`, JSON.stringify(open.schedule) === JSON.stringify(npc.schedule), open.schedule);
      check(`schedule-${id}-${rain}-prompt`, latestDialogue().messages[0]!.content.includes('- 今日行程（'), nextStop(npc.schedule!, 1400));
      const next = nextStop(npc.schedule!, 1400)!;
      const destination = next.slice(6).replace(/^去/, '');
      const text = reply.reply!.text;
      contentCheck(`schedule-${id}-${rain}-destination-and-time`, text.includes(next.slice(0, 5)) && text.includes(destination)
        && !/墓地|湖边|山洞/.test(text) && (!next.includes('睡觉') || /不再/.test(text)), { nativeNext: next, reply: text, raw: latestDialogue().content });
      // A place reached earlier in the day must not become an extra trip before the next departure.
      contentCheck(`schedule-${id}-${rain}-no-past-stop-as-future`, id === 'Pam' || id === 'Shane' ? !/Joja|超市/.test(text)
        : id === 'Harvey' && !rain ? !/镇上|鹈鹕镇/.test(text) : true, { reply: text, nativeNext: next });
      const evening = await rpc('talk-say', { text: '晚上去哪能找到你？', label: `schedule-evening-${id}-${rain}` });
      const eveningPlace = id === 'Abigail' ? /皮埃尔|杂货|家|房间/ : id === 'Harvey' && !rain ? /HarveyRoom|公寓|房间/ : /酒吧|餐吧|格斯|星之果实/;
      contentCheck(`schedule-${id}-${rain}-evening-place`, eveningPlace.test(evening.reply!.text) && !/墓地|湖边|山洞/.test(evening.reply!.text),
        { reply: evening.reply!.text, schedule: npc.schedule, raw: latestDialogue().content });
      if (id === 'Harvey') await rpc('capture', { name: `schedule-${rain ? 'rain' : 'sun'}.png` });
      await close();
    }
    records.push(sample);
  }
  check('schedule-native-rain-changes-at-least-one-route', JSON.stringify(records[0]) !== JSON.stringify(records[1]), records);
  await rpc('ignore-schedule', { npc: 'Harvey', ignore: true });
  const before = packets.length; await say('Harvey', '你现在有安排吗？', 'schedule-ignored');
  check('schedule-story-override-omits-wire', !('schedule' in modPackets('talk.open', before)[0]!));
  check('schedule-story-override-omits-prompt', !latestDialogue().messages[0]!.content.includes('- 今日行程（'));
  await close();
}
async function backstage() {
  await chapter('spring', 2); await rpc('isolate'); await stagePair('Pam', 'Gus');
  await rpc('config', { OffscreenNews: true, BackstageScenes: true });
  heldBackstage = deferred(); dropNextHourAck = true;
  const before = bgStarts(), beforeWire = packets.length, beforeGeneration = last!.generation;
  await rpc('clock', { time: 800 }); await wait(() => bgStarts() === before + 1, 'held native backdrop started');
  await wait(() => last!.generation > beforeGeneration && modPackets('town.hour', beforeWire).length >= 2, 'native reliable hour reconnected');
  check('backstage-native-reconnect-generation', last!.generation > beforeGeneration, last!.generation);
  const hours = modPackets('town.hour', beforeWire);
  check('backstage-native-reliable-resend', hours.length >= 2 && hours[0]!.seq === hours[1]!.seq, hours);
  check('backstage-replay-one-call', bgStarts() === before + 1);
  const blocker = deferred();
  const blocks = [0, 1].map(() => gateway.lane('background', { async chat() { await blocker.promise; return { ...fixed({}), usage: null }; } }).chat([]));
  await say('Pam', '今天过得怎么样？', 'backstage-concurrent-dialogue');
  check('backstage-dialogue-starts-before-release', starts.some(start => start.kind === 'dialogue' && start.held));
  await close(); blocker.resolve(); await Promise.all(blocks);
  heldBackstage.resolve(); heldBackstage = undefined;
  await wait(() => logs.some(line => line.includes('条等下一个整点写入')), 'backstage model completed');
  check('backstage-result-not-written-immediately', bgWrites().length === 0);
  await rpc('clock', { time: 900 });
  check('backstage-next-native-hour-writes', bgWrites().length >= 2, bgWrites());
  check('backstage-same-people-not-reused', bgStarts() === before + 1);
  await say('Pam', '刚才你和格斯在酒吧聊了什么？', 'backstage-native-recall');
  check('backstage-native-recall-prompt', /在.+和格斯聊天：/.test(latestDialogue().messages[0]!.content));
  await rpc('capture', { name: 'backstage-recall.png' }); await close();
  await rpc('sleep');
  check('backstage-real-save-in-database', counts().filter(row => String(row.topics).includes('backstage')).length >= 2, counts());
  await rpc('title'); await rpc('load');
  await say('Pam', '昨天你和格斯聊了什么？', 'backstage-saved-reload');
  check('backstage-saved-reload-prompt', /在.+和格斯聊天：/.test(latestDialogue().messages[0]!.content)); await close();
  await rpc('isolate'); await stagePair('Harvey', 'Maru', 'Hospital'); await rpc('config', { OffscreenNews: true, BackstageScenes: true });
  const unsavedCalls = bgStarts(); await rpc('clock', { time: 800 });
  await wait(() => calls.filter(call => call.kind === 'background').length >= unsavedCalls + 1, 'unsaved model returned');
  await rpc('clock', { time: 900 }); await say('Harvey', '刚才和玛鲁聊了什么？', 'backstage-before-rollback');
  check('backstage-unsaved-present', /在.+和玛鲁聊天：/.test(latestDialogue().messages[0]!.content)); await close();
  await rpc('title'); await rpc('load'); await say('Harvey', '刚才和玛鲁聊了什么？', 'backstage-after-rollback');
  check('backstage-unsaved-rollback', !/在.+和玛鲁聊天：/.test(latestDialogue().messages[0]!.content));
  contentCheck('backstage-rollback-reply-is-unknown-without-inventing-a-meeting', /想不起来|记不清/.test(last!.worldCommand!.state.reply!.text)
    && !/排班|药品|没见|没聊/.test(last!.worldCommand!.state.reply!.text), { reply: last!.worldCommand!.state.reply!.text, raw: latestDialogue().content });
  await close();
  await rpc('isolate'); await rpc('config', { OffscreenNews: true, BackstageScenes: true });
  const pairs = [['Abigail', 'Sebastian'], ['Sam', 'Penny'], ['Leah', 'Elliott'], ['Haley', 'Alex'], ['Maru', 'Harvey'], ['Emily', 'Shane'], ['Pam', 'Gus']];
  const capStart = bgStarts();
  for (let i = 0; i < 6; i++) {
    await stagePair(...pairs[i]! as [string, string]); await rpc('clock', { time: 700 + i * 100 });
    await wait(() => calls.filter(call => call.kind === 'background').length >= capStart + i + 1, 'capped scene completed');
    await rpc('isolate');
  }
  await stagePair(...pairs[6]! as [string, string]); await rpc('clock', { time: 1300 });
  check('backstage-native-daily-six', bgStarts() === capStart + 6, bgStarts() - capStart);
  for (const client of relay.clients) client.terminate(); await rpc('wait', { ticks: 120 }); await rpc('clock', { time: 1400 });
  check('backstage-native-reconnect-retains-six', bgStarts() === capStart + 6);
  await rpc('config', { BackstageScenes: false }); const wire = packets.length; await rpc('clock', { time: 1500 });
  const disabled = modPackets('town.hour', wire)[0]!;
  check('backstage-disabled-still-sends-town-hour', !!disabled);
  check('backstage-disabled-no-metadata', !('hearts' in disabled) && !('weather' in disabled) && !('schedules' in disabled), disabled);
  await rpc('config', { BackstageScenes: true }); await rpc('clock', { time: 2400 });
  check('backstage-after-2300-no-call', bgStarts() === capStart + 6);
  await rpc('sleep');
  await rpc('isolate'); await stagePair('Pam', 'Gus');
  heldBackstage = deferred(); const lateStart = bgStarts(); await rpc('clock', { time: 800 });
  await wait(() => bgStarts() === lateStart + 1, 'late native scene started');
  const reportsBefore = reports.length; await rpc('sleep');
  check('gateway-native-save-with-request-in-flight', reports.length > reportsBefore);
  await rpc('isolate');
  heldBackstage.resolve(); heldBackstage = undefined;
  await wait(() => calls.filter(call => call.kind === 'background').length >= lateStart + 1, 'late model completed');
  const writes = bgWrites().length; await rpc('clock', { time: 900 });
  check('backstage-late-old-day-not-written', bgWrites().length === writes);
  await rpc('sleep');
  check('gateway-late-native-token-report', reports.some(report => report.usage.background.calls === 0 && report.usage.background.inputTokens > 0), reports);
  const current = gateway.usage();
  const sum = (key: 'inputTokens' | 'cachedInputTokens' | 'outputTokens') => reports.reduce((total, report) => total + Object.values(report.usage).reduce((n, tier) => n + tier[key], 0), 0)
    + Object.values(current).reduce((n, tier) => n + tier[key], 0);
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens'] as const)
    check('gateway-native-conservation-' + key, sum(key) === calls.reduce((total, call) => total + (call.usage?.[key] ?? 0), 0), { reports, current });
}

const festivalLocations: Record<string, string> = { spring24: 'Forest', spring13: 'Town', summer11: 'Beach', fall16: 'Town', winter8: 'Forest', winter25: 'Town' };
async function festival(key: string, operation: string, args: Record<string, unknown>, expected: (packet: Record<string, unknown>) => boolean, year = 1, save = false) {
  const [, season, day] = /^(spring|summer|fall|winter)(\d+)$/.exec(key)!;
  await chapter(season!, Number(day), false, year);
  const wire = packets.length;
  const entered = await rpc('festival-open', { map: festivalLocations[key], time: 1000 });
  check(`${key}-${operation}-${year}-native-event`, entered.festival?.id === 'festival_' + key && entered.festival.actors.length > 8, entered.festival);
  check(`${key}-${operation}-${year}-festival-actors-no-normal-schedule`, Object.keys(entered.festival!.schedules).length === 0, entered.festival!.schedules);
  if (key === 'spring24') await rpc('dance-invite', { npc: 'Abigail' });
  if (operation !== 'invite-only' && operation !== 'disabled') await rpc(operation, args);
  if (operation === 'disabled') {
    // The enabled/disabled check starts its next case with this same real festival, before any result exists.
    await rpc('config', { FestivalMemories: false });
  }
  let state = await rpc('snapshot');
  if (state.festival?.isFestival) await rpc('festival-leave');
  const sent = modPackets('festival.ended', wire);
  if (operation === 'invite-only') check('flower-dance-invitation-alone-no-memory', sent.length === 0, sent);
  else if (operation === 'santa' && args.interrupt) {
    check('santa-interrupted-before-receipt', state.native?.receivedItems === 0 && state.native?.giver === 'Lewis', state.native);
    check('santa-interrupted-no-false-delivery-memory', sent.length === 0, sent);
  }
  else {
    check(`${key}-${operation}-${year}-one-result`, sent.length === 1, sent);
    check(`${key}-${operation}-${year}-vanilla-result`, expected(sent[0]!), sent[0]);
    const journal = join(directory, 'memory/scratch', digest(config.UniqueId), digest(last!.nonce) + '.jsonl');
    const rows = (await readFile(journal, 'utf8')).trim().split('\n').slice(1).map(line => JSON.parse(line) as { changes: { log?: { festival?: string }; memories?: unknown[] }[] });
    check(`${key}-${operation}-${year}-replay-one-atomic-entry`, rows.filter(row => row.changes.some(change => change.log?.festival === key)).length === 1, rows.length);
  }
  if (save) {
    await rpc('sleep'); await rpc('title'); await rpc('load');
    await say('Abigail', '花舞节那天我们一起跳舞了吗？', 'festival-saved-dance');
    check('festival-real-save-reload-recall', /（昨天）花舞节上农场主邀请我跳舞/.test(latestDialogue().messages[0]!.content)); await close();
    await server.close(); server = await BridgeServer.start(options); await rpc('wait', { ticks: 120 });
    await say('Abigail', '花舞节那天和谁跳舞了？', 'festival-backend-restart');
    check('festival-saved-backend-restart-recall', /花舞节上农场主邀请我跳舞/.test(latestDialogue().messages[0]!.content)); await close();
  }
}
async function festivals() {
  await chapter('spring', 13); await rpc('config', { FestivalMemories: false });
  const disabledWire = packets.length;
  await rpc('festival-open', { map: 'Town', time: 1000 }); await rpc('contest', { kind: 'egg', score: 99 }); await rpc('festival-leave');
  check('festival-disabled-native-contest-no-message', modPackets('festival.ended', disabledWire).length === 0);
  await festival('spring24', 'invite-only', {}, () => false);
  await festival('spring24', 'festival-main', {}, packet => packet.dance === 'Abigail', 1, true);
  await festival('winter25', 'santa', {}, packet => !!packet.santa);
  await festival('winter25', 'santa', { absentGiver: true }, packet => (packet.santa as { giver: string })?.giver === 'Lewis');
  await festival('winter25', 'santa', { absentGiver: true, interrupt: true }, packet => (packet.santa as { giver: string })?.giver === 'Lewis');
  for (const [key, kind] of [['spring13', 'egg'], ['winter8', 'fish']])
    for (const win of [true, false]) await festival(key!, 'contest', { kind, score: win ? 99 : 0 }, packet => packet.contest === (win ? 'player' : 'npc'));
  for (const [key, kind] of [['spring13', 'egg'], ['winter8', 'fish']]) {
    const [, season, day] = /^(spring|winter)(\d+)$/.exec(key!)!;
    await chapter(season!, Number(day)); const before = packets.length;
    await rpc('festival-open', { map: festivalLocations[key!], time: 1000 });
    const state = await rpc('contest', { kind, score: 99, otherWinner: true }); await rpc('festival-leave');
    check(`${key}-injected-other-player-not-local-win`, state.native?.controlledOtherWinner && modPackets('festival.ended', before).length === 0, state.native);
  }
  await festival('fall16', 'grange', { items: ['(O)254', '(O)698', '(O)424', '(O)445', '(O)454', '(O)724', '(O)422', '(O)428', '(O)72'], quality: 4 }, packet => packet.grange === 1);
  await festival('fall16', 'grange', { items: ['(O)789'] }, packet => packet.grange === 'shorts');
  for (const [item, quality, expected] of [['(O)426', 2, 4], ['', 0, 5], ['(O)789', 0, 6], ['(O)420', 0, 0], ['(O)296', 0, 1], ['(O)248', 0, 2], ['(O)254', 0, 3]] as const)
    await festival('summer11', 'soup', { item, quality }, packet => packet.soup === expected);
  await festival('summer11', 'soup', { item: '(O)426', quality: 2 }, packet => packet.soup === 4, 2);
  await fairReturn();
}
async function fairReturn() {
  // Empty displays and the fishing sub-map must not falsely finish the real fair.
  await chapter('fall', 16); const wire = packets.length; await rpc('festival-open', { map: 'Town', time: 1000 });
  await rpc('capture', { name: 'festival-fair.png' });
  await rpc('grange', { items: [] });
  const fishing = await rpc('fish-start'); check('fair-native-fishing-minigame', fishing.minigame === 'FishingGame', fishing);
  check('fair-minigame-does-not-end-festival', modPackets('festival.ended', wire).length === 0);
  await rpc('fish-end'); const returned = await rpc('snapshot');
  check('fair-fishing-return-preserves-festival', returned.festival?.id === 'festival_fall16' && returned.festival.isFestival, returned);
  await rpc('festival-leave'); check('fair-empty-grange-no-memory', modPackets('festival.ended', wire).length === 0);
  // Roll back an unsaved festival through an actual title/reload, then inspect the next native prompt.
  await festival('spring13', 'contest', { kind: 'egg', score: 99 }, packet => packet.contest === 'player');
  await rpc('title'); await rpc('load'); await say('Abigail', '复活节的彩蛋比赛怎么样？', 'festival-unsaved-rollback');
  check('festival-unsaved-reload-removes-note', !/（今天）复活节上我看到农场主赢了彩蛋大寻宝/.test(latestDialogue().messages[0]!.content)); await close();
}

try {
  await wait(() => last?.worldCommand?.completed === true && last.worldCommand.state.ready, 'initial native load');
  if (['all', 'schedules', 'content'].includes(config.Section)) await schedules();
  if (['all', 'backstage', 'content'].includes(config.Section)) await backstage();
  if (config.Section === 'all' || config.Section === 'festivals') await festivals();
  if (config.Section === 'fair-return') await fairReturn();
  if (config.Section === 'all' || config.Section === 'actions') await runActions({ rpc, chapter, check, say, close, packets: modPackets, wireCount: () => packets.length,
    latestSystem: () => latestDialogue().messages[0]!.content, seedNight, meetingEntries });
  if (config.Section === 'actions-edge') await runActionEdges({ rpc, chapter, check, say, close, packets: modPackets, wireCount: () => packets.length,
    latestSystem: () => latestDialogue().messages[0]!.content, seedNight, meetingEntries });
  if (config.Section === 'all' || config.Section === 'actions-timing') await runActionTiming({ rpc, chapter, check, say, close, packets: modPackets, wireCount: () => packets.length,
    latestSystem: () => latestDialogue().messages[0]!.content, seedNight, meetingEntries });
  if (config.Section === 'actions-checks') {
    const host = { rpc, chapter, check, say, close, packets: modPackets, wireCount: () => packets.length,
      latestSystem: () => latestDialogue().messages[0]!.content, seedNight, meetingEntries };
    await runActionQueue(host); await runActionRender(host);
  }
  if (config.Section === 'actions-places') await runActionPlaces({ rpc, chapter, check, say, close, packets: modPackets, wireCount: () => packets.length,
    latestSystem: () => latestDialogue().messages[0]!.content, seedNight, meetingEntries });
  if (config.Section === 'all' || config.Section === 'actions-incoming') await runActionIncoming({ rpc, chapter, check, say, close, packets: modPackets, wireCount: () => packets.length,
    latestSystem: () => latestDialogue().messages[0]!.content, seedNight, meetingEntries });
  if (config.Section === 'content') await festival('spring24', 'festival-main', {}, packet => packet.dance === 'Abigail', 1, true);
  if (['all', 'farm-help', 'farm-chores', 'farm-visits', 'farm-save'].includes(config.Section)) {
    const host = { rpc, chapter, check, say, close, packets: modPackets, wireCount: () => packets.length,
      latestSystem: () => latestDialogue().messages[0]!.content, seedNight, meetingEntries };
    if (['all', 'farm-help', 'farm-chores'].includes(config.Section)) await runFarmChores(host);
    if (['all', 'farm-help', 'farm-visits'].includes(config.Section)) await runFarmVisits(host);
    if (['all', 'farm-help', 'farm-save'].includes(config.Section)) await runFarmSave(host);
  }
  if (['all', 'mine', 'mine-core', 'mine-rescue', 'mine-edges', 'mine-worlds', 'mine-dungeons', 'mine-save'].includes(config.Section)) {
    const host = { rpc, chapter, check, say, close, packets: modPackets, wireCount: () => packets.length,
      latestSystem: () => latestDialogue().messages[0]!.content, seedNight, meetingEntries };
    if (['all', 'mine', 'mine-core'].includes(config.Section)) await runMineCore(host);
    if (['all', 'mine', 'mine-rescue'].includes(config.Section)) await runMineRescue(host);
    if (['all', 'mine', 'mine-edges'].includes(config.Section)) await runMineEdges(host);
    if (['all', 'mine', 'mine-worlds', 'mine-dungeons'].includes(config.Section)) await runMineWorlds(host, config.Section !== 'mine-dungeons');
    if (['all', 'mine', 'mine-save'].includes(config.Section)) await runMineSave(host);
  }
  if (['same-day', 'same-day-core', 'same-day-edges', 'call-off', 'call-off-arrival', 'call-off-arrival-save', 'farm-animals', 'meeting-spouses', 'meeting-friendship', 'later-meetings', 'friendship-boundaries'].includes(config.Section)) {
    const host = { rpc, chapter, check, say, close, packets: modPackets, wireCount: () => packets.length,
    latestSystem: () => latestDialogue().messages[0]!.content, seedNight, meetingEntries,
    setReply: (text: string) => { actionTodayReply = text; },
    setMood: (mood: number) => { actionTodayMood = mood; },
    dayMeetings: (from = 0) => packets.slice(from).filter(row => row.direction === 'backend' && row.packet.type === 'day.meetings').map(row => row.packet),
    restart: async () => { await server.close(); server = await BridgeServer.start(options); await rpc('wait', { ticks: 120 }); } };
    if (config.Section === 'meeting-spouses') await runSpouseFriendship(host);
    else if (config.Section === 'friendship-boundaries') await runFriendshipBoundaries(host);
    else if (config.Section === 'later-meetings') await runLaterMeetings(host);
    else if (config.Section === 'meeting-friendship') await runMeetingFriendship(host);
    else if (config.Section === 'farm-animals') await runFarmAnimals(host);
    else if (config.Section.startsWith('call-off-arrival')) await runArrivalProbe(host, config.Section === 'call-off-arrival-save');
    else if (config.Section === 'call-off') await runCallOff(host);
    else {
      if (config.Section !== 'same-day-edges') await runSameDay(host);
      if (config.Section !== 'same-day-core') await runSameDayEdges(host);
    }
  }
  if (!config.Offline) {
    check('real-dialogue-preserves-configured-thinking', calls.filter(call => call.real && call.kind === 'dialogue').every(call => call.thinking === paid!.config.thinking));
    check('real-backstage-disables-thinking', calls.filter(call => call.real && call.kind === 'background').every(call => call.thinking === 'disabled'));
  }
  check('no-protocol-or-native-reply-errors', errors.length === 0, errors);
  await rpc('title'); await rpc('finish'); technicalSuccess = true;
  const contentFailures = checks.filter(check => check.scope === 'content' && !check.passed);
  success = contentFailures.length === 0;
  if (!success) failure = `Native workflow completed; ${contentFailures.length} model content checks failed.`;
} catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); console.error(failure); }
finally {
  heldBackstage?.resolve();
  if (!last?.completed) {
    await json(join(directory, 'control.json'), { requestId: config.RequestId, abort: '世界验收脚本已停止，请保留本轮证据。' });
    const deadline = Date.now() + 5000;
    while (!last?.completed && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 250)); await report(); }
  }
  if (game.exitCode === null && last?.completed && !last.saveProcessing && !last.newDay) { const exited = once(game, 'exit'); game.kill(); await exited; }
  try { await writeFile(join(directory, 'smapi-log.txt'), await readFile(join(process.env.APPDATA!, 'StardewValley/ErrorLogs/SMAPI-latest.txt'))); } catch { /* Reports remain available. */ }
  for (const client of relay.clients) client.terminate(); for (const upstream of upstreams) upstream.terminate();
  await new Promise<void>(resolve => relay.close(() => resolve())); await server.close();
  await json(join(directory, 'packets.json'), packets); await json(join(directory, 'checks.json'), checks); await json(join(directory, 'usage-reports.json'), reports);
  await json(join(directory, 'result.json'), { success, technicalSuccess, failure, requestId: config.RequestId, protocol: PROTOCOL_VERSION, offline: config.Offline, section: config.Section,
    checks: checks.length, modelCalls: calls.filter(call => call.real).length, realCalls: calls.filter(call => call.real).map(({ kind, usage, timing, thinking }) => ({ kind, usage, timing, thinking })),
    contentChecks: checks.filter(check => check.scope === 'content'),
    errors, report: last, directory });
}
console.log(JSON.stringify({ success, technicalSuccess, failure, checks: checks.length, realCalls: calls.filter(call => call.real).length, directory, seconds: last?.elapsedSeconds }));
if (!success) process.exitCode = 1;
