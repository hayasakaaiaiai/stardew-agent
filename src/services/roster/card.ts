/** Parsed form of one data/npcs/<id>.md character card. */
export interface Card {
  id: string;
  name: string;
  identity: string;
  personality: string;
  style: string;
  examples: string[];
  relationships: Relationship[];
  likes: string;
  gifts: Gift[];
  topics: Topic[];
  rules: Rule[];
  /** What the NPC knows once the player has seen an event: its own heart events, or ones it witnessed. */
  afterEvents: AfterEvent[];
  special: string;
}

export interface Relationship {
  name: string;
  /** Absent for people outside the roster, e.g. Kel or Mr. Qi. */
  id?: string;
  text: string;
}

export interface Gift { item: string; text: string }

export interface Topic { minHearts: number; text: string }

export interface AfterEvent { event: string; label: string; text: string }

/**
 * A "不能说的内容" line. `unseen` rules hold until any listed event is seen; `hearts` rules hold below a
 * heart level; `always` rules never lapse; `text` rules keep a natural-language condition that the model
 * judges against the world facts.
 */
export type Rule =
  | { kind: 'always'; text: string }
  | { kind: 'unseen'; events: string[]; text: string }
  | { kind: 'hearts'; below: number; text: string }
  | { kind: 'text'; condition: string; text: string };

export interface ParseResult {
  card: Card;
  warnings: string[];
}

export class CardError extends Error {
  readonly file: string;
  readonly problems: string[];

  constructor(file: string, problems: string[]) {
    super(`${file}: ${problems.join('; ')}`);
    this.file = file;
    this.problems = problems;
  }
}

const SECTIONS = {
  身份与背景: 'identity',
  性格: 'personality',
  说话风格: 'style',
  人际关系: 'relationships',
  喜好: 'likes',
  可送物品: 'gifts',
  按心数解锁的话题: 'topics',
  不能说的内容: 'rules',
  看过事件之后: 'afterEvents',
  特殊条件: 'special',
} as const;
type SectionKey = (typeof SECTIONS)[keyof typeof SECTIONS];
const REQUIRED: SectionKey[] = ['identity', 'personality', 'style', 'relationships', 'likes', 'topics', 'rules'];
const EXAMPLES_HEADING = '示例台词';
const EVENT_ID = /事件\s*([0-9]+|[A-Za-z][\w]*)/g;

/** Parse one card. `knownIds` lists every roster id, so relationship ids can be checked. */
export function parseCard(id: string, markdown: string, knownIds: ReadonlySet<string>): ParseResult {
  const file = `${id}.md`;
  const problems: string[] = [];
  const warnings: string[] = [];
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);

  let name = '';
  const bodies = new Map<SectionKey, string[]>();
  const examples: string[] = [];
  let current: SectionKey | 'examples' | undefined;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h1 = /^# (.+)$/.exec(line);
    const h2 = /^## (.+)$/.exec(line);
    const h3 = /^### (.+)$/.exec(line);
    if (h1) {
      if (name) problems.push('more than one top-level heading');
      name = h1[1]!.trim();
      current = undefined;
    } else if (h2) {
      const title = h2[1]!.replace(/（可选）$/, '').trim();
      const key = (SECTIONS as Record<string, SectionKey>)[title];
      if (!key) problems.push(`unknown section "${h2[1]}"`);
      else if (bodies.has(key)) problems.push(`duplicate section "${title}"`);
      else bodies.set(key, []);
      current = key;
    } else if (h3) {
      if (current === 'style' && h3[1]!.trim() === EXAMPLES_HEADING) current = 'examples';
      else problems.push(`unexpected sub-heading "${h3[1]}"`);
    } else if (current === 'examples') {
      const item = listItem(line);
      if (item !== undefined) examples.push(item);
      else if (line.trim()) problems.push(`example lines must be list items: "${line}"`);
    } else if (current) {
      bodies.get(current)!.push(line);
    } else if (line.trim()) {
      problems.push(`text outside any section: "${line}"`);
    }
  }

  if (!name) problems.push('missing top-level heading with the display name');
  for (const key of REQUIRED) {
    if (!bodies.has(key) || !text(bodies.get(key)).length) problems.push(`missing or empty section for ${key}`);
  }
  if (!examples.length) problems.push('missing example lines under "### 示例台词"');

  const relationships = items(bodies.get('relationships')).map((item): Relationship => {
    const withId = /^(.+?)（([a-z]+)）：(.+)$/.exec(item);
    if (withId) {
      const [, who, npcId, about] = withId;
      if (!knownIds.has(npcId!)) problems.push(`relationship refers to unknown id "${npcId}"`);
      return { name: who!, id: npcId!, text: about! };
    }
    const [who, about] = splitOnce(item);
    if (about === undefined) problems.push(`relationship needs "名字：描述": "${item}"`);
    return { name: who, text: about ?? '' };
  });

  const gifts = items(bodies.get('gifts')).map((item): Gift => {
    // 「」 keeps a colon that belongs to the item's own name, e.g. 「传送图腾：农场」.
    const quoted = /^「(.+?)」：(.+)$/.exec(item);
    const [what, why] = quoted ? [quoted[1]!, quoted[2]!.trim()] : splitOnce(item);
    if (why === undefined) problems.push(`gift needs "物品：说明": "${item}"`);
    return { item: what, text: why ?? '' };
  });

  const topics = items(bodies.get('topics')).flatMap((item): Topic[] => {
    const match = /^(\d+)\+：(.+)$/.exec(item);
    if (!match) {
      problems.push(`topic needs "N+：内容": "${item}"`);
      return [];
    }
    return [{ minHearts: Number(match[1]), text: match[2]! }];
  });

  const rules = items(bodies.get('rules')).map((item) => {
    const rule = parseRule(item);
    if (rule.kind === 'text' && rule.condition.includes('之前')) {
      warnings.push(`${file}: rule condition has no event id, left to the model: "${rule.condition}"`);
    }
    return rule;
  });

  const afterEvents = items(bodies.get('afterEvents')).flatMap((item): AfterEvent[] => {
    const match = /^事件\s*([0-9]+|[A-Za-z]\w*)（(.+?)）：(.+)$/.exec(item);
    if (!match) {
      problems.push(`after-event line needs "事件 <编号>（标签）：内容": "${item}"`);
      return [];
    }
    return [{ event: match[1]!, label: match[2]!, text: match[3]! }];
  });
  const repeated = afterEvents.map((entry) => entry.event).filter((event, i, all) => all.indexOf(event) !== i);
  for (const event of new Set(repeated)) problems.push(`after-event lines repeat event ${event}`);

  if (problems.length) throw new CardError(file, problems);
  return {
    card: {
      id, name,
      identity: text(bodies.get('identity')),
      personality: text(bodies.get('personality')),
      style: text(bodies.get('style')),
      examples, relationships,
      likes: text(bodies.get('likes')),
      gifts, topics, rules, afterEvents,
      special: text(bodies.get('special')),
    },
    warnings,
  };
}

export function parseRule(item: string): Rule {
  const [condition, body] = splitOnce(item);
  // A line without a condition, e.g. "看过之后也只在没有旁人时承认", is a standing instruction.
  if (body === undefined) return { kind: 'always', text: item };
  if (condition.startsWith('任何时候')) return { kind: 'always', text: body };
  const hearts = /^(\d+)\s*心之前$/.exec(condition);
  if (hearts) return { kind: 'hearts', below: Number(hearts[1]), text: body };
  const events = [...condition.matchAll(EVENT_ID)].map((match) => match[1]!);
  if (events.length) return { kind: 'unseen', events, text: body };
  return { kind: 'text', condition, text: body };
}

function listItem(line: string): string | undefined {
  const match = /^- (.+)$/.exec(line.trim());
  return match ? match[1]!.trim() : undefined;
}

function items(lines: string[] | undefined): string[] {
  return (lines ?? []).flatMap((line) => {
    const item = listItem(line);
    return item === undefined ? [] : [item];
  });
}

function text(lines: string[] | undefined): string {
  return (lines ?? []).join('\n').trim();
}

/** Split on the first full-width colon. */
function splitOnce(item: string): [string, string | undefined] {
  const at = item.indexOf('：');
  return at < 0 ? [item, undefined] : [item.slice(0, at).trim(), item.slice(at + 1).trim()];
}
