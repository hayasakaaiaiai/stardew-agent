# 下矿陪同的 Windows 脚本验收

按用户“有新推送了 继续测”，纳入 `m2c-mine-companion / cb2a3f1`，保留已推送的 `84a780e`。沿用“手测部分写脚本测”的授权，使用独立 World 存档、副本 Mod 和后端；原档全部文件前后 SHA256 核对，正常安装不部署，不合入 main。

1. 保留原版日程测试门口赴约，另用受控原版路线覆盖矿洞、骷髅洞穴、火山和关系边界。明确区分正常时钟／步速和加速拓扑。
2. 通过原版 `warpFarmer`、`enterMine` 和真实 `Player.Warped` 进入／换层，检查同层寻路、远距离追上、物件保护、玩家穿过的碰撞条件；不直接调用生产加入方法充当换图证据。
3. 构造原版怪物，等待生产周期攻击，比较怪物生命、实际死亡数、掉落、玩家经验和公会击杀计数。覆盖不会战斗、重叠怪物和菜单暂停，不能仅检查 `kills` 字段。
4. 在已核对身份的副本里用原版伤害入口注入致命伤，核对死亡判定顺序、实际救援传送、血量、金钱、背包和可靠总结；不直接调用 `Rescue` 证明拦截成功。
5. 检查正常离开、回城式跨图、22:00、提前结束当天、禁用、低心数和配偶；核对回程、控制器、速度和原版行程恢复。
6. 实际保存、返回标题和重读，比较保存后的击杀／物资／记忆保留，以及不保存回滚。受控怪物和关系设置不代表完整剧情或自然刷怪验收。

## 运行

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-game-world.ps1 -Section mine -Offline
node tools/test-actions-content.ts --mine
node tools/test-actions-content.ts --mine --replay .runtime/mine-content-2026-10-22T06-18-36-815Z/calls.jsonl
```

`mine` 一次串行运行核心、两种致命伤、关系和结束边界、自然日程和三种地牢、保存回滚。定位问题可以单独选 `mine-core`、`mine-rescue`、`mine-edges`、`mine-worlds`、`mine-save`；同一时刻只运行一份原生游戏。

`-Offline` 使用固定模型，通过真实协议和存档执行。去掉它会请求已配置的真实模型；内容守卫仍检查同一套预期，不能保证一次采样符合夹具语义。`test-actions-content.ts --mine` 另计真实夜间样本，重放要求完整请求正文一致，绝不吞掉原始失败。

各批次结果、失败和覆盖边界见 [本轮报告](test-results/2026-10-22-mine-companion-windows.md)；原生副本、源码、Mod、断言、协议、原版日志、模型调用和原档前后哈希保存在每次 `.runtime/game-memory-*` 目录。只有测试姓名、存档名和 ID 都匹配的副本才接受这些破坏性夹具命令。正式安装不接收它们。
