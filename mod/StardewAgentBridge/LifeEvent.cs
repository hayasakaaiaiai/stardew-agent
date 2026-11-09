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
}

internal static class LifeEventWire
{
    internal static readonly JsonSerializerOptions Json = new() { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
    internal static JsonElement Encode(IEnumerable<LifeEvent> events) => JsonSerializer.SerializeToElement(events, Json);
}
