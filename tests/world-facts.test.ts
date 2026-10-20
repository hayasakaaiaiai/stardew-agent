import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseModMessage, type WorldFlags } from '../src/bridge/protocol.ts';
import { worldFacts } from '../src/bridge/world.ts';
import { connect, harness, openTalk, WORLD } from './helpers/bridge.ts';

const FLAGS: WorldFlags = WORLD.flags;
const names = (npc: string) => ({ Abigail: '阿比盖尔', Krobus: '科罗布斯' })[npc] ?? npc;

test('the whole town knows whom the player married, is engaged to or lives with, and how many children there are', () => {
  assert.deepEqual(Object.keys(worldFacts(1, FLAGS)).filter(key => key.startsWith('玩家的')), [], 'nothing to say before it happens');
  assert.equal(worldFacts(1, { ...FLAGS, partner: null, children: 0 }).玩家的孩子, undefined);
  assert.equal(worldFacts(1, { ...FLAGS, partner: { npc: 'Abigail', status: 'engaged' } }, names).玩家的婚约, '和阿比盖尔订婚，婚礼在即');
  const married = worldFacts(2, { ...FLAGS, partner: { npc: 'Abigail', status: 'married' }, children: 2 }, names);
  assert.equal(married.玩家的配偶, '阿比盖尔，已搬到玩家的农场');
  assert.equal(married.玩家的孩子, '有 2 个孩子');
  const roommate = worldFacts(1, { ...FLAGS, partner: { npc: 'Krobus', status: 'roommate' } }, names);
  assert.equal(roommate.玩家的室友, '科罗布斯，住在玩家的农场');
  assert.equal(roommate.玩家的配偶, undefined);
});

test('household flags are optional, and checked when present', () => {
  const talk = (flags: Record<string, unknown>) => JSON.stringify({ ...openTalk(), lineageId: 'farm', loadNonce: 'load', seq: 1,
    world: { ...WORLD, flags: { ...FLAGS, ...flags } } });
  assert.equal(parseModMessage(talk({})).type, 'talk.open', 'an older Mod sends neither');
  assert.equal(parseModMessage(talk({ partner: { npc: 'Abigail', status: 'married' }, children: 1 })).type, 'talk.open');
  for (const bad of [{ partner: { npc: 'Abigail', status: 'dating' } }, { partner: { npc: '', status: 'married' } },
    { partner: 'Abigail' }, { children: -1 }, { children: 1.5 }])
    assert.throws(() => parseModMessage(talk(bad)), /flags/);
});

test('every NPC hears the household facts under the card’s name for the partner', { timeout: 10000 }, async t => {
  const h = await harness(t); const wire = await connect(await h.start());
  wire.send({ ...openTalk(1, 'Pierre'), world: { ...WORLD, flags: { ...FLAGS, partner: { npc: 'Abigail', status: 'married' }, children: 1 } } });
  await wire.until('talk.reply');
  const system = h.fake.sent.at(-1)![0]!.content;
  assert.match(system, /\n  - 玩家的配偶：阿比盖尔，已搬到玩家的农场\n  - 玩家的孩子：有 1 个孩子/);
});
