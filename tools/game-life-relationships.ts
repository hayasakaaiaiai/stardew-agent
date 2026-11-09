/** Native appointment absence, apology and earned repair; no synthetic life events. */
import assert from 'node:assert/strict';
import type { State } from './test-game-world.ts';
import { stageLife } from './game-life-fixture.ts';
import type { LifeState } from './game-life.ts';

export interface LifeRelationshipHost {
  rpc(operation: string, args?: Record<string, unknown>): Promise<State>;
  chapter(season: string, day: number, rain?: boolean, year?: number): Promise<State>;
  check(label: string, passed: unknown, detail?: unknown): void;
  close(): Promise<void>; latestSystem(): string; setReply(text: string): void;
  packets(type: string, from?: number): Record<string, unknown>[]; wireCount(): number;
  evidence(label: string, data: unknown): Promise<void>;
}
type NativeLife = LifeState & { entries: Record<string, { grievance: string | null; share: string | null }> };
const life = (state: State): NativeLife => { assert.ok(state.life); return state.life as NativeLife; };

export async function runLifeRelationships(h: LifeRelationshipHost) {
  const { rpc, check } = h, npc = 'Abigail';
  const observe = (ticks = 45, clock = false) => rpc('life-observe', { ticks, clock });
  const menu = (kind: string) => rpc('life-menu', { npc, kind });
  const choose = (text: string) => rpc('life-choose', { text });
  const events = (state: State, kind: string) => life(state).events.filter(event => event.npc === npc.toLowerCase() && event.kind === kind);
  async function synced(label: string) {
    let state = await rpc('life-snapshot'); const deadline = Date.now() + 20000;
    while ((!life(state).ready || !state.canChat) && Date.now() < deadline) state = await observe();
    check(label + '-synchronized', life(state).supported && life(state).ready && state.canChat && !life(state).corrupt, life(state));
    return state;
  }
  async function prompt(label: string) {
    h.setReply('我会记住实际发生的事，也希望以后的约定认真对待。');
    await rpc('talk-open', { npc, keepFriendship: true });
    await rpc('talk-say', { text: '刚才的失约和道歉，你现在怎么看？', label });
    const system = h.latestSystem(); await h.close(); return system;
  }

  await h.chapter('spring', 6); await rpc('action-reset');
  await rpc('config', { SharedGoals: true, LifeActivities: true, LifeSocial: true, NpcMeetings: true,
    MeetingsGoTogether: true, MeetingsChangeFriendship: true, ChatChangesFriendship: false,
    NpcApproach: false, NpcInvites: false, BackstageScenes: false, OffscreenNews: false });
  await rpc('clock', { time: 1000 });
  await rpc('action-place', { npc, map: 'Town', x: 50, y: 68, targetX: 47, targetY: 87, next: 2200, hearts: 9 });
  await rpc('warp', { map: 'Town', x: 51, y: 68 });
  let state = await synced('relationship-initial');
  const initial = life(state).friendship[npc]!.points;
  await menu('apology'); state = await observe();
  check('relationship-no-grievance-no-apology-menu', !life(state).menu && !events(state, 'relationship.apology').length, life(state));

  // The agreement goes through fixed dialogue and the real backend parser. Movement and absence are native.
  h.setReply('你好。'); await rpc('talk-open', { npc, keepFriendship: true });
  h.setReply('好啊，今天下午三点墓地见。');
  await rpc('talk-say', { text: '今天下午三点墓地见？', label: 'life-repair-agreement' });
  await h.close(); state = await rpc('wait', { ticks: 60 });
  const plan = state.actions?.meetings.find(meeting => meeting.Npc === npc);
  check('relationship-dialogue-creates-native-appointment', plan?.Applied && !plan.Failed, state.actions);
  assert.ok(plan);
  await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 });
  const wire = h.wireCount();
  if (plan.Warp) {
    await rpc('clock', { time: 1500 }); await rpc('action-meeting-wait', { npc, speed: 8 });
  } else {
    await rpc('action-schedule-due', { npc, time: plan.Depart }); await rpc('clock', { time: 1500 });
    await rpc('action-route-wait', { npc, time: plan.Depart, speed: 8 });
  }
  state = await rpc('wait', { ticks: 60 });
  const arrived = state.actions!.meetings.find(meeting => meeting.Npc === npc)!;
  check('relationship-npc-arrived-with-player-absent', arrived.Arrived && arrived.ArrivedAt === 1500 && !arrived.Met, arrived);
  await rpc('clock', { time: arrived.Leave }); state = await rpc('wait', { ticks: 90 }); state = await synced('relationship-missed');
  const missed = events(state, 'activity.missed');
  const ended = h.packets('meet.ended', wire).find(packet => String(packet.npc).toLowerCase() === npc.toLowerCase());
  check('relationship-real-no-show-creates-one-miss', missed.length === 1 && ended?.stoodUp === true && ended.met === false, { missed, ended });
  check('relationship-miss-does-not-double-charge-friendship', life(state).friendship[npc]!.points - initial === Number(ended?.friendship ?? 0), { initial, friendship: life(state).friendship[npc], ended });
  const missedPrompt = await prompt('life-missed-prompt');
  check('relationship-prompt-knows-real-disappointment', /当前心情：失落/.test(missedPrompt) && /实际失约让你对承诺仍有顾虑/.test(missedPrompt), missedPrompt);

  await stageLife(h, { npc, map: 'Forest', x: 60, y: 30 });
  state = await synced('relationship-before-apology'); const pointsBefore = life(state).friendship[npc]!.points;
  await menu('apology'); await choose('对不起'); state = await synced('relationship-apology');
  const apologies = events(state, 'relationship.apology');
  check('relationship-native-apology-binds-real-miss', apologies.length === 1 && apologies[0]!.sourceId === missed[0]!.id, apologies);
  check('relationship-apology-does-not-grant-friendship', life(state).friendship[npc]!.points === pointsBefore, life(state).friendship[npc]);
  const apologyPrompt = await prompt('life-apology-prompt');
  check('relationship-apology-still-requires-action', /当前心情：缓和/.test(apologyPrompt) && /关系修复还要看之后的实际行动/.test(apologyPrompt), apologyPrompt);
  await menu('apology'); await rpc('life-close'); state = await synced('relationship-repeated-apology');
  check('relationship-same-day-apology-does-not-repeat', events(state, 'relationship.apology').length === 1 && life(state).friendship[npc]!.points === pointsBefore, life(state));

  await menu('activity'); await choose('去森林散步'); state = await observe();
  check('relationship-repair-requires-real-start', life(state).activity?.activity === 'forest_walk' && life(state).activity?.npc === npc, life(state));
  const deadline = Date.now() + 100000;
  while (life(state).activity && life(state).activity!.minutes < 30 && Date.now() < deadline) {
    state = await observe(120, true);
    check('relationship-repair-no-unexpected-menu', !life(state).menuType,
      { menu: life(state).menuType, dialogue: life(state).menu, activity: life(state).activity });
  }
  state = await observe(1, false);
  check('relationship-repair-has-real-company-minutes', Number(life(state).activity?.minutes) >= 30, life(state));
  await menu('activity'); await choose('结束这次活动'); state = await synced('relationship-repaired');
  check('relationship-real-completion-clears-native-grievance', events(state, 'activity.completed').some(event => event.activity === 'forest_walk' && Number(event.minutes) >= 30)
    && life(state).entries[npc]?.grievance === null, life(state));
  const repairedPrompt = await prompt('life-repaired-prompt');
  check('relationship-repair-enters-backend-context', /当前心情：释然/.test(repairedPrompt)
    && !/关系修复还要看之后的实际行动|实际失约让你对承诺仍有顾虑/.test(repairedPrompt), repairedPrompt);
  await stageLife(h, { npc, map: 'Forest', x: 60, y: 30 }); await menu('apology'); state = await observe();
  check('relationship-repaired-has-no-new-apology', !life(state).menu && events(state, 'relationship.apology').length === 1, life(state));
  await h.evidence('life-real-miss-apology-repair', { state, ended, missedPrompt, apologyPrompt, repairedPrompt });
}

/** All six supported pairs hear only an actual public cooking result, after explicit native confirmation. */
export async function runLifeFriendPairs(h: LifeRelationshipHost) {
  const { rpc, check } = h;
  async function synced(label: string) {
    let state = await rpc('life-snapshot'); const deadline = Date.now() + 20000;
    while ((!life(state).ready || !state.canChat) && Date.now() < deadline)
      state = await rpc('life-observe', { ticks: 30, clock: false });
    check(label + '-synchronized', life(state).supported && life(state).ready && state.canChat && !life(state).corrupt, life(state));
    return state;
  }
  for (const [speaker, listener] of [['Leah', 'Elliott'], ['Sam', 'Sebastian'], ['Sam', 'Abigail'],
    ['Sebastian', 'Abigail'], ['Maru', 'Penny'], ['Emily', 'Sandy']] as const) {
    const label = `life-friends-${speaker}-${listener}`;
    await h.chapter('spring', 6); await rpc('action-reset');
    await rpc('config', { LifeActivities: true, LifeSocial: true, NpcMeetings: true, MeetingsGoTogether: true,
      NpcApproach: false, NpcInvites: false, BackstageScenes: false, OffscreenNews: false });
    await stageLife(h, { npc: speaker, time: 1000, hearts: 8, kitchen: true, map: 'FarmHouse', x: 4, y: 5,
      clearItems: true, items: [{ id: '(O)176', count: 2, slot: 0 }] });
    await rpc('life-menu', { npc: speaker, kind: 'activity' }); await rpc('life-choose', { text: '一起做饭' });
    await rpc('life-cook', { recipe: 'Fried Egg' }); await rpc('life-close');
    let state = await synced(label + '-cooking');
    const source = life(state).events.find(event => event.npc === speaker.toLowerCase() && event.kind === 'activity.completed' && event.activity === 'cooking');
    check(label + '-public-source-is-real-cooking', source?.count === 1 && !life(state).activity, life(state));
    await stageLife(h, { npc: speaker, map: 'FarmHouse', x: 4, y: 5 });
    await rpc('place', { npc: listener, map: 'FarmHouse', x: 6, y: 5, hearts: 8 });
    await rpc('life-menu', { npc: speaker, kind: 'share' }); await rpc('life-choose', { text: '一起聊聊' });
    state = await synced(label + '-shared');
    const shared = life(state).events.filter(event => event.kind === 'social.shared');
    check(label + '-source-and-listener-identity', shared.length === 1 && shared[0]!.npc === speaker.toLowerCase()
      && shared[0]!.other === listener.toLowerCase() && shared[0]!.sourceId === source!.id, shared);
    await rpc('life-menu', { npc: speaker, kind: 'share' }); state = await rpc('life-observe', { ticks: 45 });
    check(label + '-same-source-does-not-repeat', life(state).events.filter(event => event.kind === 'social.shared').length === 1 && !life(state).menu, life(state));
    await h.evidence(label, state);
  }
}
