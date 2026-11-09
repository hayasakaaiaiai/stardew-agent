# 小镇调查事件与 NPC 长期目标：实现与离线验证

日期：2026-11-09。分支 `codex/npc-town-life`，起点 `codex/npc-romance / dc36f8e`。用户选定范围为调查事件与 NPC 长期目标；三条故事、八种结局已实现。没有推送、合并 main、修改 H 线、部署正常 Mod、运行游戏或调用真实模型。

交付补记：用户随后明确要求推送，功能提交 `fcce80c` 已推送。交付复核另外排除了 NPC 睡眠时的工作计时；该项通过 Release 编译，并加入 Windows W05 验收。以下未运行游戏的边界不变。

## 1. 交付范围

- 格斯《错放的备货包裹》：艾米丽／皮埃尔各自的证词，实地搜索，真实带标记任务物件，满包重试、精确归还、两种结局与回看。
- 潘妮《给下一课的观察题》：实地观察、两种可选建议、两个不同工作日、独立或协作完成的三题成品。
- 艾利欧特《一页短文，两种余味》：现场观察、留白／明朗建议、自主工作、三个完整短文版本。
- 共用 `life.sync` 事务及全局事件序号，独立 `log.storyState` 投影；未汇报见闻不进入主人公记忆，证人只知道自己的证词。握手新增 `storiesProtocol:1`。

全部交互复用原版菜单，默认调查键 F8、开关 `TownStories`。作品可在游戏里反复阅读；不新增物品、金钱或好感奖励。项目第一次明确了解后启动，不帮忙没有新增惩罚。具体规则见 [spec](../npc-town-stories-spec.md) 与 [内容依据](../npc-town-stories-content.md)。

## 2. 自动验证

环境为 macOS、Node 24.18.0、本机 .NET SDK 与合法安装游戏的编译引用。依赖沿用锁文件，未增加项目包。

| 检查 | 结果与范围 |
|---|---|
| `npm test` | 416/416；包含新增投影 27、WebSocket／SQLite 11、内容 4，共 42 项故事检查 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `npm run demo`、`npm run demo:built` | 均通过；原有独立 NPC、保存、未保存回滚及后端重启断言 |
| `dotnet run --project tests/life-flow` | 44/44 |
| `dotnet run --project tests/life-activity-rules` | 29/29 |
| `dotnet run --project tests/romance-rules` | 44/44 |
| `dotnet run --project tests/town-story-rules` | 50/50；覆盖计时、来源、任务物件标记、阶段与协议门禁；四套纯 C# 合计 167/167 |
| Mod Release | 0 警告、0 错误；`EnableModDeploy=false` |
| 共享内容和分词来源 | 打包 JSON 与源文件一致；实测 JSON 的 8 份源 SHA256 与当前源码一致 |
| 仓库与差异检查 | `node tools/check-repository.ts` 无问题；`git diff --check` 通过 |

Mod 编译命令（只编译，不部署）：

```sh
/Users/a11/.dotnet/dotnet build mod/StardewAgentBridge -c Release '-p:GamePath=/Users/a11/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS' -p:EnableModDeploy=false
```

新增后端检查覆盖八种结局、未汇报来源、证人隔离、保存知识伪造、错误字段和前置条件、重复内容校验、两工作日、混合事务全部拒绝、同一 NPC 的生活／恋爱／故事共存、部分同步后重连、后端重启、未保存贡献回滚、旧档分叉相同序号、过期 nonce 和晚到夜间印象。公开分享反例使用合法好友 Emily→Sandy，确保拒绝发生在故事来源检查而非好友白名单。

原生规则检查不加载游戏进程。对本机游戏程序集的只读静态核对确认：`questItem` 阻止丢弃和出货，物件资料的 `CanBeGivenAsGift=false` 阻止普通赠礼；实际背包、箱子、商店和菜单表现仍属于 Windows 验收。未提交游戏程序集、导出文本、反编译代码或图像。

## 3. 发现并处理的问题

1. 保存投影中伪造已知来源或角色身份：新增反例先失败，随后严格按权威来源校验保存知识。最终投影及桥接检查通过。
2. 主人公转述证人原话容易混淆第一人称：摘要注明证人姓名及引用关系；证人本人不获得调查后续结局。
3. 提出建议已隐式汇报观察，但原生仍可能再次提供汇报：原生同步登记该来源，失败时只撤销新登记，与后端含义一致。
4. 未完成工作分钟需要绑定同一天和同一地图：计时按实际游戏钟步核对；跨日或换图立即清除并保存未满阶段，已完成阶段不回退。额外覆盖 A 地图已有 10 分钟、短暂进入 B 而没有完整钟步、回 A 继续的反例，不能恢复旧分钟。正常同日同地图暂停保留已有分钟；跳时、暂停、被其他活动控制不增加分钟。
5. 后端重连握手完成前误提示旧版本：只在当前连接的记忆握手完成后做能力告警；已有故事遇真正不兼容后端仍拒绝跳过历史。
6. 初次全仓测试捕获了开发中的保存知识反例，修复后通过。后一次与编译同时进行的全仓测试中，原有 SIGKILL 恢复测试在固定 4 秒子进程启动期限超时，未产生 stderr；单独重跑 1/1、停止并行构建后全仓重跑 416/416。并行负载是推测原因，没有修改超时、削弱断言或改动生产恢复路径。

## 4. 实测 prompt 成本

使用仓库外 `gpt-tokenizer` 的 o200k 编码，执行实际生产 `storyChanges → storyContext → buildMessages`；34 张角色卡加载成功，共 21 个固定场景。结果和源文件校验值见 [JSON](2026-11-09-town-stories-prompt.json)。没有真实模型请求。

| 场景 | 新摘要增加的 token |
|---|---:|
| 尚未启动 | 0 |
| 格斯已提出事件／所有现场线索仍未汇报 | 98／98 |
| 艾米丽／皮埃尔自己的证词 | 123／135 |
| 当面告诉格斯包裹线索 | 133 |
| 直接归还／解释归还 | 144／273 |
| 潘妮开始／隐藏观察／明确贡献 | 94／94／134 |
| 潘妮一阶段／两阶段尚未记结局 | 150／152 |
| 潘妮独立／先观察／先阅读成品 | 134／167／169 |
| 艾利欧特独立／留白／明朗成品 | 134／171／170 |

整体为 **0 或 94–273**。把全部故事 JSON 常驻到同一提示还会额外增加 **1647**，并泄露未发现剧情，因此正式实现只传对应角色已知的短摘要；作品正文留在原生菜单。数字不含检索记忆增长、API 封装和输出，不能当成真实 DeepSeek 账单。新增可检索记忆的后续召回成本不包含在这个固定场景对比中。

复现方式（分词器路径按本机安装调整，不加入项目依赖）：

```sh
node tools/measure-town-stories-prompt.ts /private/tmp/stardew-feature-cost.aBgMTy/node_modules/gpt-tokenizer/esm/encoding/o200k_base.js /private/tmp/town-stories-prompt.json
```

## 5. 游戏验收边界

[Windows 全量清单](../npc-town-stories-game-checklist.md) 有 72 个独立编号，覆盖安装、八种结局、来源隔离、任务物件、实际日程工作、关开关、保存／读档／重启与旧功能回归；结果均留空，等待用户在游戏里填写。

本轮没有验证原版菜单的实际呈现、NPC 自然日程中的完整工作体验、任务物件在所有原版界面中的操作或真实模型的自由回应。Mac 上旧 `tests/mod-flow` 的游戏程序集加载限制仍沿用生活轮记录，不将历史 Windows 54/54 算进本轮。当前自动检查与 Release 只证明各自覆盖范围，不代替真人游戏验收。
