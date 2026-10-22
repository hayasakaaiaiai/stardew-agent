/** Actual dungeon warps, production follow/combat/rescue, and persistence in the identity-checked World copy. */
import type { State } from './test-game-world.ts';
import type { Host } from './game-actions.ts';

interface Actor { map: string; x: number; y: number; speed: number; pass: boolean; destroys: boolean; temporary: boolean; controller: boolean }
interface Trip { Npc: string; Place: string; Companion: boolean; Time: number; Depart: number; Leave: number; Arrived: boolean; Met: boolean; Reported: boolean;
  Joined: boolean; Following: boolean; HomeBound: boolean; Floor: number; Deepest: number; Kills: number; Rescued: boolean; Rescuing: boolean; Bye: number; actor: Actor }
export interface MineState { player: { health: number; maxHealth: number; Money: number; killScreen: boolean; kills: number; guild: number; experience: number; unconscious: number; items: unknown[] };
  meetings: Trip[]; targets: { Health: number; MaxHealth: number }[]; actualKills: number; guildDelta: number; experienceDelta: number; debris: number; travel: { X: number; Y: number }[];
  obstacle: { exists: boolean; id: string } | null }
const mine = (state: State) => state.mine!;
const trip = (state: State) => mine(state).meetings[0]!;

const doors: Record<string, { map: string; x: number; y: number; startX: number; startY: number }> = {
  矿洞: { map: 'Mountain', x: 54, y: 5, startX: 44, startY: 18 },
  骷髅洞穴: { map: 'Desert', x: 8, y: 6, startX: 10, startY: 10 },
  火山: { map: 'IslandNorth', x: 40, y: 24, startX: 40, startY: 30 },
};
async function prepare(h: Host, npc = 'Abigail', hearts = 8, enabled = true, fromNight = false,
  place = '矿洞', fresh = true) {
  const { rpc, chapter, check } = h;
  if (fresh) await chapter('spring', 6, false, npc === 'Kent' ? 2 : 1);
  await rpc('action-reset'); await rpc('mine-unlock');
  await rpc('config', { NpcMineCompanion: enabled });
  if (fromNight) {
    h.seedNight(true, false, place); await h.say(npc, `明天上午一起去${place}探险吧？`, 'mine-night-agreement'); await h.close();
    await rpc('sleep'); h.seedNight(false);
  }
  const door = doors[place]!;
  if (place !== '矿洞') {
    const topology = await rpc('mine-topology', { npc, place });
    check('mine-original-home-to-door-graph-' + place, Number(topology.native?.go) > 0 && Number(topology.native?.back) > 0, topology.native);
  }
  await rpc('action-place', { npc, hearts, map: door.map, x: door.startX, y: door.startY, targetX: door.startX + 1, targetY: door.startY, next: 1800 });
  let planned: State;
  if (fromNight) {
    await rpc('action-observe', { npc }); await rpc('config', { NpcMeetings: true }); planned = await rpc('wait', { ticks: 60 });
  } else planned = await rpc('action-meetings', { npc, meetings: [{ npc: npc.toLowerCase(), place, time: 1000 }] });
  if (!planned.actions!.meetings[0]!.Applied) await rpc('mine-probe', { npc });
  check('mine-plan-applies-' + npc + '-' + hearts, planned.actions!.meetings[0]!.Applied && !planned.actions!.meetings[0]!.Failed, planned.actions);
  await rpc('mine-start', { npc, place, speed: 8 });
  await rpc('clock', { time: 1000 }); await rpc('warp', { map: door.map, x: door.x, y: door.y });
  const met = await rpc('wait', { ticks: 30 }); check('mine-door-greeting-' + npc, trip(met).Arrived && trip(met).Met, mine(met));
  const entered = await rpc('mine-enter', { floor: 0 });
  check('mine-door-native-warp-controls-joining-' + npc + '-' + hearts, trip(entered).Following === (hearts >= 8 && enabled), mine(entered));
  return entered;
}

export async function runMineCore(h: Host) {
  const { rpc, check } = h;
  await prepare(h, 'Abigail', 8, true, true);
  let state = await rpc('mine-level', { floor: 1 });
  check('mine-native-floor-generation-and-companion-warp', trip(state).Floor === 1 && trip(state).actor.map === state.location && trip(state).Following, mine(state));
  await rpc('mine-room'); const collision = await rpc('mine-collision');
  check('mine-vanilla-collision-allows-player-through-companion', collision.native?.blocked === true && collision.native?.allowed === false, collision.native);
  state = await rpc('mine-follow', { blocked: true });
  check('mine-follows-by-native-path-through-multiple-tiles', mine(state).travel.length > 2 && trip(state).actor.temporary, mine(state));
  check('mine-native-follow-keeps-real-stone-intact', mine(state).obstacle?.exists && mine(state).obstacle?.id === '(O)343', mine(state));
  state = await rpc('mine-far');
  check('mine-far-catchup-is-near-and-keeps-protection', trip(state).actor.pass && !trip(state).actor.destroys
    && Math.abs(trip(state).actor.x - state.player!.x) + Math.abs(trip(state).actor.y - state.player!.y) <= 2, mine(state));
  state = await rpc('mine-menu', { target: true, ticks: 120 });
  check('mine-vanilla-menu-pauses-production-attacks', mine(state).targets[0]?.Health === 250, mine(state)); await rpc('action-close-menu');
  state = await rpc('mine-combat', { count: 1 });
  check('mine-production-hit-kills-real-monster', mine(state).targets.every(target => target.Health <= 0) && mine(state).actualKills === 1, mine(state));
  check('mine-real-kill-awards-xp-guild-and-drops', mine(state).guildDelta === 1 && mine(state).experienceDelta > 0 && mine(state).debris > 0, mine(state));
  const beforeKills = trip(state).Kills;
  state = await rpc('mine-combat', { count: 2 });
  check('mine-overlapping-monsters-all-die-through-native-damage', mine(state).targets.every(target => target.Health <= 0) && mine(state).actualKills === 2, mine(state));
  check('mine-trip-count-matches-all-native-kills', trip(state).Kills - beforeKills === mine(state).actualKills, mine(state));
  state = await rpc('mine-level', { floor: 5 });
  check('mine-next-floor-keeps-real-kill-count-and-deepest', trip(state).Floor === 5 && trip(state).Deepest === 5 && trip(state).Kills >= 3, mine(state));
  state = await rpc('mine-room'); const kills = trip(state).Kills;
  await h.say('Abigail', '现在第几层，你打倒了几只怪？', 'mine-live-floor-and-kills');
  check('mine-talk-has-real-floor-and-kills', /现在在矿洞第 5 层/.test(h.latestSystem()) && h.latestSystem().includes(`打倒了 ${kills} 只怪物`), h.latestSystem()); await h.close();
  await rpc('warp', { map: 'Mountain', x: 54, y: 5 }); state = await rpc('wait', { ticks: 120 });
  check('mine-exit-releases-following-and-records-trip', !trip(state).Following && trip(state).Reported && !trip(state).actor.temporary, mine(state));
  check('mine-exit-restores-vanilla-speed-and-collision', trip(state).actor.speed === 2 && !trip(state).actor.pass && trip(state).actor.destroys, mine(state));
}

export async function runMineRescue(h: Host) {
  const { rpc, check } = h;
  for (const post of [false, true]) {
    await prepare(h); await rpc('mine-level', { floor: 1 }); const before = await rpc('mine-room');
    let state = await rpc('mine-damage', { post });
    check('mine-rescue-intercepts-native-lethal-damage-' + post, state.location === 'Mountain' && mine(state).player.health >= 10
      && !mine(state).player.killScreen && trip(state).Rescued && !trip(state).Following, mine(state));
    check('mine-rescue-preserves-money-inventory-and-death-count-' + post, mine(state).player.Money === mine(before).player.Money
      && JSON.stringify(mine(state).player.items) === JSON.stringify(mine(before).player.items)
      && mine(state).player.unconscious === mine(before).player.unconscious, { before: mine(before), after: mine(state) });
    await rpc('action-close-menu'); state = await rpc('wait', { ticks: 120 });
    check('mine-rescue-restores-vanilla-speed-' + post, trip(state).actor.speed === 2 && !trip(state).actor.pass, mine(state));
  }
}

export async function runMineEdges(h: Host) {
  const { rpc, chapter, check } = h;
  for (const [hearts, enabled] of [[5, true], [8, false]] as const) {
    await prepare(h, 'Abigail', hearts, enabled);
    let state = await rpc('mine-level', { floor: 1 });
    check('mine-gate-keeps-npc-outside-' + hearts + '-' + enabled, !trip(state).Joined && trip(state).actor.map === 'Mountain', mine(state));
    await rpc('clock', { time: 1130 }); state = await rpc('wait', { ticks: 60 });
    check('mine-door-only-visit-ends-without-trip-' + hearts + '-' + enabled, trip(state).Reported
      && h.packets('meet.ended').some(packet => packet.met === true && !packet.mine), mine(state));
  }
  await prepare(h, 'Haley'); await rpc('mine-level', { floor: 1 });
  let state = await rpc('mine-combat', { count: 1 });
  check('mine-nonfighter-does-not-damage-native-monster', mine(state).targets[0]?.Health === 1 && mine(state).actualKills === 0 && trip(state).Kills === 0, mine(state));
  await rpc('mine-room'); state = await rpc('mine-follow');
  check('mine-nonfighter-still-walks-and-follows', trip(state).Following && mine(state).travel.length > 2, mine(state));
  await h.say('Haley', '刚才的史莱姆是你打倒的吗？', 'mine-nonfighter-talk');
  check('mine-nonfighter-wire-reports-no-fighting', (h.packets('talk.open').at(-1)?.mine as { fights: boolean }).fights === false); await h.close();

  await prepare(h); await rpc('mine-level', { floor: 1 }); await rpc('mine-room');
  await rpc('clock', { time: 2200 }); state = await rpc('wait', { ticks: 120 });
  check('mine-2200-goodbye-releases-dynamic-floor-actor', !trip(state).Following && trip(state).Reported
    && trip(state).actor.map === 'Mountain' && !trip(state).actor.temporary && trip(state).actor.speed === 2, mine(state));
  await prepare(h); await rpc('mine-level', { floor: 1 });
  await rpc('warp', { map: 'Farm', x: 50, y: 25 }); state = await rpc('wait', { ticks: 60 });
  check('mine-warp-home-releases-companion-to-native-schedule', !trip(state).Following && trip(state).Reported
    && trip(state).actor.map === 'Mountain' && !trip(state).actor.temporary, mine(state));

  for (const [relation, npc] of [['Married', 'Abigail'], ['Roommate', 'Krobus']] as const) {
    await chapter('spring', 6); await rpc('action-reset'); await rpc('mine-unlock');
    await rpc('config', { NpcMineCompanion: true });
    await rpc('action-place', { npc, relation: 'Married', roommate: relation === 'Roommate', hearts: 2, noSchedule: true, map: 'FarmHouse', x: 3, y: 4 });
    state = await rpc('action-meetings', { npc, meetings: [{ npc: npc.toLowerCase(), place: '矿洞', time: 1000 }] });
    check('mine-spouse-can-plan-without-schedule-' + relation, state.actions!.meetings[0]!.Spouse && trip(state).Companion && trip(state).Depart === 930, state.actions);
    await rpc('clock', { time: 1000 }); state = await rpc('wait', { ticks: 60 });
    check('mine-visible-spouse-waits-to-leave-unseen-' + relation, !trip(state).Arrived && trip(state).actor.map === 'FarmHouse', mine(state));
    await rpc('warp', { map: 'Farm', x: 50, y: 25 }); state = await rpc('wait', { ticks: 60 });
    check('mine-spouse-leaves-home-once-unseen-' + relation, trip(state).Arrived && trip(state).actor.map === 'Mountain', mine(state));
    await rpc('warp', { map: 'Mountain', x: 54, y: 5 }); await rpc('wait', { ticks: 30 });
    await rpc('mine-enter', { npc, place: '矿洞', floor: 0 }); await rpc('mine-level', { floor: 1 });
    await rpc('warp', { map: 'Mountain', x: 54, y: 5 }); state = await rpc('wait', { ticks: 30 });
    check('mine-spouse-stays-visible-after-exit-' + relation, !trip(state).Following && trip(state).HomeBound && trip(state).actor.map === 'Mountain', mine(state));
    await rpc('warp', { map: 'Farm', x: 50, y: 25 }); state = await rpc('wait', { ticks: 60 });
    check('mine-spouse-returns-home-with-native-speed-' + relation, !trip(state).HomeBound && trip(state).actor.map === 'FarmHouse'
      && trip(state).actor.speed === 2 && !trip(state).actor.temporary && !trip(state).actor.pass, mine(state));
  }
}

export async function runMineWorlds(h: Host, natural = true) {
  const { rpc, check, chapter } = h;
  // Preserve the original day's NPC schedule and let the normal clock trigger departure.
  if (natural) {
    await chapter('spring', 6); await rpc('action-reset'); await rpc('mine-unlock'); await rpc('farm-friendship', { hearts: 8 });
    let state = await rpc('action-meetings', { meetings: [{ npc: 'abigail', place: '矿洞', time: 1000 }] });
    const appointment = state.actions!.meetings[0]!;
    check('mine-original-vanilla-day-can-plan-door-route', appointment.Applied && !appointment.Failed, state.actions);
    for (const route of state.actions!.routes!.filter(route => route.time < appointment.Depart)) await rpc('action-route', { time: route.time, speed: 8 });
    await rpc('warp', { map: 'Mountain', x: 44, y: 18 });
    state = await rpc('mine-start', { npc: 'Abigail', place: '矿洞', natural: true, speed: 2 });
    check('mine-original-schedule-arrives-with-natural-clock-and-speed', trip(state).Arrived && state.time <= 1000
      && state.time > appointment.Depart && mine(state).travel.length > 2, { time: state.time, appointment, mine: mine(state) });
  }
  let state: State;
  for (const [place, npc] of [['骷髅洞穴', 'Kent'], ['火山', 'Sebastian']] as const) {
    await prepare(h, npc, 8, true, false, place);
    state = await rpc('mine-level', { floor: 1 });
    check('mine-native-other-dungeon-first-floor-' + place, trip(state).Floor === 1 && trip(state).actor.map === state.location && trip(state).Following, mine(state));
    state = await rpc('mine-combat', { count: 1 });
    check('mine-other-fighter-native-kill-' + npc, mine(state).actualKills === 1 && trip(state).Kills === 1 && mine(state).experienceDelta > 0, mine(state));
    state = await rpc('mine-level', { floor: place === '火山' ? 10 : 5 });
    check('mine-native-other-dungeon-deep-floor-' + place, trip(state).Floor === (place === '火山' ? 10 : 5) && trip(state).actor.map === state.location, mine(state));
    const before = await rpc('mine-room'); state = await rpc('mine-damage', { post: true });
    check('mine-other-dungeon-lethal-rescue-' + place, state.location === doors[place]!.map && trip(state).Rescued
      && mine(state).player.health >= 10 && !mine(state).player.killScreen && !trip(state).Following
      && mine(state).player.Money === mine(before).player.Money && JSON.stringify(mine(state).player.items) === JSON.stringify(mine(before).player.items), mine(state));
    await rpc('action-close-menu');
  }
}

export async function runMineSave(h: Host) {
  const { rpc, check } = h;
  await prepare(h, 'Abigail', 8, true, true); await rpc('title'); const morning = await rpc('load');
  await prepare(h, 'Abigail', 8, true, false, '矿洞', false); await rpc('mine-level', { floor: 5 }); await rpc('mine-combat', { count: 1 });
  await rpc('warp', { map: 'Mountain', x: 54, y: 5 }); await rpc('wait', { ticks: 60 });
  check('mine-unsaved-trip-writes-one-reliable-entry', await h.meetingEntries() === 1);
  await rpc('title'); let state = await rpc('load');
  check('mine-real-unsaved-reload-rolls-back-kills-xp-and-memory', mine(state).player.kills === mine(morning).player.kills
    && mine(state).player.experience === mine(morning).player.experience && await h.meetingEntries() === 0, mine(state));
  await prepare(h, 'Abigail', 8, true, false, '矿洞', false); await rpc('mine-level', { floor: 5 }); await rpc('mine-combat', { count: 2 });
  const rescued = await rpc('mine-damage', { post: true }); await rpc('action-close-menu');
  check('mine-rescue-replay-writes-one-entry', await h.meetingEntries() === 1);
  await rpc('clock', { time: 1010 }); await rpc('sleep'); await rpc('title'); state = await rpc('load');
  check('mine-real-save-reload-retains-kills-xp-items-and-money', mine(state).player.kills === mine(rescued).player.kills
    && mine(state).player.experience === mine(rescued).player.experience && mine(state).player.Money === mine(rescued).player.Money
    && JSON.stringify(mine(state).player.items) === JSON.stringify(mine(rescued).player.items), mine(state));
  await h.say('Abigail', '你刚才怎么把我从矿洞里救出来的？', 'mine-saved-rescue-recall');
  check('mine-saved-rescue-memory-has-actual-floor-and-kills', /下到矿洞第 5 层，打倒了 2 只怪物/.test(h.latestSystem())
    && /我把农场主背了出来/.test(h.latestSystem()), h.latestSystem()); await h.close();
  await prepare(h, 'Abigail', 8, true, false, '矿洞', false); await rpc('mine-level', { floor: 7 }); await rpc('mine-combat', { count: 1 });
  await rpc('clock', { time: 1010 }); const before = h.wireCount(); await rpc('sleep');
  check('mine-early-sleep-reports-trip-before-native-save', h.packets('meet.ended', before).some(packet => packet.left === 1010
    && (packet.mine as { deepest: number; kills: number })?.deepest === 7 && (packet.mine as { kills: number }).kills === 1), h.packets('meet.ended', before));
  await rpc('title'); state = await rpc('load');
  const actor = state.npcs!.find(npc => npc.id === 'Abigail');
  check('mine-early-sleep-does-not-lose-npc-in-deleted-level', actor && !/UndergroundMine|VolcanoDungeon/.test(actor.location) && !actor.temporary, actor);
  await h.say('Abigail', '你上次陪我下到了第几层？', 'mine-early-sleep-recall');
  check('mine-early-sleep-persists-current-trip-memory', /下到矿洞第 7 层，打倒了 1 只怪物/.test(h.latestSystem()), h.latestSystem()); await h.close();
}
