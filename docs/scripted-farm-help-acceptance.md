# 农场帮忙的 Windows 脚本验收

按用户“有新推送了 继续测”，纳入 `m2c-farm-help / 369788c`，保留已推送的 `78a4385` 及此前 Windows 修复。在独立 World 存档、Mod 和后端中补测，不部署正常安装，不合入 main。

- 用实际游戏对象准备成熟、再生、花、野生、死亡和未成熟作物，以及花盆、鸡舍、筒仓、鱼塘和箱子。调用生产农活入口，比较原版对象和产物，覆盖雨天、重复运行、箱满与无处放箱。
- 走生产约定入口和原版控制器，记录从巴士站进入农场、等候、离开和恢复日程；另测低心数、亲密关系、配偶、玩家不在场及挡路物件。
- 保存前建立受控农场基线，实际睡觉保存和读档。核对不保存回滚与保存后保留的农场变化、可靠消息和 NPC 记忆。各批次分别报告固定模型、真实模型和时间推进方式。
- 每次运行核对原测试档全部文件 SHA256。测试对象构造与直接坐标放置只用于准备场景，不能当作实际寻路、保存或模型内容通过的证据。

结果、失败与未覆盖边界写入本轮报告、`docs/status.md` 和 `docs/npc-farm-help.md`。

## 复现

在仓库根目录、正常游戏已退出时运行：

```powershell
# 一个入口运行农活、实际往返、关系边界和保存回滚。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-game-world.ps1 -Section farm-help
# 全部固定模型，不调用付费模型。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-game-world.ps1 -Section farm-help -Offline
```

也可选 `farm-chores`、`farm-visits`、`farm-save` 单独定位。默认 `all` 包含农场章节。未加 `-Offline` 时，农场章节里的现场问答和保存后的回忆使用真实模型；准备约定的对话和夜间整合仍为明确的固定夹具，不能称为整条链路都用真实模型。

```powershell
# 另用真实 nightlyConsolidator 测六种对话，各两次，共十二次 high 调用。
node tools/test-actions-content.ts --farm
# 核对请求正文完全一致后，重放已有输出，额外付费调用为零。
node tools/test-actions-content.ts --farm --replay .runtime/farm-content-2026-10-22T04-42-23-552Z/calls.jsonl
```

内容探针即使失败也写出全部十二份结果并以非零状态结束；不能用多次请求直到成功来替代原始失败。

## 夹具与证据

`FarmTest.cs` 只在已核对副本身份的 World 命令之后执行。清理可控农场时保留农舍等原版建筑，只移除自己标记的测试建筑。普通通路与封堵箱子的位置分开准备。晴雨农活使用原版对象和生产 `FarmHelp.Run`；访问使用生产 `day.meetings` 和控制器。

第一条赴约链打开自然时钟、NPC 步速 2；后续拓扑和回程可用步速 8，结束后恢复 2。逐格轨迹另外检查农场内经过多个位置，不能只检查最后坐标，以免把寻路失败的传送回退算成步行通过。保存章节实际退出标题、读档和睡觉；原版夜间非选项提示框先记录文本，再按原版点击推进，未知问题框仍会使脚本停止。

每轮目录保留 `sources/`、逐步命令、轨迹、模型请求、协议消息、断言、原版日志、画面、保存事件和原档前后哈希。运行结果分别列技术流程和人工复核的模型内容；固定夜间结果、直接构造关系、直接生产入口农活不代替自由模型选择、原版恋爱剧情或自然生长全过程的验收。
