using System;
using System.Collections.Generic;
using System.Globalization;

namespace StardewAgentBridge;

/// <summary>Rules shared by native-menu mutations and the offline transition tests.</summary>
internal static class LifeGoalRules
{
    internal static bool CurrentMenu(string menuNonce, string activeNonce, int menuDay, int activeDay)
        => menuNonce == activeNonce && menuDay == activeDay;

    internal static bool CanAccept(string? stage) => stage is null;
    internal static bool CanDeliver(string stage, int available, int required)
        => stage == "collecting" && required > 0 && available >= required;
    internal static bool CanClose(string stage) => stage is "collecting" or "ready";

    internal static int[]? DeliveryPlan(IReadOnlyList<int> stacks, int required)
    {
        if (required <= 0) return null;
        long available = 0;
        foreach (int count in stacks) { if (count < 0) return null; available += count; }
        if (available < required) return null;
        int[] take = new int[stacks.Count];
        int remaining = required;
        for (int i = 0; i < stacks.Count; i++) { take[i] = Math.Min(stacks[i], remaining); remaining -= take[i]; }
        return take;
    }

    /// <summary>An unrelated or stale attempt has no effect; a real unfinished attempt keeps already-paid materials.</summary>
    internal static string? EndAttempt(string stage, string goalId, string? attempt, string boundGoal,
        bool completed, int minutes, int requiredMinutes, int count, bool needsCatch)
    {
        if (stage != "walking" || string.IsNullOrEmpty(attempt) || boundGoal != goalId + "@" + attempt)
            return null;
        return completed && minutes >= requiredMinutes && (!needsCatch || count > 0) ? "completed" : "ready";
    }

    internal static bool OrderedEventIds(IEnumerable<string> ids, long serial)
    {
        if (serial < 0 || serial > 9007199254740991L) return false;
        long previous = 0;
        foreach (string id in ids)
        {
            if (id is null || !id.StartsWith("life-", StringComparison.Ordinal)
                || !long.TryParse(id.AsSpan(5), NumberStyles.None, CultureInfo.InvariantCulture, out long value)
                || value <= previous || value > serial || id != "life-" + value.ToString(CultureInfo.InvariantCulture)) return false;
            previous = value;
        }
        return true;
    }
}

/// <summary>The actual bounded wire replay cursor: ACK advances it, the matching final ready unlocks conversation.</summary>
internal sealed class LifeSyncCursor
{
    internal int Cursor { get; private set; }
    internal int BatchEnd { get; private set; }
    internal int Request { get; private set; }
    internal int LastRequest { get; private set; }
    internal bool Ready { get; set; }
    internal int UnsentStart => this.Request == 0 ? this.Cursor : this.BatchEnd;

    internal void Reset() { this.Cursor = 0; this.BatchEnd = 0; this.Request = 0; this.LastRequest = 0; this.Ready = false; }
    internal (int Start, int Count, bool Final) Next(int total)
    {
        if (this.Request != 0 || total < this.Cursor) throw new InvalidOperationException("Life replay is not ready for a new batch.");
        int count = Math.Min(32, total - this.Cursor);
        return (this.Cursor, count, this.Cursor + count == total);
    }
    internal void Sent(int count, int request, bool afterPending = false)
    {
        if (request < 1 || count < 0 || count > 32 || this.Request != 0 && !afterPending) throw new ArgumentOutOfRangeException(nameof(request));
        // Save-time batches are queued in wire order. Their last ACK covers all earlier batches.
        this.BatchEnd = this.UnsentStart + count; this.Request = request; this.LastRequest = request; this.Ready = false;
    }
    internal bool Acknowledge(int request)
    {
        if (request != this.Request || request == 0) return false;
        this.Cursor = this.BatchEnd; this.Request = 0; return true;
    }
    internal bool Complete(int request, int total)
    {
        if (request != this.LastRequest || request == 0) return false;
        this.Ready = this.BatchEnd == total;
        return this.Ready;
    }
}
