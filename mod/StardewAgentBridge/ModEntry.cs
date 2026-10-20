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
        helper.Events.GameLoop.Saving += (_, _) => this.OnSaving();
        helper.Events.GameLoop.Saved += (_, _) => this.OnSaved();
        helper.Events.GameLoop.ReturnedToTitle += (_, _) => this.OnReturnedToTitle();
        helper.Events.GameLoop.UpdateTicked += this.OnUpdateTicked;
        helper.Events.Display.MenuChanged += this.OnMenuChanged;
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
                this.EndTalk("（后端已断开，重连后可以重新开口。）");
        }
        // Keep a title-return event until it is acknowledged, even though the world has already unloaded.
        if (this.initialSave is not null && (this.activeLoad || this.lifecycle.Count > 0)
            && this.bridge.IsConnected && this.bridge.Generation != this.announcedGeneration)
            this.AnnounceSave();

        while (this.bridge.TryReceive(out JsonElement message))
            this.Handle(message);

        if (this.talk is { } t)
            this.TickTalk(t);

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
            && !Game1.eventUp
            && !Game1.isFestival();
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
            Game1.addHUDMessage(new HUDMessage("AI 记忆正在同步，请稍后再聊。", HUDMessage.error_type));
            return;
        }
        this.talk = new Talk(npc);
        this.talk.RequestSeq = this.Send("talk.open", new()
        {
            ["npc"] = npc.Name,
            ["hearts"] = GameState.Hearts(npc),
            ["relation"] = GameState.Relation(npc),
            ["seenEvents"] = GameState.SeenEvents(),
            ["world"] = GameState.World(),
        });
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
        Game1.player.Halt();
        Game1.player.CanMove = false;
        t.Npc.faceTowardFarmerForPeriod(this.config.ReplyTimeoutSeconds * 1000, 3, false, Game1.player);
        t.Npc.doEmote(Character.pauseEmote);
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
        t.Waiting = false;
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
        if (t.Waiting)
            Game1.player.CanMove = true;
        this.Send("talk.close", new() { ["npc"] = t.Npc.Name });
        if (notice is not null)
            Game1.addHUDMessage(new HUDMessage(notice, HUDMessage.error_type));
    }

    // ---- Backend ----

    private void Handle(JsonElement message)
    {
        string type = message.TryGetProperty("type", out JsonElement typeValue) ? typeValue.GetString() ?? "" : "";
        if (this.HandleSync(type, message))
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
