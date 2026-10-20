/** Isolated process for cleanup recovery tests; never reads .env or the normal game's memory. */
import { resolve } from 'node:path';
import { BridgeServer } from '../../src/bridge/server.ts';
import { Roster } from '../../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../../src/types.ts';
import { fakeModel } from '../helpers/bridge.ts';
const directory = process.argv[2]!;
const roster = new Roster({ directory: resolve(import.meta.dirname, '../../data/npcs'), npcIds: SOCIAL_NPCS });
await roster.load();
const server = await BridgeServer.start({ roster, model: fakeModel().model, memoryDirectory: directory, port: 0 });
process.send!({ port: server.port });
process.on('message', message => { if (message === 'stop') void server.close().then(() => process.exit(0)); });
