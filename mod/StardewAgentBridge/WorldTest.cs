using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using Microsoft.Xna.Framework.Input;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Menus;

namespace StardewAgentBridge;

/// <summary>Game-thread operations for the explicitly requested disposable world acceptance scenario.</summary>
internal sealed partial class ModEntry
{
    private object? worldTestResult;
    private int worldTestCommand;
    private string worldTestOperation = "";
    private string worldTestPending = "";
    private int worldTestWait;
    private string worldTestNpc = "";
    private string worldTestTarget = "";
    private DateTime worldTestDeadline;
    private bool worldTestSantaSeen;
    private bool worldTestSantaInterrupt;
    private string? worldTestCapture;
    private DateTime worldTestCaptureAt;
    private bool worldTestCaptureHook;
    private bool worldTestCaptureScreen;
    private object? worldTestNative;
    private readonly List<int> worldTestHours = new();
    private bool worldTestHoursHook;
    private int worldTestReturnTicks;

    private void BeginWorldTest()
    {
        this.config.ShowBubbles = false; this.config.SendLetters = false;
        this.config.NpcChat = false; this.config.AmbientLines = false;
        this.config.OffscreenNews = false; this.config.BackstageScenes = true;
        this.config.InPersonGifts = false; this.config.ChatChangesFriendship = false;
        this.config.FestivalMemories = true;
        this.townTestRunning = true;
        Game1.options.pauseWhenOutOfFocus = false;
        if (!this.worldTestHoursHook)
        {
            this.Helper.Events.GameLoop.TimeChanged += (_, e) => { if (this.memoryTest?.World == true) this.worldTestHours.Add(e.NewTime); };
            this.worldTestHoursHook = true;
        }
        if (!this.worldTestCaptureHook)
        {
            this.Helper.Events.Display.Rendered += (_, _) => this.CaptureWorldTest();
            this.worldTestCaptureHook = true;
        }
        this.worldTestPending = "";
        this.WorldComplete();
    }

    private object WorldSnapshot()
    {
        bool ready = Context.IsWorldReady;
        Event? festival = ready ? Game1.CurrentEvent : null;
        return new
        {
            ready, canChat = this.CanChat, time = ready ? Game1.timeOfDay : 0, displaySleepAllowed = this.TestDisplaySleepAllowed(),
            farm = ready ? this.FarmTestSnapshot() : null,
            mine = ready ? this.MineTestSnapshot() : null,
            outing = ready ? this.OutingTestSnapshot() : null,
            invites = ready ? this.InvitesTestSnapshot() : null,
            more = ready ? this.MoreTestSnapshot() : null,
            date = ready ? GameState.Date() : null, weather = ready ? GameState.Weather() : null,
            location = ready ? Game1.currentLocation?.NameOrUniqueName : null,
            player = ready ? new { x = Game1.player.TilePoint.X, y = Game1.player.TilePoint.Y, facing = Game1.player.FacingDirection } : null,
            menu = Game1.activeClickableMenu?.GetType().Name, minigame = Game1.currentMinigame?.GetType().Name,
            dialogue = Game1.activeClickableMenu is DialogueBox box ? new { text = box.getCurrentString(), box.isQuestion } : null,
            Game1.globalFade, Game1.fadeToBlack, Game1.fadeIn, Game1.fadeToBlackAlpha, Game1.eventUp, Game1.isWarping,
            nonce = this.loadNonce, generation = this.bridge.Generation, queue = this.lifecycle.Count,
            festival = festival is null ? null : new
            {
                festival.id, festival.isFestival, command = festival.CurrentCommand, festival.playerControlSequence,
                actors = festival.actors.Where(npc => npc is not null).Select(npc => npc.Name).ToArray(),
                schedules = GameState.Schedules(festival.actors),
                recipient = festival.secretSantaRecipient?.Name, giver = festival.mySecretSanta?.Name, festival.doingSecretSanta,
                festival.grangeJudged, festival.grangeScore,
                dance = this.festivalWatch?.Dance, soup = this.festivalWatch?.Soup,
            },
            native = this.worldTestNative, hours = this.worldTestHours.ToArray(), actions = ready ? this.ActionSnapshot() : null,
            reply = this.talk is null ? null : new { npc = this.talk.Npc.Name, text = this.talk.Reply, waiting = this.talk.Waiting },
            npcs = ready ? SocialNpcs.Select(id => Game1.getCharacterFromName(id)).OfType<NPC>().Select(npc => new
            {
                id = npc.Name, name = npc.displayName, location = npc.currentLocation?.NameOrUniqueName, speed = npc.speed,
                x = npc.TilePoint.X, y = npc.TilePoint.Y, npc.ignoreScheduleToday, npc.followSchedule,
                controller = npc.controller is not null, temporary = npc.temporaryController is not null,
                queued = npc.queuedSchedulePaths.Count, destroys = npc.willDestroyObjectsUnderfoot,
                schedule = GameState.Schedule(npc),
            }).ToArray() : null,
        };
    }

    private void WorldComplete(string? error = null)
    {
        this.worldTestPending = "";
        this.worldTestResult = new { id = this.worldTestCommand, operation = this.worldTestOperation,
            completed = true, success = error is null, error, state = this.WorldSnapshot() };
        this.MemoryTestProgress("world", error is null ? "世界脚本完成：" + this.worldTestOperation : "世界脚本失败：" + error);
    }

    private void WorldWait(string pending, int ticks = 0)
    {
        this.worldTestPending = pending; this.worldTestWait = this.memoryTestTicks + ticks;
        this.worldTestDeadline = DateTime.UtcNow.AddSeconds(150);
        this.worldTestResult = new { id = this.worldTestCommand, operation = this.worldTestOperation, completed = false, success = false };
        this.MemoryTestProgress("world", "世界脚本等待：" + this.worldTestOperation);
    }

    private void WorldNativeMenus()
    {
        if (Game1.activeClickableMenu is DialogueBox { transitioning: false } box)
        {
            box.finishTyping(); box.selectedResponse = 0; box.receiveLeftClick(0, 0);
        }
        else if (Game1.activeClickableMenu is ItemGrabMenu grab)
        {
            for (int index = 0; index < grab.ItemsToGrabMenu.actualInventory.Count; index++)
                if (grab.ItemsToGrabMenu.actualInventory[index] is not null && index < grab.ItemsToGrabMenu.inventory.Count)
                {
                    Rectangle bounds = grab.ItemsToGrabMenu.inventory[index].bounds;
                    grab.receiveLeftClick(bounds.Center.X, bounds.Center.Y);
                    return;
                }
            grab.exitThisMenu();
        }
    }

    private void TickWorldTest()
    {
        if (this.memoryTest?.World != true) return;
        try
        {
            if (Context.IsWorldReady)
            {
                if (Game1.uniqueIDForThisGame.ToString() != this.memoryTest.UniqueId || Game1.player.Name != "记忆验收"
                    || Constants.SaveFolderName != this.memoryTest.SaveFolder || !Context.IsMainPlayer)
                    throw new InvalidOperationException("拒绝在独立验收副本以外执行世界脚本。");
                if (!this.actionTestClockRunning) Game1.gameTimeInterval = 0;
                this.TraceActionTest();
            }
            if (this.worldTestPending.Length > 0)
            {
                if (this.memoryTestTicks % 60 == 0)
                {
                    this.worldTestResult = new { id = this.worldTestCommand, operation = this.worldTestOperation, completed = false, success = false, state = this.WorldSnapshot() };
                    this.MemoryTestProgress("world", "世界脚本等待：" + this.worldTestOperation);
                }
                if (DateTime.UtcNow > this.worldTestDeadline) throw new TimeoutException("等待原版状态超时：" + this.worldTestPending);
                switch (this.worldTestPending)
                {
                    case "ticks":
                        if (this.memoryTestTicks >= this.worldTestWait && this.CanChat) this.WorldComplete();
                        break;
                    case "title":
                        if (!Context.IsWorldReady && Game1.activeClickableMenu is TitleMenu && this.lifecycle.Count == 0) this.WorldComplete();
                        break;
                    case "warp":
                        if (Context.IsWorldReady && !Game1.isWarping && Game1.currentLocation?.NameOrUniqueName == this.worldTestTarget && this.CanChat) this.WorldComplete();
                        break;
                    case "festival":
                        if (Game1.CurrentEvent is { isFestival: true, playerControlSequence: true } opened
                            && (this.festivalWatch is not null || !this.config.FestivalMemories
                                || opened.id.StartsWith("festival_") && !RememberedFestivals.Contains(opened.id["festival_".Length..])))
                            this.WorldComplete();
                        break;
                    case "festival-exit":
                    case "festival-main":
                        if (this.worldTestPending == "festival-main") this.WorldNativeMenus();
                        if (Context.IsWorldReady && !Game1.eventUp && !Game1.isWarping && this.CanChat) this.WorldComplete();
                        break;
                    case "santa":
                        if (Game1.CurrentEvent is { doingSecretSanta: true } santaScene)
                        {
                            this.worldTestSantaSeen = true;
                            if (this.worldTestSantaInterrupt)
                            {
                                this.worldTestNative = new { method = "forced interruption of native receive scene", command = santaScene.CurrentCommand,
                                    giver = santaScene.mySecretSanta?.Name, menu = Game1.activeClickableMenu?.GetType().Name,
                                    receivedItems = Game1.player.Items.Count(item => item is not null) };
                                this.worldTestSantaInterrupt = false; this.CloseSocialMenu(); santaScene.forceEndFestival(Game1.player);
                                this.WorldWait("festival-exit"); return;
                            }
                        }
                        this.WorldNativeMenus();
                        if (this.worldTestSantaSeen && Game1.CurrentEvent is { isFestival: true, doingSecretSanta: false, playerControlSequence: true }) this.WorldComplete();
                        break;
                    case "fishing":
                        if (Game1.currentMinigame is not null) this.WorldComplete();
                        break;
                    case "fishing-exit":
                        if (Game1.currentMinigame is null && !Game1.globalFade && !Game1.fadeToBlack && Game1.fadeToBlackAlpha <= 0
                            && !Game1.isWarping && Game1.activeClickableMenu is null
                            && Game1.CurrentEvent is { id: "festival_fall16", isFestival: true } && this.CanChat)
                            this.worldTestReturnTicks += 10;
                        else this.worldTestReturnTicks = 0;
                        if (this.worldTestReturnTicks >= 60) this.WorldComplete();
                        break;
                    case "grange":
                        if (Game1.CurrentEvent is { grangeJudged: true } judged)
                        {
                            this.worldTestNative = new { method = "Event.forceFestivalContinue / native Lewis judging", judged.grangeScore, judged.grangeJudged,
                                items = Game1.player.team.grangeDisplay.Select(item => item?.QualifiedItemId).ToArray() };
                            this.WorldComplete();
                        }
                        break;
                    case "route":
                        NPC actor = this.SocialActor(this.worldTestNpc);
                        if (actor.currentLocation?.NameOrUniqueName == this.worldTestTarget && actor.controller is null && actor.temporaryController is null) this.WorldComplete();
                        break;
                    case "talk-open":
                        if (this.talk is not null && this.MemoryTestHasReply()) this.WorldComplete();
                        break;
                    case "talk-say":
                    case "talk-close":
                        this.WorldComplete();
                        break;
                    case "sleep":
                        // Native overnight events can show an informational message before saving.
                        if (Game1.activeClickableMenu is DialogueBox { transitioning: false, isQuestion: false } notice)
                        {
                            this.Monitor.Log("[WorldTest] Overnight message: " + notice.getCurrentString(), LogLevel.Info);
                            this.WorldNativeMenus();
                        }
                        if (Context.IsWorldReady && !Game1.newDay && !SaveGame.IsProcessing && this.CanChat
                            && this.currentDay == this.memoryTestSleepDay + 1 && this.savedCommit?.DayEnded == this.memoryTestSleepDay
                            && Game1.activeClickableMenu is null) this.WorldComplete();
                        break;
                    case "capture": break;
                    default: this.TickActionTestPending(); break;
                }
                return;
            }
            string path = Path.Combine(this.memoryTest.RunDirectory, "control.json");
            if (!File.Exists(path)) return;
            using JsonDocument? control = ReadWorldControl(path);
            if (control is null) return;
            JsonElement root = control.RootElement;
            if (root.GetProperty("requestId").GetString() != this.memoryTest.RequestId
                || !root.TryGetProperty("world", out JsonElement command)) return;
            int id = command.GetProperty("id").GetInt32();
            if (id <= this.worldTestCommand) return;
            this.worldTestCommand = id; this.worldTestOperation = command.GetProperty("operation").GetString()!;
            JsonElement args = command.GetProperty("args");
            string Text(string key, string fallback = "") => args.TryGetProperty(key, out JsonElement value) ? value.GetString()! : fallback;
            int Number(string key, int fallback = 0) => args.TryGetProperty(key, out JsonElement value) ? value.GetInt32() : fallback;
            bool Flag(string key, bool fallback = false) => args.TryGetProperty(key, out JsonElement value) ? value.GetBoolean() : fallback;
            switch (this.worldTestOperation)
            {
                case "snapshot": this.WorldComplete(); break;
                case "meeting-test-clear-hud": Game1.hudMessages.Clear(); this.WorldComplete(); break;
                case "wait": this.WorldWait("ticks", Number("ticks", 60)); break;
                case "title":
                    this.CloseSocialMenu(); Game1.ExitToTitle(); this.WorldWait("title"); break;
                case "load":
                    this.WorldWait("load"); this.MemoryTestProgress("reload-menu", "世界脚本真实重新读档。"); break;
                case "finish":
                    if (Context.IsWorldReady || this.lifecycle.Count > 0) throw new InvalidOperationException("只能在副本已退出并确认后结束。");
                    this.FinishMemoryTest(true, "节日、后台场景与行程的脚本流程完成。"); break;
                case "config":
                    foreach (JsonProperty property in args.EnumerateObject())
                    {
                        var target = this.config.GetType().GetProperty(property.Name);
                        if (target?.PropertyType != typeof(bool)) throw new InvalidOperationException("测试只允许修改布尔配置。");
                        target.SetValue(this.config, property.Value.GetBoolean());
                    }
                    this.WorldComplete(); break;
                case "clock":
                    Game1.timeOfDay = Number("time"); this.WorldWait("ticks", 20); break;
                case "warp":
                    this.CloseSocialMenu(); this.worldTestTarget = Text("map");
                    Game1.warpFarmer(this.worldTestTarget, Number("x", 8), Number("y", 8), 2); this.WorldWait("warp"); break;
                case "isolate":
                    this.TownIsolate(); this.WorldComplete(); break;
                case "place":
                    this.TownPlace(Text("npc"), Text("map"), Number("x", 5), Number("y", 5));
                    Game1.player.friendshipData[Text("npc")] = new Friendship(Number("hearts", 6) * 250);
                    this.WorldComplete(); break;
                case "route":
                    NPC routeNpc = this.SocialActor(Text("npc"));
                    int time = Number("time");
                    if (routeNpc.Schedule is null || !routeNpc.Schedule.TryGetValue(time, out var destination)) throw new InvalidOperationException("原版没有这条路线。");
                    this.worldTestNpc = routeNpc.Name; this.worldTestTarget = destination.targetLocationName;
                    Game1.timeOfDay = time; routeNpc.ignoreScheduleToday = false; routeNpc.followSchedule = true;
                    routeNpc.checkSchedule(time); this.worldTestNative = new { npc = routeNpc.Name, departure = time, target = this.worldTestTarget, method = "NPC.checkSchedule" };
                    this.WorldWait("route"); break;
                case "ignore-schedule":
                    this.SocialActor(Text("npc")).ignoreScheduleToday = Flag("ignore", true); this.WorldComplete(); break;
                case "talk-open":
                    this.CloseSocialMenu(); NPC speaker = this.SocialActor(Text("npc"));
                    if (!Flag("keepFriendship")) Game1.player.friendshipData[speaker.Name] = new Friendship(2000);
                    this.StartTalk(speaker); this.WorldWait("talk-open"); break;
                case "talk-say":
                    if (!this.MemoryTestHasReply()) throw new InvalidOperationException("还没有可继续的原版对话。");
                    this.memoryTestLine = Text("text"); this.memoryTestLabel = Text("label", "world"); this.memoryTestAfterReply = "world";
                    this.WorldWait("talk-say"); this.ChooseMemoryTestResponse(this.talk!.Options.Count);
                    this.MemoryTestProgress("input", "世界脚本通过原版输入框提问。"); break;
                case "talk-close":
                    this.WorldWait("talk-close"); this.CloseMemoryTestTalk("world"); break;
                case "sleep":
                    this.CheckMemoryTestSave(); this.memoryTestSleepDay = this.currentDay;
                    FarmHouse home = Utility.getHomeOfFarmer(Game1.player); Point bed = home.getBedSpot();
                    LocationRequest request = Game1.getLocationRequest(home.NameOrUniqueName);
                    request.OnWarp += () => Game1.currentLocation.answerDialogueAction("Sleep_Yes", Array.Empty<string>());
                    this.WorldWait("sleep"); Game1.warpFarmer(request, bed.X, bed.Y, 2); break;
                case "festival-open":
                    this.worldTestNative = null; this.worldTestSantaSeen = false;
                    Game1.timeOfDay = Number("time", 1000);
                    Game1.warpFarmer(Text("map"), Number("x", 8), Number("y", 8), 2); this.WorldWait("festival"); break;
                case "festival-leave":
                    this.CloseSocialMenu(); (Game1.CurrentEvent ?? throw new InvalidOperationException("没有节日事件。")).forceEndFestival(Game1.player);
                    this.WorldWait("festival-exit"); break;
                case "dance-invite":
                    Event dance = Game1.CurrentEvent!; NPC partner = dance.getActorByName(Text("npc", "Abigail"));
                    Game1.player.friendshipData[partner.Name] = new Friendship(2500); dance.answerDialogueQuestion(partner, "danceAsk");
                    this.worldTestNative = new { method = "Event.answerDialogueQuestion(danceAsk)", partner = Game1.player.dancePartner.TryGetVillager()?.Name };
                    this.WorldWait("ticks", 20); break;
                case "festival-main":
                    Game1.CurrentEvent!.forceFestivalContinue(); this.WorldWait("festival-main"); break;
                case "contest":
                    Event contest = Game1.CurrentEvent!;
                    Game1.player.festivalScore = Number("score");
                    this.Helper.Reflection.GetMethod(contest, Text("kind") == "egg" ? "eggHuntWinner" : "iceFishingWinner").Invoke();
                    if (Flag("otherWinner"))
                    {
                        HashSet<long> winners = this.Helper.Reflection.GetField<HashSet<long>>(contest, "festivalWinners").GetValue();
                        winners.Clear(); winners.Add(Game1.player.UniqueMultiplayerID + 1); contest.specialEventVariable1 = false;
                    }
                    this.worldTestNative = new { method = Text("kind") == "egg" ? "eggHuntWinner" : "iceFishingWinner", controlledScore = Game1.player.festivalScore,
                        controlledOtherWinner = Flag("otherWinner"), npcWins = contest.specialEventVariable1, winners = this.Helper.Reflection.GetField<HashSet<long>>(contest, "festivalWinners").GetValue().ToArray() };
                    this.WorldWait("ticks", 20); break;
                case "grange":
                    Game1.player.team.grangeDisplay.Clear();
                    foreach (JsonElement item in args.GetProperty("items").EnumerateArray()) Game1.player.team.grangeDisplay.Add(ItemRegistry.Create(item.GetString()!, quality: Number("quality", 0)));
                    Game1.CurrentEvent!.forceFestivalContinue(); this.WorldWait("grange"); break;
                case "soup":
                    Game1.player.team.luauIngredients.Clear();
                    if (Text("item").Length > 0) Game1.player.team.luauIngredients.Add(ItemRegistry.Create(Text("item"), quality: Number("quality", 0)));
                    this.worldTestNative = new { method = "native main event / governorTaste", item = Text("item"), quality = Number("quality") };
                    Game1.CurrentEvent!.forceFestivalContinue(); this.WorldWait("festival-main"); break;
                case "santa":
                    Event santa = Game1.CurrentEvent!;
                    this.worldTestSantaInterrupt = Flag("interrupt");
                    if (Flag("absentGiver")) santa.mySecretSanta = this.SocialActor("Sandy");
                    for (int i = 0; i < Game1.player.Items.Count; i++) Game1.player.Items[i] = null;
                    this.worldTestNative = new { method = "Event.chooseSecretSantaGift", recipient = santa.secretSantaRecipient?.Name, drawnGiver = santa.mySecretSanta?.Name, controlledAbsentGiver = Flag("absentGiver") };
                    santa.chooseSecretSantaGift(ItemRegistry.Create(Text("item", "(O)72")), Game1.player);
                    this.WorldWait("santa"); break;
                case "fish-start":
                    this.CloseSocialMenu(); Game1.player.Money = 10000;
                    Game1.CurrentEvent!.answerDialogue("fishingGame", 0); this.WorldWait("fishing"); break;
                case "fish-end":
                    if (Game1.currentMinigame is null) throw new InvalidOperationException("没有可退出的原版钓鱼小游戏。");
                    this.worldTestReturnTicks = 0; Game1.currentMinigame.receiveKeyPress(Keys.Escape); this.WorldWait("fishing-exit"); break;
                case "capture":
                    this.worldTestCaptureScreen = Flag("screen");
                    this.worldTestCapture = Path.Combine(this.memoryTest.RunDirectory, Path.GetFileName(Text("name", "world.png")));
                    this.worldTestCaptureAt = DateTime.UtcNow.AddSeconds(1);
                    this.WorldWait("capture"); break;
                default:
                    if (!this.ActionCommand(this.worldTestOperation, args) && !this.FarmTestCommand(this.worldTestOperation, args)
                        && !this.MineTestCommand(this.worldTestOperation, args) && !this.AnimalTestCommand(this.worldTestOperation, args)
                        && !this.OutingTestCommand(this.worldTestOperation, args) && !this.InvitesTestCommand(this.worldTestOperation, args)
                        && !this.MoreTestCommand(this.worldTestOperation, args))
                        throw new InvalidOperationException("未知世界测试命令：" + this.worldTestOperation);
                    break;
            }
        }
        catch (Exception error) { this.WorldComplete(error.GetBaseException().ToString()); }
    }

    private static JsonDocument? ReadWorldControl(string path)
    {
        try
        {
            // The runner atomically replaces this file; do not block its rename or fail a prior command during replacement.
            using FileStream input = new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return JsonDocument.Parse(input);
        }
        catch (IOException) { return null; }
    }

    private void CaptureWorldTest()
    {
        if (this.memoryTest?.World != true || this.worldTestCapture is null || DateTime.UtcNow < this.worldTestCaptureAt) return;
        string path = this.worldTestCapture; this.worldTestCapture = null;
        try
        {
            if (this.worldTestCaptureScreen)
            {
                RenderTarget2D scene = Game1.game1.screen;
                using FileStream output = File.Create(path); scene.SaveAsPng(output, scene.Width, scene.Height);
                this.WorldComplete(); return;
            }
            if (Game1.activeClickableMenu is not null)
            {
                RenderTarget2D ui = Game1.game1.uiScreen;
                using FileStream output = File.Create(path); ui.SaveAsPng(output, ui.Width, ui.Height);
                this.WorldComplete(); return;
            }
            GraphicsDevice graphics = Game1.game1.GraphicsDevice;
            int width = graphics.PresentationParameters.BackBufferWidth, height = graphics.PresentationParameters.BackBufferHeight;
            Color[] pixels = new Color[width * height]; graphics.GetBackBufferData(pixels);
            for (int y = 0; y < height / 2; y++)
            for (int x = 0; x < width; x++)
            {
                int a = y * width + x, b = (height - 1 - y) * width + x;
                (pixels[a], pixels[b]) = (pixels[b], pixels[a]);
            }
            using Texture2D capture = new(graphics, width, height); capture.SetData(pixels);
            using FileStream stream = File.Create(path); capture.SaveAsPng(stream, width, height);
            this.WorldComplete();
        }
        catch (Exception error) { this.WorldComplete("画面捕获失败：" + error.Message); }
    }
}
