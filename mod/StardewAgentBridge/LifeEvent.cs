using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace StardewAgentBridge;

internal sealed class LifeEvent
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("npc")] public string Npc { get; set; } = "";
    [JsonPropertyName("day")] public int Day { get; set; }
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("goal")] public string? Goal { get; set; }
    [JsonPropertyName("activity")] public string? Activity { get; set; }
    [JsonPropertyName("item")] public string? Item { get; set; }
    [JsonPropertyName("count")] public int? Count { get; set; }
    [JsonPropertyName("minutes")] public int? Minutes { get; set; }
    [JsonPropertyName("other")] public string? Other { get; set; }
    [JsonPropertyName("sourceId")] public string? SourceId { get; set; }
    [JsonPropertyName("friendship")] public int? Friendship { get; set; }
    [JsonPropertyName("dateId")] public string? DateId { get; set; }
    [JsonPropertyName("venue")] public string? Venue { get; set; }
    [JsonPropertyName("dateDay")] public int? DateDay { get; set; }
    [JsonPropertyName("time")] public int? Time { get; set; }
    [JsonPropertyName("preparation")] public string? Preparation { get; set; }
    [JsonPropertyName("relation")] public string? Relation { get; set; }
    [JsonPropertyName("initiator")] public string? Initiator { get; set; }
    [JsonPropertyName("weather")] public string? Weather { get; set; }
    [JsonPropertyName("reason")] public string? Reason { get; set; }
    [JsonPropertyName("detail")] public string? Detail { get; set; }
    [JsonPropertyName("storyId")] public string? StoryId { get; set; }
    [JsonPropertyName("clueId")] public string? ClueId { get; set; }
    [JsonPropertyName("choiceId")] public string? ChoiceId { get; set; }
    [JsonPropertyName("step")] public int? Step { get; set; }
    [JsonPropertyName("outcome")] public string? Outcome { get; set; }
    [JsonPropertyName("longGoalId")] public string? LongGoalId { get; set; }
    [JsonPropertyName("chapterId")] public int? ChapterId { get; set; }
    [JsonPropertyName("contributionId")] public string? ContributionId { get; set; }
    [JsonPropertyName("itemId")] public string? ItemId { get; set; }
    [JsonPropertyName("dependencySourceId")] public string? DependencySourceId { get; set; }
    [JsonPropertyName("projectId")] public string? ProjectId { get; set; }
    [JsonPropertyName("attemptId")] public string? AttemptId { get; set; }
    [JsonPropertyName("point")] public int? Point { get; set; }
    [JsonPropertyName("x")] public int? X { get; set; }
    [JsonPropertyName("y")] public int? Y { get; set; }
    [JsonPropertyName("subject")] public string? Subject { get; set; }
    [JsonPropertyName("subjectX")] public int? SubjectX { get; set; }
    [JsonPropertyName("subjectY")] public int? SubjectY { get; set; }
}

internal static class LifeEventWire
{
    internal static readonly JsonSerializerOptions Json = new() { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
    internal static JsonElement Encode(IEnumerable<LifeEvent> events) => JsonSerializer.SerializeToElement(events, Json);
}
