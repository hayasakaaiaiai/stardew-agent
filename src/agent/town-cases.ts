import { readFileSync } from 'node:fs';

export const TOWN_CASE_IDS = ['caroline_route_notes', 'clint_sample_labels', 'evelyn_blank_record', 'marnie_two_contexts'] as const;
export type TownCaseId = typeof TOWN_CASE_IDS[number];
interface InspectionBase { id: string; mode: 'site' | 'sample' | 'presence'; venue: string; label: string; hint: string; minutes: 10 }
export interface SiteInspection extends InspectionBase {
  mode: 'site'; site: { x: number; y: number; radius: number }; after?: string; laterDay?: true;
}
export interface SampleInspection extends InspectionBase { mode: 'sample'; itemId: string; itemLabel: string; count: 1 }
export interface PresenceInspection extends InspectionBase { mode: 'presence'; subject: 'marnie'; from: number; to: number }
export type TownCaseInspection = SiteInspection | SampleInspection | PresenceInspection;
export interface TownCaseDefinition {
  id: TownCaseId; kind: 'case'; owner: string; title: string; opening: string; references: string[];
  clues: { id: 'witness_a' | 'witness_b'; witness: string; label: string; text: string }[];
  inspections: TownCaseInspection[];
  endings: { id: 'a' | 'b'; label: string; title: string; text: string }[];
}

const RULES = {
  caroline_route_notes: { owner: 'caroline', witnesses: ['pierre', 'jodi'], inspections: [
    { id: 'square', mode: 'site', venue: 'Town', site: { x: 50, y: 68, radius: 5 } },
    { id: 'river', mode: 'site', venue: 'Forest', site: { x: 66, y: 50, radius: 5 } },
  ] },
  clint_sample_labels: { owner: 'clint', witnesses: ['emily', 'demetrius'], inspections: [
    { id: 'copper', mode: 'sample', venue: 'Blacksmith', itemId: '(O)378', count: 1 },
    { id: 'iron', mode: 'sample', venue: 'ScienceHouse', itemId: '(O)380', count: 1 },
  ] },
  evelyn_blank_record: { owner: 'evelyn', witnesses: ['george', 'alex'], inspections: [
    { id: 'first', mode: 'site', venue: 'Town', site: { x: 50, y: 68, radius: 5 } },
    { id: 'return', mode: 'site', venue: 'Town', site: { x: 50, y: 68, radius: 5 }, after: 'first', laterDay: true },
  ] },
  marnie_two_contexts: { owner: 'marnie', witnesses: ['shane', 'jodi'], inspections: [
    { id: 'ranch', mode: 'presence', venue: 'AnimalShop', subject: 'marnie', from: 900, to: 1600 },
    { id: 'saloon', mode: 'presence', venue: 'Saloon', subject: 'marnie', from: 1700, to: 2200 },
  ] },
} as const;
const WEATHER = ['sunny', 'rain', 'storm', 'snow', 'windy'];
function fail(message: string): never { throw new Error(`INVALID_TOWN_CASE: ${message}`); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim()
    && !/[\p{C}#$@%{}*^\[\]|]/u.test(value);
}
function minute(time: number): number { return Math.floor(time / 100) * 60 + time % 100; }

/** Fixed native checks, with authored prose shared by the backend and Mod. */
export function parseTownCaseDefinitions(value: unknown): TownCaseDefinition[] {
  if (!object(value) || !keys(value, ['version', 'cases']) || value.version !== 1 || !Array.isArray(value.cases)
    || value.cases.length !== TOWN_CASE_IDS.length) fail('definitions must contain all four cases');
  const seen = new Set<string>();
  return value.cases.map(raw => {
    if (!object(raw) || typeof raw.id !== 'string' || !TOWN_CASE_IDS.includes(raw.id as TownCaseId) || seen.has(raw.id)) fail('invalid or duplicate case ID');
    const rule = RULES[raw.id as TownCaseId]; seen.add(raw.id);
    if (!keys(raw, ['id', 'kind', 'owner', 'title', 'opening', 'references', 'clues', 'inspections', 'endings'])
      || raw.kind !== 'case' || raw.owner !== rule.owner || !text(raw.title, 80) || !text(raw.opening, 800)) fail('invalid case fields, owner or prose');
    if (!Array.isArray(raw.references) || raw.references.length < 6 || raw.references.length > 12
      || new Set(raw.references).size !== raw.references.length || raw.references.some(ref => typeof ref !== 'string'
        || !/^(?:data\/npcs\/[a-z]+|reference\/wiki\/(?:zh|en)\/[A-Za-z]+)\.md$/.test(ref))
      || [rule.owner, ...rule.witnesses].some(npc => !(raw.references as unknown[]).includes(`data/npcs/${npc}.md`)
        || !(raw.references as string[]).some(ref => new RegExp(`^reference/wiki/(?:zh|en)/${npc}\\.md$`, 'i').test(ref)))) fail('references must cover the owner and both witnesses');
    if (!Array.isArray(raw.clues) || raw.clues.length !== 2 || raw.clues.some((clue, i) => !object(clue)
      || !keys(clue, ['id', 'witness', 'label', 'text']) || clue.id !== ['witness_a', 'witness_b'][i]
      || clue.witness !== rule.witnesses[i] || !text(clue.label, 80) || !text(clue.text, 700))) fail('invalid case witnesses');
    if (!Array.isArray(raw.inspections) || raw.inspections.length !== 2) fail('each case needs two inspections');
    for (const [index, inspection] of raw.inspections.entries()) {
      const fixed = rule.inspections[index]!;
      const fields = Object.keys(fixed);
      if (!object(inspection) || !keys(inspection, [...fields, 'label', 'hint', 'minutes', ...(fixed.mode === 'sample' ? ['itemLabel'] : [])])
        || !text(inspection.label, 80) || !text(inspection.hint, 600) || inspection.minutes !== 10
        || fixed.mode === 'sample' && !text(inspection.itemLabel, 40)
        || fields.some(key => key === 'site' ? !object(inspection.site) || !keys(inspection.site, ['x', 'y', 'radius'])
          || fixed.mode !== 'site' || Object.entries(fixed.site).some(([name, expected]) => (inspection.site as Record<string, unknown>)[name] !== expected)
          : inspection[key] !== (fixed as unknown as Record<string, unknown>)[key])) fail('inspection rules do not match the fixed native case');
    }
    if (!Array.isArray(raw.endings) || raw.endings.length !== 2 || raw.endings.some((ending, i) => !object(ending)
      || !keys(ending, ['id', 'label', 'title', 'text']) || ending.id !== ['a', 'b'][i]
      || !text(ending.label, 80) || !text(ending.title, 100) || !text(ending.text, 2000))) fail('invalid case endings');
    return structuredClone(raw) as unknown as TownCaseDefinition;
  });
}

export const TOWN_CASE_DEFINITIONS: readonly TownCaseDefinition[] = parseTownCaseDefinitions(
  JSON.parse(readFileSync(new URL('../../data/town/cases.json', import.meta.url), 'utf8')),
);
export const TOWN_CASE_NPCS: readonly string[] = [...new Set(TOWN_CASE_DEFINITIONS.flatMap(definition =>
  [definition.owner, ...definition.clues.map(clue => clue.witness)]))];
export function townCaseDefinition(id: string): TownCaseDefinition | undefined { return TOWN_CASE_DEFINITIONS.find(definition => definition.id === id); }

/** Exact fields differ by native evidence mode; indoor checks never acquire global weather. */
export function townCaseInspectionKeys(definition: TownCaseDefinition, clueId: unknown): string[] | undefined {
  const inspection = definition.inspections.find(candidate => candidate.id === clueId);
  if (!inspection) return undefined;
  return ['clueId', 'venue', 'x', 'y', 'time', 'minutes', ...(inspection.mode === 'site'
    ? ['weather', ...(inspection.after ? ['sourceId'] : [])]
    : inspection.mode === 'sample' ? ['itemId', 'count'] : ['subject', 'subjectX', 'subjectY'])];
}

/** Source existence and cross-day prerequisites are checked by the shared story projection. */
export function validTownCaseInspection(raw: Record<string, unknown>, definition: TownCaseDefinition): boolean {
  const inspection = definition.inspections.find(candidate => candidate.id === raw.clueId);
  if (!inspection || raw.venue !== inspection.venue || raw.minutes !== 10 || !integer(raw.x, 0, 500) || !integer(raw.y, 0, 500)
    || !integer(raw.time, 600, 2200) || raw.time % 100 >= 60 || raw.time % 10 !== 0) return false;
  if (inspection.mode === 'site') return typeof raw.weather === 'string' && WEATHER.includes(raw.weather)
    && (!inspection.after || typeof raw.sourceId === 'string')
    && (raw.x - inspection.site.x) ** 2 + (raw.y - inspection.site.y) ** 2 <= inspection.site.radius ** 2;
  if (inspection.mode === 'sample') return raw.itemId === inspection.itemId && raw.count === 1;
  return raw.subject === inspection.subject && integer(raw.subjectX, 0, 500) && integer(raw.subjectY, 0, 500)
    && (raw.x - raw.subjectX) ** 2 + (raw.y - raw.subjectY) ** 2 <= 64
    && raw.time <= inspection.to && minute(raw.time) - 10 >= minute(inspection.from);
}
