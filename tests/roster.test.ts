import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { CardError, parseCard, parseRule, renderCard, Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';

const CARDS = resolve(import.meta.dirname, '../data/npcs');
const IDS = [...SOCIAL_NPCS];

async function loadAll() {
  const roster = new Roster({ directory: CARDS, npcIds: IDS });
  return { roster, result: await roster.load() };
}

test('all 34 cards parse, and only the two known conditions are left to the model', async () => {
  const { result } = await loadAll();
  assert.deepEqual(result.errors.map((e) => e.message), []);
  assert.deepEqual(result.loaded.sort(), [...IDS].sort());
  assert.deepEqual((await readdir(CARDS)).filter((f) => !f.startsWith('_')).length, 34);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.some((w) => w.startsWith('krobus.md')));
  assert.ok(result.warnings.some((w) => w.startsWith('pam.md')));
});

test('rule conditions: event ids, “任何时候”, and natural language', () => {
  assert.deepEqual(parseRule('看过 6 心事件（事件 4，深夜墓地）之前：不说自己在练剑。'),
    { kind: 'unseen', events: ['4'], text: '不说自己在练剑。' });
  assert.deepEqual(parseRule('看过 8 心事件（事件 53 艺术展，或事件 584059 网店）之前：只按实际的那一条说。'),
    { kind: 'unseen', events: ['53', '584059'], text: '只按实际的那一条说。' });
  assert.deepEqual(parseRule('任何时候：不说出真名。'), { kind: 'always', text: '不说出真名。' });
  assert.deepEqual(parseRule('10 心之前：不说父母不在了。'), { kind: 'hearts', below: 10, text: '不说父母不在了。' });
  assert.deepEqual(parseRule('新房子盖好之前：不提新房子（事件 611173 揭晓）。'),
    { kind: 'text', condition: '新房子盖好之前', text: '不提新房子（事件 611173 揭晓）。' });
  assert.deepEqual(parseRule('看过之后也只在没有旁人时承认。'), { kind: 'always', text: '看过之后也只在没有旁人时承认。' });
});

test('event rules lapse once any listed event is seen; topics unlock by hearts', async () => {
  const { roster } = await loadAll();
  const before = roster.render('abigail', { hearts: 4, seenEvents: new Set(), purpose: 'dialogue' });
  const after = roster.render('abigail', { hearts: 4, seenEvents: new Set(['4']), purpose: 'dialogue' });
  assert.match(before.gated, /不说自己已经在偷偷练剑/);
  assert.doesNotMatch(after.gated, /不说自己已经在偷偷练剑/);
  assert.match(after.gated, /自己可能不是皮埃尔亲生的/, 'always rules never lapse');

  const jas = (hearts: number) => roster.render('jas', { hearts, seenEvents: new Set(), purpose: 'dialogue' }).gated;
  assert.match(jas(9), /不说他们已经不在了/);
  assert.doesNotMatch(jas(10), /不说他们已经不在了/);

  const low = roster.render('abigail', { hearts: 0, seenEvents: new Set(), purpose: 'dialogue' });
  const high = roster.render('abigail', { hearts: 10, seenEvents: new Set(), purpose: 'dialogue' });
  assert.doesNotMatch(low.gated, /战斗季刊/);
  assert.match(high.gated, /战斗季刊/);
});

test('the stable part depends only on the card, so it stays in the cached prefix', async () => {
  const { roster } = await loadAll();
  for (const id of IDS) {
    const a = roster.render(id, { hearts: 0, seenEvents: new Set(), purpose: 'dialogue' });
    const b = roster.render(id, { hearts: 14, seenEvents: new Set(['1', '4', '10']), purpose: 'dialogue', includeGifts: true });
    assert.equal(a.stable, b.stable, id);
  }
  const scene = roster.render('abigail', { hearts: 4, seenEvents: new Set(), purpose: 'scene' });
  assert.doesNotMatch(scene.stable, /示例台词/);
});

test('invalid cards report every problem', () => {
  const known = new Set(['abigail', 'sam']);
  assert.throws(() => parseCard('abigail', '# 阿比盖尔\n\n## 性格\n\n- 直率\n\n## 爱好\n\n随便\n', known), (error: unknown) => {
    assert.ok(error instanceof CardError);
    assert.ok(error.problems.some((p) => p.includes('unknown section "爱好"')));
    assert.ok(error.problems.some((p) => p.includes('identity')));
    assert.ok(error.problems.some((p) => p.includes('示例台词')));
    return true;
  });
  const card = [
    '# 阿比盖尔', '## 身份与背景', '住在杂货店。', '## 性格', '- 直率', '## 说话风格', '短句。',
    '### 示例台词', '- 嘿。', '## 人际关系', '- 莫里斯（morris）：讨厌他。', '## 喜好', '紫水晶。',
    '## 按心数解锁的话题', '- 2：没有加号', '## 不能说的内容', '- 任何时候：不剧透。',
  ].join('\n');
  assert.throws(() => parseCard('abigail', card, known), (error: unknown) => {
    assert.ok(error instanceof CardError);
    assert.ok(error.problems.some((p) => p.includes('unknown id "morris"')));
    assert.ok(error.problems.some((p) => p.includes('N+：')));
    return true;
  });
});

test('after-event lines render only once the player has seen the event', () => {
  const known = new Set(['abigail']);
  const base = [
    '# 阿比盖尔', '## 身份与背景', '住在杂货店。', '## 性格', '- 直率', '## 说话风格', '短句。', '### 示例台词', '- 嘿。',
    '## 人际关系', '- 皮埃尔：父亲。', '## 喜好', '紫水晶。', '## 按心数解锁的话题', '- 0+：雨天。',
    '## 不能说的内容', '- 看过 6 心事件（事件 4）之前：不说在练剑。', '## 看过事件之后（可选）',
  ];
  const { card } = parseCard('abigail', [...base,
    '- 事件 4（6 心，深夜墓地）：她坦白在偷偷练剑。',
    '- 事件 2123243（艾米丽的 8 心事件，服装疗法）：她穿了一整套盔甲。'].join('\n'), known);
  assert.deepEqual(card.afterEvents[0], { event: '4', label: '6 心，深夜墓地', text: '她坦白在偷偷练剑。' });
  const view = (seen: string[]) => renderCard(card, { hearts: 6, seenEvents: new Set(seen), purpose: 'dialogue' }).gated;
  assert.doesNotMatch(view([]), /已经发生过的事/);
  assert.match(view(['4']), /### 已经发生过的事\n- 6 心，深夜墓地：她坦白在偷偷练剑。/);
  assert.doesNotMatch(view(['4']), /不说在练剑/, 'the matching rule lapses at the same time');
  assert.match(view(['2123243']), /艾米丽的 8 心事件/);

  for (const [bad, problem] of [
    [['- 事件 4（6 心）：一。', '- 事件 4（6 心，又一次）：二。'], 'repeat event 4'],
    [['- 事件 4：没有标签。'], '事件 <编号>（标签）：内容'],
    [['- 6 心事件之后：没有编号。'], '事件 <编号>（标签）：内容'],
  ] as const) {
    assert.throws(() => parseCard('abigail', [...base, ...bad].join('\n'), known), (error: unknown) => {
      assert.ok(error instanceof CardError && error.problems.some((p) => p.includes(problem)), String(error));
      return true;
    });
  }
});

test('every event a rule hides has an after-event line, so nothing goes blank once the rule lapses', async () => {
  const { roster } = await loadAll();
  for (const id of IDS) {
    const card = roster.get(id);
    const known = new Set(card.afterEvents.map((entry) => entry.event));
    const hidden = card.rules.flatMap((rule) => (rule.kind === 'unseen' ? rule.events : []));
    assert.deepEqual(hidden.filter((event) => !known.has(event)), [], id);
  }
});

test('a missing card is reported without stopping the others', async () => {
  const roster = new Roster({ directory: CARDS, npcIds: [...IDS, 'nobody'] });
  const result = await roster.load();
  assert.equal(result.loaded.length, 34);
  assert.deepEqual(result.errors.map((e) => e.file), ['nobody.md']);
});

test('a card broken during editing keeps its previous version on reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roster-'));
  try {
    await cp(CARDS, directory, { recursive: true });
    const roster = new Roster({ directory, npcIds: IDS });
    assert.equal((await roster.load()).errors.length, 0);
    const before = roster.get('abigail');
    await writeFile(join(directory, 'abigail.md'), '# 阿比盖尔\n\n写到一半\n');
    const result = await roster.load();
    assert.deepEqual(result.errors.map((e) => e.file), ['abigail.md']);
    assert.equal(roster.get('abigail'), before);
    assert.equal(result.loaded.length, 33);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
