import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { ROMANCE_NPCS, ROMANCE_PROFILES } from '../src/agent/romance.ts';
import { Roster } from '../src/services/roster/index.ts';
import { SOCIAL_NPCS } from '../src/types.ts';

const root = resolve(import.meta.dirname, '..');
const profilePath = resolve(root, 'data/romance/profiles.json');

test('romance content points to existing source files and its own loaded character card', async () => {
  const roster = new Roster({ directory: resolve(root, 'data/npcs'), npcIds: SOCIAL_NPCS });
  const loaded = await roster.load();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.loaded.length, 34);
  const placeWords = { Forest: /林/, Beach: /海|沙滩/, Town: /镇/, Mountain: /山|湖/ };
  for (const profile of ROMANCE_PROFILES) {
    assert.ok(roster.has(profile.id), profile.id);
    assert.equal(profile.name, roster.get(profile.id).name, `${profile.id}: display name must match its card`);
    assert.ok(profile.references.includes(`data/npcs/${profile.id}.md`), `${profile.id}: missing own card source`);
    assert.ok(profile.references.some(path => new RegExp(`^reference/wiki/(?:zh|en)/${profile.id}\\.md$`, 'i').test(path)),
      `${profile.id}: missing own wiki source`);
    for (const path of profile.references) {
      assert.ok((await stat(resolve(root, path))).isFile(), `${profile.id}: missing source ${path}`);
      assert.ok((await readFile(resolve(root, path), 'utf8')).trim(), `${profile.id}: empty source ${path}`);
    }
    for (const venue of profile.venues)
      assert.match(venue.label, placeWords[venue.map], `${profile.id}: displayed destination must describe ${venue.map}`);
  }
});

function nativeStringSet(source: string, name: string): string[] {
  const declaration = new RegExp(`HashSet<string>\\s+${name}\\s*=[^;]*?\\{([^}]*)\\}`, 's').exec(source);
  assert.ok(declaration, `missing native ${name} whitelist`);
  return [...declaration[1]!.matchAll(/"([^"\\]*)"/g)].map(match => match[1]!);
}

test('native romance eligibility and destinations cover the same shared profile content', async () => {
  const rules = await readFile(resolve(root, 'mod/StardewAgentBridge/RomanceRules.cs'), 'utf8');
  const nativeNpcs = nativeStringSet(rules, 'Npcs');
  assert.deepEqual([...nativeNpcs].sort(), [...ROMANCE_NPCS].sort());
  assert.deepEqual([...nativeNpcs].sort(), ROMANCE_PROFILES.map(profile => profile.id).sort());
  const nativeVenues = new Set(nativeStringSet(rules, 'Venues'));
  for (const profile of ROMANCE_PROFILES)
    for (const venue of profile.venues) assert.ok(nativeVenues.has(venue.map), `${profile.id}: Mod cannot count time at ${venue.map}`);
});

test('MSBuild distributes the same JSON used by the backend at the path read by the Mod', async () => {
  const projectPath = resolve(root, 'mod/StardewAgentBridge/StardewAgentBridge.csproj');
  const [project, native, shared] = await Promise.all([
    readFile(projectPath, 'utf8'),
    readFile(resolve(root, 'mod/StardewAgentBridge/Romance.cs'), 'utf8'),
    readFile(profilePath, 'utf8'),
  ]);
  const source = project.replace(/<!--[\s\S]*?-->/g, '');
  const content = [...source.matchAll(/<Content\b[^>]*>/g)].map(match =>
    Object.fromEntries([...match[0].matchAll(/(\w+)="([^"]*)"/g)].map(attribute => [attribute[1]!, attribute[2]!])))
    .filter(attributes => attributes.Include && resolve(dirname(projectPath), attributes.Include) === profilePath);
  assert.equal(content.length, 1, 'deploy exactly one source JSON rather than an independently maintained copy');
  const item = content[0]!;
  assert.ok(item.CopyToOutputDirectory === 'PreserveNewest' || item.CopyToOutputDirectory === 'Always', 'shared JSON must be copied into build output');
  const assetPath = /ReadJsonFile<[^;]+?>\("([^"]*romance[^"]*\.json)"\)/.exec(native)?.[1];
  assert.ok(assetPath, 'native profile loader must have a declared asset path');
  assert.equal(item.Link, assetPath, 'deployed JSON name must match the native loader');
  assert.deepEqual(JSON.parse(shared), ROMANCE_PROFILES, 'backend and Mod must consume the same content');
});
