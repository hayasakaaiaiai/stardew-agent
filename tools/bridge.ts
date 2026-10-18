/**
 * Starts the backend the SMAPI mod talks to (docs/game-bridge.md).
 *
 *   npm run bridge          # ws://127.0.0.1:47711, or NPC_BRIDGE_PORT
 */
import { join, resolve } from 'node:path';
import { BridgeServer } from '../src/bridge/server.ts';
import { ModelClient, modelConfigFromEnv } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';

const ROOT = resolve(import.meta.dirname, '..');
try { process.loadEnvFile(join(ROOT, '.env')); } catch { /* fall back to the real environment */ }

const roster = new Roster({ directory: join(ROOT, 'data/npcs'), npcIds: SOCIAL_NPCS });
const loaded = await roster.load();
for (const error of loaded.errors) console.error(`[roster] ${error.message}`);
const model = new ModelClient(modelConfigFromEnv());
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

const server = await BridgeServer.start({
  roster, model,
  port: Number(process.env.NPC_BRIDGE_PORT ?? 47711),
  log: (line) => console.log(`[${stamp()}] ${line}`),
});
console.log(`[${stamp()}] 后端已启动：ws://127.0.0.1:${server.port}，角色卡 ${loaded.loaded.length} 张，模型 ${model.config.model}（thinking=${model.config.thinking}）`);
console.log('启动游戏读档即可；按 Ctrl+C 停止。');

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
