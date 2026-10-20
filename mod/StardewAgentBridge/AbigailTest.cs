using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;

namespace StardewAgentBridge;

internal sealed partial class ModEntry
{
    private const string AbigailTestSave = "测试_436774213";
    private string? abigailTestRequest;
    private bool abigailTestManual;
    private string abigailTestStage = "";
    private DateTime abigailTestStarted;
    private NPC? abigailTestNpc;
    private Dialogue? abigailTestLastReply;
    private int abigailTestReplies;
    private int abigailTestTicks;

    private void BeginAbigailTestIfRequested()
    {
        string? request = Environment.GetEnvironmentVariable("STARDEW_AGENT_TEST_ABIGAIL");
        if (!Guid.TryParse(request, out _))
            return;
        this.abigailTestRequest = request;
        this.abigailTestManual = Environment.GetEnvironmentVariable("STARDEW_AGENT_TEST_ABIGAIL_MANUAL") == "1";
        this.abigailTestStarted = DateTime.UtcNow;
        this.AbigailTestProgress("load-menu", "准备点击加载，只选择“测试”存档。");
    }

    private void TickAbigailTest()
    {
        if (this.abigailTestRequest is null)
            return;
        if ((DateTime.UtcNow - this.abigailTestStarted).TotalSeconds > 150)
        {
            this.FinishAbigailTest(false, "自动测试超时；请确认游戏窗口处于前台。");
            return;
        }
        if (++this.abigailTestTicks % 10 != 0)
            return;

        try
        {
            switch (this.abigailTestStage)
            {
                case "load-menu":
                    if (Game1.activeClickableMenu is not TitleMenu title)
                        return;
                    title.skipToTitleButtons();
                    if (TitleMenu.subMenu is null)
                        title.performButtonAction("Load");
                    this.AbigailTestProgress("select-save", "已点击加载，正在查找“测试”存档。");
                    break;

                case "select-save":
                    if (TitleMenu.subMenu is not LoadGameMenu load || load.IsDoingTask())
                        return;
                    var matches = load.MenuSlots.OfType<LoadGameMenu.SaveFileSlot>()
                        .Where(slot => slot.Farmer.slotName == AbigailTestSave).ToList();
                    if (matches.Count != 1)
                        throw new InvalidOperationException("找不到唯一的测试存档：" + AbigailTestSave);
                    this.AbigailTestProgress("loading-save", "已点击“测试”存档，等待加载完成。");
                    matches[0].Activate();
                    break;

                case "loading-save":
                    if (!Context.IsWorldReady || !this.CanChat || Game1.activeClickableMenu is not null)
                        return;
                    if (Game1.player.Name != "测试" || Game1.uniqueIDForThisGame.ToString() != "436774213")
                        throw new InvalidOperationException("当前读入的不是指定测试存档，已停止。");
                    if (Game1.eventUp || Game1.isFestival())
                        throw new InvalidOperationException("当前有剧情或节日，不能开始自动对话测试。");
                    this.abigailTestNpc = Game1.getCharacterFromName("Abigail")
                        ?? throw new InvalidOperationException("当前世界里找不到阿比盖尔。");
                    this.WarpForAbigailTest(this.abigailTestNpc);
                    break;

                case "warping":
                    break; // The location request advances the scenario after the warp finishes.

                case "start-talk":
                    if (!Context.IsWorldReady || Game1.isWarping || Game1.activeClickableMenu is not null || !this.CanChat)
                        return;
                    NPC npc = this.abigailTestNpc!;
                    if (Game1.currentLocation != npc.currentLocation)
                        throw new InvalidOperationException("阿比盖尔已离开目标地图，请重新运行测试。");
                    if (this.abigailTestManual)
                    {
                        this.FinishAbigailTest(true, "已传送到阿比盖尔旁边，准备手动测试。");
                        // A vanilla message pauses the world until the player takes over; leave the NPC dialogue untouched.
                        Game1.drawObjectDialogue("手动测试已就绪。关闭提示后点击阿比盖尔，先看原版台词，再选择继续聊。可测试拼音输入、原版台词和 Esc 取消。");
                        return;
                    }
                    this.StartTalk(npc);
                    this.AbigailTestProgress("dialogue", "已传送到阿比盖尔旁边，开始测试三轮 AI 对话。");
                    break;

                case "dialogue":
                    if (this.talk is not { } talk)
                        throw new InvalidOperationException("测试对话在收到三轮回复前被关闭。");
                    if (talk.Waiting || talk.Shown is not { } shown || Game1.activeClickableMenu is not DialogueBox box || box.transitioning)
                        return;
                    if (!ReferenceEquals(this.abigailTestLastReply, shown))
                    {
                        this.abigailTestLastReply = shown;
                        this.abigailTestReplies++;
                        this.AbigailTestProgress("dialogue", $"已收到第 {this.abigailTestReplies} 轮回复。");
                    }
                    if (this.abigailTestReplies >= 3)
                    {
                        this.FinishAbigailTest(true, "三轮对话通过，保留第三轮对话框供你继续测试。");
                        return;
                    }
                    if (talk.End)
                        throw new InvalidOperationException("NPC 主动结束了对话，未完成三轮测试。");
                    // Go through the vanilla response callback and closing animation, including MenuChanged.
                    box.finishTyping();
                    box.selectedResponse = 0;
                    box.receiveLeftClick(0, 0);
                    break;
            }
        }
        catch (Exception error)
        {
            this.FinishAbigailTest(false, error.Message);
        }
    }

    private void WarpForAbigailTest(NPC npc)
    {
        GameLocation location = npc.currentLocation;
        Point origin = npc.TilePoint;
        Point[] offsets = { new(0, 1), new(1, 0), new(0, -1), new(-1, 0) };
        int[] facings = { 0, 3, 2, 1 };
        for (int i = 0; i < offsets.Length; i++)
        {
            Point tile = origin + offsets[i];
            Vector2 position = new(tile.X, tile.Y);
            if (!location.isTileOnMap(tile) || location.IsTileBlockedBy(position))
                continue;
            LocationRequest request = Game1.getLocationRequest(location.NameOrUniqueName);
            request.OnWarp += () => this.AbigailTestProgress("start-talk", "传送完成，等待开始对话。");
            this.AbigailTestProgress("warping", $"测试存档已加载，正在传送到 {location.NameOrUniqueName} 的阿比盖尔旁边。");
            Game1.warpFarmer(request, tile.X, tile.Y, facings[i]);
            return;
        }
        throw new InvalidOperationException("阿比盖尔周围没有可站立的相邻格子，已停止。");
    }

    private void AbigailTestProgress(string stage, string message, bool completed = false, bool success = false)
    {
        this.abigailTestStage = stage;
        this.Monitor.Log("[AbigailTest] " + message, success || !completed ? LogLevel.Info : LogLevel.Warn);
        string report = JsonSerializer.Serialize(new
        {
            requestId = this.abigailTestRequest,
            stage,
            message,
            completed,
            success,
            saveFolder = AbigailTestSave,
            npc = "Abigail",
            mode = this.abigailTestManual ? "manual" : "automatic",
            replies = this.abigailTestReplies,
            elapsedSeconds = Math.Round((DateTime.UtcNow - this.abigailTestStarted).TotalSeconds, 2),
        }, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(Path.Combine(this.Helper.DirectoryPath, "abigail-test-result.json"), report);
    }

    private void FinishAbigailTest(bool success, string message)
    {
        this.AbigailTestProgress(success ? "passed" : "failed", message, completed: true, success: success);
        this.abigailTestRequest = null;
        // Keep a failed unattended test paused instead of letting the farm run through more days.
        if (!success && Context.IsWorldReady && Game1.activeClickableMenu is null)
            Game1.drawObjectDialogue("自动测试已停止，请查看测试结果。关闭这段提示后可以继续游戏。");
    }
}
