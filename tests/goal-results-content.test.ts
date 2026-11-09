import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { GOAL_RESULT_DEFINITIONS } from '../src/agent/goal-results.ts';
import { LONG_GOAL_DEFINITIONS } from '../src/agent/long-goals.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';

const root = resolve(import.meta.dirname, '..');
const contentPath = resolve(root, 'data/town/goal-results.json');

test('each practice belongs to its authored collection and cites the correct existing character sources', async () => {
  const roster = new Roster({ directory: resolve(root, 'data/npcs'), npcIds: SOCIAL_NPCS });
  const loaded = await roster.load();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.loaded.length, 34);
  assert.deepEqual(GOAL_RESULT_DEFINITIONS.map(practice => practice.projectId), LONG_GOAL_DEFINITIONS.map(goal => goal.id));
  for (const practice of GOAL_RESULT_DEFINITIONS) {
    const source = LONG_GOAL_DEFINITIONS.find(goal => goal.id === practice.projectId)!;
    assert.equal(practice.owner, source.owner);
    assert.ok(roster.has(practice.owner));
    assert.ok(source.collectionTitle && source.chapters.length === 3);
    assert.ok(practice.references.includes(`data/npcs/${practice.owner}.md`));
    assert.ok(practice.references.some(path => new RegExp(`^reference/wiki/zh/${practice.owner}\\.md$`, 'i').test(path)));
    for (const path of practice.references) {
      assert.ok((await stat(resolve(root, path))).isFile(), `${practice.projectId}: missing ${path}`);
      assert.ok((await readFile(resolve(root, path), 'utf8')).trim());
      assert.doesNotMatch(path, /reference\/game/);
    }
  }
});

test('all seventy choices contain distinct complete safe text for actual native reading', () => {
  const allTexts: string[] = [];
  for (const practice of GOAL_RESULT_DEFINITIONS) {
    const prose = [practice.title, practice.venueLabel, practice.opening, practice.receiptIntro, practice.reviewIntro,
      ...practice.checkpoints.flatMap(point => [point.title, point.prompt])];
    const groups = [practice.planChoices, practice.finishChoices, practice.reviewChoices, ...practice.checkpoints.map(point => point.choices)];
    for (const group of groups) {
      assert.deepEqual(group.map(choice => choice.id), ['a', 'b']);
      assert.notEqual(group[0]!.label, group[1]!.label);
      assert.notEqual(group[0]!.text, group[1]!.text);
      assert.ok(!group[0]!.text.startsWith(group[1]!.text) && !group[1]!.text.startsWith(group[0]!.text),
        `${practice.owner}: direction cannot only add an acknowledgement to identical text`);
      for (const choice of group) {
        assert.ok(choice.text.length >= 25 && choice.text.length <= 400, `${practice.owner}: incomplete or excessive choice text`);
        assert.doesNotMatch(choice.text, /TODO|待补正文|这里填写|稍后生成/);
        prose.push(choice.label, choice.text);
        allTexts.push(choice.text);
      }
    }
    for (const text of prose) {
      assert.ok(text.length > 0 && text === text.trim());
      assert.doesNotMatch(text, /[\p{C}#$@%{}*^\[\]|]/u, `${practice.projectId}: native instruction character`);
    }
    for (const review of practice.reviewChoices) assert.match(review.text, /^回访批注：/);
  }
  assert.equal(allTexts.length, 70);
  assert.equal(new Set(allTexts).size, 70);
});

test('seven routes and authored action choices retain the agreed physical and factual boundaries', () => {
  assert.deepEqual(GOAL_RESULT_DEFINITIONS.map(practice => [practice.owner, practice.venue, practice.mode, practice.minutes, practice.checkpoints.length]), [
    ['penny', 'Forest', 'walk', 30, 2], ['elliott', 'Beach', 'walk', 30, 2], ['leah', 'Forest', 'walk', 30, 3],
    ['maru', 'Mountain', 'walk', 30, 2], ['robin', 'Town', 'walk', 30, 3], ['willy', 'Beach', 'fishing', 20, 1],
    ['linus', 'Forest', 'foraging', 20, 1],
  ]);
  assert.equal(GOAL_RESULT_DEFINITIONS.flatMap(practice => practice.checkpoints).length, 14);
  const linus = GOAL_RESULT_DEFINITIONS.find(practice => practice.owner === 'linus')!;
  assert.match(linus.checkpoints[0]!.choices[1]!.label, /至少两件/);
  assert.match(linus.checkpoints[0]!.choices[0]!.text, /不要求回到起点/);
  assert.doesNotMatch(linus.checkpoints[0]!.choices[1]!.text, /额外.*两件|回到起点/);
  const elliott = GOAL_RESULT_DEFINITIONS.find(practice => practice.owner === 'elliott')!;
  assert.match(elliott.receiptIntro, /虚构/);
  assert.match(elliott.receiptIntro, /实际同行/);
  for (const practice of GOAL_RESULT_DEFINITIONS.filter(practice => practice.mode === 'walk')) {
    assert.doesNotMatch(JSON.stringify(practice), /原地站满|原地停满|在这个点.*十分钟/);
  }
});

test('production backend and native distribution load one shared practice JSON', async () => {
  const raw = JSON.parse(await readFile(contentPath, 'utf8')) as { version: number; practices: unknown[] };
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.practices, GOAL_RESULT_DEFINITIONS);
  const projectPath = resolve(root, 'mod/StardewAgentBridge/StardewAgentBridge.csproj');
  const [project, native] = await Promise.all([
    readFile(projectPath, 'utf8'), readFile(resolve(root, 'mod/StardewAgentBridge/GoalResults.cs'), 'utf8'),
  ]);
  const source = project.replace(/<!--[\s\S]*?-->/g, '');
  const entries = [...source.matchAll(/<Content\b[^>]*>/g)].map(match =>
    Object.fromEntries([...match[0].matchAll(/(\w+)="([^"]*)"/g)].map(attribute => [attribute[1]!, attribute[2]!]))).filter(entry =>
      entry.Include && resolve(dirname(projectPath), entry.Include) === contentPath);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.Link, 'assets/goal-results.json');
  assert.ok(['PreserveNewest', 'Always'].includes(entries[0]!.CopyToOutputDirectory!));
  assert.match(native, /ReadJsonFile<[^>]+>\("assets\/goal-results\.json"\)/);
});
