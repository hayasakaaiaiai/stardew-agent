import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assetsFromFirmware, buildAssets, DEVICE_EMOTIONS, parseAssets, PortraitPacks, portraitPack } from '../src/companion/assets.ts';
import { fakeBase, writePortraits } from './helpers/faces.ts';

test('the assets image matches the firmware layout: header, 44-byte entries, ZZ markers, 16-bit byte-sum checksum', () => {
  // Bytes above 127 pin the sum as unsigned, which reproduces the stored checksum of the official v2.5.0 assets.
  const image = buildAssets([{ name: 'a.bin', data: Buffer.from([1, 200, 255]) }, { name: 'index.json', data: Buffer.from('{}') }]);
  assert.equal(image.readUInt32LE(0), 2);
  const body = image.subarray(12);
  assert.equal(image.readUInt32LE(8), body.length);
  assert.equal(image.readUInt32LE(4), body.reduce((sum, byte) => sum + byte, 0) & 0xffff);
  assert.equal(body.subarray(0, 32).toString().replace(/\0.*$/s, ''), 'a.bin');
  assert.deepEqual([body.readUInt32LE(32), body.readUInt32LE(36)], [3, 0]);
  assert.deepEqual([body.readUInt32LE(44 + 32), body.readUInt32LE(44 + 36)], [2, 5], 'each file is its marker plus its bytes');
  assert.equal(body.subarray(88, 90).toString(), 'ZZ');
  assert.deepEqual(parseAssets(image).map((file) => [file.name, [...file.data]]), [['a.bin', [1, 200, 255]], ['index.json', [...Buffer.from('{}')]]]);

  const broken = Buffer.from(image);
  broken[broken.length - 1]! ^= 1;
  assert.throws(() => parseAssets(broken), /checksum/);
  assert.throws(() => buildAssets([{ name: 'x'.repeat(32), data: Buffer.alloc(1) }]), /longer than 31/);
});

test('the default assets come out of a merged firmware image through its partition table', () => {
  const assets = fakeBase();
  const image = Buffer.alloc(0x20000 + assets.length + 100, 0xff);
  const table = (at: number, label: string, offset: number, size: number) => {
    image.writeUInt16LE(0x50aa, at);
    image.writeUInt32LE(offset, at + 4);
    image.writeUInt32LE(size, at + 8);
    image.fill(0, at + 12, at + 28);
    image.write(label, at + 12, 'latin1');
  };
  table(0x8000, 'nvs', 0x9000, 0x4000);
  table(0x8020, 'assets', 0x20000, 0x800000);
  assets.copy(image, 0x20000);
  assert.deepEqual(assetsFromFirmware(image), assets, 'trimmed to the length in its header');
  image.writeUInt16LE(0xffff, 0x8020);
  assert.throws(() => assetsFromFirmware(image), /no assets partition/);
});

test("an NPC's pack keeps the font and wake word model and points every emoji name at a portrait", () => {
  const portraits = Object.fromEntries(Object.keys(DEVICE_EMOTIONS).map((emotion) => [emotion, Buffer.from(`haley ${emotion}`)])) as Parameters<typeof portraitPack>[1];
  const files = parseAssets(portraitPack(fakeBase(), portraits));
  assert.deepEqual(files.map((file) => file.name), ['font.bin', 'srmodels.bin', 'index.json',
    'npc_neutral.png', 'npc_happy.png', 'npc_sad.png', 'npc_blush.png', 'npc_angry.png', 'npc_special.png']);
  const index = JSON.parse(files[2]!.data.toString()) as { text_font: string; emoji_collection: { name: string; file: string }[] };
  assert.equal(index.text_font, 'font.bin');
  assert.deepEqual(Object.fromEntries(index.emoji_collection.map((emoji) => [emoji.name, emoji.file])), {
    happy: 'npc_happy.png', thinking: 'npc_neutral.png', neutral: 'npc_neutral.png',
    sad: 'npc_sad.png', embarrassed: 'npc_blush.png', angry: 'npc_angry.png', surprised: 'npc_special.png',
  });
  assert.equal(files.find((file) => file.name === 'npc_blush.png')!.data.toString(), 'haley blush');
});

test('packs are built from the exported files, and an NPC exported later is picked up', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'faces-'));
  try {
    const packs = new PortraitPacks(directory);
    assert.equal(await packs.pack('haley'), undefined);
    await writePortraits(directory, 'haley');
    const pack = (await packs.pack('haley'))!;
    assert.ok(parseAssets(pack).some((file) => file.name === 'npc_happy.png'));
    assert.equal(await packs.pack('haley'), pack, 'built once');
    assert.equal(await packs.pack('abigail'), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
