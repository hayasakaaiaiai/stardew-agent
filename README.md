# 星露谷 NPC Agent

让星露谷物语里的 34 位社交 NPC 自由聊天，记住你们的经历，并在游戏中赴约、帮忙和一起行动。后端使用 Node.js / TypeScript 和可配置的云端模型，SMAPI / C# Mod 复用原版界面。

当前为单人开发版本。Windows 已执行分批游戏脚本验收；自由模型仍有漏约和编造细节的问题，详见 [项目现状](docs/status.md) 与 [真实游戏报告](docs/test-results/2026-10-24-real-meetings-game.md)。

## 功能

下面是 `main` 上已经实现、并在 Windows 游戏里用脚本验收过的全部功能。“开关”一列是 Mod 的 `config.json` 里的开关，默认全开，说明见 [Mod 配置](#mod-配置)；写着“—”的一直开着。H 线硬件陪伴保留在 `hardware-companion`，尚未纳入 main，这里不列。

### 和 NPC 聊天

| 功能 | 游戏里是什么样 | 开关 | 文档 |
|---|---|---|---|
| 继续聊 | 原版台词说完后，问“要继续和阿比盖尔聊聊吗？”。选“继续聊”，就在原版对话框里接着聊：每轮 3 个选项、“自己说……”（原版输入框，能用输入法打中文）和“离开”。头像会跟着回复的表情变。等回复时 NPC 头上冒“……”，游戏时钟停住，按 Esc 可以取消；单人游戏里整段对话基本不花游戏时间。原版每天 +20 的好感和剧情台词都照旧 | `OfferContinueChat`、`ReplyTimeoutSeconds`、`PauseClockWhileWaiting` | [game-bridge](docs/game-bridge.md) §10 |
| 34 张角色卡 | 每位 NPC 一张卡，按心数、关系（朋友、约会、订婚、结婚、室友）和看过的心事件决定说什么。没看过的事件当作没发生过 | — | [dialogue-prototype](docs/dialogue-prototype.md)、[legacy-cleanup](docs/legacy-cleanup.md) |
| 镇上都知道你的家事 | 你和谁结了婚、订了婚、和谁住在一起、有几个孩子，镇上其他人也知道。比如娶了阿比盖尔以后，皮埃尔不会再说她整天闷在家里 | — | [world-public-facts](docs/world-public-facts.md) |
| 知道自己今天的行程 | NPC 知道自己今天原版日程里接下来去哪，问“待会儿去哪”“晚上在哪能找到你”能答上来 | — | [npc-schedules](docs/npc-schedules.md) |
| 聊天影响好感 | 夸到心坎上、真心关心，原版好感会涨；冒犯、嘲笑会掉。不熟的时候难加、容易扣，熟了以后容易加、不容易扣。聊天带来的变化每位 NPC 每天合计在 −40 到 +30 点之间，跟着存档走 | `ChatChangesFriendship` | [npc-friendship](docs/npc-friendship.md) |

### 记忆

| 功能 | 游戏里是什么样 | 开关 | 文档 |
|---|---|---|---|
| 记得聊过的事 | 睡觉存档后才记住；不存档就退出，那天聊的会一起忘掉。读旧档时，只记得那个存档之前发生的事。后端中途重启，能接上当天的对话 | — | [game-memory](docs/game-memory.md)、[memory-kernel](docs/memory-kernel.md) |
| 夜里整理一天 | 每天晚上，给当天和你聊过的 NPC 整理一遍：挑 1–2 句原话记下（说话人由代码核对，不让模型改写），更新对你的印象，想好第二天的打算。模型输出格式出错时会自动补跑 | — | [nightly-consolidation](docs/nightly-consolidation.md) |
| 记得你送的礼 | 照原版的方式送礼，NPC 会记下一条“农场主送我紫水晶，我特别喜欢。”，之后问起来，回答和原版喜好一致 | — | [npc-gifts](docs/npc-gifts.md) |
| 节日记忆 | 花舞节和谁跳了舞、冬日星盛宴的秘密礼物、复活节和冰雪节的比赛、展览会名次、夏威夷宴会的汤，在场的人都记得 | `FestivalMemories` | [festival-memories](docs/festival-memories.md) |

### 第二天，NPC 自己找你

| 功能 | 游戏里是什么样 | 开关 | 文档 |
|---|---|---|---|
| 开场提起昨天的事 | 第二天第一次“继续聊”时，NPC 先提起昨晚想好的话题。你还没答应的邀约，她只会再问一次，不会当成已经约好 | — | [next-day-plans](docs/next-day-plans.md) |
| 头顶气泡 | 走到昨天和你聊过的 NPC 附近时，她头顶冒一句自言自语，配一个原版表情 | `ShowBubbles` | [npc-bubbles](docs/npc-bubbles.md) |
| 写信 | 有约定、要道谢，或者邀请还没得到回答时，第二天早上信箱里会有她的信。6 心以上时，信里还可能附一样东西 | `SendLetters` | [npc-mail](docs/npc-mail.md) |
| 当面送你东西 | 6 心以上（或约会、订婚、结婚、室友），当天第一次聊天时可能顺手递给你一样东西。和随信附赠共用冷却，同一个人 7 天最多送一次 | `InPersonGifts` | [npc-in-person-gifts](docs/npc-in-person-gifts.md) |
| 有话要说时走过来 | 真有事要找你的 NPC，看到你时头上冒“！”，喊你的名字，走到你旁边等一会儿 | `NpcApproach` | [npc-approach](docs/npc-approach.md) |

### NPC 之间

| 功能 | 游戏里是什么样 | 开关 | 文档 |
|---|---|---|---|
| 碰面聊天 | 两个 NPC 站到一起、你在附近时，他们头顶轮流冒出 2–4 句闲聊 | `NpcChat` | [npc-chat](docs/npc-chat.md) |
| 当面传话 | 碰面聊天时会说起前一晚决定可以告诉别人的新鲜事，听到的人会记住“阿比盖尔跟我说……”。别人要求保密的事、自己的心事不往外说 | `NpcChat` | [npc-news](docs/npc-news.md) |
| 不在场也传话 | 在你看不到的地方，NPC 待在一起一小时，就会把新鲜事传过去；听到的人还能再转告一次。这一项不调用模型 | `OffscreenNews` | [offscreen-news](docs/offscreen-news.md) |
| 后台聊天 | 在你不在的地方，几位有 5 心以上熟人的 NPC（最多 3 人）会一起聊一次，各自记下来。一天最多 6 次 | `BackstageScenes`（要先开 `OffscreenNews`） | [scheduler](docs/scheduler.md) |
| 同一张地图里的招呼 | 走进有人的屋子时，他们会和你打招呼、自言自语，或者互相说一句 | `AmbientLines` | [ambient-lines](docs/ambient-lines.md) |

### 约定

能约的地方：海滩、镇广场、墓地、山上湖边、森林河边、博物馆、星之果实餐吧、杂货店、你的农场、矿洞、骷髅洞穴、火山。

| 功能 | 游戏里是什么样 | 开关 | 文档 |
|---|---|---|---|
| 约明天 | “明天下午海边见”说定以后，第二天她到点自己走过去，在那里等一个半小时。你来了，她和你打招呼；你没来，她会记着“农场主没来” | `NpcMeetings` | [npc-meetings](docs/npc-meetings.md) |
| 当天约当天 | “现在陪我下矿吧”她答应了，马上就出发。屏幕上方提示“和阿比盖尔约好 11:50 在矿洞见” | `NpcMeetings` | [npc-same-day-meetings](docs/npc-same-day-meetings.md) |
| 约到后天 | 后天以内的日子都能约，可以说星期几、几号、节日名，或者“你生日那天”。约更远的日子，她会婉拒 | `NpcMeetings` | [npc-later-meetings](docs/npc-later-meetings.md)、[npc-meetings-more](docs/npc-meetings-more.md) §3 |
| 改约 | 已经约好的，可以改日子、钟点或地点 | `NpcMeetings` | [npc-meetings-more](docs/npc-meetings-more.md) §1 |
| 改口和送别 | 还没见面时说不去了，她就不去。在一起时说“你先回去吧”，她就回去；她要是嘴上说不走，你再坚持一句就行 | `NpcMeetings` | [npc-call-off](docs/npc-call-off.md) |
| 不会迟到 | 走路赶不上约定时间时，她会趁你看不见直接出现在约定地点；你已经在那张地图上的话，她从出入口快步走进来 | `NpcMeetings` | [npc-meeting-warp](docs/npc-meeting-warp.md) |
| 赴约影响好感 | 按约见面加好感，放她鸽子扣好感，和聊天共用每天的上下限。配偶和室友不加也不扣 | `MeetingsChangeFriendship` | [npc-meeting-friendship](docs/npc-meeting-friendship.md) |
| 失约、被拒以后 | 你放她鸽子以后 3 天内、拒绝她的邀约以后 1 天内，她聊天时还记着这件事。你再约她，答不答应看她的性格 | — | [npc-meetings-more](docs/npc-meetings-more.md) §2 |
| 节日当天约 | 节日那天约她，就是约好一起去节日。你去了、她也在场，就算赴约 | `NpcMeetings` | [npc-meetings-more](docs/npc-meetings-more.md) §3 |
| NPC 主动约你 | 8 心以上或在恋爱、订婚的 NPC，大约每 3 天会有一位走过来约你（同一个人至少隔 7 天），地点按她的性格挑 | `NpcInvites`（要先开 `NpcMeetings`） | [npc-invites](docs/npc-invites.md) |

### 一起做事

来农场帮忙和陪下矿，都要 8 心以上，或者在恋爱、订婚、结婚、室友关系里。心数不够的照样赴约，但来农场只是站着看看，在地牢门口只等不下去。

| 功能 | 游戏里是什么样 | 开关 | 文档 |
|---|---|---|---|
| 见面后一起逛 | 在普通地点见面以后，她跟着你走，你换地图她也跟过来。你钓鱼时她站在你旁边；你钓到鱼、捡到东西、挖到古物，她会冒表情。逛一会儿以后，她可能提议去一个地方，然后带你过去 | `MeetingsGoTogether` | [npc-outing](docs/npc-outing.md)、[npc-meetings-more](docs/npc-meetings-more.md) §4 |
| 来农场帮忙 | 约她来农场，她会浇水、收成熟的作物放进门口的箱子、给动物添干草、收鱼塘产物，还会捡动物产品、挤奶剪毛、摸动物、捡松露 | `NpcMeetings` | [npc-farm-help](docs/npc-farm-help.md)、[npc-farm-animals](docs/npc-farm-animals.md) |
| 不约也自己来帮忙 | 8 心以上或在恋爱、订婚的 NPC，大约每周会有一位上午自己来农场干活 | `NpcMeetings` | [npc-meetings-more](docs/npc-meetings-more.md) §5 |
| 陪下矿 | 约在矿洞、骷髅洞穴或火山的门口，她会跟着你一层层往下走。阿比盖尔、塞巴斯蒂安和肯特会帮你打怪，陪你下矿的人都会帮着敲石头。你晕倒时她把你背出来，不丢东西也不丢钱。你出了地牢，或者到了晚上 10 点，陪同结束 | `NpcMineCompanion`（要先开 `NpcMeetings`） | [npc-mine-companion](docs/npc-mine-companion.md)、[npc-meetings-more](docs/npc-meetings-more.md) §6 |

## 安装和启动

需要 Node.js 24、星露谷物语 1.6 和 SMAPI 4；编译 Mod 需要 .NET 8 或更高版本 SDK。以下为 Windows PowerShell 示例，在仓库根目录运行：

```powershell
npm ci
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
```

在 `.env` 填写 `NPC_MODEL_ENDPOINT`、`NPC_MODEL_NAME` 和 `NPC_MODEL_API_KEY`。接口使用 OpenAI 兼容的 `/chat/completions` 路径；端点填写基础地址。默认推理强度 high；超时和最大输出留空分别用 60000 ms、4000 token，后者包含推理 token。配置见 [.env.example](.env.example)。

先退出游戏，再编译并安装 Mod；将示例中的游戏目录换成实际安装目录：

```powershell
dotnet build mod/StardewAgentBridge -c Release '-p:GamePath=E:\games\steamapps\common\Stardew Valley'
npm run bridge
```

构建工具将 Mod 复制到游戏 `Mods/StardewAgentBridge`。保持后端运行，用 SMAPI 启动游戏并读档；看完原版 NPC 台词后选择“继续聊”。Mod 默认连接 `ws://127.0.0.1:47711`，后端未就绪时保持原版对话。改端口时同时设置后端 `NPC_BRIDGE_PORT` 和 Mod `config.json` 的 `BackendUrl`。

聊天会把角色卡、相关对话／记忆和游戏状态发送给你配置的模型服务。密钥保存在忽略的 `.env`；本地记忆与恢复数据在 `.runtime/game/`。更新代码时保留这份目录，备份游戏存档时一并备份对应的记忆数据。原理和恢复边界见 [存档记忆接入](docs/game-memory.md)。

## Mod 配置

第一次运行游戏后，SMAPI 会在 `Mods/StardewAgentBridge/config.json` 生成配置文件，改完重启游戏生效。

| 开关 | 默认 | 管什么 |
|---|---|---|
| `BackendUrl` | `ws://127.0.0.1:47711` | 后端地址 |
| `OfferContinueChat` | `true` | 原版台词后问要不要“继续聊”。关掉就没有对话入口 |
| `ReplyTimeoutSeconds` | `20` | 等回复的第一个字最多等几秒，超过就算 NPC 走神了 |
| `PauseClockWhileWaiting` | `true` | 等回复时停住游戏时钟（只停钟，画面照常动；联机时不停） |
| `ChatChangesFriendship` | `true` | 聊天影响原版好感 |
| `InPersonGifts` | `true` | 关系好的 NPC 聊天时当面送东西 |
| `ShowBubbles` | `true` | 头顶气泡 |
| `SendLetters` | `true` | NPC 写信 |
| `NpcChat` | `true` | 两个 NPC 碰面聊天，以及当面传话 |
| `OffscreenNews` | `true` | 你看不到的地方也传话 |
| `BackstageScenes` | `true` | 后台聊天（要先开 `OffscreenNews`） |
| `AmbientLines` | `true` | 同一张地图里的招呼和自言自语 |
| `FestivalMemories` | `true` | 节日记忆 |
| `NpcApproach` | `true` | 有话要说时走过来 |
| `NpcMeetings` | `true` | 约了就去赴约，包括当天约、约到后天、改约、改口、不迟到、节日约定、来农场帮忙、不约也自己来帮忙。关掉以后，约定只停留在嘴上 |
| `NpcMineCompanion` | `true` | 在地牢门口见面后跟着下去（要先开 `NpcMeetings`）。关掉的话她只在门口等 |
| `MeetingsChangeFriendship` | `true` | 赴约加好感、失约扣好感 |
| `MeetingsGoTogether` | `true` | 在普通地点见面后一起逛。关掉的话她只在原地等 |
| `NpcInvites` | `true` | NPC 主动约你（要先开 `NpcMeetings`） |

## 命令行工具

| 工具 | 做什么 | 文档 |
|---|---|---|
| `npm run chat -- abigail --hearts 4 --seen 1,2` | 在命令行和 NPC 聊天，带记忆。`/sleep` 存档并进入下一天，`/rollback` 不存档、退回上次存档，`/memories` 查看现在能想起的记忆，`/prompt` 打印上一次的完整 prompt，`/help` 列出全部命令 | [dialogue-prototype](docs/dialogue-prototype.md) §6、§13.3 |
| `npm run chat -- --probe all` | 跑所有 NPC 的探测题，对话记录存到 `.runtime/transcripts/` | [dialogue-prototype](docs/dialogue-prototype.md) |
| `npm run demo` | 用假模型离线演示记忆内核 | [memory-kernel](docs/memory-kernel.md) |
| `tools/test-game-*.ps1` | Windows 上的游戏内验收脚本，在独立的存档副本里跑 | 各功能文档的 Windows 清单一节 |

## 无游戏、无密钥验证

```powershell
npm test
npm run typecheck
npm run build
npm run demo
npm run demo:built
npm audit
node tools/check-repository.ts
```

离线测试不联网、不调用真实模型、不操作游戏存档；demo 使用临时数据库并在退出时清理。`demo:built` 需要先构建。`node:sqlite` 在 Node 24 上会显示实验性提示。

有游戏和模型配置时，可运行 [完整约定验收入口](tools/test-game-real-meetings.ps1)：`-Section edges` 执行固定反例，`-Section live` 使用收费的真实模型。脚本使用独立存档副本、Mod 和数据库，并比较原档 SHA256；执行前先退出正在运行的游戏。真实游戏最近七项中 4 项完整通过，另 3 项失败仍保留，不能把技术断言通过当作内容全部正确。

## 已知限制

- 真实游戏最近七项里 4 项完整符合预期。另外 3 项：NPC 收到邀约指令有时只寒暄；约定取消前她并没出发，第二天却说在海边等过；花舞节当面答应了，夜里却没记下约定。见 [真实游戏报告](docs/test-results/2026-10-24-real-meetings-game.md)。
- 约定、改约、改口和送别都由代码核对原话来判断。没明说的答应（比如“我早就想去了”）会漏掉；漏掉时 HUD 不会提示约好了，再明确确认一句就行。
- 模型偶尔会编出没依据的小细节，比如父亲的口头禅、东西摆在哪。说过的原话、送的礼、约定这些事实有代码核对，自由发挥的对白、印象和计划做不到完全准确。
- 推理强度用的是 `high`，偶尔一轮会超过 8 秒。
- 只支持单人游戏。

完整的已知问题见 [项目现状](docs/status.md) §6。

## 文档和资料

- [项目现状与文档索引](docs/status.md)：当前功能、分支、已知问题、测试证据。
- [记忆内核 API](docs/memory-kernel.md)：原 README 中的接口、保存回滚和恢复说明。
- [游戏桥接](docs/game-bridge.md)：Mod 原版界面、消息协议、配置和手测记录。
- [全仓审查报告](docs/test-results/2026-10-24-repository-audit.md)：本轮修复、验证及合并清理记录。
- [角色卡模板](data/npcs/_template.md) 与 [参考资料说明](reference/README.md)：角色事实来源、Wiki 署名和许可。示例台词按原版语气新写。

仓库不分发游戏导出文本、游戏程序集、存档、数据库或本地模型调用记录。`reference/wiki/` 保留来源页面、revision 和原许可说明；`reference/game/` 仅用于本地核对，已忽略。测试报告中的 `.runtime/` 路径是本地证据位置，公开仓库保留报告和复现脚本。
