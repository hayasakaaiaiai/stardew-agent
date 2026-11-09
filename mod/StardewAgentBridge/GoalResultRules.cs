using System;
using System.Collections.Generic;
using System.Linq;

namespace StardewAgentBridge;

internal sealed class GoalResultFile
{
    public int Version { get; set; }
    public List<GoalResultDefinition> Practices { get; set; } = new();
}
internal sealed class GoalResultDefinition
{
    public string ProjectId { get; set; } = "";
    public string Owner { get; set; } = "";
    public string Title { get; set; } = "";
    public string Venue { get; set; } = "";
    public string VenueLabel { get; set; } = "";
    public string Mode { get; set; } = "";
    public int Minutes { get; set; }
    public string Opening { get; set; } = "";
    public List<LongGoalChoice> PlanChoices { get; set; } = new();
    public List<GoalResultCheckpoint> Checkpoints { get; set; } = new();
    public List<LongGoalChoice> FinishChoices { get; set; } = new();
    public string ReceiptIntro { get; set; } = "";
    public string ReviewIntro { get; set; } = "";
    public List<LongGoalChoice> ReviewChoices { get; set; } = new();
    public List<string> References { get; set; } = new();
}
internal sealed class GoalResultCheckpoint
{
    public int Point { get; set; }
    public string Title { get; set; } = "";
    public string Prompt { get; set; } = "";
    public List<LongGoalChoice> Choices { get; set; } = new();
}
internal sealed class GoalResultPoint
{
    public string Id { get; set; } = "";
    public int Point { get; set; }
    public string Venue { get; set; } = "";
    public int X { get; set; }
    public int Y { get; set; }
    public int Time { get; set; }
    public string Weather { get; set; } = "";
    public int Minutes { get; set; }
    public int Count { get; set; }
    public string ChoiceId { get; set; } = "";
}
internal sealed class GoalResultAttempt
{
    public string Id { get; set; } = "";
    public int Day { get; set; }
    public string SourceId { get; set; } = "";
    public string PlanChoiceId { get; set; } = "";
    public List<GoalResultPoint> Points { get; set; } = new();
    public string? EndId { get; set; }
    public int EndDay { get; set; }
    public string? EndKind { get; set; }
    public string? Reason { get; set; }
    public int Minutes { get; set; }
    public int Count { get; set; }
    public string? FinishChoiceId { get; set; }
}
internal sealed class GoalResultPage
{
    public string Title { get; set; } = "";
    public string Text { get; set; } = "";
}
internal sealed class GoalResultState
{
    public Dictionary<int, string> Notified { get; set; } = new();
    public List<GoalResultAttempt> Attempts { get; set; } = new();
    public string? ReceiptTitle { get; set; }
    public string? ReceiptText { get; set; }
    public List<GoalResultPage> ReceiptPages { get; set; } = new();
    public string? ReviewId { get; set; }
    public int ReviewDay { get; set; }
    public string? ReviewChoiceId { get; set; }
    public string? ReviewText { get; set; }
}

/// <summary>Native practice facts, routes, provenance and replay validation without game assemblies.</summary>
internal static class GoalResultRules
{
    internal static readonly Dictionary<string, (string Map, string Mode, int Minutes, int Points)> Requirements = new(StringComparer.Ordinal)
    {
        ["penny_learning_book"] = ("Forest", "walk", 30, 2), ["elliott_triptych"] = ("Beach", "walk", 30, 2),
        ["leah_form_study"] = ("Forest", "walk", 30, 3), ["maru_field_holder"] = ("Mountain", "walk", 30, 2),
        ["robin_small_space"] = ("Town", "walk", 30, 3), ["willy_shore_guide"] = ("Beach", "fishing", 20, 1),
        ["linus_light_steps"] = ("Forest", "foraging", 20, 1),
    };
    internal static bool IsResult(LifeEvent entry) => entry.Kind.StartsWith("goalresult.", StringComparison.Ordinal);
    internal static bool Compatible(bool supported, IEnumerable<LifeEvent> events) => supported || !events.Any(IsResult);
    internal static int VersionAfterEvent(int current, string kind) => kind.StartsWith("goalresult.", StringComparison.Ordinal) ? 3 : current;
    internal static bool SaveVersion(int version, IEnumerable<LifeEvent> events) => version is 1 or 2 or 3 && (version == 3 || !events.Any(IsResult));
    internal static bool Choice(string? value) => value is "a" or "b";
    internal static bool Time(int time) => time is >= 900 and <= 2200 && time % 100 < 60 && time % 10 == 0;
    internal static int ClockMinutes(int time) => time / 100 * 60 + time % 100;
    internal static bool Duration(int minutes) => minutes is >= 10 and <= 90 && minutes % 10 == 0;
    internal static bool Count(GoalResultDefinition definition, int count) => count is >= 0 and <= 999 && (definition.Mode == "walk" ? count == 0 : count >= 1);
    internal static bool Together(string expected, string map, bool near, bool running, bool menu, bool warping)
        => map == expected && near && running && !menu && !warping;
    internal static bool Friendship(int hearts, string relation) => hearts >= 8 || relation is "married" or "roommate";
    internal static GoalResultAttempt? Active(GoalResultState state) => state.Attempts.LastOrDefault(a => a.EndId is null);
    internal static GoalResultAttempt? Completed(GoalResultState state) => state.Attempts.SingleOrDefault(a => a.EndKind == "completed");
    private static long Serial(string id) => id.StartsWith("life-", StringComparison.Ordinal) && long.TryParse(id.AsSpan(5), out long value) ? value : 0;
    private static bool Prose(string? value) => !string.IsNullOrWhiteSpace(value) && value.Length <= 6000;
    private static bool Choices(List<LongGoalChoice>? choices) => choices is { Count: 2 }
        && choices.Select(c => c.Id).OrderBy(v => v).SequenceEqual(new[] { "a", "b" }) && choices.All(c => Prose(c.Label) && Prose(c.Text));
    internal static bool Definition(GoalResultDefinition definition)
    {
        if (!Requirements.TryGetValue(definition.ProjectId, out var requirements) || !LongGoalRules.Owners.TryGetValue(definition.ProjectId, out string? owner)
            || definition.Owner != owner || definition.Venue != requirements.Map || definition.Mode != requirements.Mode || definition.Minutes != requirements.Minutes
            || !Prose(definition.Title) || !Prose(definition.VenueLabel) || !Prose(definition.Opening) || !Prose(definition.ReceiptIntro) || !Prose(definition.ReviewIntro)
            || !Choices(definition.PlanChoices) || !Choices(definition.FinishChoices) || !Choices(definition.ReviewChoices)
            || definition.References is not { Count: >= 2 } || definition.Checkpoints is null || definition.Checkpoints.Count != requirements.Points) return false;
        return definition.Checkpoints.Select((point, index) => point is not null && point.Point == index + 1 && Prose(point.Title)
            && Prose(point.Prompt) && Choices(point.Choices)).All(valid => valid);
    }
    internal static LifeEvent? ChapterSource(GoalResultDefinition definition, IEnumerable<LifeEvent> events, int chapter)
        => events.LastOrDefault(e => e.Kind == "longgoal.completed" && e.LongGoalId == definition.ProjectId && e.Npc == definition.Owner && e.ChapterId == chapter);
    internal static bool Dependency(GoalResultDefinition definition, LifeEvent? source, int day, int chapter)
        => source is not null && source.Kind == "longgoal.completed" && source.LongGoalId == definition.ProjectId && source.Npc == definition.Owner
            && source.ChapterId == chapter && source.Day > 0 && source.Day <= day;
    internal static double DistanceSquared(GoalResultPoint a, GoalResultPoint b) => (double)(a.X - b.X) * (a.X - b.X) + (double)(a.Y - b.Y) * (a.Y - b.Y);
    internal static bool Checkpoint(GoalResultDefinition definition, IReadOnlyList<GoalResultPoint> previous, GoalResultPoint point)
    {
        if (point.Point != previous.Count + 1 || point.Point > definition.Checkpoints.Count || point.Venue != definition.Venue
            || point.X is < 0 or > 500 || point.Y is < 0 or > 500 || !Time(point.Time) || !LongGoalRules.Weather(point.Weather)
            || !Duration(point.Minutes) || !Count(definition, point.Count) || !Choice(point.ChoiceId)) return false;
        if (previous.Count == 0) return point.Minutes <= ClockMinutes(point.Time) - 540;
        GoalResultPoint last = previous[^1];
        if (point.Minutes < last.Minutes + 10 || ClockMinutes(point.Time) < ClockMinutes(last.Time) + 10
            || point.Minutes - last.Minutes > ClockMinutes(point.Time) - ClockMinutes(last.Time) || point.Count < last.Count) return false;
        if (definition.ProjectId == "robin_small_space" && point.Point == 3) return DistanceSquared(previous[0], point) <= 9;
        return previous.All(prior => DistanceSquared(prior, point) >= 36);
    }
    internal static bool Ready(GoalResultDefinition definition, GoalResultAttempt attempt, int day, int minutes, int count)
        => attempt.EndId is null && attempt.Day == day && attempt.Points.Count == definition.Checkpoints.Count && Duration(minutes)
            && minutes >= definition.Minutes && minutes >= attempt.Points[^1].Minutes && Count(definition, count) && count >= attempt.Points[^1].Count
            && (definition.ProjectId != "linus_light_steps" || attempt.Points[0].ChoiceId != "b" || count >= 2);
    internal static bool Review(GoalResultAttempt? completed, string? reviewedId, int day)
        => completed is { EndKind: "completed" } && reviewedId is null && day > completed.EndDay;

    private static bool Shape(LifeEvent entry)
    {
        string[]? extras = entry.Kind switch
        {
            "goalresult.notified" => new[] { "chapterId", "sourceId" }, "goalresult.started" => new[] { "sourceId", "choiceId" },
            "goalresult.checkpoint" => new[] { "attemptId", "point", "venue", "x", "y", "time", "weather", "minutes", "count", "choiceId" },
            "goalresult.completed" => new[] { "attemptId", "sourceId", "minutes", "count", "choiceId" },
            "goalresult.cancelled" => new[] { "attemptId", "reason" }, "goalresult.reviewed" => new[] { "sourceId", "choiceId" }, _ => null,
        };
        if (extras is null) return false;
        HashSet<string> fields = new(new[] { "id", "npc", "day", "kind", "projectId" }.Concat(extras));
        var actual = LifeEventWire.Encode(new[] { entry })[0].EnumerateObject().Select(p => p.Name).ToHashSet();
        return actual.SetEquals(fields);
    }

    internal static GoalResultState? Replay(GoalResultDefinition definition, IReadOnlyList<LifeEvent> all, int day)
    {
        GoalResultState state = new(); int lastDay = 0;
        foreach (LifeEvent entry in all.Where(e => e.ProjectId == definition.ProjectId))
        {
            if (!Shape(entry) || entry.Npc != definition.Owner || entry.Day < 1 || entry.Day < lastDay || entry.Day > day || Serial(entry.Id) == 0) return null;
            lastDay = entry.Day;
            GoalResultAttempt? active = Active(state), completed = Completed(state);
            LifeEvent? source = entry.SourceId is null ? null : all.FirstOrDefault(e => e.Id == entry.SourceId && Serial(e.Id) < Serial(entry.Id));
            switch (entry.Kind)
            {
                case "goalresult.notified":
                    if (entry.ChapterId is not (1 or 2 or 3) || !Dependency(definition, source, entry.Day, entry.ChapterId.Value)
                        || state.Notified.ContainsKey(entry.ChapterId.Value) || all.Any(e => e.Kind == "longgoal.completed" && e.LongGoalId == definition.ProjectId
                            && e.ChapterId > entry.ChapterId && Serial(e.Id) < Serial(entry.Id))) return null;
                    state.Notified.Add(entry.ChapterId.Value, entry.Id);
                    break;
                case "goalresult.started":
                    if (active is not null || completed is not null || !Dependency(definition, source, entry.Day, 3) || !Choice(entry.ChoiceId)) return null;
                    state.Attempts.Add(new() { Id = entry.Id, Day = entry.Day, SourceId = entry.SourceId!, PlanChoiceId = entry.ChoiceId! });
                    break;
                case "goalresult.checkpoint":
                    if (active is null || active.Id != entry.AttemptId || active.Day != entry.Day || entry.Point is null || entry.X is null || entry.Y is null
                        || entry.Time is null || entry.Minutes is null || entry.Count is null) return null;
                    GoalResultPoint point = new()
                    {
                        Id = entry.Id, Point = entry.Point.Value, Venue = entry.Venue!, X = entry.X.Value, Y = entry.Y.Value, Time = entry.Time.Value,
                        Weather = entry.Weather!, Minutes = entry.Minutes.Value, Count = entry.Count.Value, ChoiceId = entry.ChoiceId!,
                    };
                    if (!Checkpoint(definition, active.Points, point)) return null;
                    active.Points.Add(point);
                    break;
                case "goalresult.completed":
                    if (active is null || active.Id != entry.AttemptId || entry.Minutes is null || entry.Count is null || !Choice(entry.ChoiceId)
                        || !Ready(definition, active, entry.Day, entry.Minutes.Value, entry.Count.Value) || entry.SourceId != active.Points[^1].Id) return null;
                    active.EndId = entry.Id; active.EndDay = entry.Day; active.EndKind = "completed"; active.Minutes = entry.Minutes.Value;
                    active.Count = entry.Count.Value; active.FinishChoiceId = entry.ChoiceId;
                    break;
                case "goalresult.cancelled":
                    if (active is null || active.Id != entry.AttemptId || entry.Reason is not ("player" or "interrupted" or "load")
                        || entry.Day < active.Day || entry.Reason == "player" && entry.Day != active.Day) return null;
                    active.EndId = entry.Id; active.EndDay = entry.Day; active.EndKind = "cancelled"; active.Reason = entry.Reason;
                    break;
                case "goalresult.reviewed":
                    if (!Review(completed, state.ReviewId, entry.Day) || entry.SourceId != completed!.EndId || !Choice(entry.ChoiceId)) return null;
                    state.ReviewId = entry.Id; state.ReviewDay = entry.Day; state.ReviewChoiceId = entry.ChoiceId;
                    break;
                default: return null;
            }
        }
        return state;
    }

    internal static bool ValidState(GoalResultDefinition definition, GoalResultState state, IReadOnlyList<LifeEvent> events, int day)
    {
        if (state is null || state.Notified is null || state.Attempts is null || state.ReceiptPages is null || state.Attempts.Any(a => a is null || a.Points is null)) return false;
        GoalResultState? expected = Replay(definition, events, day);
        if (expected is null || !state.Notified.OrderBy(p => p.Key).SequenceEqual(expected.Notified.OrderBy(p => p.Key)) || state.Attempts.Count != expected.Attempts.Count
            || state.ReviewId != expected.ReviewId || state.ReviewDay != expected.ReviewDay || state.ReviewChoiceId != expected.ReviewChoiceId) return false;
        for (int i = 0; i < state.Attempts.Count; i++)
        {
            GoalResultAttempt a = state.Attempts[i], b = expected.Attempts[i];
            if (a.Id != b.Id || a.Day != b.Day || a.SourceId != b.SourceId || a.PlanChoiceId != b.PlanChoiceId || a.EndId != b.EndId || a.EndDay != b.EndDay
                || a.EndKind != b.EndKind || a.Reason != b.Reason || a.Minutes != b.Minutes || a.Count != b.Count || a.FinishChoiceId != b.FinishChoiceId || a.Points.Count != b.Points.Count) return false;
            for (int p = 0; p < a.Points.Count; p++)
            {
                GoalResultPoint x = a.Points[p], y = b.Points[p];
                if (x is null || x.Id != y.Id || x.Point != y.Point || x.Venue != y.Venue || x.X != y.X || x.Y != y.Y || x.Time != y.Time
                    || x.Weather != y.Weather || x.Minutes != y.Minutes || x.Count != y.Count || x.ChoiceId != y.ChoiceId) return false;
            }
        }
        GoalResultAttempt? finished = Completed(expected);
        if (finished is null)
        { if (state.ReceiptTitle is not null || state.ReceiptText is not null || state.ReceiptPages.Count > 0) return false; }
        else
        {
            BuildReceipt(definition, expected, finished);
            if (state.ReceiptTitle != expected.ReceiptTitle || state.ReceiptText != expected.ReceiptText || state.ReceiptPages.Count != expected.ReceiptPages.Count
                || state.ReceiptPages.Select((page, index) => page is null || page.Title != expected.ReceiptPages[index].Title || page.Text != expected.ReceiptPages[index].Text).Any(invalid => invalid)) return false;
        }
        return state.ReviewId is null ? state.ReviewText is null : finished is not null && state.ReviewText == ReviewText(definition, finished, state.ReviewChoiceId!);
    }

    internal static string ReviewText(GoalResultDefinition definition, GoalResultAttempt completed, string choice)
        => $"回访依据：第 {completed.Day} 天的{definition.Title}，有效同行 {completed.Minutes} 分钟。\n" + definition.ReviewChoices.Single(c => c.Id == choice).Text;

    internal static void BuildReceipt(GoalResultDefinition definition, GoalResultState state, GoalResultAttempt attempt)
    {
        state.ReceiptTitle = definition.Title + "·实践回执";
        string action = definition.Mode == "fishing" ? $"，实际钓获 {attempt.Count} 条鱼" : definition.Mode == "foraging" ? $"，实际采集 {attempt.Count} 件" : "";
        state.ReceiptText = definition.ReceiptIntro + $"\n第 {attempt.Day} 天，在{definition.VenueLabel}实际同行 {attempt.Minutes} 分钟{action}。以下只保存这次选择与记录。";
        state.ReceiptPages = new() { new() { Title = "开始时的方案", Text = definition.PlanChoices.Single(c => c.Id == attempt.PlanChoiceId).Text } };
        foreach (GoalResultPoint point in attempt.Points)
        {
            GoalResultCheckpoint checkpoint = definition.Checkpoints[point.Point - 1];
            string weather = point.Weather switch { "rain" => "下雨", "storm" => "雷雨", "snow" => "下雪", "windy" => "刮风", _ => "晴天" };
            string fact = $"在{definition.VenueLabel}，{point.Time / 100:00}:{point.Time % 100:00}，{weather}；当时有效同行 {point.Minutes} 分钟。";
            if (definition.Mode != "walk") fact += $" 当时实际{(definition.Mode == "fishing" ? "钓获" : "采集")} {point.Count} 个。";
            if (point.Point > 1)
            {
                double distance = Math.Sqrt(DistanceSquared(attempt.Points[0], point));
                fact += $" 与首个记录位置相距 {distance.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture)} 格。";
            }
            state.ReceiptPages.Add(new() { Title = checkpoint.Title, Text = fact + "\n这次的记录选择：" + checkpoint.Choices.Single(c => c.Id == point.ChoiceId).Text });
        }
        state.ReceiptPages.Add(new() { Title = "这次的收尾选择", Text = definition.FinishChoices.Single(c => c.Id == attempt.FinishChoiceId).Text });
    }
}
