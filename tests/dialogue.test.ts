import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  buildMessages, FALLBACK_OPTIONS, JSON_HINT, parseOutput, ReplyStream, RULES, runTurn, weekday, type WorldState,
} from '../src/agent/dialogue.ts';
import type { ChatMessage, Completion, ModelClient, StreamHandlers } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';

const world: WorldState = {
  year: 1, season: 'spring', day: 19, time: '15:00', weather: '晴', location: '鹈鹕镇广场',
  player: { name: '小林', gender: 'female', farm: '晴空' },
  facts: { 巴士: '还没修好' },
};

const GOOD = '{"reply":"嘿，\\"你\\"来啦。\\n坐吧。","emotion":"happy","options":["a","b","c"],"remember":[],"end":false}';

function stream(chunks: string[]) {
  const reply = new ReplyStream();
  return { shown: chunks.map((chunk) => reply.push(chunk)).join(''), text: reply.text };
}

test('the reply is decoded while the JSON streams, even with escapes cut across chunks', () => {
  const whole = stream([GOOD]);
  assert.equal(whole.shown, '嘿，"你"来啦。\n坐吧。');

  const pieces = stream([...GOOD].map((char) => char));
  assert.equal(pieces.shown, whole.shown, 'one character per chunk');

  const unicode = stream(['{"re', 'ply" : "\\u4f', '60好', '\\', 'n"', ',"emotion":"x"}']);
  assert.equal(unicode.shown, '你好\n');

  assert.equal(stream(['{"emotion":"happy","reply":"后', '来的"}']).shown, '后来的', 'reply need not be first');
  assert.equal(stream(['   ', '  ']).shown, '');
});

test('output parsing never throws and falls back to neutral defaults', () => {
  const good = parseOutput('{"reply":" 嘿。 ","emotion":"blush","options":["一","二","三"],"remember":[{"text":"玩家送了花","importance":9}],"end":false}');
  assert.equal(good.ok, true);
  assert.equal(good.reply, '嘿。');
  assert.equal(good.meta.emotion, 'blush');
  assert.deepEqual(good.meta.remember, [{ text: '玩家送了花', importance: 5 }]);

  const fenced = parseOutput('```json\n{"reply":"好。","emotion":"happy","options":["一","二","三"],"remember":[],"end":true}\n```');
  assert.equal(fenced.ok, true);
  assert.equal(fenced.meta.end, true);

  for (const raw of ['', '   ', '不是 JSON', '{"reply":"半截', '[1,2]']) {
    const bad = parseOutput(raw, '已经显示的台词');
    assert.equal(bad.ok, false, raw);
    assert.deepEqual(bad.meta.options, FALLBACK_OPTIONS);
    assert.equal(bad.meta.emotion, 'neutral');
    assert.equal(bad.reply, '已经显示的台词', 'falls back to what was already streamed');
  }
  assert.equal(parseOutput('不是 JSON').reply, '不是 JSON', 'plain text becomes the reply when nothing streamed');

  const partial = parseOutput('{"reply":"嗯。","emotion":"furious","options":["只有一条"],"remember":"无"}');
  assert.equal(partial.ok, false);
  assert.equal(partial.meta.emotion, 'neutral');
  assert.deepEqual(partial.meta.options, ['只有一条', ...FALLBACK_OPTIONS.slice(0, 2)]);
});

test('prompt order: rules, stable card, gated card, situation, memory, then the conversation', () => {
  const messages = buildMessages({
    npcName: '阿比盖尔',
    card: { stable: 'STABLE', gated: 'GATED' },
    world,
    standing: { hearts: 4, seenEvents: new Set(), relation: 'friend' },
    memory: { memories: [{ text: '玩家说过喜欢下雨' }] },
    history: [{ player: '你好', npc: '嘿。' }],
    playerLine: '今天做什么？',
  });
  const system = messages[0]!.content;
  assert.ok(system.startsWith(RULES));
  const order = ['STABLE', 'GATED', '## 当前情况', '## 你记得的事'].map((part) => system.indexOf(part));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(order.every((at) => at > 0));
  assert.match(system, /第 1 年春季 19 日（周五）15:00，晴/);
  assert.deepEqual(messages.slice(1).map((m) => [m.role, m.content]), [
    ['user', '你好'], ['assistant', '嘿。'], ['user', `今天做什么？${JSON_HINT}`],
  ]);
  assert.equal(weekday(1), '周一');
  assert.equal(weekday(28), '周日');
});

async function fullRoster() {
  const directory = resolve(import.meta.dirname, '../data/npcs');
  const npcIds = (await readdir(directory)).filter((f) => !f.startsWith('_')).map((f) => f.slice(0, -3));
  const roster = new Roster({ directory, npcIds });
  await roster.load();
  return roster;
}

function fakeModel(outputs: string[][]) {
  const sent: ChatMessage[][] = [];
  const model = {
    async chat(messages: ChatMessage[], handlers: StreamHandlers): Promise<Completion> {
      sent.push(messages);
      const chunks = outputs[sent.length - 1] ?? [];
      for (const chunk of chunks) handlers.onContent?.(chunk);
      return {
        content: chunks.join(''), reasoning: '', finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80, reasoningTokens: 5 },
        timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 2 },
      };
    },
  } as unknown as ModelClient;
  return { model, sent };
}

test('a turn renders the card for the current standing and streams only the reply text', async () => {
  const roster = await fullRoster();
  const { model, sent } = fakeModel([[GOOD.slice(0, 20), GOOD.slice(20)]]);
  let streamed = '';
  const result = await runTurn({ roster, model }, {
    npcId: 'abigail', world, standing: { hearts: 4, seenEvents: new Set(['4']), relation: 'friend' },
    history: [], playerLine: '你好',
  }, { onReply: (text) => { streamed += text; } });
  assert.equal(result.reply, '嘿，"你"来啦。\n坐吧。');
  assert.equal(streamed, result.reply);
  assert.equal(result.metaOk, true);
  assert.equal(result.attempts.length, 1);
  assert.match(sent[0]![0]!.content, /## 角色：阿比盖尔/);
  assert.doesNotMatch(sent[0]![0]!.content, /不说自己已经在偷偷练剑/, 'event 4 was seen');
});

test('a blank reply is retried once, and usage adds up across attempts', async () => {
  const roster = await fullRoster();
  const { model, sent } = fakeModel([['     '], [GOOD]]);
  const result = await runTurn({ roster, model }, {
    npcId: 'abigail', world, standing: { hearts: 4, seenEvents: new Set(), relation: 'friend' },
    history: [], playerLine: '你好',
  });
  assert.equal(sent.length, 2);
  assert.equal(result.metaOk, true);
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(result.usage, { inputTokens: 200, outputTokens: 20, cachedInputTokens: 160, reasoningTokens: 10 });

  const { model: blank } = fakeModel([['   '], ['  ']]);
  const failed = await runTurn({ roster, model: blank }, {
    npcId: 'abigail', world, standing: { hearts: 4, seenEvents: new Set(), relation: 'friend' },
    history: [], playerLine: '你好',
  });
  assert.equal(failed.attempts.length, 2, 'gives up after two attempts');
  assert.equal(failed.metaOk, false);
  assert.deepEqual(failed.meta.options, FALLBACK_OPTIONS);
});
