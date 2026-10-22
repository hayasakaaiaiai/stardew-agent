# 当天赴约、取消与送别 Windows 检查（2026-10-22）

**五项问题已修复，限定场景验收通过。** 本轮先测试 `m2c-same-day-meetings / 8ed15be`，期间收到包含下矿 Windows 修复的 `m2c-call-off / 3fa263a`。用户随后明确要求“修复问题 推送”，工作分支为 `codex/call-off-windows-tests`，基于已推送的 `5e5f18d` 纳入 `3fa263a` 并修复。最终 **241/241 Node、43/43 C#、六批原生合计 257/257**，类型检查、构建和 Release 0 警告／错误通过；8 次真实保存、49 次读档，每批原档 6 文件 SHA256 一致。失败证据保留，提交与推送目标为本功能分支；未合入 main，正常安装未部署。

上一轮下矿修复 `cccd31e` 及记录 `5e5f18d` 已上传 `codex/mine-companion-windows-tests`；其 122/122 下矿、71/71 农场及 229/229 Node 结果见 [下矿报告](2026-10-22-mine-companion-windows.md)，不冒充本轮新功能全部合格。

## 首次发现的 5 个问题（修复前）

1. **已经过去的明确上午时间变成晚上。** 10:00 对话“今天上午九点矿洞见？”／“好啊，九点矿洞见。”，应拒绝过期约定，实际存 `21:00`；明确写 `09:00` 也一样。早上八点变成 `20:00`。`meeting-agreement.ts` 的 `agreedIn` 把所有小于 12 点且已过的钟点统一加 12 小时，丢掉了明确上午／24 小时制的含义。
2. **早上约今晚，NPC 简称钟点时漏约。** 06:00 对话“今晚八点星之果实餐吧见？”／“好啊，八点星之果实餐吧见。”，应存 `20:00`，实际 `null`。玩家的八点按晚上解释，NPC 的八点因上午还没过，被当成 `08:00`，两者冲突。需要从明确的时段解释省略时段的回复，不能按“这个钟点现在是否过去”猜。
3. **同次对话改成明天仍立即赴约。** “现在陪我下矿吧？”／“好啊。”／“改明天吧。”／“好啊，明天再去。”，实际仍存当天 `10:00`、`soon:true`。后续改口只识别拒绝词和另一个具体钟点，没有识别明确改日期；应区别于“那明天呢？”这种另起话题。
4. **半路取消、但原日程还没有第一站时，没有回原站位。** 在有明确原站位 `(Mountain 44,18)`、首个原站 14:00 的受控日程里，NPC 10:10 实际走动后取消。原站恢复了，但 NPC 留在 `(43,17)`，控制器已空。`RestoreSchedule` 放回站点后调用 `StopBefore(npc, now)`；没有过去站点时，它返回已经移动后的当前位置，原来的站位没有保存。原生断言失败，不是仅静态推测。
5. **预计到达时间被写成实际迟到时间。** 原话约 `15:00`；Mod 估计 `17:40` 到；脚本在真实寻路完成时核对游戏时钟为 `16:00`、`Arrived:true`、`Met:true`。结束后却可靠地记成“约好 15:00 在海滩见面，我 17:40 才到，农场主来了”，并直接进下次对话的 system prompt。`meet.ended.time` 发的是调整后的计划时间，`memory.ts` 把它作为 `arrived`；Mod 没记录实际抵达时刻。等待截止也仍由计划时间算，本样本是 19:10，而实际 16:00 抵达后的 90 分钟应是 17:30。

前三项已在上游原样 `8ed15be` 的独立核对模块重现（5 个输入变体全部得到错误结果）；最新 `3fa263a` 的完整测试仍复现 3 组失败，没有归因于合并。后两项由最新分支的真实 SMAPI 游戏执行复现。实际时钟探针是受控测试，不代表完整原版巴士解锁或全日自然行程。

## 修复前执行结果

| 范围 | 结果 | 原始记录 |
|---|---|---|
| 整合当天赴约，原有测试 | 234/234 通过、类型检查通过 | `.runtime/same-day-baseline-node.log` |
| 加入新增反例后的当天赴约 | 237 项，234 通过、3 失败 | `.runtime/same-day-final-node.log` |
| 最新取消／送别与新增反例 | **240 项，237 通过、3 失败** | `.runtime/call-off-node.log` |
| 类型检查、构建、Release | 通过，Release 0 警告／错误 | `.runtime/call-off-typecheck.log`、`call-off-mod-build.log` |
| 最新 C# 流程检查 | **42/42** | `.runtime/call-off-mod-checks.log` |
| 当天赴约原生核心（8ed15be 整合） | **25/25、82.50 秒**，1 次保存、5 次读档 | `.runtime/game-memory-20261022-173508` |
| 当天赴约原生边界（8ed15be 整合） | **17/17、117.16 秒**，5 次读档 | `.runtime/game-memory-20261022-174044` |
| 最新取消／送别原生（3fa263a） | **18 通过、1 失败，153.91 秒**，末项复现问题 4，整批失败 | `.runtime/game-memory-20261022-175249` |
| 最新抵达时间专项（3fa263a） | **5 通过、1 失败，54.16 秒**，末项复现问题 5，整批失败 | `.runtime/game-memory-20261022-175728` |

原生核心实际走过对话结束后立即发 `day.meetings`、原版 HUD、下一十分钟自然出发和步速 2 到门口、真实入矿／换层、prompt 中的“马上”和层数、一天不能约第二次、可靠记忆去重、同一游戏里重启后端、真实保存／重读、不保存回滚，并故意让夜间模型提议明天，验证不能把只说今天的约定挪到明天。

原生边界包含沙漠到海滩的路线规划和到场、约定钟点仍按原话保存、当天不睡觉也能来农场实际做农活、太晚去不了的原版失败 HUD、配偶不能约海滩的提示。加速拓扑与自然步速分别报告；当时未覆盖新增的实际迟到记录，后用最新抵达专项发现问题 5。

取消／送别批次在最后失败前，已通过出发前取消并还原被替换的原站、取消 HUD、prompt 去掉当前约定、不能同日重约、地牢里 NPC 不愿走时留下／答应后离开动态矿层、可靠记忆只写一次并包含送别者，以及农场走出后在原离开时刻之前结束。

四批原生各自原档 **6 文件 SHA256 前后一致**，独立测试存档与 Mod；本轮真实模型调用 **0**。固定回复用于验证协议、调度与存档，不声称验证了真实模型的同意／拒绝分布。

## 修复

- **钟点与改期。** `clockTimes` 保留是否省略时段的信息，只给省略时段的钟点继承约定的明确时段，过去的明确上午／24 小时钟点不再加 12 小时；双方明确说了不同时间仍拒绝。后续“改明天／推迟到后天”会撤回当天约定，“那明天呢”和条件句保留原约。新增反例与原来的独自行动、拒绝、结束时间、最新约定优先等一起回归。
- **取消归程。** Mod 规划时保存原站位 `Origin` 与完整原日程 `Original`。恢复被替换站点后，从原日程查现在该在哪；没有过去站点就回原站位。矿洞和农场送别共用这个恢复，保留动态矿层 `Trip.Actor`、原生步行及配偶看不到时归家的行为。
- **真实抵达、等待和记忆。** `ArrivedAt` 在原生到场检查处记录；`Time` 仍是规划估计。当天约定的 `Leave` 改为实际抵达后 90 分钟、最晚 22:00，并重算归程及恢复／延后受影响的原站；次日约定仍用原约定时刻。已到场的当天约定提前睡觉也报告。普通地点、农场入口与配偶都走同一记录入口。
- **兼容与验证。** 可靠 `meet.ended` 多一个可选 `arrived`（HHMM，不能晚于 `left`）；后端保存到当天日志，只据此记具体钟点约定的迟到，缺失时不从估计补造事实。协议版本仍为 3，旧客户端可继续发原格式。补上比估计早／晚、早于约定、旧消息无实际时刻、非法时刻的后端回归；两处 WebSocket 测试显式等初始／上一轮约定列表，避免把旧列表当作本轮结果。

prompt 模板和规则增量 **0 token**，常规模型调用增量 **0**，没有新增依赖。日志事实中的时刻按实测改正，不需要模型猜测。

## 修复后执行结果

| 范围 | 结果 | 原始记录 |
|---|---|---|
| 完整 Node | **241/241** | `.runtime/call-off-final-node.log` |
| 类型检查、构建 | 通过 | `.runtime/call-off-final-typecheck.log`、`.runtime/call-off-final-build.log` |
| Release 与 C# 流程 | 0 警告／错误，**43/43** | `.runtime/call-off-final-mod-build.log`、`.runtime/call-off-final-mod-checks.log` |
| 取消／送别原生最终批 | **20/20、155.06 秒**，半路取消回到 Mountain `(44,18)` | `.runtime/game-memory-20261022-182131` |
| 抵达初步专项 | **19/19、109.37 秒**，实际 16:00／18:00，截止 17:30／19:30，记忆使用实际时刻 | `.runtime/game-memory-20261022-181838` |
| 抵达最终专项 | **25/25、185.35 秒**，原站恢复／延后、两条真实归程，1 次真实保存、4 次读档后仍记实际时刻 | `.runtime/game-memory-20261022-182413` |
| 早睡专项 | **8/8、62.01 秒**，预计 17:40、实际 16:00，16:10 早睡仍报告并保存实际抵达；1 次保存、3 次读档 | `.runtime/game-memory-20261022-183121` |
| 当天赴约组合最终批 | **41/41、194.25 秒**，覆盖核心与边界，1 次保存、9 次读档 | `.runtime/game-memory-20261022-183530` |
| 下矿完整回归 | **122/122、435.53 秒**，三种地牢、三位战斗角色和海莉、配偶／室友、两种伤害救援、自然步速、4 次保存、19 次读档 | `.runtime/game-memory-20261022-183851` |
| 农场来访／归程回归 | **41/41、230.31 秒**，自然步速、真实农活、离开后原日程、低好感与亲密关系、配偶在场／离家；1 次保存、9 次读档 | `.runtime/game-memory-20261022-184613` |

最终六批（不重复计算初步专项）共 **257 项通过、8 次保存、49 次读档**。各批 Mod DLL 相同（SHA256 `DA56E37CB6C9785F63307878ED42C96EE0641D79D2BD007E9A005A59732DA5A7`），后端与 Mod 生产源文件均与证据目录副本一致；没有“回不到原日程”或抵达后算不出归程的回退日志。汇总在 `.runtime/call-off-final-evidence.json`。

每批原档 6 文件哈希一致。正常安装 DLL 仍为 `9C9D9EFEF9CF72529FDE5345DB7717A7675D8EEDADADD6D6DFFCBAD6389B128D`，没有部署本轮 DLL 或启动常驻后端。远端 `main` 保持 `35affae`，本地 `main` 仍为原来的 `c75c4f8`，均未移动。本机 Node `24.14.1`、.NET SDK `9.0.202`；Node 有 SQLite 实验性提示，npm 有既存 `store-dir` 配置提示，检查均成功。

抵达专项两种时钟均由 Mod 的真实寻路完成检查记录，不把加速游戏中的受控时钟误称为全日自然运行。

组合回归保留一次脚本失败：`.runtime/game-memory-20261022-182725`，28 项通过、1 项失败，125.57 秒。旧边界脚本用加速寻路在 14:40 实际到场后，再跳到预计 17:40 才让玩家来；修复后 90 分钟等到 16:10 已结束，所以“仍招呼玩家”断言失败。脚本改为在真正走到海滩前设置受控时钟，到场后核对 `ArrivedAt`，再验证招呼；未回退实际等待修复。

第二轮脚本 `.runtime/game-memory-20261022-183230` 为 27 项通过、1 项失败、128.36 秒：原生寻路完成回执先于 Mod 的周期到场观察，立即读取的 `Arrived` 尚未更新。补上与抵达专项相同的 60 帧观察等待后重跑；两次脚本失败均保留，期间生产修复没有改动。

## 复现

```powershell
npm test
npm run typecheck
npm run build
dotnet build mod/StardewAgentBridge -c Release '-p:GamePath=E:\games\steamapps\common\Stardew Valley' -p:EnableModDeploy=false
dotnet run --project tests/mod-flow/ModFlowChecks.csproj -c Release -- mod/StardewAgentBridge/bin/Release/net6.0/StardewAgentBridge.dll 'E:\games\steamapps\common\Stardew Valley'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-game-world.ps1 -Section same-day-core -Offline
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-game-world.ps1 -Section same-day-edges -Offline
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-game-world.ps1 -Section call-off -Offline
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-game-world.ps1 -Section call-off-arrival -Offline
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-game-world.ps1 -Section call-off-arrival-save -Offline
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-game-world.ps1 -Section mine -Offline
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-game-world.ps1 -Section farm-visits -Offline
```

`same-day` 会串行跑核心与边界；`call-off` 测取消／送别，`call-off-arrival` 测实际抵达与等待。纯上游失败输入和结果保存在 `.runtime/same-day-upstream-regressions.json`；游戏目录分别保留源代码、Mod、命令、原版日志、模型请求、协议和断言。每次只运行一个游戏，脚本自动创建隔离副本、结束游戏，并对原档全部 6 文件做 SHA256 比较。

尚未覆盖全 NPC、多人联机、全部原版剧情、所有地点第二站位、完整跨日取消重放和配偶各种送别路径。抵达专项使用受控游戏时钟和加速的原生寻路，不代表完整自然日程或巴士解锁流程。固定模型脚本验证 Mod／协议／状态，不代替真实模型的内容分布；本轮没有新增付费调用。

收尾拉取另外发现 `m2c-later-meetings / f68309b6f85af3e27d1de2998fee54d80ffddb65`（“约到后天”），没有纳入本轮五项修复或测试。本报告的上游基线仍为 `m2c-call-off / 3fa263a`。
