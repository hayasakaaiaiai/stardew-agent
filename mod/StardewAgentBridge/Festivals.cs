using System;
using System.Collections.Generic;
using System.Linq;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>
/// What happened at a festival, so the NPCs who were there remember it (docs/festival-memories.md). Results are read
/// from the vanilla festival event while it runs, since some are never stored and the event is gone once it ends;
/// one message goes to the backend when the player leaves. Nothing in the game is changed.
/// </summary>
internal sealed partial class ModEntry
{
    private static readonly HashSet<string> RememberedFestivals = new() { "spring13", "spring24", "summer11", "fall16", "winter8", "winter25" };

    /// <summary>What has happened so far at one festival.</summary>
    private sealed class FestivalWatch
    {
        public FestivalWatch(Event festival, string key)
        {
            this.Festival = festival;
            this.Key = key;
        }

        public Event Festival { get; }
        public string Key { get; }
        public readonly List<string> Npcs = new();
        public string? Dance;
        /// <summary>Drawn when the festival starts; vanilla clears it once the player hands their gift over.</summary>
        public string? SantaRecipient;
        public bool SantaGiven;
        public string? SantaGiver;
        public bool SantaReceived;
        public bool ContestRead;
        public string? Contest;
        public bool GrangeRead;
        public object? Grange;
        public int? Soup;
        public string[]? SoupChecked;

        public bool HasResult => this.Dance is not null || (this.SantaGiven && this.SantaReceived) || this.Contest is not null || this.Grange is not null || this.Soup is not null;

        public Dictionary<string, object?> Message() => new()
        {
            ["festival"] = this.Key,
            ["npcs"] = this.Npcs.ToList(),
            ["dance"] = this.Dance,
            ["santa"] = this.SantaGiven && this.SantaReceived && this.SantaRecipient is not null && this.SantaGiver is not null
                ? new Dictionary<string, object?> { ["recipient"] = this.SantaRecipient, ["giver"] = this.SantaGiver }
                : null,
            ["contest"] = this.Contest,
            ["grange"] = this.Grange,
            ["soup"] = this.Soup,
        };
    }

    private FestivalWatch? festivalWatch;
    /// <summary>The festival already reported today, so it is never watched twice.</summary>
    private Event? festivalDone;
    private Dictionary<string, object?>? festivalPending;

    private void ClearFestival()
    {
        this.festivalWatch = null;
        this.festivalDone = null;
        this.festivalPending = null;
    }

    private void TickFestival()
    {
        if (!this.activeLoad || this.initialSave is null || this.syncFailed)
            return;
        Event? current = Game1.CurrentEvent;
        // Leaving sets isFestival to false (Event.exitEvent). The fair's fishing game moves the player to its own
        // location but takes the festival along, so the festival only counts as dropped once no event is up.
        if (this.festivalWatch is { } ended && (!ended.Festival.isFestival || (!ReferenceEquals(current, ended.Festival) && !Game1.eventUp)))
        {
            this.festivalWatch = null;
            this.festivalDone = ended.Festival;
            this.EndFestival(ended);
        }
        if (this.festivalWatch is null && this.config.FestivalMemories && current is { isFestival: true } && !ReferenceEquals(current, this.festivalDone)
            && current.id.StartsWith("festival_") && RememberedFestivals.Contains(current.id["festival_".Length..]))
            this.festivalWatch = new FestivalWatch(current, current.id["festival_".Length..]);
        if (this.festivalWatch is { } watch)
            this.ReadFestival(watch);
        this.FlushFestival();
    }

    private void EndFestival(FestivalWatch watch)
    {
        if (!watch.HasResult)
            return;
        this.festivalPending = watch.Message();
        this.festivalPending["date"] = GameState.Date();
        this.Monitor.Log($"节日 {watch.Key} 结束，{watch.Npcs.Count} 位在场，结果已交给后端记住。", LogLevel.Trace);
    }

    /// <summary>Not during an agent conversation, like TickTown: the day's events must stay in order.</summary>
    private void FlushFestival()
    {
        if (this.festivalPending is null || this.talk is not null)
            return;
        this.Send("festival.ended", this.festivalPending);
        this.festivalPending = null;
    }

    private void ReadFestival(FestivalWatch watch)
    {
        Event festival = watch.Festival;
        foreach (NPC actor in festival.actors)
            if (actor is not null && SocialNpcs.Contains(actor.Name) && !watch.Npcs.Contains(actor.Name))
                watch.Npcs.Add(actor.Name);
        switch (watch.Key)
        {
            case "spring24":
                // Asking for a dance is not dancing: only once the main event's dance has started.
                int music = watch.Dance is null && festival.eventCommands is { } commands
                    ? Array.FindIndex(commands, command => command.StartsWith("playMusic FlowerDance"))
                    : -1;
                if (music >= 0 && festival.CurrentCommand > music && Game1.player.dancePartner.TryGetVillager() is NPC partner
                    && SocialNpcs.Contains(partner.Name))
                    watch.Dance = partner.Name;
                break;
            case "winter25":
                if (festival.secretSantaRecipient is NPC recipient)
                    watch.SantaRecipient = recipient.Name;
                else if (watch.SantaRecipient is not null)
                    watch.SantaGiven = true;
                // Vanilla swaps in Lewis when the drawn giver is not at the festival, as it sets up this scene.
                if (festival.doingSecretSanta && festival.mySecretSanta is NPC giver)
                    watch.SantaGiver = giver.Name;
                // A scene can be interrupted before its item handover. Only a completed exchange supports both memories.
                if (watch.SantaGiven && watch.SantaGiver is not null && !festival.doingSecretSanta && festival.playerControlSequence)
                    watch.SantaReceived = true;
                break;
            case "spring13":
            case "winter8":
                // Filled when the winner is announced, with whoever scored most even if nobody reached the bar; the
                // flag then sends the script to the NPC winner.
                HashSet<long> winners = this.Helper.Reflection.GetField<HashSet<long>>(festival, "festivalWinners").GetValue();
                if (!watch.ContestRead && winners.Count > 0)
                {
                    watch.ContestRead = true;
                    watch.Contest = festival.specialEventVariable1 ? "npc" : winners.Contains(Game1.player.UniqueMultiplayerID) ? "player" : null;
                }
                break;
            case "fall16":
                if (!watch.GrangeRead && festival.grangeJudged)
                {
                    watch.GrangeRead = true;
                    int score = festival.grangeScore;
                    if (score == -666)
                        watch.Grange = "shorts";
                    else if (Game1.player.team.grangeDisplay.Any(item => item is not null))
                        watch.Grange = score >= 90 ? 1 : score >= 75 ? 2 : score >= 60 ? 3 : 4;
                }
                break;
            case "summer11":
                // The governor's reaction is never stored: tasting switches the script to one of seven, so compare.
                if (watch.Soup is null && festival.eventCommands is { } playing && !ReferenceEquals(playing, watch.SoupChecked))
                {
                    watch.SoupChecked = playing;
                    for (int level = 0; level <= 6; level++)
                        if (festival.TryGetFestivalDataForYear("governorReaction" + level, out string script)
                            && Event.ParseCommands(script, festival.farmer).SequenceEqual(playing))
                        {
                            watch.Soup = level;
                            break;
                        }
                }
                break;
        }
    }
}
