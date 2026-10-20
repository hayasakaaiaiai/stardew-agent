using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>Bounded, immutable lifecycle messages. Only an acknowledgement removes an event.</summary>
internal sealed class ReliableOutbox
{
    public const int Capacity = 2000;
    private readonly SortedDictionary<int, JsonElement> pending = new();
    public int Count => this.pending.Count;
    public JsonElement[] Messages() => this.pending.Values.ToArray();
    public void Clear() => this.pending.Clear();
    public void Acknowledge(int seq) => this.pending.Remove(seq);
    public bool Add(int seq, Dictionary<string, object?> fields)
    {
        if (this.pending.Count >= Capacity)
            return false;
        using JsonDocument document = JsonDocument.Parse(JsonSerializer.Serialize(fields));
        this.pending.Add(seq, document.RootElement.Clone());
        return true;
    }
}

/// <summary>This pointer is stored by SMAPI inside the game save, so old save backups keep their own history.</summary>
internal sealed class MemoryCommit
{
    public int Format { get; set; } = 1;
    public string LineageId { get; set; } = "";
    public string CommitId { get; set; } = "";
    public string? ParentId { get; set; }
    public int DayEnded { get; set; }
    public Dictionary<string, object?> Message() => new()
    {
        ["commitId"] = this.CommitId, ["parentId"] = this.ParentId, ["dayEnded"] = this.DayEnded,
    };
}

internal sealed partial class ModEntry
{
    private const string MemorySaveKey = "memory-commit";
    private readonly ReliableOutbox lifecycle = new();
    private Dictionary<string, object?>? initialSave;
    private string lineageId = "";
    private MemoryCommit? savedCommit;
    private MemoryCommit? pendingCommit;
    private int currentDay;
    private bool activeLoad;
    private bool memoryReady;
    private bool syncFailed;

    private bool CanChat => this.activeLoad && this.memoryReady && !this.syncFailed && this.lifecycle.Count == 0
        && this.bridge.IsConnected && this.bridge.Generation == this.announcedGeneration;

    private void OnSaveLoaded()
    {
        this.ClearBubbles();
        this.ClearScenes();
        this.ResetGifts();
        this.ClearFriendshipToday();
        this.ClearPresentsToday();
        this.talk = null; this.offerFor = null; this.startFor = null;
        this.initialSave = null; this.lifecycle.Clear(); this.memoryReady = false; this.syncFailed = false;
        this.activeLoad = Context.IsMainPlayer;
        this.LoadLetters();
        if (!this.activeLoad)
        {
            this.Monitor.Log("当前为农场帮手，AI 记忆由主玩家管理，本机不写共享存档。", LogLevel.Info);
            return;
        }
        this.lineageId = Game1.uniqueIDForThisGame.ToString();
        this.loadNonce = Guid.NewGuid().ToString("N"); this.seq = 0;
        this.currentDay = AbsoluteDay(); this.pendingCommit = null;
        try
        {
            this.savedCommit = this.Helper.Data.ReadSaveData<MemoryCommit>(MemorySaveKey);
            if (this.savedCommit is { } p && (p.Format != 1 || p.LineageId != this.lineageId || p.DayEnded < 1 || string.IsNullOrWhiteSpace(p.CommitId)))
                throw new InvalidOperationException("存档内记忆指针无效；请保留存档和记忆数据库以便检查。");
            this.initialSave = new()
            {
                ["type"] = "save.loaded", ["lineageId"] = this.lineageId, ["loadNonce"] = this.loadNonce, ["seq"] = 0,
                ["player"] = GameState.Player(), ["date"] = GameState.Date(), ["commit"] = this.savedCommit?.Message(),
            };
            this.AnnounceSave();
        }
        catch (Exception ex) { this.FailSync(ex.Message); }
    }

    private void OnDayStarted()
    {
        this.ClearBubbles();
        this.ClearScenes();
        this.ResetGifts();
        this.ClearFriendshipToday();
        this.ClearPresentsToday();
        if (!this.activeLoad || this.initialSave is null)
            return;
        this.EndTalk(null);
        this.currentDay = AbsoluteDay();
        this.Send("day.started", new() { ["date"] = GameState.Date(), ["weather"] = GameState.Weather() });
    }

    private void OnSaving()
    {
        if (!this.activeLoad || this.initialSave is null || this.syncFailed)
            return;
        this.EndTalk(null);
        MemoryCommit pointer = new()
        {
            LineageId = this.lineageId, CommitId = Guid.NewGuid().ToString("N"),
            ParentId = this.savedCommit?.CommitId, DayEnded = this.currentDay,
        };
        try
        {
            this.Helper.Data.WriteSaveData(MemorySaveKey, pointer);
            this.pendingCommit = pointer;
            this.Send("save.saving", new() { ["commit"] = pointer.Message() });
        }
        catch (Exception ex) { this.FailSync(ex.Message); }
    }

    private void OnSaved()
    {
        if (this.pendingCommit is not { } pointer)
            return;
        this.savedCommit = pointer; this.pendingCommit = null;
        this.Send("save.saved", new() { ["commitId"] = pointer.CommitId, ["date"] = GameState.Date() });
    }

    private void OnReturnedToTitle()
    {
        this.ClearBubbles();
        this.ClearScenes();
        this.letters = new();
        this.talk = null; this.offerFor = null; this.startFor = null;
        this.activeLoad = false; this.memoryReady = false;
        if (this.initialSave is not null)
            this.Send("title.returned", new());
    }

    private static int AbsoluteDay() => (Game1.year - 1) * 112 + Game1.Date.SeasonIndex * 28 + Game1.dayOfMonth;

    private void AnnounceSave()
    {
        if (this.initialSave is null || !this.bridge.IsConnected)
            return;
        this.announcedGeneration = this.bridge.Generation; this.memoryReady = false;
        this.bridge.Send(this.initialSave);
        foreach (JsonElement message in this.lifecycle.Messages())
            this.bridge.Send(message);
    }

    private int Send(string type, Dictionary<string, object?> fields)
    {
        if (this.initialSave is null)
            return 0;
        fields["type"] = type; fields["lineageId"] = this.lineageId;
        fields["loadNonce"] = this.loadNonce; fields["seq"] = ++this.seq;
        if (type == "talk.say")
            fields["date"] = GameState.Date();
        bool reliable = type is "day.started" or "save.saving" or "save.saved" or "title.returned" or "gift.given";
        if (reliable && !this.lifecycle.Add(this.seq, fields))
        {
            this.FailSync("记忆同步队列已满，本次读档停用 AI；原版游戏可继续，请保留日志并重新读档。");
            return this.seq;
        }
        if (this.bridge.IsConnected && this.bridge.Generation == this.announcedGeneration)
            this.bridge.Send(fields);
        return this.seq;
    }

    private bool IsCurrentMessage(JsonElement message) => this.initialSave is not null
        && message.TryGetProperty("lineageId", out JsonElement lineage) && lineage.GetString() == this.lineageId
        && message.TryGetProperty("loadNonce", out JsonElement nonce) && nonce.GetString() == this.loadNonce;

    private bool IsCurrentReply(JsonElement message, int requestSeq) => this.IsCurrentMessage(message)
        && message.TryGetProperty("seq", out JsonElement value) && value.TryGetInt32(out int seq) && seq == requestSeq;

    private bool HandleSync(string type, JsonElement message)
    {
        if (type == "sync.error")
        {
            if (!message.TryGetProperty("loadNonce", out _) || this.IsCurrentMessage(message))
                this.FailSync(message.GetProperty("message").GetString() ?? "记忆同步失败。");
            return true;
        }
        if (type is not ("save.ready" or "ack"))
            return false;
        if (!this.IsCurrentMessage(message))
            return true;
        if (type == "save.ready")
            this.memoryReady = true;
        else
            this.lifecycle.Acknowledge(message.GetProperty("seq").GetInt32());
        return true;
    }

    private void FailSync(string reason)
    {
        this.syncFailed = true; this.memoryReady = false;
        this.EndTalk(null);
        this.Monitor.Log("AI 记忆同步已停止：" + reason, LogLevel.Warn);
        if (Context.IsWorldReady)
            Game1.addHUDMessage(new HUDMessage("AI 记忆同步失败，请查看 SMAPI 日志；原版游戏可继续。", HUDMessage.error_type));
    }
}
