import { parentPort, workerData } from 'node:worker_threads';
import { MemoryDatabase } from './database.ts';
import type { StoreCommands } from '../../types.ts';

if (!parentPort) throw new Error('The database entry point must run in a Worker');
const port = parentPort;
const database = new MemoryDatabase((workerData as { path: string }).path);
port.postMessage({ ready: true });

interface Request<K extends keyof StoreCommands = keyof StoreCommands> {
  id: number;
  operation: K;
  input: StoreCommands[K]['input'];
}

function dispatch(request: Request): unknown {
  // Only StoreService can send these private messages. Database methods validate domain invariants.
  switch (request.operation) {
    case 'root': return database.root(request.input as StoreCommands['root']['input']);
    case 'getCommit': {
      const input = request.input as StoreCommands['getCommit']['input'];
      return database.getCommit(input.lineageId, input.commitId);
    }
    case 'prepare': {
      const input = request.input as StoreCommands['prepare']['input'];
      return database.prepare(input.commitId, input.snapshot);
    }
    case 'confirm': {
      const input = request.input as StoreCommands['confirm']['input'];
      return database.confirm(input.lineageId, input.commitId);
    }
    case 'state': return database.state(request.input as StoreCommands['state']['input']);
    case 'search': return database.search(request.input as StoreCommands['search']['input']);
    case 'context': return database.context(request.input as StoreCommands['context']['input']);
    case 'validateRetirements': {
      const input = request.input as StoreCommands['validateRetirements']['input'];
      return database.validateRetirements(input.scope, input.ids);
    }
    case 'consolidationInput': {
      const input = request.input as StoreCommands['consolidationInput']['input'];
      return database.consolidationInput(input.lineageId, input.commitId, input.npcIds);
    }
    case 'consolidate': return database.consolidate(request.input as StoreCommands['consolidate']['input']);
    case 'close': database.close(); return;
  }
}

port.on('message', (request: Request) => {
  try {
    port.postMessage({ id: request.id, ok: true, value: dispatch(request) });
    if (request.operation === 'close') port.close();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    port.postMessage({ id: request.id, ok: false, error: { message: failure.message,
      code: 'code' in failure ? String(failure.code) : 'STORE_ERROR' } });
  }
});
