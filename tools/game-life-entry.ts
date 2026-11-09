/** Native vanilla-dialogue transitions, outer life entries and ordinary gift separation. */
import assert from 'node:assert/strict';
import type { State } from './test-game-world.ts';
import { stageLife } from './game-life-fixture.ts';

interface EntryHost {
  rpc(operation: string, args?: Record<string, unknown>): Promise<State>;
  chapter(season: string, day: number): Promise<State>;
  check(label: string, passed: unknown, detail?: unknown): void;
  close(): Promise<void>; setReply(text: string): void;
  packets(type: string, from?: number): Record<string, unknown>[]; wireCount(): number;
  disconnect(): Promise<void>; reconnect(): Promise<void>;
  evidence(label: string, data: unknown): Promise<void>;
}
interface EntryMenu { text: string; question: boolean; speaker: string | null; owned: boolean; choices: string[] }
interface EntryRelationship { points: number; giftsToday: number }
const life = (s: State) => { assert.ok(s.life, 'Missing native life snapshot'); return s.life; };
const menu = (s: State) => life(s).menu as EntryMenu | null;
const choices = (s: State) => menu(s)?.choices ?? [];
const relationship = (s: State, npc: string) => life(s).friendship[npc] as EntryRelationship;
const count = (s: State, id: string) => life(s).inventory.filter(item => item.id === id).reduce((total, item) => total + item.count, 0);

export async function runLifeEntry(h: EntryHost) {
  const { rpc, check } = h;
  const choose = (text: string) => rpc('life-choose', { text });
  const observe = (ticks = 45) => rpc('life-observe', { ticks, clock: false });
  async function synced(label: string) {
    let s = await rpc('life-snapshot');
    const deadline = Date.now() + 20000;
    while (!life(s).ready && Date.now() < deadline) s = await observe(30);
    check(label + '-synced', life(s).ready && life(s).supported && !life(s).corrupt, life(s));
    return s;
  }
  async function prepare(npc: string, args: Record<string, unknown> = {}) {
    await h.chapter('spring', 6); await rpc('action-reset');
    await rpc('config', { OfferContinueChat: true, SharedGoals: true, LifeActivities: true, LifeSocial: true,
      NpcMeetings: true, MeetingsGoTogether: true, NpcInvites: false, NpcApproach: false,
      BackstageScenes: false, OffscreenNews: false, SendLetters: false, ChatChangesFriendship: false });
    let s = await stageLife(h, { npc, hearts: 8, time: 900, map: 'Forest', x: 60, y: 30, clearItems: true, ...args });
    if (s.eventUp) {
      await h.evidence('entry-fixture-unrelated-story', s.festival); await rpc('action-event-skip');
      s = await stageLife(h, { npc, map: 'Forest', x: 60, y: 30, ...args });
    }
    check('entry-fixture-no-story-' + npc, !s.eventUp, s.festival);
    h.setReply('我们可以继续聊聊。');
    return synced('entry-' + npc);
  }
  async function outer(npc: string, label: string) {
    const before = h.wireCount();
    const native = await rpc('life-vanilla-open', { npc });
    check(label + '-actual-vanilla-dialogue-first', menu(native)?.speaker === npc && !menu(native)?.owned
      && !menu(native)?.question && !!menu(native)?.text, menu(native));
    const s = await rpc('life-vanilla-finish', { npc });
    check(label + '-native-close-opens-offer', !!menu(s)?.question && !menu(s)?.speaker
      && Number(s.native?.clicks) > 0, { menu: menu(s), native: s.native });
    check(label + '-no-model-call-before-chat-selection', h.packets('talk.open', before).length === 0);
    return s;
  }

  for (const [npc, goalLabel] of [['Leah', '浮木的事'], ['Willy', '材料与共同目标'], ['Maru', '材料与共同目标'], ['Penny', '']] as const) {
    await prepare(npc);
    let s = await outer(npc, 'outer-' + npc);
    const expected = ['继续聊', ...(goalLabel ? [goalLabel] : []), '一起做点事', '离开'];
    check('outer-' + npc + '-exact-entry-options', JSON.stringify(choices(s)) === JSON.stringify(expected), choices(s));
    if (goalLabel) {
      s = await choose(goalLabel);
      check('outer-' + npc + '-routes-to-real-goal-menu', choices(s).includes('我来帮忙') && choices(s).includes('以后再说'), menu(s));
      await choose('以后再说'); s = await synced('outer-decline-' + npc);
      check('outer-' + npc + '-viewing-menu-does-not-accept', !Object.keys(life(s).goals).length && !life(s).events.length, life(s));
    } else {
      s = await choose('一起做点事');
      check('outer-nongoal-npc-routes-to-activity-menu', choices(s).some(text => text.startsWith('去森林散步')), menu(s));
    }
    await rpc('life-close'); await h.evidence('outer-entry-' + npc, s);
  }

  await prepare('Leah'); await outer('Leah', 'outer-chat');
  const chatFrom = h.wireCount(); let s = await choose('继续聊');
  const chatDeadline = Date.now() + 20000;
  while (!s.reply?.text && Date.now() < chatDeadline) s = await observe(30);
  check('outer-chat-starts-one-real-bridge-request', h.packets('talk.open', chatFrom).length === 1
    && s.reply?.npc === 'Leah' && !!s.reply.text && menu(s)?.owned, { packets: h.packets('talk.open', chatFrom), reply: s.reply, menu: menu(s) });
  await h.close(); await rpc('life-close');

  for (const [npc, goal, id, needed] of [
    ['Leah', 'leah-driftwood-v1', '(O)169', 3], ['Willy', 'willy-catfish-v1', '(O)143', 1], ['Maru', 'maru-copper-v1', '(O)334', 1],
  ] as const) {
    await prepare(npc, { items: [{ id, count: needed + 1, slot: 0 }] });
    await rpc('life-menu', { npc, kind: 'goal' }); await choose('我来帮忙'); const before = await synced('gift-accepted-' + npc);
    s = await rpc('life-gift', { npc, slot: 0 });
    check('gift-' + npc + '-vanilla-consumption-and-gift-count', s.native?.received === true && count(s, id) === needed
      && relationship(s, npc).giftsToday === relationship(before, npc).giftsToday + 1, { native: s.native, life: life(s) });
    check('gift-' + npc + '-does-not-deliver-goal', life(s).goals[goal]?.stage === 'collecting'
      && !life(s).events.some(event => event.kind === 'goal.delivered'), life(s));
    await rpc('life-vanilla-finish', { npc });
    await choose(npc === 'Leah' ? '浮木的事' : '材料与共同目标');
    check('gift-' + npc + '-still-demands-full-materials', choices(await rpc('life-snapshot')).some(text => text.includes(`交付 ${needed} 份`)));
    await choose('交付'); s = await synced('gift-explicit-delivery-' + npc);
    check('gift-' + npc + '-dedicated-delivery-keeps-gift-count', count(s, id) === 0 && life(s).goals[goal]?.stage === 'ready'
      && relationship(s, npc).giftsToday === relationship(before, npc).giftsToday + 1
      && life(s).events.filter(event => event.kind === 'goal.delivered').length === 1, life(s));
    await h.evidence('ordinary-gift-' + npc, s);
  }

  await prepare('Leah'); await rpc('life-menu', { npc: 'Leah', kind: 'activity' }); await choose('去森林散步');
  s = await synced('outer-offline-start'); check('outer-offline-has-current-activity', life(s).activity?.activity === 'forest_walk', life(s));
  const starts = life(s).starts;
  await h.disconnect(); s = await outer('Leah', 'outer-offline');
  check('outer-offline-only-end-or-leave', JSON.stringify(choices(s)) === JSON.stringify(['结束当前活动', '离开']), menu(s));
  s = await choose('结束当前活动');
  check('outer-offline-routes-to-existing-exit', choices(s).includes('今天先回去') && choices(s).includes('继续')
    && !choices(s).some(text => /做饭|采集|道歉|分享/.test(text)), menu(s));
  await choose('今天先回去'); s = await observe();
  check('outer-offline-exit-releases-without-new-actions', !life(s).activity && life(s).starts === starts
    && life(s).events.filter(event => event.kind === 'activity.cancelled').length === 1
    && !life(s).events.some(event => event.kind === 'activity.completed' || event.kind === 'activity.missed'), life(s));
  await h.reconnect(); s = await synced('outer-offline-reconnect');
  check('outer-offline-cancellation-stays-single', life(s).events.filter(event => event.kind === 'activity.cancelled').length === 1, life(s));
  await h.evidence('outer-offline-exit', s);
}
