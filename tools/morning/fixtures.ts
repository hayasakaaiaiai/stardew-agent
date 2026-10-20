import { FACTS_FIXTURES } from '../nightly/facts-fixtures.ts';

/** Some plans deliberately contradict the evidence: the opening must follow the dialogue, not the plan. */
export const MORNING_FIXTURES = [
  { id: 'accepted', fixture: FACTS_FIXTURES[3]!, plan: '明天在山上和农场主一起做紫色风筝。',
    review: ['提起今天的紫色风筝约定', '不编造材料已齐、昨晚行动或完成进展'] },
  { id: 'unaccepted', fixture: FACTS_FIXTURES[1]!, plan: '明天和农场主去矿洞找紫水晶。',
    review: ['原话尚未接受邀请，只能询问', '不能说已经约好或玩家答应'] },
  { id: 'refused', fixture: FACTS_FIXTURES[2]!, plan: '明天和农场主一起去墓地。',
    review: ['玩家已拒绝，不能当成共同安排', '不把纸船计划写成已经制作或放过'] },
  { id: 'own', fixture: FACTS_FIXTURES[0]!, plan: '明天想问农场主星糖长什么样。',
    review: ['主动问起玩家的猫星糖', '不编造小猫外观或误写成 NPC 的猫'] },
  { id: 'later', fixture: { ...FACTS_FIXTURES[3]!,
      opening: '你最近有什么打算？', player: '我后天要在海边放金色纸船，到时一起去。我还没做纸船。', reply: '好，后天一起去海边。' },
    plan: '后天和农场主一起去海边放金色纸船。',
    review: ['昨天说的后天，在今天应说成明天，不能再顺延一天', '纸船仍未确认完成，不能写成已经做好或放过'] },
  { id: 'promised-delivery', fixture: { ...FACTS_FIXTURES[3]!,
      opening: '明天一起做紫色风筝，怎么样？', player: '好，明天一起做。材料你有吗？',
      reply: '竹条我家里有，明天我带来。昨晚我还查过怎么让尾巴稳一点。' },
    plan: '明天带上家里的竹条，和农场主一起做紫色风筝。',
    review: ['主动询问今天做风筝的安排', '昨天承诺带竹条不等于今天已经带来，不能说扛来了、备齐了或做完了', '不把 NPC 自述的历史行动当作本次新行动结果重述'] },
];
