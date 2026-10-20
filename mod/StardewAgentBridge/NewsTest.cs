using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>Native heart tiers and news delivery, continued in the same disposable save.</summary>
internal sealed partial class ModEntry
{
    private readonly List<object> newsTestChecks = new();
    private readonly List<int> newsTestReports = new();
    private bool newsTestRunning;
    private int newsTestStep;
    private int newsTestPhase;
    private int newsTestHeart;
    private int newsTestBefore;
    private int newsTestRequest;
    private int newsTestLines;
    private bool newsTestCaptured;
    private static readonly (string Npc, int Hearts, FriendshipStatus Status, bool Roommate, int Gain, int Loss)[] HeartCases =
    {
        ("Sam", 0, FriendshipStatus.Friendly, false, 5, 20),
        ("Haley", 1, FriendshipStatus.Friendly, false, 5, 20),
        ("Alex", 2, FriendshipStatus.Friendly, false, 10, 15),
        ("Elliott", 4, FriendshipStatus.Friendly, false, 10, 15),
        ("Leah", 5, FriendshipStatus.Friendly, false, 15, 10),
        ("Penny", 7, FriendshipStatus.Friendly, false, 15, 10),
        ("Maru", 8, FriendshipStatus.Friendly, false, 20, 5),
        ("Abigail", 3, FriendshipStatus.Dating, false, 20, 5),
        ("Shane", 3, FriendshipStatus.Engaged, false, 20, 5),
        ("Emily", 3, FriendshipStatus.Married, false, 20, 5),
        ("Krobus", 3, FriendshipStatus.Married, true, 20, 5),
    };

    private void NewsCheck(bool passed, string label, object? detail = null)
    {
        this.newsTestChecks.Add(new { label, passed, detail, phase = this.newsTestPhase, day = this.currentDay, nonce = this.loadNonce });
        if (!passed) throw new InvalidOperationException("传话和分档检查失败：" + label);
        this.MemoryTestProgress("news", "分档和传话检查通过：" + label);
    }

    private bool NewsGate(string stage)
    {
        this.MemoryTestProgress("news", stage);
        string path = Path.Combine(this.memoryTest!.RunDirectory, "control.json");
        if (!File.Exists(path)) return false;
        using JsonDocument data = JsonDocument.Parse(File.ReadAllText(path));
        return data.RootElement.GetProperty("requestId").GetString() == this.memoryTest.RequestId
            && data.RootElement.GetProperty("stage").GetString() == stage;
    }

    private void BeginNewsTest()
    {
        this.newPartsRunning = false; this.newsTestRunning = true;
        this.config.InPersonGifts = false; this.newsTestStep = 0;
        this.MemoryTestProgress("news", "开始心数分档和传话原生检查。");
    }

    private void ResumeNewsTest()
    {
        this.newsTestStep = this.newsTestPhase == 1 ? 60 : 80;
        this.WarpForMemoryTest("news");
    }

    private void NewsTalk(string id, int next)
    {
        this.CloseSocialMenu();
        NPC npc = Game1.getCharacterFromName(id);
        npc.controller = null; npc.ignoreScheduleToday = true; npc.isSleeping.Value = false; npc.IsInvisible = false;
        Game1.warpCharacter(npc, Game1.currentLocation, new Vector2(7, 8));
        npc.Halt(); Game1.player.CanMove = true;
        if (!Game1.player.friendshipData.ContainsKey(id)) Game1.player.friendshipData[id] = new Friendship(2000);
        this.newsTestBefore = Game1.player.friendshipData[id].Points;
        this.StartTalk(npc); this.newsTestStep = next;
    }

    private void NewsLine(string text, string label, int next)
    {
        this.memoryTestLine = text; this.memoryTestLabel = label; this.memoryTestAfterReply = "news";
        this.newsTestStep = next; this.MemoryTestProgress("input", "通过原版输入框检查好感分档和传话。");
        this.ChooseMemoryTestResponse(this.talk!.Options.Count);
    }

    private void NewsScene(string a, string b, int time, int next)
    {
        this.PlaceSocialPair(a, b); Game1.timeOfDay = time;
        this.newsTestLines = this.socialTestSceneLines.Count;
        this.TryStartScene(); this.newsTestRequest = this.sceneRequestSeq;
        this.NewsCheck(this.newsTestRequest != 0, "news-scene-request-" + next);
        this.newsTestStep = next;
    }

    private bool NewsSceneFinished() => this.sceneRequestSeq == 0 && this.sceneLines.Count == 0 && this.sceneShowing == 0 && this.CanChat;

    private void TickNewsTest()
    {
        if (!Context.IsWorldReady || this.memoryTest is not { } test) return;
        switch (this.newsTestStep)
        {
            case 0:
                if (!this.NewsGate("news-fixed-ready")) return;
                this.newsTestStep = 1; break;
            case 1:
                var sample = HeartCases[this.newsTestHeart];
                Game1.player.friendshipData[sample.Npc] = new Friendship(sample.Hearts * 250 + 125)
                    { Status = sample.Status, RoommateMarriage = sample.Roommate };
                NPC person = Game1.getCharacterFromName(sample.Npc);
                string label = "heart-" + this.newsTestHeart;
                this.NewsCheck(GameState.Hearts(person) == sample.Hearts, label + "-native-standing",
                    new { npc = sample.Npc, hearts = GameState.Hearts(person), relation = GameState.Relation(person), gain = sample.Gain, loss = sample.Loss });
                this.NewsTalk(sample.Npc, 2); break;
            case 2:
                if (!this.MemoryTestHasReply()) return;
                this.NewsLine("好感1 谢谢你的帮助。", "heart-positive-" + this.newsTestHeart, 3); break;
            case 3:
                var positive = HeartCases[this.newsTestHeart];
                int points = Game1.player.friendshipData[positive.Npc].Points;
                this.NewsCheck(points - this.newsTestBefore == positive.Gain, "heart-" + this.newsTestHeart + "-gain",
                    new { expected = positive.Gain, actual = points - this.newsTestBefore });
                this.newsTestBefore = points;
                this.NewsLine("好感-1 你真讨厌。", "heart-negative-" + this.newsTestHeart, 4); break;
            case 4:
                var negative = HeartCases[this.newsTestHeart];
                this.NewsCheck(Game1.player.friendshipData[negative.Npc].Points - this.newsTestBefore == -negative.Loss,
                    "heart-" + this.newsTestHeart + "-loss", new { expected = -negative.Loss,
                        actual = Game1.player.friendshipData[negative.Npc].Points - this.newsTestBefore });
                Game1.player.friendshipData[negative.Npc].Status = FriendshipStatus.Friendly;
                Game1.player.friendshipData[negative.Npc].RoommateMarriage = false;
                Game1.player.friendshipData[negative.Npc].Points = 2000;
                this.newsTestStep = ++this.newsTestHeart < HeartCases.Length ? 1 : 10;
                this.CloseMemoryTestTalk("news"); break;
            case 10:
                if (!this.NewsGate("news-learn-ready")) return;
                this.NewsTalk("Abigail", 11); break;
            case 11:
                if (!this.MemoryTestHasReply()) return;
                this.NewsLine("我养的小猫叫星糖，你可以跟朋友们说。", "news-public-cat", 12); break;
            case 12:
                this.newsTestStep = 13; this.CloseMemoryTestTalk("news"); break;
            case 13:
                Game1.player.friendshipData["Harvey"] = new Friendship(2000);
                this.NewsTalk("Harvey", 14); break;
            case 14:
                if (!this.MemoryTestHasReply()) return;
                this.NewsLine("这是秘密，别告诉别人：我其实很怕黑。", "news-private-secret", 15); break;
            case 15:
                this.newsTestStep = 16; this.CloseMemoryTestTalk("news"); break;
            case 16:
                this.newsTestStep = 17; this.NewPartsSleep(); break;
            case 17:
                if (!this.CanChat || Game1.newDay || this.currentDay != this.memoryTestSleepDay + 1
                    || this.savedCommit?.DayEnded != this.memoryTestSleepDay || Game1.activeClickableMenu is not null) return;
                this.WarpForMemoryTest("news"); this.newsTestStep = 20; break;
            case 20:
                if (!this.NewsGate("news-night-ready")) return;
                this.NewsScene("Abigail", "Sebastian", 600, 21); break;
            case 21:
                if (this.socialTestSceneLines.Count == this.newsTestLines) return;
                // The listener leaves while the scene is on screen. It must not become a heard memory.
                Game1.warpCharacter(Game1.getCharacterFromName("Sebastian"), Game1.getFarm(), new Vector2(10, 10));
                this.newsTestStep = 22; break;
            case 22:
                if (!this.NewsSceneFinished()) return;
                this.NewsCheck(!this.newsTestReports.Contains(this.newsTestRequest), "news-departed-listener-not-confirmed");
                this.NewsScene("Abigail", "Sam", 700, 30); break;
            case 30:
                if (this.socialTestSceneLines.Count == this.newsTestLines) return;
                this.NewsTalk("Maru", 31); break;
            case 31:
                if (!this.MemoryTestHasReply() || this.sceneLines.Count > 0) return;
                this.NewsCheck(!this.newsTestReports.Contains(this.newsTestRequest) && this.sceneShowing == this.newsTestRequest,
                    "news-confirmation-waits-for-dialogue-close");
                this.newsTestStep = 32; this.CloseMemoryTestTalk("news"); break;
            case 32:
                if (!this.NewsSceneFinished()) return;
                this.NewsCheck(this.newsTestReports.Contains(this.newsTestRequest), "news-confirmed-after-last-line-and-dialogue-close");
                this.NewsTalk("Sam", 33); break;
            case 33:
                if (!this.MemoryTestHasReply()) return;
                this.NewsLine("阿比盖尔有没有跟你说过我的小猫？它叫什么？", "news-listener-before-rollback", 34); break;
            case 34:
                this.NewsCheck(this.talk!.Reply.Contains("星糖"), "news-listener-native-recall", this.talk.Reply);
                this.RequestBubbleCapture("news-listener"); this.newsTestStep = 35; break;
            case 35:
                if (this.bubbleTestCapture is not null) return;
                this.newsTestStep = 40; this.CloseMemoryTestTalk("news"); break;
            case 40:
                this.NewsScene("Harvey", "Robin", 800, 41); break;
            case 41:
                if (!this.NewsSceneFinished()) return;
                this.NewsCheck(this.socialTestSceneLines.Count > this.newsTestLines, "news-secret-ordinary-scene-shown");
                this.NewsScene("Abigail", "Gus", 900, 50); break;
            case 50:
                if (this.socialTestSceneLines.Count == this.newsTestLines) return;
                // The farm can start vanilla introduction events on this old save; the cave has no event asset.
                Game1.warpFarmer("FarmCave", 5, 5, 2);
                this.newsTestStep = 51; break;
            case 51:
                if (Game1.isWarping || !this.NewsSceneFinished()) return;
                this.NewsCheck(!this.newsTestReports.Contains(this.newsTestRequest), "news-map-change-not-confirmed");
                this.newsTestPhase = 1; this.ReturnSocialTest(); break;
            case 60:
                this.NewsTalk("Sam", 61); break;
            case 61:
                if (!this.MemoryTestHasReply()) return;
                this.NewsLine("阿比盖尔有没有跟你说过我的小猫？它叫什么？", "news-listener-after-rollback", 62); break;
            case 62:
                this.newsTestStep = 63; this.CloseMemoryTestTalk("news"); break;
            case 63:
                this.NewsScene("Abigail", "Sebastian", 600, 64); break;
            case 64:
                if (!this.newsTestCaptured && this.socialTestSceneLines.Count > this.newsTestLines)
                { this.RequestBubbleCapture("news-scene"); this.newsTestCaptured = true; }
                if (!this.NewsSceneFinished() || this.bubbleTestCapture is not null) return;
                this.NewsCheck(this.newsTestReports.Contains(this.newsTestRequest), "news-reload-scene-confirmed");
                Game1.player.friendshipData["Sebastian"] = new Friendship(2000);
                this.NewsTalk("Sebastian", 65); break;
            case 65:
                if (!this.MemoryTestHasReply()) return;
                this.NewsLine("阿比盖尔有没有跟你说过我的小猫？它叫什么？", "news-listener-before-save", 66); break;
            case 66:
                this.NewsCheck(this.talk!.Reply.Contains("星糖"), "news-second-listener-native-recall", this.talk.Reply);
                this.newsTestStep = 67; this.CloseMemoryTestTalk("news"); break;
            case 67:
                this.newsTestStep = 68; this.NewPartsSleep(); break;
            case 68:
                if (!this.CanChat || Game1.newDay || this.currentDay != this.memoryTestSleepDay + 1
                    || this.savedCommit?.DayEnded != this.memoryTestSleepDay || Game1.activeClickableMenu is not null) return;
                this.newsTestPhase = 2; this.ReturnSocialTest(); break;
            case 80:
                this.NewsTalk("Sebastian", 81); break;
            case 81:
                if (!this.MemoryTestHasReply()) return;
                this.NewsLine("阿比盖尔有没有跟你说过我的小猫？它叫什么？", "news-listener-saved-reload", 82); break;
            case 82:
                this.NewsCheck(this.talk!.Reply.Contains("星糖"), "news-saved-reload-native-recall", this.talk.Reply);
                this.newsTestStep = 83; this.CloseMemoryTestTalk("news"); break;
            case 83:
                this.NewsScene("Abigail", "Elliott", 600, 84); break;
            case 84:
                if (!this.NewsSceneFinished()) return;
                this.NewsCheck(this.socialTestSceneLines.Count > this.newsTestLines, "news-third-day-ordinary-scene-shown");
                this.MemoryTestProgress("return-finish", "分档、传话及此前所有功能的组合验收完成。"); break;
        }
    }
}
