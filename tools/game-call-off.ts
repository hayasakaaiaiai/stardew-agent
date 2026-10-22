/** Cancellation and dismissal through native dialogue and the production calendar. */
import type { TodayHost } from './game-same-day-meetings.ts';

export async function runCallOff(h: TodayHost) {
  const { rpc, chapter, check } = h;
  const meeting = (state: Awaited<ReturnType<typeof rpc>>) => state.actions!.meetings[0]!;
  const actor = (state: Awaited<ReturnType<typeof rpc>>) => state.npcs!.find(npc => npc.id === 'Abigail')!;
  async function prepare(next = 1800) {
    await chapter('spring', 6); await rpc('action-reset'); await rpc('mine-unlock'); await rpc('clock', { time: 1000 });
    const state = await rpc('action-place', { map: 'Mountain', x: 44, y: 18, targetX: 45, targetY: 18, next });
    await rpc('config', { NpcMeetings: true, NpcMineCompanion: true, NpcApproach: false }); return state;
  }
  async function say(player: string, reply: string) {
    h.setReply('你好。'); await rpc('talk-open', { npc: 'Abigail', keepFriendship: true });
    h.setReply(reply); await rpc('talk-say', { text: player, label: 'call-off' }); await h.close();
    return rpc('wait', { ticks: 60 });
  }
  await prepare(1400);
  let state = await say('今天下午三点海边见？', '好啊，三点沙滩见。');
  check('call-off-future-contract-is-planned', meeting(state).Applied && !meeting(state).Reported, state.actions);
  state = await say('抱歉，今天下午不去海边了。', '好吧，今天不去了。');
  check('call-off-before-departure-restores-original-stops', meeting(state).Reported
    && state.actions!.routes?.length === 1 && state.actions!.routes[0]!.time === 1400, state.actions);
  state = await rpc('mine-hud');
  check('call-off-before-departure-uses-original-hud', (state.native?.hud as string[]).some(text => /约定取消了/.test(text)), state.native);
  h.setReply('今天已经取消了。'); await h.say('Abigail', '我们下午还约着吗？', 'call-off-memory');
  check('call-off-prompt-has-cancellation-memory-and-no-current-contract', /后来农场主说不去了/.test(h.latestSystem())
    && !h.latestSystem().includes('和农场主的约定'), h.latestSystem()); await h.close();
  state = await say('现在陪我下矿吧？', '好啊，现在一起下矿吧。');
  check('call-off-cancelled-npc-cannot-agree-again-today', meeting(state).Place === '海滩' && meeting(state).Reported, state.actions);

  await prepare(); await say('现在陪我下矿吧？', '好啊，现在一起下矿吧。');
  await rpc('warp', { map: 'Mountain', x: 54, y: 5 }); await rpc('mine-start', { npc: 'Abigail', place: '矿洞', speed: 8 });
  await rpc('mine-enter', { floor: 0 }); await rpc('mine-level', { floor: 5 }); await rpc('mine-room');
  state = await say('你先回去吧。', '凭什么让我先走，再往下一点点嘛。');
  check('call-off-refusing-companion-remains-on-real-floor', state.mine!.meetings[0]!.Following && !meeting(state).Reported, state.mine);
  state = await say('真的，你先回去吧，下面太危险了。', '好吧，那我先回去了。');
  state = await rpc('wait', { ticks: 180 });
  check('call-off-agreeing-companion-leaves-dynamic-floor', !state.mine!.meetings[0]!.Following && meeting(state).Reported
    && state.mine!.meetings[0]!.actor.map === 'Mountain' && !state.mine!.meetings[0]!.actor.temporary, state.mine);
  check('call-off-dismissal-replay-writes-one-trip-memory', await h.meetingEntries() === 1);
  h.setReply('记得，你让我先回去了。'); await h.say('Abigail', '刚才为什么先回去了？', 'call-off-dismissal-recall');
  check('call-off-dismissal-memory-retains-floor-and-who-sent-home', /下到矿洞第 5 层/.test(h.latestSystem()) && /后来农场主让我先回去了/.test(h.latestSystem()), h.latestSystem()); await h.close();

  await prepare(); await rpc('farm-fixture'); await say('现在来我农场帮忙浇水吧？', '好啊，马上来农场帮你浇水。');
  state = await rpc('farm-start', { speed: 8 }); const leave = meeting(state).Leave;
  await rpc('warp', { map: 'Farm', x: state.farm!.porch.X + 2, y: state.farm!.porch.Y }); await rpc('wait', { ticks: 60 });
  state = await say('谢谢你帮忙，今天就到这儿吧。', '好吧，我先回去了。');
  await rpc('warp', { map: 'Farm', x: 50, y: 25 }); state = await rpc('farm-wait', { until: 'gone', speed: 8 });
  check('call-off-farm-dismissal-leaves-before-original-time', meeting(state).Stage === 3 && meeting(state).Reported
    && state.time < leave && actor(state).location !== 'Farm' && !actor(state).temporary, state);
  check('call-off-farm-report-uses-actual-early-leave-time', h.packets('meet.ended').some(packet => packet.place === '农场' && Number(packet.left) < leave), h.packets('meet.ended'));

  // A real walk before the first original stop must return to the recorded original standing position.
  const original = actor(await prepare(1400)); await say('现在陪我下矿吧？', '好啊，现在一起下矿吧。');
  state = await rpc('mine-inspect');
  await rpc('warp', { map: 'Mountain', x: 40, y: 18 }); await rpc('action-schedule-due', { time: meeting(state).Depart });
  state = await rpc('wait', { ticks: 60 });
  check('call-off-midwalk-fixture-really-started-moving', actor(state).controller
    && (actor(state).x !== original.x || actor(state).y !== original.y), actor(state));
  state = await say('今天不下矿了。', '好吧，今天不去了。'); await rpc('wait', { ticks: 60 }); state = await rpc('mine-inspect');
  check('call-off-midwalk-before-first-original-stop-returns-to-original-standing', actor(state).location === original.location
    && actor(state).x === original.x && actor(state).y === original.y && !actor(state).controller, { original, after: actor(state), actions: state.actions });
  h.setReply('');
}

export async function runArrivalProbe(h: TodayHost, earlySave = false) {
  const { rpc, check, chapter } = h;
  const meeting = (state: Awaited<ReturnType<typeof rpc>>) => state.actions!.meetings[0]!;
  for (const actual of earlySave ? [1600] : [1600, 1800]) {
    const originalStop = actual === 1600 ? 1800 : 1920;
    await chapter('spring', 6); await rpc('action-reset'); await rpc('clock', { time: 1430 });
    await rpc('action-place', { map: 'Desert', x: 10, y: 10, targetX: 11, targetY: 10, next: originalStop });
    await rpc('config', { NpcMeetings: true, NpcApproach: false });
    h.setReply('你好。'); await rpc('talk-open', { npc: 'Abigail' });
    h.setReply('好啊，三点沙滩见。'); await rpc('talk-say', { text: '今天下午三点海边见？', label: 'arrival-probe' }); await h.close();
    let state = await rpc('wait', { ticks: 60 }); const plan = meeting(state);
    check('arrival-probe-native-client-plans-later-than-source-fifteen', plan.Applied && plan.Time > 1500, state.actions);
    await rpc('warp', { map: plan.spot.map, x: plan.spot.x + 4, y: plan.spot.y });
    await rpc('action-schedule-due', { time: plan.Depart });
    state = await rpc('mine-inspect');
    check('arrival-probe-not-already-at-destination', !meeting(state).Arrived, state.actions);
    await rpc('clock', { time: actual });
    state = await rpc('action-route-wait', { time: plan.Depart, speed: 8 });
    state = await rpc('wait', { ticks: 60 });
    check('arrival-probe-real-native-arrival-has-controlled-clock', state.time === actual && meeting(state).Arrived && meeting(state).Met, state);
    if (earlySave) {
      await rpc('clock', { time: 1610 }); await rpc('sleep');
      check('arrival-early-sleep-reports-before-estimated-arrival', h.packets('meet.ended').some(packet => packet.arrived === actual
        && packet.left === 1610 && Number(packet.time) > 1610), h.packets('meet.ended'));
      await rpc('title'); await rpc('load');
      h.setReply('我四点才到海边。'); await h.say('Abigail', '上次海边见面你实际几点到的？', 'arrival-early-saved-recall');
      check('arrival-early-sleep-observed-clock-persists', h.latestSystem().includes('我 16:00 才到') && !h.latestSystem().includes('我 17:40 才到'), h.latestSystem());
      await h.close(); h.setReply('');
      continue;
    }
    const leave = actual + 130;
    check('arrival-probe-wait-and-return-route-follow-observed-arrival', meeting(state).ArrivedAt === actual
      && meeting(state).Leave === leave && meeting(state).ReturnAt === leave
      && state.actions!.routes!.some(route => route.time === leave) && !state.actions!.routes!.some(route => route.time === plan.Leave), state.actions);
    check('arrival-probe-original-stop-is-released-or-deferred-with-new-deadline',
      state.actions!.routes!.some(route => route.time === originalStop) === (originalStop > leave), state.actions);
    await rpc('clock', { time: leave - 10 }); state = await rpc('wait', { ticks: 60 });
    check('arrival-probe-waits-through-the-full-observed-ninety-minutes', !meeting(state).Reported, state.actions);
    await rpc('clock', { time: meeting(state).Leave }); await rpc('wait', { ticks: 60 });
    check('arrival-probe-report-carries-observed-arrival-and-new-deadline', h.packets('meet.ended').some(packet => packet.arrived === actual && packet.left === leave), h.packets('meet.ended'));
    h.setReply('我们约好下午三点见。'); await h.say('Abigail', '我们说好几点见，你实际几点到的？', 'arrival-probe-recall');
    const clock = (time: number) => `${Math.floor(time / 100).toString().padStart(2, '0')}:${(time % 100).toString().padStart(2, '0')}`;
    check('arrival-probe-memory-uses-observed-arrival-not-plan-estimate', h.latestSystem().includes(`我 ${clock(actual)} 才到`),
      { promised: 1500, plan: plan.Time, actual, system: h.latestSystem(), wire: h.packets('meet.ended').at(-1) });
    await h.close(); h.setReply('');
    const back = state.actions!.routes!.find(route => route.time === leave)!;
    await rpc('action-schedule-due', { time: leave }); state = await rpc('action-route-wait', { time: leave, speed: 8 });
    const npc = state.npcs!.find(npc => npc.id === 'Abigail')!;
    check('arrival-probe-native-return-reaches-original-schedule', npc.location === back.map && npc.x === back.x && npc.y === back.y && !npc.controller, npc);
    if (actual === 1800) {
      await rpc('sleep'); await rpc('title'); await rpc('load');
      h.setReply('我六点才到海边。'); await h.say('Abigail', '上次海边见面你实际几点到的？', 'arrival-saved-recall');
      check('arrival-probe-observed-clock-survives-real-save-and-reload', h.latestSystem().includes('我 18:00 才到') && !h.latestSystem().includes('我 17:40 才到'), h.latestSystem());
      await h.close(); h.setReply('');
    }
  }
}
