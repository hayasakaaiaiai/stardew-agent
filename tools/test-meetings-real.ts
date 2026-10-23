/**
 * Paid end-to-end run of the meeting line with the real model (docs/real-model-meetings.md): a real BridgeServer, a
 * simulated Mod and real dialogue and nightly calls. The lines and what the backend sent the Mod are written apart, so
 * the conversations can be read and labelled before the results are looked at.
 *
 *   node --env-file=<.env> tools/test-meetings-real.ts [--batch A|B] [--only id,id] [--jobs 4]
 *   node tools/test-meetings-real.ts --replay <dir> [--only id,id]   # the recorded calls again, free
 *   node tools/test-meetings-real.ts --dry [--only id,id]            # a fixed reply for every call, free
 *   node tools/test-meetings-real.ts --compare <dir>                 # results against the labels (tools/meetings-real/labels.json)
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import type { Season } from '../src/agent/dialogue.ts';
import { FESTIVAL_DAYS } from '../src/agent/meeting-agreement.ts';
import { NIGHTLY_THINKING, nightlyConsolidator } from '../src/agent/nightly.ts';
import { PROTOCOL_VERSION, type BackendMessage, type GameDate, type LoadedSave, type WorldFlags } from '../src/bridge/protocol.ts';
import { BridgeServer } from '../src/bridge/server.ts';
import { type ChatModel, type Completion, ModelClient, modelConfigFromEnv } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';
import { SCENARIOS, type Scenario } from './meetings-real/scenarios.ts';

const ROOT = resolve(import.meta.dirname, '..');
const arg = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const SEASONS: Season[] = ['spring', 'summer', 'fall', 'winter'];
const SEASON_NAMES: Record<Season, string> = { spring: '春季', summer: '夏季', fall: '秋季', winter: '冬季' };
const FLAGS: WorldFlags = { communityCenter: 'pending', busRepaired: true, understandsDwarves: false, pamHouse: false, islandOpen: false, leoMoved: false };
const PLAYER = { name: '小林', gender: 'female' as const, farm: '晴空' };
const WAIT_MS = 120_000;

/** An appointment as a day after the conversation's (0 today), HHMM and a place; `soon` ones were "right away". */
export interface Appointment { day: number; time: number; place: string; soon?: true }
interface Line { speaker: '玩家' | 'NPC'; text: string; setup?: true }
interface Call { id: string; lane: 'dialogue' | 'nightly'; messages: unknown; completion: Completion }
interface Result {
  id: string; kind: string; npc: string; lines: Line[]; appointments: Appointment[]; setupOk: boolean; errors: string[];
  lists: unknown[]; notes: string[]; logs: string[];
}

const absolute = (season: Season, day: number) => SEASONS.indexOf(season) * 28 + day;
function dateOf(day: number, time: number): GameDate {
  return { year: Math.floor((day - 1) / 112) + 1, season: SEASONS[Math.floor((day - 1) % 112 / 28)]!, day: (day - 1) % 28 + 1, time };
}
const clock = (time: number) => `${String(Math.floor(time / 100)).padStart(2, '0')}:${String(time % 100).padStart(2, '0')}`;

/** The simulated Mod: sends with the load's envelope and waits for what answers it. */
class Wire {
  readonly inbox: BackendMessage[] = [];
  private seq = 0;
  private readonly waiters = new Set<() => void>();
  private readonly socket: WebSocket;
  readonly loaded: LoadedSave;

  private constructor(socket: WebSocket, loaded: LoadedSave) {
    this.socket = socket; this.loaded = loaded;
    socket.on('message', bytes => { this.inbox.push(JSON.parse(bytes.toString()) as BackendMessage); for (const wake of this.waiters) wake(); });
  }

  static async open(port: number, loaded: LoadedSave): Promise<Wire> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((done, fail) => { socket.once('open', done); socket.once('error', fail); });
    const wire = new Wire(socket, loaded);
    socket.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, modVersion: 'real-meetings' }));
    await wire.until(item => item.type === 'hello');
    await wire.announce();
    return wire;
  }

  until(found: (item: BackendMessage) => boolean, from = 0, ms = WAIT_MS): Promise<BackendMessage> {
    const hit = () => this.inbox.find((item, index) => index >= from && found(item));
    const existing = hit(); if (existing) return Promise.resolve(existing);
    return new Promise((done, fail) => {
      const timer = setTimeout(() => { this.waiters.delete(wake); fail(new Error('等后端回复超时')); }, ms);
      const wake = () => { const item = hit(); if (item) { clearTimeout(timer); this.waiters.delete(wake); done(item); } };
      this.waiters.add(wake);
    });
  }

  /** Sends one game event and waits for its answer: an ack, a reply, or an error with its seq. */
  async send(message: Record<string, unknown>, answer: BackendMessage['type'][]): Promise<BackendMessage> {
    const seq = ++this.seq, from = this.inbox.length;
    this.socket.send(JSON.stringify({ lineageId: this.loaded.lineageId, loadNonce: this.loaded.loadNonce, ...message, seq }));
    const got = await this.until(item => 'seq' in item && item.seq === seq && (answer.includes(item.type) || item.type === 'sync.error'
      || item.type === 'talk.error'), from);
    if (got.type === 'sync.error' || got.type === 'talk.error') throw new Error(`${String(message.type)}：${got.message}`);
    return got;
  }

  /** The same load again: the backend keeps the day and sends today's appointments as they stand. */
  async announce(): Promise<unknown[]> {
    const from = this.inbox.length;
    this.socket.send(JSON.stringify(this.loaded));
    const ready = await this.until(item => item.type === 'save.ready' || item.type === 'sync.error', from);
    if (ready.type === 'sync.error') throw new Error(`读档：${ready.message}`);
    const list = await this.until(item => item.type === 'day.meetings', this.inbox.indexOf(ready));
    return (list as Extract<BackendMessage, { type: 'day.meetings' }>).meetings;
  }

  async close(): Promise<void> {
    if (this.socket.readyState === this.socket.CLOSED) return;
    const done = new Promise<void>(closed => this.socket.once('close', () => closed()));
    this.socket.close(); await done;
  }
}

/** Every call is kept with its prompt; a replay hands each scenario its own calls back in order, or fails. */
function recorder(file: string, id: string, lane: Call['lane'], paid: ChatModel | undefined, replay: Map<string, Call[]> | undefined): ChatModel {
  return { async chat(messages, handlers, options) {
    let completion: Completion;
    if (replay) {
      const next = replay.get(`${id}/${lane}`)?.shift();
      if (!next || JSON.stringify(next.messages) !== JSON.stringify(messages)) throw new Error(`${id}：录下的 ${lane} prompt 和这次的不一样`);
      completion = next.completion;
      handlers?.onContent?.(completion.content);
    } else completion = await paid!.chat(messages, handlers, options);
    await appendFile(file, JSON.stringify({ id, lane, messages, completion } satisfies Call) + '\n');
    return completion;
  } };
}

/** Scripted replies go first, for setting up an appointment before the paid conversation; they cost nothing. */
function scripted(paid: ChatModel): { model: ChatModel; script: string[] } {
  const script: string[] = [];
  return { script, model: { chat(messages, handlers, options) {
    const reply = script.shift();
    if (reply === undefined) return paid.chat(messages, handlers, options);
    const content = JSON.stringify({ reply, emotion: 'neutral', options: ['好。', '说说别的吧。', '我先走了。'], remember: [], mood: 0, end: false });
    handlers?.onContent?.(content);
    return Promise.resolve({ content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 0, totalMs: 0 } });
  } } };
}

// "约好夏季 14 日（周三）14:00 在海滩见面。", "约好春季 24 日（周三）一起去花舞节。", and ones taken back: "……，后来……。"
const LATER = /记下了：约好(春|夏|秋|冬)季 (\d+) 日（周.）(?:(\d\d):(\d\d) 在(.+?)见面|一起去(.+?))(，后来.*)?。$/;

/** The appointments the notes leave for later days: the latest note for a day decides, and one taken back leaves none. */
function laterFrom(logs: readonly string[], today: number): Appointment[] {
  const kept = new Map<number, Appointment>();
  for (const line of logs) {
    const found = LATER.exec(line);
    if (!found) continue;
    const day = absolute(SEASONS['春夏秋冬'.indexOf(found[1]!)]!, Number(found[2])) + Math.floor((today - 1) / 112) * 112 - today;
    if (found[7]) { kept.delete(day); continue; }
    kept.set(day, found[6] ? { day, time: FESTIVAL_DAYS[found[6]]?.time ?? 0, place: found[6] } : { day, time: Number(found[3]) * 100 + Number(found[4]), place: found[5]! });
  }
  return [...kept.values()];
}

function fromList(list: readonly unknown[], npc: string, day: number, logs: readonly string[]): Appointment[] {
  return (list as { npc: string; time: number; place: string; calledOff?: true }[])
    .filter(item => item.npc === npc && !item.calledOff)
    .map(item => ({ day, time: item.time, place: item.place,
      ...(day === 0 && logs.some(line => line.includes(`${clock(item.time)} 说好马上去 ${item.place}`)) ? { soon: true as const } : {}) }));
}

async function run(scenario: Scenario, roster: Roster, calls: string, paid: { dialogue?: ChatModel; nightly?: ChatModel },
  replay: Map<string, Call[]> | undefined): Promise<Result> {
  const directory = await mkdtemp(join(tmpdir(), 'real-meetings-'));
  const logs: string[] = [];
  const id = scenario.npc.toLowerCase();
  const dialogue = scripted(recorder(calls, scenario.id, 'dialogue', paid.dialogue, replay));
  const server = await BridgeServer.start({ roster, model: dialogue.model, memoryDirectory: directory, port: 0, log: line => logs.push(line),
    consolidator: nightlyConsolidator({ roster, model: recorder(calls, scenario.id, 'nightly', paid.nightly, replay), log: line => logs.push(line) }),
    nightlyRetryDelayMs: 2000 });
  const today = absolute(scenario.date[0], scenario.date[1]);
  const result: Result = { id: scenario.id, kind: scenario.kind, npc: scenario.npc, lines: [], appointments: [], setupOk: true, errors: [], lists: [], notes: [], logs };
  const loaded: LoadedSave = { type: 'save.loaded', lineageId: `real-${scenario.id}`, loadNonce: 'load-1', seq: 0, player: PLAYER,
    date: dateOf(today, 600), commit: null };
  let wire: Wire | undefined;
  try {
    wire = await Wire.open(server.port, loaded);
    const talk = async (time: number, lines: readonly string[], setup: boolean) => {
      const extra = setup ? {} : { ...(scenario.invite ? { invite: true } : {}),
        ...(scenario.birthday ? { birthday: { season: scenario.birthday[0], day: scenario.birthday[1] } } : {}) };
      const world = { date: dateOf(today, time), weather: 'sunny', location: scenario.location, flags: FLAGS };
      const open = await wire!.send({ type: 'talk.open', npc: scenario.npc, hearts: scenario.hearts ?? 8, relation: scenario.relation ?? 'friend',
        seenEvents: [], world, ...extra }, ['talk.reply']);
      result.lines.push({ speaker: 'NPC', text: (open as { reply: string }).reply, ...(setup ? { setup: true as const } : {}) });
      for (const [index, text] of lines.entries()) {
        result.lines.push({ speaker: '玩家', text, ...(setup ? { setup: true as const } : {}) });
        const reply = await wire!.send({ type: 'talk.say', npc: scenario.npc, text, date: dateOf(today, time + 10 * (index + 1)) }, ['talk.reply']);
        result.lines.push({ speaker: 'NPC', text: (reply as { reply: string }).reply, ...(setup ? { setup: true as const } : {}) });
      }
      await wire!.send({ type: 'talk.close', npc: scenario.npc }, ['ack']);
    };
    if (scenario.setup) {
      dialogue.script.push(scenario.setup.opening ?? '嗨，小林。', scenario.setup.reply);
      await talk(scenario.setup.at, [scenario.setup.say], true);
      const set = [...fromList(await wire.announce(), id, 0, logs), ...laterFrom(logs, today)];
      result.setupOk = JSON.stringify(set) === JSON.stringify([scenario.setup.expect]);
      if (!result.setupOk) result.errors.push(`铺垫的约定没有约成：${JSON.stringify(set)}`);
    }
    await talk(scenario.time, scenario.say, false);
    const list = await wire.announce();
    result.lists.push(list);
    const appointments = fromList(list, id, 0, logs);
    if (scenario.sleep) {
      const from = logs.length;
      await wire.send({ type: 'save.saving', commit: { commitId: 'c1', parentId: null, dayEnded: today } }, ['ack']);
      await wire.send({ type: 'save.saved', commitId: 'c1', date: dateOf(today + 1, 600) }, ['ack']);
      await wire.send({ type: 'day.started', date: dateOf(today + 1, 600), weather: 'sunny' }, ['ack']);
      const started = Date.now();
      while (!logs.slice(from).some(line => /夜间整合完成|额度已用尽/.test(line))) {
        if (Date.now() - started > 4 * WAIT_MS) throw new Error('等夜间整合超时');
        await new Promise(done => setTimeout(done, 200));
      }
      if (!logs.slice(from).some(line => line.startsWith('夜间整合完成'))) result.errors.push('夜间整合没有完成');
      const next = await wire.announce();
      result.lists.push(next);
      appointments.push(...fromList(next, id, 1, logs));
      appointments.push(...laterFrom(logs, today).filter(item => item.day !== 1));
    } else appointments.push(...laterFrom(logs, today));
    result.appointments = appointments.sort((a, b) => a.day - b.day || a.time - b.time);
    result.notes = logs.filter(line => line.includes('记下了') || line.includes('约定'));
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    await wire?.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
  return result;
}

function describe(scenario: Scenario): string {
  const date = dateOf(absolute(scenario.date[0], scenario.date[1]), scenario.time);
  const weekday = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][(absolute(scenario.date[0], scenario.date[1]) - 1) % 7];
  return `${SEASON_NAMES[date.season]} ${date.day} 日（${weekday}）${clock(scenario.time)}，${scenario.location}，${scenario.npc}`
    + `（${scenario.hearts ?? 8} 心${scenario.relation && scenario.relation !== 'friend' ? `，${scenario.relation}` : ''}）`
    + (scenario.invite ? '，今天由 NPC 开口约你' : '') + (scenario.birthday ? `，NPC 的生日是${SEASON_NAMES[scenario.birthday[0]]} ${scenario.birthday[1]} 日` : '')
    + (scenario.sleep ? '；聊完睡一觉' : '');
}

/** The conversations only, for labelling before the results are seen. */
function transcript(scenarios: readonly Scenario[], results: readonly Result[]): string {
  return scenarios.map(scenario => {
    const result = results.find(item => item.id === scenario.id)!;
    const lines = result.lines.map(line => `- ${line.setup ? '（铺垫，固定回复）' : ''}${line.speaker}：${line.text}`);
    return [`## ${scenario.id}　${scenario.kind}`, '', describe(scenario), '', ...lines, ...(result.errors.length ? ['', `出错：${result.errors.join('；')}`] : []), ''].join('\n');
  }).join('\n');
}

function usage(callLines: readonly Call[]) {
  const sum = (lane: Call['lane']) => {
    const used = callLines.filter(call => call.lane === lane);
    const total = (key: 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'reasoningTokens') => used.reduce((all, call) => all + (call.completion.usage?.[key] ?? 0), 0);
    return { calls: used.length, input: total('inputTokens'), cached: total('cachedInputTokens'), output: total('outputTokens'), reasoning: total('reasoningTokens') };
  };
  return { dialogue: sum('dialogue'), nightly: sum('nightly') };
}

const key = (item: Appointment) => `${item.day}|${item.place}|${item.soon ? 'soon' : item.time}`;

/** Each scenario's result against the label read off its lines (docs/real-model-meetings.md §2). */
async function compare(directory: string) {
  const results = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8')) as Result[];
  // A run's own labels, or else the ones kept with the scenes (a replay has none of its own).
  const own = join(directory, 'labels.json');
  const labels = JSON.parse(await readFile(await readFile(own).then(() => own, () => join(import.meta.dirname, 'meetings-real/labels.json')), 'utf8')) as
    Record<string, { appointments: Appointment[]; npcWrong?: string; note?: string }>;
  const rows: { id: string; kind: string; verdict: string; label: string; code: string; note: string }[] = [];
  for (const result of results) {
    const label = labels[result.id];
    if (!label) { rows.push({ id: result.id, kind: result.kind, verdict: '未标', label: '', code: '', note: '' }); continue; }
    const want = new Set(label.appointments.map(key)), got = new Set(result.appointments.map(key));
    const same = want.size === got.size && [...want].every(item => got.has(item));
    const verdict = result.errors.length ? '出错' : same ? '对' : !got.size ? '漏记' : '错记';
    rows.push({ id: result.id, kind: result.kind, verdict: verdict + (label.npcWrong ? '；NPC 说错' : ''),
      label: [...want].join(' ') || '无', code: [...got].join(' ') || '无', note: [label.note, label.npcWrong, ...result.errors].filter(Boolean).join('；') });
  }
  for (const row of rows) console.log(`${row.id}\t${row.kind}\t${row.verdict}\t标=${row.label}\t代码=${row.code}\t${row.note}`);
  const kinds = [...new Set(rows.map(row => row.kind))];
  for (const kind of kinds) {
    const of = rows.filter(row => row.kind === kind);
    const count = (word: string) => of.filter(row => row.verdict.startsWith(word)).length;
    console.log(`${kind}：${of.length} 段，对 ${count('对')}，漏记 ${count('漏记')}，错记 ${count('错记')}，出错 ${count('出错')}，NPC 说错 ${of.filter(row => row.verdict.includes('NPC 说错')).length}`);
  }
}

const compareDir = arg('--compare');
if (compareDir) { await compare(resolve(compareDir)); process.exit(0); }

const replayDir = arg('--replay');
const only = arg('--only')?.split(',');
const batch = arg('--batch') ?? 'A';
const scenarios = SCENARIOS.filter(scenario => only ? only.includes(scenario.id) : scenario.batch === batch);
if (!scenarios.length) throw new Error('没有要跑的场景');
let replay: Map<string, Call[]> | undefined;
if (replayDir) {
  replay = new Map();
  for (const line of (await readFile(join(resolve(replayDir), 'calls.jsonl'), 'utf8')).trim().split('\n')) {
    const call = JSON.parse(line) as Call;
    replay.set(`${call.id}/${call.lane}`, [...replay.get(`${call.id}/${call.lane}`) ?? [], call]);
  }
} else try { process.loadEnvFile(join(ROOT, '.env')); } catch { /* --env-file or the real environment */ }
// --dry answers everything with one fixed line, to check the harness itself for free.
const dry: ChatModel = { chat(_messages, handlers) {
  const content = JSON.stringify({ reply: '好啊，就这么说定了。', emotion: 'happy', options: ['好。'], remember: [], mood: 0, end: false });
  handlers?.onContent?.(content);
  return Promise.resolve({ content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 0, totalMs: 0 } });
} };
const paid = replay ? {} : process.argv.includes('--dry') ? { dialogue: dry, nightly: dry } : (() => {
  const config = modelConfigFromEnv();
  return { dialogue: new ModelClient(config), nightly: new ModelClient({ ...config, thinking: NIGHTLY_THINKING }) };
})();
const output = join(ROOT, '.runtime', `real-meetings-${replay ? 'replay-' : process.argv.includes('--dry') ? 'dry-' : ''}${only ? 'only' : batch}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(output, { recursive: true });
const calls = join(output, 'calls.jsonl');
const roster = new Roster({ directory: join(ROOT, 'data/npcs'), npcIds: SOCIAL_NPCS });
await roster.load();
const results: Result[] = [];
const jobs = Number(arg('--jobs') ?? 4);
let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < scenarios.length) {
    const scenario = scenarios[next++]!;
    const result = await run(scenario, roster, calls, paid, replay);
    results.push(result);
    console.log(`${scenario.id}：${result.errors.length ? `出错（${result.errors.join('；')}）` : '完成'}`);
  }
}));
results.sort((a, b) => scenarios.findIndex(item => item.id === a.id) - scenarios.findIndex(item => item.id === b.id));
await writeFile(join(output, 'transcripts.md'), `# 约定线真实模型对话（${batch} 批）\n\n只有原话，没有代码结果，先读这个标注。\n\n${transcript(scenarios, results)}`);
await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
const recorded = (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Call);
const used = usage(recorded);
await writeFile(join(output, 'usage.json'), JSON.stringify(used, null, 2));
console.log(JSON.stringify({ output, scenarios: scenarios.length, errors: results.filter(result => result.errors.length).length, ...used }));
