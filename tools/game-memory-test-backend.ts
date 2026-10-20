/** Child process used only by the real-game memory acceptance runner. */
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BridgeServer } from '../src/bridge/server.ts';
import { NIGHTLY_THINKING, nightlyConsolidator } from '../src/agent/nightly.ts';
import { ModelClient, modelConfigFromEnv, type ChatMessage, type StreamHandlers } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';

if (!process.send) throw new Error('Start this backend through test-game-memory.ps1');
const ROOT = resolve(import.meta.dirname, '..');
const config = JSON.parse((await readFile(process.argv[2]!, 'utf8')).replace(/^\uFEFF/, '')) as { RunDirectory: string; Nightly?: boolean };
process.loadEnvFile(join(ROOT, '.env'));
class RecordingModel extends ModelClient {
  kind: 'dialogue' | 'nightly' = 'dialogue';
  override async chat(messages: ChatMessage[], handlers: StreamHandlers = {}, options: { json?: boolean; signal?: AbortSignal } = {}) {
    const startedAt = new Date().toISOString();
    const completion = await super.chat(messages, handlers, options);
    appendFileSync(join(config.RunDirectory, 'model-calls.jsonl'), JSON.stringify({
      kind: this.kind, thinking: this.config.thinking, startedAt, finishedAt: new Date().toISOString(),
      messages, content: completion.content, timing: completion.timing, usage: completion.usage,
    }) + '\n');
    return completion;
  }
}
const model = new RecordingModel(modelConfigFromEnv());
const roster = new Roster({ directory: join(ROOT, 'data/npcs'), npcIds: SOCIAL_NPCS });
const loaded = await roster.load();
if (loaded.errors.length) throw new Error('角色卡加载失败');
const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);
const nightlyModel = new RecordingModel({ ...model.config, thinking: NIGHTLY_THINKING });
nightlyModel.kind = 'nightly';
const server = await BridgeServer.start({ roster, model, memoryDirectory: join(config.RunDirectory, 'memory'),
  ...(config.Nightly ? { consolidator: nightlyConsolidator({ roster, model: nightlyModel, log }) } : {}),
  port: Number(process.argv[3] ?? 0), log });
log(`验收后端：对话 thinking=${model.config.thinking}，夜间整合=${config.Nightly ? NIGHTLY_THINKING : 'disabled'}`);
process.send({ port: server.port, model: model.config.model, pid: process.pid, nightly: !!config.Nightly });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void server.close().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
};
process.on('message', (message: unknown) => { if (message === 'stop') stop(); });
process.on('disconnect', stop);
