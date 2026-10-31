/**
 * Dialogue prototype CLI (docs/dialogue-prototype.md §6).
 *
 *   node tools/chat.ts abigail [--scenario default] [--hearts 4] [--seen 1,2] [--relation friend]
 *                              [--save cli] [--fresh] [--no-memory]
 *   node tools/chat.ts --probe abigail,shane      # or --probe all; probes never use memory
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs, styleText } from 'node:util';
import {
  type DialogueMeta, type Exchange, OPENING_LINE, runTurn, type Standing, type TurnResult, weekday, type WorldState,
} from '../src/agent/dialogue.ts';
import { NIGHTLY_THINKING, nightlyConsolidator } from '../src/agent/nightly.ts';
import { ModelClient, modelConfigFromEnv } from '../src/services/model/client.ts';
import { type Relation, Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';
import { absoluteDay, ChatSave, dateOf, minutesOf } from './chat/session.ts';

const ROOT = resolve(import.meta.dirname, '..');
const CARDS = join(ROOT, 'data/npcs');
const SCENARIOS = join(ROOT, 'tools/chat/scenarios');
const PROBES = join(ROOT, 'tools/chat/probes');
const TRANSCRIPTS = join(ROOT, '.runtime/transcripts');
const CHAT_DATA = join(ROOT, '.runtime/chat');
const RELATIONS = new Set<Relation>(['stranger', 'friend', 'dating', 'engaged', 'married', 'roommate']);
const EMOTION_LABEL: Record<DialogueMeta['emotion'], string> = {
  neutral: '平静', happy: '开心', sad: '难过', blush: '害羞', angry: '生气', special: '特殊', surprised: '吃惊',
};
// styleText only colors a terminal; piped output and NO_COLOR stay plain.
const paint = {
  title: (text: string) => styleText('bold', text),
  npc: (text: string) => styleText(['bold', 'cyan'], text),
  you: (text: string) => styleText(['bold', 'green'], text),
  dim: (text: string) => styleText('dim', text),
  warn: (text: string) => styleText('yellow', text),
};

interface Scenario {
  description: string;
  world: WorldState;
  /** Per-NPC location overrides, e.g. Krobus is always in the sewer. */
  locations?: Record<string, string>;
  standing: { hearts: number; seen: string[]; relation: Relation };
}

interface Turn {
  playerLine: string;
  standing: Standing;
  world: WorldState;
  expectation?: string;
  result: TurnResult;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    scenario: { type: 'string', default: 'default' },
    hearts: { type: 'string' },
    seen: { type: 'string' },
    relation: { type: 'string' },
    probe: { type: 'string' },
    save: { type: 'string', default: 'cli' },
    fresh: { type: 'boolean' },
    'no-memory': { type: 'boolean' },
  },
});

try { process.loadEnvFile(join(ROOT, '.env')); } catch { /* fall back to the real environment */ }
const model = new ModelClient(modelConfigFromEnv());
const npcIds: readonly string[] = SOCIAL_NPCS;
const roster = new Roster({ directory: CARDS, npcIds });
await loadRoster();

if (values.probe) await probe(values.probe === 'all' ? npcIds : values.probe.split(','));
else await chat(positionals[0]);

async function loadRoster() {
  const result = await roster.load();
  for (const warning of result.warnings) console.warn(`[roster] ${warning}`);
  for (const error of result.errors) console.error(`[roster] ${error.message}`);
  if (!result.loaded.length) throw new Error('No character cards loaded');
}

async function loadScenario(name: string): Promise<Scenario> {
  return JSON.parse(await readFile(join(SCENARIOS, `${name}.json`), 'utf8')) as Scenario;
}

function worldFor(scenario: Scenario, npcId: string): WorldState {
  const location = scenario.locations?.[npcId];
  return { ...scenario.world, facts: { ...scenario.world.facts }, ...(location ? { location } : {}) };
}

function standingFrom(base: Scenario['standing'], overrides: { hearts?: string | undefined; seen?: string | undefined; relation?: string | undefined }): Standing {
  const relation = (overrides.relation ?? base.relation) as Relation;
  if (!RELATIONS.has(relation)) throw new Error(`relation must be one of ${[...RELATIONS].join(', ')}`);
  return {
    hearts: overrides.hearts === undefined ? base.hearts : Number(overrides.hearts),
    seenEvents: new Set(overrides.seen === undefined ? base.seen : overrides.seen.split(',').filter(Boolean)),
    relation,
  };
}

async function chat(npcId: string | undefined) {
  if (!npcId || !roster.has(npcId)) throw new Error(`Usage: node tools/chat.ts <npc>; known: ${npcIds.join(' ')}`);
  const scenario = await loadScenario(values.scenario!);
  let world = worldFor(scenario, npcId);
  let standing = standingFrom(scenario.standing, values);
  let history: Exchange[] = [];
  let last: TurnResult | undefined;
  const turns: Turn[] = [];
  const name = () => roster.get(npcId).name;

  // With memory on, the save decides the date and today's conversation lives in the memory system.
  const note = (line: string) => console.log(paint.dim(`（${line}）`));
  const save = values['no-memory'] ? undefined : await ChatSave.open({
    directory: CHAT_DATA, name: values.save!, fresh: values.fresh ?? false, startDay: absoluteDay(world), npcIds,
    consolidator: nightlyConsolidator({ roster, model: new ModelClient({ ...model.config, thinking: NIGHTLY_THINKING }), log: note }),
    log: note,
  });
  const syncDate = () => { if (save) world = { ...world, ...dateOf(save.day) }; };
  syncDate();
  const memory = save?.memory(npcId, () => absoluteDay(world) * 1440 + minutesOf(world.time), () => world.player);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // An iterator buffers lines that arrive while a reply is generating, so piped input works too.
  const lines = rl[Symbol.asyncIterator]();
  const ask = async () => {
    process.stdout.write('> ');
    const next = await lines.next();
    return next.done ? undefined : String(next.value);
  };

  console.log(paint.title(`${name()}（${npcId}）· ${describeDate(world)} · ${describeStanding(standing)}`));
  console.log(paint.dim(save ? `记忆：存档“${values.save}”。/sleep 存档并进入下一天，/rollback 不存档退回上次存档。` : '记忆：关闭。'));
  console.log(paint.dim('输入数字选选项，直接打字就是自己说；/help 查看命令。') + '\n');

  const say = async (playerLine: string) => {
    let started = false;
    let thinking = false;
    let result: TurnResult;
    try {
      result = await runTurn({ roster, model, ...(memory ? { memory } : {}) }, { npcId, world, standing, history, playerLine }, {
      onReasoning: () => {
        if (!thinking && !started) process.stdout.write(paint.dim('（思考中…）'));
        thinking = true;
      },
      onReply: (text) => {
        if (!started) process.stdout.write(`${thinking ? '\r\x1b[K' : ''}${paint.npc(`${name()}：`)}`);
        started = true;
        process.stdout.write(text);
      },
      });
    } catch (error) {
      // A failed turn is not recorded, so the conversation can simply continue.
      console.log('\n' + paint.warn(`  ⚠ 这一轮请求失败，没有记下来：${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (!started) process.stdout.write(`${thinking ? '\r\x1b[K' : ''}${paint.npc(`${name()}：`)}${result.reply}`);
    process.stdout.write('\n');
    printMeta(result);
    history = [...history, { player: playerLine, npc: result.reply }];
    turns.push({ playerLine, standing, world, result });
    last = result;
  };

  const recovered = save?.todayCount(npcId) ?? 0;
  if (recovered && memory) {
    const today = (await memory.context('', standing)).today ?? [];
    console.log(paint.dim(`（恢复了今天和${name()}的 ${recovered} 轮对话）`));
    const latest = today.at(-1);
    if (latest) console.log(`${paint.npc(`${name()}：`)}${latest.npc}`);
  } else {
    await say(OPENING_LINE);
  }
  try {
    for (;;) {
      const raw = await ask();
      if (raw === undefined) break;
      const input = raw.trim();
      if (!input) continue;
      if (!process.stdin.isTTY) console.log(input);
      if (input.startsWith('/')) {
        const [command, ...args] = input.slice(1).split(/\s+/);
        const arg = args.join(' ');
        if (command === 'quit' || command === 'exit') break;
        else if (command === 'help') console.log(HELP);
        else if (command === 'hearts') { standing = { ...standing, hearts: Number(arg) }; console.log(describeStanding(standing)); }
        else if (command === 'seen' || command === 'unseen') {
          const seen = new Set(standing.seenEvents);
          for (const id of args) command === 'seen' ? seen.add(id) : seen.delete(id);
          standing = { ...standing, seenEvents: seen };
          console.log(describeStanding(standing));
        } else if (command === 'relation') { standing = standingFrom({ ...scenario.standing, hearts: standing.hearts, seen: [...standing.seenEvents] }, { relation: arg }); console.log(describeStanding(standing)); }
        else if (command === 'world') {
          if (save && args.some((pair) => /^(day|season|year)=/.test(pair))) console.log('记忆模式下日期由存档决定，用 /sleep 进入下一天');
          else { world = applyWorld(world, args); console.log(world); }
        } else if (command === 'prompt') console.log(last ? last.messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n') : '还没有发出请求');
        else if (command === 'stats') console.log(summarize(turns.map((t) => t.result)));
        else if (command === 'reload') await loadRoster();
        else if (command === 'save') console.log(`已保存：${await saveTranscript(npcId, scenario, turns)}`);
        else if (command === 'reset') {
          if (save) console.log('记忆模式下今天的对话已经记下了；要丢弃今天的内容用 /rollback');
          else { history = []; await say(OPENING_LINE); }
        } else if (command === 'sleep' || command === 'rollback') {
          if (!save) { console.log('记忆已关闭（--no-memory）'); continue; }
          if (command === 'sleep') await save.sleep();
          else await save.rollback();
          world = { ...world, time: scenario.world.time };
          syncDate();
          console.log(paint.dim(command === 'sleep' ? `（存档完成，进入${describeDate(world)}）` : `（没有存档，回到上次存档：${describeDate(world)}）`));
          await say(OPENING_LINE);
        } else if (command === 'memories') {
          if (!memory) { console.log('记忆已关闭（--no-memory）'); continue; }
          const recalled = await memory.context(arg, standing);
          if (recalled.tone) console.log(`（${recalled.tone}）`);
          if (recalled.summary) console.log(recalled.summary);
          console.log(recalled.memories.length ? recalled.memories.map((m) => `- （${m.when}）${m.text}`).join('\n') : '（没有召回到记忆）');
        } else console.log('未知命令，/help 查看命令');
        continue;
      }
      const choice = /^[1-3]$/.test(input) && last ? last.meta.options[Number(input) - 1] : undefined;
      if (choice) console.log(`${paint.you('你：')}${choice}`);
      await say(choice ?? input);
    }
  } finally {
    rl.close();
    if (turns.length) {
      console.log(summarize(turns.map((t) => t.result)));
      console.log(`对话记录：${await saveTranscript(npcId, scenario, turns)}`);
    }
    // Keeps today's unsaved conversation in the journal, like a backend restart.
    await save?.close();
  }
}

function describeDate(world: WorldState): string {
  const seasons = { spring: '春季', summer: '夏季', fall: '秋季', winter: '冬季' } as const;
  return `第 ${world.year} 年${seasons[world.season]} ${world.day} 日（${weekday(world.day)}）${world.time}`;
}

async function probe(ids: readonly string[]) {
  for (const npcId of ids) {
    if (!roster.has(npcId)) throw new Error(`Unknown NPC "${npcId}"`);
    const file = join(PROBES, `${npcId}.md`);
    const text = await readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) { console.warn(`[probe] ${npcId}: no ${file}, skipped`); continue; }
    const scenarioName = /^场景：\s*(\S+)/m.exec(text)?.[1] ?? values.scenario!;
    const scenario = await loadScenario(scenarioName);
    const turns: Turn[] = [];
    console.log('\n' + paint.title(`== ${roster.get(npcId).name}（${npcId}）· 场景 ${scenarioName}`));
    for (const line of text.split('\n')) {
      const item = /^- (?:\[([^\]]*)\]\s*)?(.+?)(?:\s+\/\/\s*(.+))?$/.exec(line.trim());
      if (!item) continue;
      const overrides = parseOverrides(item[1] ?? '');
      const standing = standingFrom(scenario.standing, overrides);
      const world = applyWorld(worldFor(scenario, npcId), overrides.world);
      const playerLine = item[2]!;
      let result: TurnResult;
      try {
        result = await runTurn({ roster, model }, { npcId, world, standing, history: [], playerLine });
      } catch (error) {
        console.log(`- ${playerLine}\n` + paint.warn(`  ⚠ 请求失败：${error instanceof Error ? error.message : String(error)}`));
        continue;
      }
      turns.push({ playerLine, standing, world, ...(item[3] ? { expectation: item[3] } : {}), result });
      console.log(`- ${playerLine}\n  ${result.reply}${result.metaOk ? '' : paint.warn('  ⚠ 格式解析失败')}`);
    }
    console.log(summarize(turns.map((t) => t.result)));
    console.log(`对话记录：${await saveTranscript(npcId, { ...scenario, description: `${scenarioName} · ${scenario.description}` }, turns)}`);
  }
}

function parseOverrides(spec: string) {
  const out: { hearts?: string; seen?: string; relation?: string; world: string[] } = { world: [] };
  for (const pair of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [key, value = ''] = pair.split('=');
    if (key === 'hearts') out.hearts = value;
    else if (key === 'seen') out.seen = value.replaceAll('+', ',');
    else if (key === 'relation') out.relation = value;
    else out.world.push(pair);
  }
  return out;
}

/** `key=value` edits: day, season, year, time, weather, location, or fact:名称=内容 (empty value deletes). */
function applyWorld(world: WorldState, pairs: string[]): WorldState {
  const next: WorldState = { ...world, facts: { ...world.facts } };
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);
    if (key.startsWith('fact:')) {
      if (value) next.facts[key.slice(5)] = value;
      else delete next.facts[key.slice(5)];
    } else if (key === 'day' || key === 'year') next[key] = Number(value);
    else if (key === 'season') next.season = value as WorldState['season'];
    else if (key === 'time' || key === 'weather' || key === 'location') next[key] = value;
    else throw new Error(`Unknown world key "${key}"`);
  }
  return next;
}

function describeStanding(standing: Standing): string {
  const seen = [...standing.seenEvents];
  return `${standing.hearts} 心 · ${standing.relation} · 已看事件 ${seen.length ? seen.join(', ') : '无'}`;
}

function printMeta(result: TurnResult) {
  const { meta, metaOk } = result;
  const options = meta.options.map((option, i) => `${i + 1}) ${option}`).join('  ');
  console.log(`  ${paint.dim(`[${EMOTION_LABEL[meta.emotion]}]`)} ${options}${metaOk ? '' : paint.warn('  ⚠ 格式解析失败')}`);
  if (meta.remember.length) console.log(paint.dim(`  记住：${meta.remember.map((m) => `${m.text}（${m.importance}）`).join('；')}`));
  if (meta.mood) console.log(paint.dim(`  好感变化：${meta.mood > 0 ? '+' : ''}${meta.mood}（游戏里每档 10 点，见 docs/npc-friendship.md）`));
  if (meta.end) console.log(paint.dim('  （对方想结束对话）'));
  console.log(paint.dim(`  ${turnStats(result)}`));
}

function turnStats({ timing, usage, attempts }: TurnResult): string {
  const seconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`);
  const tokens = usage
    ? `输入 ${usage.inputTokens}（缓存 ${usage.cachedInputTokens ?? '—'}）· 输出 ${usage.outputTokens}（推理 ${usage.reasoningTokens ?? 0}）`
    : '无用量数据';
  return `首字 ${seconds(timing.firstReplyMs)} · 总 ${seconds(timing.totalMs)} · ${tokens}${attempts.length > 1 ? ` · 重试 ${attempts.length - 1} 次` : ''}`;
}

function summarize(results: TurnResult[]): string {
  if (!results.length) return '还没有对话';
  const firsts = results.map((r) => r.timing.firstReplyMs).filter((ms): ms is number => ms !== null);
  const totals = results.map((r) => r.timing.totalMs);
  const usages = results.flatMap((r) => (r.usage ? [r.usage] : []));
  const retries = results.filter((r) => r.attempts.length > 1).length;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const input = sum(usages.map((u) => u.inputTokens));
  const cached = sum(usages.map((u) => u.cachedInputTokens ?? 0));
  const okCount = results.filter((r) => r.metaOk).length;
  return [
    `共 ${results.length} 轮`,
    `格式成功 ${okCount}/${results.length}（其中重试 ${retries} 轮）`,
    `首字中位数 ${(percentile(firsts, 0.5) / 1000).toFixed(1)}s`,
    `总耗时 P95 ${(percentile(totals, 0.95) / 1000).toFixed(1)}s，超过 8s 的 ${totals.filter((ms) => ms > 8000).length} 轮`,
    `平均输入 ${Math.round(input / Math.max(1, usages.length))} token，缓存命中 ${input ? Math.round((cached / input) * 100) : 0}%`,
    `平均输出 ${Math.round(sum(usages.map((u) => u.outputTokens)) / Math.max(1, usages.length))} token`,
    `（推理 ${Math.round(sum(usages.map((u) => u.reasoningTokens ?? 0)) / Math.max(1, usages.length))}）`,
  ].join(' · ');
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

async function saveTranscript(npcId: string, scenario: Scenario, turns: Turn[]): Promise<string> {
  const card = roster.get(npcId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const lines = [
    `# 对话记录：${card.name}（${npcId}）`,
    '',
    `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
    `- 模型：${model.config.model}（thinking=${model.config.thinking}）`,
    `- 场景：${scenario.description}`,
    `- 汇总：${summarize(turns.map((t) => t.result))}`,
  ];
  turns.forEach((turn, i) => {
    const { result } = turn;
    lines.push(
      '', `## 第 ${i + 1} 轮`, '',
      `- 条件：${describeStanding(turn.standing)} · ${turn.world.location}`,
      ...(turn.expectation ? [`- 期望：${turn.expectation}`] : []),
      '', `**玩家**：${turn.playerLine}`, '', `**${card.name}**：${result.reply}`, '',
      `- 表情：${EMOTION_LABEL[result.meta.emotion]} · 选项：${result.meta.options.join(' / ')}${result.meta.end ? ' · 想结束对话' : ''}`,
      ...(result.meta.remember.length ? [`- 记住：${result.meta.remember.map((m) => `${m.text}（${m.importance}）`).join('；')}`] : []),
      ...(result.meta.mood ? [`- 好感变化：${result.meta.mood > 0 ? '+' : ''}${result.meta.mood}`] : []),
      `- ${turnStats(result)}${result.metaOk ? '' : ' · ⚠ 格式解析失败'}`,
      ...(result.metaOk ? [] : ['', '原始输出：', '', '```', result.attempts.at(-1)!.content, '```']),
      ...(result.attempts.at(-1)!.reasoning ? ['', '<details><summary>推理过程</summary>', '', result.attempts.at(-1)!.reasoning.trim(), '', '</details>'] : []),
    );
  });
  await mkdir(TRANSCRIPTS, { recursive: true });
  const path = join(TRANSCRIPTS, `${stamp}-${npcId}.md`);
  await writeFile(path, `${lines.join('\n')}\n`);
  return path;
}

const HELP = `命令：
  /hearts N            设置心数
  /seen 4 5、/unseen 4 标记事件看过 / 没看过
  /relation dating     关系：stranger friend dating engaged married roommate
  /world day=19 weather=下雨 fact:巴士=已修好   修改世界状态（空值删除事实）
  /prompt              打印上一次发出的完整 prompt
  /stats               本次会话的统计
  /reload              重新加载角色卡
  /reset               清空今天的对话并重新开场（仅 --no-memory）
  /sleep               存档、整合当天，进入下一天
  /rollback            不存档，退回上次存档
  /memories [话题]     查看现在能召回的记忆
  /save                保存对话记录
  /quit                退出（自动保存对话记录；今天没存档的对话下次启动会恢复）`;
