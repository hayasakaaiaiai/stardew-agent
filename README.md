# 星露谷 NPC Agent

让星露谷物语里的 34 位社交 NPC 自由聊天，记住你们的经历，并在游戏中赴约、帮忙和一起行动。后端使用 Node.js / TypeScript 和可配置的云端模型，SMAPI / C# Mod 复用原版界面。

当前为单人开发版本。Windows 已执行分批游戏脚本验收；自由模型仍有漏约和编造细节的问题，详见 [项目现状](docs/status.md) 与 [真实游戏报告](docs/test-results/2026-10-24-real-meetings-game.md)。

## 已实现

- 原版 NPC 台词之后选择“继续聊”，支持三个选项和自己输入中文。
- 独立 NPC 记忆、中文检索、跨天保存、不保存回滚、后端恢复和旧档分叉。
- 好感变化、原版送礼记忆、NPC 赠礼、寄信、头顶气泡和在场／后台传话。
- 原版日程与节日事实、主动靠近、今天至后天的约定、改约、取消和赴约好感。
- 农场作物及动物帮忙、陪下矿与救援、碰面后一起逛、NPC 主动邀约。
- 三条共同目标：莉亚的浮木、威利的鲶鱼、玛鲁的铜锭；明确交付、后续活动、感谢信及两种结局。
- 真实相处事件带来的心情与信任、失约后的道歉和行动修复、原版好友之间有来源的当面分享。
- 森林散步、一起采集、陪钓鱼、一起做饭、配偶散步、家庭晚餐。
- 12 位原版恋爱角色的双向约会：共同选地点、时间与相处方式，真实同行完成后选择回忆重点、回看和重访；每人有独立邀请及地点建议。
- 小镇调查和长期目标：格斯的真实包裹调查／归还、潘妮的观察题、艾利欧特的短文。两条项目可独立推进，实地观察和明确建议会影响可阅读的成品。
- 七位 NPC 的三章节长期目标：至少六个实际工作日，16 个观察章节、5 个真实材料章节；分章选择影响完整稿页，最终合成可以反复阅读的作品。
- 合册后的成果实践：安全近处提醒、七种实地路线或真实钓鱼／采集、明确完成的回执、次日回访与可重读批注。
- 四条新调查：卡洛琳的路线起点、克林特的矿石标签、艾芙琳的跨日记录、玛妮的见面场景。每案两份当面证词、两项真实核验、个人笔记和两种完整结案。

生活功能本轮已完成代码与离线检查，尚未运行游戏验收；详见 [完整 spec](docs/npc-life-spec.md)、[验证报告](docs/test-results/2026-11-09-npc-life.md) 和 [全量游戏测试清单](docs/npc-life-game-checklist.md)。

成果实践验收版 `codex/npc-project-practice / a1389a4` 已按用户要求推送，包含此前生活、恋爱、小镇故事、七人长期目标和成果实践；Windows 按 [实践清单](docs/npc-project-practice-game-checklist.md) 验收，技术记录见 [实践报告](docs/test-results/2026-11-09-npc-project-practice.md)。本分支 `codex/npc-town-cases` 已完成四条调查扩展（功能提交 `117ee3d`），按用户授权交付 Windows 验收，见 [调查 spec](docs/npc-town-cases-spec.md)、[验证报告](docs/test-results/2026-11-09-npc-town-cases.md) 和 [四案游戏清单](docs/npc-town-cases-game-checklist.md)。新功能均未做真人游戏验收，未合并 main；此前各阶段证据与清单见 [项目现状](docs/status.md)。

H 线硬件陪伴保留在 `hardware-companion`，尚未纳入 main。

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

生活功能需要同时更新后端和 Mod，默认开关为 `SharedGoals`、`LifeActivities`、`LifeSocial`。原版台词后选择“浮木的事／材料与共同目标”或“一起做点事”；同步完成后才开放新动作。共同目标首接取需 8 心且非配偶；独立活动需 8 心或配偶／室友，部分活动还有地点、时段和角色条件，详见游戏清单。普通约定与生活活动共用每天 3 次启动额度，正常取消不算失约。

恋爱功能默认开关为 `Romance`，实际出发还需要 `NpcMeetings` 和 `MeetingsGoTogether`。只有原版恋爱、订婚或结婚关系出现新约会入口；8 心朋友和室友不算恋人。原版台词后选“我们的约会与回忆”，或回应 NPC 的邀请；约定当天准时到对方身边选择出发，到选定地图后近距相处满 30 游戏分钟再结束。出发窗口为约定时刻至其后 60 分钟；未出发可改约、取消。完整安装 Mod 时须保留 `assets/romance-profiles.json`。

小镇故事默认开关为 `TownStories`，调查键 `StoryInvestigationKey` 默认 F8。与格斯、潘妮或艾利欧特交谈后选“镇上的事”开始，艾米丽和皮埃尔提供各自掌握的证词。按 F8 实地搜索或记录观察，回到主人公身边明确汇报或给建议；背包里的故事包裹需要当面归还。两条长期目标在不同工作日、原版空闲地点各完成 30 分钟有效工作后产生成品，不参与也会推进。完整安装保留 `assets/town-stories.json`，后端和 Mod 同时更新；关闭开关仍保留现有进度、成品及包裹归还入口。

长线扩展默认开关为 `LongGoals`，在潘妮、艾利欧特、莉亚、玛鲁、罗宾、威利或莱纳斯的“长期打算”中开始。潘妮和艾利欧特须先完成各自前作，次日再开启续篇。F8 同时列出当前章节观察；材料章节在本人面前明确交齐并消耗，独立于送礼。每章两轮不同日的实际工作各 30 分钟，最快六个工作日完成三章；不提供贡献仍会推进。每章有两种可选方向和默认稿页，完成后可回看章节及最终合册。安装保留 `assets/long-goals.json`，后端和 Mod 一起更新；含长线记录的存档需要本版 Mod 和支持长线的后端。

成果实践默认开关 `ProjectPractice`。合册完成后，在本人“长期打算 → 成果实践与回访”选择计划；需要8心或配偶／室友，9–19点开始，与普通约定和活动共用每天3次额度。到指定场所真实同行，在角色身边交谈可记录位置、完成或取消；威利要求真实钓获，莱纳斯要求真实采集。全部记录点与时长满足后，必须明确选收尾才完成，次日可回访一次；取消可重试，成功完成不可重复。已有回执可分页重读并查看来源合册。完整安装保留 `assets/goal-results.json`，后端和Mod配套更新；首条实践或提醒记录使生活存档至少为3（已有4不降级），旧版会保留原记录并拒绝写入。

调查扩展默认开关 `TownCases`，独立于 `TownStories`。与卡洛琳、克林特、艾芙琳或玛妮交谈后选“镇上的事”明确开案；两位证人分别当面询问，按 F8 在指定地点正常观察完整 10 游戏分钟后核验。矿石只查看真实背包、不消耗；艾芙琳复查须更后游戏日，相同天气也可；玛妮必须本人同图、清醒可见且在八格内。回看个人笔记不自动汇报，明确汇报或最终结案才让本人知道现场。无心数门槛、期限或奖励，不占同行次数。关闭开关保留阅读。安装需保留 `assets/town-cases.json`；首条调查记录升级生活存档至 4，须后端与 Mod 配套更新。

## 无游戏、无密钥验证

```powershell
npm test
npm run typecheck
npm run build
npm run demo
npm run demo:built
npm audit
node tools/check-repository.ts
dotnet run --project tests/life-flow
dotnet run --project tests/life-activity-rules
dotnet run --project tests/romance-rules
dotnet run --project tests/town-story-rules
dotnet run --project tests/long-goal-rules
dotnet run --project tests/goal-result-rules
dotnet run --project tests/town-case-rules
```

离线测试不联网、不调用真实模型、不操作游戏存档；demo 使用临时数据库并在退出时清理。`demo:built` 需要先构建。`node:sqlite` 在 Node 24 上会显示实验性提示。

有游戏和模型配置时，可运行 [完整约定验收入口](tools/test-game-real-meetings.ps1)：`-Section edges` 执行固定反例，`-Section live` 使用收费的真实模型。脚本使用独立存档副本、Mod 和数据库，并比较原档 SHA256；执行前先退出正在运行的游戏。真实游戏最近七项中 4 项完整通过，另 3 项失败仍保留，不能把技术断言通过当作内容全部正确。

## 文档和资料

- [项目现状与文档索引](docs/status.md)：当前功能、分支、已知问题、测试证据。
- [记忆内核 API](docs/memory-kernel.md)：原 README 中的接口、保存回滚和恢复说明。
- [游戏桥接](docs/game-bridge.md)：Mod 原版界面、消息协议、配置和手测记录。
- [全仓审查报告](docs/test-results/2026-10-24-repository-audit.md)：本轮修复、验证及合并清理记录。
- [角色卡模板](data/npcs/_template.md) 与 [参考资料说明](reference/README.md)：角色事实来源、Wiki 署名和许可。示例台词按原版语气新写。

仓库不分发游戏导出文本、游戏程序集、存档、数据库或本地模型调用记录。`reference/wiki/` 保留来源页面、revision 和原许可说明；`reference/game/` 仅用于本地核对，已忽略。测试报告中的 `.runtime/` 路径是本地证据位置，公开仓库保留报告和复现脚本。
