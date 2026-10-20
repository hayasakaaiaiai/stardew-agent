/** Child process used only by the real-game memory acceptance runner. */
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BridgeServer } from '../src/bridge/server.ts';
import { ModelClient, modelConfigFromEnv, type ChatMessage, type StreamHandlers } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';

if (!process.send) throw new Error('Start this backend through test-game-memory.ps1');
const ROOT = resolve(import.meta.dirname, '..');
const config = JSON.parse((await readFile(process.argv[2]!, 'utf8')).replace(/^\uFEFF/, '')) as { RunDirectory: string };
process.loadEnvFile(join(ROOT, '.env'));
class RecordingModel extends ModelClient {
  override async chat(messages: ChatMessage[], handlers: StreamHandlers = {}, options: { json?: boolean; signal?: AbortSignal } = {}) {
    const completion = await super.chat(messages, handlers, options);
    appendFileSync(join(config.RunDirectory, 'model-calls.jsonl'), JSON.stringify({
      messages, content: completion.content, timing: completion.timing, usage: completion.usage,
    }) + '\n');
    return completion;
  }
}
const model = new RecordingModel(modelConfigFromEnv());
const roster = new Roster({ directory: join(ROOT, 'data/npcs'), npcIds: SOCIAL_NPCS });
const loaded = await roster.load();
if (loaded.errors.length) throw new Error('角色卡加载失败');
const server = await BridgeServer.start({ roster, model, memoryDirectory: join(config.RunDirectory, 'memory'),
  port: Number(process.argv[3] ?? 0), log: line => console.log(`[${new Date().toISOString()}] ${line}`) });
process.send({ port: server.port, model: model.config.model, pid: process.pid });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void server.close().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
};
process.on('message', (message: unknown) => { if (message === 'stop') stop(); });
process.on('disconnect', stop);
