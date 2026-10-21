using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>Real TimeChanged events, spatial groups and reliable news in the same disposable acceptance save.</summary>
internal sealed partial class ModEntry
{
    private readonly List<object> townTestChecks = new();
    private readonly List<object> townTestPackets = new();
    private readonly List<int> townTestHours = new();
    private bool townTestRunning;
    private int townTestStep;
    private int townTestPhase;
    private int townTestBefore;
    private int townTestClock;
    private const string TownPublic = "我给自己的蓝色风筝取名云尾，你可以跟朋友们说。";
    private const string TownString = "我答应周末给文森特做蓝色风筝。";
    private const string TownAsk = "最近有人告诉你我给蓝色风筝取了什么名字吗？";

    private void TownCheck(bool passed, string label, object? detail = null)
    {
        this.townTestChecks.Add(new { label, passed, detail, phase = this.townTestPhase, day = this.currentDay, nonce = this.loadNonce });
        if (!passed) throw new InvalidOperationException("后台传话检查失败：" + label);
        this.MemoryTestProgress("town", "后台传话检查通过：" + label);
    }

    private bool TownGate(string stage)
    {
        this.MemoryTestProgress(this.ambientTestRunning ? "ambient" : "town", stage);
        string path = Path.Combine(this.memoryTest!.RunDirectory, "control.json");
        if (!File.Exists(path)) return false;
        using JsonDocument data = JsonDocument.Parse(File.ReadAllText(path));
        return data.RootElement.GetProperty("requestId").GetString() == this.memoryTest.RequestId
            && data.RootElement.GetProperty("stage").GetString() == stage;
    }

    private void BeginTownTest()
    {
        this.newsTestRunning = false; this.townTestRunning = true;
        this.config.NpcChat = false; this.config.OffscreenNews = false;
        this.townTestStep = 0; this.MemoryTestProgress("town", "开始后台传话和低心数记忆验收。");
    }

    private void ResumeTownTest()
    {
        this.config.NpcChat = false; this.config.OffscreenNews = false;
        this.townTestStep = this.townTestPhase == 1 ? 60 : 80;
        this.WarpForMemoryTest("town");
    }

    private void TownPlace(string id, string map, int x, int y)
    {
        NPC npc = Game1.getCharacterFromName(id);
        npc.controller = null; npc.ignoreScheduleToday = true; npc.isSleeping.Value = false; npc.IsInvisible = false;
        Game1.warpCharacter(npc, Game1.getLocationFromName(map), new Vector2(x, y)); npc.Halt();
    }

    private void TownIsolate()
    {
        int offset = 0;
        foreach (string id in SocialNpcs)
            if (Game1.getCharacterFromName(id) is not null) this.TownPlace(id, "Backwoods", 100 + offset++ * 10, 100);
        this.ClearTown();
    }

    private void TownTalk(string id, int next)
    {
        this.NewsTalk(id, 0); this.townTestStep = next;
    }

    private void TownLine(string text, string label, int next)
    {
        this.memoryTestLine = text; this.memoryTestLabel = label; this.memoryTestAfterReply = "town";
        this.townTestStep = next; this.MemoryTestProgress("input", "通过原版输入框检查后台传话。");
        this.ChooseMemoryTestResponse(this.talk!.Options.Count);
    }

    private void TownHour(int time, int next)
    {
        this.townTestBefore = this.townTestPackets.Count; this.townTestClock = time;
        // SMAPI observes the actual game clock change on the next update; do not call OnTimeChanged directly.
        Game1.timeOfDay = time; this.townTestStep = next;
    }

    private bool TownHourDone(bool sent = true) => this.townTestHours.Contains(this.townTestClock)
        && (sent ? this.townTestPackets.Count > this.townTestBefore && this.CanChat : true);

    private void TickTownTest()
    {
        if (!StardewModdingAPI.Context.IsWorldReady) return;
        switch (this.townTestStep)
        {
            case 0:
                if (!this.TownGate("town-fixed-ready")) return;
                this.TownTalk("Abigail", 1); break;
            case 1:
                if (!this.MemoryTestHasReply()) return;
                this.TownLine(TownPublic, "town-public-wind", 2); break;
            case 2:
                this.townTestStep = 3; this.CloseMemoryTestTalk("town"); break;
            case 3:
                Game1.player.friendshipData["Jodi"] = new Friendship(0);
                this.TownTalk("Jodi", 4); break;
            case 4:
                if (!this.MemoryTestHasReply()) return;
                this.TownLine(TownString, "town-zero-heart-string-learn", 5); break;
            case 5:
                this.townTestStep = 6; this.CloseMemoryTestTalk("town"); break;
            case 6:
                this.TownTalk("Harvey", 7); break;
            case 7:
                if (!this.MemoryTestHasReply()) return;
                this.TownLine("谢谢你上次帮我的忙。", "town-thanks-only", 8); break;
            case 8:
                this.townTestStep = 9; this.CloseMemoryTestTalk("town"); break;
            case 9:
                this.townTestStep = 10; this.NewPartsSleep(); break;
            case 10:
                if (!this.CanChat || Game1.newDay || this.currentDay != this.memoryTestSleepDay + 1
                    || this.savedCommit?.DayEnded != this.memoryTestSleepDay || Game1.activeClickableMenu is not null) return;
                this.WarpForMemoryTest("town"); this.townTestStep = 11; break;
            case 11:
                if (!this.TownGate("town-night-ready")) return;
                this.TownTalk("Jodi", 12); break;
            case 12:
                if (!this.MemoryTestHasReply()) return;
                this.TownLine("你还记得我答应文森特什么吗？", "town-zero-heart-string-recall", 13); break;
            case 13:
                this.TownCheck(this.talk!.Reply.Contains("蓝色风筝"), "town-zero-heart-native-recall", this.talk.Reply);
                this.townTestStep = 14; this.CloseMemoryTestTalk("town"); break;
            case 14:
                this.TownIsolate();
                this.TownPlace("Abigail", "Saloon", 5, 5); this.TownPlace("Gus", "Saloon", 50, 5);
                this.TownHour(700, 15); break;
            case 15:
                if (!this.TownHourDone(false)) return;
                this.TownCheck(this.townTestPackets.Count == this.townTestBefore && this.townPending is null, "town-disabled");
                this.config.OffscreenNews = true; this.TownHour(800, 16); break;
            case 16:
                if (!this.TownHourDone()) return;
                this.TownCheck(this.townTestPackets.Count == this.townTestBefore + 1, "town-indoor-far-apart-native-event");
                this.TownIsolate();
                this.TownPlace("Gus", "Mountain", 5, 5); this.TownPlace("Pam", "Mountain", 11, 5);
                this.TownPlace("Sam", "Mountain", 17, 5); this.TownPlace("Elliott", "Mountain", 24, 5);
                this.TownPlace("Maru", "Mountain", 6, 5); Game1.getCharacterFromName("Maru").IsInvisible = true;
                this.TownHour(900, 17); break;
            case 17:
                if (!this.TownHourDone()) return;
                this.TownCheck(this.townTestPackets.Count == this.townTestBefore + 1, "town-outdoor-six-tiles-transitive-group");
                this.TownIsolate(); this.TownPlace("Pam", "Saloon", 5, 5); this.TownPlace("Leah", "Saloon", 6, 5);
                this.TownHour(1000, 18); break;
            case 18:
                if (!this.TownHourDone()) return;
                this.TownCheck(true, "town-third-hand-hour-acknowledged");
                this.TownIsolate(); this.TownPlace("Abigail", Game1.currentLocation.NameOrUniqueName, 5, 8);
                this.TownPlace("Robin", Game1.currentLocation.NameOrUniqueName, 6, 8);
                this.TownHour(1100, 19); break;
            case 19:
                if (!this.TownHourDone(false)) return;
                this.TownCheck(this.townTestPackets.Count == this.townTestBefore && this.townPending is null, "town-player-location-excluded");
                this.TownIsolate(); this.TownTalk("Maru", 20); break;
            case 20:
                if (!this.MemoryTestHasReply()) return;
                this.TownPlace("Abigail", "Saloon", 5, 5); this.TownPlace("Jodi", "Saloon", 6, 5);
                this.TownHour(1200, 21); break;
            case 21:
                if (!this.TownHourDone(false)) return;
                this.TownCheck(this.townTestPackets.Count == this.townTestBefore && this.townPending is not null, "town-defers-during-native-talk");
                this.TownPlace("Jodi", "Backwoods", 1000, 100); this.TownPlace("Leah", "Saloon", 6, 5);
                this.TownHour(1300, 22); break;
            case 22:
                if (!this.TownHourDone(false)) return;
                this.TownCheck(this.townPending?.Any(group => group.Contains("Leah")) == true
                    && this.townPending.All(group => !group.Contains("Jodi")) && this.townTestPackets.Count == this.townTestBefore,
                    "town-newest-pending-hour-replaces-older");
                this.townTestStep = 23; this.CloseMemoryTestTalk("town"); break;
            case 23:
                if (!this.TownHourDone()) return;
                this.TownCheck(this.townPending is null && this.townTestPackets.Count == this.townTestBefore + 1,
                    "town-sends-after-dialogue-close");
                this.townTestStep = 24; break;
            case 24:
                if (!this.TownGate("town-spread-ready")) return;
                Game1.player.friendshipData["Pam"] = new Friendship(2000);
                this.TownTalk("Pam", 25); break;
            case 25:
                if (!this.MemoryTestHasReply()) return;
                this.TownLine(TownAsk, "town-second-hand-before-rollback", 26); break;
            case 26:
                this.TownCheck(this.talk!.Reply.Contains("云尾"), "town-second-hand-native-recall", this.talk.Reply);
                this.RequestBubbleCapture("town-listener-pam"); this.townTestStep = 27; break;
            case 27:
                if (this.bubbleTestCapture is not null) return;
                this.townTestStep = 28; this.CloseMemoryTestTalk("town"); break;
            case 28:
                this.townTestPhase = 1; this.ReturnSocialTest(); break;
            case 60:
                this.TownCheck(this.townPending is null, "town-reload-clears-pending");
                Game1.player.friendshipData["Pam"] = new Friendship(2000);
                this.TownTalk("Pam", 61); break;
            case 61:
                if (!this.MemoryTestHasReply()) return;
                this.TownLine(TownAsk, "town-second-hand-after-rollback", 62); break;
            case 62:
                this.townTestStep = 63; this.CloseMemoryTestTalk("town"); break;
            case 63:
                this.TownIsolate(); this.config.OffscreenNews = true;
                this.TownPlace("Abigail", "Saloon", 5, 5); this.TownPlace("Gus", "Saloon", 6, 5);
                this.TownHour(800, 64); break;
            case 64:
                if (!this.TownHourDone()) return;
                this.TownPlace("Abigail", "Backwoods", 1100, 100); this.TownPlace("Pam", "Saloon", 7, 5);
                this.TownHour(900, 65); break;
            case 65:
                if (!this.TownHourDone()) return;
                this.TownCheck(true, "town-rollback-allows-news-again");
                this.config.OffscreenNews = false; this.townTestStep = 66; this.NewPartsSleep(); break;
            case 66:
                if (!this.CanChat || Game1.newDay || this.currentDay != this.memoryTestSleepDay + 1
                    || this.savedCommit?.DayEnded != this.memoryTestSleepDay || Game1.activeClickableMenu is not null) return;
                this.TownCheck(this.townPending is null, "town-new-day-clears-pending");
                this.townTestPhase = 2; this.ReturnSocialTest(); break;
            case 80:
                this.TownTalk("Pam", 81); break;
            case 81:
                if (!this.MemoryTestHasReply()) return;
                this.TownLine(TownAsk, "town-second-hand-saved-reload", 82); break;
            case 82:
                this.TownCheck(this.talk!.Reply.Contains("云尾"), "town-second-hand-save-reload-native-recall", this.talk.Reply);
                this.townTestStep = 83; this.CloseMemoryTestTalk("town"); break;
            case 83:
                this.TownIsolate(); this.config.OffscreenNews = true;
                this.TownPlace("Gus", "Saloon", 5, 5); this.TownPlace("Robin", "Saloon", 6, 5);
                this.TownHour(1000, 84); break;
            case 84:
                if (!this.TownHourDone()) return;
                if (!this.TownGate("town-final-ready")) return;
                this.TownCheck(true, "town-expired-hour-acknowledged");
                this.BeginAmbientTest(); break;
        }
    }
}
