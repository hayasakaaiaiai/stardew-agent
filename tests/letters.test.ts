import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeLetter } from '../src/agent/letters.ts';
import type { BackendMessage } from '../src/bridge/protocol.ts';
import { deferred, harness } from './helpers/bridge.ts';

test('letters reject completed deliveries while retaining questions and wishes', () => {
  for (const text of ['竹条扛来了，等你。', '材料我带来了。', '纸船折出来了。', '去墓地转了一圈。']) {
    assert.equal(safeLetter(text), undefined, text);
  }
  for (const text of ['今天一起做风筝，可别忘啦。', '纸船做好了吗？', '材料带来了没？', '要是我爸不过敏就好了。']) {
    assert.equal(safeLetter(text), text);
  }
  for (const text of ['风筝的事我记牢了，紫色的，今天一起动手吧。顺带塞了点阴森的小东西给你，合你的口味。',
    '海边放金色纸船的事我记着呢，到时候别把我落下。顺手塞了瓶虚空精华给你，这种阴森玩意儿你大概会喜欢。']) {
    assert.equal(safeLetter(text), text, 'native-run letters about remembering and enclosing an item are not off-screen progress');
  }
});

test('late daily reads cannot deliver an obsolete competing letter, including across commits', async t => {
  const h = await harness(t);
  const server = await h.start();
  const pending = deferred();
  const old = { bubbles: {}, approach: {}, letters: [{ key: 'StardewAgent.old', npc: 'haley', text: '谢谢你来看我。' }] };
  const latest = { bubbles: {}, approach: {}, letters: [{ key: 'StardewAgent.new', npc: 'abigail', text: '今天一起做风筝。', item: '蝙蝠翅膀' }] };
  let read = () => pending.promise.then(() => old);
  const save = { initial: { lineageId: 'farm' }, loadNonce: 'current', closed: false, head: 'A', day: 2, today: () => read() };
  const packets: BackendMessage[] = [];
  const session = { save, todayRevision: 0, send: (message: BackendMessage) => packets.push(message) };
  const sender = server as unknown as { sendToday(value: typeof session): Promise<void> };
  const first = sender.sendToday(session);
  read = async () => latest;
  await sender.sendToday(session);
  pending.resolve(); await first;
  assert.deepEqual(packets.filter(message => message.type === 'day.letters').map(message => message.letters), [latest.letters]);
  const changed = deferred();
  read = () => changed.promise.then(() => old);
  const obsolete = sender.sendToday(session);
  save.head = 'B';
  changed.resolve(); await obsolete;
  assert.equal(packets.length, 3, 'bubbles, letters and approach once');
});
