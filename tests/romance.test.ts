import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROMANCE_NPCS, parseRomanceEvents, romanceChanges, romanceContext, romanceProfile, type RomanceEvent } from '../src/agent/romance.ts';
import type { Json, NpcChange, NpcState } from '../src/types.ts';

const plan = (serial = 1, patch: Partial<RomanceEvent> = {}): RomanceEvent => ({ id: `life-${serial}`, npc: 'leah', day: 1,
  kind: 'romance.planned', dateId: `date-${serial}`, dateDay: 1, time: 1000, venue: 'Forest', preparation: 'quiet', relation: 'dating', initiator: 'player', ...patch });
const start = (serial = 2, patch: Partial<RomanceEvent> = {}): RomanceEvent => ({ id: `life-${serial}`, npc: 'leah', day: 1,
  kind: 'romance.started', dateId: 'date-1', venue: 'Forest', time: 1000, relation: 'dating', ...patch });
const end = (serial = 3, patch: Partial<RomanceEvent> = {}): RomanceEvent => ({ id: `life-${serial}`, npc: 'leah', day: 1,
  kind: 'romance.completed', dateId: 'date-1', venue: 'Forest', relation: 'dating', weather: 'sunny', minutes: 30, friendship: 0, ...patch });
const remember = (serial = 4, patch: Partial<RomanceEvent> = {}): RomanceEvent => ({ id: `life-${serial}`, npc: 'leah', day: 1,
  kind: 'romance.remembered', dateId: 'date-1', sourceId: 'life-3', detail: 'company', ...patch });
const cancel = (serial = 2, patch: Partial<RomanceEvent> = {}): RomanceEvent => ({ id: `life-${serial}`, npc: 'leah', day: 1,
  kind: 'romance.cancelled', dateId: 'date-1', reason: 'player', ...patch });
const reschedule = (serial = 2, patch: Partial<RomanceEvent> = {}): RomanceEvent => ({ ...plan(1), id: `life-${serial}`, kind: 'romance.rescheduled', ...patch });
const states = (changes: NpcChange[]): Record<string, NpcState> => Object.fromEntries(changes.map(change => [change.npcId, change.state!]));
const state = (npc: NpcState) => npc.romance as Record<string, Json>;

test('romance wire batches are detached, bounded, strictly ordered and reject foreign fields', () => {
  assert.deepEqual(parseRomanceEvents([]), []);
  const original = [plan()]; const copied = parseRomanceEvents(original); copied[0]!.dateDay = 2;
  assert.equal(original[0]!.dateDay, 1);
  for (const bad of [null, {}, Array.from({ length: 33 }, (_, i) => plan(i + 1)), [plan(2), plan(1)], [plan(), plan()],
    [{ ...plan(), affection: 100 }], [{ ...plan(), kind: 'romance.married' }], [{ ...plan(), npc: 'Leah' }],
    [{ ...plan(), npc: 'jas' }], [{ ...plan(), npc: 'krobus' }], [{ ...plan(), day: 0 }], [{ ...plan(), day: 1.5 }],
    [{ ...plan(), sourceId: null }], [{ ...plan(), dateId: 'date-01' }], [{ ...plan(), id: 'life-01' }]])
    assert.throws(() => parseRomanceEvents(bad), /INVALID_ROMANCE_EVENT/, JSON.stringify(bad));
});

test('date IDs are tied to creation serials and later observations cannot manufacture a fresh date', () => {
  assert.throws(() => parseRomanceEvents([plan(5, { dateId: 'date-1' })]), /original planned event/);
  assert.throws(() => parseRomanceEvents([start(2, { dateId: 'date-2' })]), /original planned event/);
  assert.throws(() => parseRomanceEvents([plan(5, { sourceId: 'life-5' })]), /source must precede/);
  assert.throws(() => parseRomanceEvents([plan(5, { sourceId: 'life-6' })]), /source must precede/);
  assert.equal(parseRomanceEvents([plan(7, { sourceId: 'life-3' })])[0]!.dateId, 'date-7');
});

test('only native dating, engagement or marriage authorizes plans and each NPC uses its own venues', () => {
  for (const relation of ['friend', 'roommate', 'stranger', 'divorced', '', null])
    assert.throws(() => parseRomanceEvents([{ ...plan(), relation }]), /native romantic relationship/);
  for (const relation of ['dating', 'engaged', 'married'] as const)
    assert.equal(parseRomanceEvents([plan(1, { relation })])[0]!.relation, relation);
  for (const npc of ROMANCE_NPCS) {
    const venue = romanceProfile(npc)!.venues[0]!.map;
    assert.equal(parseRomanceEvents([plan(1, { npc, venue })])[0]!.npc, npc);
  }
  assert.throws(() => parseRomanceEvents([plan(1, { venue: 'Town' })]), /venue is not offered/);
});

test('plans use today or tomorrow and supported times, while native starts accept real ten-minute ticks', () => {
  for (const patch of [{ dateDay: 0 }, { dateDay: 3 }, { time: 1030 }, { time: 2460 }, { preparation: 'gift' }, { initiator: 'model' }])
    assert.throws(() => parseRomanceEvents([{ ...plan(), ...patch }]), /invalid date plan/);
  assert.equal(parseRomanceEvents([plan(1, { dateDay: 2, time: 1700 })])[0]!.dateDay, 2);
  assert.equal(parseRomanceEvents([start(2, { time: 1050 })])[0]!.time, 1050);
  for (const time of [1055, 1060, 2500, 800]) assert.throws(() => parseRomanceEvents([start(2, { time })]), /observed start time/);
});

test('completion requires actual duration, known weather and an already applied nonnegative friendship delta', () => {
  for (const patch of [{ minutes: 29 }, { minutes: 1441 }, { weather: 'sunset' }, { friendship: -1 }, { friendship: 31 }, { friendship: null }])
    assert.throws(() => parseRomanceEvents([{ ...end(), ...patch }]), /observed company/);
  const { friendship: _drop, ...missingPoints } = end();
  assert.throws(() => parseRomanceEvents([missingPoints]), /observed company/);
  for (const weather of ['sunny', 'rain', 'storm', 'snow', 'windy'] as const)
    assert.equal(parseRomanceEvents([end(3, { weather, friendship: 30 })])[0]!.weather, weather);
  assert.throws(() => parseRomanceEvents([{ ...end(), detail: 'company' }]), /fields do not match/);
});

test('a confirmed plan and actual departure are not completed dates and do not invent being at the destination', () => {
  const before = { leah: { impression: '旧印象', plan: '原来的计划' }, sam: { impression: '不知情' } };
  const changes = romanceChanges([plan(), start()], before);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.npcId, 'leah');
  assert.equal(changes[0]!.state!.impression, '旧印象');
  assert.equal(changes[0]!.state!.plan, '原来的计划');
  assert.deepEqual(before, { leah: { impression: '旧印象', plan: '原来的计划' }, sam: { impression: '不知情' } });
  assert.equal(state(changes[0]!.state!).completedCount, 0);
  assert.equal(state(changes[0]!.state!).firstCompleted, null);
  assert.match(changes[0]!.memories![0]!.text, /尚未出发或完成/);
  assert.match(changes[0]!.memories![1]!.text, /只表示出发/);
  assert.match(romanceContext(changes[0]!.state!, 1, 'dating')!, /不能说已完成/);
  assert.match(romanceContext(changes[0]!.state!, 1, 'dating')!, /打算安静陪伴/);
  const talk = romanceChanges([plan(1, { preparation: 'talk' }), start()], {})[0]!.state!;
  assert.match(romanceContext(talk, 1, 'dating')!, /打算留时间聊聊/);
  assert.doesNotMatch(romanceContext(talk, 1, 'dating')!, /已经聊过|已经谈心/);
});

test('all twelve characters have isolated complete date flows and private, source-dated memories', () => {
  for (const npc of ROMANCE_NPCS) {
    const venue = romanceProfile(npc)!.venues[0]!.map;
    const changes = romanceChanges([plan(1, { npc, venue }), start(2, { npc, venue }), end(3, { npc, venue })], {});
    assert.deepEqual(changes.map(change => change.npcId), [npc]);
    assert.equal(state(changes[0]!.state!).completedCount, 1);
    assert.equal(state(changes[0]!.state!).active, null);
    assert.ok(changes[0]!.memories!.every(memory => memory.visibility === 'private' && memory.topics!.includes('romance')
      && !memory.topics!.includes('life') && memory.text.startsWith('第 1 天：')));
    assert.match(changes[0]!.memories!.at(-1)!.text, /当时的关系为恋爱中/);
    assert.equal(changes[0]!.log!.friendship, undefined, 'the bridge accounts for the native delta exactly once');
  }
});

test('one NPC cannot hold overlapping dates and a reschedule preserves a single pending plan', () => {
  const initial = states(romanceChanges([plan()], {}));
  assert.throws(() => romanceChanges([plan(2)], initial), /unfinished date already exists/);
  const changed = romanceChanges([reschedule(2, { dateDay: 2, time: 1400, preparation: 'talk', initiator: 'npc' })], initial);
  assert.equal((state(changed[0]!.state!).active as Record<string, Json>).dateDay, 2);
  assert.match(changed[0]!.memories![0]!.text, /改期本身不算失约/);
  const begun = states(romanceChanges([start(3, { day: 2, time: 1400 })], states(changed)));
  assert.throws(() => romanceChanges([reschedule(4, { day: 2, dateDay: 2 })], begun), /only a pending date/);
});

test('departure must use the planned date, destination and inclusive sixty-minute window', () => {
  const prior = states(romanceChanges([plan()], {}));
  for (const patch of [{ day: 2 }, { dateId: 'date-2' }, { venue: 'Beach' as const }, { time: 950 }, { time: 1110 }])
    assert.throws(() => romanceChanges([start(3, patch)], prior), /departure does not match/);
  const last = romanceChanges([start(2, { time: 1100 })], prior);
  assert.equal((state(last[0]!.state!).active as Record<string, Json>).startTime, 1100);
  assert.throws(() => romanceChanges([start(3)], states(last)), /departure does not match/);
});

test('completion cannot skip departure, change the destination or finish a cancelled date', () => {
  const pending = states(romanceChanges([plan()], {}));
  assert.throws(() => romanceChanges([end()], pending), /completion requires/);
  const started = states(romanceChanges([start()], pending));
  for (const patch of [{ day: 2 }, { venue: 'Beach' as const }, { dateId: 'date-2' }])
    assert.throws(() => romanceChanges([end(3, patch)], started), /completion requires/);
  const stopped = states(romanceChanges([cancel(3, { reason: 'interrupted' })], started));
  assert.throws(() => romanceChanges([end(4)], stopped), /completion requires/);
});

test('normal cancellation, expiration and changed relationship preserve facts without making a breach', () => {
  for (const reason of ['player', 'expired', 'relationship'] as const) {
    const changes = romanceChanges([plan(), cancel(2, { reason })], {});
    assert.equal(state(changes[0]!.state!).active, null);
    assert.equal(state(changes[0]!.state!).completedCount, 0);
    assert.match(changes[0]!.memories![1]!.text, /没有记录为完成.*不据此推断失约或惩罚/);
    assert.equal(changes[0]!.state!.life, undefined);
    assert.equal(changes[0]!.log!.friendship, undefined);
  }
  assert.throws(() => romanceChanges([plan(), cancel(2, { reason: 'interrupted' })], {}), /only a started date/);
  assert.throws(() => parseRomanceEvents([{ ...cancel(), relation: 'friend' }]), /fields do not match/);
});

test('a remembered detail must point to this completed date and is selected only once', () => {
  assert.throws(() => romanceChanges([plan(), remember(4)], {}), /retained completion/);
  const done = states(romanceChanges([plan(), start(), end()], {}));
  for (const patch of [{ sourceId: 'life-2' }, { dateId: 'date-2' }, { sourceId: 'life-1' }])
    assert.throws(() => romanceChanges([remember(4, patch)], done), /retained completion/);
  const remembered = romanceChanges([remember()], done);
  assert.match(remembered[0]!.memories![0]!.text, /选择把一起留出的时间.*第 1 天/);
  assert.equal((state(remembered[0]!.state!).firstCompleted as Record<string, Json>).detail, 'company');
  assert.throws(() => romanceChanges([remember(5, { detail: 'weather' })], states(remembered)), /already chosen/);
  assert.deepEqual(romanceChanges([remember()], states(remembered)), []);
});

test('remembering weather retains the actual weather and never generates conversation or photographs', () => {
  const changes = romanceChanges([plan(), start(), end(3, { weather: 'rain' }), remember(4, { detail: 'weather' })], {});
  const text = changes[0]!.memories!.at(-1)!.text;
  assert.match(text, /当时的天气.*当时下雨/);
  assert.doesNotMatch(text, /拍照|照片|谈心|谈话|晴天/);
  assert.throws(() => parseRomanceEvents([{ ...remember(), detail: 'we confessed our secrets' }]), /supported detail/);
});

test('a revisit requires this NPC own actual completion and retains its venue through rescheduling', () => {
  const done = states(romanceChanges([plan(), start(), end()], {}));
  const revisit = plan(4, { sourceId: 'life-3', dateDay: 2 });
  const changes = romanceChanges([revisit], done);
  assert.match(changes[0]!.memories![0]!.text, /重访第 1 天/);
  assert.throws(() => romanceChanges([plan(4, { sourceId: 'life-3', venue: 'Beach' })], done), /same venue/);
  const maruVenue = romanceProfile('maru')!.venues[0]!.map;
  assert.throws(() => romanceChanges([plan(4, { npc: 'maru', venue: maruVenue, sourceId: 'life-3' })], done), /retained completion/);
  assert.throws(() => romanceChanges([reschedule(5, { dateId: 'date-4', venue: 'Beach' })], states(changes)), /keep its source venue/);
  assert.throws(() => parseRomanceEvents([{ ...reschedule(5, { dateId: 'date-4' }), sourceId: 'life-3' }]), /fields do not match/);
});

test('a new visit is only remembered as a revisit once the second actual activity is completed', () => {
  const prior = states(romanceChanges([plan(), start(), end(), plan(4, { sourceId: 'life-3', dateDay: 2 })], {}));
  assert.equal(state(prior.leah!).completedCount, 1);
  const changes = romanceChanges([start(5, { dateId: 'date-4', day: 2 }), end(6, { dateId: 'date-4', day: 2, minutes: 40 })], prior);
  assert.equal(state(changes[0]!.state!).completedCount, 2);
  assert.match(changes[0]!.memories!.at(-1)!.text, /这次真实重访了第 1 天/);
  const completions = state(changes[0]!.state!).completed as Record<string, Json>[];
  assert.equal(completions.at(-1)!.sourceId, 'life-3');
  assert.equal(completions.at(-1)!.revisitDay, 1);
});

test('only the most recent twenty-four completions plus the first can be revisited', () => {
  let prior: Record<string, NpcState> = {};
  for (let i = 0; i < 26; i++) {
    const n = i * 3 + 1, day = i + 1, dateId = `date-${n}`;
    prior = states(romanceChanges([plan(n, { day, dateDay: day }), start(n + 1, { day, dateId }), end(n + 2, { day, dateId })], prior));
  }
  const saved = state(prior.leah!);
  assert.equal((saved.completed as Json[]).length, 24);
  assert.equal(saved.completedCount, 26);
  assert.equal((saved.firstCompleted as Record<string, Json>).eventId, 'life-3');
  assert.throws(() => romanceChanges([plan(79, { day: 27, dateDay: 27, sourceId: 'life-6' })], prior), /retained completion/);
  const first = romanceChanges([remember(79, { day: 27, detail: 'place' }), plan(80, { day: 27, dateDay: 27, sourceId: 'life-3' })], prior);
  assert.equal((state(first[0]!.state!).firstCompleted as Record<string, Json>).detail, 'place');
  assert.match(first[0]!.memories!.at(-1)!.text, /重访第 1 天/);
  assert.deepEqual(romanceChanges([plan(), start(), end()], prior), [], 'old records stay deduplicated after receipts are evicted');
});

test('replay is idempotent and a retained ID cannot silently acquire changed native facts', () => {
  const events = [plan(), start(), end(), remember()];
  const prior = states(romanceChanges(events, {}));
  assert.deepEqual(romanceChanges(events, prior), []);
  assert.throws(() => romanceChanges([end(3, { minutes: 40 })], prior), /reused with different content/);
  assert.deepEqual((romanceChanges([plan(5)], prior)[0]!.log!.romanceEvents as Json[]).length, 1);
});

test('rolled-back branches may reuse native serials independently without leaking other branches', () => {
  const base = { leah: { impression: '基线' } };
  const left = states(romanceChanges([plan(), start(), end(3, { weather: 'rain' })], base));
  const right = states(romanceChanges([plan(), cancel()], base));
  assert.equal(state(left.leah!).completedCount, 1);
  assert.equal(state(right.leah!).completedCount, 0);
  assert.equal(state(right.leah!).firstCompleted, null);
  assert.deepEqual(base, { leah: { impression: '基线' } });
});

test('a later invalid transition leaves all caller-owned state untouched', () => {
  const prior = states(romanceChanges([plan()], {}));
  const snapshot = structuredClone(prior);
  assert.throws(() => romanceChanges([start(), end(3, { day: 2 })], prior), /completion requires/);
  assert.deepEqual(prior, snapshot);
  assert.throws(() => romanceChanges([reschedule(3, { day: 2, dateDay: 2 }), start(4, { day: 1 })], prior), /predates/);
  assert.deepEqual(prior, snapshot);
});

test('engagement and marriage can follow dating without rewriting the relationship at an earlier event', () => {
  const changes = romanceChanges([plan(), start(2, { relation: 'engaged' }), end(3, { relation: 'married' })], {});
  assert.match(changes[0]!.memories!.at(-1)!.text, /当时的关系为已结婚/);
  const current = romanceContext(changes[0]!.state!, 1, 'married')!;
  assert.match(current, /当前原版关系/);
  assert.match(current, /不推断排他承诺、同居、婚期/);
});

test('friend and roommate contexts only describe a historic date, never current romance or pending plans', () => {
  const onlyPlanned = romanceChanges([plan()], {})[0]!.state!;
  const cancelled = romanceChanges([plan(), cancel(2, { reason: 'relationship' })], {})[0]!.state!;
  for (const prior of [onlyPlanned, cancelled]) for (const relation of ['friend', 'roommate', 'stranger'] as const) {
    const cue = romanceContext(prior, 10, relation)!;
    assert.match(cue, /只属于过去/);
    assert.match(cue, /没有已完成的约会记录/);
    assert.match(cue, /不执行旧约会/);
    assert.doesNotMatch(cue, /最近实际约会|尚未出发|已一起出发/);
  }
  const done = romanceChanges([plan(), start(), end(), plan(4, { dateDay: 2 })], {})[0]!.state!;
  for (const relation of ['friend', 'roommate', 'stranger'] as const) {
    const cue = romanceContext(done, 1, relation)!;
    assert.match(cue, /只属于过去/);
    assert.doesNotMatch(cue, /已商量第 2 天|尚未出发|当前.*恋人/);
  }
});

test('old saves never get an invented dating anniversary and first observation is not relationship inception', () => {
  assert.equal(romanceContext({}, 200, 'married'), undefined);
  const done = romanceChanges([plan(1, { day: 200, dateDay: 200 }), start(2, { day: 200 }), end(3, { day: 200 })], {})[0]!.state!;
  assert.match(romanceContext(done, 200, 'married')!, /最早可确认的是第 200 天，不猜交往起始日/);
  assert.equal(romanceContext(done, 199, 'dating'), undefined);
  assert.doesNotMatch(romanceContext(done, 300, 'dating')!, /最近实际约会/);
  assert.match(romanceContext(done, 300, 'dating')!, /已记录 1 次/);
});

test('stale plans stay explicitly expired and temporary cancellation cues do not become accomplishments', () => {
  const pending = romanceChanges([plan()], {})[0]!.state!;
  const departed = romanceChanges([plan(), start()], {})[0]!.state!;
  for (const prior of [pending, departed]) {
    const cue = romanceContext(prior, 5, 'dating')!;
    assert.match(cue, /第 1 天的旧约会安排已过期/);
    assert.match(cue, /这次未记录完成，不继续执行/);
    assert.doesNotMatch(cue, /已商量|已一起出发|最近实际约会|已记录.*次完成/);
  }
  const stopped = romanceChanges([plan(), cancel()], {})[0]!.state!;
  assert.match(romanceContext(stopped, 3, 'dating')!, /不算已完成或失约/);
  assert.equal(romanceContext(stopped, 4, 'dating'), undefined);
  assert.throws(() => romanceContext(stopped, 0, 'dating'), /invalid context/);
  assert.throws(() => romanceContext(stopped, 4, 'unknown' as 'dating'), /invalid context/);
});

test('saved romance projections reject corrupted versions, plans, sources and counters', () => {
  const done = romanceChanges([plan(), start(), end()], {})[0]!.state!;
  const current = state(done);
  for (const patch of [{ version: 2 }, { lastSerial: -1 }, { completedCount: 0 }, { completed: Array(25).fill((current.completed as Json[])[0]) },
    { active: { dateId: 'wrong' } }, { firstCompleted: null }, { cancelled: { day: -1, reason: 'player' } }, { recent: [{ id: 'life-9', signature: '' }] }])
    assert.throws(() => romanceContext({ romance: { ...current, ...patch } as Json }, 1, 'dating'), /INVALID_ROMANCE_EVENT/);
});
