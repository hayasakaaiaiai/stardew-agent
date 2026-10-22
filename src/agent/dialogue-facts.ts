import type { MemoryContext } from './dialogue.ts';
import type { ScheduleReplies } from './schedule.ts';

/** Deliberately narrow: suggestions, hypothetical trips and ordinary chat still go to the model unchanged. */
export function directScheduleReply(query: string, facts: ScheduleReplies | undefined): string | undefined {
  if (!facts) return undefined;
  const text = query.trim().replace(/[？?。！!]+$/, '');
  if (/^你?(?:待会儿?|等会儿?|一会儿?|接下来|稍后)(?:打算|准备|要|会)?(?:去哪儿?|去哪里|到哪儿?|到哪里)(?:呢|啊|呀)?$/.test(text)
    || /^你?(?:的)?下一站(?:是哪里|是哪儿|去哪儿?|去哪|在哪儿?|在哪里)?$/.test(text)) return facts.next;
  if (/^(?:你)?(?:今天晚上|晚上|今晚|傍晚)(?:去哪儿?|去哪里|在哪儿?|在哪里)(?:(?:能|可以)?找(?:到)?你)?(?:呢|啊|呀)?$/.test(text)) return facts.evening;
  return undefined;
}

/** An absent recalled event is unknown, rather than proof that a meeting did or did not happen. */
export function unknownRecentChat(query: string, memory: MemoryContext, names: readonly string[]): string | undefined {
  const match = /^(?:你)?(刚才|今天|昨天|上次)(?:你)?(?:和|跟)(.+?)(?:在[^，。？?]{1,20})?聊(?:了|过)?(?:什么|啥|些什么|些啥)(?:内容)?(?:呢|啊|呀)?[？?。！!]*$/.exec(query.trim());
  if (!match || !names.includes(match[2]!)) return undefined;
  const [, period, partner] = match;
  const when = period === '昨天' ? '昨天' : period === '上次' ? undefined : '今天';
  const known = memory.memories.some(item => (!when || item.when === when)
    && /^在[^\n]+和([^\n]+)聊天：/.exec(item.text)?.[1]?.split('、').includes(partner!));
  return known ? undefined : `和${partner}聊了什么，我一时想不起来了。`;
}
