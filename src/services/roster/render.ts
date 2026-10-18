import type { Card, Rule } from './card.ts';

export type Relation = 'stranger' | 'friend' | 'dating' | 'engaged' | 'married' | 'roommate';

export interface CardView {
  hearts: number;
  seenEvents: ReadonlySet<string>;
  /** Scene calls drop the example lines to save tokens. */
  purpose: 'dialogue' | 'scene';
  includeGifts?: boolean;
}

export interface RenderedCard {
  /** Depends only on the card file, so it can sit in the cached prompt prefix. */
  stable: string;
  /** Changes with hearts and seen events; goes after `stable`. */
  gated: string;
}

export function renderCard(card: Card, view: CardView): RenderedCard {
  const stable = [
    `## 角色：${card.name}（${card.id}）`,
    section('身份与背景', card.identity),
    section('性格', card.personality),
    section('说话风格', card.style),
    view.purpose === 'dialogue' ? section('示例台词', bullets(card.examples)) : '',
    section('人际关系', bullets(card.relationships.map((r) => `${r.name}：${r.text}`))),
    section('喜好', card.likes),
  ];

  const topics = card.topics.filter((topic) => topic.minHearts <= view.hearts).map((topic) => topic.text);
  const rules = card.rules.filter((rule) => ruleActive(rule, view)).map(ruleText);
  const gated = [
    section(`现在可以聊的话题（${view.hearts} 心）`, bullets(topics)),
    section('必须遵守的限制', bullets(rules)),
    section('特殊条件', card.special),
    view.includeGifts ? section('可以送给玩家的东西', bullets(card.gifts.map((g) => `${g.item}：${g.text}`))) : '',
  ];
  return { stable: join(stable), gated: join(gated) };
}

export function ruleActive(rule: Rule, view: Pick<CardView, 'hearts' | 'seenEvents'>): boolean {
  if (rule.kind === 'unseen') return !rule.events.some((event) => view.seenEvents.has(event));
  if (rule.kind === 'hearts') return view.hearts < rule.below;
  return true;
}

/** Event- and heart-gated rules are already known to apply, so only the instruction is shown. */
function ruleText(rule: Rule): string {
  return rule.kind === 'text' ? `${rule.condition}：${rule.text}` : rule.text;
}

function section(title: string, body: string): string {
  return body ? `### ${title}\n${body}` : '';
}

function bullets(lines: string[]): string {
  return lines.map((line) => `- ${line}`).join('\n');
}

function join(parts: string[]): string {
  return parts.filter(Boolean).join('\n\n');
}
