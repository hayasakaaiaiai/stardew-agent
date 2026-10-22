/** Native same-day contracts through actual dialogue, reliable messages, schedules and saves. */
import type { Host } from './game-actions.ts';
export interface TodayHost extends Host {
  setReply(text: string): void;
  dayMeetings(from?: number): Record<string, unknown>[];
  restart(): Promise<void>;
}

export async function runSameDay(h: TodayHost) {
  const { rpc, check, chapter } = h;
  const meeting = (state: Awaited<ReturnType<typeof rpc>>) => state.actions!.meetings[0]!;
  async function prepare() {
    await chapter('spring', 6); await rpc('action-reset'); await rpc('mine-unlock');
    await rpc('clock', { time: 1000 });
    await rpc('action-place', { map: 'Mountain', x: 44, y: 18, targetX: 45, targetY: 18, next: 1800 });
    await rpc('config', { NpcMeetings: true, NpcMineCompanion: true, NpcApproach: false });
    await rpc('warp', { map: 'Mountain', x: 54, y: 5 });
  }
  async function line(player: string, reply: string, open = true) {
    if (open) { h.setReply('嗨，今天过得怎么样？'); await rpc('talk-open', { npc: 'Abigail' }); }
    h.setReply(reply); const state = await rpc('talk-say', { text: player, label: 'same-day' });
    check('same-day-real-native-dialogue-reply', !!state.reply?.text, state.reply);
    return state;
  }
  await prepare();
  let state = await line('现在陪我下矿吧？', '好啊，现在一起去矿洞吧。');
  check('same-day-does-not-move-before-conversation-closes', state.actions!.meetings.length === 0, state.actions);
  const wire = h.wireCount(); await h.close(); state = await rpc('wait', { ticks: 60 });
  const received = h.dayMeetings(wire).at(-1)?.meetings as { npc: string; time: number; sameDay: boolean }[];
  check('same-day-talk-close-publishes-real-day-packet', received?.some(m => m.npc === 'abigail' && m.sameDay && m.time === 1000), received);
  check('same-day-native-client-plans-next-tick-warp-with-original-time', meeting(state).Applied && !meeting(state).Failed
    && meeting(state).Warp && meeting(state).Depart === 1010 && meeting(state).Time === 1000, state.actions);
  state = await rpc('mine-hud');
  check('same-day-original-hud-confirms-adjusted-time', (state.native?.hud as string[]).some(text => /约好.*矿洞见/.test(text)), state.native);
  await rpc('clock', { time: meeting(state).Depart }); state = await rpc('wait', { ticks: 60 });
  check('same-day-visible-actor-does-not-disappear', !meeting(state).Warped, state.actions);
  await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 }); state = await rpc('wait', { ticks: 60 });
  check('same-day-unseen-actor-actually-reaches-door', meeting(state).Arrived && meeting(state).Warped, state.actions);
  await rpc('warp', { map: 'Mountain', x: 54, y: 5 }); state = await rpc('wait', { ticks: 60 });
  check('same-day-arrived-actor-actually-meets-player', meeting(state).Met, state.actions);
  state = await rpc('mine-enter', { floor: 0 }); await rpc('mine-level', { floor: 3 });
  check('same-day-actual-door-entry-starts-production-companion', state.mine!.meetings[0]?.Following, state.mine);
  h.setReply('我们在第三层，今天约好马上一起下矿。'); await h.say('Abigail', '我们约的是什么，到了第几层？', 'same-day-live-talk');
  check('same-day-prompt-retains-soon-and-live-floor', /约好马上去矿洞见面/.test(h.latestSystem()) && /现在在矿洞第 3 层/.test(h.latestSystem()), h.latestSystem()); await h.close();
  const count = h.dayMeetings().length;
  await line('现在再陪我下矿吧？', '好啊，现在一起去矿洞吧。'); await h.close(); await rpc('wait', { ticks: 30 });
  check('same-day-second-contract-does-not-republish', h.dayMeetings().length === count);
  await rpc('warp', { map: 'Mountain', x: 54, y: 5 }); await rpc('wait', { ticks: 60 });
  check('same-day-reliable-end-has-one-memory-entry', await h.meetingEntries() === 1);
  await h.restart(); state = await rpc('wait', { ticks: 120 });
  check('same-day-restart-keeps-ended-visit-and-controller-state', meeting(state).Reported && !state.mine!.meetings[0]!.Following, state.actions);
  await rpc('clock', { time: 1200 });
  // Deliberately propose tomorrow from a conversation that only agreed on today.
  h.seedNight(true, false, '矿洞'); await rpc('sleep'); h.seedNight(false);
  await rpc('title'); state = await rpc('load');
  check('same-day-real-save-does-not-turn-now-into-tomorrow', !state.actions!.meetings.some(m => m.Npc === 'Abigail'), state.actions);
  h.setReply('记得，我们约好马上下矿。'); await h.say('Abigail', '你记得我们上次约的什么吗？', 'same-day-saved-recall');
  check('same-day-real-save-reload-retains-soon-memory', /约好马上去矿洞见面，农场主来了，我陪农场主下到矿洞第 3 层/.test(h.latestSystem()), h.latestSystem()); await h.close();

  await prepare(); await line('现在陪我下矿吧？', '好啊。');
  await line('还是算了，今天不去了。', '好吧，那不去了。', false); const cancelWire = h.wireCount(); await h.close(); state = await rpc('wait', { ticks: 60 });
  check('same-day-cancelled-conversation-never-plans-or-publishes', !state.actions!.meetings.length && !h.dayMeetings(cancelWire).length, state.actions);
  await line('现在陪我下矿吧？', '好啊，现在一起去矿洞吧。'); await h.close(); state = await rpc('wait', { ticks: 60 });
  check('same-day-new-conversation-can-agree-after-cancelled-one', meeting(state).Applied, state.actions);
  await rpc('title'); state = await rpc('load');
  check('same-day-unsaved-native-reload-removes-contract', !state.actions!.meetings.length, state.actions);
  h.setReply('');
}

export async function runSameDayEdges(h: TodayHost) {
  const { rpc, chapter, check } = h;
  const meeting = (state: Awaited<ReturnType<typeof rpc>>) => state.actions!.meetings[0]!;
  async function prepare(time = 1000, location = 'Mountain') {
    await chapter('spring', 6); await rpc('action-reset'); await rpc('mine-unlock');
    await rpc('clock', { time });
    await rpc('action-place', { map: location, x: location === 'Desert' ? 10 : location === 'Town' ? 50 : 44,
      y: location === 'Desert' ? 10 : location === 'Town' ? 68 : 18,
      targetX: location === 'Desert' ? 11 : location === 'Town' ? 47 : 45,
      targetY: location === 'Desert' ? 10 : location === 'Town' ? 87 : 18, next: 2200 });
    await rpc('config', { NpcMeetings: true, NpcMineCompanion: true, NpcApproach: false });
  }
  async function agree(player: string, reply: string) {
    h.setReply('你好。'); await rpc('talk-open', { npc: 'Abigail', keepFriendship: true });
    h.setReply(reply); await rpc('talk-say', { text: player, label: 'same-day-edge' }); await h.close();
    return rpc('wait', { ticks: 60 });
  }
  await prepare(1430, 'Desert');
  let state = await agree('今天下午三点海边见？', '好啊，三点沙滩见。');
  check('same-day-late-fixed-time-retains-source-clock-on-wire', (h.dayMeetings().at(-1)?.meetings as { time: number }[])?.[0]?.time === 1500);
  check('same-day-late-fixed-time-plans-on-time-warp', meeting(state).Applied && meeting(state).Warp
    && meeting(state).Time === 1500 && meeting(state).Depart === 1440, state.actions);
  const plan = meeting(state), spot = plan.spot;
  await rpc('warp', { map: spot.map, x: spot.x + 3, y: spot.y });
  await rpc('clock', { time: plan.Depart });
  state = await rpc('action-meeting-wait', { speed: 8 });
  state = await rpc('wait', { ticks: 60 });
  check('same-day-late-fixed-time-reaches-native-beach-on-time', meeting(state).Arrived && meeting(state).ArrivedAt! <= plan.Time, state.actions);
  state = await rpc('wait', { ticks: 60 });
  check('same-day-late-visit-still-greets-player', meeting(state).Met, state.actions);
  await rpc('clock', { time: meeting(state).Leave }); await rpc('wait', { ticks: 60 });
  h.setReply('你来了，我们说好三点见。'); await h.say('Abigail', '我们说好的是几点见？', 'same-day-late-memory');
  check('same-day-late-memory-keeps-agreed-fifteen-not-arrival-time', /约好 15:00 在海滩见面/.test(h.latestSystem())
    && /农场主来了/.test(h.latestSystem()), h.latestSystem()); await h.close();

  await prepare(); await rpc('farm-fixture');
  state = await agree('现在来我农场帮忙浇水吧？', '好啊，马上来农场帮你浇水。');
  check('same-day-farm-plan-applies-without-sleep', meeting(state).Applied && meeting(state).Place === '农场', state.actions);
  await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 });
  state = await rpc('farm-start', { speed: 8 });
  check('same-day-farm-visitor-actually-arrives-and-works', meeting(state).Arrived && !!meeting(state).Helped
    && meeting(state).Helped!.Watered > 0 && state.farm!.hay === 0, state.actions);

  await prepare(2030, 'Town');
  state = await agree('现在陪我下矿吧？', '好啊，现在一起去矿洞吧。');
  check('same-day-evening-native-client-plans-warp', meeting(state).Applied && meeting(state).Warp && meeting(state).Depart === 2040, state.actions);
  state = await rpc('mine-hud');
  check('same-day-evening-uses-native-soon-hud', (state.native?.hud as string[]).some(text => /约好马上在矿洞见/.test(text)), state.native);
  await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 }); await rpc('clock', { time: 2040 }); state = await rpc('wait', { ticks: 60 });
  check('same-day-evening-warp-really-arrives', meeting(state).Arrived && meeting(state).ArrivedAt === 2040, state.actions);

  await prepare(); await rpc('action-place', { map: 'FarmHouse', x: 3, y: 4, relation: 'Married', hearts: 2, noSchedule: true });
  state = await agree('现在陪我去海边吧？', '好啊，现在一起去海边吧。');
  check('same-day-spouse-beach-is-rejected-without-changing-schedule', meeting(state).Failed && !state.actions!.routes, state.actions);
  state = await rpc('mine-hud');
  check('same-day-spouse-beach-native-hud-reports-failure', (state.native?.hud as string[]).some(text => /今天去不了海滩了/.test(text)), state.native);
  h.setReply('');
}
