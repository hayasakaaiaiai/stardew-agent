/** Calendar agreements through native dialogue, two real nights, reconnects and ordinary schedule arrivals. */
import type { TodayHost } from './game-same-day-meetings.ts';
import type { State } from './test-game-world.ts';

export async function runLaterMeetings(h: TodayHost) {
  const { rpc, check, chapter } = h;
  async function converse(npc: string, text: string, reply: string) {
    h.setReply('你好。'); await rpc('talk-open', { npc, keepFriendship: true });
    h.setReply(reply); const state = await rpc('talk-say', { text, label: 'later-meeting' });
    await h.close(); await rpc('wait', { ticks: 60 }); return state;
  }
  const mine = (state: State) => state.actions!.meetings.find(m => m.Npc === 'Abigail');
  async function published(time: number) {
    let state: State;
    for (let attempt = 0; ; attempt++) {
      state = await rpc('wait', { ticks: 30 });
      if (mine(state)?.Time === time || attempt >= 19) return state;
    }
  }
  await chapter('spring', 1); await rpc('action-reset'); await rpc('clock', { time: 1000 });
  await rpc('config', { NpcMeetings: true, NpcApproach: false });
  await converse('Abigail', '周三晚上八点星之果实餐吧见？', '好啊，八点星之果实餐吧见。');
  await converse('Leah', '周三下午两点海边见？', '好啊，周三下午两点海边见。');
  let state = await rpc('wait', { ticks: 60 });
  check('later-calendar-does-not-send-future-meetings-today', !state.actions!.meetings.length, state.actions);
  await h.restart(); await converse('Abigail', '你记得我们什么时候见面吗？', '后天晚上八点餐吧见。');
  check('later-reconnect-keeps-two-days-ahead-and-explicit-evening', h.latestSystem().includes('后天（周三）20:00 在星之果实餐吧见面'), h.latestSystem());
  await rpc('sleep'); await converse('Abigail', '我们明天约在哪里？', '明天晚上八点星之果实餐吧见。');
  check('later-real-night-shows-tomorrow-in-prompt', h.latestSystem().includes('明天（周三）20:00 在星之果实餐吧见面'), h.latestSystem());
  await converse('Leah', '明天不去海边了。', '好吧，那就不去了。'); await h.restart();
  await rpc('sleep'); await rpc('title'); await rpc('load'); state = await published(2000);
  check('later-real-two-nights-and-load-publish-only-active-ordinary-meeting', mine(state)?.Time === 2000
    && !state.actions!.meetings.some(m => m.Npc === 'Leah'), state.actions);
  const packets = h.dayMeetings().flatMap(packet => packet.meetings as Record<string, unknown>[]);
  check('later-date-due-wire-keeps-evening-clock-without-same-day-flag', packets.some(m => m.npc === 'abigail'
    && m.time === 2000 && !m.sameDay), packets);
  // Give the due appointment a controlled original schedule, then let the actual game walk it.
  await rpc('action-reset'); await rpc('clock', { time: 600 });
  await rpc('action-place', { map: 'Mountain', x: 44, y: 18, targetX: 45, targetY: 18, next: 2200 });
  await rpc('config', { NpcMeetings: true, NpcApproach: false }); await h.restart();
  state = await published(2000); const plan = mine(state)!;
  check('later-due-agreement-applies-to-real-native-schedule', plan.Applied && !plan.Failed && plan.Time === 2000, state.actions);
  await rpc('warp', { map: plan.spot.map, x: plan.spot.x + 4, y: plan.spot.y });
  await rpc('action-schedule-due', { time: plan.Depart }); await rpc('clock', { time: 2000 });
  await rpc('action-route-wait', { time: plan.Depart, speed: 8 }); state = await rpc('wait', { ticks: 60 });
  check('later-due-npc-really-walks-to-saloon-and-greets', mine(state)?.Arrived && mine(state)?.Met, state.actions);
  await rpc('clock', { time: plan.Leave }); await rpc('wait', { ticks: 60 });
  check('later-due-meeting-produces-reliable-end', h.packets('meet.ended').some(packet => String(packet.npc).toLowerCase() === 'abigail'
    && packet.time === 2000 && packet.met === true), h.packets('meet.ended'));
  await converse('Abigail', '下个月28号晚上八点还在餐吧见？', '好啊，八点餐吧见。');
  check('later-far-date-refusal-hint-is-present-for-this-turn', h.latestSystem().includes('太远了') && h.latestSystem().includes('到时候再约'), h.latestSystem());
  await converse('Abigail', '最近过得怎么样？', '挺好的。');
  check('later-far-date-refusal-hint-does-not-leak-into-next-turn', !h.latestSystem().includes('这次婉拒'), h.latestSystem());
  await converse('Leah', '后天下午两点海边见？', '好啊，后天下午两点海边见。');
  await converse('Leah', '你记得后天的安排吗？', '记得，我们约在海边。');
  check('later-unsaved-agreement-really-exists-before-rollback', h.latestSystem().includes('后天（周五）14:00 在海滩见面'), h.latestSystem());
  await rpc('title'); await rpc('load'); await converse('Leah', '你接下来约了什么？', '还没有定。');
  check('later-unsaved-future-agreement-rolls-back', !h.latestSystem().includes('后天（周五）14:00 在海滩见面'), h.latestSystem());

  await chapter('spring', 27); await rpc('action-reset'); await rpc('clock', { time: 1000 });
  await rpc('config', { NpcMeetings: true, NpcApproach: false });
  await converse('Abigail', '下个月1号上午八点矿洞见？', '好啊，八点矿洞见。');
  await converse('Abigail', '你记得我们约的时间吗？', '后天上午八点。');
  check('later-next-season-first-is-two-days-ahead-and-morning', h.latestSystem().includes('后天（周一）08:00 在矿洞见面'), h.latestSystem());
  await rpc('sleep'); await rpc('sleep'); await rpc('title'); await rpc('load'); state = await published(800);
  check('later-cross-season-real-nights-preserve-day-and-morning-clock', mine(state)?.Time === 800 && mine(state)?.Place === '矿洞', state.actions);
  h.setReply('');
}
