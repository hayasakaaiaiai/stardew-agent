/** Native animal changes, vanilla pet references, storage and persistence in the guarded disposable save. */
import type { TodayHost } from './game-same-day-meetings.ts';
import type { State } from './test-game-world.ts';

interface Animal { label: string; type: string; age: number; friendship: number; happiness: number; petted: boolean; auto: boolean;
  produce: string | null; quality: number; cracker: boolean; map: string }
interface Probe { farming: number; foraging: number; ItemsForaged: number; animals: Animal[];
  ground: { map: string; id: string; stack: number; quality: number; spawned: boolean }[];
  reference: Record<string, { friendship: number; happiness: number }> }
interface Done { Collected: number; Milked: number; Sheared: number; Petted: number; Truffles: number }
const probe = (state: State) => state.native as unknown as Probe;
const amount = (state: State, id: string, quality?: number) => state.farm!.chests.flatMap(chest => chest.items)
  .filter(item => item.id === id && (quality === undefined || item.quality === quality)).reduce((n, item) => n + item.stack, 0);
const signature = (state: State) => JSON.stringify({ animals: probe(state).animals.map(({ map, ...rest }) => rest).sort((a, b) => a.label.localeCompare(b.label)),
  farming: probe(state).farming, foraging: probe(state).foraging, chests: state.farm!.chests });

export async function runFarmAnimals(h: TodayHost) {
  const { rpc, check, chapter } = h;
  async function prepare(args: Record<string, unknown> = {}, time = 900) {
    await chapter('spring', 6); await rpc('action-reset'); await rpc('config', { NpcMeetings: false, NpcApproach: false });
    await rpc('clock', { time }); return rpc('animals-fixture', args);
  }
  const before = await prepare({ stack: 2 });
  const worked = await rpc('farm-run'), summary = worked.native as unknown as Done;
  let state = await rpc('animals-inspect');
  check('animals-floor-stack-and-quality-are-conserved', amount(state, '(O)176', 2) === 2 && amount(state, '(O)442') === 1,
    { summary, before: probe(before), after: probe(state), chests: state.farm!.chests });
  check('animals-golden-cracker-milk-and-wool-have-native-quality', amount(state, '(O)184', 4) === 2 && amount(state, '(O)436', 1) === 1
    && amount(state, '(O)440', 2) === 1, state.farm!.chests);
  check('animals-summary-counts-actual-items-and-animals', summary.Collected === 3 && summary.Milked === 2 && summary.Sheared === 1
    && summary.Petted === 6 && summary.Truffles === 1, summary);
  check('animals-tools-clear-adult-produce-and-leave-baby', probe(state).animals.filter(a => ['cow', 'goat-outside', 'sheep'].includes(a.label)).every(a => a.produce === null)
    && probe(state).animals.find(a => a.label === 'baby')!.produce !== null, probe(state).animals);
  for (const animal of probe(state).animals) {
    const reference = probe(before).reference[animal.label]!;
    const tool = ['cow', 'goat-outside', 'sheep'].includes(animal.label) ? 5 : 0;
    check('animals-pet-matches-vanilla-' + animal.label, animal.friendship === reference.friendship + tool && animal.happiness === reference.happiness, animal);
  }
  check('animals-helper-grants-no-farming-or-foraging-experience', probe(state).farming === probe(before).farming && probe(state).foraging === probe(before).foraging,
    { before: probe(before), after: probe(state) });
  check('animals-machines-and-player-placed-products-stay', probe(state).ground.filter(item => ['(BC)104', '(BC)165', '(BC)101'].includes(item.id)).length === 3
    && probe(state).ground.some(item => item.id === '(O)184' && !item.spawned)
    && probe(state).ground.some(item => item.id === '(O)430' && !item.spawned) && amount(state, '(O)430', 0) === 1, probe(state).ground);
  const chests = JSON.stringify(state.farm!.chests);
  const again = (await rpc('farm-run')).native as unknown as Done;
  state = await rpc('animals-inspect');
  check('animals-second-help-is-idempotent', [again.Collected, again.Milked, again.Sheared, again.Petted, again.Truffles].every(n => n === 0)
    && JSON.stringify(state.farm!.chests) === chests, again);

  for (const args of [{ professional: true, auto: true }, { full: true, blocked: true }]) {
    const initial = await prepare(args);
    const result = (await rpc('farm-run')).native as unknown as Done;
    state = await rpc('animals-inspect');
    if ('blocked' in args) {
      check('animals-full-chests-and-no-new-spot-leave-all-products', result.Collected === 0 && result.Milked === 0 && result.Sheared === 0 && result.Truffles === 0
        && probe(state).animals.find(a => a.label === 'cow')!.produce !== null && probe(state).ground.some(item => item.id === '(O)176' && item.spawned), result);
    } else for (const animal of probe(state).animals) {
      const reference = probe(initial).reference[animal.label]!;
      const tool = ['cow', 'goat-outside', 'sheep'].includes(animal.label) ? 5 : 0;
      check('animals-auto-petter-and-profession-match-vanilla-' + animal.label, animal.friendship === reference.friendship + tool
        && animal.happiness === reference.happiness, animal);
    }
    check('animals-edge-help-still-gives-no-experience', probe(state).farming === probe(initial).farming && probe(state).foraging === probe(initial).foraging);
  }
  await prepare({ stack: 2, full: true, blocked: true, partial: true });
  const partial = (await rpc('farm-run')).native as unknown as Done;
  state = await rpc('animals-inspect');
  check('animals-partial-stack-fills-compatible-chest-and-keeps-the-rest', partial.Collected === 1
    && amount(state, '(O)176', 2) === 999 && probe(state).ground.some(item => item.id === '(O)176' && item.stack === 1 && item.quality === 2),
    { partial, ground: probe(state).ground, chests: state.farm!.chests });
  check('animals-partial-stack-counts-only-stored-items-in-native-stats', probe(state).ItemsForaged === 1, probe(state).ItemsForaged);
  const partialAgain = (await rpc('farm-run')).native as unknown as Done;
  state = await rpc('animals-inspect');
  check('animals-partial-stack-retry-neither-loses-nor-duplicates', partialAgain.Collected === 0 && amount(state, '(O)176', 2) === 999
    && probe(state).ground.some(item => item.id === '(O)176' && item.stack === 1), partialAgain);
  await prepare({}, 1900);
  const night = (await rpc('farm-run')).native as unknown as Done;
  check('animals-after-nineteen-harvests-but-does-not-pet', night.Petted === 0 && night.Milked === 2 && night.Sheared === 1, night);

  await prepare(); await rpc('clock', { time: 1000 });
  await rpc('action-place', { map: 'Mountain', x: 44, y: 18, targetX: 45, targetY: 18, next: 2000 });
  await rpc('config', { NpcMeetings: true, MeetingsChangeFriendship: false });
  h.setReply('你好。'); await rpc('talk-open', { npc: 'Abigail' });
  h.setReply('好啊，马上来农场帮忙。'); await rpc('talk-say', { text: '现在来我农场帮忙吧？', label: 'animal-agreement' }); await h.close();
  await rpc('wait', { ticks: 60 }); state = await rpc('farm-start', { speed: 8 });
  check('animals-real-npc-arrival-performs-animal-chores', state.actions!.meetings[0]!.Helped && amount(state, '(O)184', 4) === 2, state.actions);
  await rpc('warp', { map: 'Farm', x: state.farm!.porch.X + 2, y: state.farm!.porch.Y }); await rpc('wait', { ticks: 60 });
  h.setReply('我挤了奶，也剪了毛。'); await h.say('Abigail', '你帮我做了哪些动物活？', 'animal-live-recall');
  check('animals-real-help-is-in-conversation-prompt', /挤了 2 只动物的奶/.test(h.latestSystem()) && /剪了 1 只羊的毛/.test(h.latestSystem())
    && /摸了 6 只动物/.test(h.latestSystem()), h.latestSystem()); await h.close();
  await rpc('warp', { map: 'Farm', x: 50, y: 25 }); await rpc('farm-exit', { speed: 8 });
  check('animals-reliable-report-has-actual-animal-counts', h.packets('meet.ended').some(packet => (packet.helped as Record<string, unknown>)?.milked === 2
    && (packet.helped as Record<string, unknown>)?.petted === 6), h.packets('meet.ended'));
  await rpc('sleep'); const saved = await rpc('animals-inspect');
  await rpc('title'); await rpc('load'); state = await rpc('animals-inspect');
  check('animals-real-save-reload-preserves-products-and-animal-state', signature(state) === signature(saved), { saved: probe(saved), loaded: probe(state) });
  h.setReply('记得我帮你挤奶剪毛。'); await h.say('Abigail', '上次你照顾动物做了什么？', 'animal-saved-recall');
  check('animals-real-save-reload-preserves-help-memory', /挤了 2 只动物的奶/.test(h.latestSystem()) && /捡了 1 个松露/.test(h.latestSystem()), h.latestSystem()); await h.close();
  const rollback = await rpc('animals-inspect'); await rpc('farm-run'); await rpc('title'); await rpc('load'); state = await rpc('animals-inspect');
  check('animals-unsaved-help-rolls-back-animal-state-and-products', signature(state) === signature(rollback), { before: probe(rollback), after: probe(state) });
  h.setReply('');
}
