/**
 * What happened at a festival, remembered by the NPCs who were there (docs/festival-memories.md). Like a gift note
 * (src/agent/gifts.ts), each note comes from a template, without a model call.
 */
import type { MemoryDraft } from '../types.ts';

/** Festivals with a result worth remembering, by the game's festival id. */
export const FESTIVALS = ['spring13', 'spring24', 'summer11', 'fall16', 'winter8', 'winter25'] as const;
export type Festival = typeof FESTIVALS[number];
/** First to third place, 4 for none, or the mayor's shorts on display. */
export type GrangeResult = 1 | 2 | 3 | 4 | 'shorts';
export const SOUP_LEVELS = 7;
/** Lets backstage scenes find a recent festival to talk about (docs/scheduler.md §4.3). */
export const FESTIVAL_TOPIC = 'festival';

export interface FestivalResults {
  festival: Festival;
  /** NPC ids seen at the festival. */
  present: readonly string[];
  /** Whom the player danced with. */
  dance: string | null;
  /** Both sides of the secret gift exchange, once the player handed theirs over. */
  santa: { recipient: string; giver: string } | null;
  /** The NPC winner is fixed by the vanilla script; another player winning is not reported. */
  contest: 'player' | 'npc' | null;
  grange: GrangeResult | null;
  /** The governor's reaction, 0 (fainted) to 6 (the mayor's shorts), as the vanilla luau numbers it. */
  soup: number | null;
}

export interface FestivalNote { npcId: string; memory: MemoryDraft }

const CONTESTS = {
  spring13: { festival: '复活节', contest: '彩蛋大寻宝', winner: 'abigail' },
  winter8: { festival: '冰雪节', contest: '钓鱼比赛', winner: 'willy' },
} as const;
const PLACES = ['第一名', '第二名', '第三名'];
const SOUP = [
  '州长喝了汤，说太难喝，当场晕了过去。', '州长喝了汤，嫌味道恶心。', '州长喝了汤，说味道很普通。', '州长喝了汤，夸汤很好喝。',
  '州长喝了汤，说从没喝过这么好喝的汤。', '州长喝了汤，说味道淡了，好像少了一个人的材料。',
];

/**
 * Who remembers what; `name` gives an NPC id's name on its card. Those the result is about always remember it in
 * their own words; everyone else only if they were there, and says so, or the model has a shy NPC say it stayed home
 * (docs/festival-memories.md §4). No relative dates: recall adds “3 天前” itself. Nothing nobody can be sure of is put
 * on the player, such as who spoiled the soup.
 */
export function festivalMemories(results: FestivalResults, name: (id: string) => string): FestivalNote[] {
  const notes: FestivalNote[] = [];
  const note = (npcId: string, text: string, importance: number, subjects: string[] = ['player']) =>
    notes.push({ npcId, memory: { text, importance, kind: 'observation', subjects, topics: [FESTIVAL_TOPIC], visibility: 'normal' } });
  const others = (...involved: string[]) => [...new Set(results.present)].filter((id) => !involved.includes(id));
  const lewis = 'lewis';

  switch (results.festival) {
    case 'spring24': {
      const partner = results.dance;
      if (!partner) break;
      note(partner, '花舞节上农场主邀请我跳舞，我们一起跳了。', 4);
      for (const id of others(partner)) note(id, `花舞节上我看到农场主和${name(partner)}跳了舞。`, 2, ['player', partner]);
      break;
    }
    case 'winter25': {
      const santa = results.santa;
      if (!santa) break;
      note(santa.recipient, '冬日星盛宴上农场主抽到给我送礼，送了我礼物。', 3);
      note(santa.giver, '冬日星盛宴上我抽到给农场主送礼，礼物送到了。', 3);
      break;
    }
    case 'spring13':
    case 'winter8': {
      const { festival, contest, winner } = CONTESTS[results.festival];
      if (results.contest === 'player') {
        for (const id of others()) note(id, `${festival}上我看到农场主赢了${contest}。`, 2);
      } else if (results.contest === 'npc') {
        note(winner, `${festival}上我赢了${contest}，农场主没赢。`, 2);
        for (const id of others(winner)) note(id, `${festival}上我看到${name(winner)}赢了${contest}，农场主没赢。`, 2, ['player', winner]);
      }
      break;
    }
    case 'fall16': {
      const grange = results.grange;
      if (grange === 'shorts') {
        note(lewis, '星露谷展览会上农场主在展台里摆了我的紫色短裤。', 3);
        for (const id of others(lewis)) note(id, '星露谷展览会上我看到农场主在展台里摆了镇长的紫色短裤。', 3, ['player', lewis]);
      } else if (grange !== null) {
        const text = grange === 4 ? '星露谷展览会上我看到农场主的展台没评上名次。' : `星露谷展览会上我看到农场主的展台得了${PLACES[grange - 1]}。`;
        for (const id of others()) note(id, text, 2);
      }
      break;
    }
    case 'summer11': {
      const soup = results.soup;
      if (soup === null) break;
      if (soup === 6) {
        note(lewis, '夏威夷宴会的汤里有我的紫色短裤，州长气坏了。', 3, []);
        for (const id of others(lewis)) note(id, '夏威夷宴会上我看到汤里有镇长的紫色短裤，州长气坏了。', 3, [lewis]);
      } else {
        for (const id of others()) note(id, `夏威夷宴会上我看到${SOUP[soup]}`, soup === 0 ? 3 : 2, []);
      }
      break;
    }
  }
  return notes;
}
