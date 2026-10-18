/** Turns the mod's raw game state into the dialogue's WorldState (docs/game-bridge.md §3). */
import type { WorldState } from '../agent/dialogue.ts';
import type { PlayerInfo, Weather, WorldFlags, WorldSnapshot } from './protocol.ts';

const WEATHER: Record<Weather, string> = { sunny: '晴', rain: '下雨', storm: '雷雨', snow: '下雪', windy: '刮风' };

/** 1530 → "15:30"; the game clock runs to 2600, i.e. 2 a.m. */
export function clock(time: number): string {
  const hours = Math.floor(time / 100) % 24;
  const minutes = time % 100;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** The facts the cards' natural-language conditions depend on (see tools/chat/scenarios). */
export function worldFacts(year: number, flags: WorldFlags): Record<string, string> {
  const restored = flags.communityCenter === 'restored';
  const facts: Record<string, string> = {
    肯特: year >= 2 ? '已经退役回家了' : '还在前线打仗，第二年春天才回来',
    社区中心: restored ? '已经修好，镇上很热闹'
      : flags.communityCenter === 'joja' ? '玩家加入了 Joja，社区中心改成了 Joja 仓库' : '玩家正在修复，还没修好',
    'Joja 超市': restored ? '已经关门' : '照常营业',
    巴士: flags.busRepaired ? '已经修好，潘姆每天开巴士去卡利科沙漠' : '还没修好，没人能去卡利科沙漠',
    玩家会不会矮人语: flags.understandsDwarves ? '会' : '不会',
    潘姆的新房子: flags.pamHouse ? '已经盖好' : '还没盖',
    姜岛: flags.islandOpen ? '威利的船修好了，可以去姜岛' : '还去不了',
    谢恩: restored ? 'Joja 关门后失业了，还住在玛妮的牧场' : '在 Joja 超市上班',
  };
  if (flags.islandOpen) facts.雷欧 = flags.leoMoved ? '已经搬到山谷，住在山上的树屋' : '还住在姜岛';
  return facts;
}

export function worldState(snapshot: WorldSnapshot, player: PlayerInfo): WorldState {
  return {
    year: snapshot.date.year,
    season: snapshot.date.season,
    day: snapshot.date.day,
    time: clock(snapshot.date.time),
    weather: WEATHER[snapshot.weather],
    location: snapshot.location,
    player,
    facts: worldFacts(snapshot.date.year, snapshot.flags),
  };
}
