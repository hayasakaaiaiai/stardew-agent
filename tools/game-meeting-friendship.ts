/** Actual native arrivals and friendship totals, including estimates that differ from the arrival clock. */
import type { TodayHost } from './game-same-day-meetings.ts';
import type { State } from './test-game-world.ts';

export interface FriendshipHost extends TodayHost { setMood(mood: number): void }
interface Points { points: number; total: number; spouse: string | null; relation: string }
const points = (state: State) => state.native as unknown as Points;

export async function runMeetingFriendship(h: FriendshipHost) {
  const { rpc, check, chapter } = h;
  const rows: { name: string; expected: number; actual: number; wire: unknown; plan: unknown }[] = [];
  const meeting = (state: State) => state.actions!.meetings[0]!;
  async function prepare(hearts = 8, time = 1000, map = 'Town') {
    await chapter('spring', 6); await rpc('action-reset'); await rpc('clock', { time });
    await rpc('action-place', { hearts, map, x: map === 'Desert' ? 10 : 50, y: map === 'Desert' ? 10 : 68,
      targetX: map === 'Desert' ? 11 : 47, targetY: map === 'Desert' ? 10 : 87, next: 2200 });
    await rpc('config', { NpcMeetings: true, NpcApproach: false, MeetingsChangeFriendship: true, ChatChangesFriendship: true });
    await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 }); h.setMood(0);
  }
  async function converse(player: string, reply: string, mood = 0) {
    h.setMood(0); h.setReply('你好。'); await rpc('talk-open', { npc: 'Abigail', keepFriendship: true });
    h.setMood(mood); h.setReply(reply); await rpc('talk-say', { text: player, label: 'friendship' });
    await h.close(); h.setMood(0); return rpc('wait', { ticks: 60 });
  }
  async function finish(state: State, actual: number, met: boolean) {
    const plan = meeting(state);
    if (met) await rpc('warp', { map: plan.spot.map, x: plan.spot.x + 4, y: plan.spot.y });
    else if (plan.spot.map === 'Town') await rpc('warp', { map: 'Town', x: 50, y: 68 });
    await rpc('action-schedule-due', { time: plan.Depart }); await rpc('clock', { time: actual });
    await rpc('action-route-wait', { time: plan.Depart, speed: 8 }); state = await rpc('wait', { ticks: 60 });
    check('friendship-real-arrival-and-player-presence', meeting(state).Arrived && meeting(state).ArrivedAt === actual && meeting(state).Met === met, state.actions);
    await rpc('clock', { time: meeting(state).Leave }); state = await rpc('wait', { ticks: 60 });
    check('friendship-native-meeting-reported', meeting(state).Reported, state.actions);
    return state;
  }
  for (const scenario of [
    { name: 'stranger-kept', hearts: 1, met: true, expected: 5 },
    { name: 'familiar-kept', hearts: 6, met: true, expected: 15 },
    { name: 'close-kept', hearts: 8, met: true, expected: 20 },
    { name: 'three-hearts-no-show', hearts: 3, met: false, expected: -15 },
    { name: 'actually-late-despite-on-time-estimate', hearts: 8, met: false, expected: 0, sameDay: true, actual: 1600 },
    { name: 'actually-on-time-despite-late-estimate', hearts: 8, met: false, expected: -5, sameDay: true, map: 'Desert', received: 1430 },
    { name: 'switch-disabled', hearts: 8, met: true, expected: 0, disabled: true },
  ]) {
    await prepare(scenario.hearts, scenario.received ?? 1000, scenario.map);
    if (scenario.disabled) await rpc('config', { MeetingsChangeFriendship: false });
    const before = points(await rpc('friendship-inspect')).points;
    const wire = h.wireCount();
    let state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', place: scenario.map ? '海滩' : '墓地', time: 1500,
      ...(scenario.sameDay ? { sameDay: true } : {}) }] });
    const plan = meeting(state);
    check('friendship-fixture-produces-a-valid-native-plan', plan.Applied && !plan.Failed, state.actions);
    state = await finish(state, scenario.actual ?? 1500, scenario.met);
    const after = points(await rpc('friendship-inspect'));
    const ended = h.packets('meet.ended', wire).at(-1);
    rows.push({ name: scenario.name, expected: scenario.expected, actual: after.points - before, wire: ended, plan });
    check('friendship-wire-matches-native-point-change-' + scenario.name, Number(ended?.friendship ?? 0) === after.points - before, { after, ended });
  }
  check('friendship-native-matrix-matches-observed-arrivals', rows.every(row => row.actual === row.expected), rows);
  // The documented spouse exception applies to positive rewards as well as no-show penalties.
  await prepare(); await rpc('mine-unlock'); await rpc('config', { NpcMineCompanion: true });
  await rpc('action-place', { map: 'FarmHouse', x: 3, y: 4, relation: 'Married', hearts: 8, noSchedule: true });
  const spouseBefore = points(await rpc('friendship-inspect')).points;
  const spouseWire = h.wireCount();
  let state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', place: '矿洞', time: 1500 }] });
  await rpc('warp', { map: 'Farm', x: 50, y: 25 }); await rpc('clock', { time: 1500 }); state = await rpc('wait', { ticks: 60 });
  check('friendship-spouse-actually-reaches-mine-door', meeting(state).Spouse && meeting(state).Arrived, state.actions);
  await rpc('warp', { map: 'Mountain', x: 54, y: 5 }); state = await rpc('wait', { ticks: 60 });
  check('friendship-spouse-actually-meets-player', meeting(state).Met, state.actions);
  await rpc('clock', { time: meeting(state).Leave }); await rpc('wait', { ticks: 60 });
  const spouseAfter = points(await rpc('friendship-inspect')), spouseEnded = h.packets('meet.ended', spouseWire).at(-1);
  check('friendship-spouse-kept-meeting-is-exempt', spouseAfter.points === spouseBefore && spouseAfter.total === 0
    && spouseEnded?.met === true && spouseEnded.friendship === undefined, { spouseAfter, spouseEnded });

  for (const met of [false, true]) {
    await prepare(); await rpc('farm-fixture');
    const from = h.wireCount();
    await rpc('action-meetings', { meetings: [{ npc: 'abigail', place: '农场', time: 1500 }] });
    state = await rpc('farm-start', { speed: 8 });
    check('friendship-farm-visitor-actually-does-chores', !!meeting(state).Helped && !meeting(state).Met, state.actions);
    if (met) {
      await rpc('warp', { map: 'Farm', x: state.farm!.porch.X + 2, y: state.farm!.porch.Y }); state = await rpc('wait', { ticks: 60 });
      check('friendship-farm-visitor-really-meets-player', meeting(state).Met, state.actions);
    }
    await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 }); await rpc('clock', { time: meeting(state).Leave }); await rpc('wait', { ticks: 120 });
    const ended = h.packets('meet.ended', from).at(-1), after = points(await rpc('friendship-inspect'));
    check('friendship-farm-chores-' + (met ? 'reward-meeting' : 'excuse-offscreen-absence'), after.points === 2000 + (met ? 20 : 0)
      && Number(ended?.friendship ?? 0) === (met ? 20 : 0), { after, ended });
  }

  await prepare();
  await converse('今天天气真好。', '和你说话很开心。', 1);
  check('friendship-native-chat-starts-shared-daily-total', points(await rpc('friendship-inspect')).total === 20);
  state = await converse('今天下午三点墓地见？', '好啊，三点墓地见。');
  await finish(state, 1500, true);
  check('friendship-meeting-clips-at-chat-plus-thirty', points(await rpc('friendship-inspect')).points === 2030
    && points(await rpc('friendship-inspect')).total === 30, h.packets('meet.ended').at(-1));
  await h.restart(); await converse('和你一起真的很开心。', '我也很高兴。', 2);
  check('friendship-backend-reconnect-retains-shared-cap', points(await rpc('friendship-inspect')).points === 2030);
  await rpc('sleep'); const saved = points(await rpc('friendship-inspect')).points;
  await rpc('title'); await rpc('load');
  check('friendship-real-save-reload-preserves-native-points', points(await rpc('friendship-inspect')).points === saved);
  const rollback = points(await rpc('friendship-inspect')).points;
  await rpc('action-reset'); await rpc('clock', { time: 1000 });
  // World fixtures disable chat friendship on each load; re-enable it before proving rollback.
  await rpc('config', { ChatChangesFriendship: true });
  await converse('今天聊天真开心。', '很高兴又见到你。', 1);
  check('friendship-unsaved-chat-actually-changes-points', points(await rpc('friendship-inspect')).points > rollback);
  await rpc('title'); await rpc('load');
  check('friendship-unsaved-native-points-roll-back', points(await rpc('friendship-inspect')).points === rollback);
  h.setReply(''); h.setMood(0);
}

export async function runFriendshipBoundaries(h: FriendshipHost) {
  const { rpc, chapter, check } = h;
  for (const scenario of [
    { name: 'zero-cannot-become-negative', points: 0, met: false, book: 0, expected: 0 },
    { name: 'vanilla-heart-ceiling-is-reported-exactly', points: 2248, met: true, book: 0, expected: 1 },
    { name: 'native-book-bonus-is-reported-exactly', points: 2000, met: true, book: 1, expected: 22 },
    { name: 'native-book-bonus-cannot-cross-daily-cap', points: 1500, met: true, book: 1, expected: 16 },
    { name: 'native-book-can-fill-the-last-ten-points', points: 2000, met: true, book: 0, expected: 20, enableBook: true },
  ]) {
    await chapter('spring', 6); await rpc('action-reset'); await rpc('clock', { time: 1000 });
    await rpc('action-place', { map: 'Town', x: 50, y: 68, targetX: 47, targetY: 87, next: 2200 });
    await rpc('friendship-fixture', { points: scenario.points, book: scenario.book });
    await rpc('config', { NpcMeetings: true, NpcApproach: false, MeetingsChangeFriendship: true, ChatChangesFriendship: true });
    await rpc('warp', { map: scenario.met ? 'Town' : 'FarmHouse', x: scenario.met ? 49 : 3, y: scenario.met ? 87 : 4 });
    const wire = h.wireCount();
    let state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', place: '墓地', time: 1500 }] });
    const plan = state.actions!.meetings[0]!;
    check('friendship-boundary-native-plan-' + scenario.name, plan.Applied && !plan.Failed, state.actions);
    await rpc('action-schedule-due', { time: plan.Depart }); await rpc('clock', { time: 1500 });
    await rpc('action-route-wait', { time: plan.Depart, speed: 8 }); state = await rpc('wait', { ticks: 60 });
    check('friendship-boundary-actually-arrives-' + scenario.name, state.actions!.meetings[0]!.Arrived && state.actions!.meetings[0]!.Met === scenario.met, state.actions);
    await rpc('clock', { time: plan.Leave }); await rpc('wait', { ticks: 60 });
    const after = points(await rpc('friendship-inspect')), ended = h.packets('meet.ended', wire).at(-1);
    check('friendship-boundary-native-points-' + scenario.name, after.points - scenario.points === scenario.expected, { after, ended });
    check('friendship-boundary-report-and-daily-total-match-native-' + scenario.name, Number(ended?.friendship ?? 0) === scenario.expected
      && after.total === scenario.expected, { after, ended });
    if (scenario.book || scenario.enableBook) {
      if (scenario.enableBook) await rpc('friendship-fixture', { points: after.points, book: 1 });
      h.setMood(0); h.setReply('你好。'); await rpc('talk-open', { npc: 'Abigail', keepFriendship: true });
      h.setMood(2); h.setReply('和你聊天真开心。'); await rpc('talk-say', { text: '我很喜欢和你一起。', label: 'book-friendship-cap' }); await h.close();
      check('friendship-native-book-bonus-shares-the-thirty-point-cap-with-chat', points(await rpc('friendship-inspect')).total === 30
        && points(await rpc('friendship-inspect')).points === scenario.points + 30);
    }
  }
  h.setMood(0); h.setReply('');
}

/** Spouses and roommates keep their meeting memories without gaining or losing appointment friendship. */
export async function runSpouseFriendship(h: FriendshipHost) {
  const { rpc, chapter, check } = h;
  for (const npc of ['Abigail', 'Krobus']) {
    for (const place of ['矿洞', '农场']) {
      for (const met of [true, false]) {
        const label = `${npc}-${place}-${met ? 'met' : 'absent'}`;
        await chapter('spring', 6); await rpc('action-reset'); await rpc('clock', { time: 1000 });
        await rpc('mine-unlock');
        if (place === '农场') await rpc('farm-fixture');
        // Vanilla can move the farmhouse entry to (3, 11); keep its resident within greeting range of that entry.
        await rpc('action-place', { npc, map: 'FarmHouse', x: 3, y: place === '农场' ? 7 : 4, relation: 'Married', roommate: npc === 'Krobus',
          hearts: 8, noSchedule: true });
        const before = points(await rpc('friendship-fixture', { npc, points: 2000, spouse: true }));
        check('spouse-fixture-resolves-native-household-' + label, before.spouse === npc
          && before.relation === (npc === 'Krobus' ? 'roommate' : 'married'), before);
        await rpc('config', { NpcMeetings: true, NpcApproach: false, NpcMineCompanion: true, MeetingsChangeFriendship: true });
        await rpc('warp', { map: 'Farm', x: 50, y: 25 });
        const wire = h.wireCount();
        let state = await rpc('action-meetings', { npc, meetings: [{ npc: npc.toLowerCase(), place, time: 1500 }] });
        check('spouse-plan-is-applied-' + label, state.actions!.meetings[0]!.Applied && state.actions!.meetings[0]!.Spouse, state.actions);
        await rpc('clock', { time: 1500 }); state = await rpc('wait', { ticks: 60 });
        check('spouse-actually-arrives-' + label, state.actions!.meetings[0]!.Arrived && !state.actions!.meetings[0]!.Met
          && (place !== '农场' || !!state.actions!.meetings[0]!.Helped), state.actions);
        if (met) {
          await rpc('warp', place === '农场' ? { map: 'FarmHouse', x: 3, y: 10 } : { map: 'Mountain', x: 54, y: 5 });
          state = await rpc('wait', { ticks: 60 });
        }
        check('spouse-player-presence-matches-' + label, state.actions!.meetings[0]!.Met === met, state.actions);
        await rpc('clock', { time: state.actions!.meetings[0]!.Leave }); state = await rpc('wait', { ticks: 60 });
        const after = points(await rpc('friendship-inspect', { npc }));
        const ended = h.packets('meet.ended', wire).find(packet => String(packet.npc).toLowerCase() === npc.toLowerCase());
        check('spouse-appointment-changes-neither-points-nor-daily-total-' + label, state.actions!.meetings[0]!.Reported
          && after.points === before.points && after.total === 0 && !!ended && ended.met === met
          && ended.friendship === undefined, { before, after, ended });
        check('spouse-meeting-memory-still-recorded-' + label, await h.meetingEntries() === 1);
      }
    }
  }
}
