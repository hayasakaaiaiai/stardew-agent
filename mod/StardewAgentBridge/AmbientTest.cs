using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>Opt-in native display, timing and vanilla-event checks in the disposable acceptance save.</summary>
internal sealed partial class ModEntry
{
    private readonly List<object> ambientTestChecks = new();
    private readonly List<object> ambientTestShown = new();
    private readonly List<object> ambientTestPackets = new();
    private readonly List<object> ambientEventAssets = new();
    private bool ambientTestRunning;
    private int ambientTestStep;
    private int ambientTestBefore;
    private uint ambientTestWait;
    private string ambientTestOldNonce = "";
    private bool ambientTestReload;
    private bool ambientTestFaced;
    private UpdateTickedEventArgs? ambientTestUpdate;
    private Dictionary<string, int> ambientTestPoints = new();
    private int ambientTestMoney;
    private int ambientTestNoLines;
    private int ambientTestRealSeq;

    private void AmbientCheck(bool passed, string label, object? detail = null)
    {
        this.ambientTestChecks.Add(new { label, passed, detail, at = Game1.timeOfDay, nonce = this.loadNonce });
        if (!passed) throw new InvalidOperationException("同图检查失败：" + label);
        this.MemoryTestProgress("ambient", "同图检查通过：" + label);
    }

    private void BeginAmbientTest()
    {
        this.townTestRunning = this.newsTestRunning = this.newPartsRunning = false;
        this.ambientTestRunning = true;
        this.config.NpcChat = this.config.OffscreenNews = this.config.ShowBubbles = false;
        this.config.AmbientLines = true;
        this.ClearAmbient(); this.ClearScenes(); this.ClearBubbles();
        if (!this.bubbleTestRenderHook)
        {
            this.Helper.Events.Display.Rendered += (_, _) => this.CaptureBubbleTest();
            this.bubbleTestRenderHook = true;
        }
        this.ambientTestStep = 0;
        this.WarpForMemoryTest("ambient");
    }

    private void ResumeAmbientTest()
    {
        this.AmbientCheck(this.loadNonce != this.ambientTestOldNonce && this.ambientToday == 0
            && this.ambientGreeted.Count == 0 && this.ambientAskedAt.Count == 0 && this.ambientLines.Count == 0
            && this.ambientRequestSeq == 0, "ambient-real-reload-clears-state");
        this.config.NpcChat = this.config.OffscreenNews = this.config.ShowBubbles = false;
        this.ambientTestStep = 90;
        this.WarpForMemoryTest("ambient");
    }

    private void AmbientArrange()
    {
        this.TownIsolate();
        string map = Game1.currentLocation.NameOrUniqueName;
        Game1.player.Position = new Vector2(5 * 64, 9 * 64); Game1.player.CanMove = true;
        this.TownPlace("Pierre", map, 6, 9); this.TownPlace("Caroline", map, 7, 9);
        this.TownPlace("Abigail", map, 8, 9); this.TownPlace("Gus", map, 9, 9);
        this.TownPlace("Pam", map, 10, 9); this.TownPlace("Elliott", map, 16, 9);
        this.TownPlace("Maru", map, 5, 10); Game1.getCharacterFromName("Maru").IsInvisible = true;
        foreach (string name in new[] { "Pierre", "Caroline", "Abigail", "Gus", "Pam" })
        {
            Game1.getCharacterFromName(name).isEmoting = false;
            Game1.getCharacterFromName(name).faceDirection(1);
        }
    }

    private void AmbientQueue(string name = "Pierre", string to = "self")
    {
        this.ambientLines.Enqueue((name.ToLowerInvariant(), to, "今天风很轻。", "happy"));
        this.nextAmbientLineTick = 0;
        this.ambientTestBefore = this.ambientTestShown.Count;
        this.ambientTestWait = this.ambientCurrentTick + 20;
    }

    private void AmbientCheckEvents()
    {
        foreach (var item in new[] { ("HaleyHouse", "195012", "girls"), ("HaleyHouse", "195019", ""),
            ("Saloon", "195013", "guys"), ("Saloon", "195099", ""), ("Beach", "7771191", "") })
        {
            Dictionary<string, string> asset = Game1.content.Load<Dictionary<string, string>>("Data\\Events\\" + item.Item1);
            var matches = asset.Where(pair => pair.Key.Split('/')[0] == item.Item2).ToList();
            this.AmbientCheck(matches.Count == 1 && (item.Item3 == "" || matches[0].Value.Contains("dump " + item.Item3)),
                "event-asset-" + item.Item2, matches.Select(pair => pair.Key).ToArray());
            this.ambientEventAssets.Add(new { id = item.Item2, map = item.Item1, keys = matches.Select(pair => pair.Key).ToArray() });
        }
        string[] girls = { "Abigail", "Emily", "Haley", "Leah", "Maru", "Penny" };
        string[] guys = { "Alex", "Elliott", "Harvey", "Sam", "Sebastian", "Shane" };
        foreach (var group in new[] { ("girls", "dumped_Girls", girls, guys), ("guys", "dumped_Guys", guys, girls) })
        {
            // Run the game's real dump command, rather than fabricating the dictionary key it should set.
            Event.DefaultCommands.Dump(new Event("none/-1000 -1000/farmer 5 9 2/pause 1"), new[] { "dump", group.Item1 }, null!);
            this.AmbientCheck(Game1.player.activeDialogueEvents.ContainsKey(group.Item2)
                && group.Item3.All(name => ColdShoulder(name) && !this.ShouldOffer(Game1.getCharacterFromName(name)) && !this.AmbientDue(name))
                && group.Item4.All(name => !ColdShoulder(name)), "event-native-dump-" + group.Item1);
            Game1.player.activeDialogueEvents.Remove(group.Item2);
        }
        this.AmbientCheck(!ColdShoulder("Haley") && this.ShouldOffer(Game1.getCharacterFromName("Haley"))
            && !ColdShoulder("Gus"), "event-cleared-and-unaffected-npc-can-chat");
        foreach (string id in new[] { "195012", "195019", "195013", "195099", "7771191" }) Game1.player.eventsSeen.Add(id);
        this.AmbientCheck(new[] { "195012", "195019", "195013", "195099", "7771191" }.All(id => GameState.SeenEvents().Contains(id)),
            "event-history-native-export");
    }

    private void TickAmbientTest()
    {
        if (!Context.IsWorldReady) return;
        switch (this.ambientTestStep)
        {
            case 0:
                if (!this.TownGate("ambient-fixed-ready")) return;
                this.CloseSocialMenu(); this.AmbientArrange();
                this.AmbientQueue(); Game1.drawObjectDialogue("同图菜单互斥验收"); this.ambientTestStep = 1; break;
            case 1:
                if (this.ambientCurrentTick < this.ambientTestWait) return;
                this.AmbientCheck(this.ambientLines.Count == 1 && this.ambientTestShown.Count == this.ambientTestBefore,
                    "ambient-pending-line-waits-for-menu");
                this.CloseSocialMenu(); Game1.eventUp = true; this.TickAmbient(this.ambientTestUpdate!);
                this.AmbientCheck(this.ambientLines.Count == 1, "ambient-pending-line-waits-for-event");
                Game1.eventUp = false; this.talk = new Talk(Game1.getCharacterFromName("Pierre")) { Waiting = true };
                this.ambientTestWait = this.ambientCurrentTick + 20; this.ambientTestStep = 3; break;
            case 3:
                if (this.ambientCurrentTick < this.ambientTestWait) return;
                this.AmbientCheck(this.ambientLines.Count == 1, "ambient-pending-line-waits-for-ai-talk");
                this.talk = null; this.config.AmbientLines = false;
                this.ambientTestWait = this.ambientCurrentTick + 20; this.ambientTestStep = 4; break;
            case 4:
                if (this.ambientCurrentTick < this.ambientTestWait) return;
                this.AmbientCheck(this.ambientLines.Count == 1, "ambient-disabled-pending-line-hidden");
                this.config.AmbientLines = true; this.ambientTestStep = 5; break;
            case 5:
                if (this.ambientLines.Count > 0) return;
                this.AmbientCheck(this.ambientTestShown.Count == this.ambientTestBefore + 1, "ambient-line-resumes-after-free");
                this.config.NpcChat = true; this.TryStartScene();
                this.AmbientCheck(this.sceneRequestSeq == 0, "ambient-last-line-holds-scene-slot");
                this.config.NpcChat = false; this.ClearAmbient(); this.AmbientQueue();
                Game1.getCharacterFromName("Pierre").IsInvisible = true; this.ambientTestStep = 6; break;
            case 6:
                if (this.ambientLines.Count > 0) return;
                this.AmbientCheck(this.ambientTestShown.Count == this.ambientTestBefore, "ambient-newly-invisible-speaker-skipped");
                Game1.getCharacterFromName("Pierre").IsInvisible = false;
                this.ClearAmbient(); this.AmbientQueue(); Game1.getCharacterFromName("Pierre").Position = new Vector2(18 * 64, 9 * 64);
                this.ambientTestStep = 7; break;
            case 7:
                if (this.ambientLines.Count > 0) return;
                this.AmbientCheck(this.ambientTestShown.Count == this.ambientTestBefore, "ambient-thirteen-tile-speaker-skipped");
                this.AmbientArrange(); this.ClearAmbient(); this.ClearBubbles();
                this.ambientRequestSeq = 776;
                this.ambientRequestedTick = unchecked(this.ambientCurrentTick - 20 * 60);
                this.TickAmbient(this.ambientTestUpdate!);
                this.AmbientCheck(this.ambientRequestSeq == 776, "ambient-twenty-second-reply-still-accepted");
                using (JsonDocument slow = JsonDocument.Parse(JsonSerializer.Serialize(new { lineageId = this.lineageId, loadNonce = this.loadNonce,
                    seq = 776, lines = new[] { new { npc = "pierre", to = "self", text = "欢迎光临！", emote = "happy" } } })))
                    this.HandleAmbient("ambient.lines", slow.RootElement);
                this.AmbientCheck(this.ambientLines.Count == 1, "ambient-twenty-second-valid-packet-queued");
                this.ClearAmbient(); this.ClearScenes();
                this.sceneRequestSeq = 775;
                this.sceneRequestedTick = unchecked(this.sceneCurrentTick - 20 * 60);
                this.TickScenes(this.ambientTestUpdate!);
                this.AmbientCheck(this.sceneRequestSeq == 775, "scene-twenty-second-reply-still-accepted");
                using (JsonDocument slow = JsonDocument.Parse(JsonSerializer.Serialize(new { lineageId = this.lineageId, loadNonce = this.loadNonce,
                    seq = 775, lines = new[] { new { npc = "pierre", text = "欢迎光临！", emote = "happy" } } })))
                    this.HandleScenes("scene.lines", slow.RootElement);
                this.AmbientCheck(this.sceneLines.Count == 1, "scene-twenty-second-valid-packet-queued");
                this.ClearScenes(); this.sceneRequestSeq = 774;
                this.sceneRequestedTick = unchecked(this.sceneCurrentTick - SceneReplyTicks - 1);
                this.TickScenes(this.ambientTestUpdate!);
                this.AmbientCheck(this.sceneRequestSeq == 0, "scene-sixty-second-timeout-releases-request");
                using (JsonDocument lateScene = JsonDocument.Parse(JsonSerializer.Serialize(new { lineageId = this.lineageId, loadNonce = this.loadNonce,
                    seq = 774, lines = new[] { new { npc = "pierre", text = "这句不该显示。" } } })))
                    this.HandleScenes("scene.lines", lateScene.RootElement);
                this.AmbientCheck(this.sceneLines.Count == 0, "scene-timed-out-late-packet-ignored");
                this.ClearScenes();
                this.ambientRequestSeq = 777;
                this.ambientRequestedTick = unchecked(this.ambientCurrentTick - AmbientReplyTicks - 1);
                this.TickAmbient(this.ambientTestUpdate!);
                this.AmbientCheck(this.ambientRequestSeq == 0, "ambient-sixty-second-timeout-releases-request");
                using (JsonDocument late = JsonDocument.Parse(JsonSerializer.Serialize(new { lineageId = this.lineageId, loadNonce = this.loadNonce,
                    seq = 777, lines = new[] { new { npc = "pierre", to = "farmer", text = "这句不该显示。", emote = "happy" } } })))
                    this.HandleAmbient("ambient.lines", late.RootElement);
                this.AmbientCheck(this.ambientLines.Count == 0, "ambient-timed-out-late-packet-ignored");
                this.config.AmbientLines = false; this.TryStartAmbient(); this.AmbientCheck(this.ambientToday == 0, "ambient-config-off-no-request");
                this.config.AmbientLines = true;
                Game1.drawObjectDialogue("同图触发互斥验收"); this.TryStartAmbient(); this.AmbientCheck(this.ambientToday == 0, "ambient-menu-no-request");
                this.CloseSocialMenu(); Game1.eventUp = true; this.TryStartAmbient(); this.AmbientCheck(this.ambientToday == 0, "ambient-event-no-request");
                Game1.eventUp = false; this.sceneRequestSeq = 999; this.TryStartAmbient(); this.sceneRequestSeq = 0;
                this.AmbientCheck(this.ambientToday == 0, "ambient-scene-request-blocks");
                this.sceneLines.Enqueue(("Abigail", "天气不错。", "none")); this.TryStartAmbient(); this.sceneLines.Clear();
                this.AmbientCheck(this.ambientToday == 0, "ambient-scene-queue-blocks");
                this.config.ShowBubbles = true;
                this.bubbles["Pierre"] = new() { ("先冒昨晚的心事。", "happy") };
                this.bubbleShownAt["Caroline"] = 900;
                Game1.timeOfDay = 950;
                this.AmbientCheck(!this.AmbientDue("Pierre") && !this.AmbientDue("Caroline"), "ambient-nightly-priority-and-fifty-minute-gap");
                this.bubblesShown.Add("Pierre\n先冒昨晚的心事。"); Game1.timeOfDay = 1000;
                this.AmbientCheck(this.AmbientDue("Pierre") && this.AmbientDue("Caroline"), "ambient-consumed-nightly-and-sixty-minute-gap");
                this.ClearBubbles(); this.config.ShowBubbles = false; this.ClearAmbient();
                this.AmbientCheckEvents(); this.ambientTestStep = 10; break;
            case 10:
                this.ambientTestPoints = Game1.player.friendshipData.Pairs.ToDictionary(pair => pair.Key, pair => pair.Value.Points);
                this.ambientTestMoney = Game1.player.Money;
                this.ambientTestBefore = this.ambientTestShown.Count;
                this.ambientTestFaced = false;
                this.TryStartAmbient();
                this.AmbientCheck(this.ambientToday == 1 && this.ambientRequestSeq != 0 && this.ambientAskedAt.Count == 4,
                    "ambient-nearest-four-native-request");
                this.ambientTestStep = 11; break;
            case 11:
                if (!this.ambientTestFaced && this.ambientGreeted.Contains("Pierre"))
                {
                    this.AmbientCheck(Game1.getCharacterFromName("Pierre").FacingDirection == 3, "ambient-still-npc-faces-farmer");
                    this.ambientTestFaced = true; this.RequestBubbleCapture("ambient-fixed");
                }
                if (this.ambientRequestSeq != 0 || this.ambientLines.Count > 0 || this.ambientCurrentTick < this.nextAmbientLineTick) return;
                this.AmbientCheck(this.ambientTestShown.Count == this.ambientTestBefore + 4 && this.ambientGreeted.Contains("Pierre"),
                    "ambient-fixed-native-lines-and-greeting");
                this.AmbientCheck(!this.AmbientDue("Pierre"), "ambient-same-person-two-hour-cooldown");
                Game1.timeOfDay = 1020; this.TryStartAmbient();
                this.AmbientCheck(this.ambientToday == 1, "ambient-twenty-minute-global-gap");
                Game1.timeOfDay = 1030; this.TryStartAmbient();
                this.AmbientCheck(this.ambientToday == 2, "ambient-thirty-minute-new-person-allows");
                this.ambientTestStep = 12; break;
            case 12:
                if (this.ambientRequestSeq != 0 || this.ambientLines.Count > 0 || this.ambientCurrentTick < this.nextAmbientLineTick) return;
                this.config.NpcChat = true; this.scenePairs.Clear(); this.lastSceneAt = -1;
                Game1.timeOfDay = 1200; this.TryStartScene();
                this.AmbientCheck(this.sceneRequestSeq != 0 && this.sceneParticipants.Count == 2 && this.sceneParticipants.All(name => !this.AmbientDue(name)),
                    "ambient-scene-assigns-two-hour-person-cooldown");
                this.config.NpcChat = false; this.ambientTestStep = 13; break;
            case 13:
                if (this.sceneRequestSeq != 0 || this.sceneLines.Count > 0 || this.sceneShowing != 0) return;
                this.ClearAmbient(); Game1.timeOfDay = 1400; this.TryStartAmbient();
                this.AmbientCheck(this.ambientToday == 0, "ambient-scene-last-line-holds-slot");
                this.ClearScenes(); this.ClearAmbient();
                this.ambientToday = 12; Game1.timeOfDay = 1400; this.TryStartAmbient();
                this.AmbientCheck(this.ambientToday == 12 && this.ambientRequestSeq == 0, "ambient-twelve-daily-cap");
                this.ClearAmbient(); this.AmbientArrange(); this.ambientTestStep = 20; break;
            case 20:
                if (this.memoryTest!.Offline) { this.ambientTestStep = 30; break; }
                if (!this.TownGate("ambient-live-ready")) return;
                this.ambientTestBefore = this.ambientTestShown.Count; this.TryStartAmbient();
                this.ambientTestRealSeq = this.ambientRequestSeq; this.ambientTestStep = 21; break;
            case 21:
                if (this.ambientRequestSeq != 0 || this.ambientLines.Count > 0) return;
                if (this.ambientTestShown.Count == this.ambientTestBefore)
                {
                    this.ambientTestNoLines++;
                    this.AmbientCheck(this.ambientTestRealSeq != 0, "ambient-real-no-line-" + this.ambientTestNoLines,
                        new { request = this.ambientTestRealSeq, timedOut = this.ambientCurrentTick - this.ambientRequestedTick > AmbientReplyTicks });
                    this.ambientTestStep = 24; break;
                }
                this.AmbientCheck(this.ambientTestShown.Count > this.ambientTestBefore, "ambient-real-model-native-lines");
                this.RequestBubbleCapture("ambient-real"); this.ambientTestStep = 22; break;
            case 22:
                if (this.bubbleTestCapture is not null || this.ambientCurrentTick < this.nextAmbientLineTick) return;
                Game1.timeOfDay += 200; this.TryStartAmbient(); this.ambientTestStep = 23; break;
            case 23:
                if (this.ambientRequestSeq != 0 || this.ambientLines.Count > 0 || this.ambientCurrentTick < this.nextAmbientLineTick) return;
                this.AmbientCheck(this.ambientToday == 2 + this.ambientTestNoLines, "ambient-real-model-second-round"); this.ambientTestStep = 30; break;
            case 24:
                if (!this.TownGate("ambient-late-ready-" + this.ambientTestNoLines)) return;
                this.AmbientCheck(this.ambientTestShown.Count == this.ambientTestBefore, "ambient-real-late-response-not-shown-" + this.ambientTestNoLines);
                if (this.ambientTestNoLines >= 3) throw new InvalidOperationException("三次真实模型样本都没有可显示台词，保留超时或空输出证据。");
                // Sampling retries only: preserve real budgets and advance the full two-hour NPC cooldown.
                Game1.timeOfDay += 200;
                this.ambientTestBefore = this.ambientTestShown.Count; this.TryStartAmbient();
                this.ambientTestRealSeq = this.ambientRequestSeq; this.ambientTestStep = 21; break;
            case 30:
                if (!this.TownGate("ambient-content-ready")) return;
                this.AmbientCheck(this.ambientTestMoney == Game1.player.Money && this.ambientTestPoints.All(pair => Game1.player.friendshipData[pair.Key].Points == pair.Value),
                    "ambient-does-not-change-money-or-friendship");
                this.ambientTestOldNonce = this.loadNonce; this.ambientTestReload = true; this.ReturnSocialTest(); break;
            case 90:
                this.AmbientCheck(this.ambientTestReload && Game1.player.activeDialogueEvents.ContainsKey("dumped_Girls") == false
                    && Game1.player.activeDialogueEvents.ContainsKey("dumped_Guys") == false, "event-unsaved-dump-rollback");
                this.MemoryTestProgress("return-finish", "同图、事件和新旧功能组合检查完成。"); break;
        }
    }
}
