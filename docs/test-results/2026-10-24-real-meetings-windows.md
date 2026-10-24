# 约定线真实模型的 Windows 复核

2026-10-24 按用户“看新提交，之后开始测”下载 `m2c-real-meetings / f6d725f`，检查 `main / df8273c` 之后的六个提交。在本地 `codex/real-meetings-windows-tests` 工作，已包含此前 Windows 的十类修复，基于最新 main，无需重放旧分支提交。

本轮先完成自动检查，再用真实模型重新跑 D 批，另外补完整后端反例。用户看过反例后选择：先修四类错记／误取消风险，含蓄答应的漏记另列、暂不放宽。生产改动只在 `src/agent/meeting-agreement.ts`，没有修改记忆内核或 prompt。

## 1. 复现和修复

以下五个完整后端反例在修复前全部失败，修复后全部通过。使用固定模型回复、真实 `BridgeServer` 和 WebSocket 模拟 Mod，断言后端实际发出的 `day.meetings`。

| 类别 | 原话和修复前结果 | 修复后 |
|---|---|---|
| 相对改时不一致：主动邀约 | NPC 约今天 14:00 博物馆；玩家“晚一个小时”；NPC 答“下午四点博物馆见”。原来记录 16:00 | 按原钟点算出玩家提出的是 15:00，两边不一致，不新建约定；玩家重复地点时也检查 |
| 相对改时不一致：已有约定 | 原约 14:00 海滩；玩家“往后推一个小时”；NPC 答 17:00。原来改到 17:00 | 保留原约 14:00；回复 15:00 或没有另说钟点时，正常改到 15:00 |
| 上午与晚上冲突 | 原邀约 20:00 海滩；玩家“改到上午八点”；NPC 仍说晚上八点。原来只核对十二小时制数字，记录 20:00 | 明确时段及 `08:00` 按完整钟点核对，不新建冲突约定；“改到 08:00，我下午有事”中的无关时段也不能改变明确钟点 |
| 否定里的肯定词 | 玩家约 14:00 海滩；NPC“这不算好主意”。原来把“好主意”当答应 | 不建约；“我未答应你”“我没有答应你”也不算答应，肯定原话照常识别 |
| 取消别的活动却撤销见面 | 原约 14:00 海滩；玩家“今天我不去吃了，下午两点海边照常见”。原来发 `calledOff: true` | 保留见面；“下午照常见”“海边的约不变”也保留，真正“不去喝了、你别等我”仍能取消 |

同样的原话用 `origin/main` 的旧核对函数作对照，没有上述新增误建／误改／误取消；原始结果保留在 `.runtime/real-meetings-review-probes.json`。这是受控反例，不是新的真实模型发生率。

正式回归新增九项：四项原话解析测试、五项完整后端测试。修复前九项全部失败，修复后九项全部通过；原有真实原话测试也通过。没有把失败测试标跳过或改成接受错误结果。

## 2. 自动检查

| 检查 | 结果 | 证据 |
|---|---|---|
| 初始 `npm test` | 290/290 | `.runtime/real-meetings-initial-tests.log` |
| 修复前新增回归 | 新增 0/9；含原有定向测试共 11/20 | `.runtime/real-meetings-new-regressions-before.log` |
| 修复后定向回归 | 20/20 | `.runtime/real-meetings-new-regressions-after.log` |
| 最终 `npm test` | **299/299**，19.42 秒，0 失败／跳过 | `.runtime/real-meetings-final-tests.log` |
| `npm run typecheck`、`npm run build` | 通过 | `.runtime/real-meetings-final-typecheck.log`、`real-meetings-final-build.log` |
| Mod Release 编译 | **0 警告、0 错误**，`EnableModDeploy=false` | `.runtime/real-meetings-mod-build.log` |
| 编译后 C# 流程检查 | **54/54** | `.runtime/real-meetings-mod-flow.log` |

C# 流程检查加载本机原版程序集，但没有启动游戏。此次未修改 Mod 源码，编译与 54 项结果适用于最终代码。Node 仍提示 SQLite 为实验功能；npm 另有本机 `store-dir` 环境配置警告，均未导致检查失败。

## 3. 新的真实模型样本

使用 `deepseek-flash`、`high`，真实后端配合模拟 Mod，重新跑已有 D 批场景。**不是新写的留出场景，也不是游戏内验证。**需要已有约定的铺垫用固定回复，其余对话和夜间整合用真实模型。

先只读本轮 `transcripts.md`，写本轮自己的 `labels.json`，再看代码结果；没有拿旧批次的标签直接评价新回复。

| 类别 | 段数 | 对 | 漏记 | 错记／未改约 |
|---|---:|---:|---:|---:|
| 主动邀约 | 4 | 4 | 0 | 0 |
| 改约 | 4 | 3 | 0 | 1 |
| 当天约 | 3 | 1 | 2 | 0 |
| 明天、后天、更远 | 3 | 3 | 0 | 0 |
| 取消 | 3 | 3 | 0 | 0 |
| 节日、生日 | 3 | 2 | 1 | 0 |
| **合计** | **20** | **16** | **3** | **1** |

链路错误 0，不能据此把内容算成 20/20。保留的四段：

- `D-change-harvey-late`：原约 17:00，玩家要求 21:00，哈维“九点……可以是可以，不过晚上别熬太晚”。代码没有识别“可以是可以”为确认，仍保留 17:00。比较表记为错记，实际是没有应用改约；不是本轮新增假约。
- `D-today-emily-saloon`：“七点正忙得来劲，你来了我给你留靠吧台的位置”，人读原话算答应，代码漏记。
- `D-today-alex-now`：“扔球？嘿，这个我来劲了”，人读原话算愿意马上去，代码漏记。
- `D-fest-emily-ice`：“当然去啦……光想想就觉得……”，无关的“想想”仍被保守拒绝词拦下，节日约定漏记。

这四段涉及原有确认词和拒绝词范围，按用户选择暂不放宽。太远的“四天后”正确婉拒，没有误记为马上去；取消、条件句、晚到、生日和另外两类节日均与原话对得上。

原始目录：`.runtime/real-meetings-D-2026-10-24T09-21-10-351Z/`。调用共 **43 次**：对话 40、夜间 3；输入 **78,248**（命中缓存 **68,348**），输出 **8,855**（其中推理 **5,028**）。本机证据汇总为 `.runtime/real-meetings-windows-summary.json`。

修复后离线重放同一批全部 20 段：0 链路错误，每次 prompt 都经过原样相等检查；约定、铺垫结果、错误列表与修复前逐段相同，仍为 16/20。最终重放目录 `.runtime/real-meetings-replay-D-2026-10-24T09-37-58-767Z/`。重放不调用真实模型，文件中的 usage 是原调用数据，不能重复计费。

四类修复没有修改 prompt，正常输入 token 增量 **0**，新增模型调用 **0**。不能把这批重放说成新的留出验证，也不能据此保证所有自然语言都识别正确。

## 4. 重跑

```powershell
npm test
npm run typecheck
npm run build
node --test tests/real-meetings.test.ts tests/real-meetings-windows.test.ts
dotnet build mod/StardewAgentBridge/StardewAgentBridge.csproj -c Release '-p:GamePath=E:\games\steamapps\common\Stardew Valley' -p:EnableModDeploy=false
dotnet run --project tests/mod-flow/ModFlowChecks.csproj -- mod/StardewAgentBridge/bin/Release/net6.0/StardewAgentBridge.dll 'E:\games\steamapps\common\Stardew Valley'

# 真实模型，会产生调用；新回复要重新标注，不能沿用上次标签。
node tools/test-meetings-real.ts --batch D --jobs 4

# 本机已有记录的免费重放；比较前复制原批次的本轮 labels.json 到新重放目录。
node tools/test-meetings-real.ts --replay .runtime/real-meetings-D-2026-10-24T09-21-10-351Z --batch D --jobs 4
node tools/test-meetings-real.ts --compare <本次输出目录>
```

本轮未启动游戏、未操作真实存档。测试后端使用临时数据库、随机空闲端口，关闭后清理自己的临时目录。常驻后端与正式 Mod 没有部署。正式安装 DLL 收尾哈希为 `9C9D9EFEF9CF72529FDE5345DB7717A7675D8EEDADADD6D6DFFCBAD6389B128D`；本次编译产物为 `ECD4A82A499F10F4AE973BDB6B01A501C69B27283AA4384FCF66CDC86BF79D50`，两者不要混为一份已安装产物。

## 5. 留给用户的游戏内清单

按 `AGENTS.md`，游戏内验证由用户完成。使用独立存档和独立测试后端，对话与夜间保持真实模型 `high`，具体步骤见 [`real-model-meetings.md` §8](../real-model-meetings.md#8-windows-清单真实模型游戏里)。目前以下七项均**待用户验证**：

- [ ] 当天约 14:00 墓地：核对原话、HUD、实际到场、碰面以及次日记忆。
- [ ] 明天 10:00 博物馆：睡觉后确认夜间约定与到场。
- [ ] NPC 主动邀约，玩家要求晚一个小时：核对双方新钟点、HUD 和到场。
- [ ] 已约 14:00 海滩后改到 15:00：确认改约提示和实际执行。
- [ ] 明确取消当天约：确认取消提示、不再赴约、不误扣好感、次日知道是取消。
- [ ] “四天后去海边”：确认婉拒、没有约定提示、不马上赴约。
- [ ] 春季 23 日约次日花舞节：确认地点和日期正确、节日中碰面不误扣好感。

新修的冲突和否定原话由固定回复的完整后端测试覆盖。自由模型未产生相同冲突时，普通游戏流程通过也不能算这些边界在游戏里都测到了。全 NPC、自然日程长时运行、多人和全部剧情没有新增覆盖。

本轮修复 `bd88dec` 随后按用户授权，与游戏脚本 `4526ad0` 一起推送到 `codex/real-meetings-windows-tests`，未合入 main。推送后 fetch 未发现其他新分支或新提交；游戏内的实际执行结果及三个未解决内容问题见 [游戏脚本报告](2026-10-24-real-meetings-game.md)。
