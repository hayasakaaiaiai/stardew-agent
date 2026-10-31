# 项目现状

> 更新于 2026-10-24。本轮按用户要求审查全仓、修正文档，将 H 线之外的分支整合到 main，并清理历史分支、公开仓库。最终验证与远端结果见 [全仓审查报告](test-results/2026-10-24-repository-audit.md)。

## 1. 这个项目在做什么

为星露谷物语 1.6 的 34 位社交 NPC 提供中文自由对话和随存档保存、回滚、恢复的记忆。Node.js / TypeScript 后端通过本机 WebSocket 连接 SMAPI / C# Mod，界面使用原版对话框、选项和输入框。当前支持单人。

NPC 已能按原版日程聊天、传话、寄信、主动靠近、约定赴约、帮农活、照顾动物、陪下矿和一起逛。自由模型内容仍会出错，功能实现和限定场景通过不等于所有模型内容都正确。

## 2. 当前进度与证据

| 部分 | 状态与证据 |
|---|---|
| 记忆内核 | M1 已完成：NPC 隔离、中文检索、保存提交、回滚、恢复、旧档分叉；本轮补修无效读档提前删除当前 JSONL，见 [API](memory-kernel.md) |
| 对话与存档桥接 | M3a / M3b 已完成；Windows 中文输入、原版台词保留和 Esc 取消由用户在 10 月 20 日手测确认；跨天、回滚、重启和分叉见 [游戏记忆报告](test-results/2026-10-20-game-memory.md) |
| 送礼、好感、传话与后台行动 | 已合入；来源核对、有限失败恢复和原版流程见各设计文档及历史测试报告 |
| 约定线与行动 | 主动靠近至约定线收尾已实现；10 月 23 日限定原生组合 343/343，见 [报告](test-results/2026-10-23-outing-invites-windows.md) |
| 真实模型约定复核 | Windows 后端 20 段为 16 对、3 漏记、1 未改约；四类错记／误取消已修复，无新增 prompt，见 [报告](test-results/2026-10-24-real-meetings-windows.md) |
| 真实游戏约定复核 | 七项完整符合预期 4/7，自动断言 106/108，23 次真实 high 调用、5 次真实保存、21 次读档；固定反例补强 41/41，原档六文件哈希相同，见 [报告](test-results/2026-10-24-real-meetings-game.md) |
| 角色资料 | 34 张角色卡、226 条事件后话题；123 个可送物品在原版游戏中识别；卡片模板和资料许可见 §8 |
| H 线硬件陪伴 | 暂停，保留在 `hardware-companion`，不合入 main；本轮未修改 H 线 |

本轮全仓审查另修模型配置空值和浏览器访问本机桥接的问题；最终 Node **303/303**、C# **54/54**、类型检查、构建、两个 demo 通过，Release 零警告／错误，依赖审计零漏洞。独立游戏固定反例重跑 **41/41**、98 秒、0 次真实调用，原档六文件哈希相同。依赖版本固定为锁文件中已有版本，没有新增依赖、prompt 或收费调用，详见 [审查报告](test-results/2026-10-24-repository-audit.md)。历史测试数字和部署记录单独保存在 [历史快照](status-history-2026-10-24.md)，不作为当前安装状态。

2026-10-31 按用户“想一些需要美化的东西”“readme 需要有每一个可用的功能（不包括 h 线）”，在 `docs-readme` 上做了这些：
- **README**：按六组列出全部功能，每项写游戏里是什么样、对应的开关和文档；加了 18 个 Mod 开关的中文说明和命令行工具表。
- **游戏内提示**：约定取消、“今天去不了……”从红叉改成和“约好”一样的“！”。对话旁白（走神了、没有回应、连接断开）改用原版不带图标的 `HUDMessage.ForCornerTextbox`。玩家能看到的“AI”“后端”字样去掉了，只有同步失败还用红叉。时间写法核对过原版 `Game1.getTimeOfDayString`，中文本来就是 24 小时制、小时不补零，和 Mod 一致，所以没改。
- **其他**：Mod 描述改成现在的功能；`npm run chat` 用 Node 自带的 `util.styleText` 在终端里上色，不加依赖，管道和 `NO_COLOR` 时输出不变。
- **结果**：prompt 不变，token 增量 0。

Windows 上要看一眼的：
1. 改口取消后，HUD 是“！”图标，写着“和莉亚的约定取消了”。
2. 当天约配偶去海滩：“今天去不了海滩了”是“！”图标。
3. 把 `ReplyTimeoutSeconds` 临时改成 1 再继续聊：出现不带图标的文字框“（阿比盖尔好像走神了，没有回答。）”，字完整显示。
4. 等回复时关掉后端：出现“（连接断开了，过一会儿再来找阿比盖尔聊吧。）”。
5. SMAPI 启动时，Mod 后面显示新的描述。
6. 按文字匹配 HUD 的 `game-call-off.ts`、`game-same-day-meetings.ts`、`game-meetings-more.ts` 照常通过（这次只改了图标，没改那几句的文字）。

同日用户提出“继续聊的时候时间暂停”，选了“只停钟”，在 `chat-pause-time` 上实现。单人游戏里对话框和输入框开着时原版本来就停钟，漏掉的是等模型回复那几秒。现在等回复时打开原版的 `Game1.isTimePaused`，画面照常动；回复到了、取消、超时、断线、读档、回标题时恢复；只恢复自己停的；联机不停；开关 `PauseClockWhileWaiting` 默认开。token 增量 0，C# 流程检查加 1 项（要在 Windows 跑）。Windows 清单见 [game-bridge.md](game-bridge.md) §10。

用户还要“更多头像表情”：现在的回复已经用原版头像，按模型给的 6 种表情（`$h` `$s` `$u` `$l` `$a` 和平静）切换。要用 6 张以外的头像，得先查清各 NPC 有几张、各是什么，再估算角色卡多出来的 token，交用户定。

## 3. 分支

| 分支 | 用途 |
|---|---|
| `main` | 当前单人游戏实现、非 H 线功能及 Windows 修复、验收入口和本轮全仓审查修复 |
| `hardware-companion` | H 线硬件陪伴，暂停；本轮保持原提交 `6e92320` |
| `docs-readme` | 2026-10-31 建在 `main / 789b911` 上：README 列出全部功能和开关；游戏内提示、Mod 描述和命令行颜色美化。等用户确认后合入，见 §2 末尾 |
| `chat-pause-time` | 建在 `docs-readme` 上：等回复时停住游戏时钟，见 `game-bridge.md` §10 |

历史功能分支和验收分支已在内容核对、合并与验证完成后清理，提交历史保留在 main。本轮删除 51 条远端、23 条本地历史分支，两边都只剩上表两条。清理前的 refs 和完整 Git bundle 保存在本机 `.runtime/repository-publication-20261024/`；旧分支对应的设计、测试记录仍在仓库。

仓库已设为公开，默认分支 main。匿名 API、README 读取与无凭据克隆均已确认；干净克隆后 `npm ci`、303/303、类型检查、构建和构建后 demo 通过，不依赖本机 `.env`、游戏导出或运行数据。生产审查修复提交 `d11d14d`，发布确认只更新文档。

## 4. 运行环境与数据

需要 Node.js 24、星露谷物语 1.6 和 SMAPI 4；编译 Mod 需 .NET 8 或更高 SDK。Windows 本轮环境为 Node 24.14.1、.NET SDK 9.0.202、游戏 1.6.15、SMAPI 4.5.2。游戏使用自己的 .NET 6 运行时，Mod 目标 `net6.0`。

安装、配置、后端启动和 Mod 编译步骤见 [README](../README.md)。可执行离线 demo 和测试，无需模型 key、游戏或 `reference/game/`；C# 流程检查和游戏内验收需要合法安装的游戏。

- 模型配置只放 `.env`；`.env` 及其变体忽略，`.env.example` 是空模板。超时和输出上限留空分别用 60000 ms 和 4000 token，非空必须为正整数。
- 游戏后端仅监听 `127.0.0.1:47711`；可用 `NPC_BRIDGE_PORT` 改端口，同时修改 Mod 的 `BackendUrl`。浏览器 Origin 请求会被拒绝，原生 Mod 可连接。
- 正常游戏记忆在 `.runtime/game/`，包含 SQLite、恢复日志和桥接检查点；升级代码不删除这份数据。
- 本轮验收使用独立游戏进程、存档副本、Mod 目录和数据库。未部署正常安装的 DLL，也未重载常驻后端。
- 原始游戏导出文本、存档、模型输入输出、数据库和截图只在本机，不进入公开仓库；报告里的本地路径用于定位原证据。
- 本仓库 `mod/nuget.config` 使用华为云 NuGet 镜像；能访问官方源时可按需调整。

## 5. 常用验证命令

```powershell
npm ci
npm test
npm run typecheck
npm run build
npm run demo
npm run demo:built
npm audit
node tools/check-repository.ts

# 本机游戏路径按实际安装修改；只编译，不部署正常 Mod。
dotnet build mod/StardewAgentBridge -c Release '-p:GamePath=E:\games\steamapps\common\Stardew Valley' -p:EnableModDeploy=false
dotnet run --project tests/mod-flow -- 'E:\stardew-agent\mod\StardewAgentBridge\bin\Release\net6.0\StardewAgentBridge.dll' 'E:\games\steamapps\common\Stardew Valley'

# 显式启动独立游戏验收：固定反例不收费，live 会调用你配置的真实模型。
powershell -NoProfile -File tools/test-game-real-meetings.ps1 -Section edges
powershell -NoProfile -File tools/test-game-real-meetings.ps1 -Section live
```

`npm test`、类型检查、构建和 demo 都不使用真实模型。`node:sqlite` 的 ExperimentalWarning 是 Node 24 当前提示；本机 npm 的 `store-dir` 提示来自环境配置，均与测试失败分别记录。

## 6. 已知问题


| 问题 | 在哪记的 |
|---|---|
| 真实游戏七项 4/7：模型收到邀约指令仍只寒暄；取消前并未出发，次日却误说在海边等过；花舞节当面答应但夜间 `meet=null`。本轮只脚本验收，未修改这些 prompt 或识别行为 | `test-results/2026-10-24-real-meetings-game.md`、`real-model-meetings.md` §12 |
| Mac 小批 E 最后一轮 0 错记；Windows 新回复 20 段仍有 3 漏记、1 未改约（“可以是可以”保留原钟点）。只暗示的答应、无关“想想”等保守过滤暂不放宽；“两天以后”（带“以后”）也仍不会记成后天。新发现的四类错记／误取消风险已修复 | `test-results/2026-10-24-real-meetings-windows.md` §1、§3；`test-results/2026-10-24-real-meetings-D.md` §5 |
| 当天约当天由代码核对原话，没明说的答应（“我早就想去了”“两点应该能抽开身”）会漏，留出批次 19 段存下 12 段；漏了 NPC 当天不去，靠 HUD 提示让玩家再确认一句 | `npc-same-day-meetings.md` §3、§8 |
| 改口和送别只认明说的词：留出批次 21 段认出 17 段；NPC 半推半就（“我才不是害怕……好吧”）会被当成不肯走而留下；NPC 主动取消从没出现过，只有单元测试；取消后当天不能再约 | `npc-call-off.md` §3、§8 |
| “陪我下矿吧／我去找你”这类说法，模型有时把地点写成农场（11 次 3 次），被原话核对拦下，结果是没约成而不是去错地方 | `npc-mine-companion.md` §5.4 |
| 农场原始夜间样本 11/12 保留，时段换算修复后同批重放 12/12；原模型仍有选错钟点，自由印象／传话也有无来源修饰。不能将代码修复后的执行结果当成所有模型内容都正确 | `test-results/2026-10-22-farm-help-windows.md`、`npc-meetings.md` §11 |
| 未选选项被改写进 remember：按用户决定用 Windows `09bc5db` 的做法，代码把正文换成玩家原话（结构上挡住）。代价是玩家点选项回答 NPC 的问题时只存下半句答案。旧污染条目不自动清理，也不能据此保证自由回复、印象和计划全部准确 | `legacy-cleanup.md` §8–§9、`reliability-fixes.md`、`test-results/2026-10-21-reliability-windows.md` |
| 85 条未发生事件已补限制，刘易斯未看/已看各 2 次正确；全部自然剧情仍需观察 | `legacy-cleanup.md` §4、`test-results/2026-10-21-offscreen-windows.md` §6 |
| 推理强度 `high` 偶尔推理太长：66 道探测题重测后用户仍选 `high`。碰面和同图的等待已从 10 秒改为 60 秒，超过仍放弃；20/60 秒边界为原生注入验证 | `legacy-cleanup.md` §3、`test-results/2026-10-21-reliability-windows.md` |
| 偶尔有小的事实错误，比如矮人说族里"就剩我一个了" | `dialogue-prototype.md` §11 |
| 科罗布斯未看事件已明确否认，已知完成动作已过滤；萨姆等自由补写及小动作进行中描述仍可能没有依据 | `test-results/2026-10-21-reliability-windows.md` §3 |
| 真实模型附加字段偶尔解析失败，会走现有回退路径；本次 10 次调用出现 1 次 | `test-results/2026-10-20-retest.md` |
| 夜间事实记忆已改为原话引用；印象与计划仍由模型生成，可能夹带具体事实或遗漏内容，需继续观察 | `test-results/2026-10-20-nightly-facts-fix.md` |
| 计划开场使用保守问句处理，可能回退为较笼统的提问；尚未解析“下周”等任意日期表达，普通对话仍可能出现事实错误 | `test-results/2026-10-20-next-day-plans.md` |
| 气泡完成动作词过滤较保守，可能丢弃正常句子；模型可能继续追问被否认的话题，不能把规则过滤当成完整事实校验 | `test-results/2026-10-20-bubbles-windows.md` |
| 模型仍可能不合格式；现已保留未完成状态并有限补跑。持续失败仍需在最近 3 个保存点内读档或重启补跑，旧版已标完成的历史不重写 | `test-results/2026-10-20-nightly-recovery.md` |
| 三功能组合曾观察到窗台、老虎等添写；当前自由对白仍会编造父亲口头禅等小细节，不能当成已发生的游戏事件 | `test-results/2026-10-20-social-windows.md`、`test-results/2026-10-21-offscreen-windows.md` §6 |

## 7. 下一步

1. 处理真实游戏留下的三处模型内容问题：主动邀约只寒暄、取消后编造等候、花舞节夜间漏约。保留原始失败；改变 prompt 或放宽接受词表前，继续按用户决定和实测 token 数评估。
2. 暂不放宽含蓄答应的保守过滤；没有明确确认的约定可能漏记，通过 HUD 让玩家再确认。不得把固定回复通过写成自由模型通过。
3. 持续观察自然日程、全角色剧情和自由内容。多人、全 NPC、随机矿层、节日完整自然流程没有新增全面覆盖。
4. H 线保持暂停，不部署、不合入；恢复时在该分支读取 `docs/companion-device.md`，完成对应 Windows 验收。

## 8. 文档索引

| 文档 | 讲什么 |
|---|---|
| `README.md` | 全部功能（效果、开关、文档）、安装、Mod 配置开关、命令行工具、验证入口和已知限制 |
| `docs/memory-kernel.md` | 记忆内核 API、保存回滚及失败读档恢复 |
| `docs/status-history-2026-10-24.md` | 全仓审查前的历史进度、分支、部署和验证快照 |
| `docs/test-results/2026-10-24-repository-audit.md` | 全仓审查、三处修复、合并和公开前的验证 |
| `docs/real-model-meetings.md` | 用真实模型跑约定线的测试计划和结果 |
| `docs/test-results/2026-10-24-real-meetings-game.md` | 七项真实游戏脚本、自动 106/108 与内容 4/7、补强反例 41/41、三处真实问题、保存／读档及夹具失败留证 |
| `docs/test-results/2026-10-24-real-meetings-windows.md` | 六个新提交的 Windows 后端复核、四类修复、299/54 检查、真实回复 16/20、原话和调用成本、用户游戏内清单 |
| `docs/test-results/2026-10-23-real-meetings-A.md` | 约定线真实模型 A 批：旧对话重放、40 段结果、每处漏记错记的原话和原因 |
| `docs/test-results/2026-10-23-real-meetings-B.md` | 按 A 批修了以后的 A 批 39/40、节日那一行写日子的对比、留出的 B 批 15/20 与剩下的问题、成本 |
| `docs/test-results/2026-10-23-real-meetings-C.md` | B 批三处记错的修复、留出的 C 批 16/20 与两处取消/改约说法的缺口、全程成本 |
| `docs/test-results/2026-10-24-real-meetings-D.md` | C 批两处的修复、留出的 D 批 18/20（含 4 位新 NPC）、“四天后”的修复与小批 E、全程成本 |
| `docs/test-results/2026-10-23-outing-invites-windows.md` | 三个新功能分支的 Windows 组合、十类修复、279/54 自动检查、343 项限定原生及息屏和存档校验 |
| `docs/test-results/2026-10-23-meetings-more-windows.md` | 约定线收尾的六类修复、六章原生 95/95、真实节日与带路、挖矿和心情保存，含夹具失败与边界 |
| `docs/test-results/2026-10-21-ambient-windows.md` | 同图小动作、群体事件与原生疏远状态；三处修复、149/22 检查、真实定向内容和完整组合超时失败 |
| `docs/test-results/2026-10-21-new-commits.md` | 修复推送之后的节日记忆、字段顺序分支检查，156 项隔离检查和来源策略取舍 |
| `docs/test-results/2026-10-21-festival-windows.md` | 最新合并与原话策略检查、169/28 自动验收、节日进程恢复和原版字段模拟、用户游戏内清单及保留的夹具失败 |
| `docs/test-results/2026-10-21-scheduler-windows.md` | 调度器和行程 195/32 自动验收、跨保存统计及重连限额修复、固定分词、原版对象读取、保留失败与用户游戏清单 |
| `docs/test-results/2026-10-22-world-windows.md` | 手测脚本化、原版事件与保存重读、51 次真实调用、中断收礼修复、小游戏退出修正、分段结果和模型内容失败 |
| `docs/test-results/2026-10-22-grounding-fixes.md` | 日程与未知聊天事实呈现、提示成本对照、200/33 自动检查、完整原版 231/231 和推送范围 |
| `docs/test-results/2026-10-22-farm-help-windows.md` | 农场帮忙的 Windows 兼容修复、原生农活及往返、保存回滚、真实夜间样本、失败和覆盖边界 |
| `docs/test-results/2026-10-22-mine-companion-windows.md` | 下矿陪同的动态角色、救援时序、击杀统计和配偶修复，原生完整入口、模型样本、保存回滚与保留失败 |
| `docs/scripted-mine-companion-acceptance.md` | 下矿、骷髅洞穴、火山的统一独立存档脚本及分章用法 |
| `docs/scripted-farm-help-acceptance.md` | 农场帮忙统一脚本入口、副本隔离、模型类型、逐格路线和保存证据 |
| `docs/scripted-world-acceptance.md` | 原版游戏脚本的副本隔离、章节、模型、证据与中断完成条件 |
| `docs/reliability-fixes.md` | 慢回复、记忆原话、小动作完成过滤和科罗布斯事件语义的兼容修复及 token 实测 |
| `docs/test-results/2026-10-21-reliability-windows.md` | 154/22 检查、固定 166/真实 176 项、污染实际拦截、原生边界和保留的脚本失败 |
| `docs/test-results/2026-10-21-offscreen-windows.md` | 后台两手传播、遗留清理与 high 组合测试，赠礼开关修复和未选项记忆污染 |
| `docs/test-results/2026-10-21-news-windows.md` | 好感分档、NPC 传话、显示中断与同日读档预算的组合验收和失败证据 |
| `AGENTS.md` | 给 AI 助手的协作约定（Claude Code 通过 `CLAUDE.md` 读取它） |
| `docs/status.md` | 本文档：进度、分支、环境、遗留问题、下一步 |
| `docs/design.md` | 整体设计：已确认的决策、架构、存档和回滚、协议、角色卡、里程碑 |
| `docs/learning-memory.md` | 记忆内核的学习指南 |
| `docs/dialogue-prototype.md` | 角色卡加载、对话调用、命令行、探测题，以及接入记忆和好感度影响记忆 |
| `docs/game-bridge.md` | M3a：Mod 和后端的协议、原版界面怎么复用、游戏内测试清单 |
| `docs/game-memory.md` | M3b：存档同步、跨天记忆、确认补发与崩溃恢复 |
| `docs/nightly-consolidation.md` | 夜间整合：产出、输入、触发时机、出错处理、实测 token 和真实模型结果 |
| `docs/npc-farm-help.md` | 来农场帮忙：用户选定的四项、进出农场的做法、各项农活怎么走原版路径、实测、测试和 Windows 清单 |
| `docs/npc-mine-companion.md` | 陪下矿洞：用户选定的六项、门口的格子、跟随/打怪/背出去/回日程的做法、实测、测试和 Windows 清单 |
| `docs/npc-same-day-meetings.md` | 当天约当天：聊完时代码怎么核对原话、赶不上就晚到、HUD 提示、4 批真实对话的结果、成本对照、测试和 Windows 清单 |
| `docs/npc-call-off.md` | 改口和送别：哪些话算取消或让 NPC 回去、不肯走的留下、撤销时怎么回原日程、台词库和真实对话的误判实测、测试和 Windows 清单 |
| `docs/npc-meeting-friendship.md` | 赴约和爽约影响好感：沿用聊天分档的加减、哪些不算失约、Mod 改后端记、测试和 Windows 清单 |
| `docs/npc-later-meetings.md` | 约到后天：日历换算、记成记忆、更远的婉拒（三种做法的实测）、提前取消、NPC 知道约定、测试和 Windows 清单 |
| `docs/npc-farm-animals.md` | 农场动物活：用户定的四样和规则、照原版的做法、实测、测试和 Windows 清单 |
| `docs/npc-meetings-more.md` | 约定线收尾：一点钟修复、改约、失约被拒以后、节日生日、带路、自己来帮忙、挖矿；实测和 Windows 清单 |
| `docs/npc-invites.md` | NPC 主动约你：谁、多久一次、走过来开口、那一行、邀约单独核对、实测、Windows 清单 |
| `docs/npc-outing.md` | 碰面后一起逛：跟着走、陪钓鱼、表情、站到身边、不跟去的地方、聊天那一行和记忆、实测、Windows 清单 |
| `docs/npc-meeting-warp.md` | 传送赴约、入口临时快走和步速恢复，实际到场／取消／过期的 Windows 验收及准时性边界 |
| `docs/test-results/2026-10-22-meeting-warp-windows.md` | 过期误传送误扣、入口快走的原版钟速对照、逐地点入口、保存回滚、失败及覆盖边界 |
| `docs/npc-meetings.md` | 按约定赴约：夜间 `meet` 字段与原话核对、8 个地点的格子、在原版日程里插两站的做法、实测、测试和 Windows 清单 |
| `docs/npc-approach.md` | NPC 有话要说时主动走过来：谁会来（`seek` 与关键词实测）、原版寻路和日程的依据、等候与走回、测试和 Windows 清单 |
| `docs/npc-schedules.md` | NPC 知道自己今天的行程：原版日程怎么读、写进哪些 prompt、token 和真实模型对照、Windows 清单 |
| `docs/scheduler.md` | 调度器：模型网关的分级排队和用量统计，后台场景的挑组、prompt、写入时机、推理强度实测和 Windows 清单 |
| `docs/festival-memories.md` | 节日记忆：每项结果从游戏哪里读、记什么、实测 token、消息、测试、真实模型抽测和 Windows 清单 |
| `docs/ambient-lines.md` | 自主行动第二步：同图小动作的决定、规则、打不打招呼的实测对比、消息、测试和 Windows 清单 |
| `docs/offscreen-news.md` | 自主行动第一步：玩家不在场时也传话的决定、消息、成本、测试和 Windows 清单 |
| `docs/legacy-cleanup.md` | 遗留问题清理：字符串记忆、气泡过滤、三档推理强度实测、没发生过的事件、0 心门槛、卡片标准、压低编造、群体 10 心和科罗布斯 14 心、Windows 组合测试、remember 的来源 |
| `docs/npc-news.md` | M2b 第八步：NPC 之间传话的决定、规则写法对比、真实模型实测、测试和 Windows 清单 |
| `docs/npc-friendship.md` | M2b 第六步：聊天影响原版好感的决定、规则写法对比、真实模型实测、测试和 Windows 清单 |
| `docs/npc-in-person-gifts.md` | M2b 第七步：当面送礼、与寄信共用冷却、背包满、实测和组合脚本 |
| `docs/world-public-facts.md` | 配偶、婚约、室友和孩子的公开事实，Mod 字段及真实模型验收 |
| `docs/npc-gifts.md` | M2b 第五步：送礼记忆的决定、模板、实测 token、测试和 Windows 清单 |
| `docs/npc-chat.md` | M2b 第四步：NPC 碰面聊天的决定、给模型的规则、实测 token、测试和 Windows 清单 |
| `docs/npc-mail.md` | M2b 第三步：NPC 寄信和随信附赠的决定、规则、实测 token、物品名核对、测试和 Windows 清单 |
| `docs/npc-bubbles.md` | M2b 第二步：头顶气泡和表情的决定、规则、实测 token、测试和 Windows 清单 |
| `docs/next-day-plans.md` | M2b 第一步设计与实现：首次开场、原话核对、日期换算、回滚与最终 token 实测 |
| `docs/test-results/2026-10-20-next-day-plans.md` | 84 项测试、最终 12 次模型开场、日期与动作陈述处理和 Windows 真机验收 |
| `docs/test-results/2026-10-20-bubbles-windows.md` | 气泡三处修复、90/16 检查、原生画面和真实模型五节点气泡隔离验收 |
| `docs/test-results/2026-10-20-mail-windows.md` | 寄信过滤与收藏修复、97/18 检查、原生附件领取与保存、真实模型来信及保留失败 |
| `docs/test-results/2026-10-20-nightly-recovery.md` | 格式诊断反馈、69 token 实测、103/18 检查及正式 30 秒后台恢复的真机证据 |
| `docs/test-results/2026-10-20-social-windows.md` | 一个脚本覆盖碰面、送礼与好感，115/20 自动检查、39 项游戏断言、5 次真实调用、保存回滚及冷却修复 |
| `docs/test-results/2026-10-20-new-parts-windows.md` | 新旧功能同一脚本，125/20 自动检查、63 项游戏断言、8 次真实调用、原档保护和失败读档日志丢失修复 |
| `docs/test-results/2026-10-20-nightly-windows.md` | 夜间整合 Windows 真机技术验证及说话人归属错误证据 |
| `docs/test-results/2026-10-20-nightly-facts-fix.md` | 原话来源校验、实际 token 差值、15 次真实模型和修复后的真机验收 |
| `docs/test-results/2026-10-19-abigail.md` | 第二轮回复丢失的根因、修复验证、阿比盖尔三轮真机自动测试结果 |
| `docs/test-results/2026-10-20-memory.md` | M3b 代码、67 项测试及真机握手成功/模型网络失败的验证记录 |
| `docs/test-results/2026-10-20-retest.md` | 网络恢复后的三轮真机、真实模型记忆链路、存档指针对齐和失败暂停修复 |
| `docs/test-results/2026-10-20-game-memory.md` | 独立副本中跨天、回滚、后端进程重启和旧档分叉的完整真机验收 |
| `docs/test-results/2026-10-22-same-day-call-off-windows.md` | 当天赴约、取消与送别的五项修复，241/43 自动检查、原生验收、保留失败及脚本边界 |
| `data/npcs/_template.md` | 角色卡的结构 |
| `reference/README.md` | 写卡用的参考资料，以及哪些能进仓库 |
