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
    /// <summary>The same for the day the player last stood it up (docs/npc-meetings-more.md §2).</summary>
    private const string StoodUpKey = "StardewAgent/stoodUp/";
    private const int StoodUpDays = 3;

    /// <summary>About one day in this many, someone comes to help on the farm unasked (docs/npc-meetings-more.md §5).</summary>
    private const int VisitEveryDays = 7;
    /// <summary>When it reaches the farm, as an appointment there would say.</summary>
    private const int VisitTime = 900;

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

    private static int? LastAsked(string npc) => DayKept(InvitedKey + npc);

    private static int? DayKept(string key) => Game1.player.modData.TryGetValue(key, out string? value) && int.TryParse(value, out int day) ? day : null;

    /// <summary>Stood up within the last three days: it does not ask, or come on its own.</summary>
    private static bool StoodUpLately(string npc, int today) => DayKept(StoodUpKey + npc) is int day && today - day <= StoodUpDays;

    /// <summary>Close but not living together, free today, and not one who asked this past week.</summary>
    private bool MayInvite(string name, int today, bool checkInviteGap = true)
    {
        if (Game1.getCharacterFromName(name) is not NPC npc || npc.IsInvisible || this.meetings.ContainsKey(name)
            || checkInviteGap && AskedLately(LastAsked(name), today)
            || StoodUpLately(name, today))
            return false;
        string relation = GameState.Relation(npc);
        return relation is not ("married" or "roommate") && (GameState.Hearts(npc) >= InviteHearts || relation is "dating" or "engaged");
    }

    /// <summary>
    /// Today's, worked out once the day's appointments are known; null on most days. Who comes to help unasked is
    /// worked out at the same time (ComeToHelp), whatever the invitations' setting.
    /// </summary>
    private string? TodayInviter()
    {
        if (!this.config.NpcMeetings || !Context.IsWorldReady || !this.activeLoad)
            return null;
        int today = (int)Game1.Date.TotalDays;
        if (this.inviterDay == today)
            return this.inviter;
        if (!this.meetingsArrived)
            return null;
        this.inviterDay = today;
        ulong game = Game1.uniqueIDForThisGame;
        this.inviter = this.config.NpcInvites && !Utility.isFestivalDay(Game1.dayOfMonth, Game1.season) && InviteDay(game, today)
            ? ChooseInviter(game, today, SocialNpcs.Where(name => this.MayInvite(name, today))) : null;
        if (this.inviter is not null)
            this.Monitor.Log($"今天想约农场主的：{this.inviter}。", LogLevel.Info);
        this.ComeToHelp(game, today);
        return this.inviter;
    }

    /// <summary>A different draw from the invitations', for the same save and day.</summary>
    internal static bool VisitDay(ulong game, int day) => InviteMix(game ^ InviteMix((ulong)day ^ 0x5A5A5A5A)) % VisitEveryDays == 0;

    /// <summary>
    /// About one day in seven, one close NPC comes to help on the farm unasked (docs/npc-meetings-more.md §5): not on a
    /// festival, not the one asking today, not one already meeting the player, not one stood up lately.
    /// </summary>
    private void ComeToHelp(ulong game, int today)
    {
        if (Utility.isFestivalDay(Game1.dayOfMonth, Game1.season) || !VisitDay(game, today) || this.meetings.Count >= MeetsPerDay)
            return;
        string? visitor = ChooseInviter(game ^ 0x5A5A5A5A, today, SocialNpcs.Where(name => name != this.inviter && this.MayInvite(name, today, checkInviteGap: false)));
        if (visitor is null)
            return;
        this.meetings[visitor] = new Meeting(visitor, VisitTime, FarmPlace, sameDay: false) { Surprise = true };
        this.Monitor.Log($"{visitor} 今天自己来农场帮忙。", LogLevel.Info);
    }

    /// <summary>Walks over like one with something to say, until it has asked or the day is over.</summary>
    private bool InvitesToday(NPC npc) => this.config.NpcInvites && this.TodayInviter() is string name && name.Equals(npc.Name, StringComparison.OrdinalIgnoreCase)
        && this.MayInvite(npc.Name, (int)Game1.Date.TotalDays) && Game1.timeOfDay < ApproachLatestTime;

    /// <summary>Its opening asked: kept with the save, so a reload without saving forgets it.</summary>
    private void Invited(NPC npc)
    {
        int today = (int)Game1.Date.TotalDays;
        Game1.player.modData[InvitedKey + npc.Name] = today.ToString();
        this.Monitor.Log($"{npc.displayName}开口约了农场主。", LogLevel.Info);
    }
}
