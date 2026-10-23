/** Invitations exercise production selection, native approaches/dialogues, and real save rollback. */
import type { FriendshipHost } from './game-meeting-friendship.ts';
import type { State } from './test-game-world.ts';

export interface InvitesState { today: number; inviter: string | null; inviterDay: number; meetingsArrived: boolean;
  days: number[]; eligible: string[]; history: Record<string, number> }

export async function runInvites(h: FriendshipHost, section: string) {
  const { rpc, check, chapter } = h;
  const initial = await rpc('snapshot');
  const day = initial.invites!.days.find(day => day >= 5 && day < 26)!;
  check('invites-fixture-has-a-real-selected-calendar-day', !!day, initial.invites);
  async function prepare(options: { hearts?: number; relation?: string; roommate?: boolean; last?: number; date?: number; time?: number } = {}) {
    await chapter('spring', options.date ?? day); await rpc('action-reset');
    await rpc('invite-fixture', options.last === undefined ? {} : { lastAsked: options.last });
    await rpc('clock', { time: options.time ?? 1000 });
    await rpc('action-place', { map: 'Town', x: 50, y: 68, targetX: 47, targetY: 87, next: 2200,
      hearts: options.hearts ?? 8, relation: options.relation ?? '', roommate: options.roommate ?? false });
    await rpc('config', { NpcInvites: true, NpcApproach: true, NpcMeetings: true, MeetingsGoTogether: true,
      ChatChangesFriendship: true, MeetingsChangeFriendship: true });
    await rpc('action-meetings', { meetings: [] });
    if (options.date !== 13) await rpc('warp', { map: 'Town', x: 54, y: 68 });
    return rpc('invite-choose');
  }
  async function opening(reply = '今天下午三点，一起去海滩走走怎么样？') {
    h.setReply(reply); h.setMood(0); const wire = h.wireCount();
    const state = await rpc('talk-open', { npc: 'Abigail', keepFriendship: true });
    return { state, packet: h.packets('talk.open', wire).at(-1) };
  }
  if (section === 'invites' || section === 'invites-core') {
    let state = await prepare();
    check('invites-selects-the-only-eight-heart-npc', state.native?.selected === 'Abigail' && state.invites!.eligible.length === 1, state.invites);
    await rpc('action-approach-start'); state = await rpc('action-approach-wait');
    check('invites-walks-over-without-a-nightly-seek', state.actions!.approach?.npc === 'Abigail'
      && state.actions!.approach.phase === 'Waiting' && Object.keys(state.actions!.eligible).length === 0, state.actions);
    let opened = await opening(); state = opened.state;
    check('invites-native-opening-carries-the-one-turn-prompt', opened.packet?.invite === true
      && h.latestSystem().includes('你今天想主动约农场主出去一次') && state.invites!.history.Abigail === state.invites!.today, state.invites);
    h.setReply('好啊，下午三点海滩见。'); await rpc('talk-say', { text: '好啊！', label: 'invites-accept' });
    check('invites-hint-is-removed-from-the-second-turn', !h.latestSystem().includes('你今天想主动约农场主出去一次'), h.latestSystem());
    await h.close(); state = await rpc('outing-observe', { ticks: 90 });
    check('invites-acceptance-publishes-the-agreed-clock-and-place', state.actions!.meetings[0]?.Time === 1500
      && state.actions!.meetings[0]?.Place === '海滩' && state.actions!.meetings[0]?.Applied, state.actions);
    await rpc('warp', { map: 'FarmHouse', x: 3, y: 4 });
    await rpc('action-schedule-due', { time: state.actions!.meetings[0]!.Depart }); await rpc('clock', { time: 1500 });
    await rpc('action-meeting-wait', { natural: true }); await rpc('warp', { map: 'Beach', x: 33, y: 34 });
    state = await rpc('outing-observe', { ticks: 120 });
    check('invites-accepted-appointment-reaches-the-new-outing', state.outing!.meetings[0]?.Together === true, state.outing);

    state = await prepare(); const before = await rpc('friendship-inspect'); opened = await opening();
    h.setReply('没关系，下次吧。'); await rpc('talk-say', { text: '今天不行，下次吧。', label: 'invites-refuse' }); await h.close();
    state = await rpc('outing-observe', { ticks: 60 }); const after = await rpc('friendship-inspect');
    check('invites-refusal-makes-no-plan-or-friendship-penalty', state.actions!.meetings.length === 0
      && before.native?.points === after.native?.points, { actions: state.actions, before: before.native, after: after.native });
    opened = await opening('你好。');
    check('invites-refusal-does-not-ask-again-that-day', opened.packet?.invite !== true
      && !h.latestSystem().includes('你今天想主动约农场主出去一次'), opened.packet); await h.close();
    await rpc('title'); state = await rpc('load');
    check('invites-unsaved-opening-rolls-back-its-history', state.invites!.history.Abigail === undefined, state.invites);
    await rpc('invite-fixture', { preserveHistory: true });
    await rpc('action-place', { map: 'Town', x: 50, y: 68, next: 2200 }); await rpc('action-meetings', { meetings: [] });
    state = await rpc('invite-choose');
    check('invites-unsaved-reload-selects-the-same-npc', state.native?.selected === 'Abigail', state.invites);

    await opening('明天下午三点，一起去山上湖边走走好吗？'); h.setReply('那就明天下午三点，山上湖边见。');
    await rpc('talk-say', { text: '好啊！', label: 'invites-tomorrow' }); await h.close();
    const askedDay = state.invites!.today;
    await rpc('sleep'); await rpc('title'); await rpc('load'); state = await rpc('outing-observe', { ticks: 120 });
    check('invites-native-save-reload-keeps-the-asked-day', state.invites!.history.Abigail === askedDay, state.invites);
    check('invites-tomorrow-is-published-after-native-save', state.actions!.meetings.some(m => m.Npc === 'Abigail' && m.Time === 1500 && m.Place === '山上湖边'), state.actions);
  }
  if (section === 'invites' || section === 'invites-edges') {
    let state = await prepare({ hearts: 7 });
    check('invites-excludes-seven-heart-friends', state.native?.selected === null, state.invites);
    state = await prepare({ hearts: 1, relation: 'Dating' });
    check('invites-includes-dating-below-eight-hearts', state.native?.selected === 'Abigail', state.invites);
    state = await prepare({ relation: 'Married' });
    check('invites-excludes-spouses', state.native?.selected === null, state.invites);
    state = await prepare({ relation: 'Married', roommate: true });
    check('invites-excludes-roommates', state.native?.selected === null, state.invites);
    state = await prepare(); const today = state.invites!.today;
    state = await prepare({ last: today - 6 });
    check('invites-excludes-an-npc-who-asked-six-days-ago', state.native?.selected === null, state.invites);
    state = await prepare({ last: today - 7 });
    check('invites-allows-an-npc-at-seven-days', state.native?.selected === 'Abigail', state.invites);
    await rpc('config', { NpcInvites: false }); const off = await opening('你好。');
    check('invites-disabled-opening-has-no-invite', off.packet?.invite !== true, off.packet); await h.close();
    state = await prepare({ date: 13 });
    check('invites-excludes-festival-days', state.native?.selected === null, state.invites);
    await prepare({ time: 2000 }); const late = await opening('晚上好。');
    check('invites-stops-asking-at-twenty', late.packet?.invite !== true, late.packet); await h.close();
    await prepare({ time: 1900 }); await opening('明天下午三点去海滩走走好吗？');
    check('invites-after-eighteen-prompts-tomorrow-only', h.latestSystem().includes('主动约农场主出去一次：明天，'), h.latestSystem()); await h.close();
  }
  if (section === 'invites' || section === 'invites-changes') {
    let state: State;
    await prepare(); await rpc('action-meetings', { meetings: [{ npc: 'abigail', time: 1500, place: '海滩' }] });
    const busy = await opening('你好。');
    check('invites-rechecks-a-new-appointment-after-caching-the-choice', busy.packet?.invite !== true, busy.packet); await h.close();
    await prepare(); await opening(); h.setReply('抱歉，今天我去不了了。');
    await rpc('talk-say', { text: '好啊！', label: 'invites-npc-retracts' }); await h.close(); state = await rpc('outing-observe', { ticks: 60 });
    check('invites-native-retraction-makes-no-appointment', state.actions!.meetings.length === 0, state.actions);
    await prepare(); await opening(); h.setReply('那就下午三点海滩见。');
    await rpc('talk-say', { text: '好啊！', label: 'invites-first-yes' }); h.setReply('好啊，今天下午四点博物馆见。');
    await rpc('talk-say', { text: '改成今天下午四点博物馆见吧？', label: 'invites-changed-place' }); await h.close();
    state = await rpc('outing-observe', { ticks: 60 });
    check('invites-native-later-agreement-replaces-the-opening', state.actions!.meetings.length === 1
      && state.actions!.meetings[0]!.Time === 1600 && state.actions!.meetings[0]!.Place === '博物馆', state.actions);
  }
  h.setReply(''); h.setMood(0);
}
