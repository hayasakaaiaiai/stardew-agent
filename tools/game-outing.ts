/** Native outing controllers, observed terminal fishing states, vanilla gifts, and isolated save/reload. */
import type { FriendshipHost } from './game-meeting-friendship.ts';
import type { State } from './test-game-world.ts';

interface OutingFields { places: string[]; here: string; fish: number; fishNames: string[]; escaped: number; treasures: number; foraged: number; artifacts: number }
export interface OutingState { tick: number; forage: number; artifacts: number; icons: { happy: number; sad: number; heart: number; surprise: number };
  meetings: { Npc: string; Met: boolean; Arrived: boolean; Reported: boolean; CalledOff: boolean; Leave: number;
    Together: boolean; Started: boolean; Still: number; Bye: number; EmoteAfter: number; GiftEmote: number | null; waitingForReturn: boolean; fields: OutingFields;
    Since: number; Suggested: boolean; Leading: string | null; LeadMaps: string[]; LeadAway: number; leadSpot: { map: string; x: number; y: number };
    actor: { map: string; x: number; y: number; facing: number; speed: number; CurrentEmote: number; CurrentEmoteIndex: number;
      temporary: boolean; controller: boolean; pass: boolean; destroys: boolean; text: string | null } }[] }
const outing = (s: State) => s.outing!.meetings[0]!;
const distance = (s: State) => Math.abs(outing(s).actor.x - s.player!.x) + Math.abs(outing(s).actor.y - s.player!.y);

export async function runOuting(h: FriendshipHost, section: string) {
  const { rpc, check, chapter } = h;
  const observe = (ticks = 60) => rpc('outing-observe', { ticks });
  async function prepare(options: { enabled?: boolean; arrive?: number; origin?: string; soon?: boolean } = {}) {
    await chapter('spring', 6); await rpc('action-reset'); await rpc('mine-unlock'); await rpc('clock', { time: 1000 });
    const map = options.origin ?? 'Desert', town = map === 'Town';
    await rpc('action-place', { map, x: town ? 50 : 10, y: town ? 68 : 10, targetX: town ? 47 : 11, targetY: town ? 87 : 10, next: 2200 });
    await rpc('friendship-fixture', { points: 2000 });
    await rpc('config', { NpcMeetings: true, NpcApproach: false, NpcInvites: false, MeetingsGoTogether: options.enabled ?? true, MeetingsChangeFriendship: true });
    await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 });
    h.setReply('你好。'); h.setMood(0); await rpc('talk-open', { npc: 'Abigail', keepFriendship: true });
    h.setReply(options.soon ? '好啊，现在一起去海边吧。' : '好啊，今天上午十一点海边见。');
    await rpc('talk-say', { text: options.soon ? '现在一起去海边吧？' : '今天上午十一点海边见？', label: 'outing-agreement' }); await h.close();
    let state = await rpc('wait', { ticks: 30 });
    check('outing-real-dialogue-publishes-native-plan', state.actions!.meetings[0]?.Applied && !state.actions!.meetings[0]?.Failed, state.actions);
    await rpc('clock', { time: options.arrive ?? (options.soon ? 1010 : 1100) });
    state = await rpc('action-meeting-wait', { natural: true });
    check('outing-arrives-before-player-and-does-not-start-alone', outing(state).Arrived && !outing(state).Together, state.outing);
    await rpc('warp', { map: 'Beach', x: 33, y: 34 });
    return observe(90);
  }
  async function dismiss() {
    h.setReply('你好。'); await rpc('talk-open', { npc: 'Abigail', keepFriendship: true });
    h.setReply('好吧，那我先回去了。'); await rpc('talk-say', { text: '你先回去吧。', label: 'outing-dismiss' });
    await h.close(); return observe(150);
  }
  async function ended(label: string, wire: number) {
    const state = await observe(120), packet = h.packets('meet.ended', wire).at(-1);
    check(label, outing(state).Reported && !outing(state).Together && !!packet?.outing && packet.met === true, { outing: state.outing, packet });
    return { state, packet };
  }
  if (section === 'outing' || section === 'outing-core') {
    let state = await prepare({ origin: 'Town' });
    check('outing-starts-only-after-native-meeting', outing(state).Together && outing(state).Started && outing(state).actor.temporary, state.outing);
    for (const facing of [0, 1, 2, 3]) {
      await rpc('outing-player', { x: 33, y: 34, facing }); state = await observe(240);
      const a = outing(state).actor;
      check('outing-stands-beside-and-faces-with-player-' + facing, distance(state) === 1 && a.facing === facing
        && (facing % 2 ? a.x === 33 : a.y === 34), state.outing);
    }
    await rpc('outing-player', { x: 42, y: 34 }); state = await observe(240);
    check('outing-follows-player-with-native-controller', distance(state) <= 3 && outing(state).actor.temporary, state.outing);
    await rpc('outing-actor', { x: 10, y: 10 }); state = await observe(30);
    check('outing-catches-up-when-more-than-twelve-tiles-away', distance(state) <= 3, state.outing);
    for (const [map, x, y] of [['Town', 50, 68], ['ArchaeologyHouse', 11, 9], ['Forest', 66, 50]] as const) {
      await rpc('warp', { map, x, y }); state = await observe(150);
      check('outing-follows-native-map-warp-' + map, outing(state).actor.map === map && distance(state) <= 2, state.outing);
    }
    const visited = outing(state).fields.places;
    check('outing-records-native-display-names-in-order', visited.length === 4 && new Set(visited).size === 4, visited);
    state = await rpc('mine-enter', { floor: 0 }); const outside = outing(state).actor.map;
    await rpc('mine-level', { floor: 5 }); state = await observe(90);
    check('outing-waits-outside-dangerous-dungeon', outing(state).Together && outing(state).actor.map === outside, state.outing);
    await rpc('warp', { map: 'Mountain', x: 44, y: 18 }); state = await observe(90);
    check('outing-rejoins-on-a-different-safe-exit', outing(state).actor.map === 'Mountain' && distance(state) <= 2, state.outing);
    await rpc('warp', { map: 'BathHouse_Pool', x: 10, y: 15 }); state = await observe(30);
    check('outing-waits-outside-bathhouse-pool', outing(state).actor.map === 'Mountain', state.outing);
    await rpc('warp', { map: 'Beach', x: 33, y: 34 }); await observe(180);
    state = await rpc('outing-menu'); const paused = outing(state).actor;
    await rpc('outing-player', { x: 42, y: 34 }); state = await observe(180);
    check('outing-native-menu-pauses-following', outing(state).actor.x === paused.x && outing(state).actor.y === paused.y, state.outing);
    await rpc('outing-menu', { open: false }); state = await observe(240);
    check('outing-follows-again-after-menu-closes', distance(state) <= 3, state.outing);
    h.setReply('我们一起走了走。'); await h.say('Abigail', '我们刚才去了哪些地方？', 'outing-live-recall');
    check('outing-current-prompt-has-native-route', h.latestSystem().includes('你一直陪着农场主') && h.latestSystem().includes('鹈鹕镇'), h.latestSystem()); await h.close();
    // Vanilla excludes Farm from NPC schedule pathfinding, so this is a real unreachable return route.
    await rpc('warp', { map: 'Farm', x: 50, y: 25 }); state = await observe(150);
    const wire = h.wireCount(); await rpc('clock', { time: outing(state).Leave }); state = await observe(30);
    check('outing-leave-says-goodbye-before-releasing', outing(state).Bye > 0 && outing(state).actor.text === '我该回去了。', state.outing);
    const result = await ended('outing-expiry-reports-route-and-kept-meeting', wire); state = result.state;
    check('outing-no-native-return-path-waits-out-of-sight', outing(state).waitingForReturn && outing(state).actor.map === 'Farm', state.outing);
    await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 }); state = await observe(30);
    check('outing-return-fallback-waits-until-player-leaves', !outing(state).waitingForReturn && outing(state).actor.map === 'Town', state.outing);
    check('outing-expiry-restores-speed-and-collision', outing(state).actor.speed === 2 && !outing(state).actor.temporary && !outing(state).actor.pass, state.outing);
    check('outing-reliable-replay-makes-one-memory', await h.meetingEntries() === 1);
  }
  if (section === 'outing' || section === 'outing-activities') {
    let state = await prepare();
    const base = outing(state).fields;
    state = await rpc('outing-forage');
    check('outing-real-forage-pickup-is-observed', state.native?.picked === true && outing(state).fields.foraged === base.foraged + 1
      && outing(state).actor.CurrentEmote === state.outing!.icons.happy, state);
    await observe(200); state = await rpc('outing-artifact');
    check('outing-native-artifact-discovery-is-observed', outing(state).fields.artifacts === base.artifacts + 1
      && outing(state).actor.CurrentEmote === state.outing!.icons.surprise, state.outing);
    for (const [name, args, icon] of [
      ['catch', { fish: '128' }, 'happy'], ['escaped', { caught: false }, 'sad'],
      ['treasure', { fish: '129', treasure: true }, 'surprise'], ['legendary', { fish: '159', boss: true }, 'surprise'],
      ['perfect', { fish: '130', perfect: true }, 'surprise'],
    ] as const) {
      await observe(200); state = await rpc('outing-fish', args);
      check('outing-native-bobber-result-emote-' + name, outing(state).actor.CurrentEmote === state.outing!.icons[icon], state.outing);
    }
    check('outing-native-bobber-counts-and-three-name-limit', outing(state).fields.fish === 4 && outing(state).fields.escaped === 1
      && outing(state).fields.treasures === 1 && outing(state).fields.fishNames.length === 3, state.outing);
    const seen = { ...outing(state).fields };
    await rpc('mine-enter', { floor: 0 }); await rpc('mine-level', { floor: 5 });
    await rpc('outing-artifact'); state = await rpc('outing-fish');
    check('outing-does-not-count-fish-or-artifacts-out-of-sight', outing(state).fields.fish === seen.fish
      && outing(state).fields.artifacts === seen.artifacts, state.outing);
    await rpc('warp', { map: 'Beach', x: 33, y: 34 }); await observe(210);
    state = await rpc('outing-forage'); const recentEmote = outing(state).EmoteAfter;
    await rpc('outing-hold-gift'); state = await rpc('outing-give-gift');
    check('outing-gift-goes-through-native-counter-and-dialogue', state.native?.received === true
      && Number(state.native.after) === Number(state.native.before) + 1, state.native);
    const beforeClose = outing(state).EmoteAfter;
    state = await observe(10);
    check('outing-gift-reaction-waits-for-vanilla-dialogue', outing(state).EmoteAfter === beforeClose, state.outing);
    state = await rpc('action-close-menu');
    check('outing-gift-reaction-obeys-the-three-second-gap', state.outing!.tick < recentEmote
      && outing(state).EmoteAfter === recentEmote && outing(state).GiftEmote === state.outing!.icons.heart, state.outing);
    state = await observe(Math.max(10, recentEmote - state.outing!.tick + 10));
    check('outing-loved-gift-shows-native-heart-after-dialogue', outing(state).actor.CurrentEmote === state.outing!.icons.heart, state.outing);
    const last = outing(state).EmoteAfter;
    state = await rpc('outing-forage');
    check('outing-three-second-emote-throttle-keeps-counting', outing(state).EmoteAfter === last
      && outing(state).fields.foraged === seen.foraged + 2, state.outing);
    h.setReply('我看你钓鱼，也捡了采集物。'); await h.say('Abigail', '我们今天一起做了什么？', 'outing-activity-recall');
    check('outing-chat-prompt-has-only-observed-activity-counts', /钓到 4 条鱼/.test(h.latestSystem()) && /跑了 1 条/.test(h.latestSystem())
      && /钓到 1 个宝箱/.test(h.latestSystem()), h.latestSystem()); await h.close();
    await dismiss(); const result = await ended('outing-dismissal-reports-actual-activities', 0);
    await h.say('Abigail', '刚才是谁说先回去的？', 'outing-dismissal-recall');
    check('outing-dismissal-memory-retains-who-and-activities', outing(result.state).CalledOff && await h.meetingEntries() === 1
      && h.latestSystem().includes('后来农场主让我先回去了'), h.latestSystem()); await h.close();
  }
  if (section === 'outing' || section === 'outing-edges') {
    let state = await prepare({ enabled: false });
    check('outing-disabled-keeps-ordinary-wait', outing(state).Met && !outing(state).Together, state.outing);
    await rpc('warp', { map: 'Town', x: 50, y: 68 }); state = await observe(90);
    check('outing-disabled-does-not-follow-through-door', outing(state).actor.map === 'Beach', state.outing);
    state = await prepare({ arrive: 1030 });
    check('outing-fixed-clock-early-arrival-keeps-agreed-end', outing(state).Together && outing(state).Leave === 1230, state.outing);
    state = await prepare({ soon: true });
    check('outing-immediate-invitation-keeps-arrival-based-end', outing(state).Together && outing(state).Leave === 1140, state.outing);
    const wire = h.wireCount(); state = await dismiss();
    check('outing-early-dismissal-leaves-with-native-controller-released', outing(state).Reported && !outing(state).Together
      && !outing(state).actor.temporary, state.outing);
    check('outing-early-dismissal-keeps-only-one-report', h.packets('meet.ended', wire).filter(p => p.type === 'meet.ended').length === 1, h.packets('meet.ended', wire));
    state = await prepare(); await rpc('mine-enter', { floor: 0 }); await rpc('mine-level', { floor: 5 });
    await rpc('clock', { time: outing(state).Leave }); state = await observe(120);
    check('outing-expiry-while-player-underground-releases-and-reports', outing(state).Reported && !outing(state).Together
      && !outing(state).actor.temporary, state.outing);
  }
  if (section === 'outing' || section === 'outing-save') {
    await prepare(); await rpc('outing-forage'); await observe(210); await rpc('outing-fish');
    const wire = h.wireCount(); await rpc('sleep');
    check('outing-early-sleep-reports-before-native-save', h.packets('meet.ended', wire).some(p => !!p.outing && p.met === true), h.packets('meet.ended', wire));
    await rpc('title'); await rpc('load');
    h.setReply('记得一起逛，还看你钓鱼。'); await h.say('Abigail', '上次一起去了哪里？', 'outing-saved-recall');
    check('outing-save-reload-keeps-activity-memory', /我陪农场主/.test(h.latestSystem()) && /钓到 1 条鱼/.test(h.latestSystem()), h.latestSystem()); await h.close();
    await rpc('clock', { time: 1000 }); await rpc('action-reset');
    await rpc('action-place', { map: 'Desert', x: 10, y: 10, targetX: 11, targetY: 10, next: 2200 });
    await rpc('config', { NpcMeetings: true, NpcApproach: false, MeetingsGoTogether: true });
    h.setReply('你好。'); await rpc('talk-open', { npc: 'Abigail', keepFriendship: true });
    h.setReply('好啊，今天上午十一点海边见。');
    await rpc('talk-say', { text: '今天上午十一点海边见？', label: 'outing-unsaved-agreement' }); await h.close();
    let state = await observe(90);
    check('outing-unsaved-dialogue-creates-a-real-contract', state.actions!.meetings.some(m => m.Npc === 'Abigail'
      && m.Applied && !m.Failed && m.Place === '海滩'), state.actions);
    await rpc('clock', { time: 1100 }); await rpc('warp', { map: 'Beach', x: 33, y: 34 });
    await rpc('action-meeting-wait', { natural: true }); await observe(120); await rpc('outing-artifact'); await dismiss();
    await rpc('action-close-menu'); state = await observe(150);
    check('outing-unsaved-dismissal-really-reports-the-artifact', outing(state).Reported && outing(state).CalledOff
      && outing(state).fields.artifacts === 1, state.outing);
    h.setReply('刚才你挖到了古物。'); await h.say('Abigail', '刚才我挖到了什么？', 'outing-before-rollback');
    check('outing-unsaved-activity-is-readable-before-rollback', /挖到 1 件古物/.test(h.latestSystem()), h.latestSystem()); await h.close();
    await rpc('title'); state = await rpc('load');
    check('outing-unsaved-controller-is-not-persisted', !state.outing!.meetings.some(m => m.Together), state.outing);
    h.setReply('只记得保存过的那次。'); await h.say('Abigail', '刚才我挖到了什么古物？', 'outing-rolled-back-recall');
    check('outing-unsaved-activity-memory-rolls-back', !/挖到 1 件古物/.test(h.latestSystem()), h.latestSystem()); await h.close();
  }
  h.setReply(''); h.setMood(0);
}
