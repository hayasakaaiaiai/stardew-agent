/**
 * The robot's faces (docs/companion-device.md §3.3, §14). xiaozhi keeps fonts, the wake word model and emoji in
 * one "assets" flash partition and replaces all of it on download, so an NPC's pack is the firmware's own
 * default assets with the emoji pictures swapped for that NPC's portraits. Layout as in xiaozhi v2.5.0
 * main/assets.cc: a 12-byte header (file count, checksum, length), 44-byte table entries, then each file
 * behind a "ZZ" marker.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Emotion } from '../agent/dialogue.ts';

export interface AssetFile {
  name: string;
  data: Buffer;
}

const HEADER = 12;
const ENTRY = 44;
const NAME = 32;
const MARKER = Buffer.from('ZZ');
/** Where ESP-IDF puts the partition table in a merged firmware image. */
const PARTITION_TABLE = 0x8000;

/** The firmware's own check: the low 16 bits of the byte sum after the header. */
function checksum(data: Buffer): number {
  let sum = 0;
  for (const byte of data) sum += byte;
  return sum & 0xffff;
}

export function parseAssets(image: Buffer): AssetFile[] {
  if (image.length < HEADER) throw new Error('Assets image is too short');
  const count = image.readUInt32LE(0);
  const length = image.readUInt32LE(8);
  if (length === 0 || HEADER + length > image.length) throw new Error('Assets image length is out of range');
  const body = image.subarray(HEADER, HEADER + length);
  if (checksum(body) !== image.readUInt32LE(4)) throw new Error('Assets checksum does not match');
  const base = count * ENTRY;
  return Array.from({ length: count }, (_, i) => {
    const entry = body.subarray(i * ENTRY, (i + 1) * ENTRY);
    const name = entry.subarray(0, NAME).toString('utf8').replace(/\0.*$/s, '');
    const size = entry.readUInt32LE(NAME);
    const offset = base + entry.readUInt32LE(NAME + 4);
    if (!body.subarray(offset, offset + 2).equals(MARKER)) throw new Error(`Asset ${name} has no marker`);
    return { name, data: Buffer.from(body.subarray(offset + 2, offset + 2 + size)) };
  });
}

export function buildAssets(files: AssetFile[]): Buffer {
  const table = Buffer.alloc(files.length * ENTRY);
  const blobs: Buffer[] = [];
  let offset = 0;
  files.forEach((file, i) => {
    const name = Buffer.from(file.name, 'utf8');
    if (name.length >= NAME) throw new Error(`Asset name ${file.name} is longer than ${NAME - 1} bytes`);
    const entry = table.subarray(i * ENTRY);
    name.copy(entry);
    entry.writeUInt32LE(file.data.length, NAME);
    entry.writeUInt32LE(offset, NAME + 4);
    blobs.push(MARKER, file.data);
    offset += MARKER.length + file.data.length;
  });
  const body = Buffer.concat([table, ...blobs]);
  const header = Buffer.alloc(HEADER);
  header.writeUInt32LE(files.length, 0);
  header.writeUInt32LE(checksum(body), 4);
  header.writeUInt32LE(body.length, 8);
  return Buffer.concat([header, body]);
}

/** The default assets inside a released `merged-binary.bin`, trimmed to what the header says is in use. */
export function assetsFromFirmware(image: Buffer): Buffer {
  for (let at = PARTITION_TABLE; image.readUInt16LE(at) === 0x50aa; at += 32) {
    const label = image.subarray(at + 12, at + 28).toString('latin1').replace(/\0.*$/s, '');
    if (label !== 'assets') continue;
    const start = image.readUInt32LE(at + 4);
    const assets = image.subarray(start, start + HEADER + image.readUInt32LE(start + 8));
    parseAssets(assets);
    return Buffer.from(assets);
  }
  throw new Error('The firmware image has no assets partition');
}

/** The firmware names a session sends (server.ts); the firmware itself also asks for "neutral" while listening. */
export const DEVICE_EMOTIONS: Record<Emotion, string> = {
  neutral: 'neutral', happy: 'happy', sad: 'sad', blush: 'embarrassed', angry: 'angry', special: 'surprised',
};

interface Index {
  emoji_collection?: { name: string; file: string }[];
  [key: string]: unknown;
}

/**
 * Keeps fonts, the wake word model and every other setting, and points every emoji name at a portrait:
 * the six a session uses at their own picture, any other name the firmware knows at the neutral one.
 */
export function portraitPack(base: Buffer, portraits: Record<Emotion, Buffer>): Buffer {
  const files = parseAssets(base);
  const indexFile = files.find((file) => file.name === 'index.json');
  if (!indexFile) throw new Error('The base assets have no index.json');
  const index = JSON.parse(indexFile.data.toString('utf8')) as Index;
  const pictures = new Set((index.emoji_collection ?? []).map((emoji) => emoji.file));
  const fileOf = Object.fromEntries(Object.entries(DEVICE_EMOTIONS).map(([emotion, name]) => [name, `npc_${emotion}.png`]));
  const names = new Set([...(index.emoji_collection ?? []).map((emoji) => emoji.name), ...Object.values(DEVICE_EMOTIONS)]);
  const updated: Index = { ...index, emoji_collection: [...names].map((name) => ({ name, file: fileOf[name] ?? 'npc_neutral.png' })) };
  return buildAssets([
    ...files.filter((file) => file.name !== 'index.json' && !pictures.has(file.name)),
    { name: 'index.json', data: Buffer.from(JSON.stringify(updated)) },
    ...(Object.keys(DEVICE_EMOTIONS) as Emotion[]).map((emotion) => ({ name: `npc_${emotion}.png`, data: portraits[emotion] })),
  ]);
}

/**
 * Packs built from what `tools/companion/portraits.ts` exported: `<directory>/base.bin` and
 * `<directory>/portraits/<npc>/<emotion>.png`. Kept out of the repository (game and firmware content).
 */
export class PortraitPacks {
  private readonly directory: string;
  private readonly built = new Map<string, Promise<Buffer | undefined>>();

  constructor(directory: string) {
    this.directory = directory;
  }

  /** Undefined when nothing was exported for this NPC. */
  pack(npcId: string): Promise<Buffer | undefined> {
    let pack = this.built.get(npcId);
    if (!pack) {
      pack = this.build(npcId);
      this.built.set(npcId, pack);
      // A failed or missing export may be fixed while the backend runs.
      void pack.then((value) => { if (!value) this.built.delete(npcId); }, () => this.built.delete(npcId));
    }
    return pack;
  }

  private async build(npcId: string): Promise<Buffer | undefined> {
    const read = (path: string) => readFile(join(this.directory, path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    const base = await read('base.bin');
    const entries = await Promise.all((Object.keys(DEVICE_EMOTIONS) as Emotion[])
      .map(async (emotion) => [emotion, await read(join('portraits', npcId, `${emotion}.png`))] as const));
    if (!base || entries.some(([, data]) => !data)) return undefined;
    return portraitPack(base, Object.fromEntries(entries) as Record<Emotion, Buffer>);
  }
}
