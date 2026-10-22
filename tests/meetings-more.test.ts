import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type TimedQuote, quotedToday } from '../src/agent/meeting-agreement.ts';
import { MEET_PLACES } from '../src/agent/meetings.ts';

const at = (time: number) => (speaker: '玩家' | 'NPC', text: string, id = speaker + text): TimedQuote => ({ id, speaker, text, time });

test('"一点" is one o’clock only as a time; "早一点", "人少一点", "一点都不" are a little (docs/npc-meetings-more.md §0)', () => {
  const said = (line: string) => quotedToday([at(1000)('玩家', line), at(1000)('NPC', '好啊，说定了。')], MEET_PLACES);
  assert.deepEqual(said('下午一点海边见？'), { time: 1300, place: '海滩', soon: false });
  assert.deepEqual(said('一点海边见？'), { time: 1300, place: '海滩', soon: false });
  assert.deepEqual(said('一点钟一起去海边吧？'), { time: 1300, place: '海滩', soon: false });
  assert.deepEqual(said('一点半海边见？'), { time: 1330, place: '海滩', soon: false });
  for (const line of ['早一点一起去海边吧？', '人少一点的时候一起去海边吧？', '一点都不累，一起去海边吧？']) {
    assert.deepEqual(said(line), { time: 1000, place: '海滩', soon: true }, line);
  }
});
