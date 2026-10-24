# 星露谷 NPC Agent

让星露谷物语里的 34 位社交 NPC 自由聊天，记住你们的经历，并在游戏中赴约、帮忙和一起行动。后端使用 Node.js / TypeScript 和可配置的云端模型，SMAPI / C# Mod 复用原版界面。

当前为单人开发版本。Windows 已执行分批游戏脚本验收；自由模型仍有漏约和编造细节的问题，详见 [项目现状](docs/status.md) 与 [真实游戏报告](docs/test-results/2026-10-24-real-meetings-game.md)。

## 已实现

- 原版 NPC 台词之后选择“继续聊”，支持三个选项和自己输入中文。
- 独立 NPC 记忆、中文检索、跨天保存、不保存回滚、后端恢复和旧档分叉。
- 好感变化、原版送礼记忆、NPC 赠礼、寄信、头顶气泡和在场／后台传话。
- 原版日程与节日事实、主动靠近、今天至后天的约定、改约、取消和赴约好感。
- 农场作物及动物帮忙、陪下矿与救援、碰面后一起逛、NPC 主动邀约。

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

## 无游戏、无密钥验证

```powershell
npm test
npm run typecheck
npm run build
npm run demo
npm run demo:built
npm audit
node tools/check-repository.ts
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
