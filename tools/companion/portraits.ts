/**
 * Exports the robot's faces (docs/companion-device.md §14): each NPC's six portraits from the local game,
 * scaled up without smoothing, plus the default assets from the firmware image the robot was flashed with.
 * Everything goes under .runtime/, since it is game and firmware content.
 *
 *   node tools/companion/portraits.ts --xnb <xnb-lib-dir> --content "<game>/Content" --firmware merged-binary.bin
 *
 * `--xnb` is the same xnb@1.3.0 copy used for the game text (reference/README.md); `--scale` defaults to 3,
 * which turns the game's 64×64 portraits into 192×192.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';
import type { Emotion } from '../../src/agent/dialogue.ts';
import { assetsFromFirmware, DEVICE_EMOTIONS } from '../../src/companion/assets.ts';
import { SOCIAL_NPCS } from '../../src/types.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const FRAME = 64;
/** Frames in the order the game's $0 $h $s $u $l $a portrait codes use. */
const FRAMES: Record<Emotion, number> = { neutral: 0, happy: 1, sad: 2, special: 3, blush: 4, angry: 5 };
/** Portrait files named differently from the NPC. */
const TEXTURES: Record<string, string> = { leo: 'ParrotBoy' };

interface Texture { width: number; height: number; data: Uint8Array }
interface XnbModule { unpackToXnbData(buffer: Buffer): Promise<{ content: { export: Texture & { type: string } } }> }

const { values } = parseArgs({ options: {
  xnb: { type: 'string' }, content: { type: 'string' }, firmware: { type: 'string' },
  out: { type: 'string', default: join(ROOT, '.runtime/companion/assets') }, scale: { type: 'string', default: '3' },
} });
if (!values.xnb || !values.content || !values.firmware) {
  throw new Error('Usage: node tools/companion/portraits.ts --xnb <dir> --content <game Content dir> --firmware <merged-binary.bin> [--out <dir>] [--scale 3]');
}
const scale = Number(values.scale);
if (!Number.isInteger(scale) || scale < 1 || scale > 4) throw new Error('--scale must be 1–4');
const out = values.out!;

const XNB = await import(pathToFileURL(join(resolve(values.xnb), 'xnb.module.mjs')).href) as XnbModule;

await mkdir(out, { recursive: true });
const base = assetsFromFirmware(await readFile(values.firmware));
await writeFile(join(out, 'base.bin'), base);
console.log(`固件默认资源：${(base.length / 1024).toFixed(0)} KB`);

const missing: string[] = [];
let bytes = 0;
for (const npcId of SOCIAL_NPCS) {
  const name = TEXTURES[npcId] ?? npcId[0]!.toUpperCase() + npcId.slice(1);
  const sheet = await texture(join(values.content, 'Portraits', `${name}.xnb`));
  await mkdir(join(out, 'portraits', npcId), { recursive: true });
  const frames = Math.floor(sheet.width / FRAME) * Math.floor(sheet.height / FRAME);
  for (const [emotion, index] of Object.entries(FRAMES) as [Emotion, number][]) {
    // A sheet without this frame falls back to the neutral one.
    const frame = index < frames ? index : 0;
    if (frame !== index) missing.push(`${npcId}/${emotion}`);
    const png = encodePng(crop(sheet, frame, scale), FRAME * scale);
    bytes += png.length;
    await writeFile(join(out, 'portraits', npcId, `${emotion}.png`), png);
  }
}
console.log(`头像：${SOCIAL_NPCS.length} 人 × ${Object.keys(DEVICE_EMOTIONS).length} 张，${FRAME * scale}×${FRAME * scale}，共 ${(bytes / 1024).toFixed(0)} KB → ${out}`);
if (missing.length) console.log(`缺的表情用普通表情代替：${missing.join('、')}`);

async function texture(file: string): Promise<Texture> {
  // The library reports progress on stdout.
  const { log, info } = console;
  console.log = console.info = () => {};
  try {
    const { content } = await XNB.unpackToXnbData(await readFile(file));
    if (content.export.type !== 'Texture2D') throw new Error(`${file} is not a texture`);
    return content.export;
  } finally {
    Object.assign(console, { log, info });
  }
}

/** One frame, each pixel repeated `scale` times so the pixel art stays sharp. */
function crop(sheet: Texture, frame: number, scale: number): Buffer {
  const size = FRAME * scale;
  const columns = Math.floor(sheet.width / FRAME);
  const left = (frame % columns) * FRAME;
  const top = Math.floor(frame / columns) * FRAME;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = ((top + Math.floor(y / scale)) * sheet.width + left + Math.floor(x / scale)) * 4;
      pixels.set(sheet.data.subarray(from, from + 4), (y * size + x) * 4);
    }
  }
  return pixels;
}

/** RGBA, 8 bits per channel: the format of xiaozhi's own emoji. */
function encodePng(rgba: Buffer, size: number): Buffer {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
