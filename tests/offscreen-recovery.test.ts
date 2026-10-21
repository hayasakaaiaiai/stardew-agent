import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nightlyConsolidator } from '../src/agent/nightly.ts';
import type { ChatMessage, Completion, ModelClient } from '../src/services/model/client.ts';
import { connect, harness, initial, openTalk, sleep, WORLD } from './helpers/bridge.ts';

function model(make: (messages: ChatMessage[]) => unknown): ModelClient {
  return { async chat(messages: ChatMessage[]) {
    return { content: JSON.stringify(make(messages)), reasoning: '', finishReason: 'stop', usage: null,
      timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } } as Completion;
  } } as ModelClient;
}

test('string memories reach a zero-heart NPC after save and backend restart; option and reply echoes do not', async t => {
  const h = await harness(t);
  const note = '测试说周末会给文森特做蓝色风筝。';
  const reply = '那孩子一定会高兴的。';
  h.fake.model.chat = async (messages) => {
    h.fake.sent.push(messages);
    return { content: JSON.stringify({ reply, emotion: 'happy', options: ['一', '二', '三'], mood: 0, end: false,
      remember: messages.at(-1)!.content.startsWith('我答应') ? [note, '一', reply, '   '] : [] }),
      reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
  };
  const server = await h.start();
  const wire = await connect(server);
  wire.send({ ...openTalk(1, 'Jodi'), hearts: 0 }); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Jodi', text: '我答应周末给文森特做蓝色风筝。' }); await wire.until('talk.reply');
  wire.send({ type: 'talk.close', npc: 'Jodi' }); await wire.until('ack');
  const commit = await sleep(wire);
  await wire.close(); await h.stop(server);
  const reload = await connect(await h.start(), initial('reload', 2, commit));
  reload.send({ ...openTalk(2, 'Jodi'), hearts: 0 }); await reload.until('talk.reply');
  const prompt = h.fake.sent.at(-1)![0]!.content;
  assert.match(prompt, /测试说周末会给文森特做蓝色风筝。/);
  assert.doesNotMatch(prompt, /那孩子一定会高兴的。/, 'a reply echoed as a string must not become a memory');
  assert.doesNotMatch(prompt, /\n- .*一(?:\n|$)/, 'an unchosen option must not become a memory');
  await reload.close();
});

test('offscreen receipts and both news hands survive same-load backend restart and a saved day without spreading again', { timeout: 20000 }, async t => {
  const h = await harness(t);
  const share = '测试的蓝色风筝叫云尾。';
  const nightly = nightlyConsolidator({ roster: h.roster, model: model(() => ({ memories: [], retire: [], impression: '',
    plan: '', bubbles: [], letter: '', gift: false, share })) });
  const server = await h.start(nightly);
  const wire = await connect(server);
  wire.send(openTalk()); await wire.until('talk.reply');
  const first = await sleep(wire);
  for (let i = 0; i < 400 && !h.logs.some(line => line.startsWith('夜间整合完成')); i++)
    await new Promise(done => setTimeout(done, 10));
  const hour = async (client: typeof wire, groups: string[][]) => {
    const from = client.inbox.length;
    const packet = client.send({ type: 'town.hour', groups, date: { ...WORLD.date, day: 2, time: 1800 } });
    await client.until('ack', from); return packet;
  };
  await hour(wire, [['Abigail', 'Gus']]);
  const second = await hour(wire, [['Gus', 'Pam']]);
  const lastSeq = wire.cursor();
  await wire.close(); await h.stop(server);
  const running = await h.start();
  const reload = await connect(running, wire.loaded, lastSeq);
  let from = reload.inbox.length;
  reload.raw(second); await reload.until('ack', from);
  await hour(reload, [['Abigail', 'Gus'], ['Gus', 'Pam'], ['Pam', 'Sam']]);
  assert.equal(h.logs.filter(line => line.startsWith('镇上传话：格斯记下了')).length, 1);
  assert.equal(h.logs.filter(line => line.startsWith('镇上传话：潘姆记下了')).length, 1);
  assert.equal(h.logs.filter(line => line.startsWith('镇上传话：山姆记下了')).length, 0);
  const saved = await sleep(reload, 'town-saved', 2, first.commitId);
  await reload.close(); await h.stop(running);
  const afterSave = await connect(await h.start(), initial('saved-reload', 3, saved));
  for (const [npc, source] of [['Gus', '阿比盖尔跟我说'], ['Pam', '格斯跟我说，阿比盖尔说过']]) {
    from = afterSave.inbox.length;
    afterSave.send(openTalk(3, npc)); await afterSave.until('talk.reply', from);
    const system = h.fake.sent.at(-1)![0]!.content;
    assert.equal(system.split(`${source}："${share}"`).length - 1, 1);
    afterSave.send({ type: 'talk.close', npc }); await afterSave.until('ack');
  }
  from = afterSave.inbox.length;
  afterSave.send({ type: 'town.hour', groups: [['Gus', 'Sam']], date: { ...WORLD.date, day: 3, time: 1800 } });
  await afterSave.until('ack', from);
  assert.equal(h.logs.filter(line => line.startsWith('镇上传话：山姆记下了')).length, 0, 'yesterday’s first-hand news is no longer tellable');
  await afterSave.close();
});
