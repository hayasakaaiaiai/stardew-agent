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

function clockTimes(text: string): { time: number; ambiguous: boolean }[] {
  const matches = [...text.matchAll(/(\d{1,2})[:：](\d{2})/g)].map(match => ({ hour: Number(match[1]), minute: Number(match[2]), clock: true }));
  for (const match of text.matchAll(/([零〇一二两三四五六七八九十\d]{1,3})(?:点|时)(半|一刻|三刻|[零〇一二两三四五六七八九十\d]{1,3}分)?/g)) {
    const suffix = match[2];
    matches.push({ hour: number(match[1]!), minute: suffix === '半' ? 30 : suffix === '一刻' ? 15 : suffix === '三刻' ? 45 : suffix ? number(suffix.slice(0, -1)) : 0, clock: false });
  }
  return matches.map(({ hour, minute, clock }) => {
    const ambiguous = !clock && hour > 0 && hour < 12 && !/凌晨|清晨|早上|早晨|上午|中午|下午|傍晚|晚上|明早|明晚/.test(text);
    if (hour < 12 && (/下午|傍晚|晚上|明晚/.test(text) || !clock && hour < 8 && !/凌晨|清晨|早上|早晨|上午|明早/.test(text))) hour += 12;
    return { time: hour * 100 + Math.floor(minute / 10) * 10, ambiguous };
  });
}

function times(text: string, includePeriods = true): number[] {
  const clocks = clockTimes(text);
  if (clocks.length) return clocks.map(clock => clock.time);
  return includePeriods ? PERIODS.filter(([words]) => words.test(text)).map(([, time]) => time) : [];
}

/** Apply the documented default only to one agreed period, never to a concrete or conflicting clock. */
export function quotedPeriodTime(quoted: readonly Quote[], proposed: number): number {
  if (quoted.some(quote => times(quote.text, false).length)) return proposed;
  const periods = quoted.flatMap(quote => PERIODS.filter(([words]) => words.test(quote.text)));
  if (!periods.length || periods.some(([, time, start, end]) => time !== periods[0]![1] || proposed < start || proposed >= end)) return proposed;
  return periods[0]![1];
}

/** The lines ask to meet, or to come along, rather than only mention a place. */
function invited(text: string): boolean {
  const farmHelp = /农场(?!主)|地里|田里/.test(text) && /帮.{0,8}(?:浇|收|喂|添|干活)|来帮.{0,4}忙/.test(text);
  // "来我农场看看鸡吧" invites to the farm as plainly as "见" (docs/npc-mine-companion.md §5.4).
  const farmVisit = /(?:来|到)我(?:的)?农场/.test(text);
  // "陪我下矿" asks for company as plainly as "一起" (docs/npc-mine-companion.md §5.4).
  const dungeonTrip = /矿洞|矿井|矿坑|下矿|矿里|骷髅洞|火山/.test(text) && /陪(?:我|你)|带(?:我|你)|跟(?:我|你)/.test(text);
  return farmHelp || farmVisit || dungeonTrip || /(?:一起|见面?|碰面|等(?:你|我|着)|约(?:好|定)?)/.test(text);
}

/** "明天上午下矿吧？" asks along too, unless the line says who goes alone (Windows mine-companion acceptance). */
function asksAlong(quoted: readonly Quote[], placeWords: RegExp): boolean {
  return quoted.some(quote => placeWords.test(quote.text) && /(?:下矿|探险)(?:吧|？|\?)/.test(quote.text)
    && !/[我你]|自己|独自|单独|一个人/.test(quote.text));
}

/** A line asking to meet or to come along, today or any day. */
export const asksToMeet = (text: string) => invited(text) || ASKED.test(text);

/** Both parties must show intent, and every quoted concrete time must agree with the proposed ten-minute slot. */
export function quotedAgreement(quoted: readonly Quote[], all: readonly Quote[], placeWords: RegExp, time: number): boolean {
  const text = quoted.map(quote => quote.text).join('\n');
  const dungeonQuestion = /矿洞|矿井|矿坑|下矿|矿里|骷髅洞|火山/.test(text) && asksAlong(quoted, placeWords);
  if (quoted.length < 2 || REFUSED.test(text) || CONDITIONAL.test(text) || /后天|下周|下个/.test(text) || !invited(text) && !dungeonQuestion) return false;
  const concreteTimes = quoted.flatMap(quote => times(quote.text, false));
  const evidenceTimes = concreteTimes.length ? concreteTimes : quoted.flatMap(quote => times(quote.text));
  if (!evidenceTimes.length || evidenceTimes.some(value => value !== time)) return false;
  if (quoted.some(quote => !times(quote.text, false).length && PERIODS.some(([words, , start, end]) => words.test(quote.text) && (time < start || time >= end)))) return false;
  const intent = (quote: Quote) => YES.test(quote.text)
    || /(?:那就|到时|我们).{0,10}(?:见|碰面)|我(?:确定|一定|准时|会).{0,8}(?:到|去|来|参加)/.test(quote.text)
    || TOMORROW.test(quote.text) && placeWords.test(quote.text) && times(quote.text).length > 0 && /一起|见|去|来|等|陪|带|跟|下矿|探险/.test(quote.text);
  if (!quoted.some(quote => quote.speaker === '玩家' && intent(quote)) || !quoted.some(quote => quote.speaker === 'NPC' && intent(quote))) return false;
  const end = Math.max(...quoted.map(quote => all.findIndex(source => source.id === quote.id)));
  return !all.slice(end + 1).some(quote => REFUSED.test(quote.text)
    && (TOMORROW.test(quote.text) || placeWords.test(quote.text) || /不去(?:了)?[。！!]?\s*$/.test(quote.text)));
}

/** A line of the conversation that just ended, with the game time (HHMM) it was said. */
export type TimedQuote = Quote & { time: number };

/** Today's appointment from a conversation; `soon` means right away, from `time`, when it was agreed. */
export interface TodayAgreement { time: number; place: string; soon: boolean }

// Another day, or none in particular, belongs to the nightly `meet` or to nobody; the NPC may mention its own past.
const ANOTHER_DAY = /明天|明早|明晚|明儿|明日|后天|下周|下个|下次|以后|改天|哪天|(?:等.{0,3}|以后)有空|有空的时候|有空再|有机会|什么时候|周末|过几天|找(?:个)?时间|这周|这个月|将来/;
// A day named outright: "后天", "周六", "下周一", "15号" (docs/npc-later-meetings.md).
const DATE_WORDS = /后天|(?:周|星期|礼拜)[一二三四五六日天](?!起)|[\d一二三四五六七八九十]{1,3}号/;
// No day in particular.
const VAGUE = /下次|以后|改天|哪天|(?:等.{0,3}|以后)有空|有空的时候|有空再|有机会|什么时候|周末|过几天|找(?:个)?时间|这个月|将来/;
/** How far ahead an appointment may be: today, tomorrow and the day after, as the user set (docs/npc-later-meetings.md). */
const LATER_DAYS = 2;
const WEEK = '一二三四五六日';

/**
 * The absolute days a line names, by Stardew's calendar: 28-day seasons, each starting on a Monday; `today` is absolute,
 * 1 = spring 1 of year 1. "周六" on a Saturday is today; "3号" when the season is past the 3rd cannot be told, and
 * comes back as 0.
 */
export function namedDays(text: string, today: number): number[] {
  const weekday = (today - 1) % 7, seasonDay = (today - 1) % 28 + 1;
  // Tomorrow is named too, so "明天不去矿洞了" can take back one kept for tomorrow; agreeing to it is the nightly's.
  const days = [...text.matchAll(/(大)?后天|明天|明早|明晚|明儿|明日/g)].map(match => today + (match[0].endsWith('后天') ? match[1] ? 3 : 2 : 1));
  // "下周一起去" is next week together, not next Monday.
  for (const match of text.matchAll(/(下|这|本)?个?(?:周|星期|礼拜)([一二三四五六日天])(?!起)/g)) {
    let ahead = (match[2] === '天' ? 6 : WEEK.indexOf(match[2]!)) - weekday;
    if (match[1] === '下') ahead += 7;
    else if (!match[1] && ahead < 0) ahead += 7;
    days.push(today + ahead);
  }
  for (const match of text.matchAll(/(?:(下个?月)\s*)?([\d一二三四五六七八九十]{1,3})号/g)) {
    const date = number(match[2]!);
    days.push(date >= 1 && date <= 28 && (match[1] || date >= seasonDay) ? today - seasonDay + date + (match[1] ? 28 : 0) : 0);
  }
  return days;
}
const PAST = /昨天|前天|上次|那天/;
// Measured declines the nightly words miss, and "after class" with no time to go by (docs/npc-same-day-meetings.md §3).
const DECLINED = /你(?:自己|一个人)去|等你回来|找.{1,6}陪你|不陪|才不(?:要|去)|宁愿|我就不/;
const PUT_OFF = /等.{1,8}(?:完|结束)|下课|忙完|做完|收工|关门|打烊|之后/;
// Asking along for today is plain enough; the nightly check keeps "陪我" to the dungeons.
const ASKED = /陪我|带我|跟我(?:一起|去|来)|你(?:也)?(?:去|来)(?:吗|不)|要不要(?:一起|来|去)|一块儿?/;
const NOW_WORDS = /今天|待会|等会|一会|现在|马上/;
// "……好啊" and "行啊小林" agree as plainly as "好啊。"; one character alone needs a stop after it ("好看" does not),
// and a question after it is not agreeing ("嗯？").
const STOP = '[，,。！!；;？?…～~*\\s]';
const AFTER = '[，,。！!；;…～~*\\s]';
const ACCEPT = new RegExp(`(?:^|${STOP})我?(?:(?:好|行)(?:啊|呀|的|吧|嘞)|可以(?:啊|呀|的)|没问题|一言为定|说定了|就这么定|算我一个)`
  + `|(?:^|${STOP})我?(?:嗯(?:嗯)?|好|行|可以|当然(?:可以|好)?|愿意|同意)(?:$|${AFTER})|(?<!不)乐意|奉陪`);
const GOING = /(?:那就|到时|我们|咱们).{0,10}(?:见|碰面)|我(?:确定|一定|肯定|准时|会|这就|马上).{0,8}(?:到|去|来|参加|过去)|走吧|走啦|走啊|走呀|出发吧|这就(?:去|走|来|过去)/;
// "三点沙滩见", "下午见", "门口见"; not "再见", "看见" or "见过".
const SEE_YOU = /(?:点半?|边|口|滩|场|地|馆|吧|店|里|洞|山|那儿|那里|午|上|后|头|会儿?)见(?!过|到|识)/;
// A time in the NPC's line counts only in a clause about meeting: "十一点开始上课" is its own day.
const MEETING_CLAUSE = /见|碰面|等你|到|过去|过来|吧|怎么样|行吗|好吗|可以吗/;
const EARLIEST = 800;
const LATEST = 2100;

/** A change of date takes back this agreement; asking about another day does not. */
const changesDay = (text: string) => ANOTHER_DAY.test(text) && !CONDITIONAL.test(text)
  && /(?:改|换|推迟|挪|留)(?:到|成|在)?\s*(?:明天|明早|明晚|明儿|明日|后天|下周|下次|周末)|(?:明天|明早|明晚|明儿|明日|后天|下周|下次|周末)再(?:去|来|见|下矿)/.test(text);

const agrees = (quote: TimedQuote) => ACCEPT.test(quote.text) || GOING.test(quote.text) || SEE_YOU.test(quote.text);

function later(time: number, minutes: number): number {
  const total = Math.floor(time / 100) * 60 + time % 100 + minutes;
  return Math.floor(total / 60) * 100 + total % 60;
}

/**
 * Who agreed to meet where in one stretch of two to four lines, read on its own, leaving the day and time aside;
 * `after` is everything said later, and `otherDay` tells words for a day this check does not take.
 */
function agreedPlace(window: readonly TimedQuote[], after: readonly TimedQuote[], places: Readonly<Record<string, RegExp>>,
  otherDay: (text: string) => boolean, movedTo: (text: string) => boolean = changesDay): { place: string; words: RegExp } | null {
  const text = window.map(quote => quote.text).join('\n');
  const named = Object.keys(places).filter(place => places[place]!.test(text));
  if (named.length !== 1 || REFUSED.test(text) || DECLINED.test(text) || PUT_OFF.test(text) || CONDITIONAL.test(text) || otherDay(text)
    || !invited(text) && !ASKED.test(text) && !(/矿洞|矿井|矿坑|下矿|矿里|骷髅洞|火山/.test(text) && asksAlong(window, places[named[0]!]!))) return null;
  const place = named[0]!, words = places[place]!;
  // The player's own invitation counts; an NPC naming the place and "去" may be sending the player alone.
  const player = window.filter(quote => quote.speaker === '玩家');
  if (player.some(quote => PAST.test(quote.text)) || !player.some(quote => agrees(quote) || words.test(quote.text) && /一起|见|去|来|等|陪|带|跟|走|下矿|探险/.test(quote.text))
    || !window.some(quote => quote.speaker === 'NPC' && (agrees(quote)
      || words.test(quote.text) && /(?:一起|要不要|陪你|带你|我们|咱们).{0,10}(?:去|来|走)/.test(quote.text)))) return null;
  // The player taking it back needs no place: "还是算了，你忙吧".
  if (after.some(quote => movedTo(quote.text) || (REFUSED.test(quote.text) || DECLINED.test(quote.text)) && (quote.speaker === '玩家'
    || words.test(quote.text) || NOW_WORDS.test(quote.text) || /不去(?:了)?[。！!]?\s*$/.test(quote.text)))) return null;
  return { place, words };
}

/** The lines as far as times go: the player's whole, the NPC's only in clauses about meeting ("十一点开始上课" is its own day). */
function timedText(window: readonly TimedQuote[], places: Readonly<Record<string, RegExp>>): string[] {
  return window.map(quote => quote.speaker === '玩家' ? quote.text.replace(/今晚/g, '今天晚上').replace(/今早/g, '今天早上')
    : quote.text.split(/[，,。！!？?；;…]+/).filter(clause => MEETING_CLAUSE.test(clause) || Object.values(places).some(words => words.test(clause)))
      .join('，').replace(/今晚/g, '今天晚上').replace(/今早/g, '今天早上'));
}

/** A bare hour inherits an explicit period; only today's ambiguous clock may move to the evening after it has passed. */
function agreedClocks(timed: readonly string[], agreed?: number): number[] {
  const parsed = timed.flatMap(clockTimes);
  const periods = timed.flatMap(text => PERIODS.filter(([period]) => period.test(text)));
  return parsed.map(clock => {
    if (!clock.ambiguous) return clock.time;
    const explicit = [...new Set(parsed.filter(other => !other.ambiguous && other.time % 1200 === clock.time % 1200).map(other => other.time))];
    if (explicit.length === 1) return explicit[0]!;
    const inPeriod = [clock.time % 1200, clock.time % 1200 + 1200].filter(time => periods.length
      && periods.every(([, , start, end]) => time >= start && time < end));
    if (inPeriod.length === 1) return inPeriod[0]!;
    return agreed !== undefined && clock.time <= later(agreed, 10) && clock.time < 1200 ? clock.time + 1200 : clock.time;
  });
}

/** Whether a line names a day other than `today` outright; any named day counts when today is not known. */
const namesOtherDay = (text: string, today?: number) => DATE_WORDS.test(text) && (today === undefined || namedDays(text, today).some(day => day !== today));

/** Today's appointment in one stretch: a concrete time or a period still ahead, or else right away. */
function agreedIn(window: readonly TimedQuote[], after: readonly TimedQuote[], places: Readonly<Record<string, RegExp>>, today?: number): TodayAgreement | null {
  // "周六下午两点海边见" is not today, unless today is Saturday (docs/npc-later-meetings.md).
  const agreement = agreedPlace(window, after, places, text => ANOTHER_DAY.test(text) || namesOtherDay(text, today));
  if (!agreement) return null;
  const { place } = agreement;
  const agreed = window.at(-1)!.time;
  const timed = timedText(window, places);
  // Only a bare hour can inherit the agreed period. Explicit morning and 24-hour clocks never move to the evening.
  const periods = timed.flatMap(text => PERIODS.filter(([period]) => period.test(text)));
  const clocks = agreedClocks(timed, agreed);
  if (clocks.length) {
    if (clocks.some(value => value !== clocks[0]) || clocks[0]! <= later(agreed, 10) || clocks[0]! < EARLIEST || clocks[0]! > LATEST) return null;
    return { time: clocks[0]!, place, soon: false };
  }
  // "上午还要上课，下午见" at ten: the period still ahead is the one meant.
  const ahead = periods.filter(([, time]) => time > later(agreed, 10));
  if (ahead.length) return ahead.some(([, time]) => time !== ahead[0]![1]) || ahead[0]![1] > LATEST ? null : { time: ahead[0]![1], place, soon: false };
  // Only a period under way, or none: right away. One already over is a slip, not an appointment.
  return periods.some(([, , , over]) => agreed >= over) || agreed >= LATEST ? null : { time: agreed, place, soon: true };
}

/**
 * Today's appointment agreed in the conversation that just ended (docs/npc-same-day-meetings.md), checked by code
 * like the nightly one: two to four lines in a row naming one place, in which the player asks or agrees and the NPC
 * plainly agrees. A concrete time or a period still ahead is kept; none means right away. The latest agreement not
 * taken back afterwards wins; anything unsure means none.
 */
export function quotedToday(lines: readonly TimedQuote[], places: Readonly<Record<string, RegExp>>, today?: number): TodayAgreement | null {
  const agreed = (end: number) => lines[end]!.time;
  return latest(lines, (window, after) => agreedIn(window, after, places, today),
    (quote, found, end) => times(quote.text).some(other => other !== found.time && other > later(agreed(end), 10)));
}

/**
 * The latest agreement in a conversation: the shortest stretch, so talk after one does not lend it a time, each later
 * one replacing it. One changed afterwards without the place again ("还是三点吧？/行") is unsure, so none.
 */
function latest<T extends { time: number }>(lines: readonly TimedQuote[], read: (window: readonly TimedQuote[], after: readonly TimedQuote[]) => T | null,
  otherTime: (quote: TimedQuote, found: T, end: number) => boolean): T | null {
  let found: T | null = null;
  let foundEnd = -1;
  for (let end = 1; end < lines.length; end++) {
    for (let start = end - 1; start >= Math.max(0, end - 3, foundEnd + 1); start--) {
      const agreement = read(lines.slice(start, end + 1), lines.slice(end + 1));
      if (agreement) { found = agreement; foundEnd = end; break; }
    }
  }
  if (!found) return null;
  const settled = found;
  return lines.slice(foundEnd + 1).some(quote => (agrees(quote) || /还是|改|换|一起|见|约/.test(quote.text)) && otherTime(quote, settled, foundEnd))
    ? null : found;
}

/** An appointment for a later day than tomorrow, named outright: absolute `day`, HHMM `time` (docs/npc-later-meetings.md). */
export interface LaterAgreement { day: number; time: number; place: string }

/** One stretch naming one later day, up to two weeks ahead, with a concrete time or a period. */
function agreedLater(window: readonly TimedQuote[], after: readonly TimedQuote[], places: Readonly<Record<string, RegExp>>, today: number): LaterAgreement | null {
  // Tomorrow said only as "明天" is the nightly `meet`'s; named another way ("周五") the reply's "明天" is the same day.
  if (!window.some(quote => DATE_WORDS.test(quote.text))) return null;
  const days = [...new Set(window.flatMap(quote => namedDays(quote.text, today)))];
  if (days.length !== 1 || days[0]! <= today || days[0]! > today + LATER_DAYS) return null;
  // "后天再去" after agreeing on the day after tomorrow moves nothing; "改明天吧" does.
  const movedTo = (text: string) => changesDay(text) && (namedDays(text, today).length === 0 || namedDays(text, today).some(day => day !== days[0]));
  const agreement = agreedPlace(window, after, places, text => VAGUE.test(text), movedTo);
  if (!agreement) return null;
  const timed = timedText(window, places);
  const clocks = agreedClocks(timed);
  const periods = timed.flatMap(text => PERIODS.filter(([period]) => period.test(text))).map(([, time]) => time);
  const found = clocks.length ? clocks : periods;
  if (!found.length || found.some(time => time !== found[0]) || found[0]! < EARLIEST || found[0]! > LATEST) return null;
  return { day: days[0]!, time: found[0]!, place: agreement.place };
}

/**
 * An appointment for a day after tomorrow agreed in the conversation that just ended, named outright ("周六下午两点海边见",
 * "后天上午陪我下矿"); checked like today's, and tomorrow is left to the nightly `meet` (docs/npc-later-meetings.md).
 */
export function quotedLater(lines: readonly TimedQuote[], places: Readonly<Record<string, RegExp>>, today: number): LaterAgreement | null {
  return latest(lines, (window, after) => agreedLater(window, after, places, today),
    (quote, found) => times(quote.text, false).some(other => other !== found.time) || namedDays(quote.text, today).some(day => day !== found.day));
}

/** Who took today's appointment back, or sent the other home: the player or the NPC (docs/npc-call-off.md). */
export type CallOff = '玩家' | 'NPC';

// Plain words only, unlike REFUSED above: a wrong call-off walks the NPC away. Questions and conditions never count.
const PLAYER_OFF = /不(?:去|来)了|别(?:去|来|等(?:我)?)了|不用(?:去|来)了|改天(?:再)?去|下次(?:再)?去/;
// Sending company home; one that says it is staying ("凭什么让我先走？再往下一点点嘛") stays until the player insists.
const SEND_HOME = /你(?:先)?(?:回去|回家|走)吧|你可以(?:回去|回家|走)了|不用(?:再)?(?:陪|帮|等)(?:我)?了|今天(?:就)?(?:到这|先这样)/;
const STAY = /才不|不要|不走|不回|凭什么|赶我|再(?:往下|走|待|呆|玩)|还没(?:看够|玩够|走够)|别赶/;
const PLAYER_CANCEL = /取消|算了/;
// The NPC only when it says it cannot come; the player too.
const NPC_OFF = /去不了|来不了|不能去了|不能来了|没法去|没办法去|去不成|来不成/;
const ABOUT = /约|见面|今天|待会|等会|一会|上午|中午|下午|傍晚|晚上/;
const ON_AGAIN = /还是(?:去|一起|见|要)|开玩笑|逗你/;

/** A line that takes an appointment at `words` back, or sends company home; a question or a condition never does. */
function offLine(quote: TimedQuote, words: RegExp): boolean {
  const text = quote.text;
  if (/[吗？?]/.test(text) || CONDITIONAL.test(text)) return false;
  return quote.speaker === '玩家'
    // "今天就算了吧", "矿洞那边取消吧": in the same clause, not "算了，我回农场了".
    ? PLAYER_OFF.test(text) || SEND_HOME.test(text) || text.split(/[，,。！!；;]+/).some(clause => PLAYER_CANCEL.test(clause) && (words.test(clause) || ABOUT.test(clause)))
      // "不去矿洞那边了", "今天不下矿了".
      || new RegExp(`不(?:去|来)?.{0,2}(?:${words.source}).{0,4}了`).test(text) || NPC_OFF.test(text) && (words.test(text) || ABOUT.test(text) || /(?:不了|不成|不能去|不能来)了[。！!～~]?$/.test(text))
    : NPC_OFF.test(text) && (words.test(text) || ABOUT.test(text));
}

/** The last line, among those `about` admits, that calls it off and was not taken up again afterwards, and who said it. */
function lastCallOff(lines: readonly TimedQuote[], words: RegExp, about: (quote: TimedQuote) => boolean,
  again: (after: readonly TimedQuote[]) => boolean): CallOff | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!about(lines[i]!) || !offLine(lines[i]!, words)) continue;
    const after = lines.slice(i + 1);
    const onAgain = after.findIndex(quote => quote.speaker === '玩家' && ON_AGAIN.test(quote.text));
    if (again(after) || onAgain >= 0 && after.slice(onAgain + 1).some(quote => quote.speaker === 'NPC' && agrees(quote))) return null;
    const answer = after.find(quote => quote.speaker === 'NPC');
    if (SEND_HOME.test(lines[i]!.text) && answer && STAY.test(answer.text) && !/(?:好吧|行吧|那).{0,10}(?:回去|走)/.test(answer.text)) return null;
    return lines[i]!.speaker;
  }
  return null;
}

/**
 * Whether the conversation that just ended took back today's appointment at `words`, or sent the NPC home, and who
 * did; null if not, or if it was taken up again afterwards in the same conversation. Another day's plans ("明天没法去农场",
 * "周六不去海边了") leave today's alone.
 */
export function quotedCallOff(lines: readonly TimedQuote[], words: RegExp, places: Readonly<Record<string, RegExp>>, today?: number): CallOff | null {
  const otherDay = (text: string) => TOMORROW.test(text) || namesOtherDay(text, today);
  return lastCallOff(lines, words, quote => !otherDay(quote.text) || quote.text.split(/[，,。！!；;]+/).some(clause => /今天/.test(clause)
    && !otherDay(clause) && offLine({ ...quote, text: clause }, words)),
    after => quotedToday(after, places, today) !== null);
}

/** Whether the conversation took back the appointment on later `day` at `words`; the line must name that day (docs/npc-later-meetings.md). */
export function quotedLaterCallOff(lines: readonly TimedQuote[], words: RegExp, places: Readonly<Record<string, RegExp>>, day: number, today: number): CallOff | null {
  return lastCallOff(lines, words, quote => namedDays(quote.text, today).includes(day), after => quotedLater(after, places, today)?.day === day);
}
