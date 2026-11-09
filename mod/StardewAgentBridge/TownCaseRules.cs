using System;
using System.Collections.Generic;
using System.Linq;

namespace StardewAgentBridge;

internal sealed class TownCaseFile
{
    public int Version { get; set; }
    public List<TownCaseDefinition> Cases { get; set; } = new();
}
internal sealed class TownCaseDefinition
{
    public string Id { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Owner { get; set; } = "";
    public string Title { get; set; } = "";
    public string Opening { get; set; } = "";
    public List<string> References { get; set; } = new();
    public List<TownCaseClue> Clues { get; set; } = new();
    public List<TownCaseInspection> Inspections { get; set; } = new();
    public List<TownCaseEnding> Endings { get; set; } = new();
}
internal sealed class TownCaseClue
{
    public string Id { get; set; } = "";
    public string Witness { get; set; } = "";
    public string Label { get; set; } = "";
    public string Text { get; set; } = "";
}
internal sealed class TownCaseSite
{
    public int X { get; set; }
    public int Y { get; set; }
    public int Radius { get; set; }
}
internal sealed class TownCaseInspection
{
    public string Id { get; set; } = "";
    public string Mode { get; set; } = "";
    public string Venue { get; set; } = "";
    public string Label { get; set; } = "";
    public string Hint { get; set; } = "";
    public int Minutes { get; set; }
    public TownCaseSite? Site { get; set; }
    public string? After { get; set; }
    public bool? LaterDay { get; set; }
    public string? ItemId { get; set; }
    public string? ItemLabel { get; set; }
    public int? Count { get; set; }
    public string? Subject { get; set; }
    public int? From { get; set; }
    public int? To { get; set; }
}
internal sealed class TownCaseEnding
{
    public string Id { get; set; } = "";
    public string Label { get; set; } = "";
    public string Title { get; set; } = "";
    public string Text { get; set; } = "";
}
internal sealed class TownCaseState
{
    public string StartId { get; set; } = "";
    public int StartedDay { get; set; }
    public Dictionary<string, string> Sources { get; set; } = new();
    public HashSet<string> Reported { get; set; } = new();
    public string? Outcome { get; set; }
    public string? ResultTitle { get; set; }
    public string? ResultText { get; set; }
}
internal sealed class TownCaseClock
{
    public int Day;
    public string Map = "";
    public int LastTime;
    public int Minutes;
    public bool Whole;
}

/// <summary>Exact case definitions, native evidence requirements and source-bound replay without game assemblies.</summary>
internal static class TownCaseRules
{
    internal static readonly Dictionary<string, (string Owner, string A, string B)> Owners = new(StringComparer.Ordinal)
    {
        ["caroline_route_notes"] = ("caroline", "pierre", "jodi"),
        ["clint_sample_labels"] = ("clint", "emily", "demetrius"),
        ["evelyn_blank_record"] = ("evelyn", "george", "alex"),
        ["marnie_two_contexts"] = ("marnie", "shane", "jodi"),
    };
    internal static bool IsCaseId(string? id) => id is not null && Owners.ContainsKey(id);
    internal static bool IsCase(LifeEvent entry) => IsCaseId(entry.StoryId);
    internal static bool Compatible(bool supported, IEnumerable<LifeEvent> events) => supported || !events.Any(IsCase);
    internal static int VersionAfterEvent(int version, LifeEvent entry) => IsCase(entry) ? Math.Max(4, version) : version;
    internal static bool SaveVersion(int version, IEnumerable<LifeEvent> events)
        => version is >= 1 and <= 4 && (version >= 4 || !events.Any(IsCase));
    internal static bool Time(int value) => value is >= 600 and <= 2200 && value % 100 < 60 && value % 10 == 0;
    internal static int ClockMinutes(int value) => value / 100 * 60 + value % 100;
    internal static bool Coordinate(int? value) => value is >= 0 and <= 500;
    internal static bool Weather(string? value) => value is "sunny" or "rain" or "storm" or "snow" or "windy";
    internal static long Serial(string? id) => id is not null && id.StartsWith("life-", StringComparison.Ordinal)
        && long.TryParse(id.AsSpan(5), out long value) && value is > 0 and <= 9007199254740991L && id == "life-" + value ? value : 0;
    private static bool Prose(string? value) => !string.IsNullOrWhiteSpace(value) && value.Length <= 6000
        && value.IndexOfAny("#$@%{}*^[]|".ToCharArray()) < 0;

    internal static bool Definition(TownCaseDefinition definition)
    {
        if (!Owners.TryGetValue(definition.Id, out var owner) || definition.Owner != owner.Owner || definition.Kind != "case"
            || !Prose(definition.Title) || !Prose(definition.Opening) || definition.References is not { Count: >= 3 }
            || definition.References.Any(string.IsNullOrWhiteSpace)
            || definition.Clues is not { Count: 2 } || definition.Clues.Any(c => c is null || !Prose(c.Label) || !Prose(c.Text))
            || !definition.Clues.Any(c => c.Id == "witness_a" && c.Witness == owner.A)
            || !definition.Clues.Any(c => c.Id == "witness_b" && c.Witness == owner.B)
            || definition.Endings is not { Count: 2 } || definition.Endings.Any(e => e is null || !Prose(e.Label) || !Prose(e.Title) || !Prose(e.Text))
            || !definition.Endings.Select(e => e.Id).OrderBy(id => id).SequenceEqual(new[] { "a", "b" })
            || definition.Inspections is not { Count: 2 } || definition.Inspections.Any(i => i is null || i.Minutes != 10 || !Prose(i.Label) || !Prose(i.Hint))
            || definition.Inspections.Select(i => i.Id).Distinct().Count() != 2) return false;
        return definition.Inspections.All(i => InspectionDefinition(definition.Id, i));
    }

    private static bool InspectionDefinition(string id, TownCaseInspection inspection)
    {
        string? expectedMap = (id, inspection.Id) switch
        {
            ("caroline_route_notes", "square") => "Town", ("caroline_route_notes", "river") => "Forest",
            ("clint_sample_labels", "copper") => "Blacksmith", ("clint_sample_labels", "iron") => "ScienceHouse",
            ("evelyn_blank_record", "first" or "return") => "Town",
            ("marnie_two_contexts", "ranch") => "AnimalShop", ("marnie_two_contexts", "saloon") => "Saloon", _ => null,
        };
        if (expectedMap is null || inspection.Venue != expectedMap) return false;
        bool later = id == "evelyn_blank_record" && inspection.Id == "return";
        if (later ? inspection.After != "first" || inspection.LaterDay != true : inspection.After is not null || inspection.LaterDay is not null) return false;
        if (id is "caroline_route_notes" or "evelyn_blank_record")
        {
            int x = inspection.Id == "river" ? 66 : 50, y = inspection.Id == "river" ? 50 : 68;
            return inspection.Mode == "site" && inspection.Site is { Radius: 5 } site && site.X == x && site.Y == y
                && inspection.ItemId is null && inspection.ItemLabel is null && inspection.Count is null
                && inspection.Subject is null && inspection.From is null && inspection.To is null;
        }
        if (id == "clint_sample_labels") return inspection.Mode == "sample" && inspection.Site is null
            && inspection.ItemId == (inspection.Id == "copper" ? "(O)378" : "(O)380") && inspection.Count == 1 && Prose(inspection.ItemLabel)
            && inspection.Subject is null && inspection.From is null && inspection.To is null;
        return inspection.Mode == "presence" && inspection.Site is null && inspection.ItemId is null && inspection.ItemLabel is null && inspection.Count is null
            && inspection.Subject == "marnie" && inspection.From == (inspection.Id == "ranch" ? 900 : 1700) && inspection.To == (inspection.Id == "ranch" ? 1600 : 2200);
    }

    internal static bool AtSite(TownCaseInspection inspection, string map, int x, int y)
        => map == inspection.Venue && Coordinate(x) && Coordinate(y) && (inspection.Site is null
            || (long)(x - inspection.Site.X) * (x - inspection.Site.X) + (long)(y - inspection.Site.Y) * (y - inspection.Site.Y) <= (long)inspection.Site.Radius * inspection.Site.Radius);
    internal static bool Present(TownCaseInspection inspection, int time, int x, int y, string? subject, string? map, int? subjectX, int? subjectY, bool awake, bool visible)
        => inspection.Mode == "presence" && subject == inspection.Subject && map == inspection.Venue && awake && visible
            && Coordinate(x) && Coordinate(y) && Coordinate(subjectX) && Coordinate(subjectY) && Time(time) && time >= inspection.From && time <= inspection.To
            && (long)(x - subjectX!.Value) * (x - subjectX.Value) + (long)(y - subjectY!.Value) * (y - subjectY.Value) <= 64;
    internal static bool Sample(TownCaseInspection inspection, IEnumerable<(string Id, int Count)> inventory)
        => inspection.Mode == "sample" && inventory.Any(item => item.Id == inspection.ItemId && item.Count >= 1);
    internal static bool Dependency(TownCaseInspection inspection, TownCaseState state, IEnumerable<LifeEvent> events, int day)
        => inspection.After is null || state.Sources.TryGetValue(inspection.After, out string? source)
            && events.Any(e => e.Id == source && e.Kind == "story.inspected" && e.ClueId == inspection.After && e.Day < day);

    internal static void TickClock(TownCaseClock clock, int day, string map, int time, bool eligible, bool running)
    {
        if (clock.Day != day || clock.Map != map || !eligible)
        { clock.Day = day; clock.Map = map; clock.LastTime = time; clock.Minutes = 0; clock.Whole = false; }
        // Paused menus invalidate only the unfinished interval, not a completed observation at the same site.
        clock.Whole &= eligible && running;
    }
    internal static void AdvanceClock(TownCaseClock clock, int day, string map, int time, bool eligible, bool running)
    {
        TickClock(clock, day, map, time, eligible, running);
        clock.Minutes = Math.Min(10, clock.Minutes + LifeActivityRules.ClockStep(clock.LastTime, time, clock.Whole && eligible && running));
        clock.LastTime = time; clock.Whole = eligible && running;
    }
    internal static bool Ready(TownCaseDefinition definition, TownCaseState state)
        => state.Outcome is null && definition.Clues.All(c => state.Sources.ContainsKey(c.Id)) && definition.Inspections.All(i => state.Sources.ContainsKey(i.Id));

    internal static bool Shape(TownCaseDefinition definition, LifeEvent entry)
    {
        TownCaseInspection? inspection = definition.Inspections.FirstOrDefault(i => i.Id == entry.ClueId);
        string[]? extras = entry.Kind switch
        {
            "story.started" => Array.Empty<string>(), "story.clue" => new[] { "clueId", "other" },
            "story.told" => new[] { "sourceId" }, "story.resolved" => new[] { "outcome" },
            "story.inspected" when inspection?.Mode == "site" => new[] { "clueId", "venue", "x", "y", "time", "minutes", "weather" }.Concat(inspection.After is null ? Array.Empty<string>() : new[] { "sourceId" }).ToArray(),
            "story.inspected" when inspection?.Mode == "sample" => new[] { "clueId", "venue", "x", "y", "time", "minutes", "itemId", "count" },
            "story.inspected" when inspection?.Mode == "presence" => new[] { "clueId", "venue", "x", "y", "time", "minutes", "subject", "subjectX", "subjectY" }, _ => null,
        };
        return extras is not null && LifeEventWire.Encode(new[] { entry })[0].EnumerateObject().Select(p => p.Name).ToHashSet()
            .SetEquals(new[] { "id", "npc", "day", "kind", "storyId" }.Concat(extras));
    }

    internal static bool Evidence(TownCaseInspection inspection, TownCaseState state, IReadOnlyList<LifeEvent> previous, LifeEvent entry)
    {
        if (entry.Minutes != 10 || entry.Time is not int time || !Time(time) || entry.X is not int x || entry.Y is not int y
            || !AtSite(inspection, entry.Venue ?? "", x, y)) return false;
        if (inspection.Mode == "site") return Weather(entry.Weather) && (inspection.After is null
            || state.Sources.TryGetValue(inspection.After, out string? first) && first == entry.SourceId
                && previous.Any(e => e.Id == first && e.Kind == "story.inspected" && e.ClueId == inspection.After && e.Day < entry.Day));
        if (inspection.Mode == "sample") return entry.ItemId == inspection.ItemId && entry.Count == 1;
        return Present(inspection, time, x, y, entry.Subject, entry.Venue, entry.SubjectX, entry.SubjectY, true, true)
            && ClockMinutes(time) >= ClockMinutes(inspection.From!.Value) + 10;
    }

    internal static TownCaseState? Replay(TownCaseDefinition definition, IEnumerable<LifeEvent> events, int today)
    {
        TownCaseState? state = null;
        List<LifeEvent> previous = new();
        long serial = 0; int day = 0;
        foreach (LifeEvent entry in events.Where(e => e.StoryId == definition.Id))
        {
            long next = Serial(entry.Id);
            if (next <= serial || entry.Day < 1 || entry.Day < day || entry.Day > today || entry.Npc != definition.Owner || !Shape(definition, entry)) return null;
            serial = next; day = entry.Day;
            if (entry.Kind == "story.started")
            {
                if (state is not null) return null;
                state = new() { StartId = entry.Id, StartedDay = entry.Day };
            }
            else
            {
                if (state is null || state.Outcome is not null) return null;
                if (entry.Kind == "story.clue")
                {
                    TownCaseClue? clue = definition.Clues.FirstOrDefault(c => c.Id == entry.ClueId);
                    if (clue is null || clue.Witness != entry.Other || !state.Sources.TryAdd(clue.Id, entry.Id)) return null;
                }
                else if (entry.Kind == "story.inspected")
                {
                    TownCaseInspection? inspection = definition.Inspections.FirstOrDefault(i => i.Id == entry.ClueId);
                    if (inspection is null || state.Sources.ContainsKey(inspection.Id) || !Evidence(inspection, state, previous, entry)) return null;
                    state.Sources.Add(inspection.Id, entry.Id);
                }
                else if (entry.Kind == "story.told")
                {
                    if (entry.SourceId is null || !state.Sources.Values.Contains(entry.SourceId) || !state.Reported.Add(entry.SourceId)) return null;
                }
                else if (entry.Kind == "story.resolved")
                {
                    TownCaseEnding? ending = definition.Endings.FirstOrDefault(e => e.Id == entry.Outcome);
                    if (ending is null || !Ready(definition, state)) return null;
                    state.Outcome = ending.Id; state.ResultTitle = ending.Title; state.ResultText = ending.Text;
                    state.Reported.UnionWith(state.Sources.Values);
                }
                else return null;
            }
            previous.Add(entry);
        }
        return state;
    }
    internal static bool ValidState(TownCaseState actual, TownCaseState? expected)
        => expected is not null && actual.StartId == expected.StartId && actual.StartedDay == expected.StartedDay
            && actual.Sources is not null && actual.Sources.Count == expected.Sources.Count
            && expected.Sources.All(pair => actual.Sources.TryGetValue(pair.Key, out string? value) && value == pair.Value)
            && actual.Reported is not null && actual.Reported.SetEquals(expected.Reported)
            && actual.Outcome == expected.Outcome && actual.ResultTitle == expected.ResultTitle && actual.ResultText == expected.ResultText;
}
