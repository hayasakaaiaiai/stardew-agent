import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildAssets, DEVICE_EMOTIONS } from '../../src/companion/assets.ts';

/** Stands in for the firmware's default assets: a font, a wake word model, emoji and their index. */
export function fakeBase(): Buffer {
  const index = {
    version: 1, srmodels: 'srmodels.bin', text_font: 'font.bin',
    emoji_collection: [{ name: 'happy', file: 'happy.png' }, { name: 'thinking', file: 'thinking.png' }, { name: 'neutral', file: 'neutral.png' }],
  };
  return buildAssets([
    { name: 'font.bin', data: Buffer.from('font bytes') },
    { name: 'srmodels.bin', data: Buffer.from('wake word model') },
    { name: 'index.json', data: Buffer.from(JSON.stringify(index)) },
    ...['happy', 'thinking', 'neutral'].map((name) => ({ name: `${name}.png`, data: Buffer.from(`twemoji ${name}`) })),
  ]);
}

export async function writePortraits(directory: string, npcId: string): Promise<void> {
  await mkdir(join(directory, 'portraits', npcId), { recursive: true });
  await writeFile(join(directory, 'base.bin'), fakeBase());
  for (const emotion of Object.keys(DEVICE_EMOTIONS)) await writeFile(join(directory, 'portraits', npcId, `${emotion}.png`), `${npcId} ${emotion}`);
}
