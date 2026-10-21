/** Paid content samples use production prompts; keep raw output so semantic review is separate from JSON validity. */
import { buildMessages, parseOutput, type WorldState } from '../src/agent/dialogue.ts';
import { parseScene, scenePrompt } from '../src/agent/scene.ts';
import type { ChatMessage, Completion } from '../src/services/model/client.ts';
import type { Roster } from '../src/services/roster/index.ts';

export async function socialContentProbes(roster: Roster,
  call: (kind: 'dialogue' | 'scene', messages: ChatMessage[]) => Promise<Completion>) {
  const world: WorldState = { year: 1, season: 'spring', day: 8, time: '18:00', weather: '晴天', location: '小镇',
    player: { name: '小林', gender: 'female', farm: '星露' }, facts: {} };
  const samples: { label: string; repeat: number; messages: ChatMessage[]; raw: string; reply: string; valid: boolean; expected: string }[] = [];
  for (const probe of [
    { label: 'lewis-unseen', npc: 'lewis', seen: [], line: '上次艾米丽办的服装疗法，你穿了什么？', expected: '未发生的服装疗法：不知道、不承认参加过' },
    { label: 'lewis-seen', npc: 'lewis', seen: ['2123243'], line: '上次艾米丽办的服装疗法，你穿了什么？', expected: '已经看过服装疗法：可以回忆帽子、披风和手杖' },
    { label: 'sebastian-sister', npc: 'sebastian', seen: [], line: '你的兄弟姐妹叫什么？谁比较年幼？', expected: '只有同母异父的妹妹玛鲁，没有弟弟' },
  ]) {
    const standing = { hearts: 6, relation: 'friend' as const, seenEvents: new Set(probe.seen) };
    for (let repeat = 1; repeat <= 2; repeat++) {
      const messages = buildMessages({ npcName: roster.get(probe.npc).name,
        card: roster.render(probe.npc, { ...standing, purpose: 'dialogue' }), world, standing,
        memory: { memories: [] }, history: [], playerLine: probe.line });
      const result = await call('dialogue', messages);
      const parsed = parseOutput(result.content);
      samples.push({ label: probe.label, repeat, messages, raw: result.content, reply: parsed.reply,
        valid: parsed.ok, expected: probe.expected });
    }
  }
  for (const gender of ['female', 'male'] as const) for (let repeat = 1; repeat <= 2; repeat++) {
    const news = { a: { origin: 'abigail', share: '小林的蓝色风筝叫云尾。', hand: 1 as const } };
    const messages = scenePrompt(roster, 'abigail', 'sam', { ...world, player: { ...world.player, gender } }, news);
    const result = await call('scene', messages);
    const parsed = parseScene(result.content, 'abigail', 'sam', world.player.name, news);
    samples.push({ label: `scene-${gender}`, repeat, messages, raw: result.content,
      reply: parsed.lines.map(line => `${line.npc}：${line.text}`).join('\n'), valid: parsed.lines.length >= 2,
      expected: `玩家性别是${gender === 'female' ? '女' : '男'}；提起时使用相应代词，转述不超出给定内容` });
  }
  return samples;
}
