import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { LONG_GOAL_DEFINITIONS } from '../src/agent/long-goals.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';

const root = resolve(import.meta.dirname, '..');
const contentPath = resolve(root, 'data/town/long-goals.json');
const hanCount = (text: string): number => [...text.matchAll(/\p{Script=Han}/gu)].length;
const pairs = (text: string): Set<string> => new Set(Array.from(text, (_, index) => text.slice(index, index + 2)));
function sharedPairs(a: string, b: string): number {
  const first = pairs(a), second = pairs(b);
  const shared = [...first].filter(value => second.has(value)).length;
  return shared / Math.min(first.size, second.size);
}

test('long goal content cites existing owner cards and wiki without private game exports', async () => {
  const roster = new Roster({ directory: resolve(root, 'data/npcs'), npcIds: SOCIAL_NPCS });
  const loaded = await roster.load();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.loaded.length, 34);
  for (const goal of LONG_GOAL_DEFINITIONS) {
    assert.ok(roster.has(goal.owner));
    assert.ok(goal.references.includes(`data/npcs/${goal.owner}.md`));
    assert.ok(goal.references.some(path => new RegExp(`^reference/wiki/zh/${goal.owner}\\.md$`, 'i').test(path)));
    for (const path of goal.references) {
      assert.ok((await stat(resolve(root, path))).isFile(), `${goal.id}: missing ${path}`);
      assert.ok((await readFile(resolve(root, path), 'utf8')).trim());
      assert.doesNotMatch(path, /reference\/game/);
    }
  }
});

test('all sixty-three chapter outputs are full distinct prose safe for native dialogue', () => {
  const outputs = LONG_GOAL_DEFINITIONS.flatMap(goal => goal.chapters.flatMap(chapter => chapter.outputs));
  assert.equal(outputs.length, 63);
  assert.equal(new Set(outputs.map(output => output.text)).size, 63);
  for (const goal of LONG_GOAL_DEFINITIONS) {
    const prose = [goal.title, goal.opening, goal.collectionTitle, goal.collectionIntro, goal.collectionClosing];
    for (const chapter of goal.chapters) {
      prose.push(chapter.title, chapter.opening, ...chapter.choices.flatMap(choice => [choice.label, choice.text]),
        ...chapter.outputs.flatMap(output => [output.title, output.text]));
      const contribution = chapter.contribution;
      prose.push(...(contribution.kind === 'observation' ? [contribution.hint, ...contribution.venues.map(venue => venue.label)]
        : [contribution.label, contribution.purpose]));
      for (const output of chapter.outputs) {
        const length = hanCount(output.text);
        assert.ok(length >= 120 && length <= 220, `${goal.id}/${chapter.id}/${output.id}: ${length} Han characters`);
        assert.doesNotMatch(output.text, /TODO|待补全文|这里填|稍后生成/);
      }
      // Direction changes must affect the prose, not just append one acknowledgement sentence.
      for (let first = 0; first < chapter.outputs.length; first++) {
        for (let second = first + 1; second < chapter.outputs.length; second++) {
          assert.ok(sharedPairs(chapter.outputs[first]!.text, chapter.outputs[second]!.text) < 0.7,
            `${goal.id}/${chapter.id}: output variants are mostly the same prose`);
        }
      }
      const neutral = chapter.outputs.find(output => output.id === 'default')!;
      assert.doesNotMatch(neutral.text, /你没有帮|农场主没有|没有收到.*材料|没有人帮|独自完成|全靠我自己/,
        'default may still include a real contribution without a selected direction');
    }
    for (const text of prose) {
      assert.equal(text, text.trim());
      assert.ok(text.length > 0);
      assert.doesNotMatch(text, /[\p{C}#$@%{}*^\[\]|]/u, `${goal.id}: native command character`);
    }
  }
});

test('the catalogue mixes sixteen observations with five exact optional material contributions', () => {
  const chapters = LONG_GOAL_DEFINITIONS.flatMap(goal => goal.chapters);
  const materials = LONG_GOAL_DEFINITIONS.flatMap(goal => goal.chapters.flatMap(chapter =>
    chapter.contribution.kind === 'material' ? [[goal.owner, chapter.id, chapter.contribution.itemId, chapter.contribution.count]] : []));
  assert.equal(chapters.filter(chapter => chapter.contribution.kind === 'observation').length, 16);
  assert.deepEqual(materials, [['leah', 2, '(O)388', 4], ['maru', 2, '(O)334', 2], ['robin', 2, '(O)388', 8],
    ['willy', 2, '(O)388', 4], ['linus', 2, '(O)388', 3]]);
  for (const goal of LONG_GOAL_DEFINITIONS) {
    const maps = goal.chapters.flatMap(chapter => chapter.contribution.kind === 'observation'
      ? chapter.contribution.venues.map(venue => venue.map) : []);
    assert.equal(new Set(maps).size, maps.length, `${goal.id}: each observation should add another setting`);
    assert.doesNotMatch(goal.collectionTitle, /已建成|奖励|蓝图解锁/);
    assert.ok(!goal.workVenues.includes('FarmHouse'), 'spouse compatibility is verified by native state, not a public work site');
    assert.ok(!goal.workVenues.includes('Museum') && !goal.workVenues.includes('MaruRoom'));
  }
  const fiction = LONG_GOAL_DEFINITIONS.find(goal => goal.owner === 'elliott')!;
  assert.match(fiction.collectionIntro, /虚构/);
  assert.match(fiction.collectionIntro, /不代表/);
});

test('backend and packaged native loader use the exact same complete long goal catalogue', async () => {
  const raw = JSON.parse(await readFile(contentPath, 'utf8')) as { version: number; goals: unknown[] };
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.goals, LONG_GOAL_DEFINITIONS);
  const projectPath = resolve(root, 'mod/StardewAgentBridge/StardewAgentBridge.csproj');
  const [project, native] = await Promise.all([
    readFile(projectPath, 'utf8'), readFile(resolve(root, 'mod/StardewAgentBridge/LongGoals.cs'), 'utf8'),
  ]);
  const source = project.replace(/<!--[\s\S]*?-->/g, '');
  const entries = [...source.matchAll(/<Content\b[^>]*>/g)].map(match =>
    Object.fromEntries([...match[0].matchAll(/(\w+)="([^"]*)"/g)].map(attribute => [attribute[1]!, attribute[2]!]))).filter(entry =>
      entry.Include && resolve(dirname(projectPath), entry.Include) === contentPath);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.Link, 'assets/long-goals.json');
  assert.ok(['PreserveNewest', 'Always'].includes(entries[0]!.CopyToOutputDirectory!));
  assert.match(native, /ReadJsonFile<[^>]+>\("assets\/long-goals\.json"\)/);
});
