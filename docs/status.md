# 项目现状

> 更新于 2026-10-20。每做完一步就更新这份文档。各部分的细节在各自的设计文档里，见 §8。

## 1. 这个项目在做什么

让星露谷物语里 34 位可以培养好感的 NPC 由云端便宜模型驱动：
- 玩家能和 NPC 自由聊天。
- NPC 记得聊过什么。存档或不存档，记忆都和游戏进度一致。
- 以后 NPC 还会按时间自主行动，彼此互动。

整个系统分两部分，在本机用 WebSocket 通信：
- **后端**：Node.js + TypeScript，负责角色卡、记忆、调用模型。
- **Mod**：SMAPI + C#，负责从游戏里读状态，用原版界面显示对话。

## 2. 进度

| 里程碑 | 状态 | 已完成 | 还没做 | 文档 |
|---|---|---|---|---|
| M1 存储与事务 | 完成 | 记忆内核：SQLite 提交树、中文检索、当天事务、存档提交和回滚、后端崩溃恢复 | 自动清理过期的临时日志 | `README.md`、`design.md` §16 |
| M2 Agent | 完成一半 | 和玩家对话：角色卡加载、对话调用、接入记忆、好感度影响记忆 | 自主行动（调度器、合并场景调用、白名单动作）、夜间整合 | `dialogue-prototype.md` |
| M3 接入游戏 | M3a/M3b 已实现，Windows M3b 真机组合通过 | 游戏里"继续聊"；真实保存/退出、跨天记忆、回滚、后端进程重启与旧档分叉 | M3a 输入法等交互验收；Mac 验证 | `game-bridge.md`、`game-memory.md` |
| M4 内容 | 角色卡已完成 | 34 张角色卡（已审阅），"看过事件之后"共 201 条 | 物品名到 ID 的对应、各动作的上限 | `design.md` §11 |

后端 67 个测试、类型检查和构建通过，另有 13 项 C# 流程检查。10 月 20 日阿比盖尔三轮真机回归通过，随后在独立副本中用真实模型完成跨天保留、不保存回滚、后端进程重启、旧档分叉四项真机验收：76.77 秒，13 次模型调用，3 次真实睡觉保存，原测试档 6 个文件哈希均相同。详见 [真机组合验收报告](test-results/2026-10-20-game-memory.md)。

**M3a 的游戏内验证**按 `game-bridge.md` §7 的清单逐项试，Mac 和 Windows 都要试。重点看两项：
- "自己说"的输入框能不能用拼音输入法打中文。
- 聊完之后原版台词还在不在。

## 3. 分支

GitHub 私有仓库：https://github.com/hayasakaaiaiai/stardew-agent

| 分支 | 内容 | Mac 上的目录 |
|---|---|---|
| `main` | 已合入的基线：记忆内核 + 对话 + M3a | `/Users/a11/Documents/ChatGPT/stardew-agent-dialogue`（目录名是以前留下的） |
| `codex/npc-memory-store` | 记忆系统的开发分支，做完一步快进合并回 `main` | `/Users/a11/Documents/ChatGPT/stardew-agent` |
| `hardware-companion` | `main` + 硬件陪伴（机器人），还没合并 | `/Users/a11/Documents/ChatGPT/stardew-agent-hardware` |

Windows 当前开发分支是 `codex/game-save-memory`，包含前一分支的菜单修复和自动测试，以及本次 M3b 接入，目录 `E:\stardew-agent`。尚未合并进 `main`。

- Mac 上的三个目录是同一个仓库的三个 git worktree。同一个分支只能在一个目录里打开。
- 2026-10-19 把记忆系统和对话合并进了 `main`，原来的 `dialogue-prototype` 分支已删除。
- 不经你同意不合并进 `main`。`main` 有新提交时，把还没合并的分支变基到 `main` 上。
- 对话和机器人这两条线只新增 `src/` 下的文件，不改记忆系统已有的 `src/` 文件，所以和记忆分支能干净地合并。

## 4. 环境

| 需要的 | Mac | Windows |
|---|---|---|
| Node.js 24 或更高 | 已装（24.18） | 已装（24.14.1），依赖已用 `npm ci` 安装 |
| .NET SDK（只有编译 Mod 时需要） | .NET 8 装在 `~/.dotnet`，没加进 PATH，用 `~/.dotnet/dotnet` 调用 | 已装 9.0.202，可编译目标为 `net6.0` 的 Mod |
| 星露谷 1.6 + SMAPI | Steam 版 | Steam 版 1.6.15 + SMAPI 4.5.2 |
| 模型 | DeepSeek 官方接口，填在 `.env` 里 | 已在本机 `.env` 配好 `deepseek-flash`，`thinking=high` |

Windows 本机安装与验证（2026-10-19）：

- 项目位于 `E:\stardew-agent`，Release Mod 已安装到 `E:\games\steamapps\common\Stardew Valley\Mods\StardewAgentBridge`。
- 44 个自动测试和类型检查通过；Mod 编译为 0 警告、0 错误，安装后的 DLL 与编译产物哈希一致。
- 用模拟 Mod 的 WebSocket 客户端调用真实模型，完成开启对话、收到 3 个选项、选择选项继续对话和关闭对话；两轮端到端耗时分别为 1.687 秒、1.469 秒。结果保存在本机 `.runtime/smoke-result.json`。
- 已通过桌面“星露谷 AI 对话测试”快捷方式启动游戏；SMAPI 日志确认新版 Mod 加载成功并连接 `ws://127.0.0.1:47711`。以后双击该快捷方式会启动后端和 SMAPI，后端日志在本机 `.runtime/bridge.stdout.log`。
- 游戏里的中文输入、原版台词保留和其他交互仍按 `docs/game-bridge.md` §7 由用户验证；本条为 10 月 19 日的安装记录，M3b 后续进展见下文。
- 同日用户实测报告第二轮 NPC 不回复。日志显示模型在 1.1–1.7 秒内正常完成，问题出在游戏端：`UpdateTicked` 先消费选择，下一帧 `MenuChanged` 误判为退出聊天，随后丢弃第二轮回复。已让 `RunPending` 等菜单关闭通知处理完且不在等待回复时再运行，同时修复“自己说”提交的同类时序问题。
- 新增 5 项 C# 流程回归，原 DLL 为 2/5、修复后为 5/5；44 项后端测试、类型检查和 Release 编译再次通过（0 警告、0 错误）。修复 DLL 已在游戏退出后安装并核对哈希。
- 新增 `tools/test-abigail.ps1` 和 Mod 的专用测试流程。北京时间 23:14:37–23:14:50，自动点击加载并选择 `测试_436774213`，传送到 `SeedShop` 的阿比盖尔相邻空格，再通过原版选项回调连续收到三轮回复，游戏内测试流程用时 12.77 秒。三轮模型总耗时分别为 1033、1014、1623 ms；第三轮对话框已留给用户继续测试。
- 本机桌面已有“阿比盖尔自动测试”快捷方式；下次测试先正常退出游戏，再双击它。脚本会检查并编译安装所需 Mod、复用或启动后端，再启动自动测试。项目内复现命令、结果位置和覆盖边界见 `docs/game-bridge.md` §8。

Windows M3b 接入与验证（2026-10-20）：

- 新增 `src/bridge/memory.ts` 和 `SaveSync.cs`，复用已有 M1 接口，未修改记忆内核。协议升级到 2，模型请求可随取消/保存/退出中止，生命周期有确认与补发，回复带读档身份和请求序号。
- 后端完整 67 项测试、类型检查和构建通过，10 项 C# 检查通过，Release 编译 0 警告、0 错误。覆盖真实 `SIGKILL` 恢复及准备、确认、退出的崩溃窗口。
- 已用 Windows PowerShell 5 实际更新 Mod 和旧后端、加载测试档并完成“记忆已就绪”握手。00:38:04 首次模型调用 `fetch failed`，本机直接及代理访问 DeepSeek 的 TLS 握手也失败；M3b 三轮回归及跨天保存真机验收尚未完成，不能当作通过。
- 游戏记忆数据在 `.runtime/game/`；本轮自动流程没有调用睡觉或保存。安装与原始结果见 `docs/test-results/2026-10-20-memory.md`，网络恢复后继续按清单测试。
- 00:45:21 保持游戏打开并更新后端进程，00:45:24 Mod 自动重连，以同一 nonce 恢复“第 1 天，记忆已就绪”。真机重连握手成功；有实际对话内容的恢复仍需网络恢复后验证。

11 时重测：

- DeepSeek 鉴权恢复 200；阿比盖尔三轮真机流程 13.27 秒通过，三轮模型总耗时 1071、1378、1151 ms。第三轮对话框保留，本次重跑前后游戏存档哈希相同。
- 真实模型 + 模拟 Mod 消息 + 独立 SQLite，10 次调用验证“小猫星糖”跨天保留、“青岚农场”不保存退出后丢弃、“紫色风筝”重启恢复，全部通过。1 次附加字段格式回退，需继续观察。
- 发现上次失败后未暂停，游戏后来推进了 30 天；已备份当前存档和数据库，并补上测试失败后的原版暂停提示。真实存档的第 30 天提交及父指针与 SQLite 相符，读档为第 31 天。
- 详见 `docs/test-results/2026-10-20-retest.md`。真实游戏中的指定内容对话 → 睡觉 → 询问 / 不保存退出整条组合流程尚未验收。

11:46–11:48 真机组合验收：

- 新增 `tools/test-game-memory.ps1`、独立后端子进程和 Mod 的显式测试模式。创建 `MemoryTest_1987996228` 副本，使用独立 SQLite；只在副本里设置阿比盖尔 8 心并移动到农舍，避开商店剧情。原测试档和正常启动配置保持原状。
- 通过原版“自己说”输入回调提交信息；真实睡觉保存后还记得“星糖”，不保存退出后不再知道“青岚农场”。后端进程 PID 29024 退出、新进程 PID 27080 启动，游戏在同 nonce 下恢复“紫色风筝”。
- 在标题页恢复副本 A 后，不会召回 B 的风筝约定；再次真实保存得到 C，B/C 都以 A 为父且结束于第 32 天，C 只有新纸船计划，没有 B 的风筝记忆。A/B/C 的真实存档指针都与 SQLite 对齐。
- 最终 7 个证据节点通过，流程 76.77 秒、真实模型 13 次调用；原档 6 文件 SHA256 全部相同，完成后回标题页并结束脚本自己启动的验收游戏。报告见 `docs/test-results/2026-10-20-game-memory.md`。

`.env` 不进仓库，按 `.env.example` 填：

```
NPC_MODEL_ENDPOINT=https://api.deepseek.com
NPC_MODEL_NAME=deepseek-flash
NPC_MODEL_API_KEY=<你的 key>
NPC_MODEL_THINKING=high
```

- **NuGet**：Mac 这台机器连不上 nuget.org，所以 `mod/nuget.config` 把包源换成了华为云镜像。能直接连 nuget.org 的机器可以删掉这个文件。
- **网络**：Mac 访问海外站点（GitHub、NuGet、DeepSeek）偶尔会断开，遇到这种情况先重试。后端调用 DeepSeek 时已经有自动重试。
- **游戏目录**：编译 Mod 时，SMAPI 官方的编译工具会自动找游戏目录，找不到的话在 csproj 里设 `GamePath`。

## 5. 常用命令

```sh
npm ci                        # 安装依赖
npm test                      # 离线测试，不联网，不用 key
npm run typecheck             # 类型检查

npm run chat -- abigail --hearts 4 --seen 1,2   # 命令行和 NPC 聊天，带记忆
npm run chat -- --probe all   # 跑全部探测题，对话记录存到 .runtime/transcripts/

npm run bridge                # 启动给 Mod 连接的后端（127.0.0.1:47711）
dotnet build mod/StardewAgentBridge   # 编译 Mod，编译完自动装进游戏的 Mods 目录
```

- 命令行聊天的参数和 `/sleep`、`/rollback` 等存档命令见 `dialogue-prototype.md` §6 和 §13.3。
- 运行时数据都放在 `.runtime/` 下，不进仓库。

## 6. 遗留问题

| 问题 | 在哪记的 |
|---|---|
| 别人的心事件在这个 NPC 的卡里没有对应禁忌，玩家问起还没发生的事件时，NPC 可能会顺着说下去（比如刘易斯和服装疗法） | `dialogue-prototype.md` §12.6 |
| 推理强度 `high` 偶尔推理太长，单轮超过 8 秒 | `dialogue-prototype.md` §12.6 |
| 偶尔有小的事实错误，比如矮人说族里"就剩我一个了" | `dialogue-prototype.md` §11 |
| 0 心时 NPC 可能太健忘。最简单的调法是把这一档的重要度门槛从 4 降到 3 | `dialogue-prototype.md` §14.5 |
| 群体 10 心事件、科罗布斯 14 心事件还没写"看过事件之后" | `dialogue-prototype.md` §12.6 |
| 每次都发给模型的卡片核心部分实测 530–690 token，超过最初定的 500 | `design.md` §11 |
| 真实模型附加字段偶尔解析失败，会走现有回退路径；本次 10 次调用出现 1 次 | `test-results/2026-10-20-retest.md` |
| 过期的临时日志不会自动清理 | `design.md` §16 |

## 7. 下一步

1. **补齐 Windows M3a 交互项目**：中文输入法、原版台词保留、取消。脚本已覆盖原版输入回调，但不能代替中文输入法组合输入的实际操作。
2. **Mac 验收**：M3a 交互及 M3b 跨天、回滚、进程重启与旧档分叉；Windows 对应 M3b 组合已通过。当前组合启动脚本是 Windows 版本。
3. 真机验收之后的顺序还没定，候选有夜间整合、自主行动（M2b）及硬件记忆衔接。按项目约定，开始前先确认设计。

## 8. 文档索引

| 文档 | 讲什么 |
|---|---|
| `AGENTS.md` | 给 AI 助手的协作约定（Claude Code 通过 `CLAUDE.md` 读取它） |
| `docs/status.md` | 本文档：进度、分支、环境、遗留问题、下一步 |
| `docs/design.md` | 整体设计：已确认的决策、架构、存档和回滚、协议、角色卡、里程碑 |
| `README.md` | 记忆内核（M1）的用法和接口 |
| `docs/learning-memory.md` | 记忆内核的学习指南 |
| `docs/dialogue-prototype.md` | 角色卡加载、对话调用、命令行、探测题，以及接入记忆和好感度影响记忆 |
| `docs/game-bridge.md` | M3a：Mod 和后端的协议、原版界面怎么复用、游戏内测试清单 |
| `docs/game-memory.md` | M3b：存档同步、跨天记忆、确认补发与崩溃恢复 |
| `docs/test-results/2026-10-19-abigail.md` | 第二轮回复丢失的根因、修复验证、阿比盖尔三轮真机自动测试结果 |
| `docs/test-results/2026-10-20-memory.md` | M3b 代码、67 项测试及真机握手成功/模型网络失败的验证记录 |
| `docs/test-results/2026-10-20-retest.md` | 网络恢复后的三轮真机、真实模型记忆链路、存档指针对齐和失败暂停修复 |
| `docs/test-results/2026-10-20-game-memory.md` | 独立副本中跨天、回滚、后端进程重启和旧档分叉的完整真机验收 |
| `data/npcs/_template.md` | 角色卡的结构 |
| `reference/README.md` | 写卡用的参考资料，以及哪些能进仓库 |
