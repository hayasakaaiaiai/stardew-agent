import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { TOWN_CASE_DEFINITIONS } from '../src/agent/town-cases.ts';
import { STORY_DEFINITIONS } from '../src/agent/town-stories.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';

const root = resolve(import.meta.dirname, '..');
const contentPath = resolve(root, 'data/town/cases.json');

test('four original cases cite real cards and wiki for every owner and both witnesses', async () => {
  const roster = new Roster({ directory: resolve(root, 'data/npcs'), npcIds: SOCIAL_NPCS });
  const loaded = await roster.load();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.loaded.length, 34);
  const people = new Set<string>();
  for (const story of TOWN_CASE_DEFINITIONS) {
    for (const npc of [story.owner, ...story.clues.map(clue => clue.witness)]) {
      people.add(npc);
      assert.ok(roster.has(npc));
      assert.ok(story.references.includes(`data/npcs/${npc}.md`));
      assert.ok(story.references.some(path => new RegExp(`^reference/wiki/zh/${npc}\\.md$`, 'i').test(path)));
    }
    assert.ok(!story.clues.some(clue => clue.witness === story.owner));
    assert.equal(new Set(story.references).size, story.references.length);
    for (const path of story.references) {
      assert.ok((await stat(resolve(root, path))).isFile(), `${story.id}: missing ${path}`);
      assert.ok((await readFile(resolve(root, path), 'utf8')).trim());
      assert.doesNotMatch(path, /reference\/game/);
    }
  }
  assert.equal(people.size, 11);
});

test('eight case conclusions contain full distinct native-safe resolution plans', () => {
  const endings = TOWN_CASE_DEFINITIONS.flatMap(story => story.endings);
  assert.equal(endings.length, 8);
  assert.equal(new Set(endings.map(ending => ending.text)).size, 8);
  for (const story of TOWN_CASE_DEFINITIONS) {
    assert.deepEqual(story.endings.map(ending => ending.id), ['a', 'b']);
    assert.notEqual(story.endings[0]!.label, story.endings[1]!.label);
    assert.notEqual(story.endings[0]!.title, story.endings[1]!.title);
    for (const ending of story.endings) {
      const length = [...ending.text.matchAll(/\p{Script=Han}/gu)].length;
      assert.ok(length >= 120 && length <= 240, `${story.id}/${ending.id}: expected a full resolution, found ${length} Han characters`);
      assert.doesNotMatch(ending.text, /TODO|待补全文|这里填写|稍后生成/);
    }
    const prose = [story.title, story.opening, ...story.clues.flatMap(clue => [clue.label, clue.text]),
      ...story.inspections.flatMap(inspection => [inspection.label, inspection.hint, ...(inspection.mode === 'sample' ? [inspection.itemLabel] : [])]),
      ...story.endings.flatMap(ending => [ending.label, ending.title, ending.text])];
    for (const text of prose) {
      assert.ok(text.length > 0 && text === text.trim());
      assert.doesNotMatch(text, /[\p{C}#$@%{}*^\[\]|]/u, `${story.id}: unsafe native dialogue instruction`);
    }
  }
});

test('case sites use existing anchors while sample and presence content preserve their evidence boundaries', async () => {
  assert.deepEqual(TOWN_CASE_DEFINITIONS.map(story => [story.owner, ...story.clues.map(clue => clue.witness)]), [
    ['caroline', 'pierre', 'jodi'], ['clint', 'emily', 'demetrius'], ['evelyn', 'george', 'alex'], ['marnie', 'shane', 'jodi'],
  ]);
  const samples = TOWN_CASE_DEFINITIONS.flatMap(story => story.inspections.filter(inspection => inspection.mode === 'sample'));
  assert.deepEqual(samples.map(sample => [sample.venue, sample.itemId, sample.count]), [['Blacksmith', '(O)378', 1], ['ScienceHouse', '(O)380', 1]]);
  for (const sample of samples) {
    assert.match(sample.itemLabel, /矿石$/);
    assert.match(sample.hint, /不消耗/);
  }
  const presence = TOWN_CASE_DEFINITIONS.flatMap(story => story.inspections.filter(inspection => inspection.mode === 'presence'));
  assert.deepEqual(presence.map(point => [point.venue, point.subject, point.from, point.to]),
    [['AnimalShop', 'marnie', 900, 1600], ['Saloon', 'marnie', 1700, 2200]]);
  const evelyn = TOWN_CASE_DEFINITIONS.find(story => story.owner === 'evelyn')!;
  const revisit = evelyn.inspections[1]!;
  assert.equal(revisit.mode, 'site');
  if (revisit.mode === 'site') { assert.equal(revisit.after, 'first'); assert.equal(revisit.laterDay, true); }
  assert.match(revisit.hint, /天气相同也可完成/);
  const meetings = await readFile(resolve(root, 'mod/StardewAgentBridge/Meetings.cs'), 'utf8');
  assert.match(meetings, /\["镇广场"\][^\n]*\("Town",\s*50,\s*68,/);
  assert.match(meetings, /\["森林河边"\][^\n]*\("Forest",\s*66,\s*50,/);
  const sites = TOWN_CASE_DEFINITIONS.flatMap(story => story.inspections.filter(inspection => inspection.mode === 'site'));
  for (const site of sites) {
    assert.deepEqual([site.venue, site.site.x, site.site.y, site.site.radius], site.id === 'river'
      ? ['Forest', 66, 50, 5] : ['Town', 50, 68, 5]);
  }
  assert.deepEqual(STORY_DEFINITIONS.map(story => story.id).sort(), ['elliott_short_piece', 'gus_parcel', 'penny_field_notes']);
});

test('native case packaging and production backend share the exact authored JSON', async () => {
  const raw = JSON.parse(await readFile(contentPath, 'utf8')) as { version: number; cases: unknown[] };
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.cases, TOWN_CASE_DEFINITIONS);
  const projectPath = resolve(root, 'mod/StardewAgentBridge/StardewAgentBridge.csproj');
  const [project, native] = await Promise.all([
    readFile(projectPath, 'utf8'), readFile(resolve(root, 'mod/StardewAgentBridge/TownCases.cs'), 'utf8'),
  ]);
  const source = project.replace(/<!--[\s\S]*?-->/g, '');
  const entries = [...source.matchAll(/<Content\b[^>]*>/g)].map(match =>
    Object.fromEntries([...match[0].matchAll(/(\w+)="([^"]*)"/g)].map(attribute => [attribute[1]!, attribute[2]!]))).filter(entry =>
      entry.Include && resolve(dirname(projectPath), entry.Include) === contentPath);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.Link, 'assets/town-cases.json');
  assert.ok(['PreserveNewest', 'Always'].includes(entries[0]!.CopyToOutputDirectory!));
  assert.match(native, /ReadJsonFile<[^>]+>\("assets\/town-cases\.json"\)/);
});
