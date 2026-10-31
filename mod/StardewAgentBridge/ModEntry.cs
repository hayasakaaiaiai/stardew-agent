using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Menus;

namespace StardewAgentBridge;

/// <summary>
/// After a vanilla dialogue with a social NPC, offers "继续聊" and runs the agent conversation using only the game's
/// own dialogue box, question responses and text input (docs/game-bridge.md §4).
/// </summary>
internal sealed partial class ModEntry : Mod
{
    /// <summary>The NPCs with character cards in data/npcs.</summary>
    private static readonly HashSet<string> SocialNpcs = new()
    {
        "Abigail", "Alex", "Elliott", "Emily", "Haley", "Harvey", "Leah", "Maru", "Penny", "Sam", "Sebastian", "Shane",
        "Caroline", "Clint", "Demetrius", "Dwarf", "Evelyn", "George", "Gus", "Jas", "Jodi", "Kent", "Krobus", "Leo",
        "Lewis", "Linus", "Marnie", "Pam", "Pierre", "Robin", "Sandy", "Vincent", "Willy", "Wizard",
    };

    /// <summary>How often the "…" bubble is repeated while the NPC is thinking.</summary>
    private const int EmoteEveryTicks = 90;
    private const int MaxTypedLength = 60;

    private ModConfig config = null!;
    private BridgeClient bridge = null!;
    private string loadNonce = Guid.NewGuid().ToString("N");
    private int seq;
    private int announcedGeneration;
    private NPC? offerFor;
    private NPC? startFor;
    private Talk? talk;
    /// <summary>Whether <see cref="Game1.isTimePaused"/> is our pause while a reply is on its way.</summary>
    private bool clockPaused;

    /// <summary>Dialogues this mod created, so closing them never counts as a vanilla dialogue ending.</summary>
    private readonly ConditionalWeakTable<Dialogue, object> ownDialogues = new();

    /// <summary>One agent conversation. At most one action is pending between ticks.</summary>
    private sealed class Talk
    {
        public Talk(NPC npc) => this.Npc = npc;

        public NPC Npc { get; }
        public bool Waiting;
        public int WaitedTicks;
        public int RequestSeq;
        public string Reply = "";
        public string Emotion = "neutral";
        public List<string> Options = new();
        public bool End;
        public Dialogue? Shown;
        public TitleTextInputMenu? Input;
        public string? SayNext;
        public bool TypeNext;
        public bool ReshowNext;
        public bool LeaveNext;
        /// <summary>This opening asks the player out (Invites.cs); once its reply arrives, the day is kept.</summary>
        public bool Inviting;
    }

    public override void Entry(IModHelper helper)
    {
        this.config = helper.ReadConfig<ModConfig>();
        this.ConfigureMemoryTest();
        this.bridge = new BridgeClient(new Uri(this.config.BackendUrl), this.Monitor, this.ModManifest.Version.ToString());

        helper.Events.GameLoop.GameLaunched += (_, _) =>
        {
            this.bridge.Start();
            this.BeginAbigailTestIfRequested();
            this.BeginMemoryTestIfRequested();
        };
        helper.Events.GameLoop.SaveLoaded += (_, _) => this.OnSaveLoaded();
        helper.Events.GameLoop.DayStarted += (_, _) => this.OnDayStarted();
        helper.Events.GameLoop.DayEnding += (_, _) => this.OnDayEnding();
        helper.Events.GameLoop.Saving += (_, _) => this.OnSaving();
        helper.Events.GameLoop.Saved += (_, _) => this.OnSaved();
        helper.Events.GameLoop.ReturnedToTitle += (_, _) => this.OnReturnedToTitle();
        helper.Events.GameLoop.TimeChanged += (_, _) => this.OnTimeChanged();
        // Dungeon levels are dropped overnight with whoever is in them (MineCompanion.cs).
        helper.Events.GameLoop.DayEnding += (_, _) => this.ReleaseCompanions();
        helper.Events.GameLoop.DayEnding += (_, _) => this.ReleaseOutings();
        helper.Events.GameLoop.UpdateTicking += (_, _) => this.RescueBeforeUpdate();
        helper.Events.Player.Warped += (_, e) => this.OnWarped(e);
        helper.Events.GameLoop.UpdateTicked += this.OnUpdateTicked;
        helper.Events.Display.MenuChanged += this.OnMenuChanged;
        helper.Events.Content.AssetRequested += this.OnAssetRequested;
        helper.Events.Input.ButtonPressed += this.OnButtonPressed;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
            this.bridge?.Dispose();
        base.Dispose(disposing);
    }

    // ---- Game events ----

    private void OnMenuChanged(object? sender, MenuChangedEventArgs e)
    {
        if (e.OldMenu is DialogueBox { characterDialogue: Dialogue closed } && e.NewMenu is null)
        {
            if (this.ownDialogues.TryGetValue(closed, out _))
                this.OwnDialogueClosed(closed);
            else if (closed.speaker is NPC npc && this.talk is null && this.ShouldOffer(npc))
                this.offerFor = npc;
        }

        // The text input closed without sending: Escape, or an empty line. Show the last line again.
        if (this.talk is { } t && t.Input is not null && ReferenceEquals(e.OldMenu, t.Input))
        {
            t.Input = null;
            if (t.SayNext is null)
                t.ReshowNext = true;
        }
    }

    private void OnButtonPressed(object? sender, ButtonPressedEventArgs e)
    {
        if (e.Button == SButton.Escape && this.abigailTestRequest is not null)
            this.FinishAbigailTest(false, "用户按 Esc 取消自动测试。");
        if (e.Button == SButton.Escape && this.memoryTest is not null)
            this.FinishMemoryTest(false, "用户按 Esc 取消记忆验收。");
        if (this.talk is { Waiting: true } && e.Button == SButton.Escape)
            this.EndTalk(null);
    }

    private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
    {
        if (!this.bridge.IsConnected || this.bridge.Generation != this.announcedGeneration)
        {
            this.memoryReady = false;
            if (this.talk is not null)
                this.EndTalk($"（连接断开了，过一会儿再来找{this.talk.Npc.displayName}聊吧。）");
        }
        // Keep a title-return event until it is acknowledged, even though the world has already unloaded.
        if (this.initialSave is not null && (this.activeLoad || this.lifecycle.Count > 0)
            && this.bridge.IsConnected && this.bridge.Generation != this.announcedGeneration)
            this.AnnounceSave();

        while (this.bridge.TryReceive(out JsonElement message))
            this.Handle(message);

        if (this.talk is { } t)
            this.TickTalk(t);
        if (e.IsMultipleOf(30) && this.memoryTest?.BubblesOnly != true)
            this.TickBubbles();
        this.TickScenes(e);
        this.TickAmbient(e);
        this.TickApproach(e);
        if (e.IsMultipleOf(30))
            this.TickMeetings();
        this.TickCompanions(e);
        this.TickOutings(e);
        this.TickFestivalMeetings();
        this.TickGifts();
        this.TickTown();
        this.TickFestival();

        this.TickAbigailTest();
        this.TickMemoryTest();

        // Everything below opens a menu, so it waits until the previous one has fully closed.
        if (Game1.activeClickableMenu is not null || Game1.dialogueUp || !Context.IsWorldReady)
            return;
        if (this.offerFor is NPC offer)
        {
            this.offerFor = null;
            this.Offer(offer);
        }
        else if (this.startFor is NPC start)
        {
            this.startFor = null;
            this.StartTalk(start);
        }
        else if (this.talk is { } pending)
        {
            this.RunPending(pending);
        }
    }

    // ---- Conversation flow ----

    private bool ShouldOffer(NPC npc)
    {
        return this.config.OfferContinueChat
            && this.CanChat
            && Context.IsWorldReady
            && SocialNpcs.Contains(npc.Name)
            && !ColdShoulder(npc.Name)
            && !Game1.eventUp
            && !Game1.isFestival();
    }

    /// <summary>
    /// The week after a group ten-heart confrontation, when vanilla has these six refuse to talk to the player
    /// (docs/legacy-cleanup.md §6). The event's dump command sets these dialogue events.
    /// </summary>
    private static bool ColdShoulder(string name)
    {
        string? key = name switch
        {
            "Abigail" or "Emily" or "Haley" or "Leah" or "Maru" or "Penny" => "dumped_Girls",
            "Alex" or "Elliott" or "Harvey" or "Sam" or "Sebastian" or "Shane" => "dumped_Guys",
            _ => null,
        };
        return key is not null && Game1.player.activeDialogueEvents.ContainsKey(key);
    }

    private void Offer(NPC npc)
    {
        Game1.currentLocation.createQuestionDialogue(
            $"要继续和{npc.displayName}聊聊吗？",
            new[] { new Response("chat", "继续聊"), new Response("leave", "离开") },
            (_, answer) =>
            {
                if (answer == "chat")
                    this.startFor = npc;
            });
    }

    private void StartTalk(NPC npc)
    {
        if (!this.CanChat)
        {
            Game1.addHUDMessage(HUDMessage.ForCornerTextbox("记忆还在整理，稍等一下再聊吧。"));
            return;
        }
        this.talk = new Talk(npc);
        Dictionary<string, object?> fields = new()
        {
            ["npc"] = npc.Name,
            ["hearts"] = GameState.Hearts(npc),
            ["relation"] = GameState.Relation(npc),
            ["seenEvents"] = GameState.SeenEvents(),
            ["inPersonGifts"] = this.config.InPersonGifts,
            ["world"] = GameState.World(),
        };
        GameState.AddSchedule(fields, npc);
        if (this.MeetingTalk(npc))
        {
            fields["atMeeting"] = true;
            if (this.MeetingHelped(npc) is { } helped)
                fields["helped"] = helped;
            if (this.MeetingTrip(npc) is { } trip)
                fields["mine"] = trip;
            if (this.MeetingOuting(npc) is { } outing)
                fields["outing"] = outing;
            if (this.meetings.TryGetValue(npc.Name, out Meeting? visiting) && visiting.Surprise)
                fields["visit"] = true;
        }
        if (this.InvitesToday(npc))
            fields["invite"] = this.talk.Inviting = true;
        // So "你生日那天" names a day (docs/npc-meetings-more.md §3).
        if (npc.Birthday_Season is { Length: > 0 } season && npc.Birthday_Day is >= 1 and <= 28)
            fields["birthday"] = new Dictionary<string, object?> { ["season"] = season.ToLowerInvariant(), ["day"] = npc.Birthday_Day };
        this.talk.RequestSeq = this.Send("talk.open", fields);
        this.BeginWaiting(this.talk);
    }

    /// <summary>Runs whatever the player chose in the last dialogue box, once that box has closed.</summary>
    private void RunPending(Talk t)
    {
        // MenuChanged observes vanilla menu closes on the next tick. Keep the choice queued until then,
        // or OwnDialogueClosed will mistake the consumed choice for leaving and discard the next reply.
        if (t.Waiting || t.Shown is not null || t.Input is not null)
            return;

        if (t.SayNext is string line)
        {
            t.SayNext = null;
            t.RequestSeq = this.Send("talk.say", new() { ["npc"] = t.Npc.Name, ["text"] = line });
            this.BeginWaiting(t);
        }
        else if (t.TypeNext)
        {
            t.TypeNext = false;
            this.OpenInput(t);
        }
        else if (t.ReshowNext)
        {
            t.ReshowNext = false;
            this.ShowReply(t);
        }
        else if (t.LeaveNext)
        {
            this.EndTalk(null);
        }
    }

    private void BeginWaiting(Talk t)
    {
        t.Waiting = true;
        t.WaitedTicks = 0;
        this.PauseClock(true);
        Game1.player.Halt();
        Game1.player.CanMove = false;
        t.Npc.faceTowardFarmerForPeriod(this.config.ReplyTimeoutSeconds * 1000, 3, false, Game1.player);
        t.Npc.doEmote(Character.pauseEmote);
    }

    /// <summary>
    /// Stops or restarts the clock with vanilla's own flag, which leaves the world moving. Only a pause this mod set is
    /// released, so a <c>pausetime</c> from the console survives; in multiplayer the host's clock is not ours to stop.
    /// </summary>
    private void PauseClock(bool pause)
    {
        if (pause && !this.clockPaused && this.config.PauseClockWhileWaiting && !Context.IsMultiplayer && !Game1.isTimePaused)
        {
            Game1.isTimePaused = true;
            this.clockPaused = true;
        }
        else if (!pause && this.clockPaused)
        {
            Game1.isTimePaused = false;
            this.clockPaused = false;
        }
    }

    private void TickTalk(Talk t)
    {
        if (t.Waiting)
        {
            t.WaitedTicks++;
            if (t.WaitedTicks % EmoteEveryTicks == 0 && !t.Npc.isEmoting)
                t.Npc.doEmote(Character.pauseEmote, playSound: false);
            if (t.WaitedTicks > this.config.ReplyTimeoutSeconds * 60)
                this.EndTalk($"（{t.Npc.displayName}好像走神了，没有回答。）");
        }

        // The text box's font throws on characters it lacks; replace them before the next draw.
        if (t.Input is { } input && ReferenceEquals(Game1.activeClickableMenu, input))
        {
            string safe = SafeText.For(Game1.dialogueFont, input.textBox.Text);
            if (safe != input.textBox.Text)
                input.textBox.Text = safe;
        }
    }

    private void OnReply(Talk t, string reply, string emotion, List<string> options, bool end)
    {
        if (t.Inviting)
        {
            t.Inviting = false;
            this.Invited(t.Npc);
        }
        t.Waiting = false;
        this.PauseClock(false);
        t.Reply = reply;
        t.Emotion = emotion;
        t.Options = options;
        t.End = end;
        Game1.player.CanMove = true;
        this.ShowReply(t);
    }

    /// <summary>Shows the NPC's line in the vanilla dialogue box, with the options as vanilla responses.</summary>
    private void ShowReply(Talk t)
    {
        List<string> responses = t.End ? new List<string>() : t.Options.Concat(new[] { "自己说……", "离开" }).ToList();
        Dialogue dialogue = VanillaDialogue.Create(t.Npc, t.Reply, t.Emotion, responses, t.End ? null : index =>
        {
            if (index < t.Options.Count)
                t.SayNext = t.Options[index];
            else if (index == t.Options.Count)
                t.TypeNext = true;
            else
                t.LeaveNext = true;
        });
        this.ownDialogues.Add(dialogue, new object());
        t.Shown = dialogue;
        // The dialogue box pops the speaker's dialogue stack when it closes, so ours has to be on top of it.
        t.Npc.CurrentDialogue.Push(dialogue);
        Game1.drawDialogue(t.Npc);
    }

    private void OwnDialogueClosed(Dialogue closed)
    {
        // Never leave our line on the NPC's stack, or it would replace their next vanilla dialogue.
        NPC? npc = closed.speaker;
        if (npc is not null && npc.CurrentDialogue.Count > 0 && ReferenceEquals(npc.CurrentDialogue.Peek(), closed))
            npc.CurrentDialogue.Pop();

        if (this.talk is not { } t || !ReferenceEquals(t.Shown, closed))
            return;
        t.Shown = null;
        bool chose = t.SayNext is not null || t.TypeNext || t.LeaveNext;
        if (!chose)
            t.LeaveNext = true; // A plain closing line, or the box closed some other way.
    }

    private void OpenInput(Talk t)
    {
        TitleTextInputMenu input = new($"想对{t.Npc.displayName}说什么？", text =>
        {
            string line = text.Trim();
            if (line.Length > 0)
                t.SayNext = line;
            Game1.exitActiveMenu();
        }, filterInput: false);
        input.textBox.textLimit = MaxTypedLength;
        t.Input = input;
        Game1.activeClickableMenu = input;
    }

    private void EndTalk(string? notice)
    {
        if (this.talk is not { } t)
            return;
        this.talk = null;
        this.PauseClock(false);
        if (t.Waiting)
            Game1.player.CanMove = true;
        // Let vanilla expire our pause on its next update so it also releases freezeMotion.
        t.Npc.faceTowardFarmerTimer = Math.Min(t.Npc.faceTowardFarmerTimer, 1);
        t.Npc.movementPause = Math.Min(t.Npc.movementPause, 1);
        this.Send("talk.close", new() { ["npc"] = t.Npc.Name });
        // A line of narration, not an error: vanilla's text box without the red cross.
        if (notice is not null)
            Game1.addHUDMessage(HUDMessage.ForCornerTextbox(notice));
    }

    // ---- Backend ----

    private void Handle(JsonElement message)
    {
        string type = message.TryGetProperty("type", out JsonElement typeValue) ? typeValue.GetString() ?? "" : "";
        if (this.HandleSync(type, message) || this.HandleBubbles(type, message) || this.HandleLetters(type, message)
            || this.HandleScenes(type, message) || this.HandleAmbient(type, message) || this.HandleApproach(type, message)
            || this.HandleMeetings(type, message))
            return;
        string npc = message.TryGetProperty("npc", out JsonElement npcValue) ? npcValue.GetString() ?? "" : "";
        if (this.talk is not { Waiting: true } t || t.Npc.Name != npc || !this.IsCurrentReply(message, t.RequestSeq))
            return; // Late messages for a conversation that has already ended.
        switch (type)
        {
            case "talk.delta":
                t.WaitedTicks = 0; // Still generating, so not timed out.
                break;
            case "talk.reply":
                if (message.TryGetProperty("friendship", out JsonElement points) && points.ValueKind == JsonValueKind.Number
                    && points.TryGetInt32(out int delta))
                    this.ApplyFriendship(t.Npc, delta);
                if (this.memoryTest?.Social == true)
                    this.socialTestReplies.Add(new { seq = t.RequestSeq, npc = t.Npc.Name, nonce = this.loadNonce, day = this.currentDay,
                        friendship = message.TryGetProperty("friendship", out JsonElement socialDelta) ? socialDelta.Clone() : default,
                        points = Game1.player.friendshipData[t.Npc.Name].Points,
                        total = this.friendshipToday.GetValueOrDefault(t.Npc.Name), reply = message.GetProperty("reply").GetString() });
                if (message.TryGetProperty("gift", out JsonElement gift) && gift.ValueKind == JsonValueKind.String && gift.GetString() is { Length: > 0 } present)
                    this.GivePresent(t.Npc, present);
                this.OnReply(t,
                    message.GetProperty("reply").GetString() ?? "",
                    message.GetProperty("emotion").GetString() ?? "neutral",
                    message.GetProperty("options").EnumerateArray().Select(o => o.GetString() ?? "").Where(o => o.Length > 0).Take(3).ToList(),
                    message.GetProperty("end").GetBoolean());
                break;
            case "talk.error":
                string reason = message.TryGetProperty("message", out JsonElement m) ? m.GetString() ?? "" : "";
                this.Monitor.Log($"和 {npc} 的对话出错：{reason}", LogLevel.Warn);
                this.EndTalk($"（{t.Npc.displayName}没有回应。）");
                break;
        }
    }

}
