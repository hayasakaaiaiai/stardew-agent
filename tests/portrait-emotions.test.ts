import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { buildMessages, parseOutput, RULES, runTurn, type WorldState } from '../src/agent/dialogue.ts';
import { emotionsFor, SURPRISED_FRAMES } from '../src/agent/portraits.ts';
import type { ChatMessage, Completion, ModelClient, StreamHandlers } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';

const world: WorldState = {
  year: 1, season: 'spring', day: 19, time: '15:00', weather: '晴', location: '鹈鹕镇广场',
  player: { name: '小林', gender: 'female', farm: '晴空' },
  facts: {},
};
const standing = { hearts: 4, seenEvents: new Set<string>(), relation: 'friend' as const };

function replying(emotion: string) {
  const sent: ChatMessage[][] = [];
  const content = JSON.stringify({ reply: '哦？', emotion, options: ['一', '二', '三'], remember: [], mood: 0, end: false });
  const model = {
    async chat(messages: ChatMessage[], handlers: StreamHandlers): Promise<Completion> {
      sent.push(messages);
      handlers.onContent?.(content);
      return { content, reasoning: '', finishReason: 'stop', usage: null, timing: { firstReasoningMs: null, firstContentMs: 1, totalMs: 2 } };
    },
  } as unknown as ModelClient;
  return { model, sent };
}

test('each NPC is offered only the faces its vanilla portrait sheet has (docs/portrait-emotions.md)', () => {
  assert.deepEqual(emotionsFor('abigail'), ['neutral', 'happy', 'sad', 'blush', 'angry', 'special', 'surprised']);
  assert.deepEqual(emotionsFor('pierre'), ['neutral', 'happy', 'sad', 'blush', 'angry', 'special']);
  assert.deepEqual(emotionsFor('gus'), ['neutral', 'happy', 'sad', 'special']);
  assert.deepEqual(emotionsFor('wizard'), ['neutral', 'happy']);
  assert.deepEqual(emotionsFor('dwarf'), ['neutral']);
  assert.deepEqual(emotionsFor('someone'), ['neutral', 'happy', 'sad', 'blush', 'angry', 'special']);
  assert.equal(SOCIAL_NPCS.filter(id => emotionsFor(id).includes('surprised')).length, 12);
});

test('the emotion rule follows the shared rules, which stay the same for every NPC', () => {
  assert.doesNotMatch(RULES, /emotion：/);
  const system = (emotions?: Parameters<typeof emotionsFor>[0]) => buildMessages({ npcName: '格斯', card: { stable: '', gated: '' }, world,
    standing, memory: { memories: [] }, history: [], playerLine: '嗨', ...(emotions ? { emotions: emotionsFor(emotions) } : {}) })[0]!.content;
  assert.ok(system('gus').startsWith(`${RULES}\n- emotion：说这句话时的表情，取 neutral、happy、sad、special 之一。`));
  assert.match(system('abigail'), /取 neutral、happy、sad、blush、angry、special、surprised 之一。/);
  assert.match(system(), /取 neutral、happy、sad、blush、angry、special 之一。/, 'no NPC given: vanilla six');
});

test('surprised parses, and a face the portrait lacks becomes neutral without another call', async () => {
  assert.equal(parseOutput(JSON.stringify({ reply: '啊！', emotion: 'surprised', options: ['一', '二', '三'], remember: [], end: false })).meta.emotion,
    'surprised');
  const roster = new Roster({ directory: resolve(import.meta.dirname, '../data/npcs'), npcIds: SOCIAL_NPCS });
  await roster.load();
  const turn = async (npcId: string, emotion: string) => {
    const { model, sent } = replying(emotion);
    const result = await runTurn({ roster, model }, { npcId, world, standing, history: [], playerLine: '你好' });
    assert.equal(sent.length, 1);
    return result;
  };
  assert.equal((await turn('abigail', 'surprised')).meta.emotion, 'surprised');
  const gus = await turn('gus', 'angry');
  assert.equal(gus.meta.emotion, 'neutral');
  assert.equal(gus.metaOk, true, 'a valid but missing face is not a format failure');
  assert.equal((await turn('gus', 'surprised')).meta.emotion, 'neutral');
  assert.equal((await turn('dwarf', 'happy')).meta.emotion, 'neutral');
  assert.equal((await turn('wizard', 'happy')).meta.emotion, 'happy');
});

test('the Mod draws surprised from the same frames the backend offers', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../mod/StardewAgentBridge/VanillaDialogue.cs'), 'utf8');
  const table = /Surprised = new\(StringComparer\.OrdinalIgnoreCase\)\s*\{([^}]*)\}/.exec(source)?.[1];
  assert.ok(table, 'VanillaDialogue.cs has no Surprised table');
  const mod = Object.fromEntries([...table.matchAll(/\["(\w+)"\] = (\d+)/g)].map(([, name, frame]) => [name!.toLowerCase(), Number(frame)]));
  assert.deepEqual(mod, { ...SURPRISED_FRAMES });
});
