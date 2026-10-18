import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict.js';

const jieba = Jieba.withDict(dict);
const stopWords = new Set(['的', '了', '是', '在', '和', '与', '吗', '呢', '我', '你', '他', '她', '我们', '你们', '他们']);

export function tokenize(text: string): string[] {
  return [...new Set(jieba.cutForSearch(text.normalize('NFKC').toLowerCase(), true)
    .map(word => word.trim()).filter(word => /[\p{L}\p{N}]/u.test(word) && !stopWords.has(word)))];
}

export function ftsQuery(text: string): string | null {
  const terms = tokenize(text).slice(0, 32);
  return terms.length ? terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ') : null;
}
