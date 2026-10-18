import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Card, CardError, parseCard } from './card.ts';
import { type CardView, type RenderedCard, renderCard } from './render.ts';

export type { AfterEvent, Card, Gift, Relationship, Rule, Topic } from './card.ts';
export { CardError, parseCard, parseRule } from './card.ts';
export type { CardView, Relation, RenderedCard } from './render.ts';
export { renderCard, ruleActive } from './render.ts';

export interface RosterLoad {
  loaded: string[];
  errors: CardError[];
  warnings: string[];
}

/**
 * Character cards from data/npcs. A card that fails to parse on reload keeps its previous version,
 * so a typo while editing never takes an NPC offline.
 */
export class Roster {
  readonly directory: string;
  readonly npcIds: readonly string[];
  private cards = new Map<string, Card>();

  constructor(config: { directory: string; npcIds: readonly string[] }) {
    this.directory = config.directory;
    this.npcIds = config.npcIds;
  }

  async load(): Promise<RosterLoad> {
    const known = new Set(this.npcIds);
    const files = new Set(await readdir(this.directory));
    const result: RosterLoad = { loaded: [], errors: [], warnings: [] };
    for (const file of files) {
      const id = file.replace(/\.md$/, '');
      if (file.endsWith('.md') && !file.startsWith('_') && !known.has(id)) {
        result.warnings.push(`${file}: not a roster NPC, ignored`);
      }
    }
    for (const id of this.npcIds) {
      const file = `${id}.md`;
      if (!files.has(file)) {
        result.errors.push(new CardError(file, ['file not found']));
        continue;
      }
      try {
        const parsed = parseCard(id, await readFile(join(this.directory, file), 'utf8'), known);
        this.cards.set(id, parsed.card);
        result.loaded.push(id);
        result.warnings.push(...parsed.warnings);
      } catch (error) {
        if (!(error instanceof CardError)) throw error;
        result.errors.push(error);
      }
    }
    return result;
  }

  has(id: string): boolean {
    return this.cards.has(id);
  }

  get(id: string): Card {
    const card = this.cards.get(id);
    if (!card) throw new Error(`No character card loaded for "${id}"`);
    return card;
  }

  render(id: string, view: CardView): RenderedCard {
    return renderCard(this.get(id), view);
  }
}
