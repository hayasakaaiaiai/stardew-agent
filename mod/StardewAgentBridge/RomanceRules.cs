using System;
using System.Collections.Generic;
using System.Linq;

namespace StardewAgentBridge;

/// <summary>Native relationship, time, and provenance rules shared with offline checks.</summary>
internal static class RomanceRules
{
    internal static readonly HashSet<string> Npcs = new(StringComparer.Ordinal)
    { "abigail", "alex", "elliott", "emily", "haley", "harvey", "leah", "maru", "penny", "sam", "sebastian", "shane" };
    internal static readonly HashSet<string> Venues = new(StringComparer.Ordinal) { "Forest", "Beach", "Town", "Mountain" };
    internal static readonly int[] Times = { 1000, 1400, 1700 };
    internal static bool Eligible(string npc, string relation)
        => Npcs.Contains(npc) && relation is "dating" or "engaged" or "married";
    internal static bool Clock(int time) => time >= 600 && time <= 2600 && time % 100 < 60;
    internal static int Minutes(int time) => time / 100 * 60 + time % 100;
    internal static bool Plan(int today, int plannedDay, int time, int now)
        => today >= 1 && (plannedDay == today || plannedDay == today + 1) && Array.IndexOf(Times, time) >= 0
            && Clock(now) && (plannedDay != today || Minutes(time) >= Minutes(now));
    internal static bool Depart(int today, int plannedDay, int time, int now)
        => today == plannedDay && Array.IndexOf(Times, time) >= 0 && Clock(now)
            && Minutes(now) >= Minutes(time) && Minutes(now) <= Minutes(time) + 60;
    internal static bool Expired(int today, int plannedDay, int time, int now)
        => plannedDay < today || plannedDay == today && Clock(now) && Minutes(now) > Minutes(time) + 60;
    internal static bool CountTime(string venue, string map, bool together, bool romantic)
        => Venues.Contains(venue) && venue == map && together && romantic;
    internal static bool Complete(int minutes, bool sameSession, bool romantic)
        => minutes >= 30 && sameSession && romantic;
    internal static bool Preparation(string value) => value is "quiet" or "talk";
    internal static bool Detail(string value) => value is "place" or "weather" or "company";
    internal static bool Invite(int today, int lastNpcDay, int lastGlobalDay)
        => today >= 1 && lastGlobalDay != today && (lastNpcDay == 0 || today - lastNpcDay >= 3);
    internal static bool RecallSource(string npc, string sourceNpc, string sourceKind, string dateId, string sourceDateId)
        => npc == sourceNpc && sourceKind == "romance.completed" && dateId == sourceDateId;
    internal static bool Rememberable(IReadOnlyCollection<LifeEvent> events, string npc, LifeEvent source)
        => source.DateId is not null && source.Npc == npc && source.Kind == "romance.completed"
            && Memories(events, npc).Any(e => e.Id == source.Id && RecallSource(npc, e.Npc, e.Kind, source.DateId, e.DateId ?? ""))
            && !events.Any(e => e.Kind == "romance.remembered" && e.Npc == npc && e.SourceId == source.Id);
    internal static List<LifeEvent> Memories(IEnumerable<LifeEvent> events, string npc)
    {
        List<LifeEvent> completed = events.Where(e => e.Npc == npc && e.Kind == "romance.completed").ToList();
        return completed.Count == 0 ? new() : completed.TakeLast(24).Prepend(completed[0]).DistinctBy(e => e.Id).ToList();
    }
    internal static bool Compatible(bool supported, IEnumerable<LifeEvent> events)
        => supported || !events.Any(e => e.Kind.StartsWith("romance.", StringComparison.Ordinal));
    internal static string Place(string map) => map switch
    { "Forest" => "森林", "Beach" => "海滩", "Town" => "小镇", "Mountain" => "山间", _ => "约好的地方" };
    internal static string Weather(string weather) => weather switch
    { "rain" => "雨天", "storm" => "雷雨天", "snow" => "雪天", "windy" => "有风的天气", "sunny" => "晴天", _ => "当时的天气" };
}
