# 四条小镇调查离线验证

日期：2026-11-09。工作树 `/Users/a11/Documents/ChatGPT/stardew-agent-town-cases`，分支 `codex/npc-town-cases`，基于成果实践验收提交 `a1389a4`。该前版已按用户要求推送至 `origin/codex/npc-project-practice`；本轮扩展本地提交，尚未推送、未合并 main。设计见 [spec](../npc-town-cases-spec.md)，内容与原版依据见 [内容目录](../npc-town-cases-content.md)。

## 1. 完成交付

新增卡洛琳路线起点、克林特矿石标签、艾芙琳跨日记录、玛妮见面场景四案；共11位实际参与居民、8份证词、8项现场和8篇完整原创结案。每篇结案158–167汉字。旧三故事保留，现在共七故事、十六种结局；此前七人长期目标、成果实践和其余生活功能保留。

每案明确开案，采访两位指定证人，再完成两次真实核验。四份来源齐全后，选择a／b两种处理方案之一。现场分别验证两端位置、背包一份真实矿石、更后游戏日的原来源、玛妮本人实际近处在场。矿石不消耗，室内不填写外部天气，相同天气也能完成跨日复查。无额外物品、金钱、好感奖励或期限；不创建约定、不控制NPC，不占同行次数。

个人笔记能回读原文和真实来源；阅读不算汇报。只有明确汇报或结案时主人公才知道现场。证人只知道自己讲过的内容，不自动知道其他证词或结局。结案页保存所选全文，可随时回读。关闭TownCases停止新推进、保留已有阅读；关闭旧TownStories不关闭新案入口。

新增story.inspected，复用五域事务中的story日志和版本1投影；新增casesProtocol:1，旧storiesProtocol:1不变。原生独立LifeSave.Cases，首条新案记录成功后升级生活存档4；接受1–4，旧域后续事件不降级。缺新能力且已有新案历史时阻止整个混合同步及聊天，原记录保留。记忆内核、依赖和H线未改。

## 2. 已执行检查

环境：macOS、Node24.18.0、.NET SDK8.0.426。全仓Node与原生编译串行执行，未部署或启动游戏。

| 检查 | 实际结果 |
|---|---|
| `npm test` | **555/555**，25.19秒，0失败、跳过或取消；512既有项＋25纯投影＋14桥接＋4内容 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `npm run demo` / `npm run demo:built` | 两者通过：34NPC加载，中文召回，保存、回滚、重启断言完整 |
| 新调查定向组合 | **43/43**；与全仓中的同一组检查，不重复计入总数 |
| 独立C# | **743/743**：原6套44＋29＋44＋50＋191＋148，新调查237 |
| Mod Release | 通过，0警告、0错误，3.70秒，EnableModDeploy=false；含最后的实际位置门禁 |
| 内容与共享资产 | 四案、八全文、角色资料路径、安全文本、共享JSON接线通过；源JSON与Release资产SHA256相同 |
| 仓库检查与diff检查 | 文档引用、忽略规则、敏感内容及`git diff --check`通过 |

全仓日志 `/private/tmp/stardew-cases-full.log`；新调查定向日志 `/private/tmp/stardew-cases-targeted.log`。原生各套、Release及资产日志在 `.runtime/verification-town-cases/`。源码与输出资产SHA256：`205af566872c80d32f25821de70479094fc6a39e111c9b6f3cf197dab0d274d8`。本地运行产物不提交。

```sh
npm test
npm run typecheck
npm run build
npm run demo
npm run demo:built
node tools/check-repository.ts
/Users/a11/.dotnet/dotnet run --project tests/life-flow
/Users/a11/.dotnet/dotnet run --project tests/life-activity-rules
/Users/a11/.dotnet/dotnet run --project tests/romance-rules
/Users/a11/.dotnet/dotnet run --project tests/town-story-rules
/Users/a11/.dotnet/dotnet run --project tests/long-goal-rules
/Users/a11/.dotnet/dotnet run --project tests/goal-result-rules
/Users/a11/.dotnet/dotnet run --project tests/town-case-rules
/Users/a11/.dotnet/dotnet build mod/StardewAgentBridge -c Release '-p:GamePath=/Users/a11/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS' -p:EnableModDeploy=false
```

## 3. 关键覆盖与开发记录

- 严格核对四个固定案ID、owner、两证人、两种现场字段、真实地图／坐标、时间窗和完整来源。不能用矿锭、错误矿石、箱内库存、另一个NPC、同日复查或别案来源替代。两结局都要求全部四份来源，不存在猜对答案绕过调查。
- 未汇报四份来源与刚开案的主人公摘要逐字相同；逐条汇报只添加对应事实；结案一次披露四份来源。证人只获自己的证词，不获得主角结果。乔迪参与两案、皮埃尔同时参与旧包裹和新案均有检查。
- WebSocket／SQLite验证混合五域全成全败、分页重放、重连只记一次、保存／重启、未保存回滚、兄弟存档另一结局、跨域改写同一事件ID拒绝、合法好友关系也不能把私有案件来源当普通八卦。
- 迟到夜间印象与新调查投影独立保存，后续保存不会覆盖印象。首轮这个测试的假模型把每个NPC都写成caroline，触发既有UNKNOWN_NPC隔离检查；改为按实际单NPC输入回传后通过，没有放宽生产隔离。八卦夹具也改为已有的Emily／Sandy好友关系，确保测的是私有来源拒绝。
- 原生完整钟步、菜单暂停、开菜单后保留已满10分钟候选、离开／换日／读档清零、样品确认复核、本人清醒可见和实际时窗均有纯规则覆盖。第一次部分区间不冒充完整10分钟。最终presence还并用既有LifeNear检查实际浮点距离和同一地点对象，避免整数格点取整掩盖略超八格；此游戏对象检查经编译与代码核对，实际移动边界留给Windows验收。
- 保存缓存依完整事件重放校验，包括四来源、汇报集合、结局标题和全文。旧Story校验只跳过固定四案交新重放器，未知ID仍拒绝。写失败恢复版本、序号及Cases原对象；菜单回调检查加载标识、游戏日、状态身份和现场。
- 原版NPC菜单与共用F8分页同时列出新旧内容；没有新画布或第二套F8处理器。内容交叉核对确认开场、证词、现场要求、结案首次显示和回看均引用共享正文，不只显示标题。

另外尝试了旧 `tests/mod-flow` 反射组合，尚未进入断言就在加载 `Stardew Valley.dll` 时出现FileLoadException（Program.cs:23）。本机arm64 .NET与原版x86-64程序集的环境限制仍保留，日志为 `.runtime/verification-town-cases/mod-flow.log`；未改测试去规避，也未将历史Windows的通过数量计入743。纯规则通过与Release通过不代表该反射组合或游戏已通过。

## 4. 实际prompt成本

[逐项结果](2026-11-09-town-cases-prompt.json) 使用生产storyChanges→storyContext→buildMessages、34张真实角色卡及54场景，记录42份源文件／角色卡SHA256。外置gpt-tokenizer3.4.0、o200k_base作为DeepSeek本地近似，没有新增依赖或调用模型。

- 8个无案件或无关NPC样本：新增**0**。
- 46个开案、汇报、两种结案、证人及多案共存样本：新增**71–380 token**。
- 乔迪两案各自证词合计211；皮埃尔已有旧包裹证词的基线上再增加路线证词为71。
- 附完整案件资料对照再增加**650–1323 token**；含未选结案，不能作为生产配置。完整正文留在菜单，prompt只放实际已知来源和所选结果标题。

这些是messages内容分词差值，不含API封装、输出、历史和检索增长。实装前60／160的原型仅用于方向比较，不能代替此处生产数值。

```sh
node tools/measure-town-cases-prompt.ts /private/tmp/stardew-feature-cost.aBgMTy/node_modules/gpt-tokenizer/esm/encoding/o200k_base.js docs/test-results/2026-11-09-town-cases-prompt.json
```

## 5. Windows验收与交付边界

[游戏清单](../npc-town-cases-game-checklist.md) **87个独立编号／91个结果格**全部留空，覆盖四案八结局、实际计时／样品／本人在场、地图与窗口、分页、开关、隐私、版本4、保存恢复及旧五域回归。需用户实际进游戏测试原版显示、自然日程、真实移动和自由模型回复。

前版成果实践已推送 `codex/npc-project-practice / a1389a4`；四案新增版本地 `codex/npc-town-cases` 完成后等待后续推送指令。不部署DLL、不调用真实模型、不修改正常存档或main；H线仍暂停。
