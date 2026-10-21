# 项目现状

> 更新于 2026-10-21。每做完一步就更新这份文档。各部分的细节在各自的设计文档里，见 §8。

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
| M1 存储与事务 | 完成 | 记忆内核；当天事务；存档与回滚；崩溃恢复；过期临时日志/检查点清理，失败新读档保护旧日志（2026-10-20 合入 `main`） | — | `README.md`、`design.md` §16 |
| M2 Agent | 第一至八步、公开家庭信息、好感分档已合入 | 对话、夜间整合、次日计划、气泡、寄信、恢复；碰面、送礼、好感（按熟悉程度分档）、当面赠礼、家庭信息、在场传话（2026-10-21 Windows 验收后合入 `main`） | 不在场传话（`m2c-offscreen-news`）、遗留清理/全部改用 high（`legacy-cleanup`）和同图小动作（`m2c-ambient-lines`）待验收；观察正常游玩和自由生成内容 | `dialogue-prototype.md`、`nightly-consolidation.md`、`next-day-plans.md`、`npc-bubbles.md`、`npc-mail.md`、`npc-chat.md`、`npc-gifts.md`、`npc-friendship.md`、`npc-in-person-gifts.md`、`world-public-facts.md`、`npc-news.md`、`offscreen-news.md`、`legacy-cleanup.md`、`ambient-lines.md` |
| M3 接入游戏 | 完成（Windows） | 游戏里"继续聊"；真实保存/退出、跨天记忆、回滚、后端进程重启与旧档分叉；拼音输入法、原版台词保留、取消三项手测通过 | — | `game-bridge.md`、`game-memory.md` |
| M4 内容 | 角色卡已完成 | 34 张角色卡（已审阅），"看过事件之后"共 201 条（`group-events` 补群体 10 心和科罗布斯 14 心后 226 条） | 物品名到 ID 的对应、各动作的上限 | `design.md` §11 |

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

23 时按用户“你写脚本测”“一个脚本测三个功能”的要求，在 `codex/social-windows-tests`（基于 `m2b-friendship` / `6654433`）新增统一入口 `tools/test-game-social.ps1`。115/115 Node、20/20 C#、类型检查、构建和 Release 零警告零错误通过；同一游戏进程完成 39 项检查、5 次真实调用、1 次真实睡觉保存和 3 次读档，80.43 秒通过。修复后端漏检 60 分钟间隔，并补上日期/异步跨天保护，正常 prompt token 增量 0。原档 6 文件哈希相同；真实模型正确回忆紫水晶，夸奖 +20、冒犯 -20。正常后端在 23:29 备份后重载为 PID 33020，协议 3 握手通过，Mod 安装哈希一致。未推送、未合入 `main`；内容编造样本和覆盖边界见 [三功能组合验收报告](test-results/2026-10-20-social-windows.md)。

随后按“新的部分提交也要测”同步 `c25e331` 及其前面 4 个新提交，在 `codex/new-parts-windows-tests` 保留上一轮测试和冷却修复。统一脚本新增当面赠礼、满背包、特殊物品过滤、家庭公开事实及跨进程清理测试，125/125 Node、20/20 C#、类型检查、构建与 Release 零警告零错误通过；同一游戏进程 115.80 秒、63 项检查、8 次真实调用、2 次真实保存、6 次读档通过。实际送出羊肚菌和樱桃炸弹，皮埃尔知道阿比盖尔搬到农场，原档 6 个文件哈希相同。复现并修复无效新读档先丢弃旧日志的问题，正常 prompt token 增量 0。正常后端 23:49 备份后重载为 PID 1564，DLL 哈希一致、协议 3 握手通过。未推送、未合入 `main`，详见 [新提交组合验收报告](test-results/2026-10-20-new-parts-windows.md)。

用户随后明确要求“推送”。验收代码 `a966ea6`（包含上一轮 `36999ea`）已上传到 GitHub 的 `codex/new-parts-windows-tests`，本分支已设置远端跟踪。前文“未推送”为当时验收完成的状态；目前仍未合入 `main`。

按用户“陌生时容易扣、难加，熟悉时不容易扣、容易加”，`m2b-friendship-by-hearts` 把好感换算改成按熟悉程度分档：加分每档 0–1 心 5、2–4 心 10、5–7 心 15、8 心以上或亲密关系 20；扣分反过来是 20、15、10、5；每天 −40 到 +30 的上限不变，token 成本 0。已变基到合并后的 `main`，Windows 组合脚本的好感预期改为按同一张表计算（测试档阿比盖尔 8 心：`+30,0,0,-10×7,0`）。见 [npc-friendship.md](npc-friendship.md) §2.1。

M2b 第八步“NPC 之间传话”在 `m2b-npc-news` 上实现：当晚和玩家聊过的 NPC 在夜间整合时自己决定一件愿意告诉别人的事（谁要求保密的、自己的秘密和心事、普通寒暄都不写），第二天碰面聊天时可以说出来；Mod 显示完后发 `scene.shown`，听到的人记“阿比盖尔跟我说：“……””，跟当天保存或回滚。真实模型：夜间 48 次全部符合预期，16 次秘密都没说出去；碰面聊天 9 次转述都没超出给定内容。每晚每位 NPC +77 输入（可缓存）、约 +45 输出；碰面规则 +62（可缓存），有新鲜事时 +约 32。已和 Windows 的碰面冷却修复合在一起，变基后 130/130、类型检查、构建和 Release 编译通过，见 [npc-news.md](npc-news.md)。

2026-10-21 按用户“又提交了新的 测试”扩展统一入口，分支已变基到 `main / ed9eb28`，纳入 `m2b-npc-news / dc6d1d2`（含 `6774889`）。11 种好感状态、原生传话、公开/保密、显示中断、重复确认及保存回滚全部通过；修复听者离场仍确认、同连接新读档继承旧场景预算，正常 token 增量 0。最终 132/132 Node、20/20 C#、类型检查、构建、Release 零警告/错误通过；115 项真机检查、250.33 秒、22 次真实调用、4 次保存、8 次读档，原档 6 文件哈希一致。正常后端 00:38:37 备份后更新为 PID 12072，DLL 哈希一致，新协议消息探测通过。截图中“我弟”原始回复属于山姆，塞巴的卡片仍正确写妹妹玛鲁；添写文森特也听说了的内容未当成真实事件。完整证据、采样限制和错误/中止记录见 [本轮报告](test-results/2026-10-21-news-windows.md)。

自主行动第一步“玩家不在场时也传话”在 `m2c-offscreen-news` 上实现。用户选定：不在场也传话、可以再传一手、白天 0 次额外模型调用。每到游戏整点，Mod 报告玩家看不到的地方哪些 NPC 待在一起（室内同一张地图，室外 6 格以内），后端用代码传话：当事人说出去是第一手，听到的人当天还能再转告一次（第二手），第二手不再往下传；每人对同一件事只记一次，跟当天保存或回滚。碰面聊天也能说第二手的新鲜事。0 token。见 [offscreen-news.md](offscreen-news.md)。

遗留问题清理在 `legacy-cleanup` 上（建在 `m2c-offscreen-news` 上）：实测 48 次对话里 42% 把 `remember` 写成字符串数组、记忆被整条丢掉，改为接收；气泡放过“太……了”；对话推理强度用 66 道探测题重测后保持 `high`，按用户要求夜间整合和碰面聊天也改成 `high`（夜间输出约 +31%，碰面输出约 2.1 倍、+0.6 秒）；85 条没有禁忌的事件在没看过时显示“没发生过：……”（合计 1433 token）；0–1 心回忆门槛降到 3；卡片核心标准改为不超过 700。2026-10-21 两条分支变基到合入分档与在场传话后的 `main` / `35affae`，和 Windows 的场景中断、读档预算修复合在一起，138/138、类型检查、构建和 Release 编译通过。见 [legacy-cleanup.md](legacy-cleanup.md)。

碰面聊天补上玩家性别（`scene-player-gender`，建在 `legacy-cleanup` 上）：带新鲜事的碰面原来不知道玩家是男是女，15 段里 5 段把女性玩家叫成“他”；有新鲜事时加一行“农场主：小林（女）”（12 token）后 6 处都用“她”。见 [npc-news.md](npc-news.md) §4.1。

压低自由编造（`less-fabrication`，建在 `scene-player-gender` 上）：8 道诱导补写的题实测 24 次里 7 次有没依据的小细节（紫水晶摆在哪、镇上谁夸了你），两种规则（35–50 token）都没有减少，不加；夜间 `share` 把普通道谢当新鲜事（4 次 3 次），改为代码过滤“谢”（谢恩除外），复测 4/4 拦下、真新鲜事照传，0 token。见 [legacy-cleanup.md](legacy-cleanup.md) §5。

同图小动作（`m2c-ambient-lines`，建在 `less-fabrication` 上）用户确认设计后已实现，等 Windows 验收：玩家附近最多 4 位 NPC 合并调用一次，每人最多冒一句、可以每天跟农场主打一次招呼；每位 NPC 两个游戏小时最多一次、两次调用隔 30 游戏分钟、一天最多 12 次；只显示，不写记忆。真实模型 21 次平均输入 799、输出 248 token、2.9 秒，一天最多约 9.6k 输入、3.0k 输出。最终代码真实模型 12 次平均 785 / 220 token、2.4 秒，过滤后每次 2.6 句。141/141、类型检查、构建和 Release 编译通过，新增的 C# 流程检查要在 Windows 跑。见 [ambient-lines.md](ambient-lines.md)。

补内容（`group-events`，建在 `m2c-ambient-lines` 上）：群体 10 心的两种结局其实是两个编号不同的事件（女生 `195012` 对质 / `195019` 兔子脚，男生 `195013` / `195099`），科罗布斯 14 心是 `7771191`。按用户选择 12 张候选人卡各加两条（没看过时每卡常驻 +44 token），科罗布斯那条禁忌补上编号（没看过时 40 → 14）；原版疏远的那一周，这六人不弹“继续聊”、不参加同图小动作。真实模型 7 道题各 2 次全部符合预期，142/142、类型检查和 Release 编译通过。见 [legacy-cleanup.md](legacy-cleanup.md) §6。

节日记忆（`festival-memories`，建在 `group-events` 上）设计稿，等用户确认：花舞节舞伴、冬日星盛宴秘密礼物、复活节/冰雪节比赛和展览会名次、夏威夷宴会汤的评价，按模板给在场的 NPC 记，不调用模型，被想起时每条 18–29 token。见 [festival-memories.md](festival-memories.md)。

## 3. 分支

GitHub 私有仓库：https://github.com/hayasakaaiaiai/stardew-agent

| 分支 | 内容 | Mac 上的目录 |
|---|---|---|
| `main` | 已合入的基线：记忆内核 + 对话 + M3a + M3b + 夜间整合 + M2b 第一至七步（次日计划、气泡、寄信、碰面聊天、送礼记忆、聊天好感、当面赠礼）+ 公开家庭信息 + 临时日志清理 | `/Users/a11/Documents/ChatGPT/stardew-agent-dialogue`（目录名是以前留下的） |
| `codex/npc-memory-store` | 记忆系统的开发分支，做完一步快进合并回 `main` | `/Users/a11/Documents/ChatGPT/stardew-agent` |
| `hardware-companion` | `main` + 硬件陪伴（机器人），还没合并 | `/Users/a11/Documents/ChatGPT/stardew-agent-hardware` |
| `codex/next-day-plans` | M2b 首次开场主动提计划，2026-10-20 已快进合并进 `main` | Windows：`E:\stardew-agent` |
| `m2b-bubbles` | M2b 头顶气泡和表情，2026-10-20 随 `codex/mail-windows-tests` 合入 `main` | `/Users/a11/Documents/ChatGPT/stardew-agent-m2b` |
| `codex/bubbles-windows-tests` | 气泡 Windows 验收和三处修复，`910c127` 保留，未推送 | Windows 历史验收分支 |
| `m2b-mail` | NPC 寄信与随信附赠，2026-10-20 随 `codex/mail-windows-tests` 合入 `main` | `/Users/a11/Documents/ChatGPT/stardew-agent-mail` |
| `codex/mail-windows-tests` | 气泡、寄信验收与修复，追加夜间格式失败恢复；2026-10-20 快进合并进 `main` | Windows：`E:\stardew-agent` |
| `m2b-npc-chat` | M2b 第四步上游；Windows 验收和冷却修复见 `codex/social-windows-tests` | `/Users/a11/Documents/ChatGPT/stardew-agent-chat` |
| `m2b-gifts` | M2b 第五步上游，协议 3；Windows 验收见 `codex/social-windows-tests` | 已提交，目录现在用于下一步 |
| `m2b-friendship` | M2b 第六步上游，包含第四、五步；Windows 验收见 `codex/social-windows-tests` | `/Users/a11/Documents/ChatGPT/stardew-agent-gifts` |
| `codex/social-windows-tests` | 上一轮三项统一脚本验收和冷却修复，`36999ea` 保留；未推送 | Windows 历史验收分支 |
| `m1-scratch-cleanup` | 新读档清理其他 nonce 的临时日志和检查点，上游 `2c12b9f` | 已同步到当前验收分支 |
| `m2b-in-person-gifts` | 当面送礼及特殊物品过滤，上游 `7a7d52d` | 已同步到当前验收分支 |
| `world-public-facts` | 公开家庭状态与中文日志，上游 `c25e331` | 已同步到当前验收分支 |
| `codex/new-parts-windows-tests` | 统一验收与失败读档保护修复；2026-10-20 按用户“合并到 main”快进合入 `main` | Windows：`E:\stardew-agent` |
| `m2b-friendship-by-hearts` | 好感按熟悉程度分档；随 `codex/news-windows-tests` 合入 `main` | — |
| `m2b-npc-news` | 在场传话，基线 `dc6d1d2`；随 `codex/news-windows-tests` 合入 `main` | — |
| `codex/news-windows-tests` | 最新 `main / ed9eb28` + `dc6d1d2`，好感分档与传话组合验收及两处修复；2026-10-21 按用户“合并完继续下一步”快进合入 `main` | Windows：`E:\stardew-agent` |
| `m2c-offscreen-news`、`legacy-cleanup` | 不在场传话；遗留清理与全部改用 high。已变基到新 `main`，待独立验收 | 已提交 |
| `scene-player-gender` | 碰面聊天补上玩家性别，建在 `legacy-cleanup` 上 | 已提交 |
| `less-fabrication` | 自由编造实测（不加规则）与 `share` 道谢过滤，建在 `scene-player-gender` 上 | 已提交 |
| `m2c-ambient-lines` | 同图小动作，建在 `less-fabrication` 上；待 Windows 验收 | 已推送 |
| `group-events` | 群体 10 心、科罗布斯 14 心的“看过事件之后”和疏远期处理，建在 `m2c-ambient-lines` 上 | 已推送 |
| `festival-memories` | 节日记忆，建在 `group-events` 上；设计稿待确认 | `/Users/a11/Documents/ChatGPT/stardew-agent-gifts` |

Windows 上的目录是 `E:\stardew-agent`。当前 `codex/news-windows-tests` 从上一轮 `908e73b` 建立，测试期间发现主线更新后先备份改动、变基到 `origin/main / ed9eb28`，再纳入最新 `m2b-npc-news / dc6d1d2`，保留上游新加的动态好感预期与本轮真机夹具。此前所有本地验收分支及 `codex/next-day-plans` / `2260625` 均保留。

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
| 别人的心事件在这个 NPC 的卡里没有对应禁忌，玩家问起还没发生的事件时，NPC 可能会顺着说下去（比如刘易斯和服装疗法）。`legacy-cleanup` 已改为没看过时写明“没发生过”，待验收 | `dialogue-prototype.md` §12.6、`legacy-cleanup.md` §4.1 |
| 推理强度 `high` 偶尔推理太长，单轮超过 8 秒。66 道探测题重测后用户仍选 `high` | `dialogue-prototype.md` §12.6、`legacy-cleanup.md` §3 |
| 偶尔有小的事实错误，比如矮人说族里"就剩我一个了" | `dialogue-prototype.md` §11 |
| 0 心时 NPC 可能太健忘。`legacy-cleanup` 已把 0–1 心的门槛从 4 降到 3，待验收 | `dialogue-prototype.md` §14.5、`legacy-cleanup.md` §4.2 |
| 群体 10 心事件、科罗布斯 14 心事件还没写"看过事件之后"。`group-events` 已补，待验收 | `legacy-cleanup.md` §6 |
| 每次都发给模型的卡片核心部分实测 530–690 token，超过最初定的 500。用户决定不压，标准改为 700 | `design.md` §11、`legacy-cleanup.md` §4.3 |
| 真实模型附加字段偶尔解析失败，会走现有回退路径；本次 10 次调用出现 1 次 | `test-results/2026-10-20-retest.md` |
| 夜间事实记忆已改为原话引用；印象与计划仍由模型生成，可能夹带具体事实或遗漏内容，需继续观察 | `test-results/2026-10-20-nightly-facts-fix.md` |
| 计划开场使用保守问句处理，可能回退为较笼统的提问；尚未解析“下周”等任意日期表达，普通对话仍可能出现事实错误 | `test-results/2026-10-20-next-day-plans.md` |
| 气泡完成动作词过滤较保守，可能丢弃正常句子；模型可能继续追问被否认的话题，不能把规则过滤当成完整事实校验 | `test-results/2026-10-20-bubbles-windows.md` |
| 模型仍可能不合格式；现已保留未完成状态并有限补跑。持续失败仍需在最近 3 个保存点内读档或重启补跑，旧版已标完成的历史不重写 | `test-results/2026-10-20-nightly-recovery.md` |
| 三功能组合的真实模型仍补写窗台、老虎等细节，记忆字段曾混入未选择的选项；当次非法字符串记忆已被解析器忽略，自然游玩仍需观察 | `test-results/2026-10-20-social-windows.md` |

## 7. 下一步

1. **硬件陪伴（暂停）**：用户 2026-10-20 决定 H 线先不做。H4（机器人接回游戏存档）已在 `hardware-companion` 实现并变基到最新 `main`，恢复时按 `companion-device.md` §13.9 在 Windows 上测。
2. **M2b 前三步已合入 `main`**：[次日主动提起计划](next-day-plans.md)、[头顶气泡和表情](npc-bubbles.md)、[寄信与随信附赠](npc-mail.md)，以及[夜间格式失败恢复](test-results/2026-10-20-nightly-recovery.md)。继续观察正常游玩中的自然语言日期、重复邀约、气泡过滤和自由生成内容。
3. **M2b 第四步：NPC 碰面聊天**：Windows 组合验收通过，后端 60 分钟冷却/日期修复在 `codex/social-windows-tests`；继续观察镇上自然碰面，见 [npc-chat.md](npc-chat.md) §8。
4. **M2b 第五步：送礼记忆**：原版赠送、保存、回滚和真实回忆的组合验收通过；生日、任务与节日场景的覆盖边界见 [npc-gifts.md](npc-gifts.md) §7。Mod 与后端均已更新到协议 3。
5. **M2b 第六步：聊天影响好感**：增减、上限、重复消息、保存与回滚通过，见 [npc-friendship.md](npc-friendship.md) §8；已合入 `main`。按熟悉程度分档在 `m2b-friendship-by-hearts`。
6. **自主行动**：第一步不在场传话待验收；第二步[同图小动作](ambient-lines.md)已实现，待 Windows 验收（清单见该文档 §8）。
7. **已合入 `main`（2026-10-20）**：用户提交组合验收结果并要求合并后，`codex/new-parts-windows-tests` / `908e73b` 快进合入；Mac 上复核 125/125、类型检查、构建和 Release 编译。包含第四至七步、公开家庭信息、临时日志清理，以及 Windows 修的后端碰面冷却与失败读档保护。自然婚礼/电影等剧情、全部 NPC 自然游玩和模型事实可靠性仍按 [本轮报告](test-results/2026-10-20-new-parts-windows.md) 的覆盖边界观察。
8. **好感分档与在场传话已合入 `main`（2026-10-21）**：`codex/news-windows-tests` / `7ff44ea` 的统一脚本 115 项真机检查通过，含两处修复；按用户要求快进合入，Mac 复核 132/132、类型检查、构建和 Release 编译。结果、失败保留与范围见 [10 月 21 日报告](test-results/2026-10-21-news-windows.md)。
9. **待验收**：`m2c-offscreen-news`（不在场传话）和 `legacy-cleanup`（字符串记忆、气泡过滤、没发生过的事件、0 心门槛、全部改用 high）已变基到新 `main`，切到最前端的 `group-events`（含性别修正、压低编造、同图小动作和补内容）一起测；不能将 `dc6d1d2` 的 low/disabled 数据当作它们已通过。

## 8. 文档索引

| 文档 | 讲什么 |
|---|---|
| `docs/test-results/2026-10-21-news-windows.md` | 好感分档、NPC 传话、显示中断与同日读档预算的组合验收和失败证据 |
| `AGENTS.md` | 给 AI 助手的协作约定（Claude Code 通过 `CLAUDE.md` 读取它） |
| `docs/status.md` | 本文档：进度、分支、环境、遗留问题、下一步 |
| `docs/design.md` | 整体设计：已确认的决策、架构、存档和回滚、协议、角色卡、里程碑 |
| `README.md` | 记忆内核（M1）的用法和接口 |
| `docs/learning-memory.md` | 记忆内核的学习指南 |
| `docs/dialogue-prototype.md` | 角色卡加载、对话调用、命令行、探测题，以及接入记忆和好感度影响记忆 |
| `docs/game-bridge.md` | M3a：Mod 和后端的协议、原版界面怎么复用、游戏内测试清单 |
| `docs/game-memory.md` | M3b：存档同步、跨天记忆、确认补发与崩溃恢复 |
| `docs/nightly-consolidation.md` | 夜间整合：产出、输入、触发时机、出错处理、实测 token 和真实模型结果 |
| `docs/festival-memories.md` | 节日记忆：每项结果从游戏哪里读、记什么、消息、测试和 Windows 清单 |
| `docs/ambient-lines.md` | 自主行动第二步：同图小动作的决定、规则、打不打招呼的实测对比、消息、测试和 Windows 清单 |
| `docs/offscreen-news.md` | 自主行动第一步：玩家不在场时也传话的决定、消息、成本、测试和 Windows 清单 |
| `docs/legacy-cleanup.md` | 遗留问题清理：字符串记忆、气泡过滤、三档推理强度实测、没发生过的事件、0 心门槛、卡片标准、压低编造、群体 10 心和科罗布斯 14 心 |
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
| `data/npcs/_template.md` | 角色卡的结构 |
| `reference/README.md` | 写卡用的参考资料，以及哪些能进仓库 |
