/** Messages between the SMAPI mod and the backend (docs/game-bridge.md §3, design §10). */
import type { AmbientLine } from '../agent/ambient.ts';
import type { Bubble } from '../agent/bubbles.ts';
import type { Emotion, Season } from '../agent/dialogue.ts';
import { type Festival, FESTIVALS, type GrangeResult, SOUP_LEVELS } from '../agent/festivals.ts';
import { FRIENDSHIP_DAY_MAX, FRIENDSHIP_DAY_MIN } from '../agent/friendship.ts';
import { GIFT_TASTES, type GiftTaste } from '../agent/gifts.ts';
import { MAX_STOPS, type ScheduleStop } from '../agent/schedule.ts';
import type { DeliveredLetter } from '../agent/letters.ts';
import type { Helped, MineTrip } from '../agent/meetings.ts';
import type { SceneLine } from '../agent/scene.ts';
import type { Relation } from '../services/roster/index.ts';

export const PROTOCOL_VERSION = 3;

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
  /** Whom the player is engaged to, married to or living with, by game name (docs/world-public-facts.md). */
  partner?: { npc: string; status: 'engaged' | 'married' | 'roommate' } | null;
  /** Children living on the farm. */
  children?: number;
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

/**
 * Optional on `town.hour`, for scenes between the NPCs of a group (docs/scheduler.md §4.1): each group's place, each
 * NPC's hearts with the player by game name, and the weather. Without `hearts` the backend starts no scene.
 */
export interface Backstage { places?: string[]; hearts?: Record<string, number>; weather?: Weather; schedules?: Schedules }
/** Today's schedule of each NPC that has one, by game name (docs/npc-schedules.md); optional on scenes and town hours. */
export type Schedules = Record<string, ScheduleStop[]>;
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
    /** Mod setting; omitted by older protocol-3 clients, which keep the original enabled behavior. */
    inPersonGifts?: boolean;
    /** Its schedule today, if it follows one (docs/npc-schedules.md). */
    schedule?: ScheduleStop[];
    /** It is at the place it agreed to meet the player, at the agreed time (docs/npc-meetings.md). */
    atMeeting?: boolean;
    /** Farm chores it did there today (docs/npc-farm-help.md). */
    helped?: Helped;
    /** It is in a dungeon with the player now (docs/npc-mine-companion.md). */
    mine?: MineTrip;
    world: WorldSnapshot;
  } & Envelope)
  | ({ type: 'talk.say'; npc: string; text: string; date: GameDate } & Envelope)
  | ({ type: 'talk.close'; npc: string } & Envelope)
  /** A vanilla gift the NPC should remember (docs/npc-gifts.md); reliable like the save lifecycle, acknowledged with ack. */
  | ({ type: 'gift.given'; npc: string; item: string; taste: GiftTaste; birthday: boolean; date: GameDate } & Envelope)
  /** Two NPCs standing together near the player (docs/npc-chat.md); game names. */
  | ({ type: 'scene.request'; npcs: [string, string]; world: WorldSnapshot; schedules?: Schedules } & Envelope)
  /** The lines of that request have been shown, so news told in them is remembered (docs/npc-news.md); reliable, acknowledged. */
  | ({ type: 'scene.shown'; request: number; date: GameDate } & Envelope)
  /** Social NPCs who spent this hour together away from the player, by game name (docs/offscreen-news.md); reliable, acknowledged. */
  | ({ type: 'town.hour'; groups: string[][]; date: GameDate } & Backstage & Envelope)
  /** NPCs near the player, each to say at most one line (docs/ambient-lines.md); game names. */
  | ({ type: 'ambient.request'; npcs: AmbientNpc[]; world: WorldSnapshot } & Envelope)
  /** What happened at a festival the player just left (docs/festival-memories.md); game names. Reliable, acknowledged. */
  | ({ type: 'festival.ended' } & FestivalEnded & Envelope)
  /**
   * An appointment the NPC went to is over (docs/npc-meetings.md); `left` is HHMM. `friendship` is what the Mod changed for
   * it, within the day's range shared with conversations (docs/npc-meeting-friendship.md). Reliable, acknowledged.
   */
  | ({ type: 'meet.ended'; npc: string; place: string; time: number; left: number; met: boolean; helped?: Helped; mine?: MineTrip;
    friendship?: number; date: GameDate } & Envelope);

export interface FestivalEnded {
  festival: Festival;
  /** Social NPCs seen at the festival. */
  npcs: string[];
  dance: string | null;
  santa: { recipient: string; giver: string } | null;
  contest: 'player' | 'npc' | null;
  grange: GrangeResult | null;
  soup: number | null;
  date: GameDate;
}

export interface AmbientNpc {
  /** The game's internal name, e.g. "Pierre". */
  npc: string;
  hearts: number;
  relation: Relation;
  /** Already greeted the player over its head today. */
  greeted: boolean;
  /** Its schedule today, if it follows one (docs/npc-schedules.md). */
  schedule?: ScheduleStop[];
}

export type BackendMessage =
  | { type: 'hello'; protocol: number }
  | ({ type: 'save.ready'; day: number } & Envelope)
  | ({ type: 'ack' } & Envelope)
  | ({ type: 'sync.error'; message: string } & Partial<Envelope>)
  /** Today's lines to mutter when the player is near, by NPC id (docs/npc-bubbles.md); seq is 0. */
  | ({ type: 'day.bubbles'; npcs: Record<string, Bubble[]> } & Envelope)
  /** NPCs who walk over to the player today, by id, with the fewest hearts each needs (docs/npc-approach.md); seq is 0. */
  | ({ type: 'day.approach'; npcs: Record<string, number> } & Envelope)
  /**
   * Today's appointments with the player, by NPC id; HHMM and a place the Mod knows (docs/npc-meetings.md); seq is 0.
   * `sameDay` ones were agreed today and may come late; resent when a conversation settles one
   * (docs/npc-same-day-meetings.md). `calledOff` ones were taken back, or the NPC sent home, in a later conversation
   * (docs/npc-call-off.md).
   */
  | ({ type: 'day.meetings'; meetings: { npc: string; time: number; place: string; sameDay?: true; calledOff?: true }[] } & Envelope)
  /** At most one letter for the mailbox this morning (docs/npc-mail.md); seq is 0. */
  | ({ type: 'day.letters'; letters: DeliveredLetter[] } & Envelope)
  | ({ type: 'talk.delta'; npc: string; text: string } & Envelope)
  | TalkReply
  | ({ type: 'talk.error'; npc: string; message: string } & Envelope)
  /** Answers a scene.request with its seq; empty when nothing should be shown. */
  | ({ type: 'scene.lines'; lines: SceneLine[] } & Envelope)
  /** Answers an ambient.request with its seq; empty when nothing should be shown. */
  | ({ type: 'ambient.lines'; lines: AmbientLine[] } & Envelope);

export type TalkReply = {
  type: 'talk.reply'; npc: string; reply: string; emotion: Emotion; options: string[]; end: boolean;
  /** Points the Mod adds to vanilla friendship with this reply, already within the day's range (docs/npc-friendship.md). */
  friendship: number;
  /** A card gift the NPC hands over with this reply, by its name in the game (docs/npc-in-person-gifts.md). */
  gift?: string;
} & Envelope;

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
  const helped = (value: unknown) => {
    const h = value as Record<string, unknown> | null | undefined;
    if (h !== undefined && (!h || typeof h !== 'object' || Array.isArray(h)
      || ['watered', 'harvested', 'fed', 'ponds'].some(key => !Number.isSafeInteger(h[key]) || (h[key] as number) < 0 || (h[key] as number) > 100000)
      // The animals tended, from a Mod that does them (docs/npc-farm-animals.md).
      || ['collected', 'milked', 'sheared', 'petted', 'truffles'].some(key => h[key] !== undefined
        && (!Number.isSafeInteger(h[key]) || (h[key] as number) < 0 || (h[key] as number) > 100000)))) fail('helped is invalid');
  };
  const mine = (value: unknown) => {
    const m = value as Record<string, unknown> | null | undefined;
    if (m !== undefined && (!m || typeof m !== 'object' || Array.isArray(m)
      || ['floor', 'deepest', 'kills'].some(key => !Number.isSafeInteger(m[key]) || (m[key] as number) < 0 || (m[key] as number) > 100000)
      || (m.floor as number) > (m.deepest as number) || typeof m.fights !== 'boolean' || typeof m.rescued !== 'boolean')) fail('mine is invalid');
  };
  const isName = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 50 && !/[\u0000-\u001f]/u.test(value);
  const isSchedule = (value: unknown) => Array.isArray(value) && value.length <= MAX_STOPS && value.every((item) => {
    const stop = item as Record<string, unknown> | null;
    return !!stop && Number.isSafeInteger(stop.time) && (stop.time as number) >= 0 && (stop.time as number) <= 2800
      && (stop.time as number) % 100 <= 59 && isName(stop.place) && typeof stop.sleep === 'boolean';
  });
  const schedules = (value: unknown) => {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 34
      || Object.entries(value).some(([npc, stops]) => !isName(npc) || !isSchedule(stops)))) fail('schedules must map names to stops');
  };
  const world = (value: unknown) => {
    const w = value as Record<string, unknown> | null;
    if (!w || typeof w.location !== 'string' || !w.flags || typeof w.flags !== 'object') fail('world is invalid');
    const { partner, children } = w!.flags as Record<string, unknown>;
    const p = partner as Record<string, unknown> | null | undefined;
    if (p !== undefined && p !== null && (typeof p !== 'object' || typeof p.npc !== 'string' || !p.npc || p.npc.length > 50
      || /[\u0000-\u001f]/u.test(p.npc) || !['engaged', 'married', 'roommate'].includes(p.status as string))) fail('world.flags.partner is invalid');
    if (children !== undefined && (!Number.isSafeInteger(children) || (children as number) < 0 || (children as number) > 9)) fail('world.flags.children is invalid');
    date(w!.date);
    weather(w!.weather);
  };

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
      if (data.inPersonGifts !== undefined && typeof data.inPersonGifts !== 'boolean') fail('inPersonGifts must be a boolean');
      if (data.schedule !== undefined && !isSchedule(data.schedule)) fail('schedule must be a list of stops');
      if (data.atMeeting !== undefined && typeof data.atMeeting !== 'boolean') fail('atMeeting must be a boolean');
      helped(data.helped);
      mine(data.mine);
      world(data.world);
      break;
    }
    case 'meet.ended': {
      envelope();
      text('npc', 50);
      text('place', 20);
      for (const key of ['time', 'left']) {
        const time = int(data[key], key);
        if (time < 0 || time > 2600 || time % 100 > 59) fail(`${key} is invalid`);
      }
      if (typeof data.met !== 'boolean') fail('met must be a boolean');
      if (data.friendship !== undefined) {
        const points = int(data.friendship, 'friendship');
        if (points < FRIENDSHIP_DAY_MIN || points > FRIENDSHIP_DAY_MAX) fail('friendship is out of range');
      }
      helped(data.helped);
      mine(data.mine);
      date(data.date);
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
    case 'gift.given':
      envelope();
      text('npc', 50);
      text('item', 100);
      if (!GIFT_TASTES.includes(data.taste as GiftTaste)) fail('taste is invalid');
      if (typeof data.birthday !== 'boolean') fail('birthday must be a boolean');
      date(data.date);
      break;
    case 'town.hour': {
      envelope();
      date(data.date);
      const groups = data.groups;
      if (!Array.isArray(groups) || groups.length > 34 || groups.some((group) => !Array.isArray(group) || group.length < 2 || group.length > 34
        || group.some((npc) => typeof npc !== 'string' || !npc || npc.length > 50 || /[\u0000-\u001f]/u.test(npc)))) fail('groups must be lists of names');
      const { places, hearts } = data;
      if (places !== undefined && (!Array.isArray(places) || places.length !== (groups as unknown[]).length
        || places.some((place) => typeof place !== 'string' || place.length > 50 || /[\u0000-\u001f]/u.test(place)))) fail('places must name each group');
      if (hearts !== undefined && (!hearts || typeof hearts !== 'object' || Array.isArray(hearts) || Object.keys(hearts).length > 34
        || Object.entries(hearts).some(([npc, value]) => !isName(npc) || !Number.isSafeInteger(value) || value < 0 || value > 14))) fail('hearts must map names to 0–14');
      if (data.weather !== undefined) weather(data.weather);
      schedules(data.schedules);
      break;
    }
    case 'festival.ended': {
      envelope();
      date(data.date);
      if (!FESTIVALS.includes(data.festival as Festival)) fail('festival is invalid');
      if (!Array.isArray(data.npcs) || data.npcs.length > 64 || !data.npcs.every(isName)) fail('npcs must be a list of names');
      if (data.dance !== null && !isName(data.dance)) fail('dance must be a name or null');
      const santa = data.santa as Record<string, unknown> | null;
      if (santa !== null && (typeof santa !== 'object' || !isName(santa.recipient) || !isName(santa.giver))) fail('santa is invalid');
      if (data.contest !== null && data.contest !== 'player' && data.contest !== 'npc') fail('contest is invalid');
      if (data.grange !== null && data.grange !== 'shorts' && ![1, 2, 3, 4].includes(data.grange as number)) fail('grange is invalid');
      if (data.soup !== null && (!Number.isSafeInteger(data.soup) || (data.soup as number) < 0 || (data.soup as number) >= SOUP_LEVELS)) fail('soup is invalid');
      break;
    }
    case 'scene.shown':
      envelope();
      if (int(data.request, 'request') < 1) fail('request is out of range');
      date(data.date);
      break;
    case 'scene.request': {
      envelope();
      const npcs = data.npcs;
      if (!Array.isArray(npcs) || npcs.length !== 2
        || npcs.some((npc) => typeof npc !== 'string' || !npc || npc.length > 50 || /[\u0000-\u001f]/u.test(npc))) fail('npcs must be two names');
      schedules(data.schedules);
      world(data.world);
      break;
    }
    case 'ambient.request': {
      envelope();
      const npcs = data.npcs;
      if (!Array.isArray(npcs) || npcs.length < 1 || npcs.length > 4) fail('npcs must list one to four NPCs');
      for (const item of npcs as unknown[]) {
        const n = item as Record<string, unknown> | null;
        if (!n || typeof n.npc !== 'string' || !n.npc || n.npc.length > 50 || /[\u0000-\u001f]/u.test(n.npc)) fail('npcs[].npc must be a name');
        if (int(n!.hearts, 'npcs[].hearts') < 0 || (n!.hearts as number) > 14) fail('npcs[].hearts is out of range');
        if (!RELATIONS.has(n!.relation as Relation)) fail('npcs[].relation is invalid');
        if (typeof n!.greeted !== 'boolean') fail('npcs[].greeted must be a boolean');
        if (n!.schedule !== undefined && !isSchedule(n!.schedule)) fail('npcs[].schedule must be a list of stops');
      }
      world(data.world);
      break;
    }
    default:
      fail('unknown type');
  }
  return data as unknown as ModMessage;
}
