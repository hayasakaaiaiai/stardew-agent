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
| M1 存储与事务 | 完成 | 记忆内核：SQLite 提交树、中文检索、当天事务、存档提交和回滚、后端崩溃恢复；过期临时日志和检查点的清理（`m1-scratch-cleanup`，待合入） | — | `README.md`、`design.md` §16 |
| M2 Agent | 对话、夜间整合、次日计划、头顶气泡、寄信与格式失败恢复已合入 | 对话；夜间原话校验；首次“继续聊”提计划；头顶气泡和表情；寄信与随信附赠；夜间格式失败有限补跑（2026-10-20 合并进 `main`） | NPC 碰面聊天（`m2b-npc-chat`）、送礼记忆（`m2b-gifts`）、聊天影响好感（`m2b-friendship`）、当面送东西（`m2b-in-person-gifts`），待 Windows 验收；自主行动（调度器、合并场景调用、白名单动作）；观察正常游玩和自由生成内容 | `dialogue-prototype.md`、`nightly-consolidation.md`、`next-day-plans.md`、`npc-bubbles.md`、`npc-mail.md`、`npc-chat.md`、`npc-gifts.md`、`npc-friendship.md`、`npc-in-person-gifts.md` |
| M3 接入游戏 | 完成（Windows） | 游戏里"继续聊"；真实保存/退出、跨天记忆、回滚、后端进程重启与旧档分叉；拼音输入法、原版台词保留、取消三项手测通过 | — | `game-bridge.md`、`game-memory.md` |
| M4 内容 | 角色卡已完成 | 34 张角色卡（已审阅），"看过事件之后"共 201 条 | 物品名到 ID 的对应、各动作的上限 | `design.md` §11 |

`main` 上后端 103 个测试、类型检查和构建通过，另有 18 项 C# 流程检查（Windows）。10 月 20 日阿比盖尔三轮真机回归通过，随后在独立副本中用真实模型完成跨天保留、不保存回滚、后端进程重启、旧档分叉四项真机验收：76.77 秒，13 次模型调用，3 次真实睡觉保存，原测试档 6 个文件哈希均相同。详见 [真机组合验收报告](test-results/2026-10-20-game-memory.md)。

12:38 的初版夜间整合技术链路通过，但内容复核发现 NPC 的墓地计划被写成农场主说过的事，且进入次日 prompt。失败证据保留在 [夜间整合 Windows 报告](test-results/2026-10-20-nightly-windows.md)。

按用户“调整防止记错”的要求，现已用代码核对原话来源，禁止模型自由改写长期记忆。76/76、类型检查、构建和 13/13 C# 检查通过；5 类真实模型样本各 3 次通过。13:01 的真机组合验收 103.42 秒、13 次对话 + 3 次夜间整合通过，原档 6 文件哈希相同；原话确实落库并进入次日 prompt。固定输入每晚增加 195 输入 token，正常调用次数不变。常驻后端已备份并更新，最终 PID 25704。详见 [事实归属修复报告](test-results/2026-10-20-nightly-facts-fix.md)。

用户确认 M2b 第一步后，`codex/next-day-plans` 已实现次日首次“继续聊”主动提计划、原话核对、日期换算、开场问句处理以及重启/回滚/分叉语义。该分支已同步 `main` / `7b3d6df`，完整 84/84、类型检查、构建、13/13 C# 检查通过。最终真实模型 6 类各 2 次，另有 12 次普通开场对照；首次计划开场额外 162–169 输入 token，之后不增加固定成本或固定调用。最终真机 105.22 秒、17 次调用、3 次真实睡觉保存通过，原档 6 文件哈希未变；14:17:21 已备份并重载正常后端，PID 17244。展示效果、回退和保留的失败证据见 [次日计划验收报告](test-results/2026-10-20-next-day-plans.md)。

**游戏内验证只在 Windows 上做**，Mac 只做自动测试、类型检查和编译 Mod。M3a 按 `game-bridge.md` §7 剩下的三项手测（拼音输入法打中文、聊完后原版台词还在、等待回复时按 Esc 取消），用户 2026-10-20 在 Windows 上测完，报告没有问题；测试记录没有推送到仓库。

19 时按用户“你自己写脚本测”完成最新 `m2b-bubbles` / `86fe712` 的 Windows 验收，工作分支为 `codex/bubbles-windows-tests`。修复完成动作漏过滤、异步旧消息覆盖、Mod 异常行抛错三处问题；最终 90/90 Node、16/16 C#、类型检查和构建通过，Release 零警告零错误。固定数据原生显示 16.86 秒、12 项行为及 3 项画面捕获通过；真实模型流程 97.46 秒、17 次调用、3 次真实保存、5 个 Mod 气泡接收节点通过，原档 6 文件哈希一致。安装 DLL 已更新，正常后端备份后于 19:10 重载，PID 15088。当时未推送、未合入 `main`（后已推送，2026-10-20 合入 `main`，见下）；完整证据与测试限制见 [气泡 Windows 报告](test-results/2026-10-20-bubbles-windows.md)。

随后按“推了新分支，继续测”拉取 `m2b-mail` / `fa3e818`，在 `codex/mail-windows-tests` 合入本地气泡修复继续验收。修复来信过滤、异常行和收藏标题，将异步版本保护扩展到信件；最终 97/97 Node、18/18 C#、类型检查和构建通过，Release 零警告零错误。原生信箱 23.46 秒、24 项行为和 3 项 UI 捕获通过，123 个赠品名在游戏中识别；最终真实模型 112.17 秒、17 次调用、3 次保存、5 个实际 Mod 气泡/信件接收节点通过。早期两次真实运行分别因引用超限失败、因过滤误杀全部来信而不算内容通过，记录均保留；引用超限的模型可靠性问题仍存在。正常后端于 19:38 备份后重载，当前 PID 29608，Mod 已更新。原档 6 文件哈希不变，当时未推送、未合入 `main`（后已推送，2026-10-20 合入 `main`，见下）。详见 [寄信 Windows 报告](test-results/2026-10-20-mail-windows.md)。

20 时按用户确认完成夜间格式失败恢复：不再把两次失败标为完成，第二次请求带具体错误反馈，30 秒后最多自动补跑一轮，成功落库后才刷新 Mod。正常首轮输入增量 0，引用超限重试样例增加 69 输入 token；103/103 Node、18/18 C#、类型检查和构建通过。真机主动注入两次超限输出后，原记忆和未完成状态保留，36.890 秒时自动恢复落库，气泡与来信到达；完整 125.26 秒、17 次真实调用、3 次保存通过，原档 6 文件哈希一致。正常后端备份后于 20:05 重载，当前 PID 29688。仍在 `codex/mail-windows-tests`，当时未推送、未合入 `main`（后已推送，2026-10-20 合入 `main`，见下）。证据、预算和恢复边界见 [夜间恢复报告](test-results/2026-10-20-nightly-recovery.md)。

2026-10-20 晚审核 `main` 之后的 7 个提交（`7fcf8ab`…`c4d661b`：气泡、M3a 手测记录、硬件暂停、寄信、气泡与寄信的 Windows 修复、夜间失败恢复），没有发现需要拦下的问题；Mac 上 103/103、类型检查、构建和 Release 编译（0 警告、0 错误）通过，C# 流程检查在 Mac 上加载不了游戏程序集，以 Windows 的 18/18 为准。按用户“审核新提交之后合并到 main”的要求快进合并进 `main`。审核时记下、留给后续观察的两点：某位 NPC 格式失败会让同一提交里其他 NPC 的合格结果在补跑时重算（已写在恢复报告 §2）；气泡里“了”的过滤很保守，正常句子也可能被丢掉。

M2b 第四步“NPC 碰面聊天”在 `m2b-npc-chat` 上实现，已建在新的 `main` / `db94a12` 上：两个 NPC 相距 2 格内、玩家在 8 格内且能自由行动时，Mod 请求一段 2–4 句的闲聊，轮流冒在两人头上；只显示，不写记忆、不改存档。每对一天一次、一天最多 4 段、两段间隔 1 游戏小时，关掉推理。真实模型每段输入 440–541、输出约 90–115 token，1–4.6 秒。106/106、类型检查和 Release 编译通过，等 Windows 游戏内验收，见 [npc-chat.md](npc-chat.md) §7。

M2b 第五步“NPC 记得玩家送的礼物”在 `m2b-gifts` 上实现，建在 `m2b-npc-chat` 上：Mod 对比原版的当天送礼计数发现送礼，发可靠的 `gift.given`；后端按模板给这位 NPC 记一条“农场主送我紫水晶，我特别喜欢。”，重要度按原版喜好，跟着存档保存或回滚；夜间整合不再把这类记忆当成对话笔记替换掉。不调用模型，固定 token 0，被想起时每条 16–22 token。协议版本升到 3。真实模型 6 次问“喜欢我送的东西吗”，回答都和原版喜好一致。111/111、类型检查、构建和 Release 编译通过，等 Windows 验收，见 [npc-gifts.md](npc-gifts.md) §6。

M2b 第六步“聊天影响原版好感”在 `m2b-friendship` 上实现，建在 `m2b-gifts` 上：对话每轮模型多给一个 -2 到 2 的 `mood`，代码按每档 10 点换算，每位 NPC 每天合计截在 −40 到 +30（`design.md` §8），随回复发给 Mod，Mod 再核对一次后调用原版 `changeFriendship`；开场一律 0，当天合计从当天日志加总，跟存档保存或回滚。规则最短写法 57 token；真实模型 48 次实测每轮多 59 输入（可缓存）、约 19 输出 token，字段齐全 48/48，讨要好感和奉承没有加分。114/114、类型检查、构建和 Release 编译通过，等 Windows 验收，见 [npc-friendship.md](npc-friendship.md) §7。

M1 剩下的“自动清理过期的临时日志”在 `m1-scratch-cleanup` 上补上，建在 `m2b-friendship` 上：同一存档用新的 nonce 读档成功后，删除这个存档其他 nonce 的当天 JSONL 和桥接检查点，后端中途重启过也一样（同一进程里换 nonce 本来就会删）。只删文件名符合格式的文件，其他存档不动。设计里“启动时删 24 小时前的残留”没做，理由见 `design.md` §6。纯后端改动，116/116、类型检查和构建通过；撤掉实现，两项新测试都失败。

M2b 第七步“关系好的 NPC 当面送东西”在 `m2b-in-person-gifts` 上实现，建在 `m1-scratch-cleanup` 上：6 心以上的 NPC 当天第一次开场时，代码从角色卡里挑一样能当面给的（不选“随信寄来”的条目和钱），在“当前情况”末尾加一行（48–57 token），模型决定送不送；和寄信附赠共用 7 天冷却，冷却从送礼时记下的记忆里取，不依赖夜间整合。真实模型 6 次开场 5 次送出。120/120、类型检查、构建和 Release 编译通过，等 Windows 验收，见 [npc-in-person-gifts.md](npc-in-person-gifts.md) §7。

“全镇都知道的家庭状况”在 `world-public-facts` 上实现，建在 `m2b-in-person-gifts` 上：玩家结婚、订婚、和科罗布斯同住、有孩子时，所有 NPC 的世界事实里多一行（11–20 token，之前为 0）。以前只有配偶自己知道，问皮埃尔“阿比盖尔最近还好吗”，他会当她还住在家里；加上之后知道她嫁到了玩家的农场。123/123、类型检查、构建和 Release 编译通过，见 [world-public-facts.md](world-public-facts.md)。

## 3. 分支

GitHub 私有仓库：https://github.com/hayasakaaiaiai/stardew-agent

| 分支 | 内容 | Mac 上的目录 |
|---|---|---|
| `main` | 已合入的基线：记忆内核 + 对话 + M3a + M3b + 夜间整合 + M2b 前三步（次日计划、气泡、寄信）与夜间失败恢复 | `/Users/a11/Documents/ChatGPT/stardew-agent-dialogue`（目录名是以前留下的） |
| `codex/npc-memory-store` | 记忆系统的开发分支，做完一步快进合并回 `main` | `/Users/a11/Documents/ChatGPT/stardew-agent` |
| `hardware-companion` | `main` + 硬件陪伴（机器人），还没合并 | `/Users/a11/Documents/ChatGPT/stardew-agent-hardware` |
| `codex/next-day-plans` | M2b 首次开场主动提计划，2026-10-20 已快进合并进 `main` | Windows：`E:\stardew-agent` |
| `m2b-bubbles` | M2b 头顶气泡和表情，2026-10-20 随 `codex/mail-windows-tests` 合入 `main` | `/Users/a11/Documents/ChatGPT/stardew-agent-m2b` |
| `codex/bubbles-windows-tests` | 气泡 Windows 验收和三处修复，`910c127` 保留，未推送 | Windows 历史验收分支 |
| `m2b-mail` | NPC 寄信与随信附赠，2026-10-20 随 `codex/mail-windows-tests` 合入 `main` | `/Users/a11/Documents/ChatGPT/stardew-agent-mail` |
| `codex/mail-windows-tests` | 气泡、寄信验收与修复，追加夜间格式失败恢复；2026-10-20 快进合并进 `main` | Windows：`E:\stardew-agent` |
| `m2b-npc-chat` | M2b 第四步：NPC 碰面聊天（旁听），建在最新 `main` 上，等 Windows 验收 | `/Users/a11/Documents/ChatGPT/stardew-agent-chat` |
| `m2b-gifts` | M2b 第五步：NPC 记得玩家送的礼物，建在 `m2b-npc-chat` 上，等 Windows 验收；协议版本 3 | 已提交，目录现在用于下一步 |
| `m2b-friendship` | M2b 第六步：聊天影响原版好感，建在 `m2b-gifts` 上，等 Windows 验收 | 已提交 |
| `m1-scratch-cleanup` | M1 补齐：过期临时日志和检查点的清理，建在 `m2b-friendship` 上 | 已提交 |
| `m2b-in-person-gifts` | M2b 第七步：关系好的 NPC 当面送东西，建在 `m1-scratch-cleanup` 上 | 已提交 |
| `world-public-facts` | 全镇都知道的家庭状况（配偶、婚约、室友、孩子），建在 `m2b-in-person-gifts` 上 | `/Users/a11/Documents/ChatGPT/stardew-agent-gifts` |

Windows 上的目录是 `E:\stardew-agent`。当前从 `m2b-mail` 建立寄信验收分支，并合入本地 `910c127` 的气泡修复；已包含最新远端 `main` / `6c151f2`。本地 `codex/next-day-plans` 的手测入口提交 `2260625` 仍保留，并复用到验收分支。M3b 在 `codex/game-save-memory` 上开发，2026-10-20 快进合并进 `main`；它已经包含的 `codex/abigail-auto-test` 同时删除。

本次按用户“拉下来测”“修复”的要求，Windows 在 `nightly-consolidation` 上完成远端 `3f70b27` 验证和事实归属修复。本机常驻后端已重新启动，日志确认对话 `high`、夜间整合 `low`；原游戏记忆库、临时日志及旧后端日志在更新前已备份。

夜间整合的修复和验收记录 `e49535b`、`5896878` 已先推送到 `nightly-consolidation`，随后由上游合入 `main` / `7b3d6df`。Windows 的 `codex/next-day-plans` 已变基到该提交；用户已确认复用“继续聊”并要求完成后上传 GitHub；验收后用户同意，2026-10-20 快进合并进 `main`。

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
| 夜间事实记忆已改为原话引用；印象与计划仍由模型生成，可能夹带具体事实或遗漏内容，需继续观察 | `test-results/2026-10-20-nightly-facts-fix.md` |
| 计划开场使用保守问句处理，可能回退为较笼统的提问；尚未解析“下周”等任意日期表达，普通对话仍可能出现事实错误 | `test-results/2026-10-20-next-day-plans.md` |
| 气泡完成动作词过滤较保守，可能丢弃正常句子；模型可能继续追问被否认的话题，不能把规则过滤当成完整事实校验 | `test-results/2026-10-20-bubbles-windows.md` |
| 模型仍可能不合格式；现已保留未完成状态并有限补跑。持续失败仍需在最近 3 个保存点内读档或重启补跑，旧版已标完成的历史不重写 | `test-results/2026-10-20-nightly-recovery.md` |

## 7. 下一步

1. **硬件陪伴（暂停）**：用户 2026-10-20 决定 H 线先不做。H4（机器人接回游戏存档）已在 `hardware-companion` 实现并变基到最新 `main`，恢复时按 `companion-device.md` §13.9 在 Windows 上测。
2. **M2b 前三步已合入 `main`**：[次日主动提起计划](next-day-plans.md)、[头顶气泡和表情](npc-bubbles.md)、[寄信与随信附赠](npc-mail.md)，以及[夜间格式失败恢复](test-results/2026-10-20-nightly-recovery.md)。继续观察正常游玩中的自然语言日期、重复邀约、气泡过滤和自由生成内容。
3. **M2b 第四步：NPC 碰面聊天**：`m2b-npc-chat` 已实现，等 Windows 按 [npc-chat.md](npc-chat.md) §7 验收；通过后合入 `main`。
4. **M2b 第五步：送礼记忆**：`m2b-gifts` 已实现，等 Windows 按 [npc-gifts.md](npc-gifts.md) §6 验收。Mod 和后端要一起更新（协议 3）。
5. **M2b 第六步：聊天影响好感**：`m2b-friendship` 已实现，等 Windows 按 [npc-friendship.md](npc-friendship.md) §7 验收。
6. **M2b 第七步：当面送东西**：`m2b-in-person-gifts` 已实现，等 Windows 按 [npc-in-person-gifts.md](npc-in-person-gifts.md) §7 验收。
7. **Windows 一次测完**：`world-public-facts` 是这一串的最前端，包含第四到七步、临时日志清理和家庭状况，切到这个分支按 `npc-chat.md` §7、`npc-gifts.md` §6、`npc-friendship.md` §7、`npc-in-person-gifts.md` §7、`world-public-facts.md` §5 一起测；都通过后整串快进合入 `main`。
8. **自主行动**：调度器、合并场景调用另行设计。白名单动作里和对话相关的（好感、当面送礼）已经做了。

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
| `docs/nightly-consolidation.md` | 夜间整合：产出、输入、触发时机、出错处理、实测 token 和真实模型结果 |
| `docs/world-public-facts.md` | 全镇都知道的家庭状况：写法、实测、测试和 Windows 清单 |
| `docs/npc-in-person-gifts.md` | M2b 第七步：当面送东西的决定、冷却、实测、测试和 Windows 清单 |
| `docs/npc-friendship.md` | M2b 第六步：聊天影响原版好感的决定、规则写法对比、真实模型实测、测试和 Windows 清单 |
| `docs/npc-gifts.md` | M2b 第五步：送礼记忆的决定、模板、实测 token、测试和 Windows 清单 |
| `docs/npc-chat.md` | M2b 第四步：NPC 碰面聊天的决定、给模型的规则、实测 token、测试和 Windows 清单 |
| `docs/npc-mail.md` | M2b 第三步：NPC 寄信和随信附赠的决定、规则、实测 token、物品名核对、测试和 Windows 清单 |
| `docs/npc-bubbles.md` | M2b 第二步：头顶气泡和表情的决定、规则、实测 token、测试和 Windows 清单 |
| `docs/next-day-plans.md` | M2b 第一步设计与实现：首次开场、原话核对、日期换算、回滚与最终 token 实测 |
| `docs/test-results/2026-10-20-next-day-plans.md` | 84 项测试、最终 12 次模型开场、日期与动作陈述处理和 Windows 真机验收 |
| `docs/test-results/2026-10-20-bubbles-windows.md` | 气泡三处修复、90/16 检查、原生画面和真实模型五节点气泡隔离验收 |
| `docs/test-results/2026-10-20-mail-windows.md` | 寄信过滤与收藏修复、97/18 检查、原生附件领取与保存、真实模型来信及保留失败 |
| `docs/test-results/2026-10-20-nightly-recovery.md` | 格式诊断反馈、69 token 实测、103/18 检查及正式 30 秒后台恢复的真机证据 |
| `docs/test-results/2026-10-20-nightly-windows.md` | 夜间整合 Windows 真机技术验证及说话人归属错误证据 |
| `docs/test-results/2026-10-20-nightly-facts-fix.md` | 原话来源校验、实际 token 差值、15 次真实模型和修复后的真机验收 |
| `docs/test-results/2026-10-19-abigail.md` | 第二轮回复丢失的根因、修复验证、阿比盖尔三轮真机自动测试结果 |
| `docs/test-results/2026-10-20-memory.md` | M3b 代码、67 项测试及真机握手成功/模型网络失败的验证记录 |
| `docs/test-results/2026-10-20-retest.md` | 网络恢复后的三轮真机、真实模型记忆链路、存档指针对齐和失败暂停修复 |
| `docs/test-results/2026-10-20-game-memory.md` | 独立副本中跨天、回滚、后端进程重启和旧档分叉的完整真机验收 |
| `data/npcs/_template.md` | 角色卡的结构 |
| `reference/README.md` | 写卡用的参考资料，以及哪些能进仓库 |
