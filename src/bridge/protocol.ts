/** Messages between the SMAPI mod and the backend (docs/game-bridge.md §3, design §10). */
import type { Bubble } from '../agent/bubbles.ts';
import type { Emotion, Season } from '../agent/dialogue.ts';
import type { DeliveredLetter } from '../agent/letters.ts';
import type { Relation } from '../services/roster/index.ts';

export const PROTOCOL_VERSION = 2;

/** seq=0 is reserved for the connection handshake; game events increase within one load. */
export interface Envelope {
  lineageId: string;
  loadNonce: string;
  seq: number;
}

export type Weather = 'sunny' | 'rain' | 'storm' | 'snow' | 'windy';

export interface GameDate {
  year: number;
  season: Season;
  day: number;
  /** The game's HHMM clock, e.g. 1530; it runs past midnight up to 2600. */
  time: number;
}

/** Raw game state; the backend turns it into the prose facts the model reads (src/bridge/world.ts). */
export interface WorldFlags {
  communityCenter: 'pending' | 'restored' | 'joja';
  busRepaired: boolean;
  understandsDwarves: boolean;
  pamHouse: boolean;
  islandOpen: boolean;
  leoMoved: boolean;
}

export interface WorldSnapshot {
  date: GameDate;
  weather: Weather;
  /** The location's display name, already in the game language. */
  location: string;
  flags: WorldFlags;
}

export interface PlayerInfo {
  name: string;
  gender: 'male' | 'female';
  farm: string;
}

export interface SavePointer {
  commitId: string;
  parentId: string | null;
  dayEnded: number;
}

export type LoadedSave = { type: 'save.loaded'; player: PlayerInfo; date: GameDate; commit: SavePointer | null } & Envelope;

export type ModMessage =
  | { type: 'hello'; modVersion: string; protocol: number }
  | LoadedSave
  | ({ type: 'day.started'; date: GameDate; weather: Weather } & Envelope)
  | ({ type: 'save.saving'; commit: SavePointer } & Envelope)
  | ({ type: 'save.saved'; commitId: string; date: GameDate } & Envelope)
  | ({ type: 'title.returned' } & Envelope)
  | ({
    type: 'talk.open';
    /** The game's internal name, e.g. "Abigail". */
    npc: string;
    hearts: number;
    relation: Relation;
    seenEvents: string[];
    world: WorldSnapshot;
  } & Envelope)
  | ({ type: 'talk.say'; npc: string; text: string; date: GameDate } & Envelope)
  | ({ type: 'talk.close'; npc: string } & Envelope);

export type BackendMessage =
  | { type: 'hello'; protocol: number }
  | ({ type: 'save.ready'; day: number } & Envelope)
  | ({ type: 'ack' } & Envelope)
  | ({ type: 'sync.error'; message: string } & Partial<Envelope>)
  /** Today's lines to mutter when the player is near, by NPC id (docs/npc-bubbles.md); seq is 0. */
  | ({ type: 'day.bubbles'; npcs: Record<string, Bubble[]> } & Envelope)
  /** At most one letter for the mailbox this morning (docs/npc-mail.md); seq is 0. */
  | ({ type: 'day.letters'; letters: DeliveredLetter[] } & Envelope)
  | ({ type: 'talk.delta'; npc: string; text: string } & Envelope)
  | TalkReply
  | ({ type: 'talk.error'; npc: string; message: string } & Envelope);

export type TalkReply = { type: 'talk.reply'; npc: string; reply: string; emotion: Emotion; options: string[]; end: boolean } & Envelope;

export function absoluteDay(date: Pick<GameDate, 'year' | 'season' | 'day'>): number {
  return (date.year - 1) * 112 + ['spring', 'summer', 'fall', 'winter'].indexOf(date.season) * 28 + date.day;
}

export function gameMinutes(date: GameDate): number {
  return absoluteDay(date) * 1440 + (Math.floor(date.time / 100) % 24) * 60 + date.time % 100;
}

const RELATIONS = new Set<Relation>(['stranger', 'friend', 'dating', 'engaged', 'married', 'roommate']);
const SEASONS = new Set<Season>(['spring', 'summer', 'fall', 'winter']);
const WEATHERS = new Set<Weather>(['sunny', 'rain', 'storm', 'snow', 'windy']);

/** Throws on anything malformed, so handlers only see well-typed messages. */
export function parseModMessage(raw: string): ModMessage {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a message object');
  const data = value as Record<string, unknown>;
  const fail = (why: string): never => { throw new Error(`Bad ${String(data?.type)} message: ${why}`); };
  const text = (key: string, max = 2000) => {
    const value = data[key];
    if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f]/u.test(value)) fail(`${key} must be a non-empty string up to ${max} characters`);
    return value as string;
  };
  const int = (value: unknown, key: string) => {
    if (!Number.isSafeInteger(value)) fail(`${key} must be an integer`);
    return value as number;
  };
  const envelope = () => {
    text('lineageId', 200);
    text('loadNonce', 200);
    if (int(data.seq, 'seq') < (data.type === 'save.loaded' ? 0 : 1)) fail('seq is out of range');
  };
  const date = (value: unknown) => {
    const d = value as Record<string, unknown> | null;
    if (!d || !SEASONS.has(d.season as Season)) fail('date.season is invalid');
    if (int(d!.year, 'date.year') < 1 || int(d!.day, 'date.day') < 1 || (d!.day as number) > 28) fail('date is out of range');
    const time = int(d!.time, 'date.time');
    if (time < 0 || time > 2600 || time % 100 > 59) fail('date.time is invalid');
  };
  const pointer = (value: unknown) => {
    const p = value as Record<string, unknown> | null;
    if (!p || typeof p.commitId !== 'string' || !p.commitId.length || p.commitId.length > 200
      || /[\u0000-\u001f]/u.test(p.commitId)
      || (p.parentId !== null && (typeof p.parentId !== 'string' || !p.parentId.length || p.parentId.length > 200 || /[\u0000-\u001f]/u.test(p.parentId)))) fail('commit is invalid');
    if (int(p!.dayEnded, 'commit.dayEnded') < 1) fail('commit.dayEnded is invalid');
  };
  const weather = (value: unknown) => { if (!WEATHERS.has(value as Weather)) fail('weather is invalid'); };

  switch (data.type) {
    case 'hello':
      text('modVersion', 50);
      int(data.protocol, 'protocol');
      break;
    case 'save.loaded': {
      envelope();
      const player = data.player as Record<string, unknown> | null;
      if (!player || typeof player.name !== 'string' || typeof player.farm !== 'string'
        || (player.gender !== 'male' && player.gender !== 'female')) fail('player is invalid');
      if (data.seq !== 0) fail('save.loaded requires seq=0');
      date(data.date);
      if (data.commit !== null) pointer(data.commit);
      break;
    }
    case 'save.saving':
      envelope(); pointer(data.commit); break;
    case 'save.saved':
      envelope(); text('commitId', 200); date(data.date); break;
    case 'title.returned':
      envelope(); break;
    case 'day.started':
      envelope();
      date(data.date);
      weather(data.weather);
      break;
    case 'talk.open': {
      envelope();
      text('npc', 50);
      int(data.hearts, 'hearts');
      if ((data.hearts as number) < 0 || (data.hearts as number) > 14) fail('hearts is out of range');
      if (!RELATIONS.has(data.relation as Relation)) fail('relation is invalid');
      if (!Array.isArray(data.seenEvents) || data.seenEvents.some((e) => typeof e !== 'string')) fail('seenEvents must be strings');
      const world = data.world as Record<string, unknown> | null;
      if (!world || typeof world.location !== 'string' || !world.flags || typeof world.flags !== 'object') fail('world is invalid');
      date(world!.date);
      weather(world!.weather);
      break;
    }
    case 'talk.say':
      envelope();
      text('npc', 50);
      text('text', 500);
      date(data.date);
      break;
    case 'talk.close':
      envelope();
      text('npc', 50);
      break;
    default:
      fail('unknown type');
  }
  return data as unknown as ModMessage;
}
