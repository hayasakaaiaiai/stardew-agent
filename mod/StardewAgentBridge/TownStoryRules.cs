using System;
using System.Collections.Generic;
using System.Linq;

namespace StardewAgentBridge;

/// <summary>Pure observation, provenance and lifetime checks used by the actual native story flow.</summary>
internal static class TownStoryRules
{
    internal static readonly Dictionary<string, string> Owners = new(StringComparer.Ordinal)
    { ["gus_parcel"] = "gus", ["penny_field_notes"] = "penny", ["elliott_short_piece"] = "elliott" };
    internal const string ParcelItemId = "(O)StardewAgent_StoryParcel";
    internal const string ParcelMarkKey = "StardewAgent/StoryParcel";

    internal static bool Current(string nonce, int day, string currentNonce, int currentDay)
        => nonce == currentNonce && day > 0 && day == currentDay;
    internal static bool NearSite(string map, int x, int y, string siteMap, int siteX, int siteY, int radius)
        => map == siteMap && radius >= 0 && (long)(x - siteX) * (x - siteX) + (long)(y - siteY) * (y - siteY) <= (long)radius * radius;
    internal static bool WorkDay(int day, int startedDay, int completedStep, int lastWorkDay)
        => startedDay > 0 && completedStep is 0 or 1 && (completedStep == 0 ? day > startedDay : day > lastWorkDay && lastWorkDay > startedDay);
    internal static int ClockStep(int previous, int now, bool wholeInterval, int previousDay, int day, string previousMap, string map)
        => previousDay == day && previousMap == map ? LifeActivityRules.ClockStep(previous, now, wholeInterval) : 0;
    internal static bool WorkReady(int minutes, bool eligibleDay, bool sameMap) => minutes >= 30 && eligibleDay && sameMap;
    internal static int WorkAccumulation(int previousMinutes, int previousDay, string? previousMap, int day, string map, int added)
        => Math.Min(30, (previousDay == day && previousMap == map ? previousMinutes : 0) + added);
    internal static bool ObservationReady(int minutes, string map, IReadOnlyCollection<string> offeredMaps)
        => minutes >= 10 && offeredMaps.Contains(map);
    internal static bool ParcelMatches(string itemId, string? marker, string startId)
        => itemId == ParcelItemId && startId.StartsWith("life-", StringComparison.Ordinal) && marker == "gus_parcel@" + startId;
    internal static bool CanExplain(IEnumerable<string> clues) => new[] { "parcel", "emily_mark", "pierre_mark" }.All(clues.Contains);
    internal static bool CanTell(string story, string sourceStory, string sourceKind, string sourceId, IEnumerable<string> reported)
        => story == sourceStory && sourceKind is "story.clue" or "story.observed" && !reported.Contains(sourceId);
    internal static string ProjectOutcome(string? choice) => choice ?? "independent";
    internal static IEnumerable<string> ResolutionSources(string outcome, IReadOnlyDictionary<string, string> clues)
        => outcome == "explained" ? clues.Values : outcome == "returned" && clues.TryGetValue("parcel", out string? source) ? new[] { source } : Array.Empty<string>();
    internal static HashSet<string> ReportedSources(IEnumerable<LifeEvent> events)
    {
        Dictionary<string, string> clues = new();
        HashSet<string> sources = new();
        foreach (LifeEvent entry in events)
        {
            if (entry.Kind == "story.clue" && entry.ClueId is not null) clues[entry.ClueId] = entry.Id;
            if (entry.Kind is "story.told" or "story.choice" && entry.SourceId is not null) sources.Add(entry.SourceId);
            if (entry.Kind == "story.resolved") sources.UnionWith(ResolutionSources(entry.Outcome ?? "", clues));
        }
        return sources;
    }
    internal static string Direction(int x, int y, int targetX, int targetY)
    {
        string horizontal = targetX > x + 2 ? "东" : targetX < x - 2 ? "西" : "";
        string vertical = targetY > y + 2 ? "南" : targetY < y - 2 ? "北" : "";
        return horizontal + vertical;
    }
    internal static bool Compatible(bool supported, IEnumerable<LifeEvent> events)
        => supported || !events.Any(entry => entry.Kind.StartsWith("story.", StringComparison.Ordinal));
}
