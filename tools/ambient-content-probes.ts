/** Preserve raw paid samples for semantic review; parsing success alone says nothing about factual accuracy. */
import { ambientPrompt, parseAmbient, type AmbientPerson } from '../src/agent/ambient.ts';
import { buildMessages, parseOutput, type WorldState } from '../src/agent/dialogue.ts';
import type { ChatMessage, Completion } from '../src/services/model/client.ts';
import type { Roster } from '../src/services/roster/index.ts';

export async function ambientContentProbes(roster: Roster,
  call: (kind: 'dialogue' | 'ambient', messages: ChatMessage[]) => Promise<Completion>) {
  const world: WorldState = { year: 1, season: 'spring', day: 18, time: '10:00', weather: '下雨', location: '皮埃尔的杂货店',
    player: { name: '小林', gender: 'female', farm: '晴空' }, facts: { 社区中心: '玩家正在修复，还没修好' } };
  const samples: { label: string; repeat: number; messages: ChatMessage[]; raw: string; reply: string; valid: boolean; expected: string }[] = [];
  for (const probe of [
    { label: 'haley-confrontation', npc: 'haley', seen: ['195012'], line: '上次你们几个在你家一起质问我，我很抱歉。你还在生气吗？', expected: '已发生女生对质；可回忆疏远与谅解，不混成八卦结局' },
    { label: 'haley-unseen-group', npc: 'haley', seen: [], line: '上次你们几个在你家一起质问我，我很抱歉。', expected: '未发生群体事件，不顺着承认' },
    { label: 'penny-lucky-group', npc: 'penny', seen: ['195019'], line: '上次在海莉家大家聊了什么？', expected: '八卦结局，可以回忆镇长和玛妮，不声称质问或疏远' },
    { label: 'sam-confrontation', npc: 'sam', seen: ['195013'], line: '上次你们几个一起质问我，我很抱歉。', expected: '已发生男生对质，可回忆疏远与翻篇' },
    { label: 'sam-lucky-group', npc: 'sam', seen: ['195099'], line: '上次酒吧的八球锦标赛怎么样？谁赢了？', expected: '八球结局，塞巴斯蒂安赢；不混成对质' },
    { label: 'sam-unseen-group', npc: 'sam', seen: [], line: '上次你们几个在酒吧一起质问我，我很抱歉。', expected: '未发生群体事件，不承认质问' },
    { label: 'krobus-seen-fourteen', npc: 'krobus', seen: ['7771191'], line: '还记得海滩那个夜晚吗？你坐了什么兜风？', expected: '月光水母和海怪触手，不添玩家带路的经历' },
    { label: 'krobus-unseen-fourteen', npc: 'krobus', seen: [], line: '还记得海滩那个夜晚吗？你坐了什么兜风？', expected: '事件未发生，不承认海滩兜风' },
  ]) for (let repeat = 1; repeat <= 2; repeat++) {
    const standing = { hearts: probe.npc === 'krobus' ? 14 : 10, relation: probe.npc === 'krobus' ? 'roommate' as const : 'friend' as const,
      seenEvents: new Set(probe.seen) };
    const messages = buildMessages({ npcName: roster.get(probe.npc).name, card: roster.render(probe.npc, { ...standing, purpose: 'dialogue' }),
      world, standing, memory: { memories: [] }, history: [], playerLine: probe.line });
    const result = await call('dialogue', messages), parsed = parseOutput(result.content);
    samples.push({ label: probe.label, repeat, messages, raw: result.content, reply: parsed.reply, valid: parsed.ok, expected: probe.expected });
  }
  const person = (id: string, hearts: number, relation: AmbientPerson['relation'] = 'friend', greeted = false): AmbientPerson => ({ id, hearts, relation, greeted });
  for (const scenario of [
    { label: 'ambient-rain-shop', people: [person('pierre', 3), person('caroline', 1), person('abigail', 6)], world },
    { label: 'ambient-already-greeted-saloon', people: [person('gus', 4, 'friend', true), person('pam', 2), person('shane', 0, 'stranger'), person('emily', 5, 'friend', true)],
      world: { ...world, time: '21:00', weather: '晴天', location: '星之果实餐吧' } },
    { label: 'ambient-dating-beach', people: [person('elliott', 9, 'dating')], world: { ...world, time: '18:00', weather: '晴天', location: '海滩' } },
    { label: 'ambient-windy-clinic', people: [person('harvey', 2), person('maru', 7)], world: { ...world, weather: '刮风', location: '诊所' } },
  ]) {
    const messages = ambientPrompt(roster, scenario.people, scenario.world), result = await call('ambient', messages);
    const parsed = parseAmbient(result.content, scenario.people, world.player.name);
    samples.push({ label: scenario.label, repeat: 1, messages, raw: result.content,
      reply: parsed.map(line => `${line.npc}→${line.to}：${line.text}`).join('\n'), valid: parsed.length > 0,
      expected: '符合天气、地点、心数；不泄漏秘密；已招呼的人不得再向玩家说话；每人一句' });
  }
  return samples;
}
