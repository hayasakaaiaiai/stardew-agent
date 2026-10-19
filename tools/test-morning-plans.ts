/** Paid real-model regression through the actual chat save, plan wrapper, and turn pipeline. */
import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OPENING_LINE, runTurn, type DialogueMemory, type WorldState } from '../src/agent/dialogue.ts';
import { MORNING_HEADING } from '../src/agent/morning.ts';
import { nightlyPrompt } from '../src/agent/nightly.ts';
import { ModelClient, modelConfigFromEnv } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';
import { ChatSave } from './chat/session.ts';
import { MORNING_FIXTURES } from './morning/fixtures.ts';

const args = process.argv.slice(2);
const repeats = args.includes('--repeat') ? Number(args[args.indexOf('--repeat') + 1]) : 2;
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('--repeat 必须为 1–10');
const fixtures = args.includes('--case') ? MORNING_FIXTURES.filter(item => item.id === args[args.indexOf('--case') + 1]) : MORNING_FIXTURES;
if (!fixtures.length) throw new Error('--case 没有匹配的样本');
const root = resolve(import.meta.dirname, '..');
const directory = join(root, '.runtime', 'morning-plans-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory);
process.loadEnvFile(join(root, '.env'));
const model = new ModelClient(modelConfigFromEnv());
const roster = new Roster({ directory: join(root, 'data/npcs'), npcIds: SOCIAL_NPCS });
assert.equal((await roster.load()).errors.length, 0);
const standing = { hearts: 8, relation: 'friend' as const, seenEvents: new Set<string>() };
const world: WorldState = { year: 1, season: 'summer', day: 4, time: '09:00', weather: '晴', location: '农场',
  player: { name: '记忆验收', gender: 'male', farm: '记忆验收' }, facts: {} };
await writeFile(join(directory, 'review.md'), '# 次日开场真实模型核对\n\n以下为真实持久化与开场流程；格式与生命周期通过后仍需核对生成内容。\n');
console.log(directory);
for (const sample of fixtures) for (let repeat = 1; repeat <= repeats; repeat++) {
  const saveDirectory = join(directory, `${sample.id}-${repeat}`);
  const save = await ChatSave.open({ directory: saveDirectory, name: 'test', fresh: true, startDay: 31, npcIds: SOCIAL_NPCS,
    consolidator: async input => input.npcs.map(npc => ({ npcId: npc.npcId, state: { day: input.commit.dayEnded, plan: sample.plan },
      memories: [{ text: nightlyPrompt(roster, input.commit, npc).sources
        .map(source => `${source.speaker === '玩家' ? '农场主说' : '我说'}：${JSON.stringify(source.text)}`).join('\n'),
        importance: 5, kind: 'summary' as const, visibility: 'private' as const }],
    })),
  });
  try {
    const memory = save.memory('abigail', () => save.day * 1440 + 600, () => world.player);
    await memory.context(OPENING_LINE, standing);
    await memory.record({ player: OPENING_LINE, npc: sample.fixture.opening }, []);
    await memory.context(sample.fixture.player, standing);
    await memory.record({ player: sample.fixture.player, npc: sample.fixture.reply }, []);
    await save.sleep({ label: 'morning-plans', player: world.player, facts: {}, npcs: {}, seenEvents: [] });
    const db = new DatabaseSync(join(saveDirectory, 'memory.sqlite'), { readOnly: true });
    try {
      const count = () => db.prepare('SELECT COUNT(*) AS n FROM memory').get()!.n;
      const before = count();
      for (const variant of args.includes('--compare') ? ['baseline', 'current'] : ['current']) {
        const dialogue: DialogueMemory = variant === 'current' ? memory : {
          context: async (query, current) => {
            const { summary, replyView: _view, ...recalled } = await memory.context(query, current);
            const prior = summary?.split(MORNING_HEADING)[0]?.trimEnd();
            return { ...recalled, ...(prior ? { summary: prior } : {}) };
          },
          record: async () => {},
        };
        const result = await runTurn({ roster, model, memory: dialogue }, { npcId: 'abigail', world, standing, playerLine: OPENING_LINE });
        assert.equal(result.messages[0]!.content.includes(MORNING_HEADING), variant === 'current');
        assert.equal(count(), before, 'opening must not turn generated remember into new facts');
        assert.ok(result.reply.trim());
        await appendFile(join(directory, 'calls.jsonl'), JSON.stringify({ id: sample.id, repeat, variant, ...result }) + '\n');
        await appendFile(join(directory, 'review.md'), `\n## ${sample.id} / ${variant} / ${repeat}\n\n${sample.review.map(item => `- [ ] ${item}`).join('\n')}\n\n${result.reply}\n\n输入 ${result.usage?.inputTokens}，输出 ${result.usage?.outputTokens}，耗时 ${result.timing.totalMs} ms。\n`);
        console.log(JSON.stringify({ id: sample.id, repeat, variant, reply: result.reply, usage: result.usage }));
      }
      assert.equal(save.todayCount('abigail'), 1);
      assert.ok(!(await memory.context(OPENING_LINE, standing)).summary?.includes(MORNING_HEADING), 'second opening must be normal');
    } finally { db.close(); }
  } finally { await save.close(); }
}
await writeFile(join(directory, 'result.json'), JSON.stringify({ completed: true, needsContentReview: true, cases: fixtures.length, repeats, compare: args.includes('--compare') }, null, 2));
console.log('实际来源、首次开场、remember 过滤与第二次开场检查完成；请核对 review.md 内容。');
