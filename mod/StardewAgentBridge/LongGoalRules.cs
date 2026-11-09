using System;
using System.Collections.Generic;
using System.Linq;

namespace StardewAgentBridge;

internal sealed class LongGoalFile
{
    public int Version { get; set; }
    public List<LongGoalDefinition> Goals { get; set; } = new();
}
internal sealed class LongGoalDefinition
{
    public string Id { get; set; } = "";
    public string Owner { get; set; } = "";
    public string Title { get; set; } = "";
    public string Opening { get; set; } = "";
    public List<string> References { get; set; } = new();
    public string? RequiresStory { get; set; }
    public List<string> WorkVenues { get; set; } = new();
    public string CollectionTitle { get; set; } = "";
    public string CollectionIntro { get; set; } = "";
    public string CollectionClosing { get; set; } = "";
    public List<LongGoalChapter> Chapters { get; set; } = new();
}
internal sealed class LongGoalChapter
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public string Opening { get; set; } = "";
    public LongGoalContribution Contribution { get; set; } = new();
    public List<LongGoalChoice> Choices { get; set; } = new();
    public List<LongGoalOutput> Outputs { get; set; } = new();
}
internal sealed class LongGoalContribution
{
    public string Id { get; set; } = "";
    public string Kind { get; set; } = "";
    public List<LongGoalVenue> Venues { get; set; } = new();
    public int Minutes { get; set; }
    public string Hint { get; set; } = "";
    public string? ItemId { get; set; }
    public int Count { get; set; }
    public string Label { get; set; } = "";
    public string Purpose { get; set; } = "";
}
internal sealed class LongGoalVenue
{
    public string Map { get; set; } = "";
    public string Label { get; set; } = "";
}
internal sealed class LongGoalChoice
{
    public string Id { get; set; } = "";
    public string Label { get; set; } = "";
    public string Text { get; set; } = "";
}
internal sealed class LongGoalOutput
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string Text { get; set; } = "";
}
internal sealed class LongGoalState
{
    public string StartId { get; set; } = "";
    public int StartedDay { get; set; }
    public string? DependencySourceId { get; set; }
    public List<LongGoalChapterState> Chapters { get; set; } = new() { new(), new(), new() };
    public string? CollectionTitle { get; set; }
    public string? CollectionIntro { get; set; }
    public string? CollectionClosing { get; set; }
}
internal sealed class LongGoalChapterState
{
    public string? ObservationId { get; set; }
    public string? ObservationVenue { get; set; }
    public string? ObservationWeather { get; set; }
    public int ObservationMinutes { get; set; }
    public string? ContributionId { get; set; }
    public string? ChoiceId { get; set; }
    public int WorkStep { get; set; }
    public int LastWorkDay { get; set; }
    public int WorkMinutes { get; set; }
    public int WorkAccumDay { get; set; }
    public string? WorkMap { get; set; }
    public string? CompletionId { get; set; }
    public int CompletedDay { get; set; }
    public string? Outcome { get; set; }
    public string? ResultTitle { get; set; }
    public string? ResultText { get; set; }
}

/// <summary>Shared native chapter, source, clock and save checks; no game assembly is needed.</summary>
internal static class LongGoalRules
{
    internal static readonly Dictionary<string, string> Owners = new(StringComparer.Ordinal)
    {
        ["penny_learning_book"] = "penny", ["elliott_triptych"] = "elliott", ["leah_form_study"] = "leah",
        ["maru_field_holder"] = "maru", ["robin_small_space"] = "robin", ["willy_shore_guide"] = "willy", ["linus_light_steps"] = "linus",
    };
    internal static readonly Dictionary<string, string[]> WorkMaps = new(StringComparer.Ordinal)
    {
        ["penny"] = new[] { "Trailer", "Trailer_Big", "ArchaeologyHouse", "Town" }, ["elliott"] = new[] { "ElliottHouse", "Beach" },
        ["leah"] = new[] { "LeahHouse", "Forest", "Beach" }, ["maru"] = new[] { "ScienceHouse", "Mountain" },
        ["robin"] = new[] { "ScienceHouse" }, ["willy"] = new[] { "FishShop", "Beach" }, ["linus"] = new[] { "Tent", "Mountain" },
    };
    internal static readonly Dictionary<string, string[]> ObservationMaps = new(StringComparer.Ordinal)
    {
        ["penny"] = new[] { "Town", "Forest", "Mountain" }, ["elliott"] = new[] { "Beach", "Town", "Forest" },
        ["leah"] = new[] { "Forest", "", "Beach" }, ["maru"] = new[] { "Mountain", "", "Town" },
        ["robin"] = new[] { "Town", "", "Mountain" }, ["willy"] = new[] { "Beach", "", "Forest" }, ["linus"] = new[] { "Mountain", "", "Forest" },
    };
    internal static string? Dependency(string owner) => owner == "penny" ? "penny_field_notes" : owner == "elliott" ? "elliott_short_piece" : null;
    internal static int MaterialCount(string owner) => owner switch { "leah" or "willy" => 4, "maru" => 2, "robin" => 8, "linus" => 3, _ => 0 };
    internal static bool IsLongGoal(LifeEvent entry) => entry.Kind.StartsWith("longgoal.", StringComparison.Ordinal);
    internal static bool Compatible(bool supported, IEnumerable<LifeEvent> events) => supported || !events.Any(IsLongGoal);
    internal static int VersionAfterEvent(int currentVersion, string kind) => kind.StartsWith("longgoal.", StringComparison.Ordinal) ? Math.Max(2, currentVersion) : currentVersion;
    internal static bool SaveVersion(int version, IEnumerable<LifeEvent> events) => version is 1 or 2 or 3 && (version >= 2 || !events.Any(IsLongGoal));
    internal static int CurrentChapter(LongGoalState state) => state.Chapters.FindIndex(chapter => chapter.Outcome is null) + 1;
    internal static int OpenedDay(LongGoalState state, int chapter) => chapter == 1 ? state.StartedDay : state.Chapters[chapter - 2].CompletedDay;
    internal static bool ChapterAvailable(int chapter, int day, int openedDay) => chapter is >= 1 and <= 3 && openedDay > 0
        && (chapter == 1 ? day >= openedDay : day > openedDay);
    internal static bool Editable(int chapter, int currentChapter, int day, int openedDay, int workStep, string? outcome)
        => chapter == currentChapter && ChapterAvailable(chapter, day, openedDay) && workStep is 0 or 1 && outcome is null;
    internal static bool WorkDay(int day, int openedDay, int step, int lastWorkDay)
        => openedDay > 0 && step is 0 or 1 && (step == 0 ? day > openedDay : day > lastWorkDay && lastWorkDay > openedDay);
    internal static bool WorkHour(int time) => time >= 800 && time <= 2000;
    internal static bool Worker(bool clock, int time, bool sleeping, bool moving, bool controlled, bool building)
        => clock && WorkHour(time) && !sleeping && !moving && !controlled && !building;
    internal static bool HasSpouseWorkplace(string owner) => owner is "penny" or "elliott" or "leah" or "maru";
    internal static bool ActualSpouse(string owner, string? spouse, string relation)
        => owner.Equals(spouse, StringComparison.OrdinalIgnoreCase) && relation == "married";
    internal static bool Workplace(string owner, string map, bool actualSpouse)
        => WorkMaps.TryGetValue(owner, out string[]? maps) && (maps.Contains(map) || map == "FarmHouse" && actualSpouse && HasSpouseWorkplace(owner));
    internal static int ClockStep(int previous, int now, bool whole, int previousDay, int day, string previousMap, string map, bool work)
        => previousDay == day && previousMap == map && (!work || WorkHour(previous) && WorkHour(now))
            ? LifeActivityRules.ClockStep(previous, now, whole) : 0;
    internal static int Accumulate(int minutes, int previousDay, string? previousMap, int day, string map, int added)
        => Math.Min(30, (previousDay == day && previousMap == map ? minutes : 0) + added);
    internal static bool ObservationReady(LongGoalChapter chapter, int minutes, string map)
        => chapter.Contribution.Kind == "observation" && minutes >= chapter.Contribution.Minutes && chapter.Contribution.Venues.Any(v => v.Map == map);
    internal static string Outcome(string? choice) => choice ?? "default";
    internal static string ContributionNote(LongGoalChapter definition, LongGoalChapterState state)
    {
        if (state.ContributionId is null) return "";
        if (definition.Contribution.Kind == "material")
            return $"\n本章也记下了你的帮助：交付 {definition.Contribution.Count} 份{definition.Contribution.Label}。";
        string weather = state.ObservationWeather switch { "rain" => "下雨", "storm" => "雷雨", "snow" => "下雪", "windy" => "刮风", _ => "晴天" };
        string place = definition.Contribution.Venues.Single(v => v.Map == state.ObservationVenue).Label;
        return $"\n本章也记下了你当面分享的观察：在{place}，当时{weather}。";
    }
    internal static bool Source(string? source, string? expected) => source is not null && source == expected;
    internal static bool Material(string? actual, string? expected, int available, int required)
        => expected is "(O)388" or "(O)334" && actual == expected && required > 0 && available >= required;
    internal static bool Deliver<T>(IReadOnlyList<(int Slot, T Item, int Stack)> stacks, int required,
        Action<T, int> setStack, Action<int, T?> setSlot, Func<bool> commit) where T : class
    {
        int[]? plan = LifeGoalRules.DeliveryPlan(stacks.Select(s => s.Stack).ToArray(), required);
        if (plan is null) return false;
        bool saved = false;
        try
        {
            for (int i = 0; i < stacks.Count; i++)
            {
                var stack = stacks[i]; int left = stack.Stack - plan[i];
                setStack(stack.Item, left);
                if (left == 0) setSlot(stack.Slot, null);
            }
            saved = commit();
            return saved;
        }
        finally
        {
            if (!saved)
                foreach (var stack in stacks) { setStack(stack.Item, stack.Stack); setSlot(stack.Slot, stack.Item); }
        }
    }
    internal static bool DependencyReady(LongGoalDefinition goal, LifeEvent? source, int day)
        => goal.RequiresStory is null ? source is null : source is not null && source.Kind == "story.resolved"
            && source.StoryId == goal.RequiresStory && source.Npc == goal.Owner && source.Day < day;
    internal static bool Weather(string? weather) => weather is "sunny" or "rain" or "storm" or "snow" or "windy";
    private static bool Prose(string? value) => !string.IsNullOrWhiteSpace(value) && value.Length <= 3000;
    private static bool EventShape(LifeEvent entry)
    {
        string[]? extras = entry.Kind switch
        {
            "longgoal.started" => new[] { "dependencySourceId" },
            "longgoal.observed" => new[] { "chapterId", "contributionId", "venue", "weather", "minutes" },
            "longgoal.contributed" => new[] { "chapterId", "contributionId", "sourceId", "itemId", "count" },
            "longgoal.choice" => new[] { "chapterId", "choiceId", "sourceId" },
            "longgoal.worked" => new[] { "chapterId", "step", "venue", "minutes" },
            "longgoal.completed" => new[] { "chapterId", "outcome" },
            _ => null,
        };
        if (extras is null) return false;
        HashSet<string> allowed = new(new[] { "id", "npc", "day", "kind", "longGoalId" }.Concat(extras));
        return LifeEventWire.Encode(new[] { entry })[0].EnumerateObject().All(property => allowed.Contains(property.Name));
    }

    internal static bool Definition(LongGoalDefinition goal)
    {
        if (!Owners.TryGetValue(goal.Id, out string? owner) || goal.Owner != owner || goal.RequiresStory != Dependency(owner)
            || !Prose(goal.Title) || !Prose(goal.Opening) || !Prose(goal.CollectionTitle) || !Prose(goal.CollectionIntro) || !Prose(goal.CollectionClosing)
            || goal.References is null || goal.References.Count < 2 || goal.WorkVenues is null
            || !goal.WorkVenues.OrderBy(v => v).SequenceEqual(WorkMaps[owner].OrderBy(v => v)) || goal.Chapters is null || goal.Chapters.Count != 3) return false;
        for (int i = 0; i < 3; i++)
        {
            LongGoalChapter chapter = goal.Chapters[i];
            if (chapter is null || chapter.Id != i + 1 || !Prose(chapter.Title) || !Prose(chapter.Opening) || chapter.Contribution is null
                || chapter.Choices is null || chapter.Choices.Count != 2 || !chapter.Choices.Select(c => c.Id).OrderBy(v => v).SequenceEqual(new[] { "a", "b" })
                || chapter.Choices.Any(c => !Prose(c.Label) || !Prose(c.Text)) || chapter.Outputs is null || chapter.Outputs.Count != 3
                || !chapter.Outputs.Select(o => o.Id).OrderBy(v => v).SequenceEqual(new[] { "a", "b", "default" })
                || chapter.Outputs.Any(o => !Prose(o.Title) || !Prose(o.Text))) return false;
            LongGoalContribution c = chapter.Contribution;
            string map = ObservationMaps[owner][i];
            if (map.Length > 0)
            {
                if (c.Id != "observation" || c.Kind != "observation" || c.Minutes != 10 || !Prose(c.Hint) || c.Venues is null
                    || c.Venues.Count != 1 || c.Venues[0].Map != map || !Prose(c.Venues[0].Label) || c.ItemId is not null || c.Count != 0) return false;
            }
            else if (c.Id != "materials" || c.Kind != "material" || c.ItemId != (owner == "maru" ? "(O)334" : "(O)388")
                || c.Count != MaterialCount(owner) || !Prose(c.Label) || !Prose(c.Purpose) || c.Minutes != 0 || c.Venues is null || c.Venues.Count != 0) return false;
        }
        return true;
    }

    /// <summary>Rebuild the durable facts before trusting native progress; partial clock counters never invent events.</summary>
    internal static bool ValidState(LongGoalDefinition goal, LongGoalState state, IReadOnlyList<LifeEvent> all, int day)
    {
        if (state is null || state.Chapters is null || state.Chapters.Count != 3 || state.Chapters.Any(c => c is null)) return false;
        LifeEvent[] events = all.Where(e => e.LongGoalId == goal.Id).ToArray();
        if (events.Length == 0) return false;
        LifeEvent start = events[0];
        LifeEvent? dependency = all.FirstOrDefault(e => e.Id == start.DependencySourceId);
        if (start.Kind != "longgoal.started" || !EventShape(start) || start.Npc != goal.Owner || start.Day < 1 || start.Day > day
            || start.Id != state.StartId || start.Day != state.StartedDay || start.DependencySourceId != state.DependencySourceId
            || !DependencyReady(goal, dependency, start.Day) || goal.RequiresStory is null && start.DependencySourceId is not null
            || dependency is not null && !LifeGoalRules.OrderedEventIds(new[] { dependency.Id, start.Id }, 9007199254740991L)) return false;
        LongGoalState rebuilt = new() { StartId = start.Id, StartedDay = start.Day, DependencySourceId = start.DependencySourceId };
        int previousDay = start.Day;
        foreach (LifeEvent entry in events.Skip(1))
        {
            int current = CurrentChapter(rebuilt);
            if (current == 0 || !EventShape(entry) || entry.ChapterId != current || entry.Npc != goal.Owner || entry.Day > day || entry.Day < previousDay
                || !ChapterAvailable(current, entry.Day, OpenedDay(rebuilt, current))) return false;
            previousDay = entry.Day;
            LongGoalChapter definition = goal.Chapters[current - 1];
            LongGoalChapterState chapter = rebuilt.Chapters[current - 1];
            bool editable = Editable(current, current, entry.Day, OpenedDay(rebuilt, current), chapter.WorkStep, chapter.Outcome);
            switch (entry.Kind)
            {
                case "longgoal.observed":
                    if (!editable || chapter.ObservationId is not null || entry.ContributionId != definition.Contribution.Id
                        || !ObservationReady(definition, entry.Minutes ?? 0, entry.Venue ?? "") || entry.Minutes > 1440 || !Weather(entry.Weather)) return false;
                    chapter.ObservationId = entry.Id; chapter.ObservationVenue = entry.Venue; chapter.ObservationWeather = entry.Weather; chapter.ObservationMinutes = entry.Minutes!.Value;
                    break;
                case "longgoal.contributed":
                    if (!editable || chapter.ContributionId is not null || entry.ContributionId != definition.Contribution.Id) return false;
                    if (definition.Contribution.Kind == "observation")
                    { if (!Source(entry.SourceId, chapter.ObservationId) || entry.ItemId is not null || entry.Count is not null) return false; }
                    else if (!Material(entry.ItemId, definition.Contribution.ItemId, entry.Count ?? 0, definition.Contribution.Count)
                        || entry.Count != definition.Contribution.Count || entry.SourceId is not null) return false;
                    chapter.ContributionId = entry.Id;
                    break;
                case "longgoal.choice":
                    if (!editable || chapter.ChoiceId is not null || !Source(entry.SourceId, chapter.ContributionId) || entry.ChoiceId is not ("a" or "b")) return false;
                    chapter.ChoiceId = entry.ChoiceId;
                    break;
                case "longgoal.worked":
                    if (entry.Step != chapter.WorkStep + 1 || !WorkDay(entry.Day, OpenedDay(rebuilt, current), chapter.WorkStep, chapter.LastWorkDay)
                        || !Workplace(goal.Owner, entry.Venue ?? "", true) || entry.Minutes is < 30 or > 1440 || entry.Minutes is null) return false;
                    chapter.WorkStep++; chapter.LastWorkDay = entry.Day;
                    break;
                case "longgoal.completed":
                    if (chapter.WorkStep != 2 || entry.Day < chapter.LastWorkDay || entry.Outcome != Outcome(chapter.ChoiceId)) return false;
                    chapter.CompletionId = entry.Id; chapter.CompletedDay = entry.Day; chapter.Outcome = entry.Outcome;
                    break;
                default: return false;
            }
        }
        for (int i = 0; i < 3; i++)
        {
            LongGoalChapterState actual = state.Chapters[i], expected = rebuilt.Chapters[i];
            if (actual.ObservationId != expected.ObservationId || actual.ObservationVenue != expected.ObservationVenue || actual.ObservationWeather != expected.ObservationWeather
                || actual.ObservationMinutes != expected.ObservationMinutes || actual.ContributionId != expected.ContributionId || actual.ChoiceId != expected.ChoiceId
                || actual.WorkStep != expected.WorkStep || actual.LastWorkDay != expected.LastWorkDay || actual.CompletionId != expected.CompletionId
                || actual.CompletedDay != expected.CompletedDay || actual.Outcome != expected.Outcome || actual.WorkMinutes is < 0 or > 30
                || actual.WorkAccumDay < 0 || actual.WorkAccumDay > day || actual.WorkMinutes > 0 && (actual.WorkStep == 2 || actual.Outcome is not null
                    || !WorkDay(actual.WorkAccumDay, OpenedDay(rebuilt, i + 1), actual.WorkStep, actual.LastWorkDay) || !Workplace(goal.Owner, actual.WorkMap ?? "", true))
                || actual.Outcome is not null && (!Prose(actual.ResultTitle) || !Prose(actual.ResultText))
                || actual.Outcome is null && (actual.ResultTitle is not null || actual.ResultText is not null)) return false;
        }
        return CurrentChapter(rebuilt) != 0 ? state.CollectionTitle is null && state.CollectionIntro is null && state.CollectionClosing is null
            : Prose(state.CollectionTitle) && Prose(state.CollectionIntro) && Prose(state.CollectionClosing);
    }
}
