/** Live-model meeting acceptance in the disposable native World harness; fixed counterexamples are labelled apart. */
import type { FriendshipHost } from './game-meeting-friendship.ts';
import type { State } from './test-game-world.ts';

interface RealHost extends FriendshipHost {
  fixedModel(enabled: boolean): void;
  contentCheck(label: string, passed: boolean, detail: unknown): void;
  logMark(): number;
  settleNightly(from: number): Promise<void>;
  evidence(label: string, data: unknown): Promise<void>;
  transcript(label: string, text: string): Promise<void>;
}
const plan = (state: State, npc = 'Abigail') => state.actions!.meetings.find(item => item.Npc === npc);

export async function runRealMeetings(h: RealHost, section: string) {
  const { rpc, check, contentCheck } = h;
  const observe = (ticks = 60) => rpc('outing-observe', { ticks });
  const points = async () => Number((await rpc('friendship-inspect')).native!.points);
  async function prepare(label: string, npc = 'Abigail', day = 6, season = 'spring') {
    h.fixedModel(false); h.seedNight(false); h.setMood(0); h.setReply('');
    await h.chapter(season, day); await rpc('action-reset'); await rpc('clock', { time: 1000 });
    await rpc('action-place', { npc, map: 'Town', x: 50, y: 68, targetX: 47, targetY: 87, next: 2200, hearts: 8 });
    await rpc('config', { NpcMeetings: true, NpcInvites: false, NpcApproach: false, MeetingsGoTogether: false,
      MeetingsChangeFriendship: true, ChatChangesFriendship: false, BackstageScenes: false, OffscreenNews: false });
    const placed = await rpc('warp', { map: 'Town', x: 54, y: 68 });
    if (placed.eventUp) {
      await h.evidence(label + '-unrelated-fixture-story', { event: placed.festival?.id });
      await rpc('action-event-skip');
    }
    await rpc('meeting-test-clear-hud');
    console.log(`SCENE ${label}`);
    const state = await observe();
    check(label + '-fixture-is-outside-story', !state.eventUp, state.festival);
    return state;
  }
  async function talk(label: string, player: string, npc = 'Abigail', fixedReply?: string, fixedOpening = '你好。') {
    h.fixedModel(fixedReply !== undefined); h.setReply(fixedOpening);
    const opening = await rpc('talk-open', { npc, keepFriendship: true });
    h.setReply(fixedReply ?? '');
    const reply = await rpc('talk-say', { text: player, label });
    check(label + '-native-dialogue', !!reply.reply?.text, reply.reply);
    await h.transcript(label, `${fixedReply === undefined ? '真实模型' : '固定回复夹具'}\n\n- NPC 开场：${opening.reply?.text}\n- 玩家：${player}\n- NPC：${reply.reply?.text}`);
    await h.close(); await rpc('action-close-menu');
    const state = await observe();
    await h.evidence(label, { mode: fixedReply === undefined ? 'real' : 'fixed', player, opening: opening.reply, reply: reply.reply, state });
    return state;
  }
  async function expected(label: string, state: State, time: number, place: string, npc = 'Abigail', hudRequired = true) {
    const meeting = plan(state, npc);
    const ok = !!meeting && !meeting.Reported && meeting.Applied && !meeting.Failed && meeting.Time === time && meeting.Place === place;
    contentCheck(label + '-words-match-native-contract', ok, { wanted: { npc, time, place }, actual: meeting });
    // A saved tomorrow appointment is loaded as a daily list; the immediate toast is only for today's new/change event.
    if (ok && hudRequired) {
      const hud = (await rpc('mine-hud')).native?.hud as string[];
      check(label + '-native-hud-confirms-contract', hud.some(text => /约好|改到/.test(text) && text.includes(place)), hud);
      await rpc('capture', { name: `${label}-hud.png`, screen: true });
    }
    return ok;
  }
  async function arrive(label: string, state: State, npc = 'Abigail') {
    const meeting = plan(state, npc)!;
    await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 });
    if (!meeting.Warp) await rpc('action-schedule-due', { npc, time: meeting.Depart });
    else await rpc('clock', { time: Math.max(state.time, meeting.Time - 30) });
    state = await rpc('action-meeting-wait', { npc, natural: true });
    const reached = plan(state, npc)!;
    const actor = state.npcs!.find(item => item.id === npc);
    check(label + '-actual-native-arrival', reached.Arrived && actor?.location === reached.spot.map
      && actor.x === reached.spot.x && actor.y === reached.spot.y, { meeting: reached, actor });
    await rpc('clock', { time: meeting.Time });
    await rpc('warp', { map: reached.spot.map, x: reached.spot.x + 3, y: reached.spot.y });
    state = await observe(90);
    check(label + '-actual-player-meeting', plan(state, npc)!.Met, state.actions);
    await rpc('action-camera'); await rpc('capture', { name: `${label}-met.png`, screen: true });
    await h.evidence(label + '-arrival', state);
    return state;
  }
  async function finish(label: string, state: State, npc = 'Abigail') {
    const from = h.wireCount();
    await rpc('clock', { time: plan(state, npc)!.Leave }); state = await observe(120);
    check(label + '-native-end-is-reliable', plan(state, npc)!.Reported && h.packets('meet.ended', from)
      .some(item => item.npc === npc && item.met === true && !item.stoodUp), { actions: state.actions, packets: h.packets('meet.ended', from) });
    return state;
  }
  async function save(label: string) {
    h.fixedModel(false); const from = h.logMark(); await rpc('sleep'); await h.settleNightly(from);
    await rpc('title'); const state = await rpc('load');
    check(label + '-real-save-and-reload-ready', state.ready && state.canChat, state);
    return observe(90);
  }
  async function recall(label: string, npc: string, place: string, cancelled = false) {
    await talk(label, cancelled ? '昨天为什么没有去海边见面，你还记得吗？' : `昨天我们在${place}见到面了吗，你还记得吗？`, npc);
    const prompt = h.latestSystem();
    check(label + '-saved-fact-in-real-prompt', cancelled ? /后来农场主说不去了/.test(prompt)
      : prompt.includes(place) && /农场主来了/.test(prompt), prompt);
  }
  async function readyInvite(label: string) {
    // invite-fixture cleared the daily-list latch. Restore it by a real backend reconnection, not a synthetic list.
    const from = h.wireCount(); await h.restart(); let state = await observe(30);
    for (let attempt = 0; attempt < 30 && !state.invites?.meetingsArrived; attempt++) state = await observe(30);
    check(label + '-received-real-daily-list', state.invites?.meetingsArrived && h.dayMeetings(from).length > 0, state.invites);
    state = await rpc('invite-choose');
    check(label + '-production-selects-abigail', state.native?.selected === 'Abigail', state.invites);
    return state;
  }

  if (section !== 'real-meetings-edges') {
    await prepare('live-today');
    let state = await talk('live-today', '下午两点一起去墓地走走？');
    if (await expected('live-today', state, 1400, '墓地')) {
      state = await arrive('live-today', state); await finish('live-today', state);
      await save('live-today'); await recall('live-today-recall', 'Abigail', '墓地');
    }

    await prepare('live-tomorrow', 'Penny', 6);
    await talk('live-tomorrow', '明天上午十点博物馆见，可以吗？', 'Penny');
    state = await save('live-tomorrow');
    if (await expected('live-tomorrow', state, 1000, '博物馆', 'Penny', false)) {
      state = await arrive('live-tomorrow', state, 'Penny'); await finish('live-tomorrow', state, 'Penny');
    }

    state = await prepare('live-invite');
    const day = state.invites!.days.find(value => value >= 5 && value < 24)!;
    check('live-invite-has-real-calendar-draw', !!day, state.invites);
    await prepare('live-invite-day', 'Abigail', day); await rpc('invite-fixture');
    await rpc('action-place', { map: 'Town', x: 50, y: 68, targetX: 47, targetY: 87, next: 2200, hearts: 8 });
    await rpc('config', { NpcInvites: true, NpcApproach: true });
    state = await readyInvite('live-invite');
    await rpc('action-approach-start'); state = await rpc('action-approach-wait');
    check('live-invite-actually-walked-over', state.actions!.approach?.phase === 'Waiting', state.actions);
    const wire = h.wireCount();
    state = await talk('live-invite', '好啊，不过能晚一个小时吗？');
    check('live-invite-native-request-was-an-invitation', h.packets('talk.open', wire).at(-1)?.invite === true);
    let invited = plan(state);
    if (!invited) { state = await save('live-invite-next-day'); invited = plan(state); }
    contentCheck('live-invite-new-clock-produced-contract', !!invited && invited.Applied && !invited.Failed, state.actions);
    if (invited && !invited.Reported && invited.Applied && !invited.Failed && !invited.Festival) {
      state = await arrive('live-invite', state); await finish('live-invite', state);
    }

    await prepare('live-change');
    state = await talk('setup-live-change', '今天下午两点海边见？', 'Abigail', '好，下午两点海边见。');
    check('live-change-setup-really-created-original-contract', plan(state)?.Time === 1400, state.actions);
    await rpc('clock', { time: 1100 });
    state = await talk('live-change', '下午能改到三点吗？');
    if (await expected('live-change', state, 1500, '海滩')) {
      state = await arrive('live-change', state); await finish('live-change', state);
    }

    await prepare('live-cancel');
    state = await talk('setup-live-cancel', '今天下午两点海边见？', 'Abigail', '好，下午两点海边见。');
    check('live-cancel-setup-really-created-original-contract', plan(state)?.Time === 1400, state.actions);
    const before = await points();
    state = await talk('live-cancel', '下午的约我去不了了，抱歉。');
    check('live-cancel-native-plan-released', plan(state)?.Reported, state.actions);
    check('live-cancel-no-friendship-penalty', await points() === before);
    const hud = (await rpc('mine-hud')).native?.hud as string[];
    check('live-cancel-native-hud', hud.some(text => text.includes('约定取消了')), hud);
    await rpc('capture', { name: 'live-cancel-hud.png', screen: true });
    await save('live-cancel'); await recall('live-cancel-recall', 'Abigail', '海滩', true);

    await prepare('live-far'); const from = h.wireCount();
    state = await talk('live-far', '四天后一起去海边训练？');
    check('live-far-never-moves-native-npc', !plan(state), state.actions);
    check('live-far-no-confirming-hud', !((await rpc('mine-hud')).native?.hud as string[]).some(text => /约好.*海滩/.test(text)));
    check('live-far-real-prompt-requests-refusal', h.latestSystem().includes('4 天后'), h.latestSystem());
    await h.evidence('live-far-wire', h.dayMeetings(from));

    await prepare('live-festival', 'Abigail', 23);
    await talk('live-festival', '明天一起去花舞节吧？');
    check('live-festival-real-prompt-has-date-and-venue', /花舞节是明天.*森林河边.*9 点/.test(h.latestSystem()), h.latestSystem());
    state = await save('live-festival'); const festivalPlan = plan(state);
    contentCheck('live-festival-native-next-day-plan', festivalPlan?.Festival === 'spring24' && festivalPlan.Time === 900, state.actions);
    if (festivalPlan?.Festival === 'spring24') {
      const before = await points();
      state = await rpc('festival-open', { map: 'Forest', x: 1, y: 20, time: 1000 });
      check('live-festival-actual-cast-and-meeting', state.festival?.actors.includes('Abigail') && plan(state)!.Met, { festival: state.festival, actions: state.actions });
      await rpc('capture', { name: 'live-flower-dance.png', screen: true });
      const mark = h.wireCount(); await rpc('festival-leave'); await observe(90);
      check('live-festival-not-mistaken-for-no-show', !h.packets('meet.ended', mark).some(item => item.stoodUp)
        && await points() >= before, h.packets('meet.ended', mark));
    }
  }

  if (section !== 'real-meetings-live') {
    for (const row of [
      { id: 'edge-relative-invite', opening: '今天下午两点博物馆见，要不要一起？', player: '好啊，不过能晚一个小时吗？', reply: '好，下午四点博物馆见。' },
      { id: 'edge-explicit-period', opening: '今天晚上八点海边见，要不要一起？', player: '好啊，不过改到上午八点可以吗？', reply: '好，晚上八点海边见。' },
      { id: 'edge-relative-change', player: '今天的约往后推一个小时行吗？', reply: '好啊，下午五点海边见。', setup: true },
      { id: 'edge-negation', player: '今天下午两点一起去海边？', reply: '这不算好主意。' },
      { id: 'edge-other-cancel', player: '今天我不去吃了，下午两点海边照常见。', reply: '好。', setup: true },
    ]) {
      let state = await prepare(row.id); h.fixedModel(true);
      if (row.opening) {
        const day = state.invites!.days.find(value => value >= 5 && value < 24)!;
        await prepare(row.id + '-day', 'Abigail', day); await rpc('invite-fixture');
        await rpc('action-place', { map: 'Town', x: 50, y: 68, targetX: 47, targetY: 87, next: 2200 });
        await rpc('config', { NpcInvites: true }); await readyInvite(row.id);
      }
      if (row.setup) {
        state = await talk(row.id + '-setup', '今天下午两点海边见？', 'Abigail', '好，下午两点海边见。');
        check(row.id + '-original-contract-established', plan(state)?.Time === 1400, state.actions);
      }
      const from = h.wireCount();
      state = await talk(row.id, row.player, 'Abigail', row.reply, row.opening);
      if (row.opening) check(row.id + '-native-opening-is-an-invitation', h.packets('talk.open', from).at(-1)?.invite === true);
      const current = plan(state);
      check(row.id + '-native-contract-is-safe', row.setup ? current?.Time === 1400 && !current.Reported : !current, state.actions);
      const hud = (await rpc('mine-hud')).native?.hud as string[];
      check(row.id + '-no-false-native-hud', row.setup ? !hud.some(text => /取消了|改到/.test(text)) : !hud.some(text => /约好|改到/.test(text)), hud);
      await h.evidence(row.id + '-final', { actions: state.actions, hud });
    }
  }
  h.fixedModel(false); h.setReply('');
}
