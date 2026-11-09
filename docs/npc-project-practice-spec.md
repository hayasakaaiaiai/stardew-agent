# 成果实践与回访

2026-11-09。承接用户“推送，之后继续”：长期目标验收版已推送至 `codex/npc-long-goals / 80bdaf4`；本阶段从该提交隔离在 `codex/npc-project-practice`。按以下顺序实现完整的提醒、七种实践和回访，不含 H 线、摆摊、公共改造或新的恋爱关系规则。

## 1. 玩家能做什么

1. 已真实完成章节的居民，在同图近处、安全空闲时用原版气泡提醒一次最新成果；错过不损失进度。
2. 三章完整合册后，从居民“长期打算”进入“成果实践”。仍需现有 **8 心或配偶／室友**，9–19 点当面开始，共用普通约定／活动每天 3 次额度；低好感不影响此前自主写作、合册阅读或提醒。
3. 带角色去指定场所，用真实相处、移动、钓鱼或采集，配合明确原版选项完成一次实践。结束后可反复阅读本次回执；最早次日给出一次回访反馈，形成可回看的批注。

不增加物品、地图摆设、好感或恋爱奖励。完成页只写实际记录和玩家选择；小说、设计、建议不变成已经发生的世界事实。模型无权开始、跳过或结算实践。

## 2. 七种实践

| 项目 | 实践／地点 | 实际要求 | 玩家操作 |
|---|---|---|---|
| penny_learning_book | 把问题带出去／Forest | 30 分钟，2 个相隔至少 6 格的记录点，记录间至少 10 分钟 | 选择比较方法，对两次实际记录各提出一个问题，收尾保留一个未解决问题 |
| elliott_triptych | 沿岸试读／Beach | 30 分钟，2 个相隔至少 6 格的停读点，间隔至少 10 分钟 | 安排停读和留到下一处的段落，收尾修订节奏；不声称播放语音 |
| leah_form_study | 换个角度再看／Forest | 30 分钟，3 个两两相隔至少 6 格的位置，记录间至少 10 分钟 | 选择观看路线并比较站位；不声称雕塑已被摆放 |
| maru_field_holder | 把记录找回来／Mountain | 30 分钟，2 个相隔至少 6 格的位置，间隔至少 10 分钟 | 留下两条真实地图、天气、时间记录，选择整理／复核方式；不生成测量仪器或读数 |
| robin_small_space | 让路线走得通／Town | 30 分钟，3 次记录；第二点离首点至少 6 格，第三点回到首点 3 格内；每次间隔至少 10 分钟 | 标记拟放置参照、实际往返，再修订范围／朝向；不改碰撞、不宣称负重测试 |
| willy_shore_guide | 带着问题下一竿／Beach | 20 分钟，本次在海滩近处真正钓获至少 1 条鱼；1 次记录 | 选按地点／时段记，保存实际数量，再选保留条件／下次只换一个条件 |
| linus_light_steps | 够了就停下／Forest | 20 分钟，本次在森林近处真正采集至少 1 件；1 次记录 | 记录点选择就此收尾／至少两件再收尾；后者需实际至少 2 件才能结束；物品留在背包 |

所有首个记录点至少累计 10 分钟；走路项目在目标地图正常同行累计计时，记录点是该段末尾实际位置，不声称在点上站满 10 分钟。欧氏格距；坐标是玩家实际格点。打开菜单、暂停、离开地图、NPC 距离大于 8 格或跨图的钟步不计时。返回后可接着同次实践；达到原活动 90 分钟上限、日终或取消只结束尝试，完成必须玩家明确点击“完成实践”。同一合册仅完成一次，可取消后重新尝试，每次开始占额度。

## 3. 内容与事件契约

配置 `data/town/goal-results.json`：`{version:1,practices:[...]}`，固定七个项目。每项字段：`projectId,owner,title,venue,venueLabel,mode,minutes,opening,planChoices,checkpoints,finishChoices,receiptIntro,reviewIntro,reviewChoices,references`。

`mode` 为 `walk/fishing/foraging`；`minutes` 为上表 30/20。三组选项及每个记录点选项均为 `{id:'a'|'b',label,text}` 两项；`checkpoints` 为 `{point:1..3,title,prompt,choices}`。文本为原创、原版对话安全文本；人物事实依据已有角色卡／wiki，链接记在 references。详细文字仅原版阅读菜单展示，不常驻 prompt。

所有新事件共享 `life-N` 严格递增序号；共同字段 `{id,npc,day,kind,projectId}`。只认七位对应 owner，字段严格拒绝额外内容。

| kind | 额外字段 | 规则 |
|---|---|---|
| goalresult.notified | chapterId, sourceId | sourceId 是本人该章真实 longgoal.completed；每章至多一次，提醒最新未提醒的完成章，气泡展示成功才写 |
| goalresult.started | sourceId, choiceId | sourceId 精确指第三章 completed；choiceId 为 a/b；id 即 attemptId。不得早于合册完成，不能覆盖活跃尝试或已完成实践 |
| goalresult.checkpoint | attemptId, point, venue, x, y, time, weather, minutes, count, choiceId | 同日同尝试，顺序 1..N；venue 固定目标地图；x/y 整数 0..500；time 合法 9:00–22:00 游戏钟点；weather= sunny/rain/storm/snow/windy；minutes 为 10..90 的 10 倍数，count 为 0..999；符合上表路线及间隔，行走 count=0，钓鱼／采集至少 1；a/b 明确操作 |
| goalresult.completed | attemptId, sourceId, minutes, count, choiceId | sourceId 指本次最后记录点，所有点齐全，同日、时长达标且不小于末点，动作数量不倒退；莱纳斯点选 b 则 count≥2。完成选择 a/b |
| goalresult.cancelled | attemptId, reason | reason=player/interrupted/load；关闭未完成尝试，后两种可在稍后游戏日记录；不写成功结果 |
| goalresult.reviewed | sourceId, choiceId | sourceId 精确指 completed，严格次日或以后，a/b 一次；只评价那次实践，不代表第二次行动 |

通知与实践相互独立。通知后不会自动视为读过合册。无额外 opened 门槛。取消不保留控制器，重试必须新 started ID，旧点不能复用。跨日／读档遗留 started 在实际恢复生活数据后补 cancelled(load/interrupted)，不复活跟随。

## 4. 存储和桥接

新投影 `state.goalResult` 与独立 `log.goalResultState/goalResultEvents`，不覆盖 impression、plan 或其他域。合并日志先投影 longGoal，再投影新域，支持同批真实第三章完成解锁，但引用必须更早。引用与重放检查在 TypeScript/C# 一致。保留通知回执、本次尝试完整来源、完成和回访；允许淘汰已取消尝试，保留 watermark 并依靠全局 journal ID 签名核验旧重放，不能重新应用旧动作。

握手 `resultsProtocol:1`；旧后端禁止新实践，已有新域待同步时拒绝误报就绪。LifeSave 接收 1/2/3，首条新事件才升级 3，写入失败还原版本／序号／状态；旧版拒绝 3 并保留原文。存档中新增 GoalResults；读档验证依据完整 journal 重建，不能只信 UI 缓存。

复用 LifeActivitySession、跟随、跨图、释放及日程恢复；新增实践标记，计时与动作采样限定目标地图／NPC 近处。实践不走旧 activity.completed、友情、八卦或 cooking continuation；不给旧 lifeActivity 枚举快照塞新类型。新功能配置 `ProjectPractice=true`，关闭后停止已有实践并释放角色；已保存成果仍可阅读。

提醒：每天全局最多 1 次，加载后的实际提醒日从日志推导；只选最新章，不补刷旧章，不打断原版剧情、节日、菜单、钓鱼或已有控制活动。原版气泡和可选表情；保存失败不消费待提醒状态。

## 5. Prompt 成本选择

采用单个当前阶段的短摘要，包含真实结果和未完成边界，不附整份步骤或作品。实现前以 o200k 原型实测：威利待实践短摘要 48 token，连同全部规则 137 token，差 89 token；只是原型，不冒充最终生产值。最终使用生产 buildMessages、34 张角色卡、七项目阶段样本重新测量，并报告无项目增量 0、各阶段区间及全规则对照。新摘要仅本人知道，通知本身不生成事实记忆。

## 6. 顺序与验收

- [x] 0. 推送稳定验收版；隔离后续分支；锁定本文契约和成本方向。
- [x] 1. 七套内容、严格配置和新事件投影；去重、跨来源／跨日／取消／回访边界。
- [x] 2. 原生提醒、七套实践与完成／回访阅读；真实动作、取消恢复、兼容与配置。
- [x] 3. 合并桥接、持久化／重启／回滚／知情隔离；原生纯规则和 Release 编译。
- [x] 4. 实际分词、全仓测试、typecheck、构建、demo、仓库检查；更新报告、status 和 Windows 清单后提交。新阶段暂不推送，不合并 main。

Windows 清单必须覆盖七条实践、每种收尾／回访选择、路线和动作不足、低心门槛、暂停／菜单／跨图、主动提醒去重、取消／超时／日终／读档、断线结算、版本降级、旧生活／恋爱／故事回归。游戏结果留空，由用户测试。

## 7. 完成记录与实测差异

七套内容、14 个记录点、70 条选择正文均已接入原版菜单；回执逐页保留实际选择，并可打开本存档原合册。后端取消历史有界压缩，原生仍依生活日志保留各次尝试以核对存档。通知不增加单独摘要；已完成合册的待实践状态由原长期目标摘要表达，首次实际 started 才增加新摘要，避免重复。

原生小菜单每页最多四个内容选项再加翻页／关闭。首次记录的分钟不得早于09:00可启动时间；后续记录累计分钟增量不得超过真实钟点差。配偶／室友对 ignoreScheduleToday 日程标记沿用原活动豁免，其余忙碌条件保留。

最终 Node **512/512**、独立 C# **506/506**、类型检查、构建、源码与构建后 demo、Mod Release（0警告0错误）通过。实际84场景、34卡、43源哈希分词：新摘要 **0 或51–97 o200k token**；附完整玩法还需 **529–766 token**。详见 [验证报告](test-results/2026-11-09-npc-project-practice.md)。Windows [83编号／90结果格](npc-project-practice-game-checklist.md) 全部待用户实际测试；未运行游戏、部署、调用真实模型、推送本阶段或合并 main。
