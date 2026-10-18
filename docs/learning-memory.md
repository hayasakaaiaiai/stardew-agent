# NPC 记忆内核学习指南

这份指南围绕本项目的 M1：用 Node 24、TypeScript、Cordis、SQLite、FTS5 和中文分词，完成能随游戏存档提交、回滚和恢复的 NPC 记忆内核。学习目标是能读懂实现、独立修改一个功能，并用测试证明没有串档或泄露未来记忆。

M1 使用离线假模型模拟互动。SMAPI 游戏连接、真实云端模型、NPC 移动和完整自主调度属于后续阶段。你可以先在终端理解整条数据链路，之后再接游戏。

当前 `NpcAgent` 提供的是每个 NPC 独立的会话记忆句柄：`record()` 写入，`context()` / `recall()` 读取，并随当天作用域接收取消信号。它还没有自主决策循环，也不会自行调用模型或控制游戏。M1 的 `consolidateCommit()` 接收调用方提供的整理函数，负责读取指定提交的输入、检查取消并保存整合结果；离线示例传入确定性的假模型，真实摘要生成器和自动夜间调度留给后续 Agent 层。

## 先认识系统中各部分的位置

```text
NPC 会话句柄 → Cordis 共享存储服务 → 一个数据库 Worker
      ↓                                ├─ Jieba 中文分词
当天工作区 + 临时 JSONL 日志              ├─ SQLite：历史、状态、提交树、FTS5
                                       └─ 合并当天记忆并排序
```

每个 NPC 是独立的 Agent，拥有自己的状态分区；所有 Agent 可以共用同一进程、数据库服务和模型接口。NPC 数量并不要求相同数量的进程或数据库连接。

| 技术或概念 | 本项目中的用途 | 学到什么程度即可继续 |
|---|---|---|
| Node 24 + TypeScript | 写服务、描述消息和状态、运行脚本与测试 | 能读写模块、异步函数和带类型的对象 |
| Cordis | 管理插件、服务依赖、存档作用域和资源释放 | 能挂载服务、隔离实例，并正确卸载 |
| SQLite + `node:sqlite` | 持久化历史与状态 | 能建表、参数化读写、使用短事务和索引 |
| 提交树 + 当天工作区 | 对齐游戏存档、支持读旧档和新分支 | 能解释某条记忆为什么在当前读档中可见 |
| FTS5 + `@node-rs/jieba` | 中文关键词召回 | 能让短中文词被检索，同时保留权限与分支过滤 |
| Worker + JSONL + 取消信号 | 管理并发、后端恢复和过期结果 | 能定位一次请求的开始、完成、取消和恢复边界 |
| `node:test` | 用可重复场景验证正确性 | 能写出会在错误实现上失败的回滚测试 |

建议按下面七个单元顺序学习。每个单元以验收目标为准，不需要先看完所有文档。

## 单元 1：TypeScript、Node 模块和异步执行

**用途**：理解数据如何从调用方进入服务，如何等待 Worker 返回结果，以及为什么“函数还在执行”会影响读档回滚。

**最小必学知识**：

- JavaScript 的对象、数组、`Map`、闭包、异常和 `try/finally`。
- `import` / `export`、ES Modules，以及文件路径相对哪个模块解析。
- TypeScript 的 `type`、`interface`、可选字段、联合类型、类型收窄和 `import type`。
- `Promise`、`async/await`，以及并发发起与顺序等待的区别。
- 用 `unknown` 接收不可信 JSON，再逐项校验；类型声明本身不会验证运行时输入。

先读 [TypeScript 常用类型](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html) 和 [类型收窄](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)。项目直接运行 `.ts` 文件，用 Node 的类型剥离能力；运行代码不会顺便做类型检查，仍需单独执行 `npm run typecheck`。这个命令通过 `tsconfig.check.json` 同时检查源码和测试，不生成产物。本仓库的 `erasableSyntaxOnly` 限制了需要生成运行时代码的语法，例如 `enum` 和构造函数参数属性。参见 [Node 24 TypeScript 支持](https://nodejs.org/download/release/v24.0.0/docs/api/typescript.html)。

本仓库使用 `module: "ESNext"` 和 `moduleResolution: "Bundler"` 做类型检查：Cordis rc.11 发布的 `.d.ts` 使用无扩展名的相对导出，采用 NodeNext 时无法按预期解析。这里没有增加打包器；源码仍显式使用 `.ts` 相对路径并由 Node 直接执行，构建时用 `rewriteRelativeImportExtensions` 将这些路径改为 `.js`。不要因为选项名叫 Bundler 就在源码中省略扩展名。可对照 [模块解析选项](https://www.typescriptlang.org/tsconfig/moduleResolution.html) 和 [扩展名重写](https://www.typescriptlang.org/tsconfig/rewriteRelativeImportExtensions.html)。

**短练习**：在临时目录定义一个联合类型，描述 `talk`、`prepare`、`confirm` 三种事件。写一个分发函数，按事件种类读取对应字段；再用一个手动控制完成时机的 Promise 模拟迟到的回复。

**验收目标**：能说明“代码能执行”和“类型检查通过”分别证明什么；能让编译器指出把 `confirm` 当成 `talk` 使用的错误；能解释为什么先调用的异步函数可能后完成。

## 单元 2：Cordis 服务、插件和生命周期

**用途**：全局共享数据库服务，为不同存档提供隔离的状态；关闭当天工作区时，停止依赖它的活动。

**最小必学知识**：

- `Context` 是访问服务和注册副作用的入口。
- 插件负责安装功能，`Service` 提供可供其他插件调用的能力，`inject` 描述依赖。
- 作用域和 `isolate` 决定某个服务实例对哪些调用方可见。
- `ctx.on()`、`ctx.effect()` 和 disposer 管理事件监听、定时器及释放逻辑。
- `dispose()` 的异步清理需要被等待；异步任务也要主动响应取消。
- TypeScript 的模块声明合并如何给 `Context` 补上服务类型。

阅读 [Cordis 上游仓库](https://github.com/cordiverse/cordis) 和上游 README 链接的 [Cordis 入门](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer)。项目锁定 `cordis@4.0.0-rc.11`；在线教程可能对应更新版本，具体方法签名和清理顺序要结合本仓库安装的类型定义与测试核对。学习时先掌握服务、依赖和生命周期，不必先学习整个 DeepSeek Harness。

**短练习**：创建一个共享的记录服务，再创建两个隔离的存档服务。让两个小插件分别写入各自存档，并各自注册一项可释放的副作用。卸载其中一个存档，观察另一方仍能工作。

**验收目标**：能画出“共享服务 → 存档 → 当天 → NPC”的依赖关系；关闭一天后不再出现该天的监听器或定时器；能指出隔离服务与按 `npcId` 分区分别解决什么问题。

## 单元 3：SQLite 建模和 `node:sqlite`

**用途**：让 NPC 的对话、记忆、状态和存档历史跨进程保留，并让关联数据一起写入成功或一起失败。

**最小必学知识**：

- `CREATE TABLE`、`SELECT`、`INSERT`、`UPDATE`，以及 `WHERE`、`ORDER BY`、`LIMIT`、`JOIN`。
- 主键、外键、唯一约束和索引；JSON 文本适合放复杂状态，常用过滤字段应有独立列。
- 参数化语句：`prepare()` 后绑定参数，避免把玩家文本拼进 SQL。
- `BEGIN` / `COMMIT` / `ROLLBACK` 的边界，以及失败后的异常处理。
- 数据库版本迁移：已有数据库如何增加字段或索引。

从 [Node 24 SQLite API](https://nodejs.org/download/release/v24.0.0/docs/api/sqlite.html) 中的 `DatabaseSync`、`StatementSync` 学起，再读 [SQLite 事务](https://sqlite.org/lang_transaction.html)。`DatabaseSync` 是同步接口；本项目把它放到专用 Worker，主线程通过异步消息访问。

练习时先分清三种数据：原始对话用于追溯，情节记忆用于召回，当前状态与计划用于直接读取。计划应有结构化字段，例如约定对象、游戏时间和完成状态；重要的赴约提醒不能只依赖关键词检索。

当前 `NpcState` 是可存 JSON 的对象，尚未规定完整的计划类型或实现到期提醒。写入 `state` 表示一份完整状态快照，读取时取当前路径上最近的快照，不会自动按字段合并。修改情绪时，如果还需要保留计划，应先取出状态、构造完整新快照再写入。

**短练习**：建立一个临时数据库，写入一条对话和一条来源指向该对话的记忆。把两次插入放在同一事务中，故意让第二次违反约束，确认第一条也没有留下。然后关闭、重新打开数据库，检查成功写入的数据仍在。

**验收目标**：能写出“某 NPC 在某提交点上的记忆”查询；能用约束阻止重复记录；能解释新增一个字段是否需要迁移。

### 易混概念：Agent Session 与 SQLite Session API

| 名称 | 含义 | 本项目如何使用 |
|---|---|---|
| NPC / Agent Session | 当前存档谱系中，某 NPC 在当前分支上的持续经历 | 由存档身份、NPC 身份、提交路径和当天工作区共同决定 |
| SQLite `Session` / `createSession()` | 追踪表变化并导出 changeset / patchset 的数据库功能 | 不会自动生成 NPC 会话，也不负责游戏存档对齐 |

可以先跳过 SQLite Session API。本项目的 NPC Session 是业务概念。需要了解数据库变化集时，再读 [SQLite Session 扩展](https://sqlite.org/sessionintro.html)。

## 单元 4：提交树、当天工作区和存档协议

**用途**：实现“睡觉存档才保留今天；没保存退出就忘掉；恢复旧档后还能重新玩”。这是本项目最重要的业务知识。

**最小必学知识**：

- `lineageId` 表示一局游戏的谱系；`npcId` 表示角色；`commitId` 表示一个 Agent 保存点。
- `head` 是本次读档指向的提交点，日期本身不能唯一识别分支。
- 当天工作区保存从 `head` 出发的未提交变化，包括对话派生出的记忆、情绪和计划。
- 提交节点保留父指针，旧历史只追加；读档回退通过选择旧节点完成。
- 幂等性：同一 `prepare`、`confirm` 或补发操作重试，不应产生重复内容或不同结果。
- 递归 CTE 可以沿父指针查询祖先路径。阅读 [SQLite WITH / Recursive CTE](https://sqlite.org/lang_with.html)。

```text
创世 C0
└─ C1
   ├─ C2
   │  └─ C3
   └─ C2b
```

读档到 `C2b`，可见路径是 `C0、C1、C2b`；`C2` 和 `C3` 的经历不属于这条分支。上图的分叉从 `C1` 开始，因此两个分支各自的“同一天”可以有不同内容。

读取某 NPC 的上下文时，核心规则是：

```text
可见内容 = 当前提交路径上属于该 NPC 的内容 + 当前工作区属于该 NPC 的内容
```

记忆还要满足知情范围。A 私下知道的事，不会因为 B 共用数据库就自动成为 B 的记忆。来源记录和“转述给谁”的事件应进入接收者自己的分区。

保存协议包含三个关键步骤：

1. `prepare`：冻结当天工作区，把所有 NPC 的变化写入待确认提交。
2. `confirm`：收到游戏确实保存成功的依据，确认提交并移动 `head`。
3. 读档对齐或回滚：用游戏存档携带的提交指针选择历史；未保存的一天丢弃。待确认提交的去留由读档证据决定。

派生摘要也要绑定它依赖的提交点。由未来分支生成的摘要、计划或索引结果，不能出现在旧档中。

当前用 `src/agent/consolidation.ts` 的 `consolidateCommit()` 调用整理器：只读取明确指定的已确认提交及其祖先，不能把正在进行的新一天混进输入；模型前后均检查取消信号，输出校验后再提交。已完成整合的提交会直接返回，不再调用整理器。一次调用对应该提交的完整整合批次，适合练习“数据来源”和“可重复调用”怎样共同决定记忆的一致性。

这个完整批次里，整理器每次只看到一个 NPC 的私密历史，当天没有日志的 NPC 跳过；各 NPC 的输出收集完成后再一起写入数据库。可以对照隐私测试，理解“数据库一起提交”和“模型分别看到输入”分别解决什么问题。

源码中的“回滚”对应 `SaveManager.returnToTitle()` 丢弃当天，或 `load({ commitId: ... })` 重新对齐旧节点，并没有一个撤销全部历史的 SQL 命令。M1 要求已有存档传入准确的提交指针；未知 `commitId` 会报错，省略指针从创世节点开始。设计草案中按日期猜测、缺失提交后回退父节点等兼容策略尚未实现。

### 易混概念：SQL 事务与游戏存档提交

SQL 事务保证一次数据库写入的原子性。它成功后，游戏存档文件仍可能没有写成功。`prepare/confirm` 是应用层用来协调两边的协议，不会把游戏文件与数据库变成同一个原子事务。需要提交 ID、重试和启动校验处理两边先后完成的情况。

“回到旧档”通过切换提交路径完成；SQL `ROLLBACK` 只撤销尚未提交的数据库事务。整个游戏日保持在应用层工作区里，不需要让一个 SQL 事务持续一整天。

**短练习**：手工模拟 `C0 → C1 → C2`。在 `C2` 记住一个秘密，随后读回 `C1` 并生成 `C2b`。分别读取两个分支；再让 A 告诉 B 一件事，未保存就回滚，确认两者都忘记。

**验收目标**：能根据一条记忆的 `commitId` 判断当前是否可见；能解释只有 `prepared`、没有 `confirmed` 时为何不能直接判定游戏保存失败。

## 单元 5：FTS5、中文分词和记忆召回

**用途**：从允许读取的历史里找到与本轮话题相关的少量记忆，控制模型上下文长度。

**最小必学知识**：

- 全文索引保存便于搜索的表示，原始文本保留给显示、追溯和重建索引。
- `CREATE VIRTUAL TABLE ... USING fts5(...)`、`MATCH` 和 BM25 排序。
- 使用相同的分词与规范化规则处理入库文本和查询文本。
- 写入、检索时同时处理主题标签、NPC、存档分支、私密级别和退场标记。
- 用户文本先转成受控的查询词；SQL 参数绑定之外，还需正确处理 FTS 查询表达式中的引号、运算符和空查询。

FTS5 默认分词不会按本项目需要理解中文词边界。使用 `@node-rs/jieba` 预分词，再以空格连接检索字段；例如把“明天一起去海边吧”变成一组词，查询“海边”时使用同一规则。具体分词输出以安装版本和词典为准。游戏专名可以补主题标签或别名，例如“阿比盖尔 / Abigail”。参见 [结巴 Node 绑定的官方用法](https://github.com/napi-rs/node-rs/tree/main/packages/jieba)。

FTS5 的 `bm25()` 以较小数值表示更好的匹配。它提供词项相关性，不能保证理解“散步”和“海边约会”是相关经历。先用可解释的标签与规则改善，再评估语义检索。阅读 [FTS5 查询语法](https://sqlite.org/fts5.html#full_text_query_syntax) 和 [BM25](https://sqlite.org/fts5.html#the_bm25_function)。

当前实现先在数据库里过滤提交路径、NPC、私密级别、主题和退场标记，再按 FTS5 / BM25 召回已提交候选；随后与当天记忆合并，用关键词覆盖率、重要度和新近程度重新排序。最后这层 `score` 是数值越高越靠前，与 BM25 的方向不同。`limit` 控制条数，`maxChars` 控制文本字符数，当前不是精确的模型 token 预算。

调用 `context({ sharedScene: true, ... })` 时，只提供该 NPC 的 `normal` 记忆，`state` 为 `{}`、`today` 为 `[]`。M1 的状态和原始日志可以包含私密信息，不能把它们直接放进多人共享上下文。`normal` 也只代表该记忆可以用于所属 NPC 参与的共享场景，其他 NPC 仍需通过实际交流事件获得自己的副本。

检索必须保留可见范围。不要先从全库取固定数量的最高分记录，再删掉无权限内容，否则其他 NPC 或分支的记录可能挤掉真正相关的候选。到期约定、当前计划和固定角色资料走直接读取；历史回忆走召回。

**短练习**：准备十条含“海边、矿洞、生日”的中文记忆，加入另一位 NPC、另一份存档和未来分支的同词记忆。比较原始中文与分词字段的匹配结果，再测试引号、英文、两个汉字和无搜索词的输入。

**验收目标**：能用“海边”召回允许读取的相关记忆；任意查询都不能带出其他存档、未知秘密和未来分支；搜索字段能够从原始数据重新生成。

## 单元 6：数据库 Worker、JSONL 恢复与取消

**用途**：多个 Agent 共用存储时，把同步 SQL 操作集中管理；后端崩溃后恢复当天内容；读档后丢弃旧任务的结果。

**最小必学知识**：

- Worker 的 `postMessage`、消息编号、请求到 Promise 的映射、错误和退出处理。
- 在线程之间传普通数据；数据库连接留在创建它的 Worker 内。消息采用结构化克隆，不能把任意函数或类实例当作可用服务传过去。参见 [Node Worker Threads](https://nodejs.org/download/release/v24.0.0/docs/api/worker_threads.html)。
- 对写入操作排队，确保冻结、准备提交和状态修改具有明确顺序；队列还需考虑失败和关闭。
- JSONL 每行一个 JSON 操作，包含恢复所需身份和操作序号；读取时识别完整记录、重复操作与损坏尾行。
- `AbortController` / `AbortSignal` 用于合作式取消；任务返回后，写入前仍需验证工作区身份和开放状态。参见 [AbortController](https://nodejs.org/download/release/v24.0.0/docs/api/globals.html#class-abortcontroller)。

当前数据库连接、Jieba 词典、全文查询和最终排序都在同一个数据库 Worker 中。主线程负责当天工作区和文件日志，不加载分词词典。读 `src/agent/memory.ts` 时要留意：文件位于 `agent/` 目录，不代表它就在主线程执行；实际运行位置取决于谁导入并调用它。

恢复时需要分清两种情况：游戏仍在同一次读档中，后端重启，可以凭匹配的日志头恢复；日志头核对 `format`、`lineageId`、`loadNonce`、`baseCommitId` 和 `day`。游戏重新读档，`loadNonce` 改变，就应丢弃上一轮未保存内容。仅凭存档名字或游戏日期不足以确定可恢复。

日志的“写入成功”与“断电后保证存在”也不同。了解 `appendFile`、文件句柄、`sync`、关闭与错误处理即可；恢复承诺要与实现采用的同步策略相符。参见 [Node 文件系统 API](https://nodejs.org/download/release/v24.0.0/docs/api/fs.html)。不要默认异步写文件就天然保证最后一条操作不丢失。

本次 M1 的具体策略是：每个事件先追加一行 JSONL，再 `await handle.sync()`，之后才加入可读取的当天状态并完成 `record()`。这比设计草案里的定时批量刷盘更保守；学习时可检查 `DayJournal.append()` 和 `DayTxn.record()` 的调用顺序，理解确认点为何在 `sync()` 之后。进程被强制终止的恢复场景有自动测试，实际存储设备的断电保证仍取决于系统与硬件。

### 易混概念：SQLite WAL 与项目临时日志

| 日志 | 谁管理 | 记录什么 | 解决什么问题 |
|---|---|---|---|
| SQLite WAL | SQLite 引擎 | 数据库页的变更 | SQLite 自身的事务与恢复；读写并发 |
| 项目 JSONL | 本项目 | 当天尚未正式提交的业务操作和恢复身份 | 同一次游戏读档中，重建后端的当天工作区 |

WAL 不了解 NPC、游戏保存和 `loadNonce`。JSONL 也不能代替数据库原子事务。WAL 模式仍然只有一个写入者，单 Worker 的作用是集中数据库访问并把同步执行移出主线程。阅读 [SQLite WAL](https://sqlite.org/wal.html)。

**短练习**：给一项模型请求设置手动完成按钮，在它返回前回滚。确认结果无法写入。另做一个日志回放程序：写入三条操作，模拟末尾半条 JSON；用相同身份恢复完整操作，再用新 `loadNonce` 验证不能恢复。练习前复制一份临时日志，不操作游戏数据。

**验收目标**：能解释“取消请求”和“拒绝过期写入”为何都要有；同一条事件补发两次不重复生效；Worker 异常退出后调用方得到错误，不会永远等待。

## 单元 7：用确定性测试理解整个内核

**用途**：先证明保存、回滚和检索的规则成立，之后接入真实模型时才知道错误出在哪一层。

**最小必学知识**：

- `node:test`、`node:assert/strict`、测试前后资源清理和临时目录。
- 假模型根据固定输入返回固定输出；用受控 Promise 制造竞态，不靠随机回复或长时间睡眠。
- 将读档、保存、重启、重复消息和失败窗口构造成事件序列。
- 断言业务不变量，而不是仅断言某个方法被调用。

阅读 [Node Test Runner](https://nodejs.org/download/release/v24.0.0/docs/api/test.html)。本项目测试不需要真实模型密钥和网络；假模型用于验证状态流转，不用于衡量 NPC 的对话质量。

练习优先覆盖这些情形：

| 场景 | 应证明的不变量 |
|---|---|
| 对话后未保存就读档 | 对话及派生记忆、计划一起消失 |
| A 和 B 当天交流后回滚 | 两个 NPC 的未提交变化一起消失 |
| 两个存档同时加载 | 对话、状态、检索互不串档 |
| 旧档分叉后分别读取 | 公共祖先可见，两条后续分支互不可见 |
| 只有 `prepare`，随后重启 | 根据存档指针完成确认或保留旧历史 |
| 后端重启并重连 | 相同恢复身份可回放，新身份不能继承当天日志 |
| 旧模型请求迟到 | 不能写入新读档或被冻结的工作区 |
| 搜索命中未来摘要 | 即使词完全匹配，也不能越过提交路径过滤 |
| 多人共享上下文 | 只返回 normal 记忆，状态和原始当天记录保持为空 |
| 重复或取消整合 | 已完成提交跳过整理器，取消后的结果不能落入记忆 |

**短练习**：挑一个已经通过的回滚测试，先预测它保护哪条规则；在自己的练习分支中临时去掉相应检查，确认该测试会失败，再恢复检查。

**验收目标**：能新增一个“存档边界上的失败”测试，指出预期错误与观察证据；能够区分类型检查、自动测试和游戏内验证各自覆盖的范围。

## 在本仓库中怎样开始读

先读 `README.md`、`package.json`、`tsconfig.json` 和 `tsconfig.check.json`，理解当前范围、入口命令和语法限制，再读 `docs/design.md` 的 §3、§5、§6、§13、§14。设计文档包含后续阶段设想；M1 学习时以当前实现和测试为准。

下列路径均相对于仓库根目录。可以按学习单元查对应文件，也可以从 `NpcAgent.record()` 一路跟到数据库。

| 对应单元 | 源码路径与入口 | 阅读时要回答的问题 |
|---|---|---|
| 1：数据和类型 | `src/types.ts`；`src/validation.ts` | `DayEntry` 怎样同时修改多个 NPC？`SessionScope` 怎样指定当前历史？输入如何校验和复制？ |
| 2：插件启动 | `src/index.ts` 的 `createRuntime()` | 为何 34 个 NPC 只创建一个 `StoreService` 和一个数据库 Worker？失败时如何释放？ |
| 2：作用域 | `src/save/manager.ts`；`src/save/scope.ts` | `save` 与 `day` 在哪里隔离？旧作用域怎样卸载？NPC 句柄何时重新注册？ |
| 3：数据结构 | `src/services/store/schema.ts` | 每张表保存什么？`pathCte` 如何从 head 读取祖先？触发器怎样让 FTS 索引随记忆一起写入？ |
| 3、4：持久化 | `src/services/store/database.ts` 的 `prepare()`、`confirm()`、`state()`、`consolidate()` | 哪些写入共用一个 SQL 事务？状态快照怎样选择？整合为何不能任意覆盖？ |
| 4：白天变化 | `src/save/day.ts` 的 `record()`、`freeze()`、`overlay()` | `record()` 如何排队和去重？prepare 怎样立即拒绝新事件，又等待已接收事件落盘？ |
| 4：游戏提交 | `src/save/ledger.ts`；`src/save/scope.ts` 的初始化 | prepare 和 confirm 如何串行？存档指向 prepared 节点时怎样对齐？ |
| 4、7：保存后的整合 | `src/agent/consolidation.ts` 的 `consolidateCommit()`；`src/services/store/database.ts` 的 `consolidationInput()` | 如何锁定已提交输入？取消在哪些边界检查？为何已完成提交不应再次调用模型？ |
| 5：中文处理 | `src/services/store/tokenizer.ts` | `cutForSearch()`、Unicode 规范化、停用词和 FTS 引号分别解决什么问题？ |
| 5：检索和预算 | `src/services/store/database.ts` 的 `search()`、`context()`；`src/agent/memory.ts` | 哪些过滤发生在候选 LIMIT 之前？当天记忆怎样合入？BM25 与最终 score 的方向有什么不同？ |
| 6：线程边界 | `src/services/store/index.ts`；`src/services/store/worker.ts` | 请求编号怎样匹配 Promise？Worker 出错时谁拒绝未完成请求？分词词典在哪个线程加载？ |
| 6：恢复与取消 | `src/save/journal.ts`；`src/save/day.ts` | 什么时候确认事件？恢复核对哪些字段？半行日志怎样处理？旧句柄如何拒绝写入？ |
| 7：调用入口 | `src/agent/npc.ts` | `record()`、`context()`、`recall()` 做了什么？哪些职责仍留给后续自主 Agent？ |
| 7：行为证据 | `tests/memory.test.ts`；`tests/fixtures/crash-writer.ts` | 每个测试保护哪条不变量？强制终止进程的测试怎样与普通重启区别开？ |

最后结合 `src/demo.ts` 中的离线事件顺序观察整条链路。示例在系统临时目录创建数据库，并在退出时清理；它依次演示创建所有社交 NPC 句柄、私下邀请、提交第 1 天、用假模型整理记忆、未保存的第 2 天回滚，以及同一次读档中后端重启后恢复当天话题。它模拟游戏侧调用，不会建立真实 SMAPI 连接。

可从仓库根目录执行已定义的命令：

```sh
npm ci
npm run demo
npm test
npm run typecheck
npm run build
npm run demo:built
```

首次安装依赖时执行 `npm ci`。`demo` 展示离线事件流，`test` 验证业务规则，`typecheck` 检查源码与测试的类型，`build` 生成 JavaScript 输出。`demo:built` 在构建后运行产物及其 Worker，帮助检查 `.ts` 到 `.js` 的路径是否正确。学习时先追踪一条数据：玩家输入 → 当天工作区 → prepare → confirm → 整合 → 重启后读取；再追踪同样的输入在“直接退出”路径中如何被丢弃。

## 暂时可以放在后面的内容

先完成“写入、读取、检索、保存对齐、回滚、恢复”的闭环。向量数据库、分布式 Agent 框架、模型训练和复杂 ORM 不属于这条入门路径的前置要求。

需要语义召回时，可继续学习 embedding 的含义、相似度、模型版本与向量重建，再研究 [sqlite-vec 的 JavaScript 接入](https://alexgarcia.xyz/sqlite-vec/js.html)。即使增加向量检索，存档分支和 NPC 知情范围仍然必须先决定候选是否可见。
