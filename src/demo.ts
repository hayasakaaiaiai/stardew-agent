import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, consolidateCommit, SOCIAL_NPCS } from './index.ts';
import type { Consolidator, RuntimeConfig } from './index.ts';

// The fake model only exercises data flow; it does not evaluate dialogue quality.
const fakeModel: Consolidator = async input => input.npcs.filter(npc => npc.logs.length > 0).map(npc => ({
  npcId: npc.npcId,
  state: { ...npc.state, mood: '期待', plans: [{ dueDay: input.commit.dayEnded + 1, intent: '与玩家去海边散步', status: 'pending' }] },
  memories: [{ text: '玩家邀请我明天去海边散步，我答应了', kind: 'summary', importance: 4, topics: ['海边', '约定'] }],
}));

const directory = await mkdtemp(join(tmpdir(), 'stardew-memory-demo-'));
const config: RuntimeConfig = { databasePath: join(directory, 'memory.sqlite'), journalDirectory: join(directory, 'scratch') };
let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
try {
  runtime = await createRuntime(config);
  let save = await runtime.ctx.saves.load({ lineageId: 'demo-farm', loadNonce: 'first-load', day: 1 });
  console.log(`已加载 ${save.agents.size} 个独立 NPC 会话，共用 1 个数据库 Worker。`);
  assert.equal(save.agents.size, SOCIAL_NPCS.length);
  await save.agent('abigail').record({ seq: 1, gameTime: 1 * 1440 + 600,
    log: { player: '明天一起去海边吧？', npc: '好呀，我带点零食。' },
    memories: [{ text: '玩家邀请我明天去海边', topics: ['海边'], importance: 4 }] });
  assert.equal((await save.agent('abigail').recall({ query: '海边', nowGameTime: 2100 })).length, 1);
  assert.deepEqual(await save.agent('sebastian').recall({ query: '海边', nowGameTime: 2100 }), []);
  await save.prepare('demo-day-1'); await save.confirm('demo-day-1');
  await consolidateCommit(runtime.ctx.store, { lineageId: 'demo-farm', commitId: 'demo-day-1', npcIds: [...SOCIAL_NPCS] }, fakeModel);
  await save.startDay(2);
  console.log('第 1 天已保存：中文“海边”可召回；Sebastian 不知道私下的邀请。');

  await save.agent('abigail').record({ seq: 2, gameTime: 2 * 1440 + 600,
    state: { mood: '担心', plans: [{ intent: '明天去矿洞' }] }, memories: [{ text: '今天临时改约去矿洞' }] });
  await runtime.ctx.saves.returnToTitle('demo-farm');
  save = await runtime.ctx.saves.load({ lineageId: 'demo-farm', loadNonce: 'reloaded-game', day: 2, commitId: 'demo-day-1' });
  const restored = await save.agent('abigail').context({ query: '海边', nowGameTime: 3000 });
  assert.equal(restored.state.mood, '期待');
  assert.deepEqual(await save.agent('abigail').recall({ query: '矿洞', nowGameTime: 3000 }), []);
  console.log('第 2 天没保存就退出：矿洞记忆和计划已回退，保留第 1 天的海边约定。');

  await save.agent('abigail').record({ seq: 1, gameTime: 3000, memories: [{ text: '后端重启之前又聊过生日' }] });
  await runtime.close(); // Keep the scratch journal, simulating a backend restart while the game remains open.
  runtime = await createRuntime(config);
  save = await runtime.ctx.saves.load({ lineageId: 'demo-farm', loadNonce: 'reloaded-game', day: 2, commitId: 'demo-day-1' });
  assert.equal((await save.agent('abigail').recall({ query: '生日', nowGameTime: 3000 })).length, 1);
  console.log('同一次读档中重启后端：当天生日话题已恢复；完整性断言全部通过。');
} finally {
  await runtime?.close();
  await rm(directory, { recursive: true, force: true });
}
