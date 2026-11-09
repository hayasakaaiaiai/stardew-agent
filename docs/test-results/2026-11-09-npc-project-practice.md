# 成果实践与回访离线验证

日期：2026-11-09。工作树 `/Users/a11/Documents/ChatGPT/stardew-agent-project-practice`，分支 `codex/npc-project-practice`，基于已推送的长期目标验收提交 `80bdaf4`。设计见 [spec](../npc-project-practice-spec.md)，人工入口见 [Windows 清单](../npc-project-practice-game-checklist.md)。

## 1. 交付内容

七本真实合册各有一次可实际完成的共同实践：潘妮两地提问、艾利欧特沿岸停读、莉亚三个观看位置、玛鲁两条记录、罗宾往返路线、威利实际垂钓、莱纳斯实际采集。七套共 14 个记录点、70 条明确选择正文；原版菜单显示所选正文，并能回读本存档实际合册与章节。完成后最早次日可明确回访一次。

完成章节会在安全近处用原版气泡提醒，全局每天最多一次，只提醒最新已完成章。提醒不视为已读，不自动启动实践。实践仍需 8 心或配偶／室友、9–19 点开始，共用每天 3 次活动额度；不增加物品、地图变化、好感或恋爱奖励。自动超时、日终及中断只取消，必须由玩家明确收尾才完成。

新域用 `goalresult.*`、`resultsProtocol:1` 与 `log.goalResultState`；生活存档首条新事件升级 3，接受旧版 1／2。写失败恢复版本、序号和原状态；旧后端遇已有新记录停止混合同步。新记录使用 projectId，避免被原长期目标重放器误收。

## 2. 已执行检查

环境：macOS、Node **24.18.0**、.NET SDK **8.0.426**；不增加依赖。下面命令均在本工作树执行。

| 检查 | 结果 |
|---|---|
| `npm test` | 最终 **512/512**，36.5 秒，0 失败／跳过；463 既有项＋32 纯投影＋13 桥接＋4 内容 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `npm run demo` / `npm run demo:built` | 两者通过；34 NPC 加载、中文记忆、保存／回滚／重启断言完整 |
| 新实践纯投影 | 32/32；覆盖 112 条完整 a/b 组合路线与拒绝路径 |
| 新 WebSocket／SQLite 集成 | 13/13 |
| 新内容检查 | 4/4；7 套／14 点／70 文案、作者依据、安全文本与 Mod 资产接线 |
| 独立 C# | **506/506**：旧 44＋29＋44＋50＋191，新成果实践 148 |
| Mod Release | 通过；**0 警告、0 错误**，4.79 秒，EnableModDeploy=false |
| 仓库检查／`git diff --check` | 通过；无未发布链接、密钥或版权游戏导出问题 |

最终 Node 日志：`/private/tmp/stardew-result-final.log`（首轮为 `/private/tmp/stardew-result-full.log`），定向桥接日志：`/private/tmp/stardew-result-bridge.log`。原生各套与编译日志位于本地 `.runtime/verification-project-practice/`，不提交运行产物。源 JSON 与 Release 资产 SHA-256 相同：`2a54564a55a4d639a8a641591510418bb47bba866d9ee20b8e93c3abcb20fb1e`。

复现原生检查：

```sh
/Users/a11/.dotnet/dotnet run --project tests/life-flow
/Users/a11/.dotnet/dotnet run --project tests/life-activity-rules
/Users/a11/.dotnet/dotnet run --project tests/romance-rules
/Users/a11/.dotnet/dotnet run --project tests/town-story-rules
/Users/a11/.dotnet/dotnet run --project tests/long-goal-rules
/Users/a11/.dotnet/dotnet run --project tests/goal-result-rules
/Users/a11/.dotnet/dotnet build mod/StardewAgentBridge -c Release '-p:GamePath=/Users/a11/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS' -p:EnableModDeploy=false
```

## 3. 核验的边界

- 合册与实践同批同步可按真实来源解锁；不完整路线会让整批原子拒绝，不留下旧生活或长线的半批状态。
- 同 owner、同项目、同尝试、同日、真实路线／时长／动作数量均检查；点位之间的累计分钟不得超过游戏钟差。莱纳斯选择 b 时要求本次总量至少两件。
- 取消后新尝试不能引用旧点。后端保留当前尝试和通知凭据，100 次取消重试仍有界；旧尝试只有先通过全局事件签名一致性检查才能略过重放，未知旧 ID 与改写内容会被拒绝。
- 保存／后端重启后可继续次日回访；未保存完成能回滚，并允许兄弟存档使用相同序号形成另一种真实选择。迟到的夜间印象不会被实践投影覆盖。
- 完成只产生主人公私有事实，不能当作普通活动八卦传播；提醒没有新共同经历记忆，另一 NPC 的摘要中没有该实践。
- 原生复用已有跟随、跨图、结束和日程恢复；目标地图之外的鱼获／采集不会计数，菜单、暂停或不完整钟步不加时。通用活动退出不产生 practice completed，也不进入旧活动好感或恋爱结算。
- 存档版本 3 后继续写原 longgoal 事件不会退回 2。完成页与回访页按真实日志和选中正文重建核对，不能只用非空字符串蒙混来源。

开发中补齐了三个交叉核验发现：时间增量与钟点差一致、配偶 ignoreScheduleToday 仅作为日程标记时不误挡启动／提醒、倒序通知在 TS 和 C# 均按更早事件序号判断最新章。正常睡眠、移动、剧情和控制器占用仍会阻止抢占角色。

## 4. 实际 prompt 成本

[逐项数据与源码哈希](2026-11-09-goal-results-prompt.json) 由生产 `buildMessages`、34 张真实角色卡、七项目共 **84 场景**生成，含 **43 份源文件哈希**。使用外置 `gpt-tokenizer` 的 o200k_base，本地近似 DeepSeek 成本，没有调用模型。

- 28 个无实践、仅通知或其他 NPC 场景：增量 **0**。
- 56 个真实开始／记录点／完成／取消／重试／回访场景：增量 **51–97 token**。
- 对照把完整菜单规则另附到当前摘要：还会增加 **529–766 token**。生产只保留当前阶段短摘要。

计量是 messages 内容的分词差值，不含 API 封装、输出、对话历史或检索记忆增长；不能将摘要增量当作整次调用成本。实现前的威利原型 48／137 token 仅用于方向选择，最终数值以上述生产样本为准。

```sh
node tools/measure-goal-results-prompt.ts /private/tmp/stardew-feature-cost.aBgMTy/node_modules/gpt-tokenizer/esm/encoding/o200k_base.js docs/test-results/2026-11-09-goal-results-prompt.json
```

## 5. 交付与未验证部分

此前长期目标版本已按用户要求推送至 `codex/npc-long-goals / 80bdaf4`，可在 Windows 验收。本轮单独本地提交，尚未推送、不合入 main，H 线未改。

本轮没有部署 DLL、启动游戏或调用真实模型；原版菜单排版、自然跟随／日程、真实钓鱼采集与不同分辨率下的游戏操作仍由用户验收。新增清单 **83 个编号／90 个结果格**全部留空。C# 规则检查和 Release 编译不等于真实游戏测试，也不复用历史 mod-flow 游戏程序集测试的通过数。
