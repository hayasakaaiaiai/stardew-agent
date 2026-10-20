using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Menus;

namespace StardewAgentBridge;

/// <summary>Opt-in native-game acceptance test. Its launcher creates and verifies an isolated save first.</summary>
internal sealed class MemoryTestConfig
{
    public string RequestId { get; set; } = "";
    public string SaveFolder { get; set; } = "";
    public string UniqueId { get; set; } = "";
    public string BackendUrl { get; set; } = "";
    public string RunDirectory { get; set; } = "";
    public bool MorningPlans { get; set; }
    public bool BubblesOnly { get; set; }
    public bool MailOnly { get; set; }
}

internal sealed partial class ModEntry
{
    private MemoryTestConfig? memoryTest;
    private string memoryTestStage = "";
    private string memoryTestAfterWarp = "";
    private string memoryTestAfterClose = "";
    private string memoryTestLabel = "";
    private string memoryTestLine = "";
    private string memoryTestAfterReply = "";
    private DateTime memoryTestStarted;
    private int memoryTestTicks;
    private int memoryTestFirstDay;
    private int memoryTestSleepDay;
    private int memoryTestRestartGeneration;
    private readonly List<object> memoryTestReplies = new();
    private readonly List<object> memoryTestEvents = new();

    private void ConfigureMemoryTest()
    {
        string? path = Environment.GetEnvironmentVariable("STARDEW_AGENT_TEST_MEMORY");
        if (string.IsNullOrWhiteSpace(path))
            return;
        MemoryTestConfig test = JsonSerializer.Deserialize<MemoryTestConfig>(File.ReadAllText(path))
            ?? throw new InvalidOperationException("记忆测试配置为空。");
        if (!Guid.TryParse(test.RequestId, out _) || !ulong.TryParse(test.UniqueId, out _)
            || test.SaveFolder != "MemoryTest_" + test.UniqueId || test.UniqueId == "436774213"
            || !Path.IsPathFullyQualified(test.RunDirectory) || !Directory.Exists(test.RunDirectory)
            || !Uri.TryCreate(test.BackendUrl, UriKind.Absolute, out Uri? uri)
            || uri.Scheme != "ws" || uri.Host != "127.0.0.1")
            throw new InvalidOperationException("记忆验收只允许独立的 MemoryTest 存档和本机测试后端。");
        this.memoryTest = test;
        this.config.BackendUrl = test.BackendUrl;
    }

    private void BeginMemoryTestIfRequested()
    {
        if (this.memoryTest is null)
            return;
        this.memoryTestStarted = DateTime.UtcNow;
        this.Helper.Events.GameLoop.Saving += (_, _) => this.RecordMemoryTestEvent("Saving");
        this.Helper.Events.GameLoop.Saved += (_, _) => this.RecordMemoryTestEvent("Saved");
        this.Helper.Events.GameLoop.SaveLoaded += (_, _) => this.RecordMemoryTestEvent("SaveLoaded");
        this.Helper.Events.GameLoop.ReturnedToTitle += (_, _) => this.RecordMemoryTestEvent("ReturnedToTitle");
        this.MemoryTestProgress("load-menu", "开始独立存档的真实游戏记忆验收。");
    }

    private void RecordMemoryTestEvent(string name)
    {
        if (this.memoryTest is not null)
            this.memoryTestEvents.Add(new { name, day = this.currentDay, nonce = this.loadNonce,
                pointer = this.savedCommit, pending = this.pendingCommit, at = DateTime.UtcNow });
    }

    private void TickMemoryTest()
    {
        if (this.memoryTest is not { } test || ++this.memoryTestTicks % 10 != 0)
            return;
        try
        {
            string controlPath = Path.Combine(test.RunDirectory, "control.json");
            using JsonDocument? control = File.Exists(controlPath) ? JsonDocument.Parse(File.ReadAllText(controlPath)) : null;
            bool matched = control is not null && control.RootElement.GetProperty("requestId").GetString() == test.RequestId;
            if (matched && control!.RootElement.TryGetProperty("abort", out JsonElement reason))
                throw new InvalidOperationException(reason.GetString());
            if ((DateTime.UtcNow - this.memoryTestStarted).TotalSeconds > 660)
                throw new TimeoutException("记忆真机验收超时。");
            if (this.syncFailed)
                throw new InvalidOperationException("记忆同步失败，请查看后端日志。");

            switch (this.memoryTestStage)
            {
                case "load-menu":
                case "reload-menu":
                case "fork-menu":
                    if (Game1.activeClickableMenu is not TitleMenu title || this.lifecycle.Count > 0)
                        return;
                    string next = this.memoryTestStage == "load-menu" ? "select-save"
                        : this.memoryTestStage == "reload-menu" ? "select-reload" : "select-fork";
                    title.skipToTitleButtons();
                    if (TitleMenu.subMenu is null)
                        title.performButtonAction("Load");
                    this.MemoryTestProgress(next, "加载独立验收存档。");
                    break;

                case "select-save":
                case "select-reload":
                case "select-fork":
                    if (TitleMenu.subMenu is not LoadGameMenu load || load.IsDoingTask())
                        return;
                    var matches = load.MenuSlots.OfType<LoadGameMenu.SaveFileSlot>()
                        .Where(slot => slot.Farmer.slotName == test.SaveFolder).ToList();
                    if (matches.Count != 1)
                        throw new InvalidOperationException("找不到唯一的验收副本：" + test.SaveFolder);
                    string loaded = this.memoryTestStage == "select-save" ? "loaded-first"
                        : this.memoryTestStage == "select-reload" ? "loaded-rollback" : "loaded-fork";
                    this.MemoryTestProgress(loaded, "等待读档和记忆握手。");
                    matches[0].Activate();
                    break;

                case "loaded-first":
                case "loaded-rollback":
                case "loaded-fork":
                    if (!Context.IsWorldReady || !this.CanChat || Game1.activeClickableMenu is not null)
                        return;
                    this.CheckMemoryTestSave();
                    // This is a disposable save; high hearts avoid the documented low-heart recall filter.
                    Game1.player.friendshipData["Abigail"] = new Friendship(2000);
                    if (test.MailOnly)
                    {
                        this.BeginLetterTest();
                        break;
                    }
                    if (test.BubblesOnly)
                    {
                        this.memoryTestFirstDay = this.currentDay;
                        this.WarpForMemoryTest("bubbles");
                        break;
                    }
                    if (this.memoryTestStage == "loaded-first")
                    {
                        this.memoryTestFirstDay = this.currentDay;
                        this.WarpForMemoryTest("learn-cat");
                    }
                    else
                    {
                        if (this.currentDay != this.memoryTestFirstDay + 1)
                            throw new InvalidOperationException("重新读档的日期不符合预期。");
                        this.WarpForMemoryTest(this.memoryTestStage == "loaded-rollback" ? "ask-rollback" : "ask-fork");
                    }
                    break;

                case "warping":
                    break;

                case "start-talk":
                    if (Game1.isWarping || Game1.activeClickableMenu is not null || !this.CanChat)
                        return;
                    NPC npc = Game1.getCharacterFromName("Abigail");
                    if (npc.currentLocation != Game1.currentLocation)
                        throw new InvalidOperationException("阿比盖尔已离开目标地点。");
                    if (test.BubblesOnly)
                    {
                        this.BeginBubbleTest(npc);
                        break;
                    }
                    this.StartTalk(npc);
                    this.MemoryTestProgress("opening", "等待阿比盖尔的开场回复。");
                    break;

                case "opening":
                    if (!this.MemoryTestHasReply())
                        return;
                    this.memoryTestReplies.Add(new { label = "opening-" + this.memoryTestAfterWarp,
                        line = "（玩家走过来，想和你多聊几句）", reply = this.talk!.Reply,
                        day = this.currentDay, nonce = this.loadNonce, requestSeq = this.talk.RequestSeq,
                        hearts = GameState.Hearts(this.talk.Npc), generation = this.bridge.Generation });
                    if (this.memoryTestAfterWarp == "next-plan")
                        this.CloseMemoryTestTalk("return-fork");
                    else
                        this.BeginMemoryTestLine(this.memoryTestAfterWarp);
                    break;

                case "input":
                    if (this.talk?.Input is not { } input || !ReferenceEquals(Game1.activeClickableMenu, input))
                    {
                        // Vanilla briefly ignores clicks after opening a box, even after its transition ends.
                        if (this.talk?.Shown is not null && Game1.activeClickableMenu is DialogueBox { transitioning: false })
                            this.ChooseMemoryTestResponse(this.talk.Options.Count);
                        return;
                    }
                    input.textBox.Text = this.memoryTestLine;
                    // Submit through the vanilla input callback, preserving the real menu-close event ordering.
                    input.textBoxEnter(input.textBox);
                    this.MemoryTestProgress("reply", "已通过原版输入框提交：" + this.memoryTestLine);
                    break;

                case "reply":
                    if (!this.MemoryTestHasReply())
                        return;
                    this.memoryTestReplies.Add(new { label = this.memoryTestLabel, line = this.memoryTestLine,
                        reply = this.talk!.Reply, day = this.currentDay, nonce = this.loadNonce,
                        hearts = GameState.Hearts(this.talk.Npc), generation = this.bridge.Generation });
                    this.MemoryTestProgress(this.memoryTestAfterReply, "已收到回复：" + this.memoryTestLabel);
                    break;

                case "learned-cat":
                    this.CloseMemoryTestTalk("sleep-a");
                    break;
                case "asked-cat":
                    this.BeginMemoryTestLine("learn-farm");
                    break;
                case "learned-farm":
                    this.CloseMemoryTestTalk("return-rollback");
                    break;
                case "asked-rollback":
                    this.PauseMemoryTest("rollback-ready", "校验未保存的信息是否已丢弃。");
                    break;
                case "learned-kite":
                    this.CloseMemoryTestTalk("pause-restart");
                    break;
                case "asked-restart":
                    this.CloseMemoryTestTalk("sleep-b");
                    break;
                case "asked-fork":
                    this.PauseMemoryTest("fork-loaded", "校验旧档没有混入未来分支的记忆。");
                    break;
                case "learned-boat":
                    this.CloseMemoryTestTalk("sleep-c");
                    break;

                case "closing":
                    if (this.talk?.Shown is not null && Game1.activeClickableMenu is DialogueBox { transitioning: false })
                    {
                        if (this.talk.End) Game1.exitActiveMenu();
                        else this.ChooseMemoryTestResponse(this.talk.Options.Count + 1);
                        return;
                    }
                    if (this.talk is not null || Game1.activeClickableMenu is not null || !this.CanChat)
                        return;
                    this.MemoryTestProgress(this.memoryTestAfterClose, "对话已正常关闭。");
                    break;

                case "sleep-a":
                case "sleep-b":
                case "sleep-c":
                    this.CheckMemoryTestSave();
                    this.memoryTestSleepDay = this.currentDay;
                    string slept = this.memoryTestStage + "-wait";
                    FarmHouse home = Utility.getHomeOfFarmer(Game1.player);
                    Point bed = home.getBedSpot();
                    if (bed.X < 0 || bed.Y < 0)
                        throw new InvalidOperationException("验收副本没有可用的床。");
                    LocationRequest request = Game1.getLocationRequest(home.NameOrUniqueName);
                    request.OnWarp += () =>
                    {
                        // Use the game's actual sleep action, not date editing or a simulated save message.
                        this.MemoryTestProgress(slept, "已选择睡觉，等待真实 Saving/Saved 和次日。");
                        Game1.currentLocation.answerDialogueAction("Sleep_Yes", Array.Empty<string>());
                    };
                    this.MemoryTestProgress("warping", "返回副本的床边睡觉。");
                    Game1.warpFarmer(request, bed.X, bed.Y, 2);
                    break;

                case "sleep-a-wait":
                case "sleep-b-wait":
                case "sleep-c-wait":
                    if (!Context.IsWorldReady || !this.CanChat || Game1.activeClickableMenu is not null || Game1.newDay)
                        return;
                    if (this.currentDay != this.memoryTestSleepDay + 1
                        || this.savedCommit?.DayEnded != this.memoryTestSleepDay)
                        return;
                    string gate = this.memoryTestStage == "sleep-a-wait" ? "saved-a"
                        : this.memoryTestStage == "sleep-b-wait" ? "saved-b" : "saved-c";
                    this.PauseMemoryTest(gate, "真实保存已完成，等待核对存档和数据库。");
                    break;

                case "return-rollback":
                    Game1.ExitToTitle();
                    this.MemoryTestProgress("reload-menu", "不保存退出，重新加载同一副本。");
                    break;
                case "pause-restart":
                    this.memoryTestRestartGeneration = this.bridge.Generation;
                    this.PauseMemoryTest("restart-backend", "游戏保持打开，等待独立后端重启。");
                    break;
                case "return-fork":
                    Game1.ExitToTitle();
                    this.MemoryTestProgress("wait-title-fork", "返回标题页后恢复副本的旧保存点。");
                    break;
                case "wait-title-fork":
                    if (Game1.activeClickableMenu is TitleMenu && !Context.IsWorldReady && this.lifecycle.Count == 0)
                        this.MemoryTestProgress("restore-a", "标题页已就绪，可安全恢复副本的 A 保存点。");
                    break;
                case "return-finish":
                    Game1.ExitToTitle();
                    this.MemoryTestProgress("wait-title-finish", "验收完成，回到标题页。");
                    break;
                case "bubbles-only":
                    this.TickBubbleTest();
                    break;
                case "mail-only":
                    this.TickLetterTest();
                    break;
                case "mail-title":
                    if (Game1.activeClickableMenu is TitleMenu && !Context.IsWorldReady && this.lifecycle.Count == 0)
                        this.MemoryTestProgress("reload-menu", "重新加载副本，核对信件和附件存档状态。");
                    break;
                case "mail-sleep-wait":
                    if (Context.IsWorldReady && this.CanChat && Game1.activeClickableMenu is null && !Game1.newDay
                        && this.currentDay == this.memoryTestSleepDay + 1 && this.savedCommit?.DayEnded == this.memoryTestSleepDay)
                    {
                        this.LetterCheck(true, "real-sleep-save-completed");
                        Game1.ExitToTitle();
                        this.MemoryTestProgress("mail-title", "真实睡觉保存后重新读档。");
                    }
                    break;
                case "wait-bubbles-title":
                    if (Game1.activeClickableMenu is TitleMenu && !Context.IsWorldReady && this.lifecycle.Count == 0)
                        this.MemoryTestProgress("reload-menu", "重新加载独立副本，验证气泡可重新出现。");
                    break;
                case "wait-title-finish":
                    if (Game1.activeClickableMenu is TitleMenu && !Context.IsWorldReady && this.lifecycle.Count == 0)
                        this.FinishMemoryTest(true, test.MailOnly ? "原生信箱、附件领取、回滚和保存检查完成。" : test.BubblesOnly ? "原生气泡显示、距离、冷却与读档检查完成。" : "跨天、未保存回滚、后端重启和旧档分叉的真机流程完成。");
                    break;

                case "saved-a":
                case "rollback-ready":
                case "restart-backend":
                case "saved-b":
                case "restore-a":
                case "fork-loaded":
                case "saved-c":
                    if (!matched || control!.RootElement.GetProperty("stage").GetString() != this.memoryTestStage)
                        return;
                    if (this.memoryTestStage == "restart-backend"
                        && (this.bridge.Generation <= this.memoryTestRestartGeneration || !this.CanChat))
                        return;
                    string completed = this.memoryTestStage;
                    if (Game1.activeClickableMenu is DialogueBox && this.talk?.Shown is null)
                        Game1.exitActiveMenu();
                    this.MemoryTestProgress("gate-closed", "外部证据核验完成。");
                    if (completed == "saved-a") this.WarpForMemoryTest("ask-cat");
                    else if (completed == "rollback-ready") this.BeginMemoryTestLine("learn-kite");
                    else if (completed == "restart-backend") this.WarpForMemoryTest("ask-restart");
                    else if (completed == "saved-b")
                    {
                        if (test.MorningPlans) this.WarpForMemoryTest("next-plan");
                        else this.MemoryTestProgress("return-fork", "准备读回旧保存点。");
                    }
                    else if (completed == "restore-a") this.MemoryTestProgress("fork-menu", "加载旧保存点。");
                    else if (completed == "fork-loaded") this.BeginMemoryTestLine("learn-boat");
                    else this.MemoryTestProgress("return-finish", "最终分叉保存已核验。");
                    break;
            }
        }
        catch (Exception error)
        {
            this.FinishMemoryTest(false, error.Message);
        }
    }

    private void CheckMemoryTestSave()
    {
        if (this.memoryTest is not { } test || Game1.uniqueIDForThisGame.ToString() != test.UniqueId
            || Game1.player.Name != "记忆验收" || Constants.SaveFolderName != test.SaveFolder
            || Game1.eventUp || Game1.isFestival() || !Context.IsMainPlayer)
            throw new InvalidOperationException($"独立验收条件不符：ID={Game1.uniqueIDForThisGame}，玩家={Game1.player.Name}，"
                + $"目录={Constants.SaveFolderName}，主玩家={Context.IsMainPlayer}，剧情={Game1.eventUp}，节日={Game1.isFestival()}。");
    }

    private void WarpForMemoryTest(string afterOpen)
    {
        this.CheckMemoryTestSave();
        NPC npc = Game1.getCharacterFromName("Abigail") ?? throw new InvalidOperationException("找不到阿比盖尔。");
        // Eight hearts can trigger a vanilla event in the shop. Keep this disposable fixture in the farmhouse.
        FarmHouse scene = Utility.getHomeOfFarmer(Game1.player);
        bool placed = false;
        for (int y = 4; y < 20 && !placed; y++)
        for (int x = 2; x < 30; x++)
        {
            Point origin = new(x, y);
            Point beside = new(x + 1, y);
            if (!scene.isTileOnMap(origin) || !scene.isTileOnMap(beside)
                || scene.IsTileBlockedBy(new Vector2(x, y)) || scene.IsTileBlockedBy(new Vector2(x + 1, y)))
                continue;
            npc.controller = null;
            Game1.warpCharacter(npc, scene, new Vector2(x, y));
            placed = true;
            break;
        }
        if (!placed)
            throw new InvalidOperationException("验收副本的房间没有可用的相邻空格。");
        Point[] offsets = { new(0, 1), new(1, 0), new(0, -1), new(-1, 0) };
        for (int i = 0; i < offsets.Length; i++)
        {
            Point tile = npc.TilePoint + offsets[i];
            if (!npc.currentLocation.isTileOnMap(tile) || npc.currentLocation.IsTileBlockedBy(new Vector2(tile.X, tile.Y)))
                continue;
            this.memoryTestAfterWarp = afterOpen;
            LocationRequest request = Game1.getLocationRequest(npc.currentLocation.NameOrUniqueName);
            request.OnWarp += () => this.MemoryTestProgress("start-talk", "已到阿比盖尔旁边。");
            this.MemoryTestProgress("warping", "传送到阿比盖尔旁边。");
            Game1.warpFarmer(request, tile.X, tile.Y, new[] { 0, 3, 2, 1 }[i]);
            return;
        }
        throw new InvalidOperationException("阿比盖尔周围没有可站立的格子。");
    }

    private bool MemoryTestHasReply()
    {
        if (this.talk is null)
            throw new InvalidOperationException("测试对话在收到回复前结束。");
        return !this.talk.Waiting && this.talk.Shown is not null
            && Game1.activeClickableMenu is DialogueBox { transitioning: false };
    }

    private void BeginMemoryTestLine(string label)
    {
        (string line, string after) = label switch
        {
            "learn-cat" => ("请记住一件重要的事：我的紫色小猫叫星糖，明天我会再问你。", "learned-cat"),
            "ask-cat" => ("我养的紫色小猫叫什么名字？", "asked-cat"),
            "learn-farm" => ("再告诉你一件重要的事：我明天打算把农场改名为青岚农场，请记住。", "learned-farm"),
            "ask-rollback" => ("我的小猫叫什么？我有没有告诉过你要给农场换名字？", "asked-rollback"),
            "learn-kite" => ("记住我们的计划：明天一起做一只紫色风筝，这是我很期待的重要约定。", "learned-kite"),
            "ask-restart" => ("我们刚刚约好要做的风筝是什么颜色？", "asked-restart"),
            "ask-fork" => ("我的小猫叫什么？我之前和你约好要一起做什么东西吗？", "asked-fork"),
            "learn-boat" => ("记住一件重要计划：我后天要在海边放金色纸船，到时一起去。", "learned-boat"),
            _ => throw new InvalidOperationException("未知的验收对话。"),
        };
        this.memoryTestLabel = label; this.memoryTestLine = line; this.memoryTestAfterReply = after;
        if (!this.MemoryTestHasReply() || this.talk!.End)
            throw new InvalidOperationException("NPC 已结束对话，不能提交验收文本。");
        this.MemoryTestProgress("input", "选择原版“自己说”输入框。");
        this.ChooseMemoryTestResponse(this.talk.Options.Count);
    }

    private void ChooseMemoryTestResponse(int index)
    {
        DialogueBox box = (DialogueBox)Game1.activeClickableMenu;
        if (box.transitioning)
            throw new InvalidOperationException("不能在对话框过渡时选择。");
        box.finishTyping(); box.selectedResponse = index; box.receiveLeftClick(0, 0);
    }

    private void CloseMemoryTestTalk(string afterClose)
    {
        this.memoryTestAfterClose = afterClose;
        this.MemoryTestProgress("closing", "通过原版选项离开对话。");
        if (this.talk!.End) Game1.exitActiveMenu();
        else this.ChooseMemoryTestResponse(this.talk.Options.Count + 1);
    }

    private void PauseMemoryTest(string stage, string message)
    {
        if (Game1.activeClickableMenu is null)
            Game1.drawObjectDialogue("记忆自动验收正在校验结果，请等待。");
        this.MemoryTestProgress(stage, message);
    }

    private void MemoryTestProgress(string stage, string message, bool completed = false, bool success = false)
    {
        if (this.memoryTest is not { } test)
            return;
        this.memoryTestStage = stage;
        this.Monitor.Log("[MemoryTest] " + message, completed && !success ? LogLevel.Warn : LogLevel.Info);
        string reportPath = Path.Combine(test.RunDirectory, "game-result.json");
        string report = JsonSerializer.Serialize(new { requestId = test.RequestId, stage, message, completed, success,
            saveFolder = test.SaveFolder, lineageId = this.lineageId, nonce = this.loadNonce, day = this.currentDay,
            pointer = this.savedCommit, generation = this.bridge.Generation, replies = this.memoryTestReplies,
            bubbleChecks = this.bubbleTestChecks, bubblePackets = this.bubbleTestPackets,
            letterChecks = this.letterTestChecks, letterPackets = this.letterTestPackets,
            worldReady = Context.IsWorldReady, saveProcessing = SaveGame.IsProcessing, newDay = Game1.newDay,
            events = this.memoryTestEvents, elapsedSeconds = Math.Round((DateTime.UtcNow - this.memoryTestStarted).TotalSeconds, 2) },
            new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(reportPath + ".tmp", report);
        File.Move(reportPath + ".tmp", reportPath, overwrite: true);
    }

    private void FinishMemoryTest(bool success, string message)
    {
        this.MemoryTestProgress(success ? "passed" : "failed", message, completed: true, success: success);
        this.memoryTest = null;
        if (!success && Context.IsWorldReady && Game1.activeClickableMenu is null)
            Game1.drawObjectDialogue("记忆自动验收已停止，请查看测试结果。关闭提示后可以继续游戏。");
    }
}
