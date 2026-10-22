/** Conservative checks for quoted appointments; uncertainty must not move an NPC. No extra model request. */
type Quote = { id: string; speaker: '玩家' | 'NPC'; text: string };
const TOMORROW = /明天|明早|明晚|明儿|明日/;
const REFUSED = /不(?:去了?|来了?|想去|想来|想见|能去|能来|方便|同意|答应|确定|一定|知道|用来|和你|跟你|见面|约)|别(?:来|等)|没(?:空|时间|答应|同意)|不行|不了|算了|改天|再说|想想|考虑|还没(?:决定|想好|定)|不能确定|待定|暂定|也许|可能/;
const CONDITIONAL = /如果|要是|除非|才会|看情况/;
const YES = /(?:^|[，,。！!；;\s])(?:我)?(?:嗯(?:嗯)?|好(?:啊|呀|的|吧|嘞)?|行(?:啊|呀|的)?|可以(?:啊|呀|的)?|没问题|当然(?:可以)?|愿意|同意|说定了|一言为定|就这么定)(?:$|[，,。！!；;\s])/;
const PERIODS: [RegExp, number, number, number][] = [
  [/早上|早晨|明早/, 900, 600, 1200], [/上午/, 1000, 600, 1200], [/中午/, 1200, 1100, 1400],
  [/下午/, 1400, 1200, 1800], [/傍晚/, 1700, 1700, 2000], [/晚上|明晚/, 1900, 1800, 2400],
];

function number(word: string): number {
  if (/^\d+$/.test(word)) return Number(word);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (word.includes('十')) {
    const [tens, units] = word.split('十');
    return (tens ? digits[tens]! : 1) * 10 + (units ? digits[units]! : 0);
  }
  return digits[word] ?? NaN;
}

function times(text: string, includePeriods = true): number[] {
  const matches = [...text.matchAll(/(\d{1,2})[:：](\d{2})/g)].map(match => ({ hour: Number(match[1]), minute: Number(match[2]), clock: true }));
  for (const match of text.matchAll(/([零〇一二两三四五六七八九十\d]{1,3})(?:点|时)(半|一刻|三刻|[零〇一二两三四五六七八九十\d]{1,3}分)?/g)) {
    const suffix = match[2];
    matches.push({ hour: number(match[1]!), minute: suffix === '半' ? 30 : suffix === '一刻' ? 15 : suffix === '三刻' ? 45 : suffix ? number(suffix.slice(0, -1)) : 0, clock: false });
  }
  if (matches.length) return matches.map(({ hour, minute, clock }) => {
    if (hour < 12 && (/下午|傍晚|晚上|明晚/.test(text) || !clock && hour < 8 && !/凌晨|清晨|早上|早晨|上午|明早/.test(text))) hour += 12;
    return hour * 100 + Math.floor(minute / 10) * 10;
  });
  return includePeriods ? PERIODS.filter(([words]) => words.test(text)).map(([, time]) => time) : [];
}

/** Apply the documented default only to one agreed period, never to a concrete or conflicting clock. */
export function quotedPeriodTime(quoted: readonly Quote[], proposed: number): number {
  if (quoted.some(quote => times(quote.text, false).length)) return proposed;
  const periods = quoted.flatMap(quote => PERIODS.filter(([words]) => words.test(quote.text)));
  if (!periods.length || periods.some(([, time, start, end]) => time !== periods[0]![1] || proposed < start || proposed >= end)) return proposed;
  return periods[0]![1];
}

/** Both parties must show intent, and every quoted concrete time must agree with the proposed ten-minute slot. */
export function quotedAgreement(quoted: readonly Quote[], all: readonly Quote[], placeWords: RegExp, time: number): boolean {
  const text = quoted.map(quote => quote.text).join('\n');
  const farmHelp = /农场(?!主)|地里|田里/.test(text) && /帮.{0,8}(?:浇|收|喂|添|干活)|来帮.{0,4}忙/.test(text);
  // "来我农场看看鸡吧" invites to the farm as plainly as "见" (docs/npc-mine-companion.md §5.4).
  const farmVisit = /(?:来|到)我(?:的)?农场/.test(text);
  // "陪我下矿" asks for company as plainly as "一起" (docs/npc-mine-companion.md §5.4).
  const dungeonTrip = /矿洞|矿井|矿坑|下矿|矿里|骷髅洞|火山/.test(text) && /陪(?:我|你)|带(?:我|你)|跟(?:我|你)/.test(text);
  if (quoted.length < 2 || REFUSED.test(text) || CONDITIONAL.test(text) || /后天|下周|下个/.test(text)
    || !farmHelp && !farmVisit && !dungeonTrip && !/(?:一起|见面?|碰面|等(?:你|我|着)|约(?:好|定)?)/.test(text)) return false;
  const concreteTimes = quoted.flatMap(quote => times(quote.text, false));
  const evidenceTimes = concreteTimes.length ? concreteTimes : quoted.flatMap(quote => times(quote.text));
  if (!evidenceTimes.length || evidenceTimes.some(value => value !== time)) return false;
  if (quoted.some(quote => !times(quote.text, false).length && PERIODS.some(([words, , start, end]) => words.test(quote.text) && (time < start || time >= end)))) return false;
  const intent = (quote: Quote) => YES.test(quote.text)
    || /(?:那就|到时|我们).{0,10}(?:见|碰面)|我(?:确定|一定|准时|会).{0,8}(?:到|去|来|参加)/.test(quote.text)
    || TOMORROW.test(quote.text) && placeWords.test(quote.text) && times(quote.text).length > 0 && /一起|见|去|来|等|陪/.test(quote.text);
  if (!quoted.some(quote => quote.speaker === '玩家' && intent(quote)) || !quoted.some(quote => quote.speaker === 'NPC' && intent(quote))) return false;
  const end = Math.max(...quoted.map(quote => all.findIndex(source => source.id === quote.id)));
  return !all.slice(end + 1).some(quote => REFUSED.test(quote.text)
    && (TOMORROW.test(quote.text) || placeWords.test(quote.text) || /不去(?:了)?[。！!]?\s*$/.test(quote.text)));
}
