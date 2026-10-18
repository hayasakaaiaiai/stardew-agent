/** Messages between the SMAPI mod and the backend (docs/game-bridge.md §3, design §10). */
import type { Emotion, Season } from '../agent/dialogue.ts';
import type { Relation } from '../services/roster/index.ts';

export const PROTOCOL_VERSION = 1;

/** Every mod message carries these; M3a records them, M3b uses `seq` for replay and dedupe. */
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

export type ModMessage =
  | { type: 'hello'; modVersion: string; protocol: number }
  | ({ type: 'save.loaded'; player: PlayerInfo } & Envelope)
  | ({ type: 'day.started'; date: GameDate; weather: Weather } & Envelope)
  | ({
    type: 'talk.open';
    /** The game's internal name, e.g. "Abigail". */
    npc: string;
    hearts: number;
    relation: Relation;
    seenEvents: string[];
    world: WorldSnapshot;
  } & Envelope)
  | ({ type: 'talk.say'; npc: string; text: string } & Envelope)
  | ({ type: 'talk.close'; npc: string } & Envelope);

export type BackendMessage =
  | { type: 'hello'; protocol: number }
  | { type: 'talk.delta'; npc: string; text: string }
  | { type: 'talk.reply'; npc: string; reply: string; emotion: Emotion; options: string[]; end: boolean }
  | { type: 'talk.error'; npc: string; message: string };

const RELATIONS = new Set<Relation>(['stranger', 'friend', 'dating', 'engaged', 'married', 'roommate']);
const SEASONS = new Set<Season>(['spring', 'summer', 'fall', 'winter']);
const WEATHERS = new Set<Weather>(['sunny', 'rain', 'storm', 'snow', 'windy']);

/** Throws on anything malformed, so handlers only see well-typed messages. */
export function parseModMessage(raw: string): ModMessage {
  const data = JSON.parse(raw) as Record<string, unknown>;
  const fail = (why: string): never => { throw new Error(`Bad ${String(data?.type)} message: ${why}`); };
  const text = (key: string, max = 2000) => {
    const value = data[key];
    if (typeof value !== 'string' || value.length > max) fail(`${key} must be a string up to ${max} characters`);
    return value as string;
  };
  const int = (value: unknown, key: string) => {
    if (!Number.isSafeInteger(value)) fail(`${key} must be an integer`);
    return value as number;
  };
  const envelope = () => {
    text('lineageId', 200);
    text('loadNonce', 200);
    int(data.seq, 'seq');
  };
  const date = (value: unknown) => {
    const d = value as Record<string, unknown> | null;
    if (!d || !SEASONS.has(d.season as Season)) fail('date.season is invalid');
    int(d!.year, 'date.year'); int(d!.day, 'date.day'); int(d!.time, 'date.time');
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
      break;
    }
    case 'day.started':
      envelope();
      date(data.date);
      weather(data.weather);
      break;
    case 'talk.open': {
      envelope();
      text('npc', 50);
      int(data.hearts, 'hearts');
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
