import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nightlyConsolidator } from '../src/agent/nightly.ts';
import type { ChatMessage, Completion, ModelClient } from '../src/services/model/client.ts';
import { connect, harness, initial, openTalk, sleep, WORLD } from './helpers/bridge.ts';

function model(answer: (messages: ChatMessage[]) => unknown): ModelClient {
  return { async chat(messages: ChatMessage[]): Promise<Completion> {
    return { content: JSON.stringify(answer(messages)), reasoning: '', finishReason: 'stop', usage: null,
      timing: { firstReasoningMs: null, firstContentMs: 0, totalMs: 0 } };
  } } as ModelClient;
}

test('both listeners remember only after a shown receipt; save and backend restart keep each source exactly once', { timeout: 20000 }, async t => {
  const h = await harness(t);
  const first = '农场主养的小猫叫星糖。', second = '农场主在学做南瓜汤。';
  const nightly = nightlyConsolidator({ roster: h.roster, model: model(messages => ({ memories: [], retire: [], impression: '', plan: '',
    bubbles: [], letter: '', gift: false, share: messages[1]!.content.includes('## 你是谁\n- 阿比盖尔') ? first : second })) });
  const scenes = model(() => ({ lines: [{ speaker: 'a', text: '农场主养的小猫叫星糖。' },
    { speaker: 'b', text: '农场主在学做南瓜汤。' }], told: ['a', 'b'] }));
  const server = await h.start(nightly, undefined, scenes);
  const wire = await connect(server);
  const talk = async (npc: string, day: number) => {
    const from = wire.inbox.length;
    wire.send(openTalk(day, npc)); await wire.until('talk.reply', from);
    const system = h.fake.sent.at(-1)![0]!.content;
    wire.send({ type: 'talk.close', npc }); await wire.until('ack');
    return system;
  };
  await talk('Abigail', 1); await talk('Sebastian', 1);
  await sleep(wire);
  for (let i = 0; i < 400 && !h.logs.some(line => line.startsWith('夜间整合完成')); i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  let from = wire.inbox.length;
  const request = wire.send({ type: 'scene.request', npcs: ['Abigail', 'Sebastian'], world: { ...WORLD, date: { ...WORLD.date, day: 2 } } });
  await wire.until('scene.lines', from);
  assert.doesNotMatch(await talk('Abigail', 2), /塞巴斯蒂安跟我说/, 'a generated scene has not been displayed yet');
  from = wire.inbox.length;
  wire.send({ type: 'scene.shown', request: 99999, date: { ...WORLD.date, day: 2 } }); await wire.until('ack', from);
  assert.doesNotMatch(await talk('Sebastian', 2), /阿比盖尔跟我说/, 'an unknown request cannot create a memory');
  from = wire.inbox.length;
  const shown = wire.send({ type: 'scene.shown', request: request.seq, date: { ...WORLD.date, day: 2 } });
  await wire.until('ack', from);
  from = wire.inbox.length; wire.raw(shown); await wire.until('ack', from);
  const a = `塞巴斯蒂安跟我说："${second}"`, b = `阿比盖尔跟我说："${first}"`;
  assert.equal((await talk('Abigail', 2)).split(a).length - 1, 1);
  assert.equal((await talk('Sebastian', 2)).split(b).length - 1, 1);
  const commit = await sleep(wire, 'news-saved', 2, 'saved-day-1');
  await wire.close(); await h.stop(server);
  const restarted = await connect(await h.start(), initial('new-load', 3, commit));
  for (const [npc, note] of [['Abigail', a], ['Sebastian', b]]) {
    const cursor = restarted.inbox.length;
    restarted.send(openTalk(3, npc)); await restarted.until('talk.reply', cursor);
    assert.equal(h.fake.sent.at(-1)![0]!.content.split(note!).length - 1, 1, `${npc}: saved after backend restart`);
    restarted.send({ type: 'talk.close', npc }); await restarted.until('ack');
  }
  assert.equal(h.logs.filter(line => line === `阿比盖尔记下了：${a}`).length, 1);
  assert.equal(h.logs.filter(line => line === `塞巴斯蒂安记下了：${b}`).length, 1);
});
