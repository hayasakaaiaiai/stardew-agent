using System;
using System.Collections.Generic;
using System.Linq;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>
/// Now and then a close NPC asks the player out (docs/npc-invites.md): about one day in three, one NPC, chosen from the
/// save's id and the date so a reload brings the same one, walks over and asks on its first opening of the day. The day
/// it asked is kept with the save, so the same NPC waits a week before asking again.
/// </summary>
internal sealed partial class ModEntry
{
    private const int InviteHearts = 8;
    private const int InviteGapDays = 7;
    /// <summary>About one day in this many has someone ask.</summary>
    private const int InviteEveryDays = 3;
    /// <summary>The player's modData key, plus the NPC's name: the absolute day it last asked.</summary>
    private const string InvitedKey = "StardewAgent/invited/";

    /// <summary>Today's, once worked out after the day's appointments arrived: the NPC that asks, or null for nobody.</summary>
    private string? inviter;
    private int inviterDay = -1;
    /// <summary>The day's appointments have arrived since the day started or the save loaded.</summary>
    private bool meetingsArrived;

    private void ClearInvites()
    {
        this.inviter = null;
        this.inviterDay = -1;
        this.meetingsArrived = false;
    }

    /// <summary>SplitMix64: a well-spread number from another, the same on every run.</summary>
    private static ulong InviteMix(ulong value)
    {
        value += 0x9E3779B97F4A7C15;
        value = (value ^ (value >> 30)) * 0xBF58476D1CE4E5B9;
        value = (value ^ (value >> 27)) * 0x94D049BB133111EB;
        return value ^ (value >> 31);
    }

    /// <summary>FNV-1a over the name: string.GetHashCode differs from run to run.</summary>
    private static ulong InviteName(string name)
    {
        ulong hash = 0xCBF29CE484222325;
        foreach (char c in name)
            hash = (hash ^ c) * 0x100000001B3;
        return hash;
    }

    internal static bool InviteDay(ulong game, int day) => InviteMix(game ^ InviteMix((ulong)day)) % InviteEveryDays == 0;

    /// <summary>One of those who may ask, the same one for the same save and day.</summary>
    internal static string? ChooseInviter(ulong game, int day, IEnumerable<string> eligible)
        => eligible.OrderBy(name => InviteMix(game ^ InviteMix((ulong)day) ^ InviteName(name))).ThenBy(name => name, StringComparer.Ordinal).FirstOrDefault();

    /// <summary>Asked within the last week, by the day kept in the save.</summary>
    internal static bool AskedLately(int? lastAsked, int today) => lastAsked is int last && today - last < InviteGapDays;

    private static int? LastAsked(string npc)
        => Game1.player.modData.TryGetValue(InvitedKey + npc, out string? value) && int.TryParse(value, out int day) ? day : null;

    /// <summary>Close but not living together, free today, and not one who asked this past week.</summary>
    private bool MayInvite(string name, int today)
    {
        if (Game1.getCharacterFromName(name) is not NPC npc || npc.IsInvisible || this.meetings.ContainsKey(name) || AskedLately(LastAsked(name), today))
            return false;
        string relation = GameState.Relation(npc);
        return relation is not ("married" or "roommate") && (GameState.Hearts(npc) >= InviteHearts || relation is "dating" or "engaged");
    }

    /// <summary>Today's, worked out once the day's appointments are known; null on most days.</summary>
    private string? TodayInviter()
    {
        if (!this.config.NpcInvites || !this.config.NpcMeetings || !Context.IsWorldReady || !this.activeLoad)
            return null;
        int today = (int)Game1.Date.TotalDays;
        if (this.inviterDay == today)
            return this.inviter;
        if (!this.meetingsArrived)
            return null;
        this.inviterDay = today;
        ulong game = Game1.uniqueIDForThisGame;
        this.inviter = !Utility.isFestivalDay(Game1.dayOfMonth, Game1.season) && InviteDay(game, today)
            ? ChooseInviter(game, today, SocialNpcs.Where(name => this.MayInvite(name, today))) : null;
        if (this.inviter is not null)
            this.Monitor.Log($"今天想约农场主的：{this.inviter}。", LogLevel.Info);
        return this.inviter;
    }

    /// <summary>Walks over like one with something to say, until it has asked or the day is over.</summary>
    private bool InvitesToday(NPC npc) => this.TodayInviter() is string name && name.Equals(npc.Name, StringComparison.OrdinalIgnoreCase)
        && this.MayInvite(npc.Name, (int)Game1.Date.TotalDays) && Game1.timeOfDay < ApproachLatestTime;

    /// <summary>Its opening asked: kept with the save, so a reload without saving forgets it.</summary>
    private void Invited(NPC npc)
    {
        int today = (int)Game1.Date.TotalDays;
        Game1.player.modData[InvitedKey + npc.Name] = today.ToString();
        this.Monitor.Log($"{npc.displayName}开口约了农场主。", LogLevel.Info);
    }
}
