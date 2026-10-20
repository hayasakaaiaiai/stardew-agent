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

/// <summary>One opt-in disposable-save scenario covering scenes, vanilla gifts, friendship, save and rollback.</summary>
internal sealed partial class ModEntry
{
    private readonly List<object> socialTestChecks = new();
    private readonly List<object> socialTestReplies = new();
    private readonly List<object> socialTestSceneLines = new();
    private int socialTestPhase;
    private int socialTestStep;
    private int socialTestTurn;
    private int socialTestBefore;
    private int socialTestSavedPoints;
    private int socialTestSavedGiftCount;
    private int socialTestFirstDay;
    private int socialTestExpected;
    private string socialTestFirstNonce = "";
    private string socialTestPartner = "";
    private bool socialTestLive;
    private bool socialTestCaptured;
    private static readonly int[] SocialDeltas = { 20, 10, 0, -20, -20, -20, -10, 0 };
    private NPC SocialNpc => Game1.getCharacterFromName("Abigail");
    private int SocialPoints => Game1.player.friendshipData["Abigail"].Points;

    private void SocialCheck(bool passed, string label, object? detail = null)
    {
        this.socialTestChecks.Add(new { label, passed, detail, phase = this.socialTestPhase, live = this.socialTestLive,
            day = this.currentDay, nonce = this.loadNonce, points = this.SocialPoints,
            gifts = Game1.player.friendshipData["Abigail"].GiftsToday, scenes = this.scenesToday });
        if (!passed) throw new InvalidOperationException("组合检查失败：" + label);
        this.MemoryTestProgress("social", "组合检查通过：" + label);
    }

    private void BeginSocialTest()
    {
        this.CheckMemoryTestSave();
        if (this.newPartsRunning) { this.ResumeNewPartsTest(); return; }
        if (this.socialTestPhase == 0)
        {
            Game1.player.friendshipData["Abigail"] = new Friendship(2000);
            this.ResetGifts();
            this.socialTestFirstDay = this.currentDay;
            this.socialTestFirstNonce = this.loadNonce;
        }
        this.config.ShowBubbles = false;
        this.config.SendLetters = false;
        this.config.NpcChat = true;
        this.config.ChatChangesFriendship = true;
        if (!this.bubbleTestRenderHook)
        {
            this.Helper.Events.Display.Rendered += (_, _) => this.CaptureBubbleTest();
            this.bubbleTestRenderHook = true;
        }
        this.socialTestStep = this.socialTestPhase == 0 ? 0 : this.socialTestPhase == 1 ? 50 : 70;
        this.WarpForMemoryTest("social");
    }

    private void PlaceSocialPair(string first, string second)
    {
        GameLocation room = Game1.currentLocation;
        foreach (NPC old in room.characters.ToArray())
        {
            if (old.Name == first || old.Name == second) continue;
            old.controller = null;
            old.Position = new Vector2(30 * 64, 30 * 64);
        }
        NPC a = Game1.getCharacterFromName(first), b = Game1.getCharacterFromName(second);
        a.controller = null; b.controller = null;
        Game1.warpCharacter(a, room, new Vector2(5, 8));
        Game1.warpCharacter(b, room, new Vector2(6, 8));
        a.isSleeping.Value = false; b.isSleeping.Value = false;
        a.IsInvisible = false; b.IsInvisible = false;
        a.ignoreScheduleToday = true; b.ignoreScheduleToday = true;
        a.Halt(); b.Halt(); a.isEmoting = false; b.isEmoting = false;
        Game1.player.Position = new Vector2(5 * 64, 9 * 64);
        Game1.player.CanMove = true;
        this.socialTestPartner = second;
    }

    private void CloseSocialMenu()
    {
        if (Game1.activeClickableMenu is not null) Game1.exitActiveMenu();
        Game1.dialogueUp = false;
        Game1.player.CanMove = true;
        this.offerFor = null; this.startFor = null;
    }

    private void HoldSocialGift(string id)
    {
        this.CloseSocialMenu();
        Game1.player.CurrentToolIndex = 0;
        Game1.player.ActiveObject = ItemRegistry.Create<StardewValley.Object>(id);
        this.socialTestBefore = Game1.player.friendshipData["Abigail"].GiftsToday;
    }

    private void GiveSocialGift(string label)
    {
        this.SocialCheck(this.SocialNpc.tryToReceiveActiveObject(Game1.player, false)
            && Game1.player.friendshipData["Abigail"].GiftsToday == this.socialTestBefore + 1, label);
        this.CloseSocialMenu();
    }

    private void SocialLine(string line, string label, int next)
    {
        this.socialTestBefore = this.SocialPoints;
        this.memoryTestLine = line; this.memoryTestLabel = label; this.memoryTestAfterReply = "social";
        this.socialTestStep = next;
        this.MemoryTestProgress("input", "通过原版输入框提交组合验收台词。");
        this.ChooseMemoryTestResponse(this.talk!.Options.Count);
    }

    private void SleepSocialTest()
    {
        this.CheckMemoryTestSave();
        this.memoryTestSleepDay = this.currentDay;
        FarmHouse home = Utility.getHomeOfFarmer(Game1.player);
        Point bed = home.getBedSpot();
        LocationRequest request = Game1.getLocationRequest(home.NameOrUniqueName);
        request.OnWarp += () =>
        {
            this.MemoryTestProgress("social", "通过原版睡觉保存礼物和好感。");
            Game1.currentLocation.answerDialogueAction("Sleep_Yes", Array.Empty<string>());
        };
        this.MemoryTestProgress("warping", "组合验收返回床边。");
        Game1.warpFarmer(request, bed.X, bed.Y, 2);
    }

    private void ReturnSocialTest()
    {
        Game1.ExitToTitle();
        this.MemoryTestProgress("social-title", "返回标题页，重新读入组合验收副本。");
    }

    private void TickSocialTest()
    {
        if (!Context.IsWorldReady || this.memoryTest is not { } test) return;
        switch (this.socialTestStep)
        {
            case 0:
                if (!Context.IsPlayerFree) return;
                this.PlaceSocialPair("Abigail", "Sebastian");
                Game1.timeOfDay = 600;
                this.config.NpcChat = false; this.TryStartScene();
                this.SocialCheck(this.scenesToday == 0, "scene-disabled");
                this.config.NpcChat = true;
                Game1.player.Position = new Vector2(5 * 64, 18 * 64); this.TryStartScene();
                this.SocialCheck(this.scenesToday == 0, "scene-player-outside-eight-tiles");
                Game1.player.Position = new Vector2(5 * 64, 9 * 64);
                Game1.getCharacterFromName("Sebastian").Position = new Vector2(8 * 64, 8 * 64); this.TryStartScene();
                this.SocialCheck(this.scenesToday == 0, "scene-npcs-outside-two-tiles");
                this.PlaceSocialPair("Abigail", "Sebastian");
                Game1.drawObjectDialogue("组合测试：菜单期间不应开始闲聊。"); this.TryStartScene();
                this.SocialCheck(this.scenesToday == 0, "scene-menu-blocks");
                this.CloseSocialMenu(); Game1.eventUp = true; this.TryStartScene();
                this.SocialCheck(this.scenesToday == 0, "scene-event-blocks");
                Game1.eventUp = false; this.talk = new Talk(this.SocialNpc); this.TryStartScene();
                this.SocialCheck(this.scenesToday == 0, "scene-ai-talk-blocks");
                this.talk = null; this.socialTestStep = 1;
                break;
            case 1:
                if (!Context.IsPlayerFree) return;
                this.TryStartScene();
                this.SocialCheck(this.scenesToday == 1, "scene-first-request");
                this.socialTestStep = 2;
                break;
            case 2:
                if (!this.socialTestCaptured && this.socialTestSceneLines.Count >= 1)
                {
                    this.RequestBubbleCapture("social-scene-fixed"); this.socialTestCaptured = true;
                }
                if (this.sceneRequestSeq != 0 || this.sceneLines.Count > 0 || this.bubbleTestCapture is not null) return;
                this.SocialCheck(this.socialTestSceneLines.Count >= 2, "scene-native-lines-shown");
                Game1.timeOfDay = 700; this.TryStartScene();
                this.SocialCheck(this.scenesToday == 1, "scene-pair-once-daily");
                this.PlaceSocialPair("Abigail", "Alex"); Game1.timeOfDay = 650; this.TryStartScene();
                this.SocialCheck(this.scenesToday == 1, "scene-fifty-minute-gap-blocks");
                Game1.timeOfDay = 700; this.TryStartScene();
                this.SocialCheck(this.scenesToday == 2, "scene-sixty-minute-gap-allows");
                this.socialTestStep = 3;
                break;
            case 3:
                if (this.sceneRequestSeq != 0 || this.sceneLines.Count > 0) return;
                if (this.scenesToday < 4)
                {
                    this.PlaceSocialPair("Abigail", this.scenesToday == 2 ? "Sam" : "Penny");
                    Game1.timeOfDay = this.scenesToday == 2 ? 800 : 900; this.TryStartScene();
                    return;
                }
                this.PlaceSocialPair("Abigail", "Maru"); Game1.timeOfDay = 1000; this.TryStartScene();
                this.SocialCheck(this.scenesToday == 4, "scene-four-daily-cap");
                this.HoldSocialGift("(O)66"); this.socialTestStep = 21;
                break;
            case 21:
                this.GiveSocialGift("gift-native-amethyst-counter"); this.socialTestStep = 22;
                break;
            case 22:
                this.CloseSocialMenu();
                if (!this.CanChat) return;
                this.SocialCheck(this.giftCounts["Abigail"] == this.socialTestBefore + 1, "gift-mod-detected-and-acknowledged");
                int beforeDefense = this.SocialPoints;
                this.config.ChatChangesFriendship = false; this.ApplyFriendship(this.SocialNpc, 20);
                this.SocialCheck(this.SocialPoints == beforeDefense, "friendship-disabled-native-zero");
                this.config.ChatChangesFriendship = true;
                this.ApplyFriendship(this.SocialNpc, 999);
                this.SocialCheck(this.SocialPoints == beforeDefense + 30, "friendship-mod-positive-defense");
                this.ApplyFriendship(this.SocialNpc, -999);
                this.SocialCheck(this.SocialPoints == beforeDefense - 40, "friendship-mod-negative-defense");
                // Restore this disposable fixture before exercising the backend's independent accounting.
                Game1.player.friendshipData["Abigail"].Points = beforeDefense; this.ClearFriendshipToday();
                this.socialTestBefore = this.SocialPoints;
                this.StartTalk(this.SocialNpc); this.socialTestStep = 30;
                break;
            case 30:
                if (!this.MemoryTestHasReply()) return;
                this.SocialCheck(this.SocialPoints == this.socialTestBefore, "friendship-opening-zero");
                this.socialTestTurn = 0; this.socialTestStep = 31;
                break;
            case 31:
                if (!this.MemoryTestHasReply()) return;
                this.socialTestExpected = SocialDeltas[this.socialTestTurn];
                this.SocialLine((this.socialTestTurn < 3 ? "好感2 " : "好感-2 ") + "组合验收第" + this.socialTestTurn + "轮", "fixed-cap-" + this.socialTestTurn, 32);
                break;
            case 32:
                this.SocialCheck(this.SocialPoints - this.socialTestBefore == this.socialTestExpected, "friendship-native-delta-" + this.socialTestTurn,
                    new { expected = this.socialTestExpected, actual = this.SocialPoints - this.socialTestBefore });
                if (this.socialTestTurn == 2) this.SocialCheck(this.friendshipToday["Abigail"] == 30, "friendship-positive-cap");
                if (++this.socialTestTurn < SocialDeltas.Length) this.socialTestStep = 31;
                else
                {
                    this.SocialCheck(this.friendshipToday["Abigail"] == -40, "friendship-negative-cap");
                    this.socialTestStep = 40; this.CloseMemoryTestTalk("social");
                }
                break;
            case 40:
                this.socialTestStep = 41; this.SleepSocialTest();
                break;
            case 41:
                if (!this.CanChat || Game1.activeClickableMenu is not null || Game1.newDay
                    || this.currentDay != this.memoryTestSleepDay + 1 || this.savedCommit?.DayEnded != this.memoryTestSleepDay) return;
                this.socialTestSavedPoints = this.SocialPoints;
                this.socialTestSavedGiftCount = Game1.player.friendshipData["Abigail"].GiftsToday;
                this.SocialCheck(this.friendshipToday.Count == 0 && this.scenesToday == 0, "new-day-resets-caps");
                this.socialTestPhase = 1; this.ReturnSocialTest();
                break;
            case 50:
                this.SocialCheck(this.loadNonce != this.socialTestFirstNonce && this.currentDay == this.socialTestFirstDay + 1
                    && this.SocialPoints == this.socialTestSavedPoints, "friendship-real-save-and-reload");
                this.HoldSocialGift("(O)330"); this.socialTestStep = 51;
                break;
            case 51:
                this.GiveSocialGift("gift-native-clay-counter"); this.socialTestStep = 52;
                break;
            case 52:
                this.CloseSocialMenu(); if (!this.CanChat) return;
                this.StartTalk(this.SocialNpc); this.socialTestStep = 53;
                break;
            case 53:
                if (!this.MemoryTestHasReply()) return;
                this.SocialLine("好感-2 请记住这份新礼物。", "unsaved-clay", 54);
                break;
            case 54:
                this.SocialCheck(this.SocialPoints == this.socialTestBefore - 20, "friendship-unsaved-negative");
                this.socialTestStep = 55; this.CloseMemoryTestTalk("social");
                break;
            case 55:
                this.socialTestPhase = 2; this.ReturnSocialTest();
                break;
            case 70:
                this.SocialCheck(this.SocialPoints == this.socialTestSavedPoints, "friendship-unsaved-rollback");
                this.SocialCheck(Game1.player.friendshipData["Abigail"].GiftsToday == this.socialTestSavedGiftCount
                    && this.friendshipToday.Count == 0, "gift-counter-and-chat-cap-rollback");
                this.StartTalk(this.SocialNpc); this.socialTestStep = 71;
                break;
            case 71:
                if (!this.MemoryTestHasReply()) return;
                this.SocialLine("好感0 我昨天送了你什么？", "saved-gift-recall-after-rollback", 72);
                break;
            case 72:
                this.socialTestStep = 80; this.CloseMemoryTestTalk("social");
                break;
            case 80:
                if (test.Offline) { if (test.NewParts) this.BeginNewPartsTest(); else this.MemoryTestProgress("return-finish", "三项固定模型组合检查完成。"); break; }
                this.MemoryTestProgress("social", "social-real-ready");
                string path = Path.Combine(test.RunDirectory, "control.json");
                if (!File.Exists(path)) return;
                using (JsonDocument control = JsonDocument.Parse(File.ReadAllText(path)))
                {
                    if (control.RootElement.GetProperty("requestId").GetString() != test.RequestId
                        || control.RootElement.GetProperty("stage").GetString() != "social-real-ready") return;
                }
                this.socialTestLive = true;
                this.PlaceSocialPair("Gus", "Pam"); Game1.timeOfDay = 1200; this.TryStartScene();
                this.socialTestCaptured = false;
                this.socialTestTurn = this.socialTestSceneLines.Count; this.socialTestStep = 81;
                break;
            case 81:
                if (!this.socialTestCaptured && this.socialTestSceneLines.Count > this.socialTestTurn)
                {
                    this.RequestBubbleCapture("social-scene-real"); this.socialTestCaptured = true;
                }
                if (this.sceneRequestSeq != 0 || this.sceneLines.Count > 0 || this.bubbleTestCapture is not null) return;
                this.SocialCheck(this.socialTestSceneLines.Count - this.socialTestTurn >= 2, "scene-real-model-native-lines");
                this.socialTestStep = 90; this.WarpForMemoryTest("social");
                break;
            case 90:
                if (!this.CanChat || !Context.IsPlayerFree) return;
                this.socialTestBefore = this.SocialPoints; this.StartTalk(this.SocialNpc); this.socialTestStep = 91;
                break;
            case 91:
                if (!this.MemoryTestHasReply()) return;
                this.SocialCheck(this.SocialPoints == this.socialTestBefore, "friendship-real-opening-zero");
                this.SocialLine("我昨天送给你的礼物是什么？你喜欢吗？", "real-gift-recall", 92);
                break;
            case 92:
                this.SocialCheck(this.talk!.Reply.Contains("紫水晶"), "gift-real-model-remembers-amethyst", this.talk.Reply);
                this.SocialLine("你画的那幅画真好看，我很喜欢。", "real-positive", 93);
                break;
            case 93:
                this.SocialCheck(this.SocialPoints > this.socialTestBefore, "friendship-real-positive", this.talk!.Reply);
                this.SocialLine("你那头紫头发真难看。", "real-negative", 94);
                break;
            case 94:
                this.SocialCheck(this.SocialPoints < this.socialTestBefore, "friendship-real-negative", this.talk!.Reply);
                this.socialTestStep = 95; this.CloseMemoryTestTalk("social");
                break;
            case 95:
                if (test.NewParts) this.BeginNewPartsTest();
                else this.MemoryTestProgress("return-finish", "三项固定模型和真实模型组合检查完成。");
                break;
        }
    }
}
