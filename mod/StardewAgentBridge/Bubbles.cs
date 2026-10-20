using System;
using System.Collections.Generic;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>
/// Lines an NPC mutters when the player comes near, written by the nightly consolidation (docs/npc-bubbles.md).
/// They are only shown: nothing goes back to the backend and nobody remembers them.
/// </summary>
internal sealed partial class ModEntry
{
    private const float BubbleRangeTiles = 5;
    private const int BubbleGapMinutes = 60;

    private static readonly Dictionary<string, int> BubbleEmotes = new()
    {
        ["happy"] = Character.happyEmote,
        ["heart"] = Character.heartEmote,
        ["question"] = Character.questionMarkEmote,
        ["exclamation"] = Character.exclamationEmote,
        ["sad"] = Character.sadEmote,
        ["music"] = Character.musicNoteEmote,
    };

    /// <summary>NPC id from the backend (lower case) → today's lines.</summary>
    private readonly Dictionary<string, List<(string Text, string Emote)>> bubbles = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> bubblesShown = new();
    private readonly Dictionary<string, int> bubbleShownAt = new(StringComparer.OrdinalIgnoreCase);

    private void ClearBubbles()
    {
        this.bubbles.Clear();
        this.bubblesShown.Clear();
        this.bubbleShownAt.Clear();
    }

    /// <summary>A newer list replaces the old one, e.g. after a late consolidation; lines already shown stay shown.</summary>
    private bool HandleBubbles(string type, JsonElement message)
    {
        if (type != "day.bubbles")
            return false;
        if (!this.IsCurrentMessage(message) || !message.TryGetProperty("npcs", out JsonElement npcs) || npcs.ValueKind != JsonValueKind.Object)
            return true;
        this.bubbles.Clear();
        foreach (JsonProperty npc in npcs.EnumerateObject())
        {
            if (npc.Value.ValueKind != JsonValueKind.Array)
                continue;
            List<(string Text, string Emote)> lines = new();
            foreach (JsonElement line in npc.Value.EnumerateArray())
            {
                if (line.ValueKind != JsonValueKind.Object)
                    continue;
                string text = line.TryGetProperty("text", out JsonElement t) && t.ValueKind == JsonValueKind.String
                    ? VanillaDialogue.Escape(t.GetString() ?? "").Trim() : "";
                string emote = line.TryGetProperty("emote", out JsonElement e) && e.ValueKind == JsonValueKind.String
                    ? e.GetString() ?? "none" : "none";
                if (text.Length > 0)
                    lines.Add((text, emote));
            }
            if (lines.Count > 0)
                this.bubbles[npc.Name] = lines;
        }
        this.RecordBubbleTestPacket();
        return true;
    }

    /// <summary>At most one line per call, for the first NPC nearby that has one due.</summary>
    private void TickBubbles()
    {
        if (!this.config.ShowBubbles || this.bubbles.Count == 0 || !Context.IsPlayerFree || Game1.eventUp || this.talk is not null)
            return;
        Vector2 player = Game1.player.Tile;
        foreach (NPC npc in Game1.currentLocation.characters)
        {
            if (!this.bubbles.TryGetValue(npc.Name, out List<(string Text, string Emote)>? lines)
                || Vector2.Distance(npc.Tile, player) > BubbleRangeTiles)
                continue;
            if (this.bubbleShownAt.TryGetValue(npc.Name, out int shownAt)
                && Utility.CalculateMinutesBetweenTimes(shownAt, Game1.timeOfDay) < BubbleGapMinutes)
                continue;
            int index = lines.FindIndex(line => !this.bubblesShown.Contains(npc.Name + "\n" + line.Text));
            if (index < 0)
                continue;
            (string text, string emote) = lines[index];
            npc.showTextAboveHead(text);
            if (BubbleEmotes.TryGetValue(emote, out int id))
                npc.doEmote(id);
            this.bubblesShown.Add(npc.Name + "\n" + text);
            this.bubbleShownAt[npc.Name] = Game1.timeOfDay;
            return;
        }
    }
}
