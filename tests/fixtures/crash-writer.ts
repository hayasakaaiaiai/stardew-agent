import { join } from 'node:path';
import { createRuntime } from '../../src/index.ts';

const directory = process.argv[2]!;
const runtime = await createRuntime({ databasePath: join(directory, 'memory.sqlite'), journalDirectory: join(directory, 'scratch'), npcIds: ['abigail', 'sebastian'] });
const save = await runtime.ctx.saves.load({ lineageId: 'crash-farm', loadNonce: 'same-running-game', day: 1 });
await save.record({ seq: 1, gameTime: 1441, changes: [{ npcId: 'abigail', memories: [{ text: '进程崩溃之前聊过海边' }] }] });
process.send!({ baseCommitId: save.ledger.head.id });
process.on('message', () => {});
