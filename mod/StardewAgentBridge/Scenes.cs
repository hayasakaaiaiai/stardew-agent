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
/// Two NPCs standing together near the player chat over their heads (docs/npc-chat.md). News is confirmed only
/// after both participants stayed for the displayed scene (docs/npc-news.md). The backend checks the budget too.
/// </summary>
internal sealed partial class ModEntry
{
    private const float SceneNpcRange = 2;
    private const float ScenePlayerRange = 8;
    private const int ScenesPerDay = 4;
    private const int SceneGapMinutes = 60;
    private const int SceneLineTicks = 180;
    private const int SceneReplyTicks = 60 * 60;

    private readonly HashSet<string> scenePairs = new();
    private readonly Queue<(string Npc, string Text, string Emote)> sceneLines = new();
    private readonly HashSet<string> sceneParticipants = new(StringComparer.OrdinalIgnoreCase);
    private GameLocation? sceneLocation;
    private int scenesToday;
    private int lastSceneAt = -1;
    private int sceneRequestSeq;
    /// <summary>The request whose lines are on screen; reported once the last one shows (docs/npc-news.md).</summary>
    private int sceneShowing;
    private uint sceneRequestedTick;
    private uint nextSceneLineTick;
    private uint sceneCurrentTick;

    private bool SceneBusy => this.sceneRequestSeq != 0 || this.sceneLines.Count > 0 || this.sceneShowing != 0
        || this.sceneCurrentTick < this.nextSceneLineTick;

    private void ClearScenes()
    {
        this.scenePairs.Clear();
        this.sceneLines.Clear();
        this.scenesToday = 0;
        this.lastSceneAt = -1;
        this.sceneRequestSeq = 0;
        this.sceneShowing = 0;
        this.sceneParticipants.Clear();
        this.sceneLocation = null;
        this.nextSceneLineTick = 0;
    }

    private bool HandleScenes(string type, JsonElement message)
    {
        if (type != "scene.lines")
            return false;
        if (this.sceneRequestSeq == 0 || !this.IsCurrentReply(message, this.sceneRequestSeq))
            return true;
        int request = this.sceneRequestSeq;
        this.sceneRequestSeq = 0;
        if (!message.TryGetProperty("lines", out JsonElement lines) || lines.ValueKind != JsonValueKind.Array)
            return true;
        foreach (JsonElement line in lines.EnumerateArray())
        {
            // A malformed line is skipped like in HandleBubbles, never thrown on.
            if (line.ValueKind != JsonValueKind.Object)
                continue;
            string npc = line.TryGetProperty("npc", out JsonElement n) && n.ValueKind == JsonValueKind.String ? n.GetString() ?? "" : "";
            string text = line.TryGetProperty("text", out JsonElement t) && t.ValueKind == JsonValueKind.String
                ? VanillaDialogue.Escape(t.GetString() ?? "").Trim() : "";
            string emote = line.TryGetProperty("emote", out JsonElement e) && e.ValueKind == JsonValueKind.String ? e.GetString() ?? "none" : "none";
            if (npc.Length > 0 && text.Length > 0)
                this.sceneLines.Enqueue((npc, text, emote));
        }
        if (this.sceneLines.Count > 0)
            this.sceneShowing = request;
        this.nextSceneLineTick = 0;
        return true;
    }

    private void TickScenes(UpdateTickedEventArgs e)
    {
        this.sceneCurrentTick = e.Ticks;
        // A departed listener did not hear the whole scene. Do not acknowledge generated but unseen news,
        // including a scene interrupted by the player changing maps while a dialogue delays its receipt.
        if (this.sceneShowing != 0 && (this.sceneLocation != Game1.currentLocation
            || this.sceneParticipants.Any(id => Game1.currentLocation?.characters.Any(npc => npc.Name.Equals(id, StringComparison.OrdinalIgnoreCase)) != true)))
        {
            this.sceneLines.Clear(); this.sceneShowing = 0;
            this.sceneParticipants.Clear(); this.sceneLocation = null;
        }
        if (this.sceneLines.Count > 0 && e.Ticks >= this.nextSceneLineTick)
        {
            // A speaker who has left the map is skipped; the rest of the talk goes on.
            (string id, string text, string emote) = this.sceneLines.Dequeue();
            NPC? npc = Game1.currentLocation?.characters.FirstOrDefault(c => c.Name.Equals(id, StringComparison.OrdinalIgnoreCase));
            if (npc is not null)
            {
                npc.showTextAboveHead(text);
                if (BubbleEmotes.TryGetValue(emote, out int emoteId))
                    npc.doEmote(emoteId);
                if (this.memoryTest?.Social == true)
                    this.socialTestSceneLines.Add(new { npc = id, text, emote, visible = this.BubbleText(npc), day = this.currentDay });
            }
            this.nextSceneLineTick = e.Ticks + SceneLineTicks;
        }
        // News told in these lines is remembered once they have all shown. Not during an agent conversation: the
        // backend writes a turn under its earlier seq when the reply arrives, and the day's events must stay in order.
        if (this.sceneLines.Count == 0 && this.sceneShowing != 0 && this.talk is null)
        {
            if (this.newsTestRunning) this.newsTestReports.Add(this.sceneShowing);
            this.Send("scene.shown", new() { ["request"] = this.sceneShowing, ["date"] = GameState.Date() });
            this.sceneShowing = 0;
            this.sceneParticipants.Clear(); this.sceneLocation = null;
        }
        if (this.sceneRequestSeq != 0 && e.Ticks - this.sceneRequestedTick > SceneReplyTicks)
            this.sceneRequestSeq = 0;
        // The scripted tests place NPCs on purpose; a scene there would only add model calls and noise.
        if (e.IsMultipleOf(60) && this.memoryTest is null && this.abigailTestRequest is null)
            this.TryStartScene();
    }

    private void TryStartScene()
    {
        if (!this.config.NpcChat || this.sceneRequestSeq != 0 || this.sceneLines.Count > 0
            || this.AmbientBusy
            || this.scenesToday >= ScenesPerDay || !this.CanChat || !Context.IsPlayerFree || Game1.eventUp || this.talk is not null
            || Game1.currentLocation is not GameLocation location)
            return;
        if (this.lastSceneAt >= 0 && Utility.CalculateMinutesBetweenTimes(this.lastSceneAt, Game1.timeOfDay) < SceneGapMinutes)
            return;
        Vector2 player = Game1.player.Tile;
        List<NPC> near = location.characters
            .Where(npc => SocialNpcs.Contains(npc.Name) && Vector2.Distance(npc.Tile, player) <= ScenePlayerRange)
            .ToList();
        for (int i = 0; i < near.Count; i++)
        {
            for (int j = i + 1; j < near.Count; j++)
            {
                if (Vector2.Distance(near[i].Tile, near[j].Tile) > SceneNpcRange)
                    continue;
                string pair = string.Join("+", new[] { near[i].Name, near[j].Name }.OrderBy(name => name, StringComparer.Ordinal));
                if (!this.scenePairs.Add(pair))
                    continue;
                this.scenesToday++;
                this.lastSceneAt = Game1.timeOfDay;
                this.sceneRequestedTick = this.sceneCurrentTick;
                this.sceneLocation = location;
                this.sceneParticipants.Clear();
                this.sceneParticipants.Add(near[i].Name); this.sceneParticipants.Add(near[j].Name);
                // They just had their say; no ambient lines for them for a while (docs/ambient-lines.md).
                this.ambientAskedAt[near[i].Name] = this.ambientAskedAt[near[j].Name] = Game1.timeOfDay;
                this.sceneRequestSeq = this.Send("scene.request", new()
                {
                    ["npcs"] = new[] { near[i].Name, near[j].Name },
                    ["world"] = GameState.World(),
                });
                return;
            }
        }
    }
}
