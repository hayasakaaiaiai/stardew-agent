/** Disposable backend process for the bridge's hard-crash recovery check. Never reads the user's .env or game saves. */
import { resolve } from 'node:path';
import { BridgeServer } from '../../src/bridge/server.ts';
import { Roster } from '../../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../../src/types.ts';
import { fakeModel } from '../helpers/bridge.ts';

const roster = new Roster({ directory: resolve(import.meta.dirname, '../../data/npcs'), npcIds: SOCIAL_NPCS });
await roster.load();
const server = await BridgeServer.start({ roster, model: fakeModel().model, port: 0, memoryDirectory: process.argv[2]! });
process.send?.({ port: server.port });
