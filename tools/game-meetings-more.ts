/** Native acceptance for the remaining appointment features, using disposable world/save fixtures. */
import type { FriendshipHost } from './game-meeting-friendship.ts';
import { prepareMine } from './game-mine-companion.ts';
import type { State } from './test-game-world.ts';

export interface MoreState { rocks: number; mining: number; level: number; levels: number; ladder: boolean | null;
  stone: { exists: boolean; health: number | null; id: string | null } | null; barrel: boolean; loot: (string | null)[];
  mined: Record<string, number>; items: Record<string, number>; travel: string[] }
const plan = (state: State) => state.actions!.meetings.find(m => m.Npc === 'Abigail')!;
const outing = (state: State) => state.outing!.meetings.find(m => m.Npc === 'Abigail')!;

export async function runMeetingsMore(h: FriendshipHost, section: string) {
  const { rpc, check, chapter } = h;
  const observe = (ticks = 90) => rpc('outing-observe', { ticks });
  async function fresh(day = 6, season = 'spring', time = 1000, npc = 'Abigail') {
    h.seedNight(false); h.setMood(0); await chapter(season, day); await rpc('action-reset'); await rpc('mine-unlock');
    await rpc('clock', { time }); await rpc('action-place', { npc, map: 'Desert', x: 10, y: 10, targetX: 11, targetY: 10, next: 2200 });
    await rpc('config', { NpcMeetings: true, NpcInvites: false, NpcApproach: false, MeetingsGoTogether: false, NpcMineCompanion: true,
      MeetingsChangeFriendship: true, ChatChangesFriendship: true });
    return rpc('warp', { map: 'FarmHouse', x: 3, y: 4 });
  }
  async function converse(player: string, reply: string, opening = '你好。') {
    h.setReply(opening); h.setMood(0); await rpc('talk-open', { npc: 'Abigail', keepFriendship: true });
    h.setReply(reply); await rpc('talk-say', { text: player, label: 'meetings-more' }); await h.close(); return observe();
  }
  async function arrive(state: State) {
    if (!plan(state).Warp) await rpc('action-schedule-due', { time: plan(state).Depart });
    await rpc('clock', { time: plan(state).Time }); return rpc('action-meeting-wait', { natural: true });
  }
  const all = section === 'meetings-more';
  if (all || section === 'more-dialogue') {
    await fresh(); let state = await converse('早一点一起去海边吧？', '好啊，一起去海边吧。');
    check('more-a-little-earlier-is-immediate-not-one-oclock', plan(state).Time === 1000 && plan(state).Place === '海滩', state.actions);
    await fresh(); state = await converse('下午一点海边见？', '好啊，下午一点海边见。');
    check('more-a-real-one-oclock-remains-thirteen', plan(state).Time === 1300, state.actions);
    await fresh(); await converse('今天下午两点一起去海边吧？', '好啊，两点海边见。');
    await rpc('clock', { time: 1100 }); state = await converse('下午的约改成五点在广场吧？', '好呀。');
    check('more-native-reschedule-replaces-the-old-plan', plan(state).Time === 1700 && plan(state).Place === '镇广场'
      && plan(state).Applied && !plan(state).Reported, state.actions);
    state = await rpc('mine-hud');
    check('more-native-reschedule-shows-the-original-hud', (state.native?.hud as string[]).some(text => /改到.*17:00.*镇广场/.test(text)), state.native);
    await rpc('clock', { time: 1200 }); state = await converse('今天的改到明天下午三点吧？', '好，明天下午三点见。');
    check('more-moving-to-tomorrow-releases-today', plan(state).Reported && JSON.stringify(h.dayMeetings().at(-1)).includes('movedTo'), state.actions);
    await rpc('sleep'); await rpc('title'); await rpc('load'); state = await observe(150);
    check('more-moved-date-survives-native-save-and-reload', plan(state).Time === 1500 && plan(state).Place === '镇广场', state.actions);
    await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 }); state = await arrive(state);
    check('more-moved-appointment-really-arrives-at-the-new-place', plan(state).Arrived && !plan(state).Met && plan(state).spot.map === 'Town', state.actions);
    await rpc('warp', { map: 'Town', x: 52, y: 68 }); state = await observe();
    check('more-rescheduled-arrival-meets-the-player', plan(state).Met, state.actions);
    state = await converse('改成明天下午四点海边见吧？', '好啊，明天下午四点海边见。');
    check('more-cannot-reschedule-after-they-have-met', plan(state).Time === 1500 && plan(state).Place === '镇广场' && !plan(state).Reported, state.actions);
  }
  if (all || section === 'more-festivals') {
    await fresh(11, 'fall'); let state = await converse('你生日那天下午一起去海边吧？', '好啊，生日那天下午两点海边见。');
    const birthday = h.packets('talk.open').at(-1)?.birthday as { season: string; day: number };
    check('more-birthday-comes-from-the-native-npc', birthday?.season === 'fall' && birthday.day === 13, birthday);
    h.setReply('记得。'); await h.say('Abigail', '我们约在什么时候？', 'more-birthday-recall');
    check('more-birthday-creates-the-right-future-contract', h.latestSystem().includes('后天') && h.latestSystem().includes('14:00')
      && h.latestSystem().includes('海滩'), h.latestSystem()); await h.close();
    await fresh(22); await converse('花舞节那天一起去吧？', '好啊，花舞节一起去。');
    await rpc('sleep'); await rpc('sleep'); state = await observe(150);
    check('more-festival-note-becomes-a-native-festival-plan', plan(state).Festival === 'spring24' && plan(state).Time === 900 && plan(state).Applied, state.actions);
    state = await rpc('festival-open', { map: 'Forest', x: 1, y: 20, time: 1000 });
    check('more-native-flower-dance-cast-fulfills-the-appointment', state.festival?.actors.includes('Abigail') && plan(state).Met, { actions: state.actions, festival: state.festival });
    const wire = h.wireCount(); await rpc('festival-leave'); state = await observe(150);
    check('more-leaving-the-native-festival-reports-kept-once', h.packets('meet.ended', wire).filter(p => p.place === '花舞节' && p.met === true).length === 1, h.packets('meet.ended', wire));
    await fresh(24, 'spring', 600, 'Dwarf');
    await rpc('action-meetings', { npc: 'Dwarf', meetings: [{ npc: 'dwarf', place: '花舞节', time: 900 }] });
    const beforeAbsent = (await rpc('friendship-inspect', { npc: 'Dwarf' })).native!.points;
    state = await rpc('festival-open', { map: 'Forest', x: 1, y: 20, time: 1000 });
    check('more-festival-absence-fixture-uses-the-real-cast', !state.festival?.actors.includes('Dwarf'), state.festival);
    const absentWire = h.wireCount(); await rpc('festival-leave'); await observe(120);
    const absentPoints = (await rpc('friendship-inspect', { npc: 'Dwarf' })).native!.points;
    check('more-an-absent-festival-npc-cannot-penalize-the-player-who-attended', absentPoints === beforeAbsent
      && !h.packets('meet.ended', absentWire).some(packet => packet.npc === 'Dwarf' && packet.stoodUp === true), h.packets('meet.ended', absentWire));
    await fresh(24, 'spring', 600);
    await rpc('action-meetings', { meetings: [{ npc: 'abigail', place: '花舞节', time: 900 }] });
    const missedWire = h.wireCount(); await rpc('clock', { time: 2200 }); await rpc('sleep');
    check('more-missing-the-festival-still-counts-as-a-no-show', h.packets('meet.ended', missedWire)
      .some(packet => packet.npc === 'Abigail' && packet.met === false && packet.stoodUp === true && Number(packet.friendship) < 0), h.packets('meet.ended', missedWire));
    await fresh(26, 'summer'); state = await converse('月光水母那天一起在海边看水母吧？', '好啊，月光水母起舞那天一起去。');
    await rpc('sleep'); await rpc('sleep'); await rpc('title'); await rpc('load'); state = await observe(150);
    check('more-evening-festival-keeps-twenty-two-oclock', plan(state)?.Festival === 'summer28' && plan(state).Time === 2200, state.actions);
    await rpc('festival-open', { map: 'Beach', x: 33, y: 34, time: 2200 }); await rpc('festival-leave'); state = await observe(150);
    check('more-native-moonlight-jellies-is-a-kept-appointment', plan(state).Reported && plan(state).Met, state.actions);
    await fresh(22); state = await converse('后天下午一起去海边吧？', '那天是花舞节，我们一起去花舞节吧。');
    check('more-festival-clash-adds-the-one-turn-hint', h.latestSystem().includes('是花舞节') && h.latestSystem().includes('普通地方约不了'), h.latestSystem());
    h.setReply('你好。'); await rpc('talk-open', { npc: 'Abigail', keepFriendship: true });
    check('more-festival-clash-hint-does-not-persist-next-opening', !h.latestSystem().includes('普通地方约不了'), h.latestSystem()); await h.close();
  }
  if (all || section === 'more-leading') {
    async function prepareLead() {
      await fresh(); await rpc('action-place', { map: 'Town', x: 50, y: 68, targetMap: 'ArchaeologyHouse', targetX: 11, targetY: 9, next: 2200 });
      await rpc('config', { MeetingsGoTogether: true }); let state = await converse('今天上午十一点海边见？', '好啊，十一点海边见。');
      state = await arrive(state); await rpc('warp', { map: 'Beach', x: 33, y: 34 }); state = await observe(120);
      check('more-leading-starts-as-a-real-outing', outing(state).Together, state.outing);
      await rpc('clock', { time: 1130 }); return observe(90);
    }
    let state = await prepareLead();
    check('more-after-thirty-minutes-suggests-an-original-schedule-place', outing(state).Leading === '博物馆' && outing(state).Suggested
      && outing(state).actor.text === '要不要去博物馆看看？', state.outing);
    await rpc('warp', { map: 'Town', x: 50, y: 68 }); state = await observe(30);
    check('more-leading-survives-player-ahead-on-the-route', outing(state).Leading === '博物馆' && outing(state).actor.map === 'Town', state.outing);
    state = await rpc('more-lead-follow');
    check('more-npc-really-leads-through-native-maps-to-the-museum', outing(state).Leading === null && outing(state).actor.map === 'ArchaeologyHouse'
      && state.more!.travel.length > 10 && state.more!.travel.some(p => p.startsWith('Town:')), { outing: state.outing, more: state.more });
    check('more-leading-destination-enters-the-outing-history', outing(state).fields.places.some(place => /博物馆/.test(place)), state.outing);
    await rpc('clock', { time: 1140 }); state = await observe(120);
    check('more-leading-is-suggested-only-once', outing(state).Leading === null && outing(state).Suggested, state.outing);
    await prepareLead(); await rpc('warp', { map: 'Forest', x: 66, y: 50 }); state = await observe(150);
    check('more-a-different-door-cancels-leading-and-rejoins', outing(state).Leading === null && outing(state).Together && outing(state).actor.map === 'Forest', state.outing);
  }
  if (all || section === 'more-visits') {
    let state = await rpc('snapshot'); let visitDay = state.invites!.visitDays[0];
    check('more-visit-fixture-has-a-native-weekly-draw-day', visitDay !== undefined, state.invites);
    async function visitor(lastAsked?: number, stoodUp?: number) {
      await fresh(visitDay!, 'spring', 700); await rpc('farm-fixture');
      await rpc('invite-fixture', { ...(lastAsked === undefined ? {} : { lastAsked }), ...(stoodUp === undefined ? {} : { stoodUp }) });
      await rpc('action-place', { map: 'Desert', x: 10, y: 10, targetX: 11, targetY: 10, next: 2200 });
      await rpc('config', { NpcInvites: false }); return rpc('action-meetings', { meetings: [] });
    }
    state = await visitor();
    check('more-weekly-visitor-is-created-without-an-invitation', plan(state)?.Surprise && plan(state).Time === 900 && plan(state).Place === '农场', state.actions);
    const points = (await rpc('friendship-inspect')).native!.points;
    state = await rpc('farm-start', { speed: 8 });
    check('more-unasked-visitor-really-does-the-farm-work', plan(state).Stage === 1 && Number(plan(state).Helped?.Harvested) > 0, state.actions);
    await rpc('warp', { map: 'Farm', x: state.farm!.porch.X + 2, y: state.farm!.porch.Y }); await observe();
    h.setReply('我自己来帮帮忙。'); await h.say('Abigail', '咦，你怎么来了？', 'more-surprise-visit');
    check('more-visit-prompt-identifies-unasked-help', h.latestSystem().includes('没约就自己来') && h.packets('talk.open').at(-1)?.visit === true, h.latestSystem()); await h.close();
    await rpc('clock', { time: plan(state).Leave }); await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 }); state = await rpc('farm-wait', { until: 'gone', speed: 8 });
    const packet = h.packets('meet.ended').at(-1);
    check('more-unasked-help-has-no-appointment-friendship', packet?.surprise === true && packet.friendship === undefined
      && (await rpc('friendship-inspect')).native!.points === points, packet);
    h.setReply('记得，我是自己来的。'); await h.say('Abigail', '刚才为什么来农场？', 'more-surprise-memory');
    check('more-unasked-help-has-its-own-memory', /我没约就去(?:了)?农场主的农场帮(?:了)?忙/.test(h.latestSystem()), h.latestSystem()); await h.close();
    const today = state.invites!.today;
    state = await visitor(today - 1);
    check('more-visits-do-not-inherit-the-invitation-seven-day-gap', plan(state)?.Surprise, state.actions);
    state = await visitor(undefined, today - 2);
    check('more-visits-respect-a-recent-no-show', state.actions!.meetings.length === 0, state.actions);
  }
  if (all || section === 'more-mining') {
    for (const npc of ['Abigail', 'Haley']) {
      h.setReply(''); await prepareMine(h, npc, 8, true, true); await rpc('mine-level', { floor: 5 });
      let state = await rpc('more-stones', { npc, boundary: true }); const before = state.more!;
      state = await observe(100);
      check('more-hard-ore-needs-multiple-native-hits-' + npc, state.more!.stone?.exists && Number(state.more!.stone.health) < 3, state.more);
      state = await observe(260);
      check('more-real-stone-break-drops-loot-and-opens-a-ladder-' + npc, !state.more!.stone?.exists && state.more!.rocks === before.rocks + 1
        && state.more!.mined[npc] === before.mined[npc]! + 1 && state.more!.ladder
        && (state.more!.loot.some(Boolean) || Object.entries(state.more!.items).some(([id, count]) => count > (before.items[id] ?? 0))), state.more);
      check('more-mining-gives-no-mining-experience-or-level-' + npc, state.more!.mining === before.mining && state.more!.level === before.level
        && state.more!.levels === before.levels, { before, after: state.more });
      check('more-mining-keeps-breakable-containers-intact-' + npc, state.more!.barrel, state.more);
      h.setReply('刚才敲了石头。'); await h.say(npc, '你帮我敲碎了几块石头？', 'more-mined-recall');
      check('more-mining-count-reaches-the-live-prompt-' + npc, h.latestSystem().includes(`敲碎了 ${state.more!.mined[npc]} 块石头`), h.latestSystem()); await h.close();
    }
    await prepareMine(h); await rpc('mine-level', { floor: 5 }); let state = await rpc('more-stones', { monster: true });
    state = await observe(100);
    check('more-fighter-prioritizes-a-living-monster-over-ore', state.more!.stone?.health === 3 && state.mine!.targets.some(m => m.Health < m.MaxHealth), { more: state.more, mine: state.mine });
  }
  if (all || section === 'more-moods') {
    await fresh(); let state = await converse('今天上午十一点海边见？', '好啊，十一点海边见。'); state = await arrive(state);
    await rpc('clock', { time: plan(state).Leave }); state = await observe(120);
    check('more-a-real-no-show-records-its-day-and-reliable-field', state.invites!.stoodUp.Abigail === state.invites!.today
      && h.packets('meet.ended').at(-1)?.stoodUp === true, h.packets('meet.ended').at(-1));
    await rpc('sleep'); await rpc('title'); await rpc('load'); await observe(120);
    h.setReply('上次没等到你。'); await h.say('Abigail', '你好。', 'more-stood-up-mood');
    check('more-no-show-mood-survives-native-save', h.latestSystem().includes('你还记着') && h.latestSystem().includes('农场主没来'), h.latestSystem()); await h.close();
    await rpc('friendship-fixture', { points: 2000 }); state = await rpc('snapshot');
    check('more-no-show-excludes-an-otherwise-close-npc-from-inviting', !state.invites!.eligible.includes('Abigail'), state.invites);
    const day = state.invites!.days.find(day => day >= 5 && day < 26)!;
    await fresh(day); await rpc('invite-fixture'); await rpc('action-place', { map: 'Desert', x: 10, y: 10, targetX: 11, targetY: 10, next: 2200 });
    await rpc('config', { NpcInvites: true }); await rpc('action-meetings', { meetings: [] });
    await converse('今天不行，下次吧。', '没关系，下次吧。', '今天下午三点，一起去海滩走走好吗？');
    h.setReply('没有约成。'); await h.say('Abigail', '你好。', 'more-turned-down-today');
    check('more-rejection-mood-says-it-was-declined-without-waiting', h.latestSystem().includes('农场主当场说不行，没约成')
      && !h.latestSystem().includes('你还记着'), h.latestSystem()); await h.close();
    await rpc('sleep'); await rpc('title'); await rpc('load'); await observe(120);
    h.setReply('昨天没有约成。'); await h.say('Abigail', '你好。', 'more-turned-down-saved');
    check('more-rejection-mood-survives-one-native-saved-day', h.latestSystem().includes('昨天你开口约农场主出去，农场主当场说不行，没约成'), h.latestSystem()); await h.close();
    await rpc('sleep'); h.setReply('你好。'); await h.say('Abigail', '你好。', 'more-turned-down-expired');
    check('more-rejection-mood-expires-after-one-day', !h.latestSystem().includes('农场主当场说不行，没约成'), h.latestSystem()); await h.close();
  }
  h.setReply(''); h.setMood(0);
}
