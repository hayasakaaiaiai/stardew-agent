# Stardew NPC Agent：记忆内核

基于 Cordis 的轻量 NPC 记忆运行时。当前完成 M1：独立 NPC Session、中文记忆检索、游戏日提交与回滚，以及后端进程恢复。默认创建 34 个社交 NPC 的会话句柄，共享两个全局服务和一个数据库 Worker。

**本文只讲记忆内核。**对话、真实模型和游戏 Mod 见各自的设计文档，整个项目的进度、分支、环境和下一步见 [`docs/status.md`](docs/status.md)。记忆内核本身还没有自主行动循环：`NpcAgent` 现在是独立会话记忆句柄，验证的是数据与存档规则。

## 运行

需要 Node.js 24；依赖版本由 `package-lock.json` 锁定。

```sh
npm ci
npm run demo
npm test
npm run typecheck
npm run build
npm run demo:built
```

示例在操作系统临时目录创建数据库，退出时清理。测试不访问游戏文件，不联网，不使用模型密钥。`demo:built` 需要先执行 `build`，用于验证编译后的 JavaScript 与数据库 Worker。

## 数据流

```text
多个 NpcAgent 句柄
    ├─ record → 当天 DayTxn → JSONL 追加 + sync → 确认接收
    └─ context / recall
            ↓
      一个 StoreService / DB Worker
            ├─ SQLite：提交树、状态、原始事件和记忆
            ├─ Jieba：中文分词与查询规范化
            └─ FTS5 召回 → 分支/知情范围过滤 → 本地排序
```

记忆、对话、计划和情绪都属于当前存档分支。角色卡仍保存在 `data/npcs/`，本阶段不负责加载或修改角色卡。

## 最小使用方式

```ts
import { createRuntime } from './src/index.ts';

const runtime = await createRuntime({
  databasePath: '.runtime/memory.sqlite',
  journalDirectory: '.runtime/scratch',
});

try {
  const save = await runtime.ctx.saves.load({
    lineageId: '当前游戏的稳定身份',
    loadNonce: '本次读档的随机身份',
    day: 1,
  });
  const abigail = save.agent('abigail');
  await abigail.record({
    seq: 1,
    gameTime: 1 * 1440 + 600,
    log: { player: '明天一起去海边吧？', npc: '好呀。' },
    memories: [{ text: '玩家邀请我明天去海边', topics: ['海边'], importance: 4 }],
    state: {
      mood: '期待',
      plans: [{ dueDay: 2, intent: '与玩家去海边', status: 'pending' }],
    },
  });
  const context = await abigail.context({ query: '海边', nowGameTime: 2100 });
  console.log(context);

  // 将这个 ID 随游戏存档记录。真正收到“游戏保存成功”后才能 confirm。
  await save.prepare('本次游戏存档的唯一提交ID');
  await save.confirm('本次游戏存档的唯一提交ID');
  await save.startDay(2);
} finally {
  await runtime.close();
}
```

`record` 的 `state` 是**整对象快照**，会替换该 NPC 上一份状态，不是深度合并补丁。更新一个字段时先读取现有状态再构造新快照。`memories` 是追加数据，`log` 是原始对话或观察。跨 NPC 事件用 `save.record({ seq, gameTime, changes: [...] })` 一次记录，提交时一起保留或回滚。

`seq` 在同一次游戏读档中递增，多个 NPC 共用序列；新读档可以从 1 开始。同一个序号补发相同内容不会重复写入，不同内容会报错。`gameTime` 和 `nowGameTime` 都是包含游戏日的绝对游戏分钟，不是现实时间，也不是原版 HHMM 整数。

## 保存、回滚与恢复

- 每个“存档谱系 × NPC”是一个逻辑 Session。它由当前提交的祖先路径，加上当天工作区组成，不会为每位 NPC 单独创建数据库。
- `prepare` 立即禁止新写入、取消当天信号，等待已接收事件完成后，使用一个短 SQL 事务写入所有 NPC 的待确认提交。
- `confirm` 只能用于游戏保存确实成功的情况。它推进 `head`、卸载当天 Agent 句柄并删除当天临时日志。随后 `startDay` 创建新的工作区和句柄。
- `returnToTitle(lineageId)` 丢弃当天内容。重新加载旧 `commitId` 时，只能读取它及其祖先；从旧档继续保存会生成新分支。
- `runtime.close()` 保留当天 JSONL，适用于后端停机。重新启动后，仅当 `lineageId`、`loadNonce`、基础提交点、游戏日全部一致时恢复。换一个 `loadNonce` 不会继承上次未保存的内容。
- 同一运行中以相同身份重新 `load`，会保留已有工作区；不以重连当成重新读档。
- 存档明确引用一个 `prepared` 提交时，说明游戏已保存了这个指针，加载过程会确认它。这覆盖“游戏保存成功，但后端没收到成功通知”的窗口。
- 新建或首次接入的存档不提供 `commitId`，从创世提交开始。已有存档也缺少指针时仍从创世开始，**不猜测最新历史**；显式指向缺失或别的谱系的提交则报错。

游戏文件与 SQLite 不是同一事务。M1 内核提供应用层协议和可恢复数据；游戏端提交指针、生命周期补发与断线握手在 M3b 桥接层实现，见 [存档记忆接入](docs/game-memory.md)；当前真机验收状态见 [项目现状](docs/status.md)。

JSONL 每次事件落盘后才确认；异常中断留下的最后半行可以丢弃并截断，完整行损坏会报错。过期 nonce 的文件不会用于恢复。同一个存档用新的 nonce 读档成功后，`SaveManager` 删除这个存档其他 nonce 的 JSONL（`DayJournal.prune`），后端中途重启过也一样；不再读的存档会各留一份。只删文件名符合日志格式的文件。

## 检索与知情范围

默认记忆为 `private`，只供所属 NPC 的单独调用使用；`normal` 可用于该 NPC 参与的共享场景。其他 NPC 不会直接继承它：转述必须作为事件写进接收者的分区。

`context({ sharedScene: true, ... })` 只返回 `normal` 记忆，状态与当天原始记录为空。M1 的状态是自由 JSON，无法可靠判断其中是否含秘密，所以不把整个状态对象放进共享上下文。

SQL 先限制提交祖先路径、NPC、可见性、主题和退场标记，再应用候选上限。非空查询经 Jieba 分词、转成受控 FTS 表达式，以 BM25 召回最多 200 条；当天记忆使用同样的分词规则。最后结合词项匹配、重要度和游戏内新近程度排序。空查询取近期候选。返回值默认最多 8 条、正文合计最多 4000 个 Unicode 字符，**字符预算不是精确模型 token 预算**。

到期约定、当前计划直接保存在 `state` 中，调用方应直接检查，不依赖历史相似度检索。`retireMemoryIds` 让旧记忆在当前分支退场，不删除原文；读回退场之前的提交，仍能召回它。

## 夜间整合接口

`consolidateCommit` 给调用方传入的整理函数提供某个**已保存提交**的日志、状态和历史记忆。每次模型调用只有一个 NPC 的私密输入，当天没有日志的 NPC 跳过。每个 NPC 最多提供 1000 条历史记忆；不会把正在进行的新一天混进输入。

```ts
import { consolidateCommit } from './src/index.ts';

await consolidateCommit(runtime.ctx.store, {
  lineageId: '当前游戏的稳定身份',
  commitId: '已经保存的提交ID',
  npcIds: ['abigail', 'sebastian'],
}, async (input, signal) => {
  signal.throwIfAborted();
  // 后续在这里调用真实模型；现在可返回确定性的假摘要和计划。
  return [];
});
```

一次 `consolidateCommit` 是该提交的完整整合批次，各 NPC 的输出最终一起提交。输出只追加到来源提交，原始事件不改写；同一提交完成后不再重新调用模型，也不能换一份结果覆盖。`demo.ts` 使用假模型演示这条路径。用真实模型的整理器和存档后的自动调度在 Agent 层，见 [夜间整合](docs/nightly-consolidation.md)；还没有每周/每季摘要。

## 实现与学习入口

- [学习指南](docs/learning-memory.md)：7 个单元、官方资料、练习与验收目标。
- [设计草案](docs/design.md)：完整系统方向及后续里程碑。
- [运行时入口](src/index.ts)、[数据类型](src/types.ts)。
- [存储与 SQL](src/services/store/database.ts)、[Worker](src/services/store/worker.ts)、[中文分词](src/services/store/tokenizer.ts)。
- [当天工作区](src/save/day.ts)、[提交协调](src/save/ledger.ts)、[恢复日志](src/save/journal.ts)。
- [NPC 句柄](src/agent/npc.ts)、[排序](src/agent/memory.ts)、[整合接口](src/agent/consolidation.ts)。
- [行为测试](tests/memory.test.ts)：含真正 SIGKILL 后端子进程、重新读档分叉、跨 NPC 回滚和中文短词检索。

代码保持严格类型检查。TypeScript 使用 ESNext/Bundler 解析以兼容 Cordis rc.11 发布包的无扩展名类型导出；本项目的相对导入显式使用 `.ts`，构建时重写成 `.js`，产物直接由 Node 运行。数据库版本目前为 1；遇到更高版本会拒绝打开，没有自动迁移实现。
