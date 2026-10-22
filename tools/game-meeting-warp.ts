/** Native warp arrivals, visibility gates, return routes and actual friendship, using only disposable World fixtures. */
import type { FriendshipHost } from './game-meeting-friendship.ts';
import type { State } from './test-game-world.ts';

const meeting = (state: State) => state.actions!.meetings[0]!;
const actor = (state: State) => state.npcs!.find(npc => npc.id === 'Abigail')!;
const standing = (state: State) => state.native as { points: number; total: number };

export async function runMeetingWarp(h: FriendshipHost, edges = false) {
  const { rpc, chapter, check } = h;
  async function prepare(time = 1000, map = 'Town', next = 2200) {
    await chapter('spring', 6); await rpc('action-reset'); await rpc('mine-unlock'); await rpc('clock', { time });
    await rpc('action-place', { map, x: map === 'Town' ? 50 : 10, y: map === 'Town' ? 68 : 10,
      targetX: map === 'Town' ? 47 : 11, targetY: map === 'Town' ? 87 : 10, next });
    await rpc('config', { NpcMeetings: true, NpcMineCompanion: true, NpcApproach: false, MeetingsChangeFriendship: true });
    await rpc('warp', { map, x: map === 'Town' ? 52 : 12, y: map === 'Town' ? 68 : 10 });
    h.setMood(0); h.setReply('');
  }
  async function agree(player: string, reply: string) {
    h.setReply('你好。'); await rpc('talk-open', { npc: 'Abigail', keepFriendship: true });
    h.setReply(reply); await rpc('talk-say', { text: player, label: 'meeting-warp' }); await h.close();
    return rpc('wait', { ticks: 30 });
  }
  async function report(met: boolean, expected: number) {
    let state = await rpc('snapshot'); const plan = meeting(state);
    check('warp-arrival-is-observed-before-reporting', plan.Arrived && plan.Met === met, state.actions);
    const wire = h.wireCount();
    await rpc('clock', { time: plan.Leave }); state = await rpc('wait', { ticks: 60 });
    const after = standing(await rpc('friendship-inspect')), ended = h.packets('meet.ended', wire).at(-1);
    check('warp-kept-or-missed-meeting-records-native-friendship-' + expected, meeting(state).Reported
      && after.points === 2000 + expected && after.total === expected && Number(ended?.friendship ?? 0) === expected
      && ended?.met === met, { after, ended });
    check('warp-meeting-still-has-one-memory', await h.meetingEntries() === 1);
  }
  if (!edges) {
    let state: State;
    // The player is already on the destination map: a real path must come in from an entrance.
    await prepare(1430, 'Desert'); state = await agree('今天下午三点海边见？', '好啊，三点沙滩见。');
    check('warp-fixed-time-keeps-three-oclock', meeting(state).Applied && meeting(state).Warp && meeting(state).Time === 1500, state.actions);
    await rpc('clock', { time: meeting(state).Depart }); await rpc('warp', { map: 'Beach', x: 33, y: 34 });
    state = await rpc('action-meeting-wait', { natural: true, speed: 2 });
    const travel = state.native?.travel as { map: string; x: number; y: number; speed: number }[];
    check('warp-visible-destination-requires-native-walk-from-entry', meeting(state).Warped && meeting(state).Arrived
      && travel.length > 3 && travel.some(p => p.map === 'Beach' && Math.abs(p.x - 30) + Math.abs(p.y - 34) > 6), { actions: state.actions, travel });
    check('warp-fixed-time-arrives-on-time-with-vanilla-clock', meeting(state).ArrivedAt! <= 1500, state.actions);
    check('warp-only-hurries-entrance-leg-and-restores-speed', travel.some(p => p.speed > 2 && p.speed <= 4)
      && state.native?.speed === 2, state.native);
    state = await rpc('wait', { ticks: 60 }); check('warp-fixed-time-player-was-met', meeting(state).Met, state.actions);
    await report(true, 20);

    await prepare();
    state = await agree('现在陪我下矿吧？', '好啊，现在一起去矿洞吧。');
    check('warp-soon-native-plan-keeps-source-clock', meeting(state).Applied && meeting(state).Warp
      && meeting(state).Time === 1000 && meeting(state).Depart === 1010, state.actions);
    await rpc('clock', { time: 1010 }); state = await rpc('wait', { ticks: 60 });
    check('warp-does-not-disappear-in-front-of-player', !meeting(state).Warped && actor(state).location === 'Town', state.actions);
    await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 }); state = await rpc('wait', { ticks: 60 });
    check('warp-unseen-actor-reaches-exact-meeting-spot', meeting(state).Warped && meeting(state).Arrived
      && actor(state).location === 'Mountain' && actor(state).x === 56 && actor(state).y === 6, state.actions);
    await rpc('warp', { map: 'Mountain', x: 54, y: 5 }); state = await rpc('wait', { ticks: 60 });
    check('warp-actually-greets-player-at-door', meeting(state).Met, state.actions);
    await report(true, 20);
    await rpc('action-schedule-due', { time: meeting(state).Leave });
    state = await rpc('action-position-wait', { map: 'Town', x: 50, y: 68 });
    check('warp-kept-visit-really-walks-back-to-original-position', actor(state).location === 'Town' && actor(state).x === 50
      && actor(state).y === 68 && !actor(state).controller, actor(state));

    await prepare(); state = await agree('现在陪我下矿吧？', '好啊，现在一起去矿洞吧。');
    await rpc('clock', { time: 1010 }); await rpc('warp', { map: 'Mountain', x: 54, y: 5 });
    state = await rpc('action-meeting-wait', { natural: true, speed: 2 });
    check('warp-player-waiting-at-mine-sees-an-entrance-walk', meeting(state).Arrived && meeting(state).Warped
      && (state.native?.travel as unknown[]).length > 3, state.native);
    check('warp-soon-without-a-fixed-deadline-keeps-normal-speed', (state.native?.travel as { speed: number }[]).every(p => p.speed === 2)
      && state.native?.speed === 2, state.native);

    await prepare(); state = await agree('现在陪我下矿吧？', '好啊，现在一起去矿洞吧。');
    await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 }); await rpc('clock', { time: 1010 }); state = await rpc('wait', { ticks: 60 });
    check('warp-cancel-fixture-is-arrived-but-player-absent', meeting(state).Arrived && !meeting(state).Met, state.actions);
    const cancelWire = h.wireCount();
    state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', place: '矿洞', time: 1000, calledOff: true }] });
    check('warp-reliable-cancellation-reports-no-meeting', meeting(state).Reported && !h.packets('meet.ended', cancelWire).length, state.actions);
    state = await rpc('action-position-wait', { map: 'Town', x: 50, y: 68 });
    check('warp-cancellation-walks-back-to-original-standing', actor(state).location === 'Town' && actor(state).x === 50
      && actor(state).y === 68 && standing(await rpc('friendship-inspect')).total === 0, actor(state));

    await prepare(1430, 'Desert'); state = await agree('今天下午三点海边见？', '好啊，三点沙滩见。');
    await rpc('warp', { map: 'Beach', x: 33, y: 34 }); await rpc('clock', { time: 1440 }); state = await rpc('wait', { ticks: 30 });
    check('warp-cancel-hurrying-fixture-really-has-a-faster-entrance-leg', meeting(state).Warped && !meeting(state).Arrived
      && actor(state).speed > 2, actor(state));
    const hurryingWire = h.wireCount();
    state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', place: '海滩', time: 1500, calledOff: true }] });
    check('warp-cancel-hurrying-restores-speed-before-return', meeting(state).Reported && actor(state).speed === 2
      && !h.packets('meet.ended', hurryingWire).length, { actions: state.actions, npc: actor(state) });
    state = await rpc('action-position-wait', { map: 'Desert', x: 10, y: 10 });
    check('warp-cancel-hurrying-actually-returns-home', actor(state).location === 'Desert' && actor(state).x === 10
      && actor(state).y === 10, actor(state));

    await prepare(1430, 'Desert'); await agree('今天下午三点海边见？', '好啊，三点沙滩见。');
    await rpc('warp', { map: 'Beach', x: 33, y: 34 }); await rpc('clock', { time: 1440 }); state = await rpc('wait', { ticks: 30 });
    check('warp-clear-fixture-really-is-hurrying', actor(state).speed > 2, actor(state));
    state = await rpc('action-reset');
    check('warp-clear-restores-pending-entrance-speed', actor(state).speed === 2, actor(state));



    await prepare(1430, 'Desert'); state = await agree('今天下午三点海边见？', '好啊，三点沙滩见。');
    await rpc('clock', { time: meeting(state).Depart }); await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 });
    state = await rpc('wait', { ticks: 60 }); check('warp-no-show-actually-arrived-on-time', meeting(state).Arrived && !meeting(state).Met, state.actions);
    await report(false, -5);

    // Tomorrow's otherwise impossible early trip, and a nearby ordinary walk.
    await prepare(600, 'Desert'); await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 });
    state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', place: '矿洞', time: 800 }] });
    check('warp-next-day-unreachable-route-is-not-refused', meeting(state).Applied && meeting(state).Warp && meeting(state).Depart === 730, state.actions);
    await rpc('clock', { time: 720 }); state = await rpc('wait', { ticks: 60 });
    check('warp-does-not-arrive-more-than-half-hour-early', !meeting(state).Warped && actor(state).location === 'Desert', state.actions);
    await rpc('clock', { time: 730 }); state = await rpc('wait', { ticks: 60 });
    check('warp-next-day-actually-arrives-at-allowed-time', meeting(state).Arrived && meeting(state).ArrivedAt === 730, state.actions);

    await prepare(); await rpc('warp', { map: 'Town', x: 49, y: 87 });
    state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', place: '墓地', time: 1500 }] });
    check('warp-keeps-reachable-ordinary-walking-route', meeting(state).Applied && !meeting(state).Warp, state.actions);
    await rpc('action-schedule-due', { time: meeting(state).Depart });
    state = await rpc('action-route-wait', { time: meeting(state).Depart, speed: 8 }); state = await rpc('wait', { ticks: 60 });
    check('warp-ordinary-route-actually-walks-and-meets', meeting(state).Arrived && meeting(state).Met && !meeting(state).Warped, state.actions);
  } else {
    await prepare(2030); let state = await agree('现在陪我下矿吧？', '好啊，现在一起去矿洞吧。');
    await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 });
    await rpc('clock', { time: 2200 }); state = await rpc('wait', { ticks: 60 });
    check('warp-does-not-start-an-unobserved-expired-visit', !meeting(state).Arrived && !meeting(state).Warped
      && !h.packets('meet.ended').length, { actions: state.actions, npc: actor(state), packets: h.packets('meet.ended') });
    // Keep the NPC visible until after its deadline: it must not teleport at curfew or run a phantom return leg.
    await prepare(2030); state = await agree('现在陪我下矿吧？', '好啊，现在一起去矿洞吧。');
    check('warp-late-evening-soon-is-allowed', meeting(state).Applied && meeting(state).Warp && meeting(state).Depart === 2040, state.actions);
    await rpc('clock', { time: 2200 }); state = await rpc('wait', { ticks: 60 });
    check('warp-visible-npc-cannot-complete-an-expired-meeting', !meeting(state).Arrived && actor(state).location === 'Town', state.actions);
    await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 }); state = await rpc('wait', { ticks: 60 });
    check('warp-expired-visit-does-not-teleport-after-curfew', !meeting(state).Arrived && actor(state).location === 'Town'
      && !h.packets('meet.ended').length, { actions: state.actions, npc: actor(state), packets: h.packets('meet.ended') });

    await prepare(1430, 'Desert'); state = await agree('今天下午三点海边见？', '好啊，三点沙滩见。');
    await rpc('warp', { map: 'Beach', x: 33, y: 34 }); await rpc('clock', { time: 1440 }); state = await rpc('wait', { ticks: 30 });
    check('warp-expiry-fixture-is-still-walking-in-from-entrance', meeting(state).Warped && !meeting(state).Arrived, state.actions);
    await rpc('clock', { time: 1630 }); state = await rpc('wait', { ticks: 60 });
    check('warp-unfinished-entrance-walk-expires-without-penalty', meeting(state).Reported && !meeting(state).Arrived
      && !h.packets('meet.ended').length && standing(await rpc('friendship-inspect')).total === 0 && actor(state).speed === 2, state.actions);
    check('warp-unfinished-entrance-walk-restores-original-stops', state.actions!.routes?.length === 1
      && state.actions!.routes[0]!.time === 2200, state.actions);

    await prepare(1440, 'Desert'); state = await agree('今天下午三点海边见？', '好啊，三点沙滩见。');
    check('warp-short-time-fixture-has-a-native-plan', state.actions!.meetings[0]?.Applied, state.actions);
    await rpc('clock', { time: 1500 }); await rpc('warp', { map: 'Beach', x: 3, y: 10 }); state = await rpc('wait', { ticks: 30 });
    check('warp-hurrying-is-capped-at-four-when-time-is-short', meeting(state).Warped && actor(state).speed === 4, actor(state));
    state = await rpc('action-meeting-wait', { natural: true, speed: 2 });
    check('warp-late-hurrying-arrival-still-restores-original-speed', meeting(state).ArrivedAt! > 1500 && !meeting(state).Met
      && actor(state).speed === 2, { actions: state.actions, npc: actor(state) });
    const lateWire = h.wireCount(); await rpc('clock', { time: meeting(state).Leave }); await rpc('wait', { ticks: 60 });
    const latePoints = standing(await rpc('friendship-inspect')), lateEnd = h.packets('meet.ended', lateWire).at(-1);
    check('warp-npc-late-despite-hurrying-does-not-penalize-player', latePoints.points === 2000 && latePoints.total === 0
      && !!lateEnd && lateEnd.friendship === undefined && lateEnd.met === false, { latePoints, lateEnd });
  }
  h.setReply(''); h.setMood(0);
}

export async function runMeetingWarpPlaces(h: FriendshipHost) {
  const { rpc, chapter, check } = h;
  for (const [place, map, x, y] of [
    ['杂货店', 'SeedShop', 15, 20],
    ['海滩', 'Beach', 33, 34], ['镇广场', 'Town', 53, 68], ['墓地', 'Town', 49, 87],
    ['山上湖边', 'Mountain', 46, 18], ['森林河边', 'Forest', 68, 50],
    ['博物馆', 'ArchaeologyHouse', 13, 9], ['星之果实餐吧', 'Saloon', 22, 19],
    ['矿洞', 'Mountain', 54, 5], ['骷髅洞穴', 'Desert', 10, 10], ['火山', 'IslandNorth', 40, 26],
  ] as const) {
    await chapter('spring', 6); await rpc('action-reset'); await rpc('mine-unlock'); await rpc('clock', { time: 1000 });
    const source = map === 'Desert' ? 'Town' : 'Desert';
    await rpc('action-place', { map: source, x: source === 'Town' ? 50 : 10, y: source === 'Town' ? 68 : 10,
      targetX: source === 'Town' ? 47 : 11, targetY: source === 'Town' ? 87 : 10, next: 2200 });
    await rpc('config', { NpcMeetings: true, NpcMineCompanion: true, NpcApproach: false });
    let state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', place, time: 1000, sameDay: true }] });
    check('warp-place-native-plan-' + place, meeting(state).Applied && meeting(state).Warp, state.actions);
    await rpc('warp', { map, x, y }); await rpc('clock', { time: 1010 }); state = await rpc('wait', { ticks: 60 });
    if (place === '杂货店' && state.festival?.id === '3102768') {
      check('warp-does-not-interrupt-native-pierre-story', !meeting(state).Warped && actor(state).location === source, state.actions);
      await rpc('action-event-skip'); await rpc('warp', { map, x, y }); state = await rpc('wait', { ticks: 60 });
      check('warp-resumes-after-native-story-is-skipped', !state.festival, state.festival);
    }
    const entrance = meeting(state).Warped ? undefined : (await rpc('action-entrances', { place })).native;
    if (!meeting(state).Warped) state = await rpc('wait', { ticks: 180 });
    check('warp-place-has-a-usable-entrance-' + place, meeting(state).Warped, { actions: state.actions, npc: actor(state), entrance });
    state = await rpc('action-meeting-wait'); state = await rpc('wait', { ticks: 60 });
    check('warp-place-actually-walks-in-and-meets-' + place, meeting(state).Arrived && meeting(state).Met
      && actor(state).location === map, { actions: state.actions, npc: actor(state) });
  }
}
