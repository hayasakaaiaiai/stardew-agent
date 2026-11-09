using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentBridge;

internal sealed partial class ModEntry
{
    private const string LifeSaveKey = "StardewAgent/Life/v1";
    private const int LifeEventLimit = 4096;
    private static readonly JsonSerializerOptions LifeJson = LifeEventWire.Json;

    private sealed class LifeSave
    {
        public int Version { get; set; } = 1;
        public long Serial { get; set; }
        public List<LifeEvent> Events { get; set; } = new();
        public Dictionary<string, LifeGoal> Goals { get; set; } = new();
        public List<LifeLetter> Letters { get; set; } = new();
        public int MailDay { get; set; }
        public int ActivityDay { get; set; }
        public int ActivityStarts { get; set; }
        public Dictionary<string, RomanceState> Romance { get; set; } = new();
        public int RomanceInvitationDay { get; set; }
        public Dictionary<string, TownStoryState> Stories { get; set; } = new();
        public Dictionary<string, LongGoalState> LongGoals { get; set; } = new();
        public Dictionary<string, GoalResultState> GoalResults { get; set; } = new();
        public Dictionary<string, TownCaseState> Cases { get; set; } = new();
    }

    private LifeSave lifeSave = new();
    private List<LifeEvent> lifeEvents => this.lifeSave.Events;
    private readonly LifeSyncCursor lifeSync = new();
    private bool lifeReady { get => this.lifeSync.Ready; set => this.lifeSync.Ready = value; }
    private bool lifeSupported;
    private bool lifeCorrupt;

    // Existing activities can finish offline: their evidence is saved with the game and replayed later.
    private bool CanRecordLifeEvent => this.CanRecordLifeEvents(1);
    private bool CanRecordLifeEvents(int count) => this.activeLoad && !this.syncFailed && !this.lifeCorrupt
        && Context.IsWorldReady && count > 0 && this.lifeEvents.Count <= LifeEventLimit - count
        && this.lifeSave.Serial <= 9007199254740991L - count;
    private int LifeActivityStartsToday => this.lifeSave.ActivityDay == this.currentDay ? this.lifeSave.ActivityStarts : 0;

    private bool ReserveLifeActivitySlot()
    {
        if (!this.lifeSupported || !this.CanChat || !this.CanRecordLifeEvents(2) || this.meetings.Values.Count(m => !m.Surprise) + this.LifeActivityStartsToday >= MeetsPerDay)
        {
            this.LifeNotice("今天的共同活动和约定已满，或生活记录暂时不能写入。请稍后再安排。");
            return false;
        }
        int oldDay = this.lifeSave.ActivityDay, oldCount = this.lifeSave.ActivityStarts;
        this.lifeSave.ActivityStarts = this.LifeActivityStartsToday + 1;
        this.lifeSave.ActivityDay = this.currentDay;
        try { this.PersistLife(); return true; }
        catch
        {
            this.lifeSave.ActivityDay = oldDay; this.lifeSave.ActivityStarts = oldCount;
            return false;
        }
    }

    private void UndoLifeActivitySlot()
    {
        if (this.lifeSave.ActivityDay == this.currentDay && this.lifeSave.ActivityStarts > 0)
        {
            this.lifeSave.ActivityStarts--;
            try { this.PersistLife(); }
            catch (Exception ex)
            {
                this.lifeCorrupt = true;
                this.Monitor.Log("生活活动计数无法恢复，已停用新的生活动作：" + ex.Message, LogLevel.Error);
            }
        }
    }

    private void LoadLife()
    {
        this.ClearLifeActivities();
        this.ClearStoryIntervals();
        this.ClearCaseClocks();
        this.ClearLongGoalIntervals();
        this.ClearGoalResults();
        this.goalsUpgradeNotified = false;
        this.storiesUpgradeNotified = false;
        this.romanceUpgradeNotified = false;
        this.lifeReady = false; this.lifeCorrupt = false;
        this.lifeSync.Reset();
        this.lifeSave = new();
        if (!this.activeLoad || !Game1.player.modData.TryGetValue(LifeSaveKey, out string? json))
            return;
        try
        {
            LifeSave saved = JsonSerializer.Deserialize<LifeSave>(json, LifeJson) ?? throw new InvalidOperationException("生活记录为空。");
            if (saved.Version is not (1 or 2 or 3 or 4) || saved.Serial < 0 || saved.Serial > 9007199254740991L || saved.Events is null
                || saved.Goals is null || saved.Letters is null || saved.Romance is null || saved.Stories is null || saved.LongGoals is null || saved.GoalResults is null || saved.Cases is null || saved.Events.Count > LifeEventLimit
                || saved.Events.Any(e => e is null || e.Day < 1 || e.Day > AbsoluteDay())
                || !LifeGoalRules.OrderedEventIds(saved.Events.Select(e => e.Id), saved.Serial))
                throw new InvalidOperationException("生活记录版本或内容无效；原始记录保留。");
            this.lifeSave = saved;
            this.ValidateRomanceSave();
            this.ValidateStorySave();
            this.ValidateCaseSave();
            this.ValidateLongGoalSave();
            this.ValidateGoalResultSave();
            this.QueueGoalResultRecovery();
            // A loaded game starts at morning; no unfinished actor controller survives the save boundary.
            foreach (LifeGoal goal in saved.Goals.Values)
                if (goal.Stage == "walking") { goal.Stage = "ready"; goal.Attempt = null; }
        }
        catch (Exception ex)
        {
            this.lifeCorrupt = true;
            this.Monitor.Log("生活功能暂停：" + ex.Message, LogLevel.Warn);
        }
    }

    private void PersistLife()
    {
        if (!this.activeLoad || this.lifeCorrupt || !Context.IsWorldReady)
            return;
        Game1.player.modData[LifeSaveKey] = JsonSerializer.Serialize(this.lifeSave, LifeJson);
    }

    private bool EmitLifeEvent(string npc, string kind, string? activity = null, string? goal = null, string? item = null,
        int? count = null, int? minutes = null, string? other = null, string? sourceId = null, int? friendship = null)
        => this.AppendLifeEvent(new LifeEvent
        {
            Npc = npc.ToLowerInvariant(), Kind = kind, Activity = activity, Goal = goal, Item = item, Count = count,
            Minutes = minutes, Other = other?.ToLowerInvariant(), SourceId = sourceId, Friendship = friendship,
        });

    private bool AppendLifeEvent(LifeEvent entry)
    {
        if (!this.CanRecordLifeEvent)
        {
            if (Context.IsWorldReady)
                Game1.addHUDMessage(new HUDMessage("生活记录暂时不可写入，请先保存并查看日志。", HUDMessage.error_type));
            return false;
        }
        long serial = this.lifeSave.Serial;
        int version = this.lifeSave.Version;
        entry.Id = "life-" + (serial + 1);
        entry.Day = this.currentDay;
        this.lifeSave.Serial = serial + 1;
        this.lifeSave.Version = TownCaseRules.VersionAfterEvent(GoalResultRules.VersionAfterEvent(LongGoalRules.VersionAfterEvent(version, entry.Kind), entry.Kind), entry);
        this.lifeEvents.Add(entry);
        try { this.PersistLife(); }
        catch (Exception ex)
        {
            this.lifeEvents.RemoveAt(this.lifeEvents.Count - 1);
            this.lifeSave.Serial = serial;
            this.lifeSave.Version = version;
            this.Monitor.Log("生活记录保存失败：" + ex.Message, LogLevel.Error);
            return false;
        }
        this.lifeReady = false;
        this.SendNextLifeBatch();
        return true;
    }

    private void RestartLifeSync()
    {
        this.lifeReady = false;
        this.lifeSync.Reset();
    }

    private void SendNextLifeBatch()
    {
        if (!this.lifeSupported || this.lifeSync.Request != 0 || !this.memoryReady || this.syncFailed || !this.activeLoad || this.lifeCorrupt
            || !this.bridge.IsConnected || this.bridge.Generation != this.announcedGeneration)
            return;
        if (!this.RomanceCompatible)
        {
            this.ReportRomanceCompatibility();
            return;
        }
        if (!this.StoriesCompatible)
        {
            this.ReportStoryCompatibility();
            return;
        }
        if (!this.CasesCompatible)
        {
            this.ReportCaseCompatibility();
            return;
        }
        if (!this.LongGoalsCompatible)
        {
            this.ReportLongGoalCompatibility();
            return;
        }
        if (!this.GoalResultsCompatible)
        {
            this.ReportGoalResultCompatibility();
            return;
        }
        var batch = this.lifeSync.Next(this.lifeEvents.Count);
        int request = this.Send("life.sync", new()
        {
            ["events"] = LifeEventWire.Encode(this.lifeEvents.Skip(batch.Start).Take(batch.Count)),
            ["final"] = batch.Final,
        });
        this.lifeSync.Sent(batch.Count, request);
    }

    private void LifeAcknowledged(int request)
    {
        if (this.lifeSync.Acknowledge(request) && this.lifeSync.Cursor < this.lifeEvents.Count)
            this.SendNextLifeBatch();
    }

    private bool HandleLife(string type, JsonElement message)
    {
        if (type == "hello")
        {
            this.lifeSupported = message.TryGetProperty("lifeProtocol", out JsonElement capability)
                && capability.TryGetInt32(out int version) && version == 1;
            this.romanceSupported = message.TryGetProperty("romanceProtocol", out JsonElement romanceCapability)
                && romanceCapability.TryGetInt32(out int romanceVersion) && romanceVersion == 1;
            this.romanceUpgradeNotified = false;
            this.ReportRomanceCompatibility();
            this.storiesSupported = message.TryGetProperty("storiesProtocol", out JsonElement storiesCapability)
                && storiesCapability.TryGetInt32(out int storiesVersion) && storiesVersion == 1;
            this.storiesUpgradeNotified = false;
            this.ReportStoryCompatibility();
            this.casesSupported = message.TryGetProperty("casesProtocol", out JsonElement casesCapability)
                && casesCapability.TryGetInt32(out int casesVersion) && casesVersion == 1;
            this.casesUpgradeNotified = false;
            this.ReportCaseCompatibility();
            this.goalsSupported = message.TryGetProperty("goalsProtocol", out JsonElement goalsCapability)
                && goalsCapability.TryGetInt32(out int goalsVersion) && goalsVersion == 1;
            this.goalsUpgradeNotified = false;
            this.ReportLongGoalCompatibility();
            this.resultsSupported = message.TryGetProperty("resultsProtocol", out JsonElement resultsCapability)
                && resultsCapability.TryGetInt32(out int resultsVersion) && resultsVersion == 1;
            this.resultsUpgradeNotified = false;
            this.ReportGoalResultCompatibility();
            if (!this.lifeSupported)
            {
                this.Monitor.Log("当前后端不支持生活功能，请同时更新后端和 Mod。普通聊天仍可使用。", LogLevel.Warn);
                if (Context.IsWorldReady)
                    Game1.addHUDMessage(new HUDMessage("生活功能需要更新后端；普通聊天仍可使用。", HUDMessage.error_type));
            }
            return true;
        }
        if (type != "life.ready")
            return false;
        if (!this.IsCurrentMessage(message) || !message.TryGetProperty("seq", out JsonElement seqValue)
            || !seqValue.TryGetInt32(out int request))
            return true;
        // ACK and ready may arrive in either order; only the current final batch unlocks conversation.
        this.lifeSync.Complete(request, this.lifeEvents.Count);
        return true;
    }

    private void ClearLife()
    {
        this.ClearLifeActivities();
        this.ClearStoryIntervals();
        this.ClearCaseClocks();
        this.ClearLongGoalIntervals();
        this.ClearGoalResults();
        this.lifeSave = new(); this.lifeReady = false; this.lifeCorrupt = false;
        this.lifeSync.Reset();
    }
}
