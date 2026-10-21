using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>Opt-in native bubble checks; only the isolated MemoryTest launcher enables these.</summary>
internal sealed partial class ModEntry
{
    private readonly List<object> bubbleTestChecks = new();
    private readonly List<object> bubbleTestPackets = new();
    private NPC? bubbleTestNpc;
    private int bubbleTestStep;
    private bool bubbleTestReloaded;
    private bool bubbleTestRenderHook;
    private string bubbleTestOldNonce = "";
    private string? bubbleTestCapture;
    private DateTime bubbleTestCaptureAt;
    private string BubbleText(NPC? npc) => npc is null ? "" : this.Helper.Reflection.GetField<object>(npc, "textAboveHead").GetValue()?.ToString() ?? "";

    private void RecordBubbleTestPacket()
    {
        if (this.memoryTest is null) return;
        this.bubbleTestPackets.Add(new { nonce = this.loadNonce, day = this.currentDay,
            npcs = this.bubbles.ToDictionary(pair => pair.Key, pair => pair.Value.Select(line => new { text = line.Text, emote = line.Emote }).ToArray()) });
        this.MemoryTestProgress(this.memoryTestStage, "收到当前读档的气泡数据。");
    }

    private void BeginBubbleTest(NPC npc)
    {
        this.CheckMemoryTestSave();
        this.bubbleTestNpc = npc;
        this.bubbleTestStep = this.bubbleTestReloaded ? 10 : 0;
        if (!this.bubbleTestRenderHook)
        {
            this.Helper.Events.Display.Rendered += (_, _) => this.CaptureBubbleTest();
            this.bubbleTestRenderHook = true;
        }
        this.MemoryTestProgress("bubbles-only", "开始原生气泡自动检查。");
    }

    private void BubbleCheck(bool passed, string label)
    {
        this.bubbleTestChecks.Add(new { label, passed, nonce = this.loadNonce, at = Game1.timeOfDay,
            shown = this.bubblesShown.Count, text = this.BubbleText(this.bubbleTestNpc),
            emote = this.bubbleTestNpc?.CurrentEmote, free = StardewModdingAPI.Context.IsPlayerFree,
            distance = this.bubbleTestNpc is null ? -1 : Vector2.Distance(this.bubbleTestNpc.Tile, Game1.player.Tile) });
        if (!passed) throw new InvalidOperationException("气泡检查失败：" + label + $"；shown={this.bubblesShown.Count}，text={this.BubbleText(this.bubbleTestNpc)}，emote={this.bubbleTestNpc?.CurrentEmote}，free={StardewModdingAPI.Context.IsPlayerFree}");
        this.MemoryTestProgress("bubbles-only", "气泡检查通过：" + label);
    }

    private void PlaceBubblePlayer(int distance)
    {
        NPC npc = this.bubbleTestNpc!;
        foreach (Point delta in new[] { new Point(distance, 0), new Point(-distance, 0), new Point(0, distance), new Point(0, -distance) })
        {
            Point tile = npc.TilePoint + delta;
            if (!npc.currentLocation.isTileOnMap(tile) || npc.currentLocation.IsTileBlockedBy(new Vector2(tile.X, tile.Y))) continue;
            Game1.player.Position = new Vector2(tile.X * 64, tile.Y * 64);
            return;
        }
        throw new InvalidOperationException("找不到指定距离的可站立格子。");
    }

    private void RequestBubbleCapture(string name)
    {
        this.bubbleTestCapture = name;
        this.bubbleTestCaptureAt = DateTime.UtcNow.AddMilliseconds(1200);
    }

    private void CaptureBubbleTest()
    {
        if ((this.memoryTest?.BubblesOnly != true && this.memoryTest?.MailOnly != true && this.memoryTest?.Social != true) || this.bubbleTestCapture is not { } name || DateTime.UtcNow < this.bubbleTestCaptureAt) return;
        this.bubbleTestCapture = null;
        try
        {
            if (this.memoryTest.MailOnly || ((this.newPartsRunning || this.newsTestRunning || this.townTestRunning) && Game1.activeClickableMenu is not null))
            {
                // Menus live in Stardew's separate UI render target, not the world back buffer.
                RenderTarget2D ui = Game1.game1.uiScreen;
                using FileStream capture = File.Create(Path.Combine(this.memoryTest.RunDirectory, name + ".png"));
                ui.SaveAsPng(capture, ui.Width, ui.Height);
                this.letterTestChecks.Add(new { label = "capture-" + name, passed = true, width = ui.Width, height = ui.Height, layer = "native-ui-target" });
                return;
            }
            GraphicsDevice device = Game1.game1.GraphicsDevice;
            int width = device.PresentationParameters.BackBufferWidth, height = device.PresentationParameters.BackBufferHeight;
            Color[] pixels = new Color[width * height];
            device.GetBackBufferData(pixels);
            // Stardew's OpenGL back buffer is bottom-up; PNG rows are top-down.
            for (int y = 0; y < height / 2; y++)
            for (int x = 0; x < width; x++)
            {
                int a = y * width + x, b = (height - 1 - y) * width + x;
                (pixels[a], pixels[b]) = (pixels[b], pixels[a]);
            }
            using Texture2D image = new(device, width, height);
            image.SetData(pixels);
            using FileStream output = File.Create(Path.Combine(this.memoryTest.RunDirectory, name + ".png"));
            image.SaveAsPng(output, width, height);
            (this.memoryTest.MailOnly ? this.letterTestChecks : this.bubbleTestChecks).Add(new { label = "capture-" + name, passed = true, width, height });
        }
        catch (Exception error)
        {
            (this.memoryTest.MailOnly ? this.letterTestChecks : this.bubbleTestChecks).Add(new { label = "capture-" + name, passed = false, error = error.Message });
        }
    }

    private void TickBubbleTest()
    {
        if (this.bubbleTestNpc is not { } npc || !this.bubbles.TryGetValue("abigail", out var lines) || lines.Count != 2) return;
        switch (this.bubbleTestStep)
        {
            case 0:
                this.config.ShowBubbles = false;
                this.TickBubbles();
                this.BubbleCheck(this.bubblesShown.Count == 0, "disabled");
                this.config.ShowBubbles = true;
                this.PlaceBubblePlayer(6);
                this.TickBubbles();
                this.BubbleCheck(this.bubblesShown.Count == 0, "outside-six-tiles");
                this.PlaceBubblePlayer(5);
                Game1.drawObjectDialogue("气泡测试：菜单期间不应显示。");
                this.TickBubbles();
                this.BubbleCheck(this.bubblesShown.Count == 0, "menu-blocks");
                Game1.exitActiveMenu();
                Game1.dialogueUp = false;
                Game1.player.CanMove = true;
                Game1.eventUp = true;
                this.TickBubbles();
                this.BubbleCheck(this.bubblesShown.Count == 0, "event-blocks");
                Game1.eventUp = false;
                this.talk = new Talk(npc) { Waiting = true };
                this.TickBubbles();
                this.BubbleCheck(this.bubblesShown.Count == 0, "ai-conversation-blocks");
                this.talk = null;
                this.BubbleCheck(!this.bubbles.ContainsKey("sam"), "no-unlisted-npc");
                this.bubbleTestStep = 3;
                break;
            case 3:
                if (!StardewModdingAPI.Context.IsPlayerFree) return;
                // The fixture moved Abigail out of bed; clear her old sleeping emote before checking the new one.
                npc.isEmoting = false;
                Game1.timeOfDay = 650;
                this.TickBubbles();
                this.BubbleCheck(this.bubblesShown.Count == 1 && this.BubbleText(npc) == lines[0].Text
                    && npc.CurrentEmote == BubbleEmotes[lines[0].Emote], "first-at-five-tiles");
                this.RequestBubbleCapture("bubble-first");
                this.bubbleTestStep = 1;
                break;
            case 1:
                if (this.bubbleTestCapture is not null) return;
                Game1.timeOfDay = 740;
                this.TickBubbles();
                this.BubbleCheck(this.bubblesShown.Count == 1, "fifty-minute-cooldown");
                npc.isEmoting = false;
                Game1.timeOfDay = 750;
                this.TickBubbles();
                this.BubbleCheck(this.bubblesShown.Count == 2 && this.BubbleText(npc) == lines[1].Text
                    && npc.CurrentEmote == BubbleEmotes[lines[1].Emote], "second-at-sixty-minutes");
                this.RequestBubbleCapture("bubble-second");
                this.bubbleTestStep = 2;
                break;
            case 2:
                if (this.bubbleTestCapture is not null) return;
                Game1.timeOfDay = 850;
                this.TickBubbles();
                this.BubbleCheck(this.bubblesShown.Count == 2, "no-third-or-repeat");
                this.bubbleTestOldNonce = this.loadNonce;
                this.bubbleTestReloaded = true;
                Game1.ExitToTitle();
                this.MemoryTestProgress("wait-bubbles-title", "不保存退出后重新加载副本。");
                break;
            case 10:
                this.BubbleCheck(this.loadNonce != this.bubbleTestOldNonce && this.bubblesShown.Count == 0 && this.bubbleShownAt.Count == 0, "reload-clears-consumed-state");
                this.PlaceBubblePlayer(1);
                npc.isEmoting = false;
                this.TickBubbles();
                this.BubbleCheck(this.bubblesShown.Count == 1 && this.BubbleText(npc) == lines[0].Text, "reload-shows-first-again");
                this.RequestBubbleCapture("bubble-reload");
                this.bubbleTestStep = 11;
                break;
            case 11:
                if (this.bubbleTestCapture is not null) return;
                this.MemoryTestProgress("return-finish", "气泡自动检查完成，返回标题页。");
                break;
        }
    }
}
