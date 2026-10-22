import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkMeet, meetDraft, helpedText, meetingLine, meetingMemory } from '../src/agent/meetings.ts';
import { NIGHTLY_RULES, nightlyConsolidator } from '../src/agent/nightly.ts';
import { parseModMessage } from '../src/bridge/protocol.ts';
import type { ChatMessage, Completion, ModelClient } from '../src/services/model/client.ts';
import { connect, harness, openTalk, sleep, WORLD } from './helpers/bridge.ts';

const HELPED = { watered: 120, harvested: 35, fed: 8, ponds: 2 };

test('the farm is a meeting place, but “农场主” in a line is the player, not the place', () => {
  assert.match(NIGHTLY_RULES, /杂货店、农场之一/);
  const sources = [
    { id: 't1', speaker: '玩家' as const, text: '明天上午来农场帮我浇浇水好吗？' },
    { id: 't2', speaker: 'NPC' as const, text: '好啊，明天上午我去帮农场主的忙。' },
  ];
  assert.deepEqual(checkMeet(meetDraft({ time: '10:00', place: '农场', sources: ['t1', 't2'] }), sources), { time: 1000, place: '农场' });
  assert.equal(checkMeet(meetDraft({ time: '10:00', place: '农场', sources: ['t2'] }), sources), null, 'only the NPC spoke, and only of 农场主');
  assert.equal(checkMeet(meetDraft({ time: '10:00', place: '农场', sources: ['t1', 't2'] }),
    [{ ...sources[0]!, text: '明天上午来帮农场主吧' }, sources[1]!]), null);
});

test('farm chore requests still need both parties, a time, and an unconditional agreement', () => {
  const proposal = meetDraft({ time: '10:00', place: '农场', sources: ['t1', 't2'] });
  const quotes = (player: string, npc: string) => [{ id: 't1', speaker: '玩家' as const, text: player }, { id: 't2', speaker: 'NPC' as const, text: npc }];
  assert.deepEqual(checkMeet(proposal, quotes('明天上午来田里帮我收成熟的作物吧？', '没问题，明天上午我来帮忙。')), { time: 1000, place: '农场' });
  for (const [player, npc] of [
    ['明天上午来农场帮我浇水好吗？', '不行，我明天不去农场。'],
    ['如果明天上午有空，来农场帮我浇水吧。', '好啊。'],
    ['明天上午来农场帮我浇水好吗？', '我还没决定，想想再说。'],
    ['明天来农场帮忙，几点还没想好。', '好啊。'],
    ['明天上午来农场帮我浇水好吗？', '明天下午我来帮忙。'],
    ['今天的天气真不错。', '我明天上午去农场帮忙。'],
  ]) assert.equal(checkMeet(proposal, quotes(player!, npc!)), null, `${player} / ${npc}`);
  assert.equal(checkMeet(meetDraft({ time: '10:00', place: '农场', sources: ['t1'] }),
    quotes('明天上午来农场帮我浇水好吗？', '我不去。')), null);
});

test('what a helper did is said in the talk and remembered, leaving out what there was none of', () => {
  assert.equal(helpedText(HELPED), '浇了 120 格水、收了 35 个作物放进农舍门口的箱子、给动物添了 8 份干草、收了 2 个鱼塘的产物放进箱子');
  assert.equal(helpedText({ watered: 0, harvested: 4, fed: 0, ponds: 0 }), '收了 4 个作物放进农舍门口的箱子');
  assert.equal(helpedText({ watered: 0, harvested: 0, fed: 0, ponds: 0 }), '农场里没什么要干的活');
  const meeting = { time: 1000, place: '农场' };
  assert.equal(meetingLine(meeting, 1030, true, { watered: 12, harvested: 0, fed: 0, ponds: 0 }),
    '今天 10:00 在农场见面，现在就在这里碰面了；你来了以后已经浇了 12 格水');
  assert.equal(meetingLine(meeting, 1030, true), '今天 10:00 在农场见面，现在就在这里碰面了', 'a visitor who does not help');
  assert.equal(meetingMemory({ ...meeting, met: true, left: 1130, helped: { watered: 12, harvested: 0, fed: 3, ponds: 0 } }).text,
    '约好 10:00 在农场见面，我浇了 12 格水、给动物添了 3 份干草，农场主来了。');
});

test('the Mod reports the chores only as whole counts', () => {
  const base = { type: 'meet.ended', lineageId: 'farm', loadNonce: 'n', seq: 3, npc: 'Abigail', place: '农场', time: 1000, left: 1130, met: true,
    date: { year: 1, season: 'spring', day: 2, time: 1130 } };
  assert.deepEqual((parseModMessage(JSON.stringify({ ...base, helped: HELPED })) as { helped?: unknown }).helped, HELPED);
  for (const helped of [null, [], { ...HELPED, watered: -1 }, { ...HELPED, fed: 1.5 }, { watered: 1, harvested: 1, fed: 1 }, { ...HELPED, ponds: 100001 }]) {
    assert.throws(() => parseModMessage(JSON.stringify({ ...base, helped })), JSON.stringify(helped));
  }
  assert.throws(() => parseModMessage(JSON.stringify({ ...openTalk(), lineageId: 'farm', loadNonce: 'n', seq: 4, helped: { watered: 'a' } })));
});

const nightly = {
  async chat(messages: ChatMessage[]): Promise<Completion> {
    const output = { memories: [{ sources: ['t2'], importance: 3 }], retire: [], impression: '', plan: '明天上午去农场帮忙', bubbles: [], letter: '',
      gift: false, share: '', meet: { time: '09:00', place: '农场', sources: ['t2', 't3'] } };
    void messages;
    return { content: JSON.stringify(output), reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } };
  },
} as unknown as ModelClient;

test('a farm appointment reaches the Mod, the talk there knows the chores, and the memory keeps them', { timeout: 15000 }, async t => {
  const h = await harness(t);
  const originalChat = h.fake.model.chat.bind(h.fake.model);
  h.fake.model.chat = async (...args: Parameters<typeof originalChat>) => {
    const result = await originalChat(...args);
    return { ...result, content: JSON.stringify({ ...JSON.parse(result.content), reply: '好啊，明天上午我去农场帮你浇水。' }) };
  };
  const server = await h.start(nightlyConsolidator({ roster: h.roster, model: nightly }));
  const wire = await connect(server);
  wire.send(openTalk(1)); await wire.until('talk.reply');
  wire.send({ type: 'talk.say', npc: 'Abigail', text: '明天上午来农场帮我浇浇水好吗？' }); await wire.until('talk.reply');
  await sleep(wire);
  for (let i = 0; i < 300 && !h.logs.includes('今天的约定：abigail 10:00 农场'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(h.logs.includes('今天的约定：abigail 10:00 农场'));
  const prompt = () => h.fake.sent.at(-1)!.map(message => message.content).join('\n');
  wire.send({ ...openTalk(2), world: { ...WORLD, location: '农场', date: { ...WORLD.date, day: 2, time: 1030 } }, atMeeting: true, helped: HELPED });
  await wire.until('talk.reply', wire.inbox.length);
  assert.match(prompt(), /- 和农场主的约定：今天 10:00 在农场见面，现在就在这里碰面了；你来了以后已经浇了 120 格水、收了 35 个作物放进农舍门口的箱子/);
  wire.send({ type: 'talk.close', npc: 'Abigail' }); await wire.until('ack');
  wire.send({ type: 'meet.ended', npc: 'Abigail', place: '农场', time: 1000, left: 1130, met: true, helped: HELPED, date: { ...WORLD.date, day: 2, time: 1130 } });
  await wire.until('ack', wire.inbox.length);
  assert.ok(h.logs.includes(`阿比盖尔记下了：约好 10:00 在农场见面，我${helpedText(HELPED)}，农场主来了。`));
  await wire.close();
});
