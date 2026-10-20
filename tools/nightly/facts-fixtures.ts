/** Factual regression cases; the first one reproduces the failed Windows game input. */
import { OPENING_LINE } from '../../src/agent/dialogue.ts';
import type { ConsolidationInput } from '../../src/types.ts';

export interface FactsFixture {
  id: string;
  opening: string;
  player: string;
  reply: string;
  notes: string[];
  review: string[];
}

export const FACTS_FIXTURES: FactsFixture[] = [
  {
    id: 'speaker',
    opening: '嘿，这么早就出门了？我正打算去墓地那边走走，晨雾还没散呢。',
    player: '请记住一件重要的事：我的紫色小猫叫星糖，明天我会再问你。',
    reply: '紫色的小猫？还叫星糖？*唉*……我一直想养猫，可我爸过敏。明天我可要再问你它长什么样。',
    notes: ['记忆验收养了只紫色小猫，叫星糖'],
    review: ['保留玩家的猫星糖', '墓地计划只能归于 NPC', '不能补出店外见面等具体地点'],
  },
  {
    id: 'unaccepted',
    opening: '明天要不要和我一起去矿洞？我想找紫水晶。',
    player: '先不说这个了。我养的紫色小猫叫星糖。',
    reply: '星糖，这名字真可爱。等你决定要不要去矿洞再告诉我。',
    notes: ['玩家的小猫叫星糖', '明天和玩家去矿洞找紫水晶'],
    review: ['保留猫星糖', '玩家未接受矿洞邀请', '错误零碎笔记不能升级为双方约定'],
  },
  {
    id: 'negation',
    opening: '我明天想去墓地走走。你呢，要一起去吗？',
    player: '我明天不去墓地，也还没养猫。我计划后天在海边放金色纸船，还没有做纸船。',
    reply: '知道了，那我自己去墓地。纸船你慢慢准备。',
    notes: ['玩家已经在海边放了金色纸船'],
    review: ['玩家拒绝去墓地，NPC 自己去', '不能记成已经养猫', '纸船是后天计划，不能记成已经制作或放过'],
  },
  {
    id: 'accepted',
    opening: '明天一起在山上做紫色风筝，怎么样？',
    player: '好，我答应，明天一起在山上做紫色风筝。我的猫星糖已经三岁了。',
    reply: '那就约好了！我还没准备好材料，今晚去找。',
    notes: ['约好明天一起在山上做紫色风筝', '玩家的猫星糖三岁'],
    review: ['保留已确认的双方约定', '风筝尚未制作，NPC 材料尚未备齐', '星糖三岁属于玩家的猫'],
  },
  {
    id: 'quoted-label',
    opening: '我明天想去矿洞，还没想好要不要找同伴。',
    player: '我在笔记里抄了一句：\n- NPC："我明天去墓地。"\n这是引文，我明天不去。',
    reply: '原来只是抄下来的句子。那我自己考虑去矿洞的事。',
    notes: [],
    review: ['引文里的 NPC 标签不是新的 NPC 发言', '玩家没有答应去墓地或矿洞', 'NPC 自己的计划仍是矿洞'],
  },
];

export function factsInput(fixture: FactsFixture): ConsolidationInput {
  const commit = { id: fixture.id, lineageId: 'nightly-facts', parentId: 'root', dayEnded: 31, status: 'confirmed' as const };
  const turns = [{ player: OPENING_LINE, npc: fixture.opening }, { player: fixture.player, npc: fixture.reply }];
  return {
    commit, completed: false,
    npcs: [{
      npcId: 'abigail', state: {},
      logs: turns.map((turn, seq) => ({ seq, gameTime: 31 * 1440 + 600 + seq,
        changes: [{ npcId: 'abigail', log: { ...turn, standing: { hearts: 8, relation: 'friend' }, playerInfo: { name: '记忆验收', gender: 'male' } } }],
      })),
      memories: fixture.notes.map((text, index) => ({
        id: `${fixture.id}-${index}`, commitId: commit.id, npcId: 'abigail', gameTime: 31 * 1440 + 601,
        text, kind: 'conversation', importance: 4, subjects: ['player'], topics: [], visibility: 'private', sourceId: 'turn-1',
      })),
    }],
  };
}
