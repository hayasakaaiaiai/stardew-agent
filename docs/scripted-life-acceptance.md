# 生活功能独立游戏脚本验收

2026-11-09。用户明确要求检查新推送、运行测试并编写脚本进入游戏验证。本轮在 `codex/npc-life-windows-tests` 验收 `d7b11a3`，不合并主线或替换正常安装。验收完成后，已按用户授权将修复提交 `71e5385` 推送到同名远端分支。

沿用现有 World 验收框架：启动独立 SMAPI 进程，复制指定源测试存档，使用独立 Mod 目录、临时端口与记忆数据库。源档先备份、结束后逐文件核对 SHA256；正常存档、正常记忆与正常安装 DLL 均不作为写入目标。失败保留断言、原始通讯、游戏日志，并自动暂停；保存尚未结束时不杀游戏进程。测试保留息屏设置。

```powershell
powershell -NoProfile -File tools/test-game-life.ps1
# 可以单独复查章节
powershell -NoProfile -File tools/test-game-life.ps1 -Section goals
powershell -NoProfile -File tools/test-game-life.ps1 -Section activities
powershell -NoProfile -File tools/test-game-life.ps1 -Section family
powershell -NoProfile -File tools/test-game-life.ps1 -Section social
powershell -NoProfile -File tools/test-game-life.ps1 -Section save
powershell -NoProfile -File tools/test-game-life.ps1 -Section edges
```

脚本通过原版菜单选择接取、交付和活动，活动分钟等待原版时钟累积；准备位置、心数、背包和家庭关系属于明确标注的测试夹具。采集使用原版物体拾取，钓鱼使用原版 BobberBar 结束状态夹具，不证明玩家完整抛竿操作。厨房操作走原版烹饪页并点击库存放下成品，家庭餐检查实际扣物。`family` 是 `activities` 中厨房及家庭餐的定向重跑入口。模型使用固定回复，检查事实是否进入真实后端 prompt，不将其作为自由模型语义验收。

生活脚本显式最小化独立游戏窗口并断言 SDL 最小化标志，仍保持失焦继续运行。遇到夹具触发的无关原版剧情，先记录再结束剧情并重新准备演员；这部分不算剧情冲突验收。后端断线章节由测试转发器明确拒绝连接，不读取已关闭服务器的地址。正常游戏不启用这些测试行为。

测试范围与失败记录在本轮结果报告中填写；本文件不能单独证明任何场景已通过。生产规格仍以 `npc-life-spec.md` 为准。
