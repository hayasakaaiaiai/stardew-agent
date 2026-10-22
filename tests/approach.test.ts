import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approachHearts } from '../src/agent/approach.ts';
import { NIGHTLY_HINT, NIGHTLY_RULES, nightlyConsolidator, parseNightly } from '../src/agent/nightly.ts';
import type { BackendMessage } from '../src/bridge/protocol.ts';
import type { ChatMessage, Completion, ModelClient } from '../src/services/model/client.ts';
import type { DayEntry, NpcContext, NpcState, RecallResult } from '../src/types.ts';
import { connect, harness, initial, openTalk, sleep } from './helpers/bridge.ts';

const QUOTE = '农场主说："明天一起做紫色风筝吧。"\n我说："好啊，明天山上见。"';
const YESTERDAY = 31 * 1440 + 600;

function context(change: { state?: NpcState; memories?: Partial<RecallResult>[]; today?: DayEntry[] } = {}): Pick<NpcContext, 'state' | 'memories' | 'today'> {
  return {
    state: change.state ?? { day: 31, plan: '想问农场主风筝的事', seek: true },
    memories: (change.memories ?? [{}]).map(memory => ({ text: QUOTE, importance: 3, gameTime: YESTERDAY, ...memory }) as RecallResult),
    today: change.today ?? [],
  };
}

test('the nightly rules ask for seek, and only a literal true counts', () => {
  assert.match(NIGHTLY_RULES, /- seek：明天在镇上碰到农场主时/);
  assert.match(NIGHTLY_RULES, /"plan":"……","seek":false,/);
  assert.match(NIGHTLY_HINT, /plan、seek、/);
  const seek = (value: unknown) => parseNightly(JSON.stringify({ memories: [], impression: '好', plan: '想问风筝', ...(value === undefined ? {} : { seek: value }) }))!.seek;
  assert.equal(seek(true), true);
  for (const value of [false, undefined, 'true', 1, null]) assert.equal(seek(value), false, JSON.stringify(value));
});

test('an NPC walks over only the day after choosing to, with a usable plan, a quoted memory and nothing said yet', () => {
  assert.equal(approachHearts(context(), 32), 0);
  const never: Parameters<typeof context>[0][] = [
    { state: { day: 31, plan: '想问农场主风筝的事', seek: false } },
    { state: { day: 31, plan: '想问农场主风筝的事' } },
    { state: { day: 31, plan: '想问农场主风筝的事', seek: 'true' } },
    { state: { day: 30, plan: '想问农场主风筝的事', seek: true } },
    { state: { day: 31, plan: '', seek: true } },
    { state: { day: 31, plan: '长'.repeat(101), seek: true } },
    { memories: [] },
    { memories: [{ text: '农场主想做风筝' }] },
    { memories: [{ gameTime: YESTERDAY - 1440 }] },
    { today: [{ seq: 3, gameTime: 32 * 1440 + 500, changes: [{ npcId: 'abigail', log: { player: '早', npc: '早啊。' } }] }] },
  ];
  for (const item of never) assert.equal(approachHearts(context(item), 32), undefined, JSON.stringify(item));
  const heard: DayEntry = { seq: 2, gameTime: 32 * 1440 + 540, changes: [{ npcId: 'abigail', log: { gift: { item: '紫水晶' } } }] };
  assert.equal(approachHearts(context({ today: [heard] }), 32), 0, 'a gift or news is not a conversation');
});

test("the hearts needed follow recall's importance floor, so the opening can bring the plan up", () => {
  const hearts = (importance: number) => approachHearts(context({ memories: [{ importance }] }), 32);
  assert.deepEqual([5, 4, 3, 2, 1].map(hearts), [0, 0, 0, 5, 8]);
  assert.equal(approachHearts(context({ memories: [{ importance: 1 }, { importance: 2 }, { importance: 4, gameTime: YESTERDAY - 1440 }] }), 32), 5,
    'the best memory from yesterday decides');
});

const nightly = (content: Record<string, Record<string, unknown>>) => ({
  async chat(messages: ChatMessage[]): Promise<Completion> {
    const npc = Object.keys(content).find(name => messages[1]!.content.includes(`- ${name}，`))!;
    const output = { retire: [], impression: '', bubbles: [], letter: '', gift: false, share: '', ...content[npc] };
    return { content: JSON.stringify(output), reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
  },
}) as unknown as ModelClient;

type Approach = Extract<BackendMessage, { type: 'day.approach' }>;

test('the Mod learns who walks over after the night, not after talking today, and the list follows the save', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const model = nightly({
    阿比盖尔: { memories: [{ sources: ['t2'], importance: 4 }], plan: '想问农场主风筝做不做', seek: true },
    山姆: { memories: [{ sources: ['t2'], importance: 2 }], plan: '再问问农场主来不来听排练', seek: true },
    潘妮: { memories: [{ sources: ['t2'], importance: 4 }], plan: '把书架整理好', seek: false },
  });
  const server = await h.start(nightlyConsolidator({ roster: h.roster, model }));
  let wire = await connect(server);
  for (const npc of ['Abigail', 'Sam', 'Penny']) {
    wire.send(openTalk(1, npc)); await wire.until('talk.reply');
    wire.send({ type: 'talk.say', npc, text: '明天见' }); await wire.until('talk.reply');
  }
  const approaches = (from: number) => wire.inbox.slice(from).filter((item): item is Approach => item.type === 'day.approach').map(item => item.npcs);
  const waitFor = async (from: number, expected: Record<string, number>) => {
    for (let i = 0; i < 300 && !approaches(from).some(npcs => JSON.stringify(npcs) === JSON.stringify(expected)); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(approaches(from).at(-1), expected);
  };
  assert.deepEqual(approaches(0), [{}], 'nobody on the first day');
  const calls = h.fake.sent.length;
  const commit = await sleep(wire);
  await waitFor(0, { abigail: 0, sam: 5 });
  assert.ok(h.logs.includes('今天想主动找农场主的：abigail（0 心起）、sam（5 心起）'));
  assert.equal(h.fake.sent.length, calls, 'deciding who walks over calls no model');

  wire.send(openTalk(2, 'Abigail')); await wire.until('talk.reply');
  const cursor = wire.cursor();
  await wire.close();
  wire = await connect(server, initial(), cursor);
  await waitFor(0, { sam: 5 });

  wire.send({ type: 'title.returned' }); await wire.until('ack'); await wire.close();
  wire = await connect(server, initial('load-2', 2, commit));
  await waitFor(0, { abigail: 0, sam: 5 });
  assert.equal(approaches(0).length, 1, 'a reload without saving brings the walk back once');
  await wire.close();
});
