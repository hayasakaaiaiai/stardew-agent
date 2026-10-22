# 主动靠近与按约赴约：Windows 验收

测试远端 `m2c-approach / e8ec3c3`、`m2c-meetings / 9c4ca4a`。工作分支 `codex/meetings-windows-tests` 从已推送的 `770af1d` 出发，保留上一轮事实回答、原话记忆、节日和调度器修复。正常安装不部署，不合入 main。本轮沿用用户“手测部分写脚本测”的授权。

## 验证结果

| 范围 | 结果 |
|---|---|
| 原样上游快照 | 194/194 Node，类型检查通过 |
| 保留 Windows 修复的合并基线 | 210/210 Node、37/37 C#，类型检查、构建、Mod Release 通过 |
| 本轮最终单元与流程检查 | 214/214 Node、37/37 C#；类型检查和构建通过；Mod Release 0 警告、0 错误 |
| 原生完整动作组合（第六处修复后） | 103/103，773.36 秒，2 次真实保存、19 次读档；模型付费调用 0 |
| 原生自然时钟、提前睡觉和重读 | 14/14，136.22 秒，1 次真实保存、5 次读档；模型付费调用 0 |
| 旧行程、后台场景和花舞节原生回归 | 105/105，200.04 秒；固定模型，付费调用 0 |
| 最终前置路程修复 | 自然时钟 4/4、41.24 秒；八地点往返 51/51、427.59 秒；容量／迟到／开关等边界 21/21、41.13 秒 |
| 补强原版队列恢复和画面定位 | 5/5、44.04 秒；实际入队、自动恢复、只观察到达，另确认相邻位置并拍到 NPC 喊名 |
| 真实夜间整合 | 20/20，20 次 `high`；最终规则重放同样 20/20，额外付费调用 0 |

自然时钟样本从出发前一站开始：原版时间推进触发 12:10 出发，步速 2，13:40 到海滩 `(30,34)`，早于 14:00 的约定。玩家到场后原生 `Arrived/Met` 为真，画面可见阿比盖尔喊“记忆验收！”。14:10 睡觉时 `meet.ended` 的日期为春 1 日、时间 14:10、序号 2；`save.saving` 序号 3。次日退出重读后的实际对话请求含“约好 14:00 在海滩见面，农场主来了”。

最后一处规划修复后的杂货店样本从 12:50 自然推进，13:00 启动替换后的路线并在同一十分钟刻度内站到 `(13,20)`，原版控制器已结束、队列为空，原来的 14:10 迟到消除。随后重跑全部八地点及规划边界。完整 103 项、旧功能 105 项、海滩 14 项属于此前修复点；之后只补测改变的规划路径与驱动，按批次列出，不相加冒充一轮全新完整组合。

## 复现的问题与修复

1. **约定来源与时间不足以证明双方同意。**旧代码接受拒绝、尚未决定、条件邀请、单方邀请，以及引用 14:00 却输出 09:00 的错误模型结果。新增有限中文校验：双方意向、拒绝／不确定、时段与具体时间、后天及后续明确取消。具体时刻兼容另一方笼统时段答复和常见肯定短答。原始三组回归在旧代码上全部失败，记录 `meetings-source-guards-red.log`；其他负例与短答兼容也保留红测记录。
2. **继承属性被当成地点。**`constructor/toString/__proto__` 可使夜间核对抛错、进入保存状态，或被 `meet.ended` 记成虚构经历。三处入口改为自有地点键。真实 WebSocket 回归旧代码误记 3 条，修复后确认但不记；记录 `meetings-result-place-red.log`。
3. **收到得太晚仍改日程。**13:40 收到 14:00 海滩约定，仍放入 13:50 出发的 132 步路线。现在核对出发加预计路程及原有提前量，来不及就保留原日程；原生红测 `game-memory-20261022-080231`，初次定向绿测 `080348`。
4. **客户端接受后端不会生成的时间。**原来接收 07:00、14:05、21:10 等值。现在与后端一致，只认 08:00–21:00 的十分钟刻度。扩充后的 C# 检查在旧 DLL 上 36/37，修复后 37/37。
5. **出发点计算来回切换。**餐吧路线依次从 13:00 的镇上站点、较早的杂货店站点计算，时间又跨回 13:00，最终放弃可行约定。重算只保留更早的出发时间，保持两轮上限；可能更早到场等候。完整组合 `080516` 的前 71 项通过，第 72 项餐吧应用失败；修复后另测餐吧、杂货店，并重跑完整组合。
6. **提前睡觉漏记赴约。**原 `Saving` 回调里游戏已是次日 06:00，约定结束校验被跳过。新增 `DayEnding` 结算，保留可靠队列和重复保护。自然时钟红测 `081739` 为 10/11，修复后 `082107` 为 14/14，真实日期、序号、保存与重读均符合。
7. **未算上一段原版路程，赴约只能排队迟到。**从 12:50 开始自然计时，原计划 13:00 走原版站点、13:10 出发赴约，14:00 的杂货店约定实际 14:10 才到。`084232` 为 2/3。改为先核对上一段路线的预计抵达，必要时提前替换这站、从更早站点出发；如果必须回到过去则不改。最后这处修复后单独复测自然时钟和全部地点。

不改存储内核、状态格式、模型档位或依赖。普通 prompt 完全不变，本轮修复增量 **0 token、0 次模型调用**。原会议端到端假模型只写“回复 N”，没有真正答应，已改成明确答复并引用双方原话。

测试驱动首轮也有原版“继续聊”问题框在强制关闭后重新弹出的等待问题；改为逐帧关闭已排队菜单。另一次控制文件原子替换遇到短暂共享异常，改用允许删除／替换的只读文件流并在瞬时 IO 冲突时重读。均保留原记录，不用重试抹掉产品失败。

另补强了旧队列用例：先显式让原版 `checkSchedule` 在临时控制器持有时到点排队，检查待执行数大于零；靠近结束后检查原版控制器自动接管、队列清空，最后只等它到达，不再手动启动路线。海滩首个画面夹具从 `(35,34)` 出发时触发合法的原地招呼，原“必到相邻格”的断言失败（`084001`，3/4）；改用原版路线已经确认的 `(30,34)` 并读取实际玩家坐标，最终队列与画面专项 5/5，不改产品去迎合夹具。

## 成本与真实模型范围

`tools/test-actions-content.ts` 执行真实 `nightlyConsolidator`，10 种对话各 2 次。海滩下午、餐吧晚上、博物馆三点、墓地上午共 8/8 生成正确约定；拒绝、未决定、后天、没有时段、不支持地点和自行干活共 12/12 不生成约定。已答应的 8 份中模型选择主动靠近 5 份；这是 `seek` 的自主选择，不把赴约等同于一定提前来找玩家。明确拒绝和自行干活 4/4 不主动来找。

20 次调用总输入 **26,764**（缓存 **21,504**），输出 **16,210**（其中推理 **13,030**）；调用中位 **4.77 秒**，模型调用时间合计 **99.04 秒**。所有请求和完成结果逐条留存；最终规则重放时逐字核对请求，没有为内容失败追加付费重试。该批只验证约定与指定 `seek` 边界，印象、信件和闲聊仍有添写细节的样本。

分词实测用已有隔离安装的 `gpt-tokenizer@3.4.0 / o200k_base`，近似 DeepSeek，只数消息正文。夜间规则 `1060 → 1130 → 1285`，主动靠近 +70、赴约再 +155、合计 +225；固定对话样例 `2173 → 2194/2200`，当天有约定 +21、已经碰面 +27。本轮修复后的夜间规则与 `9c4ca4a` 相同。这些编码近似值和上游供应商计数分别报告。

## 复现入口

在项目根目录执行；原版测试要求先正常退出已有游戏，自动创建身份受限的独立副本，每次备份原档并核对全部文件 SHA256。

```powershell
npm test
npm run typecheck
npm run build
dotnet build mod/StardewAgentBridge -c Release '-p:GamePath=E:\games\steamapps\common\Stardew Valley' -p:EnableModDeploy=false
dotnet run --project tests/mod-flow/ModFlowChecks.csproj -c Release -- mod/StardewAgentBridge/bin/Release/net6.0/StardewAgentBridge.dll 'E:\games\steamapps\common\Stardew Valley'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-game-world.ps1 -Section actions -Offline
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-game-world.ps1 -Section actions-timing -Offline
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-game-world.ps1 -Section actions-incoming -Offline
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-game-world.ps1 -Section actions-checks -Offline
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-game-world.ps1 -Section actions-places -Offline
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-game-world.ps1 -Section content -Offline
```

默认 `-Section all` 也包含动作、自然时钟和前置路程检查。不加 `-Offline` 时原有对话／后台部分使用真实模型；动作验收及上述自然时钟数字来自固定模型原版进程，真实夜间整合另测，不能称为同一轮全真实端到端。

```powershell
# 20 次真实 high 调用；读本机 .env，不输出 key。
node tools/test-actions-content.ts
# 不收费，重放已有请求与完成结果。
node tools/test-actions-content.ts --replay .runtime/actions-content-2026-10-21T23-55-06-456Z/calls.jsonl
```

## 证据与边界

- 原样快照：`.runtime/review-new-commits-9c4ca4a`；最终 Node、类型、构建与 C# 日志：`.runtime/actions-final-*.log`。
- 原生组合 `082333`、旧功能 `083633`、海滩自然时钟 `082107`、最终前置路程 `084508`、八地点 `084556`、队列与画面 `085310`、边界 `085402`，均位于 `.runtime/game-memory-20261022-` 前缀目录。汇总 `.runtime/actions-final-evidence.json` 含各批次数、保存／读档数、哈希、错误和 DLL 校验。
- 真实模型：`.runtime/actions-content-2026-10-21T23-55-06-456Z`；最终重放：`.runtime/actions-content-replay-2026-10-22T00-14-25-778Z`；分词：`.runtime/actions-token-costs.json`。
- 每轮原版记录包含 `commands.jsonl`、`actions-trajectory.jsonl`、请求、协议消息、`checks.json`、`result.json`、SMAPI 日志和原档前后哈希。失败／中止 `074655/074943/075942/080231/080516/081739/084001/084232` 另存；`074943` 在正常步速完整定约链和部分地点通过后主动停止，为八地点采用明确标注的加速拓扑检查，不能算完整成功。
- 主动靠近和第一条完整赴约链步速 2；八地点拓扑矩阵步速 8，到达后恢复 2，时钟由脚本推进。另一个海滩样本打开自然时钟、步速 2，由原版到点触发出发。不能把矩阵的成功扩大成八地点自然时钟都准时，或 34 位 NPC、所有剧情与整夜日程均已验收。
- 新增守卫采用有限中文规则，模糊或冲突时会放弃约定，不能覆盖任意自由表达。截图已复核海滩到场招呼和补充的海滩靠近喊名；最早镇上截图未清楚拍到人物，不据此确认全部表情的视觉观感。
- 所有列为通过的批次原档 **6 个文件 SHA256 前后相同**，Mod／协议错误为空。独立启动时有 Steam 未运行的成就提示，Node 有 SQLite 实验性提示、npm 有既有 `store-dir` 环境警告，均与 Mod 编译 0 警告／错误分开记录。
- 正常安装 DLL 仍为 `9C9D9EFEF9CF72529FDE5345DB7717A7675D8EEDADADD6D6DFFCBAD6389B128D`；正常后端 47711 无监听，本轮不部署、不重启、不写正常存档。代码只提交本地验收分支，未推送、未合入 main。
