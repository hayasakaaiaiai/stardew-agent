# 恋爱三功能离线验证

日期：2026-11-09。分支：`codex/npc-romance`，起点 `d7b11a3`。环境：macOS、Node 24.18.0、本机 .NET SDK、合法安装的 Stardew Valley 游戏引用。实现范围为 [spec](../npc-romance-spec.md) 中的双向约会、共同回忆、12 人角色差异；关系公开、纪念日奖励与独立情侣矛盾剧情不在本轮。

## 1. 实现与验证范围

- 12 人共用一份原创配置，Mod 包含同源 JSON。只认可原版恋爱／订婚／结婚；朋友与室友无恋爱入口。
- 明确计划、改约、取消、真实出发、目标地图有效相处与完成；NPC 邀请按角色 3 天、全局每天一次冷却。到场之前不累计约会完成时间。
- 真实完成后选地点／天气／相伴时间为回忆重点，回看与引用旧来源重访；首次单独保留，近期档案有界，记忆保持私密。
- 新事件复用持久生活日志和存档桥接，独立 `log.romanceState` 投影不覆盖整体 NPC state。混合批次全量校验后原子写入，生活与恋爱共用实际好感预算。
- 全程未使用真实模型、未启动游戏、未部署常用 Mod、未改真实存档。下述通过仅覆盖各自测试范围。

## 2. 自动检查结果

| 检查 | 本轮结果 | 覆盖内容 |
|---|---|---|
| `npm test` | 374/374，0 失败、0 跳过 | 既有 337 项与新增 37 项；无真实模型调用 |
| `tests/romance.test.ts` | 24/24，包含在上项 | 12 人各自状态流、严格字段、原版关系、日期／时刻／地点、来源与重访、重复保护、分支隔离、24 条保留、历史关系与当前提示 |
| `tests/romance-bridge.test.ts` | 10/10，包含在上项 | 混合顺序与原子回滚、私密来源、同步门禁、后端重启、保存与未保存分叉、旧 nonce、好感共享预算、晚到夜间印象 |
| `tests/romance-content.test.ts` | 3/3，包含在上项 | 12 人与本地引用文件、原生名单／地图一致、构建复制路径 |
| `npm run typecheck` | 通过 | TypeScript 严格类型检查 |
| `npm run build` | 通过 | 编译 JavaScript；构建后 romance 模块可读取同源 12 人配置 |
| `npm run demo` / `npm run demo:built` | 均通过 | 34 NPC、中文检索、私密隔离、未保存回滚、重启恢复 |
| `dotnet run --project tests/romance-rules` | 44/44 | 生产纯规则：关系、出发窗口、目标地图、真实钟步、回邀冷却、首次及近期来源、wire 序列化、旧后端门禁、私密活动与旧菜单生命周期 |
| `dotnet run --project tests/life-flow` | 44/44 | 既有生活目标、交付、同步规则回归 |
| `dotnet run --project tests/life-activity-rules` | 29/29 | 既有活动、计时、关系修复与释放控制规则回归 |
| Mod Release、`EnableModDeploy=false` | 通过 | 真实游戏 API 引用编译；0 警告、0 错误；未部署 |
| `node tools/check-repository.ts` / `git diff --check` | 通过 | 文档链接、锁定依赖、公开文件与格式检查 |

纯 C# 合计 **117 项**，不依赖运行中的游戏。新增规则测试不能代替原版菜单与完整控制器运行。旧 `tests/mod-flow` 在此前本机检查时因 Mac 游戏程序集加载失败，仍不宣称历史 Windows 54/54 已在本轮重新通过。

主要复现命令在仓库根目录执行：

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run demo
npm run demo:built
dotnet run --project tests/life-flow
dotnet run --project tests/life-activity-rules
dotnet run --project tests/romance-rules
node tools/check-repository.ts
git diff --check
```

本机 Mod 编译命令（其他机器更换 SDK 与游戏路径）：

```sh
/Users/a11/.dotnet/dotnet build mod/StardewAgentBridge -c Release \
  '-p:GamePath=/Users/a11/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS' \
  -p:EnableModDeploy=false
```

## 3. 本轮发现并修复的边界

1. **回滚测试夹具与人物地点不符**：首次桥接检查 9/10，失败是夹具把莉亚地点写成未提供的 Town；严格校验正确拒绝。按实际配置改为 Beach，定向重跑通过，后续全仓 374/374。没有放宽人物地点校验来迁就测试。
2. **只有旧计划、没有完成的分手情形**：初次上下文测试 22/24。已改为明确旧安排属于过去；不能以高心数、室友状态或检索到旧计划继续当前恋爱。未收到取消事件的跨日过期计划也给出明确边界。修复后 24/24。
3. **准备方式出发后丢失**：已把 quiet／talk 意图保留在进行中摘要；两种断言通过。它表示计划中的相处方式，不能推断已谈心或生成拍照、演奏等事实。
4. **地图描述过度具体**：整张 Mountain 计时不足以证明在湖边；后端与原生统一为“山间”，并补规则检查。
5. **本机游戏 API 不存在**：最初 Release 编译暴露 `getAllCharacters` 不可用；改用仓库已有角色名查找方式，最终 Release 通过。
6. **旧后端能力握手顺序**：既覆盖读档后 hello，也覆盖 hello 后读档；带恋爱历史必须升级两端，不能跳过不兼容日志。普通旧生活记录保持兼容。
7. **关系变化与退出恢复**：完成前重新核对关系；写入失败回退好感并释放控制。回程恢复配偶住处时也核对当前原版关系，不沿用出发时已失效的身份。
8. **日志满时的确认体验**：停止新增 NPC 回邀，计划与最终确认检查容量并明确提示，保留过去记录与现有活动退出路径。

两位实现者与一位独立只读复核者交叉核对了 TypeScript 契约、C# 字段、菜单回调、保存与退出路径。人工代码复核不替代自动检查或真人游戏结果。

## 4. Prompt 成本

使用仓库外 `gpt-tokenizer@3.4.0` 的 `o200k_base` 编码，不增加项目依赖。直接调用生产 `romanceChanges`、`romanceContext`、`buildMessages`，载入 34 张现有角色卡，固定莉亚场景，检索和对话历史为空；按相同当前关系重建基线。完整输入与源文件 SHA256 保存在 [分词 JSON](2026-11-09-romance-prompt.json)。

恋爱关系基线 **1897 token**；12 个场景的当前摘要增加 **0–125 token**。全部 12 人配置额外常驻会再加 **1757 token**，正式实现未采用。记忆检索增长、供应商消息封装和输出不包含在内；这些数字是 DeepSeek 分词近似，不是 API 账单或模型准确率。

| 场景 | 相同关系基线上的增量 |
|---|---:|
| 无记录 | 0 |
| 已确认计划／改约 | 65／67 |
| 出发后保留相处方式 | 74 |
| 实际完成／选回忆重点 | 87／96 |
| 朋友或室友的旧完成／仅旧计划 | 45 |
| 已确认重访计划 | 125 |
| 过期计划尚无完成 | 70 |

复现时将 tokenizer 模块地址作为脚本参数传入，具体用法见 `tools/measure-romance-prompt.ts`。没有为本轮调用收费模型。

## 5. Windows 仍需验证

使用 [全量游戏清单](../npc-romance-game-checklist.md) 验证所有 12 人菜单与语气、双向邀请、实际跟随及计时、准备方式在真实聊天中的表现、共同回忆／重访、关系变化、关闭功能、离线结束、保存回滚与旧生活功能。所有游戏项均为待用户执行。

`codex/npc-shared-goals` 远端仍为 `d7b11a3`，`main` 为 `789b911`；本轮新分支不自动推送、不合入 main。更新 Windows 时同时更新后端与含 assets 的完整 Mod，不删除 `.runtime/game/`。
