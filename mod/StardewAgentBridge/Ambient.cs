using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>
/// NPCs near the player each say at most one line over their heads, or greet the player once a day
/// (docs/ambient-lines.md). Only shown, never remembered. The backend checks the budget and greetings too.
/// </summary>
internal sealed partial class ModEntry
{
    private const float AmbientRange = 10;
    private const float AmbientShowRange = 12;
    private const int AmbientMaxNpcs = 4;
    private const int AmbientCallsPerDay = 12;
    private const int AmbientNpcGapMinutes = 120;
    private const int AmbientCallGapMinutes = 30;
    private const int AmbientLineTicks = 180;
    private const int AmbientReplyTicks = 600;
    private const int AmbientFaceMilliseconds = 3000;

    /// <summary>NPC name → game time it last went into a request.</summary>
    private readonly Dictionary<string, int> ambientAskedAt = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> ambientGreeted = new(StringComparer.OrdinalIgnoreCase);
    private readonly Queue<(string Npc, string To, string Text, string Emote)> ambientLines = new();
    private int ambientToday;
    private int lastAmbientAt = -1;
    private int ambientRequestSeq;
    private uint ambientRequestedTick;
    private uint nextAmbientLineTick;
    private uint ambientCurrentTick;

    private void ClearAmbient()
    {
        this.ambientAskedAt.Clear();
        this.ambientGreeted.Clear();
        this.ambientLines.Clear();
        this.ambientToday = 0;
        this.lastAmbientAt = -1;
        this.ambientRequestSeq = 0;
    }

    private bool HandleAmbient(string type, JsonElement message)
    {
        if (type != "ambient.lines")
            return false;
        if (this.ambientRequestSeq == 0 || !this.IsCurrentReply(message, this.ambientRequestSeq))
            return true;
        this.ambientRequestSeq = 0;
        if (!message.TryGetProperty("lines", out JsonElement lines) || lines.ValueKind != JsonValueKind.Array)
            return true;
        foreach (JsonElement line in lines.EnumerateArray())
        {
            // A malformed line is skipped like in HandleScenes, never thrown on.
            if (line.ValueKind != JsonValueKind.Object)
                continue;
            string npc = line.TryGetProperty("npc", out JsonElement n) && n.ValueKind == JsonValueKind.String ? n.GetString() ?? "" : "";
            string to = line.TryGetProperty("to", out JsonElement o) && o.ValueKind == JsonValueKind.String ? o.GetString() ?? "self" : "self";
            string text = line.TryGetProperty("text", out JsonElement t) && t.ValueKind == JsonValueKind.String
                ? VanillaDialogue.Escape(t.GetString() ?? "").Trim() : "";
            string emote = line.TryGetProperty("emote", out JsonElement e) && e.ValueKind == JsonValueKind.String ? e.GetString() ?? "none" : "none";
            if (npc.Length > 0 && text.Length > 0)
                this.ambientLines.Enqueue((npc, to, text, emote));
        }
        this.nextAmbientLineTick = 0;
        return true;
    }

    private void TickAmbient(UpdateTickedEventArgs e)
    {
        this.ambientCurrentTick = e.Ticks;
        if (this.ambientLines.Count > 0 && e.Ticks >= this.nextAmbientLineTick)
        {
            // A speaker who has left the map or wandered off is skipped; the others still speak.
            (string id, string to, string text, string emote) = this.ambientLines.Dequeue();
            NPC? npc = Game1.currentLocation?.characters.FirstOrDefault(c => c.Name.Equals(id, StringComparison.OrdinalIgnoreCase));
            if (npc is not null && Vector2.Distance(npc.Tile, Game1.player.Tile) <= AmbientShowRange)
            {
                if (to == "farmer")
                {
                    this.ambientGreeted.Add(npc.Name);
                    // Turning around mid-walk or mid-animation would look broken, so only someone standing still does.
                    if (!npc.isMoving() && !npc.doingEndOfRouteAnimation.Value)
                        npc.faceTowardFarmerForPeriod(AmbientFaceMilliseconds, 3, false, Game1.player);
                }
                npc.showTextAboveHead(text);
                if (BubbleEmotes.TryGetValue(emote, out int emoteId))
                    npc.doEmote(emoteId);
                this.bubbleShownAt[npc.Name] = Game1.timeOfDay;
                this.nextAmbientLineTick = e.Ticks + AmbientLineTicks;
            }
        }
        if (this.ambientRequestSeq != 0 && e.Ticks - this.ambientRequestedTick > AmbientReplyTicks)
            this.ambientRequestSeq = 0;
        // The scripted tests place NPCs on purpose; lines there would only add model calls and noise.
        if (e.IsMultipleOf(60) && this.memoryTest is null && this.abigailTestRequest is null)
            this.TryStartAmbient();
    }

    private void TryStartAmbient()
    {
        if (!this.config.AmbientLines || this.ambientRequestSeq != 0 || this.ambientLines.Count > 0
            || this.sceneRequestSeq != 0 || this.sceneLines.Count > 0
            || this.ambientToday >= AmbientCallsPerDay || !this.CanChat || !Context.IsPlayerFree || Game1.eventUp || Game1.isFestival()
            || this.talk is not null || Game1.currentLocation is not GameLocation location)
            return;
        if (this.lastAmbientAt >= 0 && Utility.CalculateMinutesBetweenTimes(this.lastAmbientAt, Game1.timeOfDay) < AmbientCallGapMinutes)
            return;
        Vector2 player = Game1.player.Tile;
        List<NPC> near = location.characters
            .Where(npc => SocialNpcs.Contains(npc.Name) && !npc.IsInvisible && Vector2.Distance(npc.Tile, player) <= AmbientRange
                && this.AmbientDue(npc.Name))
            .OrderBy(npc => Vector2.Distance(npc.Tile, player))
            .Take(AmbientMaxNpcs)
            .ToList();
        if (near.Count == 0)
            return;
        foreach (NPC npc in near)
            this.ambientAskedAt[npc.Name] = Game1.timeOfDay;
        this.ambientToday++;
        this.lastAmbientAt = Game1.timeOfDay;
        this.ambientRequestedTick = this.ambientCurrentTick;
        this.ambientRequestSeq = this.Send("ambient.request", new()
        {
            ["npcs"] = near.Select(npc => new Dictionary<string, object?>
            {
                ["npc"] = npc.Name,
                ["hearts"] = GameState.Hearts(npc),
                ["relation"] = GameState.Relation(npc),
                ["greeted"] = this.ambientGreeted.Contains(npc.Name),
            }).ToList(),
            ["world"] = GameState.World(),
        });
    }

    /// <summary>
    /// Not asked within two hours, not in a scene, and nothing over its head within the hour. Last night's lines
    /// say more than small talk, so someone with some left waits until they have all shown (docs/ambient-lines.md §2).
    /// </summary>
    private bool AmbientDue(string name)
    {
        if (this.ambientAskedAt.TryGetValue(name, out int asked) && Utility.CalculateMinutesBetweenTimes(asked, Game1.timeOfDay) < AmbientNpcGapMinutes)
            return false;
        if (this.bubbleShownAt.TryGetValue(name, out int shown) && Utility.CalculateMinutesBetweenTimes(shown, Game1.timeOfDay) < BubbleGapMinutes)
            return false;
        return !this.sceneParticipants.Contains(name) && !this.HasBubblesLeft(name);
    }
}
