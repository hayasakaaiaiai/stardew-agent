/** Native farm mutations and travel in the identity-checked disposable World save. */
import type { State } from './test-game-world.ts';
import type { Host } from './game-actions.ts';

interface Soil { x: number; y: number; label: string; pot: boolean; state: number; watered: boolean; needsWater: boolean;
  crop: { id: string; ready: boolean; dead: boolean; forage: boolean; day: number; regrows: boolean } | null }
interface Item { id: string; stack: number; quality: number }
export interface FarmState { rain: boolean; hay: number; door: { X: number; Y: number }; porch: { X: number; Y: number };
  gates: { bus: { X: number; Y: number }; entry: { X: number; Y: number }; exit: { X: number; Y: number } };
  soils: Soil[]; chests: { x: number; y: number; helper: boolean; items: Item[] }[];
  buildings: { type: string; feed: number; output: { id: string; stack: number } | null }[];
  objects: { x: number; y: number; id: string }[]; debris: (string | null)[] }
interface Done { Watered: number; Harvested: number; Fed: number; Ponds: number }
const farm = (state: State) => state.farm!;
const soil = (state: State, label: string) => farm(state).soils.find(soil => soil.label === label)!;
const amount = (state: State, id: string) => farm(state).chests.flatMap(chest => chest.items).filter(item => item.id === id).reduce((n, item) => n + item.stack, 0);
const done = (state: State) => state.native as unknown as Done;
const signature = (state: State) => JSON.stringify({ soils: [...farm(state).soils].sort((a, b) => a.x - b.x || a.y - b.y), hay: farm(state).hay,
  chests: [...farm(state).chests].sort((a, b) => a.x - b.x || a.y - b.y), buildings: [...farm(state).buildings].sort((a, b) => a.type.localeCompare(b.type)) });

export async function runFarmChores(h: Host) {
  const { rpc, chapter, check } = h;
  for (const rain of [false, true]) {
    await chapter('spring', 1, rain); await rpc('action-reset');
    const before = await rpc('farm-fixture');
    if (!rain) {
      const probe = await rpc('farm-probe');
      const paths = (probe.native as unknown as { paths: { count: number | null }[] }).paths;
      check('farm-native-gate-to-porch-path-exists', (paths[0]!.count ?? 0) > 2, paths);
    }
    check('farm-fixture-keeps-vanilla-house-' + rain, farm(before).buildings.some(building => building.type === 'Farmhouse'), farm(before).buildings);
    const eligible = farm(before).soils.filter(soil => soil.crop && !soil.crop.dead && !soil.watered && soil.needsWater).length;
    const state = await rpc('farm-run'), result = done(state);
    check('farm-water-native-soil-and-pots-' + rain, result.Watered === (rain ? 0 : eligible)
      && (rain || soil(state, 'young').watered && soil(state, 'pot').watered), { result, eligible, farm: farm(state) });
    check('farm-harvest-native-single-and-regrowing-' + rain, !soil(state, 'parsnip').crop && soil(state, 'blueberry').crop?.regrows
      && !soil(state, 'blueberry').crop?.ready && amount(state, '(O)24') >= 1 && amount(state, '(O)258') >= 3, farm(state));
    check('farm-keeps-flower-forage-dead-and-young-' + rain, soil(state, 'flower').crop?.ready && soil(state, 'wild').crop?.ready
      && soil(state, 'ginger').crop?.forage && soil(state, 'dead').crop?.dead && !soil(state, 'young').crop?.ready, farm(state).soils);
    check('farm-native-hay-and-pond-conservation-' + rain, result.Fed === 3 && farm(state).hay === 0
      && farm(state).buildings.find(building => building.type === 'Coop')!.feed === 3
      && result.Ponds === 1 && amount(state, '(O)812') === 3 && !farm(state).buildings.find(building => building.type === 'Fish Pond')!.output,
      { result, farm: farm(state) });
    const itemCount = farm(state).chests.flatMap(chest => chest.items).reduce((n, item) => n + item.stack, 0);
    check('farm-harvest-count-matches-stored-items-' + rain, result.Harvested === itemCount - 3 && farm(state).debris.length === 0, { result, itemCount });
    const again = await rpc('farm-run');
    check('farm-repeat-does-not-duplicate-chores-' + rain, Object.values(done(again)).every(n => n === 0) && signature(again) === signature(state), done(again));
  }
  await chapter('spring', 1); await rpc('action-reset');
  await rpc('farm-fixture', { full: true }); let state = await rpc('farm-run');
  check('farm-full-chest-adds-another-without-losing-items', farm(state).chests.length >= 2 && amount(state, '(O)390') === 36 * 999
    && done(state).Harvested > 0 && done(state).Ponds === 1, farm(state));
  const before = await rpc('farm-fixture', { full: true, blocked: true }); state = await rpc('farm-run');
  check('farm-no-space-preserves-crops-and-pond-output', done(state).Harvested === 0 && done(state).Ponds === 0
    && soil(state, 'parsnip').crop?.ready && soil(state, 'blueberry').crop?.ready
    && farm(state).buildings.find(building => building.type === 'Fish Pond')!.output?.stack === 3
    && JSON.stringify(farm(state).chests) === JSON.stringify(farm(before).chests), farm(state));
  check('farm-no-space-does-not-break-objects', JSON.stringify(farm(state).objects) === JSON.stringify(farm(before).objects), farm(state).objects);
}

async function arrive(h: Host, hearts = 8, natural = false, fromNight = false) {
  const { rpc, check } = h;
  if (!fromNight) await rpc('action-reset');
  await rpc('farm-fixture');
  // Keep the native day schedule; only the friendship and the appointment are controlled.
  await rpc('farm-friendship', { hearts });
  let state: State;
  if (fromNight) {
    await rpc('config', { NpcMeetings: true }); await rpc('action-observe', { npc: 'Abigail' });
    state = await rpc('wait', { ticks: 60 });
    check('farm-real-day-packet-after-night', state.actions!.meetings.some(meeting => meeting.Place === '农场' && meeting.Time === 1000), state.actions);
  } else state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', place: '农场', time: 1000 }] });
  const meeting = state.actions!.meetings[0]!;
  check('farm-native-plan-applies-' + hearts, meeting.Applied && !meeting.Failed, state.actions);
  for (const route of state.actions!.routes!.filter(route => route.time < meeting.Depart)) await rpc('action-route', { time: route.time, speed: 8 });
  // Vanilla completes local paths immediately off screen; the walking assertion needs a player on the farm.
  if (natural) await rpc('warp', { map: 'Farm', x: 50, y: 25 });
  state = await rpc('farm-start', { natural, speed: natural ? 2 : 8 });
  const travel = (state.native as unknown as { farmTravel: { X: number; Y: number }[] }).farmTravel;
  if (natural) check('farm-visitor-walks-inside-farm-' + hearts, travel.length > 2, travel);
  check('farm-visitor-actually-reaches-porch-' + hearts, state.npcs!.find(npc => npc.id === 'Abigail')!.location === 'Farm'
    && state.actions!.meetings[0]!.Arrived, state);
  if (natural) check('farm-natural-clock-normal-speed-is-on-time', state.time <= 1000 && state.time > meeting.Depart, { time: state.time, meeting });
  return state;
}

export async function runFarmVisits(h: Host) {
  const { rpc, chapter, check } = h;
  await chapter('spring', 1); await rpc('action-reset'); h.seedNight(true, true);
  await h.say('Abigail', '明天上午来农场帮我浇浇水好吗？', 'farm-night-agreement'); await h.close(); await rpc('sleep'); h.seedNight(false);
  let state = await arrive(h, 8, true, true);
  const originalDestroys = state.actions!.meetings[0]!.Destroys;
  check('farm-native-walk-keeps-fence-and-house', state.npcs!.find(npc => npc.id === 'Abigail')!.destroys === false
    && farm(state).objects.some(item => item.x === farm(state).gates.entry.X - 2 && item.y === farm(state).gates.entry.Y + 2 && item.id === '(O)322')
    && farm(state).buildings.some(building => building.type === 'Farmhouse'), state);
  check('farm-close-visitor-does-real-chores', !soil(state, 'parsnip').crop && farm(state).hay === 0 && amount(state, '(O)812') === 3, farm(state));
  const porch = farm(state).porch;
  await rpc('clock', { time: 1000 }); await rpc('warp', { map: 'Farm', x: porch.X + 2, y: porch.Y });
  state = await rpc('wait', { ticks: 60 });
  check('farm-nearby-player-is-greeted', state.actions!.meetings[0]!.Met, state.actions);
  await h.say('Abigail', '你都帮我干了什么？', 'farm-help-talk');
  check('farm-talk-wire-and-prompt-contain-real-chores', h.packets('talk.open').at(-1)!.helped
    && /你来了以后已经/.test(h.latestSystem()), h.latestSystem()); await h.close();
  await rpc('action-camera'); await rpc('capture', { name: 'farm-help-porch.png', screen: true });
  await rpc('capture', { name: 'farm-help-porch-final.png' });
  await rpc('warp', { map: 'Farm', x: 50, y: 25 });
  const before = h.wireCount(); state = await rpc('farm-exit', { speed: 8 });
  check('farm-present-player-sees-native-walk-to-exit', (state.native as unknown as { farmTravel: unknown[] }).farmTravel.length > 2, state.native);
  check('farm-leaves-and-native-schedule-resumes', state.npcs!.find(npc => npc.id === 'Abigail')!.location !== 'Farm'
    && !state.npcs!.find(npc => npc.id === 'Abigail')!.temporary, state);
  check('farm-leaving-restores-native-object-walking', state.npcs!.find(npc => npc.id === 'Abigail')!.destroys === originalDestroys, state.npcs!.find(npc => npc.id === 'Abigail'));
  check('farm-reliable-summary-matches-chores', h.packets('meet.ended', before).some(packet => packet.place === '农场' && packet.helped && packet.met === true), h.packets('meet.ended', before));
  check('farm-replayed-summary-writes-one-entry', await h.meetingEntries() === 1);
  await chapter('spring', 1); state = await arrive(h, 5);
  check('farm-low-hearts-visitor-does-no-chores', soil(state, 'parsnip').crop?.ready && farm(state).hay === 3 && amount(state, '(O)812') === 0, farm(state));
  const lowBefore = h.wireCount(); await rpc('farm-exit', { speed: 8 });
  check('farm-low-hearts-no-show-has-no-chore-claim', h.packets('meet.ended', lowBefore).some(packet => packet.met === false && !packet.helped), h.packets('meet.ended', lowBefore));
  await chapter('spring', 1); state = await arrive(h, 8);
  check('farm-offscreen-helper-does-real-chores', state.location === 'FarmHouse' && !soil(state, 'parsnip').crop
    && farm(state).hay === 0 && amount(state, '(O)812') === 3, state);
  const absentBefore = h.wireCount(); await rpc('farm-exit', { speed: 8 });
  check('farm-offscreen-help-records-work-and-no-show', h.packets('meet.ended', absentBefore).some(packet => packet.met === false && packet.helped), h.packets('meet.ended', absentBefore));
  for (const relation of ['Dating', 'Engaged']) {
    await chapter('spring', 1); await rpc('action-reset'); await rpc('farm-friendship', { hearts: 2, relation });
    state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', place: '农场', time: 1000 }] });
    check('farm-intimate-relation-can-help-below-eight-hearts-' + relation, state.actions!.meetings[0]!.Applied && state.actions!.meetings[0]!.Helps, state.actions);
  }
  for (const map of ['Farm', 'FarmHouse', 'Town']) {
    const home = map !== 'Town';
    await chapter('spring', 1); await rpc('action-reset'); await rpc('farm-fixture');
    await rpc('action-place', { relation: 'Married', noSchedule: true, map, x: map === 'Farm' ? 64 : map === 'FarmHouse' ? 3 : 50, y: map === 'Farm' ? 16 : map === 'FarmHouse' ? 4 : 68 });
    state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', place: '农场', time: 1000 }] });
    check('farm-spouse-does-not-need-or-change-a-schedule-' + map, state.actions!.meetings[0]!.Applied && state.actions!.meetings[0]!.Spouse && !state.actions!.routes, state.actions);
    await rpc('clock', { time: 1000 }); state = await rpc('farm-watch');
    check('farm-spouse-only-works-when-home-' + map, home ? !soil(state, 'parsnip').crop && state.actions!.meetings[0]!.Helped
      : soil(state, 'parsnip').crop?.ready && !state.actions!.meetings[0]!.Helped && state.actions!.meetings[0]!.Reported, state);
  }
}

export async function runFarmSave(h: Host) {
  const { rpc, chapter, check } = h;
  await chapter('spring', 1); await rpc('action-reset'); await rpc('farm-fixture'); h.seedNight(true, true);
  await h.say('Abigail', '明天上午来农场帮我浇浇水好吗？', 'farm-save-agreement'); await h.close(); await rpc('sleep'); h.seedNight(false);
  await rpc('title'); let before = await rpc('load');
  await rpc('farm-run'); await rpc('title'); let state = await rpc('load');
  check('farm-unsaved-real-reload-restores-all-farm-state', signature(state) === signature(before), { before: farm(before), after: farm(state) });
  await rpc('action-reset'); await rpc('farm-friendship', { hearts: 8 });
  state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', place: '农场', time: 1000 }] });
  const meeting = state.actions!.meetings[0]!;
  check('farm-saved-fixture-plan-applies', meeting.Applied && !meeting.Failed, state.actions);
  for (const route of state.actions!.routes!.filter(route => route.time < meeting.Depart)) await rpc('action-route', { time: route.time, speed: 8 });
  state = await rpc('farm-start', { speed: 8 });
  // The native overnight update can replace the fixture's pond output before this saved baseline.
  const expectedRoe = amount(before, '(O)812') + farm(before).buildings.reduce((n, building) =>
    n + (building.output?.id === '(O)812' ? building.output.stack : 0), 0);
  check('farm-saved-fixture-native-arrival', state.actions!.meetings[0]!.Arrived && expectedRoe > 0
    && amount(state, '(O)812') === expectedRoe && !farm(state).buildings.find(building => building.type === 'Fish Pond')!.output,
    { expectedRoe, farm: farm(state) });
  const stock = farm(state).chests.flatMap(chest => chest.items);
  await rpc('clock', { time: 1010 }); const wireBefore = h.wireCount(); await rpc('sleep');
  check('farm-early-sleep-reports-current-day-chores', h.packets('meet.ended', wireBefore).some(packet => packet.left === 1010 && packet.helped), h.packets('meet.ended', wireBefore));
  await rpc('title'); state = await rpc('load');
  check('farm-real-save-reload-retains-chest-and-hay', JSON.stringify(farm(state).chests.flatMap(chest => chest.items)) === JSON.stringify(stock) && farm(state).hay === 0, farm(state));
  await h.say('Abigail', '你上次来农场做了什么？', 'farm-help-saved-recall');
  check('farm-real-save-reload-retains-chore-memory', /约好 10:00 在农场见面，我/.test(h.latestSystem()) && /收了 1 个鱼塘/.test(h.latestSystem()), h.latestSystem());
  await h.close();
}
