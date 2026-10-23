# 动物活开发分支合并后的 Windows 回归

## 范围

用户要求“看一下有没有新推送”，随后要求“测一下之后修复”。远端 `m2c-farm-animals` 从 `c8e9821` 更新到 `c5728f3`，新增一个合并提交，把已测过的 `b1c34f4` 日期、赴约好感、配偶／室友豁免和动物活修复并入开发分支。它尚未包含后续已推送的 `ab9eb06` 入口临时快走和过期保护。

本轮在 `codex/animals-merge-windows-tests` 从 `ab9eb06` 整合 `c5728f3`，不合并 main，不部署正常 Mod 或重载常驻后端。固定模型、真实模型调用 0；不改变 prompt、调用次数或依赖。

## 合并处理

- `Meetings.cs` 保留 `ReceivedAt`、按实际到达判断 `ComesLate`、配偶／室友赴约均不加不扣，同时保留 `WarpSpeed`、到期前未抵达的保护及抵达／取消／过期／清理恢复步速。
- 日期解析沿用开发分支的 `agreedClocks`，替换功能相同的 `readClocks` 回调形式；裸钟点继承明确时段，只有今天的模糊钟点才能按当前时钟转为晚上。`agreedPlace` 已经检查改日，移除 `agreedIn` 中重复的相同检查。
- C# 流程检查只保留一份 `WarpDeparture` 检查，保留实际迟到和好感边界检查。
- 文档保留 Windows 已完成的快走验收和用户的明确选择，更新开发分支状态。

新旧解析在 4,608 组受控对话中比较了今天／未来约定、取消和日期换算，23,040 次 API 结果比较没有差异。组合包含上午、晚上、裸钟点、24 小时钟点、明确改日，以及跨季／跨年日期；这是合并等价性检查，不计作新增产品功能覆盖，也不替代原生测试。证据为 `.runtime/animals-merge-parser-comparison.json`。

## 验证结果

Node **258/258**、C# **46/46**、类型检查和后端构建通过；Mod Release **0 警告、0 错误**，编译关闭部署。

| 章节 | 通过 | 保存／读档 | 证据目录 |
|---|---:|---:|---|
| 动物活、物品守恒、保存回滚 | 43/43 | 1／8 | `.runtime/game-memory-20261022-225027` |
| 后天约定、跨季、取消、重连 | 17/17 | 4／5 | `.runtime/game-memory-20261022-225219` |
| 赴约好感、实际迟到、共享额度 | 57/57 | 1／13 | `.runtime/game-memory-20261022-225435` |
| 原版上下限及友谊之书 | 29/29 | 0／5 | `.runtime/game-memory-20261022-225855` |
| 配偶与室友的八种组合 | 57/57 | 0／8 | `.runtime/game-memory-20261022-230047` |
| 入口快走、抵达、归程、取消 | 45/45 | 0／9 | `.runtime/game-memory-20261022-230233` |
| 过期保护、步速封顶、迟到免扣 | 16/16 | 0／4 | `.runtime/game-memory-20261022-230659` |
| 当天邀约、原版路线与保存 | 44/44 | 1／8 | `.runtime/game-memory-20261022-230820` |
| 提前睡觉报告与保存召回 | 8/8 | 1／2 | `.runtime/game-memory-20261022-231032` |

限定原生合计 **316/316**，**8 次真实睡觉保存、62 次真实读档**；真实模型 0 次。各批原档 6 文件 SHA256 前后相同，收尾再与原目录核对一致。每批归档的全部生产源码和测试脚本均与最终文件一致，各批 DLL 与最终构建一致：`777A1422EF3230101AE7AB7F5A590B0D1556E7C32560CF1099479055C884727E`。正常安装 DLL 保持 `9C9D9EFEF9CF72529FDE5345DB7717A7675D8EEDADADD6D6DFFCBAD6389B128D`，常驻后端未重载。

本轮没有发现新增产品缺陷；合并时补齐开发分支尚未包含的入口快走、步速恢复和过期误扣保护。新旧日期解析等价，原版实际好感、配偶／室友豁免、动物物品守恒及保存回滚均通过。

## 执行记录

辅助批处理最初误用 Windows PowerShell 5：第一次因无 BOM 的中文字符串解析失败，尚未启动测试；第二次把 Node 的 SQLite 实验性警告当作终止错误，尚未启动游戏。改用本任务原有的 PowerShell 7 执行环境，不修改产品代码或测试断言。第二次的独立目录为 `.runtime/game-memory-20261022-224958`，启动日志另存 `.runtime/animals-merge-startup-powershell5.log`，原档哈希相同；这两次均不计入通过数。

## 重复执行

正常退出游戏后，在 PowerShell 7 的仓库根目录执行：

```powershell
foreach ($section in @('farm-animals', 'later-meetings', 'meeting-friendship', 'friendship-boundaries', 'meeting-spouses', 'meeting-warp', 'meeting-warp-edges', 'same-day', 'call-off-arrival-save')) {
    & .\tools\test-game-world.ps1 -Offline -Section $section
    if ($LASTEXITCODE -ne 0) { throw "原生章节失败：$section" }
}
npm test
npm run typecheck
npm run build
dotnet build mod/StardewAgentBridge -c Release -p:EnableModDeploy=false
dotnet run --project tests/mod-flow/ModFlowChecks.csproj -c Release -- mod/StardewAgentBridge/bin/Release/net6.0/StardewAgentBridge.dll 'E:\games\steamapps\common\Stardew Valley'
```

## 覆盖边界

原生章节使用有身份保护的独立存档、独立 Mod、随机端口和独立后端数据库；实际调用原版路径、好感、动物、保存和读档。日期、NPC 日程和关系由夹具控制，不能据此声称覆盖所有自然日程、全部第三方地图或真实多人。入口快走依旧最高临时步速 4，只争取准时；玩家一直同图或临近约定才让 NPC 出发时仍可能迟到。正常安装和原存档均保留。
