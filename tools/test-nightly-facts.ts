/** Paid real-model regression: writes source, output, usage, and a checklist for human content review. */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nightlyPrompt, NIGHTLY_RULES, NIGHTLY_THINKING, parseNightly } from '../src/agent/nightly.ts';
import { ModelClient, modelConfigFromEnv, type ChatMessage } from '../src/services/model/client.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';
import { FACTS_FIXTURES, factsInput } from './nightly/facts-fixtures.ts';

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
if (args.some(arg => arg.startsWith('--') && !['--repeat', '--baseline', '--out'].includes(arg))) {
  throw new Error('用法：node tools/test-nightly-facts.ts [--repeat 3] [--baseline 旧模型调用.jsonl] [--out 输出目录]');
}
const repeats = args.includes('--repeat') ? Number(option('--repeat')) : 3;
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('--repeat 必须是 1–10');
const root = resolve(import.meta.dirname, '..');
const directory = resolve(args.includes('--out') ? option('--out')! : join(root, '.runtime', 'nightly-facts-' + new Date().toISOString().replace(/[:.]/g, '-')));
await mkdir(directory, { recursive: true });
// Append logs must never combine separate runs, especially with different rule versions.
await writeFile(join(directory, 'calls.jsonl'), '', { flag: 'wx' });
process.loadEnvFile(join(root, '.env'));
const model = new ModelClient({ ...modelConfigFromEnv(), thinking: NIGHTLY_THINKING });
const roster = new Roster({ directory: join(root, 'data/npcs'), npcIds: SOCIAL_NPCS });
const loaded = await roster.load();
if (loaded.errors.length) throw new Error('角色卡加载失败');
let baseline: string | undefined;
if (args.includes('--baseline')) {
  const lines = (await readFile(resolve(option('--baseline')!), 'utf8')).trim().split('\n').filter(Boolean);
  const call = lines.map(line => JSON.parse(line) as { kind?: string; messages: ChatMessage[] }).find(call => call.kind === 'nightly');
  if (!call?.messages[0]?.content) throw new Error('找不到旧版 nightly 规则');
  baseline = call.messages[0].content;
}
await writeFile(join(directory, 'inputs.json'), JSON.stringify({
  model: model.config.model, thinking: model.config.thinking,
  rulesHash: createHash('sha256').update(NIGHTLY_RULES).digest('hex'), rules: NIGHTLY_RULES, baseline, repeats, fixtures: FACTS_FIXTURES,
}, null, 2));
await writeFile(join(directory, 'review.md'), '# 夜间记忆内容核对\n\n模型输出需要逐项复核；格式有效不代表内容正确。\n');
console.log(`真实模型事实回归：${directory}`);
for (const fixture of FACTS_FIXTURES) {
  const input = factsInput(fixture);
  const messages = nightlyPrompt(roster, input.commit, input.npcs[0]!).messages;
  for (const variant of baseline ? ['baseline', 'current'] : ['current']) {
    const sent = variant === 'baseline' ? [{ role: 'system' as const, content: baseline! }, {
      role: 'user' as const,
      content: messages[1]!.content.replace('## 今天的对话（NPC=你，玩家=农场主）', '## 今天的对话')
        .replace(/^- t\d+ (NPC|玩家)：(".*")$/gm, (_line, speaker: string, quoted: string) =>
          `- ${speaker === 'NPC' ? '你' : '农场主'}：${JSON.parse(quoted) as string}`),
    }] : messages;
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const completion = await model.chat(sent, {}, { json: true });
      const parsed = variant === 'baseline' ? undefined : parseNightly(completion.content);
      const sources = nightlyPrompt(roster, input.commit, input.npcs[0]!).sources;
      const valid = parsed?.memories.every(memory => memory.sources.every(id => sources.some(source => source.id === id)));
      const grounded = parsed?.memories.map(memory => ({ importance: memory.importance,
        text: sources.filter(source => memory.sources.includes(source.id))
          .map(source => `${source.speaker === '玩家' ? '农场主说' : '我说'}：${JSON.stringify(source.text)}`).join('\n'),
      }));
      await appendFile(join(directory, 'calls.jsonl'), JSON.stringify({ id: fixture.id, variant, repeat, messages: sent, ...completion, parsed, grounded }) + '\n');
      await appendFile(join(directory, 'review.md'), `\n## ${fixture.id} / ${variant} / ${repeat}\n\n${fixture.review.map(item => `- [ ] ${item}`).join('\n')}\n\n\`\`\`json\n${JSON.stringify(parsed ? { ...parsed, memories: grounded } : completion.content, null, 2)}\n\`\`\`\n`);
      console.log(`${fixture.id} ${variant} ${repeat}：输入 ${completion.usage?.inputTokens ?? '?'}，输出 ${completion.usage?.outputTokens ?? '?'}，${completion.timing.totalMs} ms`);
      if (variant !== 'baseline' && !valid) throw new Error(`${fixture.id} 输出无法解析或引用无效，原始内容已保存`);
    }
  }
}
await writeFile(join(directory, 'result.json'), JSON.stringify({ completed: true, needsContentReview: true, fixtures: FACTS_FIXTURES.length, repeats, baseline: !!baseline }, null, 2));
console.log('调用完成，请按 review.md 核对内容。');
