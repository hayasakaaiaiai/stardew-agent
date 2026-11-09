# NPC 长期目标扩展 spec

> 2026-11-09。用户要求先推送现版给 Windows 验收，随后继续长期目标，认为三条故事偏薄。验收分支 `codex/npc-town-life / b281ed1` 已推送；本轮在独立工作树 `/Users/a11/Documents/ChatGPT/stardew-agent-long-goals`、分支 `codex/npc-long-goals` 推进。用户此前已授权先写 spec、按顺序完成开发，本轮延续此方式；不合并 main、不碰 H 线、不启动游戏。新扩展完成后单独交付，不改已冻结的 Windows 验收分支。

## 1. 范围与顺序

| 阶段 | 完成条件 |
|---|---|
| L0 | 七项目、21章、63篇可读章节产物、原版依据、配置与事件契约 |
| L1 | 严格后端投影、前置、章节状态、知识隔离与旧存档兼容 |
| L2 | 原版菜单、现场观察、精确材料交付、六工作日推进、章节回看和合册 |
| L3 | 生活／恋爱／故事／长线四域原子日志、保存重启回滚、协议及降级保护 |
| L4 | 全仓测试、类型检查、构建、原生规则、实际分词及 Windows 清单 |

七条均为本 Mod 原创的长期个人项目。原三故事完整保留，不改其 ID、事件或结局。不是新增七个立即结束的对话：各三章、每章两日工作、有独立成果，玩家可以分章参与，也可以只看进展。无新增金钱、好感、物品奖励、建筑改造或强制日程。

| ID／角色 | 项目与三章 | 真实贡献 |
|---|---|---|
| penny_learning_book／潘妮 | 把问题带出书页：事实与猜想、两地比较、容纳未知 | Town、Forest、Mountain 各一章观察 |
| elliott_triptych／艾利欧特 | 三处风景的旁白：海边开场、街口转折、林间收束 | Beach、Town、Forest 各一章观察 |
| leah_form_study／莉亚 | 留白的形状：轮廓、材料取舍、观看路线 | Forest 观察、4 木材、Beach 观察 |
| maru_field_holder／玛鲁 | 随身观察夹：需求、部件连接、使用与修订 | Mountain 观察、2 铜锭、Town 观察 |
| robin_small_space／罗宾 | 窄地方也能好用：通道与收纳、连接、维护 | Town 观察、8 木材、Mountain 观察 |
| willy_shore_guide／威利 | 空鱼篓也有记录：岸边记录、工具归位、复盘 | Beach 观察、4 木材、Forest 观察 |
| linus_light_steps／莱纳斯 | 经过时轻一点：停留、少量材料安排、离开检查 | Mountain 观察、3 木材、Forest 观察 |

潘妮／艾利欧特分别须原 `penny_field_notes`／`elliott_short_piece` 的真实结局，且后续最早次日明确开启；其他五位可直接从“长期打算”开始，无恋爱或心数门槛。所有产物是稿本、设计说明或练习页，不冒充原版教学、小说出版、雕塑赠送、设备制造或房屋建成。

## 2. 章节与实际工作

每章有标题／引子、一个可选贡献、两个明确方案和 `default/a/b` 三篇完整产物。未选方案采用 default；default 不等于玩家完全没帮忙，已交材料或已汇报观察仍须被承认。章节结果为所选方向或 default，由真实已完成的两阶段工作产生，自由模型不能替玩家提交或推进。

第1章 opened 来源是项目 started；以后是前章 completed。每章工作1必须晚于 opened 日，工作2必须晚于工作1日。因此最早六个不同工作日完成。后续章的观察、交料、建议亦须晚于前章完成日；无需玩家回来读成果或再次接取。每章最多一次观察、一次当面贡献、一次方案选择；工作2以后不能补交或改方案。

各工作阶段在同日、同地图积累30分钟。换图或跨日立即清空未满阶段，正常同图暂停保留已有分钟但不补算暂停时间。需08:00–20:00正常游戏钟步、本人清醒静止、允许地图、无剧情及其他控制器／约定活动；不把睡觉、诊所值班、罗宾实际施工或远离游戏的后台时间算工作。玩家可不在同图。

工作图：潘妮 Trailer／Trailer_Big／ArchaeologyHouse／Town；艾利欧特 ElliottHouse／Beach；莉亚 LeahHouse／Forest／Beach；玛鲁 ScienceHouse／Mountain；罗宾 ScienceHouse；威利 FishShop／Beach；莱纳斯 Tent／Mountain。婚后四位可恋爱主人公在 FarmHouse 的计时只在其确为玩家配偶时允许；后端该地点只接收原生已核验的事实，不推断其他家庭变化。

## 3. 贡献与原版交互

观察：只从当前章开启后的同地图完整正常10分钟形成现场凭据，保存实际地点、天气和分钟。F8 汇总旧故事与新长线观察，只弹一个原版菜单；换图、跨日、读档清空未确认计时。现场记录不让不在场的 NPC 知道，返回本人面前明确汇报才生成 contribution。

材料：只使用明确的原版 `(O)388` 木材和 `(O)334` 铜锭，按章固定数量，一次交齐并消耗。菜单显示名称、数量和用途；不足不扣，取消不扣，写事件失败恢复原槽位、物件和数量；与普通送礼分开，不加好感。材料只证明交付，不证明玩家亲自采集、钓获、打造或已制成新物品。

有本章 contribution 后才可选 a/b 方案。观察汇报或材料交付与选方案分开确认，均由原版选项执行；忽略、晚来、退出不惩罚也不阻断 NPC 工作。已完成章节标题及全文持久保存，可随时重读；最后合册由实际完成的三篇组成，不预选其他分支。所有按钮复核 load nonce、游戏日、距离、开关、当前章、已完成状态及素材。

新开关 `LongGoals` 默认 true；关闭后保留进度、章节及合册回看，停止新贡献与工作。游戏中仍只用原版对话、提问框、提示，所有显示内容转义原版指令字符。

## 4. 唯一内容配置

`data/town/long-goals.json` 构建复制到 `assets/long-goals.json`，顶层 `{version:1,goals:[...]}`，固定上述七ID及owner。

每项目：`id,owner,title,opening,references,requiresStory?,workVenues,collectionTitle,collectionIntro,collectionClosing,chapters`。每章：`id` 为1/2/3，`title,opening,contribution,choices,outputs`。

- observation contribution：`{id:"observation",kind:"observation",venues:[{map,label}],minutes:10,hint}`。
- material contribution：`{id:"materials",kind:"material",itemId,count,label,purpose}`。
- choices：两个 `{id:"a"|"b",label,text}`。
- outputs：三个 `{id:"default"|"a"|"b",title,text}`；每篇约120–220汉字，方向改变正文结构或取舍，不只附一行感谢。
- `references` 是对应现有角色卡和 wiki 路径；实际角色事实由本地资料支持，故事新内容明确为原创，不导出版权游戏素材。

## 5. 日志契约与兼容

保留 `storiesProtocol:1`，另加 `goalsProtocol:1`。长线仍用 `life.sync`、共享 life-N 顺序和32条批次；前缀 `longgoal.*` 避开旧材料委托 `goal.*`。所有事件基础字段 `{id,npc,day,kind,longGoalId}`，owner固定。

| kind | 额外字段与规则 |
|---|---|
| longgoal.started | 前置项目须 `dependencySourceId` 为本NPC原故事 resolved 的精确ID；无前置则不允许字段 |
| longgoal.observed | `chapterId,contributionId,venue,weather,minutes`；观察章、当前章、允许地图、正常观察至少10分钟 |
| longgoal.contributed | 观察章：`chapterId,contributionId,sourceId` 指本章 observed；材料章：`chapterId,contributionId,itemId,count` 精确匹配配置；不允许两种字段混用 |
| longgoal.choice | `chapterId,choiceId,sourceId` 指本章 contributed，且仅当前章、未选过 |
| longgoal.worked | `chapterId,step,venue,minutes`，step为1/2，至少30分钟且日期严格满足章节门槛 |
| longgoal.completed | `chapterId,outcome`，两阶段已存在，outcome必须等于本章choiceId或default；第三章即全项目完成 |

天气沿用 sunny/rain/storm/snow/windy。贡献和选择须工作2尚未完成。所有未来日期、额外字段、错角色／章／地点／材料／来源和更改后的重复事件严格拒绝。

后端新增 `src/agent/long-goals.ts`，独立 `state.longGoal` 和 `log.longGoalState`，不改记忆内核。先投影本批 story，再把该命名空间合入长线的 prior；前置须 source serial小于started serial且source day早于started day，拒绝同批倒序依赖。四域先整体校验，最后一次原子写入，夜间印象／计划不被覆盖。

原生新增 `LifeSave.LongGoals`，旧档缺字段默认空。新 Mod 接受生活存档版本1/2；首条长线事件成功时升级2，失败回退版本。旧 Mod 遇2拒绝写生活数据，防止忽略新字段再覆盖。无长线记录继续版本1。含长线历史而缺capability时暂停整个混合同步，不过滤事件或跳共享cursor；退出已有旧活动的恢复路径保留。

## 6. 知识和成本

只有owner接收本项目记忆。未汇报观察只存在隐藏进度；本人工作、已收贡献、所选方案、真实章节结果才属于已知。不当作公共好友八卦来源。章节全文和未选方案不常驻提示：进行中仅当前章和已完成章节数量，全部完成后仅最终合册标题与真实贡献概要。不补写未提供正文。

实施时用仓库外 o200k tokenizer 测实际生产摘要，比较“仅当前章”与“保留三章摘要”，再锁定最终提示篇幅；不新增依赖或真实模型调用。新来源可能被既有检索召回，该额外成本单独说明，不能把摘要增量当全部账单。

## 7. 验证与交付

覆盖7项目所有默认和两选择产物、三章顺序、六工作日、后续前置同批正序／倒序、跨章来源、隐藏观察、材料不足／取消／精确扣除／失败回退、关闭／旧后端／旧Mod保护、睡眠与婚后地点、混合四域原子性、旧存档读入、保存／重启／分叉和晚到nightly。原生规则与编译自己完成；真人Windows清单结果留空。最终状态、成本、实现调整和检查记录见下节。

## 8. 实现结果与实测

L0–L4 已完成代码与离线检查，七项目21章节全部接入。63篇产物各144–162汉字，已确认16观察章、5材料章以及每章默认／两方案有正文差异；原生保存本次实际结果，合册入口按真实三章阅读。无奖励或世界设施变更。详见 [验证报告](test-results/2026-11-09-npc-long-goals.md)、[内容目录](npc-long-goals-content.md) 和 [Windows 清单](npc-long-goals-game-checklist.md)。

全仓 Node **463/463**、类型检查、构建、源码／构建后 demo 通过；五套独立 C# **358/358**（本轮191），Mod Release 0警告0错误。Windows清单99个独立编号、141个空白结果格，其中21章各验三种稿页，不把离线通过当真人验收。

实现收敛为独立 `longGoal` 状态中的有限事件重放：每NPC一个项目、最多19条长线事件，加精确前作凭据，不再另存一份易失配的后端进度和知识副本；原生仍保存章节结果文本快照及计时。每次从事件重放得到当前章，摘要只读取允许角色知道的字段。

新增共享日志ID一致性检查：四域、全部NPC、当前存档祖先与当天日志的同一life-N必须对应完全相同内容；桥接先校验后原子写入。正常新保存点增量扩展索引，读旧档／兄弟分支重建当前祖先索引，合法回滚后的序号复用仍允许。该检查没有新增记忆内核接口。

工作地图与实际配偶关系联合核验；罗宾有未完成建造时保守暂停私人项目，玛鲁不在诊所推进。F8合并为一个带分页的原版提问框，各选项再核对应功能开关和能力；没有增加第二个观察快捷键。原三故事保持原投影与内容，原生只抽取F8选项供共用入口。

实际生产分词74场景、34卡、12份源哈希：当前章方案新增 **0 或97–226 o200k token**；若另保留已完成章摘要，还增加 **89–184**（有旧章时）。最终采用当前章方案，已完成后给合册与真实贡献概要，63篇正文保留在原生菜单。该数字不含旧功能摘要、API封装、输出或后续检索增长，无真实模型调用；原始对照见 [分词JSON](test-results/2026-11-09-long-goals-prompt.json)。
