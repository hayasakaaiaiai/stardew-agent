import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { STORY_DEFINITIONS } from '../src/agent/town-stories.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';

const root = resolve(import.meta.dirname, '..');
const contentPath = resolve(root, 'data/town/stories.json');
interface StoryContent {
  id: string;
  kind: 'investigation' | 'project';
  owner: string;
  title: string;
  opening: string;
  references: string[];
  clues?: { id: string; witness?: string; text: string }[];
  site?: { map: string; x: number; y: number; radius: number; label: string; hint: string };
  observationVenues?: { map: string; label: string }[];
  workVenues?: string[];
  choices?: { id: string; label: string; text: string }[];
  endings: { id: string; title: string; text: string }[];
}
async function stories(): Promise<StoryContent[]> {
  const content = JSON.parse(await readFile(contentPath, 'utf8')) as { version: number; stories: StoryContent[] };
  assert.equal(content.version, 1);
  return content.stories;
}

test('town stories cite existing cards and wiki sources for every owner and witness', async () => {
  const roster = new Roster({ directory: resolve(root, 'data/npcs'), npcIds: SOCIAL_NPCS });
  const loaded = await roster.load();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.loaded.length, 34);
  for (const story of await stories()) {
    const people = [story.owner, ...(story.clues ?? []).flatMap(clue => clue.witness ? [clue.witness] : [])];
    for (const person of people) {
      assert.ok(roster.has(person), `${story.id}: unknown owner or witness ${person}`);
      assert.ok(story.references.includes(`data/npcs/${person}.md`), `${story.id}: missing ${person} card`);
      assert.ok(story.references.some(path => new RegExp(`^reference/wiki/(?:zh|en)/${person}\\.md$`, 'i').test(path)),
        `${story.id}: missing ${person} wiki source`);
    }
    for (const path of story.references) {
      assert.ok((await stat(resolve(root, path))).isFile(), `${story.id}: missing reference ${path}`);
      assert.ok((await readFile(resolve(root, path), 'utf8')).trim(), `${story.id}: empty reference ${path}`);
    }
  }
});

test('all story outcomes are complete native-readable artifacts with no dialogue command characters', async () => {
  const content = await stories();
  assert.deepEqual(content.map(story => story.id).sort(), ['elliott_short_piece', 'gus_parcel', 'penny_field_notes']);
  for (const story of content) {
    const prose = [story.title, story.opening, ...(story.clues ?? []).map(clue => clue.text),
      ...(story.choices ?? []).flatMap(choice => [choice.label, choice.text]),
      ...story.endings.flatMap(ending => [ending.title, ending.text]),
      ...(story.site ? [story.site.label, story.site.hint] : []),
      ...(story.observationVenues ?? []).map(venue => venue.label)];
    for (const value of prose) {
      assert.ok(value.trim().length > 0 && value.length <= 240, `${story.id}: blank or oversized native prose`);
      assert.doesNotMatch(value, /[\p{C}#$@%{}*^\[\]|]/u, `${story.id}: native dialogue instruction in content`);
    }
    const outcomes = story.kind === 'investigation' ? ['explained', 'returned']
      : ['independent', ...story.choices!.map(choice => choice.id)].sort();
    assert.deepEqual(story.endings.map(ending => ending.id).sort(), outcomes, `${story.id}: missing playable conclusion`);
    assert.equal(new Set(story.endings.map(ending => ending.text)).size, story.endings.length, `${story.id}: outcomes need distinct content`);
    if (story.kind === 'project') {
      for (const ending of story.endings) assert.ok(ending.text.length >= 70, `${story.id}: result must contain the full readable artifact`);
    }
    if (story.id === 'penny_field_notes') {
      for (const ending of story.endings) for (const part of ['一、', '二、', '三、']) assert.ok(ending.text.includes(part), `${ending.id}: missing worksheet question`);
    }
  }
});

test('story investigation roles and destinations use the confirmed native map identifiers', async () => {
  const content = await stories();
  const parcel = content.find(story => story.id === 'gus_parcel')!;
  assert.deepEqual(parcel.clues!.map(clue => [clue.id, clue.witness ?? null]),
    [['emily_mark', 'emily'], ['pierre_mark', 'pierre'], ['parcel', null]]);
  assert.deepEqual(parcel.site && { map: parcel.site.map, x: parcel.site.x, y: parcel.site.y, radius: parcel.site.radius },
    { map: 'Town', x: 50, y: 68, radius: 5 });
  const penny = content.find(story => story.id === 'penny_field_notes')!;
  assert.deepEqual(penny.workVenues, ['Trailer', 'Trailer_Big', 'ArchaeologyHouse', 'Town']);
  assert.deepEqual(penny.observationVenues!.map(venue => venue.map), ['Forest', 'Town']);
  const elliott = content.find(story => story.id === 'elliott_short_piece')!;
  assert.deepEqual(elliott.workVenues, ['ElliottHouse', 'Beach']);
  assert.deepEqual(elliott.observationVenues!.map(venue => venue.map), ['Beach', 'Forest']);
  const meetings = await readFile(resolve(root, 'mod/StardewAgentBridge/Meetings.cs'), 'utf8');
  assert.match(meetings, /\["博物馆"\][^\n]*\("ArchaeologyHouse",/, 'work uses the existing verified museum internal map');
  assert.match(meetings, /\["镇广场"\][^\n]*\("Town",\s*50,\s*68,/, 'investigation uses the existing verified town square');
});

test('MSBuild and the native loader use the same story JSON as the production backend', async () => {
  const projectPath = resolve(root, 'mod/StardewAgentBridge/StardewAgentBridge.csproj');
  const [project, native] = await Promise.all([
    readFile(projectPath, 'utf8'), readFile(resolve(root, 'mod/StardewAgentBridge/TownStories.cs'), 'utf8'),
  ]);
  const source = project.replace(/<!--[\s\S]*?-->/g, '');
  const content = [...source.matchAll(/<Content\b[^>]*>/g)].map(match =>
    Object.fromEntries([...match[0].matchAll(/(\w+)="([^"]*)"/g)].map(attribute => [attribute[1]!, attribute[2]!])))
    .filter(attributes => attributes.Include && resolve(dirname(projectPath), attributes.Include) === contentPath);
  assert.equal(content.length, 1, 'deploy one shared configuration rather than a separately edited copy');
  const assetPath = /ReadJsonFile<[^;]+?>\("([^"]*town-stories[^\"]*\.json)"\)/.exec(native)?.[1];
  assert.ok(assetPath, 'the native story loader needs an explicit asset path');
  assert.equal(content[0]!.Link, assetPath);
  assert.ok(['PreserveNewest', 'Always'].includes(content[0]!.CopyToOutputDirectory!));
  assert.deepEqual(await stories(), STORY_DEFINITIONS, 'the backend must parse the exact JSON distributed to the Mod');
});
