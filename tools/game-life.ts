/** Disposable native-game life acceptance. Fixed dialogue is evidence transport, not model evaluation. */
import assert from 'node:assert/strict';
import type { State } from './test-game-world.ts';
import { stageLife } from './game-life-fixture.ts';
import { runLifeRelationships, runLifeFriendPairs } from './game-life-relationships.ts';
import { runLifeEntry } from './game-life-entry.ts';

interface LifeEvent { id: string; npc: string; kind: string; activity?: string; goal?: string; count?: number; minutes?: number; other?: string; sourceId?: string; friendship?: number }
interface Goal { stage: string; deliveredDay?: number | null }
export interface LifeState {
  supported: boolean; ready: boolean; corrupt: boolean; events: LifeEvent[];
  menuType: string | null; windowMinimized: boolean | null;
  goals: Record<string, Goal>; letters: { key: string; text: string; sent: boolean }[];
  activity: { npc: string; activity: string; minutes: number; count: number; goal?: string | null; wholeInterval: boolean } | null;
  starts: number; inventory: { id: string; count: number; slot: number }[];
  friendship: Record<string, { points: number; giftsToday: number }>; menu: { choices: string[] } | null; mailbox: string[];
}
interface LifeHost {
  rpc(operation: string, args?: Record<string, unknown>): Promise<State>;
  chapter(season: string, day: number, rain?: boolean, year?: number): Promise<State>;
  check(label: string, passed: unknown, detail?: unknown): void;
  say(npc: string, text: string, label: string): Promise<State>;
  close(): Promise<void>; latestSystem(): string; setReply(text: string): void;
  packets(type: string, from?: number): Record<string, unknown>[]; wireCount(): number;
  disconnect(): Promise<void>; reconnect(): Promise<void>; memoryLifeRows(): string[];
  evidence(label: string, data: unknown): Promise<void>;
}
const life = (s: State) => { assert.ok(s.life, 'Native life snapshot is missing'); return s.life; };
const count = (s: State, id: string) => life(s).inventory.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
const events = (s: State, kind: string, npc?: string) => life(s).events.filter(e => e.kind === kind && (!npc || e.npc === npc.toLowerCase()));

export async function runLife(h: LifeHost, section: string) {
  const { rpc, check } = h;
  const observe = (ticks = 45, clock = false) => rpc('life-observe', { ticks, clock });
  const choose = (text: string) => rpc('life-choose', { text });
  const menu = (npc: string, kind = 'goal') => rpc('life-menu', { npc, kind });
  async function synced(label: string) {
    let s = await rpc('life-snapshot'); const deadline = Date.now() + 20000;
    while (!life(s).ready && Date.now() < deadline) s = await observe(30);
    check(label + '-life-synchronized', life(s).supported && life(s).ready && !life(s).corrupt, life(s));
    return s;
  }
  async function prepare(npc = 'Leah', args: Record<string, unknown> = {}) {
    await h.chapter('spring', 6); await rpc('action-reset');
    await rpc('config', { SharedGoals: true, LifeActivities: true, LifeSocial: true, NpcMeetings: true,
      MeetingsGoTogether: true, MeetingsChangeFriendship: true, NpcInvites: false, NpcApproach: false,
      BackstageScenes: false, OffscreenNews: false, SendLetters: false, ChatChangesFriendship: false });
    let setup = await stageLife(h, { npc, hearts: 8, time: 900, map: 'Forest', x: 60, y: 30, clearItems: true, ...args });
    if (setup.eventUp) {
      await h.evidence('fixture-unrelated-story', setup.festival); await rpc('action-event-skip');
      setup = await stageLife(h, { npc, map: 'Forest', x: 60, y: 30, ...args });
    }
    check('fixture-no-active-story-' + npc, !setup.eventUp, setup.festival);
    h.setReply('我记得我们实际一起做过的事。');
    return synced('prepare-' + npc);
  }
  async function accept(npc: string, goal: string) {
    let s = await menu(npc);
    check(npc + '-native-accept-choice', (life(s).menu?.choices ?? []).some(c => c.includes('我来帮忙')), (life(s).menu?.choices ?? []));
    await choose('我来帮忙'); s = await synced(npc + '-accept');
    check(npc + '-accepted-once', life(s).goals[goal]?.stage === 'collecting' && events(s, 'goal.accepted', npc).length === 1, life(s));
    return s;
  }
  async function deliver(npc: string, goal: string, id: string, amount: number) {
    const before = await rpc('life-snapshot'); await menu(npc); await choose('交付');
    const s = await synced(npc + '-deliver');
    check(npc + '-native-material-deduction', count(before, id) - count(s, id) === amount && life(s).goals[goal]?.stage === 'ready', life(s));
    check(npc + '-delivery-does-not-use-gift-count', life(s).friendship[npc]?.giftsToday === life(before).friendship[npc]?.giftsToday, life(s).friendship[npc]);
    check(npc + '-one-delivery-fact', events(s, 'goal.delivered', npc).length === 1, life(s).events);
    return s;
  }
  async function minutes(target: number, label: string) {
    let s = await rpc('life-snapshot'); const deadline = Date.now() + 100000;
    while (life(s).activity && life(s).activity!.minutes < target && Date.now() < deadline) {
      s = await observe(120, true);
      if (life(s).menuType) check(label + '-unexpected-menu-during-natural-clock', false, { menu: life(s).menuType, dialogue: life(s).menu, activity: life(s).activity });
    }
    await observe(1, false);
    check(label + '-natural-clock-minutes', !!life(s).activity && life(s).activity!.minutes >= target, life(s));
    return s;
  }
  async function finish(npc: string, label: string) {
    const before = await rpc('life-snapshot'); const activity = life(before).activity; const prior = events(before, 'activity.completed', npc).length;
    await menu(npc, 'activity'); await choose('结束这次活动'); const s = await synced(label);
    check(label + '-released-actor-and-completion', !life(s).activity && events(s, 'activity.completed', npc).length === prior + 1 && events(s, 'activity.completed', npc).at(-1)?.activity === activity?.activity, life(s));
    const actor = s.npcs?.find(candidate => candidate.id === npc);
    check(label + '-native-control-and-speed-restored', actor && !actor.temporary && actor.speed === 2 && actor.destroys, actor);
    return s;
  }
  async function goalStart(npc: string, goal: string) {
    await menu(npc); await choose('现在一起去'); const s = await observe();
    check(npc + '-goal-start-binds-attempt', life(s).goals[goal]?.stage === 'walking' && life(s).activity?.goal?.startsWith(goal + '@'), life(s));
    return s;
  }
  if (section === 'life' || section === 'life-goals') {
    for (const [npc, goal, id, amount, duration] of [
      ['Leah', 'leah-driftwood-v1', '(O)169', 3, 30], ['Willy', 'willy-catfish-v1', '(O)143', 1, 20], ['Maru', 'maru-copper-v1', '(O)334', 1, 30],
    ] as const) {
      console.log('SCENE life-goal-' + npc);
      await prepare(npc, { items: [{ id, count: Math.max(1, amount - 1), slot: 0 }] }); await accept(npc, goal);
      if (amount > 1) {
        await menu(npc); await choose('交付'); let s = await synced(npc + '-insufficient');
        check(npc + '-insufficient-keeps-items-and-stage', count(s, id) === 2 && life(s).goals[goal]?.stage === 'collecting' && !events(s, 'goal.delivered').length, life(s));
        await stageLife(h, { npc, items: [{ id, count: 2, slot: 0 }, { id, count: 2, slot: 1 }], clearItems: true });
      }
      await deliver(npc, goal, id, amount);
      await h.say(npc, '材料交了吗，后面的活动完成了吗？', npc + '-ready-prompt');
      check(npc + '-prompt-has-pending-goal', h.latestSystem().includes('共同目标') && /未完成|待同行|尚未|还没有|还没/.test(h.latestSystem()), h.latestSystem()); await h.close();
      await stageLife(h, { npc, map: 'Forest', x: 60, y: 30 }); await goalStart(npc, goal);
      if (npc === 'Willy') { await rpc('outing-fish', { fish: '128' }); await rpc('life-close'); await observe(); }
      await minutes(duration, npc); const s = await finish(npc, npc + '-goal-finish');
      check(npc + '-goal-completed-with-one-letter', life(s).goals[goal]?.stage === 'completed' && events(s, 'goal.completed', npc).length === 1 && life(s).letters.length === 1, life(s));
      check(npc + '-no-material-reward', count(s, id) === (amount === 3 ? 1 : 0), life(s).inventory);
      await menu(npc); check(npc + '-cannot-repeat-completed-goal', !(life(await rpc('life-snapshot')).menu?.choices ?? []).some(c => /我来帮忙|交付/.test(c))); await rpc('life-close');
      await h.evidence('goal-' + npc, s);
    }
    await prepare(); await accept('Leah', 'leah-driftwood-v1'); await menu('Leah'); await choose('先到这里'); await choose('结束目标');
    let s = await synced('close-without-material');
    check('unpaid-close-no-letter-no-loss', life(s).goals['leah-driftwood-v1']?.stage === 'closed' && !life(s).letters.length && !events(s, 'activity.missed').length, life(s));
    await prepare('Leah', { items: [{ id: '(O)169', count: 3, slot: 0 }] }); await accept('Leah', 'leah-driftwood-v1'); await deliver('Leah', 'leah-driftwood-v1', '(O)169', 3);
    await menu('Leah'); await choose('先到这里'); await choose('结束目标'); s = await synced('material-ending');
    check('material-ending-does-not-invent-walk', life(s).goals['leah-driftwood-v1']?.stage === 'closed' && life(s).letters.length === 1 && !life(s).letters[0]!.text.includes('林子里走走') && !events(s, 'activity.completed').length, life(s));
  }
  if (section === 'life' || section === 'life-activities' || section === 'life-family') {
    if (section !== 'life-family') for (const [npc, activity, choice, duration, native] of [
      ['Leah', 'forest_walk', '去森林散步', 30, ''], ['Leah', 'foraging', '一起采集', 20, 'life-forage'],
      ['Willy', 'fishing', '陪我钓鱼', 20, 'outing-fish'], ['Leah', 'spouse_walk', '一起出门走走', 30, ''],
    ] as const) {
      await prepare(npc, { spouse: activity === 'spouse_walk' }); await menu(npc, 'activity'); await choose(choice);
      let s = await observe(); check(activity + '-native-start', life(s).activity?.activity === activity && life(s).starts === 1, life(s));
      if (native) { await rpc(native); await rpc('life-close'); await observe(); }
      await minutes(duration, activity); s = await finish(npc, activity);
      const e = events(s, 'activity.completed', npc).at(-1)!;
      check(activity + '-objective-outcome', e.activity === activity && Number(e.minutes) >= duration && (!native || Number(e.count) >= 1), e);
      await stageLife(h, { npc, map: 'Forest', x: 60, y: 30, spouse: activity === 'spouse_walk' });
      await menu(npc, 'activity'); await choose(choice); s = await observe();
      check(activity + '-same-day-repeat-rejected', !life(s).activity && life(s).starts === 1, life(s)); await rpc('life-close');
      if (activity === 'forest_walk') {
        await stageLife(h, { npc, items: [{ id: '(O)169', count: 3, slot: 0 }], clearItems: true });
        await accept(npc, 'leah-driftwood-v1'); await deliver(npc, 'leah-driftwood-v1', '(O)169', 3);
        await menu(npc); await choose('现在一起去'); s = await observe();
        check('story-cannot-repeat-todays-successful-walk', !life(s).activity && life(s).goals['leah-driftwood-v1']?.stage === 'ready' && life(s).starts === 1 && count(s, '(O)169') === 0, life(s)); await rpc('life-close');
      }
      await h.evidence(activity, s);
    }
    await prepare('Leah', { kitchen: true, map: 'FarmHouse', x: 4, y: 5, items: [{ id: '(O)176', count: 2, slot: 0 }] });
    await menu('Leah', 'activity'); await choose('一起做饭'); let s = await observe();
    check('cooking-native-kitchen-opened', life(s).activity?.activity === 'cooking', s);
    await rpc('life-cook', { recipe: 'Fried Egg' }); await observe(); await rpc('life-close'); s = await synced('cooking');
    check('cooking-consumes-egg-produces-meal', count(s, '(O)176') === 1 && count(s, '(O)194') === 1 && events(s, 'activity.completed', 'Leah').some(e => e.activity === 'cooking' && e.count === 1), life(s));
    for (const [npc, roommate] of [['Leah', false], ['Krobus', true]] as const) {
      await prepare(npc, { spouse: !roommate, roommate, kitchen: true, map: 'FarmHouse', x: 4, y: 5, items: [{ id: '(O)194', count: 2, slot: 0 }] });
      const before = await rpc('life-snapshot'); await menu(npc, 'dinner'); await choose('分享'); await rpc('life-close'); s = await synced('dinner-' + npc);
      check(npc + '-dinner-consumes-one-no-friendship', count(s, '(O)194') === 1 && events(s, 'activity.completed', npc).some(e => e.activity === 'home_dinner' && e.friendship === 0) && life(s).friendship[npc]?.points === life(before).friendship[npc]?.points, life(s));
      await menu(npc, 'dinner'); await rpc('life-close'); s = await observe(); check(npc + '-dinner-repeat-no-consumption', count(s, '(O)194') === 1 && life(s).starts === 1, life(s));
    }
  }
  if (section === 'life' || section === 'life-social') {
    await prepare(); await menu('Leah', 'activity'); await choose('去森林散步'); await minutes(30, 'public-sharing'); await finish('Leah', 'public-sharing');
    await stageLife(h, { npc: 'Leah', map: 'Forest', x: 60, y: 30 }); await rpc('place', { npc: 'Elliott', map: 'Forest', x: 62, y: 30, hearts: 8 });
    await menu('Leah', 'share'); await choose('这次不说'); let s = await synced('share-cancel'); check('share-cancel-no-heard-fact', !events(s, 'social.shared').length, life(s));
    await menu('Leah', 'share'); await choose('一起聊聊'); s = await synced('share-confirm');
    check('share-actual-friend-source', events(s, 'social.shared').length === 1 && events(s, 'social.shared')[0]!.other === 'elliott' && !!events(s, 'social.shared')[0]!.sourceId, life(s));
    await menu('Leah', 'share'); s = await observe(); check('share-repeat-no-duplicate', events(s, 'social.shared').length === 1, life(s)); await rpc('life-close');
    await h.say('Elliott', '听莉亚说我们一起做了什么？', 'listener-recall'); check('listener-prompt-is-hearsay', h.latestSystem().includes('莉亚告诉我') && h.latestSystem().includes('这是转述，不是我亲历'), h.latestSystem()); await h.close();
    await h.say('Maru', '我刚刚和莉亚做了什么？', 'uninvolved-recall'); check('uninvolved-no-life-summary', !h.latestSystem().includes('## 最近相处'), h.latestSystem()); await h.close();
    await h.evidence('social-share', s);
    await runLifeRelationships(h);
    await runLifeFriendPairs(h);
  }
  if (section === 'life' || section === 'life-save') {
    const npc = 'Leah', goal = 'leah-driftwood-v1';
    await prepare(npc, { items: [{ id: '(O)169', count: 3, slot: 0 }] }); await accept(npc, goal); await deliver(npc, goal, '(O)169', 3);
    await rpc('sleep'); await rpc('title'); let s = await rpc('load'); await synced('saved-ready');
    check('saved-delivery-keeps-consumption-stage', life(s).goals[goal]?.stage === 'ready' && count(s, '(O)169') === 0, life(s));
    const baseline = life(s).events.length; const baselineMemory = h.memoryLifeRows();
    check('saved-life-facts-are-in-sqlite', baselineMemory.length === 2, baselineMemory);
    await h.disconnect(); await h.reconnect(); s = await synced('backend-restart'); check('backend-restart-no-duplicate-events', life(s).events.length === baseline, life(s));
    await rpc('sleep'); await synced('replay-next-save');
    check('backend-replay-next-save-no-duplicate-memory', JSON.stringify(h.memoryLifeRows()) === JSON.stringify(baselineMemory), { before: baselineMemory, after: h.memoryLifeRows() });
    await stageLife(h, { npc, time: 900, map: 'Forest', x: 60, y: 30 }); await goalStart(npc, goal); await minutes(30, 'day-end');
    const from = h.wireCount(); await rpc('sleep'); s = await synced('day-end-complete');
    check('day-end-completion-sealed-safely', life(s).goals[goal]?.stage === 'completed' && events(s, 'goal.completed').length === 1, life(s));
    await h.evidence('day-end-packets', { life: h.packets('life.sync', from), save: h.packets('save.saving', from) });
    await rpc('config', { SendLetters: true }); await rpc('sleep'); s = await synced('story-letter');
    check('story-letter-enters-native-mailbox', life(s).mailbox.includes('StardewAgent.Life.' + goal), life(s));
    await rpc('title'); await rpc('load'); s = await synced('reload-story'); check('saved-completion-and-letter-no-duplicate', life(s).goals[goal]?.stage === 'completed' && life(s).mailbox.filter(k => k === 'StardewAgent.Life.' + goal).length === 1, life(s));
    await prepare(npc, { items: [{ id: '(O)169', count: 3, slot: 0 }] }); await rpc('sleep');
    await stageLife(h, { npc, time: 900, map: 'Forest', x: 60, y: 30 }); await accept(npc, goal); await deliver(npc, goal, '(O)169', 3);
    await rpc('title'); s = await rpc('load'); await synced('unsaved-rollback');
    check('unsaved-rollback-restores-items-and-removes-facts', !life(s).goals[goal] && count(s, '(O)169') === 3 && !life(s).events.length, life(s));
    await h.say(npc, '之前的浮木目标交料了吗？', 'life-rollback-context');
    check('unsaved-rollback-removes-backend-life-context', !h.latestSystem().includes('## 最近相处') && !h.latestSystem().includes('农场主实际交给我'), h.latestSystem()); await h.close();
    await prepare();
    for (const [owner, story, item, amount] of [['Leah', 'leah-driftwood-v1', '(O)169', 3], ['Willy', 'willy-catfish-v1', '(O)143', 1], ['Maru', 'maru-copper-v1', '(O)334', 1]] as const) {
      await stageLife(h, { npc: owner, hearts: 8, map: 'Forest', x: 60, y: 30, clearItems: true, items: [{ id: item, count: amount, slot: 0 }] });
      await accept(owner, story); await deliver(owner, story, item, amount); await menu(owner); await choose('先到这里'); await choose('结束目标'); await synced('mail-queue-' + owner);
    }
    await rpc('config', { SendLetters: true });
    for (let day = 1; day <= 3; day++) {
      await rpc('sleep'); s = await synced('mail-daily-' + day);
      const mail = life(s).mailbox.filter(key => key.startsWith('StardewAgent.Life.'));
      check('three-pending-story-letters-daily-limit-' + day, mail.length === day && new Set(mail).size === day && life(s).letters.filter(letter => letter.sent).length === day, life(s));
    }

  }
  if (section === 'life' || section === 'life-edges') {
    await runLifeEntry(h);
    await prepare(); await menu('Leah', 'activity'); await choose('去森林散步');
    await menu('Leah', 'activity'); let s = await observe(480, true); check('native-menu-pauses-activity-minutes', life(s).activity?.minutes === 0, life(s)); await rpc('life-close');
    await rpc('clock', { time: 1000 }); s = await observe(); check('time-jump-not-company-credit', life(s).activity?.minutes === 0, life(s));
    await h.disconnect(); await menu('Leah', 'activity'); await choose('今天先回去'); s = await observe();
    check('offline-menu-releases-with-cancellation', !life(s).activity && events(s, 'activity.cancelled').length === 1 && !events(s, 'activity.missed').length, life(s));
    await h.reconnect(); s = await synced('offline-replay'); check('offline-result-replays-once', events(s, 'activity.cancelled').length === 1, life(s));
    for (let n = 1; n < 3; n++) { await stageLife(h, { npc: 'Leah', map: 'Forest', x: 60, y: 30 }); await menu('Leah', 'activity'); await choose('去森林散步'); await menu('Leah', 'activity'); await choose('今天先回去'); await synced('cancel-slot-' + n); }
    await stageLife(h, { npc: 'Leah', map: 'Forest', x: 60, y: 30 }); await menu('Leah', 'activity'); await choose('去森林散步'); s = await observe();
    check('fourth-activity-blocked-by-daily-limit', !life(s).activity && life(s).starts === 3, life(s)); await rpc('life-close');
    await prepare('Leah', { hearts: 7 }); s = await menu('Leah'); check('below-eight-hearts-no-goal', !(life(s).menu?.choices ?? []).length && !Object.keys(life(s).goals).length, life(s));
    await prepare('Leah', { spouse: true }); s = await menu('Leah'); check('spouse-no-new-goal', !(life(s).menu?.choices ?? []).length && !Object.keys(life(s).goals).length, life(s));
  }
}
