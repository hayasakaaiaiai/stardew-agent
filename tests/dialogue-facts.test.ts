import assert from 'node:assert/strict';
import { test } from 'node:test';
import { directScheduleReply, unknownRecentChat } from '../src/agent/dialogue-facts.ts';
import { scheduleReplies } from '../src/agent/schedule.ts';
import { runTurn, type DialogueMemory, type Exchange } from '../src/agent/dialogue.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';
import type { ChatModel, Completion } from '../src/services/model/client.ts';

const native = [{ time: 1200, place: 'Joja 超市', sleep: false }, { time: 1230, place: 'Joja 超市', sleep: false },
  { time: 1600, place: '星之果实酒吧', sleep: false }, { time: 2400, place: '潘姆家', sleep: true }];

test('direct schedule answers exclude past stops and keep the place spanning the evening and midnight', () => {
  const facts = scheduleReplies(native, 1400)!;
  assert.equal(directScheduleReply('你待会儿要去哪儿？', facts), '我接下来会在16:00去星之果实酒吧。');
  assert.equal(directScheduleReply('下一站是哪儿？', facts), facts.next);
  assert.equal(directScheduleReply('晚上去哪能找到你？', facts), '晚些时候我会这样安排：16:00 星之果实酒吧，00:00 回家睡觉。');
  assert.equal(scheduleReplies(native, 2300)!.evening, '晚些时候我会这样安排：现在在星之果实酒吧，00:00 回家睡觉。');
  const rainy = scheduleReplies([{ time: 900, place: '皮埃尔的杂货店', sleep: false }, { time: 2200, place: '皮埃尔的杂货店', sleep: true }], 1400)!;
  assert.equal(rainy.next, '今天不再去别的地方了，22:00睡觉。');
  assert.equal(scheduleReplies(native, 2500)!.next, '今天不再外出了。');
  for (const query of ['我们待会一起去墓地好吗？', '你觉得我待会要去哪儿？', '如果下雨，你待会儿要去哪儿？', '你想去哪儿？', '最近怎么样？'])
    assert.equal(directScheduleReply(query, facts), undefined, query);
  assert.equal(directScheduleReply('你待会儿要去哪儿？', undefined), undefined, 'a festival or story override has no schedule facts');
});

test('recent NPC chat recall needs the matching person and day, including groups, without guessing that nobody met', () => {
  const names = ['玛鲁', '格斯', '谢恩'];
  const empty = { memories: [] };
  const note = { text: '在哈维的诊所和玛鲁、格斯聊天：玛鲁调好了显微镜。', when: '今天' };
  assert.equal(unknownRecentChat('刚才和玛鲁聊了什么？', empty, names), '和玛鲁聊了什么，我一时想不起来了。');
  assert.equal(unknownRecentChat('刚才你和格斯在酒吧聊了什么？', empty, names), '和格斯聊了什么，我一时想不起来了。');
  assert.equal(unknownRecentChat('刚才和玛鲁聊了什么？', { memories: [note] }, names), undefined);
  assert.equal(unknownRecentChat('今天和格斯聊了什么？', { memories: [note] }, names), undefined);
  assert.equal(unknownRecentChat('昨天和玛鲁聊了什么？', { memories: [note] }, names), '和玛鲁聊了什么，我一时想不起来了。');
  assert.equal(unknownRecentChat('上次和玛鲁聊了什么？', { memories: [note] }, names), undefined);
  assert.equal(unknownRecentChat('刚才和谢恩聊了什么？', { memories: [note] }, names), '和谢恩聊了什么，我一时想不起来了。');
  assert.equal(unknownRecentChat('刚才和玛鲁聊了什么？', { memories: [{ text: '农场主说："在诊所和玛鲁聊天：整理药品"', when: '今天' }] }, names),
    '和玛鲁聊了什么，我一时想不起来了。', 'a player claim is not the NPC chat event');
  for (const query of ['刚才我们聊了什么？', '你和玛鲁关系怎么样？', '要不要和玛鲁聊聊？', '刚才和一个陌生人聊了什么？'])
    assert.equal(unknownRecentChat(query, empty, names), undefined, query);
});

test('hallucinated schedule and rollback replies never stream or enter the recorded exchange; usage is preserved', async () => {
  const roster = new Roster({ directory: 'data/npcs', npcIds: SOCIAL_NPCS }); await roster.load();
  const records: Exchange[] = [];
  const memory: DialogueMemory = { context: async () => ({ memories: [] }), record: async (exchange, remembered) => {
    records.push(exchange); assert.deepEqual(remembered, []);
  } };
  const wrong = ['可能去湖边走走，看看山洞。', '就是诊所排班和整理药品。', '我今天还没见过玛鲁。'];
  let calls = 0;
  const model: ChatModel = { async chat(_messages, handlers) {
    const content = JSON.stringify({ reply: wrong[calls++], emotion: 'happy', options: ['去湖边', '整理药品', '送药'],
      remember: [{ text: '玩家喜欢山洞', importance: 4 }], mood: 2, give: true, end: true });
    for (const character of content) handlers?.onContent?.(character);
    return { content, reasoning: '', finishReason: 'stop', usage: { inputTokens: 130, outputTokens: 40, cachedInputTokens: 60, reasoningTokens: null },
      timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 1 } } satisfies Completion;
  } };
  const world = { year: 1, season: 'spring' as const, day: 1, time: '14:00', weather: '下雨', location: '诊所',
    player: { name: '小林', gender: 'female' as const, farm: '晴空' }, facts: {}, scheduleFacts: scheduleReplies(native, 1400)! };
  for (const [index, playerLine] of ['你待会儿要去哪儿？', '刚才和玛鲁聊了什么？', '刚才和玛鲁聊了什么？'].entries()) {
    let shown = '';
    const result = await runTurn({ roster, memory, model }, { npcId: 'harvey', world, standing: { hearts: 8, relation: 'friend', seenEvents: new Set() }, playerLine },
      { onReply: delta => { shown += delta; } });
    assert.equal(shown, result.reply); assert.equal(records[index]!.npc, result.reply);
    assert.doesNotMatch(shown, /湖边|山洞|药品|排班|没见/);
    assert.equal(result.reply, index === 0 ? '我接下来会在16:00去星之果实酒吧。' : '和玛鲁聊了什么，我一时想不起来了。');
    assert.equal(result.meta.mood, 0); assert.equal(result.meta.give, false); assert.equal(result.meta.end, false);
    assert.deepEqual(result.meta.remember, []); assert.doesNotMatch(result.meta.options.join(''), /湖边|药/);
    assert.equal(result.attempts.length, 1); assert.equal(result.usage!.inputTokens, 130);
  }
  assert.equal(calls, 3, 'no corrective model request is added');
});
