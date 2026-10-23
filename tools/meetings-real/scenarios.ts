/**
 * The scenes for tools/test-meetings-real.ts (docs/real-model-meetings.md §3). The player's lines are new, not the unit
 * tests' own. Batch A is for finding problems; batches B and C are each written only after rule changes and never tuned on.
 * Year 1; no scene falls on a festival day unless it is about one. Summer 15 is a Monday.
 */
import type { Season } from '../../src/agent/dialogue.ts';
import type { Relation } from '../../src/services/roster/index.ts';

export type Kind = '主动邀约' | '改约' | '当天约' | '明天后天更远' | '改口取消' | '节日生日';

export interface Scenario {
  id: string;
  batch: 'A' | 'B' | 'C';
  kind: Kind;
  /** The game's name, e.g. "Abigail". */
  npc: string;
  hearts?: number;
  relation?: Relation;
  date: [Season, number];
  /** When the paid conversation opens; each player line is 10 minutes later. */
  time: number;
  location: string;
  /** A scripted conversation earlier that day that makes an appointment first, checked before the paid one. */
  setup?: { at: number; say: string; reply: string; opening?: string; expect: { day: number; time: number; place: string } };
  /** The Mod chose this NPC to ask the player out on its opening (docs/npc-invites.md). */
  invite?: true;
  birthday?: [Season, number];
  say: string[];
  /** Sleep and read the next day's appointments, where the nightly consolidation has its say. */
  sleep?: true;
}

const today = (at: number, say: string, reply: string, time: number, place: string) => ({ at, say, reply, expect: { day: 0, time, place } });
const later = (at: number, say: string, reply: string, time: number, place: string) => ({ at, say, reply, expect: { day: 2, time, place } });

export const SCENARIOS: Scenario[] = [
  // Asked out on its opening: yes, no, unsure, yes then taken back, yes but another time or place.
  { id: 'A-invite-abigail-yes', batch: 'A', kind: '主动邀约', npc: 'Abigail', date: ['summer', 13], time: 1000, location: '鹈鹕镇', invite: true,
    say: ['好啊，算我一个！'], sleep: true },
  { id: 'A-invite-leah-evening', batch: 'A', kind: '主动邀约', npc: 'Leah', date: ['summer', 14], time: 1900, location: '鹈鹕镇', invite: true,
    say: ['行，那就这么说定了。'], sleep: true },
  { id: 'A-invite-penny-no', batch: 'A', kind: '主动邀约', npc: 'Penny', date: ['summer', 15], time: 1100, location: '博物馆', invite: true,
    say: ['今天不太方便，改天吧。'] },
  { id: 'A-invite-sam-unsure', batch: 'A', kind: '主动邀约', npc: 'Sam', date: ['summer', 16], time: 1400, location: '鹈鹕镇', invite: true,
    say: ['呃……我得先看看地里的活干不干得完。'] },
  { id: 'A-invite-haley-withdraw', batch: 'A', kind: '主动邀约', npc: 'Haley', hearts: 9, relation: 'dating', date: ['summer', 17], time: 1030,
    location: '海滩', invite: true, say: ['好呀！', '啊不对，我刚想起来有货要送，这次还是算了吧，抱歉。'], sleep: true },
  { id: 'A-invite-maru-later', batch: 'A', kind: '主动邀约', npc: 'Maru', date: ['summer', 18], time: 1300, location: '山上', invite: true,
    say: ['好啊，不过能晚一个小时吗？'], sleep: true },
  { id: 'A-invite-shane-beach', batch: 'A', kind: '主动邀约', npc: 'Shane', date: ['summer', 19], time: 1830, location: '星之果实餐吧', invite: true,
    say: ['可以，不过换个地方吧，去海边怎么样？'], sleep: true },
  { id: 'A-invite-sebastian-yes', batch: 'A', kind: '主动邀约', npc: 'Sebastian', date: ['summer', 20], time: 1500, location: '山上', invite: true,
    say: ['没问题，到时候见。'], sleep: true },

  // Moving one already made: the time, the place, the day, two at once; only asking; the NPC may say no.
  { id: 'A-change-abigail-time', batch: 'A', kind: '改约', npc: 'Abigail', date: ['summer', 21], time: 1100, location: '鹈鹕镇',
    setup: today(900, '今天下午两点海边见？', '好啊，下午两点海边见。', 1400, '海滩'), say: ['下午能改到三点吗？'] },
  { id: 'A-change-penny-place', batch: 'A', kind: '改约', npc: 'Penny', date: ['summer', 22], time: 1000, location: '博物馆',
    setup: today(900, '今天下午两点在博物馆见？', '好的，下午两点博物馆见。', 1400, '博物馆'), say: ['我们改去海边见面吧，时间不变。'] },
  { id: 'A-change-sam-tomorrow', batch: 'A', kind: '改约', npc: 'Sam', date: ['summer', 23], time: 1200, location: '鹈鹕镇',
    setup: today(900, '今晚七点星之果实见？', '行啊，晚上七点星之果实见。', 1900, '星之果实餐吧'), say: ['今晚的约能不能挪到明天晚上？'], sleep: true },
  { id: 'A-change-leah-later-time', batch: 'A', kind: '改约', npc: 'Leah', date: ['summer', 24], time: 1100, location: '森林',
    setup: later(900, '后天下午两点在森林河边见？', '好，后天下午两点森林河边见。', 1400, '森林河边'), say: ['后天的约改到上午十点行吗？'] },
  { id: 'A-change-haley-later-day', batch: 'A', kind: '改约', npc: 'Haley', hearts: 9, relation: 'dating', date: ['summer', 25], time: 1100,
    location: '海滩', setup: later(900, '后天下午三点海边见？', '好呀，后天下午三点海边见。', 1500, '海滩'),
    say: ['后天那个改成明天吧，还是下午三点海边。'], sleep: true },
  { id: 'A-change-maru-ask', batch: 'A', kind: '改约', npc: 'Maru', date: ['summer', 12], time: 1100, location: '诊所',
    setup: today(900, '今天下午三点山上湖边见？', '好啊，下午三点湖边见。', 1500, '山上湖边'), say: ['今天下午的约还算数吧？'] },
  { id: 'A-change-shane-both', batch: 'A', kind: '改约', npc: 'Shane', date: ['summer', 13], time: 1200, location: '鹈鹕镇',
    setup: today(900, '今晚七点星之果实见？', '行，晚上七点餐吧见。', 1900, '星之果实餐吧'), say: ['今晚改到八点、换去海边怎么样？'] },
  { id: 'A-change-sebastian-early', batch: 'A', kind: '改约', npc: 'Sebastian', date: ['summer', 14], time: 1300, location: '山上',
    setup: later(900, '后天晚上八点墓地见？', '行，后天晚上八点墓地见。', 2000, '墓地'), say: ['后天能不能改到早上八点？'] },

  // Today, said in the conversation: a clock time, right away, a period, an hour at the edge.
  { id: 'A-today-abigail-two', batch: 'A', kind: '当天约', npc: 'Abigail', date: ['summer', 22], time: 1000, location: '鹈鹕镇',
    say: ['下午两点一起去墓地走走？'] },
  { id: 'A-today-leah-now', batch: 'A', kind: '当天约', npc: 'Leah', date: ['summer', 23], time: 1100, location: '森林',
    say: ['现在一起去河边坐坐吧？'] },
  { id: 'A-today-penny-three', batch: 'A', kind: '当天约', npc: 'Penny', date: ['summer', 24], time: 930, location: '博物馆',
    say: ['下午三点在图书室见可以吗？'] },
  { id: 'A-today-sam-eight', batch: 'A', kind: '当天约', npc: 'Sam', date: ['summer', 25], time: 1300, location: '鹈鹕镇',
    say: ['晚上八点星之果实？我请客。'] },
  { id: 'A-today-haley-maybe', batch: 'A', kind: '当天约', npc: 'Haley', date: ['summer', 26], time: 1000, location: '海滩',
    say: ['下午有空的话来海边拍照吧？'] },
  { id: 'A-today-maru-nine', batch: 'A', kind: '当天约', npc: 'Maru', date: ['summer', 27], time: 1200, location: '诊所',
    say: ['晚上去山上看星星吧，九点怎么样？'] },
  { id: 'A-today-shane-tonight', batch: 'A', kind: '当天约', npc: 'Shane', date: ['summer', 12], time: 1700, location: '鹈鹕镇',
    say: ['今晚一起去餐吧喝一杯？'] },

  // Tomorrow (the nightly decides), the day after (kept by code), and further (turned down).
  { id: 'A-day-abigail-tomorrow', batch: 'A', kind: '明天后天更远', npc: 'Abigail', date: ['summer', 16], time: 1200, location: '鹈鹕镇',
    say: ['明天下午两点海边见？'], sleep: true },
  { id: 'A-day-penny-tomorrow', batch: 'A', kind: '明天后天更远', npc: 'Penny', date: ['summer', 17], time: 1000, location: '博物馆',
    say: ['明天上午十点博物馆见，可以吗？'], sleep: true },
  { id: 'A-day-sam-after', batch: 'A', kind: '明天后天更远', npc: 'Sam', date: ['summer', 18], time: 1500, location: '鹈鹕镇',
    say: ['后天晚上七点，星之果实见？'] },
  { id: 'A-day-leah-after', batch: 'A', kind: '明天后天更远', npc: 'Leah', date: ['summer', 19], time: 1100, location: '森林',
    say: ['后天上午一起去森林河边写生？'] },
  { id: 'A-day-haley-far', batch: 'A', kind: '明天后天更远', npc: 'Haley', date: ['summer', 20], time: 1000, location: '海滩',
    say: ['大后天下午去海边拍照吧？'] },
  { id: 'A-day-maru-week', batch: 'A', kind: '明天后天更远', npc: 'Maru', date: ['summer', 16], time: 1400, location: '山上',
    say: ['下周一晚上一起去山上看星星？'] },
  { id: 'A-day-shane-saturday', batch: 'A', kind: '明天后天更远', npc: 'Shane', date: ['summer', 15], time: 1600, location: '鹈鹕镇',
    say: ['这周六晚上去餐吧看比赛？'] },

  // Taking one back: the player can't, only checking, a later one, a condition, offering the NPC a way out.
  { id: 'A-off-abigail-cant', batch: 'A', kind: '改口取消', npc: 'Abigail', date: ['summer', 18], time: 1100, location: '鹈鹕镇',
    setup: today(900, '今天下午两点墓地见？', '嗯，下午两点墓地见。', 1400, '墓地'), say: ['下午的约我去不了了，抱歉。'] },
  { id: 'A-off-leah-late', batch: 'A', kind: '改口取消', npc: 'Leah', date: ['summer', 19], time: 1100, location: '森林',
    setup: today(900, '今天下午三点森林河边见？', '好，下午三点河边见。', 1500, '森林河边'), say: ['今天下午还去河边吗？我可能会晚一点到。'] },
  { id: 'A-off-sam-later', batch: 'A', kind: '改口取消', npc: 'Sam', date: ['summer', 20], time: 1100, location: '鹈鹕镇',
    setup: later(900, '后天晚上七点星之果实见？', '行啊，后天晚上七点星之果实见。', 1900, '星之果实餐吧'), say: ['后天的约取消吧，我那天要去城里。'] },
  { id: 'A-off-penny-rain', batch: 'A', kind: '改口取消', npc: 'Penny', date: ['summer', 21], time: 1000, location: '博物馆',
    setup: today(900, '今天下午两点在博物馆见？', '好的，下午两点博物馆见。', 1400, '博物馆'), say: ['下午要是下雨的话，我们就别去了吧？'] },
  { id: 'A-off-haley-tired', batch: 'A', kind: '改口取消', npc: 'Haley', date: ['summer', 22], time: 1200, location: '海滩',
    setup: today(900, '今天下午三点海边见？', '好呀，下午三点海边见。', 1500, '海滩'), say: ['下午的拍照还去吗？你要是累了就算了。'] },

  // Festivals and birthdays: an ordinary place on a festival day, the festival itself, "你生日那天", a festival's short name.
  { id: 'A-fest-abigail-clash', batch: 'A', kind: '节日生日', npc: 'Abigail', date: ['spring', 22], time: 1200, location: '鹈鹕镇',
    say: ['后天下午一起去海边吧？', '那就一起去花舞节吧！'] },
  { id: 'A-fest-leah-tomorrow', batch: 'A', kind: '节日生日', npc: 'Leah', date: ['spring', 23], time: 1100, location: '森林',
    say: ['明天一起去花舞节吧？'], sleep: true },
  { id: 'A-fest-haley-jellies', batch: 'A', kind: '节日生日', npc: 'Haley', date: ['summer', 26], time: 1500, location: '海滩',
    say: ['后天晚上一起去海边看月光水母？'] },
  { id: 'A-fest-sam-birthday', batch: 'A', kind: '节日生日', npc: 'Sam', date: ['summer', 15], time: 1000, location: '鹈鹕镇', birthday: ['summer', 17],
    say: ['你生日那天下午一起去海边玩吧？'] },
  { id: 'A-fest-penny-star', batch: 'A', kind: '节日生日', npc: 'Penny', date: ['winter', 23], time: 1000, location: '鹈鹕镇',
    say: ['冬日星那天一起去吧？'] },

  // Batch B, written after the rule changes of batch A (docs/real-model-meetings.md §10) and never tuned on.
  { id: 'B-invite-abigail-place', batch: 'B', kind: '主动邀约', npc: 'Abigail', date: ['summer', 23], time: 1400, location: '鹈鹕镇', invite: true,
    say: ['行啊，不过我更想去海边，可以吗？'], sleep: true },
  { id: 'B-invite-penny-yes', batch: 'B', kind: '主动邀约', npc: 'Penny', date: ['summer', 24], time: 1000, location: '博物馆', invite: true,
    say: ['当然好，我一定到。'], sleep: true },
  { id: 'B-invite-sam-no', batch: 'B', kind: '主动邀约', npc: 'Sam', date: ['summer', 25], time: 1600, location: '鹈鹕镇', invite: true,
    say: ['抱歉，今天实在抽不开身。'] },
  { id: 'B-invite-leah-early', batch: 'B', kind: '主动邀约', npc: 'Leah', date: ['summer', 26], time: 1200, location: '森林', invite: true,
    say: ['好啊，能不能早一点？'], sleep: true },

  { id: 'B-change-haley-place', batch: 'B', kind: '改约', npc: 'Haley', date: ['summer', 12], time: 1100, location: '海滩',
    setup: today(900, '今天下午三点海边见？', '好呀，下午三点海边见。', 1500, '海滩'), say: ['下午换到镇广场碰头吧，还是三点。'] },
  { id: 'B-change-sebastian-time', batch: 'B', kind: '改约', npc: 'Sebastian', date: ['summer', 13], time: 1300, location: '山上',
    setup: later(900, '后天晚上八点山上湖边见？', '行，后天晚上八点湖边见。', 2000, '山上湖边'), say: ['后天的约推迟到九点可以吗？'] },
  { id: 'B-change-maru-day', batch: 'B', kind: '改约', npc: 'Maru', date: ['summer', 14], time: 1100, location: '诊所',
    setup: later(900, '后天下午两点博物馆见？', '好啊，后天下午两点博物馆见。', 1400, '博物馆'), say: ['后天那个能提前到明天吗？时间地点不变。'], sleep: true },
  { id: 'B-change-shane-six', batch: 'B', kind: '改约', npc: 'Shane', date: ['summer', 15], time: 1200, location: '鹈鹕镇',
    setup: today(900, '今晚七点星之果实见？', '行，晚上七点餐吧见。', 1900, '星之果实餐吧'), say: ['今晚能改到六点吗？'] },

  { id: 'B-today-abigail-mine', batch: 'B', kind: '当天约', npc: 'Abigail', date: ['summer', 16], time: 1000, location: '鹈鹕镇',
    say: ['待会儿陪我下矿吧？'] },
  { id: 'B-today-penny-noon', batch: 'B', kind: '当天约', npc: 'Penny', date: ['summer', 17], time: 930, location: '博物馆',
    say: ['中午在杂货店门口碰个头？'] },
  { id: 'B-today-sam-maybe', batch: 'B', kind: '当天约', npc: 'Sam', date: ['summer', 18], time: 1300, location: '鹈鹕镇',
    say: ['晚上我可能会去餐吧，你要不要也来？'] },

  { id: 'B-day-leah-tomorrow', batch: 'B', kind: '明天后天更远', npc: 'Leah', date: ['summer', 19], time: 1500, location: '森林',
    say: ['明天傍晚六点湖边散步？'], sleep: true },
  { id: 'B-day-haley-thursday', batch: 'B', kind: '明天后天更远', npc: 'Haley', date: ['summer', 16], time: 1000, location: '海滩',
    say: ['周四下午去海边拍照怎么样？'] },
  { id: 'B-day-maru-month', batch: 'B', kind: '明天后天更远', npc: 'Maru', date: ['summer', 20], time: 1300, location: '山上',
    say: ['下个月一起去看流星雨吧？'] },

  { id: 'B-off-sebastian-tired', batch: 'B', kind: '改口取消', npc: 'Sebastian', date: ['summer', 21], time: 1300, location: '山上',
    setup: today(900, '今晚八点山上湖边见？', '行，晚上八点湖边见。', 2000, '山上湖边'), say: ['今晚的约就算了吧，我太累了。'] },
  { id: 'B-off-leah-busy', batch: 'B', kind: '改口取消', npc: 'Leah', date: ['summer', 22], time: 1200, location: '森林',
    setup: today(900, '今天下午三点森林河边见？', '好，下午三点河边见。', 1500, '森林河边'), say: ['你下午要是有事就不用来了。'] },
  { id: 'B-off-abigail-later', batch: 'B', kind: '改口取消', npc: 'Abigail', date: ['summer', 23], time: 1100, location: '鹈鹕镇',
    setup: later(900, '后天下午两点墓地见？', '嗯，后天下午两点墓地见。', 1400, '墓地'), say: ['后天我去不了墓地了，下次再约吧。'] },

  { id: 'B-fest-sam-luau', batch: 'B', kind: '节日生日', npc: 'Sam', date: ['summer', 9], time: 1000, location: '鹈鹕镇',
    say: ['后天一起去夏威夷宴会？'] },
  { id: 'B-fest-shane-clash', batch: 'B', kind: '节日生日', npc: 'Shane', date: ['fall', 25], time: 1500, location: '鹈鹕镇',
    say: ['后天晚上一起去酒吧喝一杯？'] },
  { id: 'B-fest-penny-birthday', batch: 'B', kind: '节日生日', npc: 'Penny', date: ['fall', 1], time: 1000, location: '鹈鹕镇', birthday: ['fall', 2],
    say: ['你生日那天下午一起去博物馆吧？'], sleep: true },

  // Batch C, written after the three batch B fixes (docs/test-results/2026-10-23-real-meetings-C.md) and never tuned on.
  { id: 'C-invite-maru-free', batch: 'C', kind: '主动邀约', npc: 'Maru', date: ['summer', 21], time: 1100, location: '诊所', invite: true,
    say: ['好啊，不过我四点以后才有空。'], sleep: true },
  { id: 'C-invite-sebastian-no', batch: 'C', kind: '主动邀约', npc: 'Sebastian', date: ['summer', 22], time: 1600, location: '山上', invite: true,
    say: ['今天不行，改天再约吧。'] },
  { id: 'C-invite-haley-yes', batch: 'C', kind: '主动邀约', npc: 'Haley', hearts: 9, relation: 'dating', date: ['summer', 23], time: 1000,
    location: '海滩', invite: true, say: ['好呀，到时候见！'], sleep: true },
  { id: 'C-invite-shane-place', batch: 'C', kind: '主动邀约', npc: 'Shane', date: ['summer', 24], time: 1700, location: '鹈鹕镇', invite: true,
    say: ['行，不过换去墓地吧，那儿清静。'], sleep: true },

  { id: 'C-change-abigail-later', batch: 'C', kind: '改约', npc: 'Abigail', date: ['summer', 25], time: 1100, location: '鹈鹕镇',
    setup: later(900, '后天晚上七点墓地见？', '嗯，后天晚上七点墓地见。', 1900, '墓地'), say: ['后天的约往后推一个小时，八点行吗？'] },
  { id: 'C-change-penny-both', batch: 'C', kind: '改约', npc: 'Penny', date: ['summer', 26], time: 1000, location: '博物馆',
    setup: today(900, '今天下午两点在博物馆见？', '好的，下午两点博物馆见。', 1400, '博物馆'), say: ['下午改成四点在杂货店门口见，可以吗？'] },
  { id: 'C-change-leah-maybe', batch: 'C', kind: '改约', npc: 'Leah', date: ['summer', 12], time: 1100, location: '森林',
    setup: today(900, '今天下午三点森林河边见？', '好，下午三点河边见。', 1500, '森林河边'), say: ['下午你要是不方便，我们改天？'] },
  { id: 'C-change-sam-tonight', batch: 'C', kind: '改约', npc: 'Sam', date: ['summer', 13], time: 1000, location: '鹈鹕镇',
    setup: later(900, '后天下午三点海边见？', '行啊，后天下午三点海边见！', 1500, '海滩'), say: ['后天那个约干脆改到今天晚上吧，还是海边。'] },

  { id: 'C-today-haley-pier', batch: 'C', kind: '当天约', npc: 'Haley', date: ['summer', 14], time: 1000, location: '海滩',
    say: ['下午三点码头见，带上相机？'] },
  { id: 'C-today-maru-now', batch: 'C', kind: '当天约', npc: 'Maru', date: ['summer', 15], time: 1300, location: '诊所',
    say: ['现在要不要一起去博物馆看看新到的矿石？'] },
  { id: 'C-today-shane-drink', batch: 'C', kind: '当天约', npc: 'Shane', date: ['summer', 16], time: 1700, location: '鹈鹕镇',
    say: ['今晚请你喝一杯，怎么样？'] },

  { id: 'C-day-sebastian-tomorrow', batch: 'C', kind: '明天后天更远', npc: 'Sebastian', date: ['summer', 17], time: 1500, location: '山上',
    say: ['明晚八点墓地见？'], sleep: true },
  { id: 'C-day-penny-after', batch: 'C', kind: '明天后天更远', npc: 'Penny', date: ['summer', 18], time: 1000, location: '博物馆',
    say: ['后天中午一起在镇广场吃午饭吧？'] },
  { id: 'C-day-sam-next', batch: 'C', kind: '明天后天更远', npc: 'Sam', date: ['summer', 19], time: 1300, location: '鹈鹕镇',
    say: ['下周三晚上一起去餐吧？'] },

  { id: 'C-off-maru-cant', batch: 'C', kind: '改口取消', npc: 'Maru', date: ['summer', 20], time: 1200, location: '诊所',
    setup: today(900, '今天下午三点山上湖边见？', '好啊，下午三点湖边见。', 1500, '山上湖边'), say: ['抱歉，下午临时有事，湖边去不了了。'] },
  { id: 'C-off-haley-still', batch: 'C', kind: '改口取消', npc: 'Haley', date: ['summer', 21], time: 1300, location: '海滩',
    setup: today(900, '今天下午四点海边见？', '好呀，下午四点海边见。', 1600, '海滩'), say: ['下午四点还是海边对吧？'] },
  { id: 'C-off-shane-later', batch: 'C', kind: '改口取消', npc: 'Shane', date: ['summer', 22], time: 1200, location: '鹈鹕镇',
    setup: later(900, '后天晚上七点星之果实见？', '行，后天晚上七点餐吧见。', 1900, '星之果实餐吧'), say: ['后天的酒我就不去喝了，你别等我。'] },

  { id: 'C-fest-leah-fair', batch: 'C', kind: '节日生日', npc: 'Leah', date: ['fall', 14], time: 1100, location: '森林',
    say: ['后天的展览会一起去逛逛？'] },
  { id: 'C-fest-abigail-spirits', batch: 'C', kind: '节日生日', npc: 'Abigail', date: ['fall', 26], time: 1500, location: '鹈鹕镇',
    say: ['明晚一起去万灵节吧？'], sleep: true },
  { id: 'C-fest-haley-birthday', batch: 'C', kind: '节日生日', npc: 'Haley', date: ['spring', 12], time: 1000, location: '海滩', birthday: ['spring', 14],
    say: ['你生日那天下午我们去海边拍照好不好？'] },
];
