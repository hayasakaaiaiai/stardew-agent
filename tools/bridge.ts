/**
 * Starts the backend the SMAPI mod (docs/game-bridge.md) and the companion robot (docs/companion-device.md) talk to.
 *
 *   npm run bridge          # mod: ws://127.0.0.1:47711 (NPC_BRIDGE_PORT); robot: port 47712 on the LAN (NPC_DEVICE_PORT)
 *
 * Type /robot to pick a save and an NPC for the robot; /help lists the commands.
 */
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { NIGHTLY_THINKING, nightlyConsolidator } from '../src/agent/nightly.ts';
import { BridgeServer } from '../src/bridge/server.ts';
import { PortraitPacks } from '../src/companion/assets.ts';
import { CompanionError, CompanionService } from '../src/companion/service.ts';
import { OTA_PATH } from '../src/companion/server.ts';
import { gameDate } from '../src/companion/session.ts';
import { DashScopeSpeech, dashScopeConfigFromEnv, SilentSpeech } from '../src/companion/voice.ts';
import { ModelClient, modelConfigFromEnv, type Thinking } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';

const ROOT = resolve(import.meta.dirname, '..');
try { process.loadEnvFile(join(ROOT, '.env')); } catch { /* fall back to the real environment */ }

const roster = new Roster({ directory: join(ROOT, 'data/npcs'), npcIds: SOCIAL_NPCS });
const loaded = await roster.load();
for (const error of loaded.errors) console.error(`[roster] ${error.message}`);
const model = new ModelClient(modelConfigFromEnv());
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (line: string) => console.log(`[${stamp()}] ${line}`);
const nightlyModel = new ModelClient({ ...model.config, thinking: NIGHTLY_THINKING });

// Spoken replies wait on the model, so voice uses less reasoning than the game (docs/companion-device.md §6).
const voiceThinking = (process.env.NPC_VOICE_THINKING?.trim() || 'low') as Thinking;
if (!['disabled', 'low', 'high', 'max'].includes(voiceThinking)) throw new Error('NPC_VOICE_THINKING must be disabled, low, high or max');
const voiceModel = new ModelClient({ ...model.config, thinking: voiceThinking });
const voices = JSON.parse(await readFile(join(ROOT, 'data/voices.json'), 'utf8')) as { default: string; npcs: Record<string, string> };
const dashScope = dashScopeConfigFromEnv();
const speech = dashScope ? new DashScopeSpeech(dashScope) : new SilentSpeech();

const companion = await CompanionService.start({
  dataDirectory: join(ROOT, '.runtime/chat'),
  roster, model: voiceModel, speech, npcIds: SOCIAL_NPCS,
  voiceFor: (npcId) => voices.npcs[npcId] ?? voices.default,
  port: Number(process.env.NPC_DEVICE_PORT ?? 47712),
  faces: new PortraitPacks(join(ROOT, '.runtime/companion/assets')),
  log,
});
const server = await BridgeServer.start({
  roster, model,
  memoryDirectory: join(ROOT, '.runtime', 'game'),
  consolidator: nightlyConsolidator({ roster, model: nightlyModel, log }),
  port: Number(process.env.NPC_BRIDGE_PORT ?? 47711),
  log,
  onSaveLoaded: (lineageId) => companion.gameLoaded(lineageId),
  onDisconnected: () => companion.gameClosed(),
});

log(`后端已启动：游戏 ws://127.0.0.1:${server.port}，角色卡 ${loaded.loaded.length} 张，模型 ${model.config.model}（游戏 thinking=${model.config.thinking}，夜间整合 thinking=${NIGHTLY_THINKING}，机器人 thinking=${voiceThinking}）`);
log(`机器人：语音 ${speech.name}。配置地址填下面任意一个（机器人和电脑要在同一个网络）：`);
for (const { name, address } of lanAddresses()) console.log(`    http://${address}:${companion.port}${OTA_PATH}  （网卡 ${name}）`);
console.log('输入 /robot 选择存档和角色，/help 查看命令；按 Ctrl+C 停止。');

const HELP = `/robot          选择存档和角色，让机器人开始
/robot stop     结束机器人这次的聊天，写回存档
/robot pair     两分钟内允许一台新机器人配对
/robot face     重新给机器人下发当前角色的头像
/help           显示这些命令`;

const rl = createInterface({ input: process.stdin, output: process.stdout });
// One queue for commands and the picker's answers, so lines typed or piped ahead are taken in order.
const lines = rl[Symbol.asyncIterator]();
const ask = async (prompt: string) => {
  process.stdout.write(prompt);
  const next = await lines.next();
  return next.done ? '' : String(next.value).trim();
};
void (async () => {
  for (let next = await lines.next(); !next.done; next = await lines.next()) {
    await command(String(next.value).trim()).catch((error: unknown) => {
      log(error instanceof CompanionError ? error.message : `出错：${error instanceof Error ? error.message : String(error)}`);
    });
  }
})();

async function command(input: string) {
  if (!input) return;
  if (input === '/help') console.log(HELP);
  else if (input === '/robot stop') { if (!await companion.stop()) log('机器人没有在聊天，或者这次没有说过话'); }
  else if (input === '/robot pair') {
    companion.pairing.open(120_000);
    log('两分钟内，第一台请求连接的新机器人会被允许。现在重启机器人。');
  } else if (input === '/robot face') {
    if (!await companion.refreshFace()) log('机器人没有连着');
  } else if (input === '/robot') await pick();
  else console.log('未知命令，/help 查看命令');
}

async function pick() {
  const saves = await companion.saves();
  if (!saves.length) {
    log('还没有可用的存档。命令行聊天的存档要先 /sleep 存一次档才会出现在这里。');
    return;
  }
  const seasons = { spring: '春', summer: '夏', fall: '秋', winter: '冬' } as const;
  console.log(saves.map((save, i) => {
    const date = gameDate(save.dayEnded);
    return `  ${i + 1}) ${save.label} · ${save.player.name}，${save.player.farm}农场 · 第 ${date.year} 年${seasons[date.season]} ${date.day} 日`;
  }).join('\n'));
  const save = saves[Number(await ask('选择存档（编号）：')) - 1];
  if (!save) { log('没有这个编号'); return; }
  const answer = (await ask('选择角色（名字或 id，比如 海莉 / haley）：')).toLowerCase();
  const npcId = SOCIAL_NPCS.find((id) => id === answer || roster.get(id).name === answer);
  if (!npcId) { log(`没有“${answer}”这个角色`); return; }
  const session = await companion.begin(save, npcId);
  log(`机器人现在是${session.npcName}（存档“${save.label}”）。机器人连上后${session.npcName}会先开口。`);
}

/**
 * Addresses the robot could reach, labelled with the interface. Proxy and VPN adapters are left out: the robot
 * cannot reach them, e.g. a proxy's 198.18.0.0/15 TUN address or WSL's virtual switch.
 */
function lanAddresses(): { name: string; address: string }[] {
  const all = Object.entries(networkInterfaces()).flatMap(([name, items]) => (items ?? [])
    .filter((item) => item.family === 'IPv4' && !item.internal).map((item) => ({ name, address: item.address })));
  const real = all.filter(({ name, address }) => !/^(utun|tun|tap|docker|veth|br-|vEthernet|wg|tailscale|zt)/i.test(name)
    && !/^198\.1[89]\./.test(address));
  const shown = real.length ? real : all;
  return shown.length ? shown : [{ name: 'lo', address: '127.0.0.1' }];
}

const stop = async () => {
  rl.close();
  await companion.close();
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
