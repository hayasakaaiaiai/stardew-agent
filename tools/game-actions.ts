/** Disposable native movement scenarios, driven through the opt-in World RPC. */
import type { State } from './test-game-world.ts';

interface Meeting { Npc: string; Time: number; Place: string; Leave: number; Depart: number; Applied: boolean; Failed: boolean;
  Arrived: boolean; Met: boolean; Reported: boolean; Stage: number; Helps: boolean; Spouse: boolean; Destroys: boolean | null;
  Helped: { Watered: number; Harvested: number; Fed: number; Ponds: number } | null; spot: { map: string; x: number; y: number } }
export interface ActionState { eligible: Record<string, number>; approached: string[]; lastApproachAt: number;
  approach: { npc: string; phase: string; Talked: boolean; origin: { x: number; y: number; facing: number }; path: number; hold: boolean } | null;
  meetings: Meeting[]; routes: { time: number; map: string; x: number; y: number; steps: number }[] | null }
export interface Host { rpc(operation: string, args?: Record<string, unknown>): Promise<State>;
  chapter(season: string, day: number, rain?: boolean, year?: number): Promise<State>;
  check(label: string, passed: unknown, detail?: unknown): void;
  say(npc: string, text: string, label: string): Promise<State>; close(): Promise<void>;
  packets(type: string, from?: number): Record<string, unknown>[]; wireCount(): number;
  latestSystem(): string; seedNight(enabled: boolean, farm?: boolean): void;
  meetingEntries(): Promise<number>;
}
const npc = (state: State, id = 'Abigail') => state.npcs!.find(npc => npc.id === id)!;

export async function runActions(h: Host) {
  const { rpc, check, chapter } = h;
  async function prepare(args: Record<string, unknown> = {}) {
    await rpc('action-reset'); await rpc('config', { BackstageScenes: false, OffscreenNews: false });
    await rpc('clock', { time: 1100 }); await rpc('warp', { map: 'Town', x: 45, y: 68 });
    await rpc('action-place', args); await rpc('action-approach-list', { npcs: { abigail: 0 } });
  }
  await prepare();
  let state = await rpc('action-approach-start');
  check('approach-starts-native-controller', state.actions?.approach?.phase === 'Walking' && npc(state).temporary, state.actions);
  state = await rpc('action-approach-wait');
  check('approach-walks-next-to-player', Math.abs(npc(state).x - 45) + Math.abs(npc(state).y - 68) === 1 && state.actions?.approach?.hold, state.actions);
  await rpc('action-camera'); await rpc('capture', { name: 'action-approach-wait.png', screen: true });
  await rpc('clock', { time: 1130 }); state = await rpc('action-approach-return');
  check('approach-timeout-restores-native-origin', npc(state).x === 50 && npc(state).y === 68 && !npc(state).temporary, npc(state));
  state = await rpc('action-approach-start'); check('approach-once-per-npc', !state.actions?.approach);

  await prepare(); await rpc('action-approach-start'); await rpc('action-approach-wait');
  await rpc('action-vanilla-talk'); await rpc('action-close-menu'); state = await rpc('action-approach-return');
  check('approach-vanilla-dialogue-returns-without-waiting-thirty-minutes', npc(state).x === 50 && npc(state).y === 68, npc(state));
  await prepare(); await rpc('action-approach-start'); await rpc('warp', { map: 'SeedShop', x: 8, y: 8 });
  state = await rpc('action-approach-return');
  check('approach-player-leaving-map-restores-origin', npc(state).location === 'Town' && npc(state).x === 50 && npc(state).y === 68, npc(state));

  for (const [label, fixture, config] of [
    ['hearts', { hearts: 1 }, {}], ['married', { relation: 'Married' }, {}], ['talked', { talked: true }, {}],
    ['busy', { busy: true }, {}], ['story', { ignore: true }, {}], ['next-stop-too-soon', { next: 1200 }, {}],
    ['disabled', {}, { NpcApproach: false }],
  ] as const) {
    await prepare(fixture);
    if (label === 'hearts') await rpc('action-approach-list', { npcs: { abigail: 5 } });
    await rpc('config', config); state = await rpc('action-approach-start');
    check('approach-excludes-' + label, !state.actions?.approach, state.actions);
  }
  await prepare(); await rpc('clock', { time: 2000 }); state = await rpc('action-approach-start'); check('approach-excludes-late-evening', !state.actions?.approach);
  await prepare(); await rpc('warp', { map: 'Farm', x: 8, y: 8 });
  await rpc('action-place', { map: 'Farm', x: 10, y: 8, noSchedule: true });
  state = await rpc('action-approach-start'); check('approach-excludes-farm', !state.actions?.approach);

  await runActionQueue(h);

  await prepare();
  for (const [index, id] of ['Abigail', 'Sam', 'Alex'].entries()) {
    await rpc('clock', { time: 1100 + index * 100 }); await rpc('action-place', { npc: id });
    await rpc('action-approach-list', { npcs: { [id.toLowerCase()]: 0 } });
    state = await rpc('action-approach-start');
    check('approach-hourly-budget-start-' + id, state.actions?.approach?.npc === id, state.actions);
    await rpc('action-approach-wait'); await rpc('clock', { time: 1130 + index * 100 }); await rpc('action-approach-return');
    await rpc('action-place', { npc: id, x: 70, y: 68 });
    if (index === 0) {
      await rpc('action-place', { npc: 'Sam' }); await rpc('action-approach-list', { npcs: { sam: 0 } });
      state = await rpc('action-approach-start');
      check('approach-excludes-within-sixty-minute-gap', !state.actions?.approach, state.actions);
    }
  }
  await rpc('clock', { time: 1400 }); await rpc('action-place', { npc: 'Haley' }); await rpc('action-approach-list', { npcs: { haley: 0 } });
  state = await rpc('action-approach-start');
  check('approach-global-daily-three-limit', !state.actions?.approach && state.actions?.approached.length === 3, state.actions);

  // Full night → messages → inserted routes → meeting → reliable result → save/reload/rollback.
  await chapter('spring', 1); await rpc('action-reset'); h.seedNight(true);
  await h.say('Abigail', '明天下午14:00在海滩见面，我确定参加。', 'actions-agree-tomorrow'); await h.close();
  await rpc('sleep'); h.seedNight(false);
  state = await rpc('wait', { ticks: 120 });
  check('meeting-nightly-reaches-native-client', state.actions?.meetings.some(m => m.Npc === 'Abigail' && m.Time === 1400 && m.Place === '海滩'), state.actions);
  // BeginWorldTest keeps normal options stable; let the actual received appointment apply now.
  await rpc('config', { NpcMeetings: true }); state = await rpc('wait', { ticks: 60 });
  let meeting = state.actions!.meetings.find(m => m.Npc === 'Abigail')!;
  check('meeting-native-original-schedule-is-modified', meeting.Applied && !meeting.Failed, state.actions);
  await rpc('action-observe', { npc: 'Abigail' }); state = await rpc('snapshot');
  for (const route of state.actions!.routes!.filter(route => route.time <= meeting.Depart)) await rpc('action-route', { time: route.time });
  await rpc('clock', { time: 1400 }); await rpc('warp', { map: meeting.spot.map, x: meeting.spot.x + 2, y: meeting.spot.y });
  state = await rpc('wait', { ticks: 60 });
  check('meeting-native-arrival-and-player-greeting', state.actions!.meetings[0]!.Arrived && state.actions!.meetings[0]!.Met, state.actions);
  await h.say('Abigail', '我们约好在这里见面对吧？', 'actions-meeting-talk');
  check('meeting-native-talk-knows-this-meeting', h.latestSystem().includes('现在就在这里碰面了')); await h.close();
  const wire = h.wireCount(); await rpc('clock', { time: meeting.Leave }); state = await rpc('wait', { ticks: 60 });
  check('meeting-native-reliable-result', h.packets('meet.ended', wire).some(packet => packet.met === true), h.packets('meet.ended', wire));
  check('meeting-replayed-result-has-one-atomic-entry', await h.meetingEntries() === 1);
  await rpc('sleep'); await rpc('title'); await rpc('load');
  await h.say('Abigail', '上次约在海滩见面，我来了吗？', 'actions-saved-meeting');
  check('meeting-real-save-reload-retains-result', /约好 14:00 在海滩见面，农场主来了/.test(h.latestSystem())); await h.close();

  await runActionPlaces(h);
  await runActionEdges(h);
}

export async function runActionPlaces(h: Host) {
  const { rpc, check, chapter } = h;
  let state: State, meeting: Meeting;
  // Every place uses the real NPC's selected day schedule, plus controlled appointment packets.
  for (const place of ['海滩', '镇广场', '墓地', '山上湖边', '森林河边', '博物馆', '星之果实餐吧', '杂货店']) {
    await chapter('spring', 1); await rpc('action-reset');
    state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', time: 1400, place }] });
    meeting = state.actions!.meetings[0]!;
    check('meeting-place-applies-' + place, meeting.Applied && !meeting.Failed, state.actions);
    const routes = state.actions!.routes!;
    check('meeting-place-paired-native-stops-' + place, routes.some(route => route.time === meeting.Depart && route.map === meeting.spot.map)
      && routes.some(route => route.time === meeting.Leave) && routes.some(route => route.time > meeting.Leave), routes);
    for (const route of routes.filter(route => route.time <= meeting.Depart)) await rpc('action-route', { time: route.time, speed: 8 });
    state = await rpc('wait', { ticks: 60 });
    check('meeting-place-native-arrival-' + place, npc(state).location === meeting.spot.map
      && Math.abs(npc(state).x - meeting.spot.x) + Math.abs(npc(state).y - meeting.spot.y) <= 2 && meeting.Applied, npc(state));
    const before = h.wireCount(); await rpc('clock', { time: meeting.Leave });
    state = await rpc('action-route', { time: meeting.Leave, speed: 8 });
    const expected = routes.find(route => route.time === meeting.Leave)!;
    check('meeting-place-native-return-' + place, npc(state).location === expected.map && npc(state).x === expected.x && npc(state).y === expected.y, npc(state));
    check('meeting-no-show-is-reported-' + place, h.packets('meet.ended', before).some(packet => packet.met === false), h.packets('meet.ended', before));
    if (place === '海滩') {
      await rpc('title'); await rpc('load'); await h.say('Abigail', '昨天约在海滩，我来了吗？', 'actions-unsaved-meeting');
      check('meeting-unsaved-result-rolls-back', !/约好 14:00 在海滩见面，我等到/.test(h.latestSystem())); await h.close();
    }
  }
}

export async function runActionEdges(h: Host) {
  const { rpc, check, chapter } = h;
  await chapter('spring', 1); await rpc('action-reset');
  let state = await rpc('action-meetings', { enabled: false, meetings: [{ npc: 'abigail', time: 1400, place: '海滩' }] });
  check('meeting-disabled-keeps-native-schedule', !state.actions!.meetings[0]!.Applied && !state.actions!.meetings[0]!.Failed, state.actions);
  await rpc('config', { NpcMeetings: true }); state = await rpc('wait', { ticks: 60 });
  check('meeting-enabling-applies-pending-appointment', state.actions!.meetings[0]!.Applied, state.actions);
  const before = h.wireCount(); await rpc('clock', { time: 1530 }); state = await rpc('wait', { ticks: 60 });
  check('meeting-never-arrived-does-not-write-waiting-memory', state.actions!.meetings[0]!.Reported
    && !state.actions!.meetings[0]!.Arrived && h.packets('meet.ended', before).length === 0, state.actions);
  await chapter('spring', 1); await rpc('action-reset'); await rpc('clock', { time: 1340 });
  state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', time: 1400, place: '海滩' }] });
  check('meeting-too-late-for-native-travel-keeps-original-schedule', state.actions!.meetings[0]!.Failed && !state.actions!.meetings[0]!.Applied, state.actions);
  for (const [place, capacity] of [['海滩', 2], ['墓地', 1]] as const) {
    await chapter('spring', 1); await rpc('action-reset');
    state = await rpc('action-meetings', { meetings: ['abigail', 'haley', 'sam', 'alex'].map(npc => ({ npc, time: 1400, place })) });
    const list = state.actions!.meetings;
    check('meeting-global-three-limit-' + place, list.length === 3, list);
    check('meeting-native-place-capacity-' + place, list.filter(meeting => meeting.Applied).length === capacity && list.filter(meeting => meeting.Failed).length === 3-capacity, list);
    const spots = list.filter(meeting => meeting.Applied).map(meeting => JSON.stringify(meeting.spot));
    check('meeting-native-distinct-spots-' + place, new Set(spots).size === spots.length, list);
  }
  for (const [label, fixture] of [['married', { relation: 'Married' }], ['no-schedule', { noSchedule: true }], ['story', { ignore: true }]] as const) {
    await chapter('spring', 1); await rpc('action-reset'); await rpc('action-place', fixture);
    state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', time: 1400, place: '海滩' }] });
    check('meeting-excludes-' + label, state.actions!.meetings[0]!.Failed && !state.actions!.meetings[0]!.Applied, state.actions);
  }
}

export async function runActionQueue(h: Host) {
  const { rpc, check } = h;
  await rpc('action-reset'); await rpc('clock', { time: 1300 }); await rpc('warp', { map: 'Town', x: 45, y: 68 });
  await rpc('action-place', { next: 1500 }); await rpc('action-approach-list', { npcs: { abigail: 0 } });
  await rpc('action-approach-start'); await rpc('action-approach-wait');
  let state = await rpc('action-schedule-due', { time: 1500 });
  check('approach-native-schedule-really-queues-while-held', npc(state).queued > 0 && npc(state).temporary, npc(state));
  state = await rpc('action-approach-return');
  check('approach-release-automatically-resumes-queued-schedule', npc(state).controller && npc(state).queued === 0, npc(state));
  state = await rpc('action-route-wait', { time: 1500 });
  check('approach-queued-native-schedule-reaches-its-target', npc(state).location === 'Town' && npc(state).x === 47 && npc(state).y === 87, npc(state));
}

export async function runActionRender(h: Host) {
  const { rpc, check } = h;
  await rpc('action-reset'); await rpc('clock', { time: 1100 }); await rpc('warp', { map: 'Beach', x: 32, y: 34 });
  await rpc('action-place', { map: 'Beach', x: 30, y: 34, noSchedule: true }); await rpc('action-approach-list', { npcs: { abigail: 0 } });
  await rpc('action-approach-start'); const state = await rpc('action-approach-wait');
  check('approach-render-fixture-is-adjacent', state.player && Math.abs(npc(state).x - state.player.x) + Math.abs(npc(state).y - state.player.y) === 1,
    { npc: npc(state), player: state.player, approach: state.actions?.approach });
  await rpc('action-camera'); await rpc('capture', { name: 'action-approach-render.png', screen: true });
}

export async function runActionTiming(h: Host) {
  const { rpc, check, chapter } = h;
  await runActionRender(h);
  let state: State;
  for (const place of ['星之果实餐吧', '杂货店']) {
    await chapter('spring', 1); await rpc('action-reset');
    state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', time: 1400, place }] });
    check('meeting-departure-settles-across-native-stop-' + place, state.actions!.meetings[0]!.Applied && !state.actions!.meetings[0]!.Failed, state.actions);
  }
  await chapter('spring', 1); await rpc('action-reset');
  state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', time: 1400, place: '海滩' }] });
  const meeting = state.actions!.meetings[0]!;
  check('meeting-natural-clock-plan-applies', meeting.Applied && !meeting.Failed, state.actions);
  for (const route of state.actions!.routes!.filter(route => route.time < meeting.Depart)) await rpc('action-route', { time: route.time, speed: 8 });
  state = await rpc('action-flow-route', { time: meeting.Depart });
  check('meeting-natural-clock-actually-advanced', state.time > meeting.Depart, state);
  check('meeting-natural-clock-arrives-by-agreed-time', state.time <= meeting.Time && npc(state).location === meeting.spot.map
    && Math.abs(npc(state).x - meeting.spot.x) + Math.abs(npc(state).y - meeting.spot.y) <= 2, { time: state.time, meeting, npc: npc(state) });
  await rpc('warp', { map: meeting.spot.map, x: meeting.spot.x + 2, y: meeting.spot.y });
  state = await rpc('wait', { ticks: 60 });
  check('meeting-natural-clock-native-greeting', state.actions!.meetings[0]!.Arrived && state.actions!.meetings[0]!.Met, state.actions);
  await rpc('action-camera'); await rpc('capture', { name: 'action-meeting-render.png', screen: true });
  await rpc('clock', { time: 1410 }); const before = h.wireCount(); await rpc('sleep');
  check('meeting-early-sleep-reports-the-actual-time', h.packets('meet.ended', before).some(packet => packet.left === 1410 && packet.met === true), h.packets('meet.ended', before));
  await rpc('title'); await rpc('load'); await h.say('Abigail', '上次在海滩见面，我来了吗？', 'actions-early-save');
  check('meeting-early-sleep-real-save-retains-result', /约好 14:00 在海滩见面，农场主来了/.test(h.latestSystem())); await h.close();
}

export async function runActionIncoming(h: Host) {
  const { rpc, check, chapter } = h;
  await chapter('spring', 1); await rpc('action-reset');
  let state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', time: 1400, place: '杂货店' }] });
  const meeting = state.actions!.meetings[0]!;
  check('meeting-incoming-leg-plan-applies', meeting.Applied && !meeting.Failed, state.actions);
  for (const route of state.actions!.routes!.filter(route => route.time < 1300)) await rpc('action-route', { time: route.time, speed: 8 });
  // Start before the original 13:00 stop so it must really be reached, or replaced by the appointment.
  state = await rpc('action-flow-route', { time: meeting.Depart, start: 1250 });
  check('meeting-incoming-leg-natural-clock-is-on-time', state.time <= 1400 && npc(state).location === 'SeedShop'
    && npc(state).x === meeting.spot.x && npc(state).y === meeting.spot.y, { time: state.time, meeting, npc: npc(state) });
}
