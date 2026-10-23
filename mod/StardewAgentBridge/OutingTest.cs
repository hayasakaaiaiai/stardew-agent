using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Tools;

namespace StardewAgentBridge;

/// <summary>Native observations and controlled inputs behind WorldTest's disposable-save identity guard.</summary>
internal sealed partial class ModEntry
{
    private object OutingTestSnapshot() => new
    {
        tick = Game1.ticks, forage = Game1.stats.ItemsForaged, artifacts = ArtifactsFound(),
        icons = new { happy = Character.happyEmote, sad = Character.sadEmote, heart = Character.heartEmote, surprise = Character.exclamationEmote },
        meetings = this.meetings.Values.Select(m => new
        {
            m.Npc, m.Met, m.Arrived, m.Reported, m.CalledOff, m.Leave,
            m.Out.Together, m.Out.Started, m.Out.Still, m.Out.Bye, m.Out.EmoteAfter, m.Out.GiftEmote,
            m.Out.Since, m.Out.Suggested, m.Out.Leading, m.Out.LeadMaps, m.Out.LeadAway,
            leadSpot = new { map = m.Out.LeadSpot.Map, x = m.Out.LeadSpot.X, y = m.Out.LeadSpot.Y },
            waitingForReturn = m.Out.GoBack is not null, fields = m.Out.Fields(),
            actor = (m.Trip.Actor ?? Game1.getCharacterFromName(m.Npc)) is not NPC npc ? null : new
            {
                map = npc.currentLocation.NameOrUniqueName, x = npc.TilePoint.X, y = npc.TilePoint.Y,
                facing = npc.FacingDirection, npc.speed, npc.CurrentEmote, npc.CurrentEmoteIndex,
                temporary = npc.temporaryController is not null, controller = npc.controller is not null,
                pass = npc.farmerPassesThrough, destroys = npc.willDestroyObjectsUnderfoot,
                text = this.Helper.Reflection.GetField<string>(npc, "textAboveHead", required: false)?.GetValue(),
            },
        }).ToArray(),
    };

    private bool OutingTestCommand(string operation, JsonElement args)
    {
        if (!operation.StartsWith("outing-", StringComparison.Ordinal)) return false;
        string Text(string key, string fallback = "") => args.TryGetProperty(key, out JsonElement value) ? value.GetString()! : fallback;
        int Number(string key, int fallback = 0) => args.TryGetProperty(key, out JsonElement value) ? value.GetInt32() : fallback;
        bool Flag(string key, bool fallback = false) => args.TryGetProperty(key, out JsonElement value) ? value.GetBoolean() : fallback;
        NPC npc = this.SocialActor(Text("npc", "Abigail"));
        switch (operation)
        {
            case "outing-inspect": this.WorldComplete(); break;
            case "outing-observe": this.WorldWait("outing-ticks", Number("ticks", 60)); break;
            case "outing-player":
                Game1.player.setTileLocation(new Vector2(Number("x"), Number("y")));
                Game1.player.faceDirection(Number("facing", 2));
                this.WorldWait("outing-ticks", Number("ticks", 1)); break;
            case "outing-actor":
                npc.temporaryController = null; npc.controller = null; npc.Halt();
                npc.setTileLocation(new Vector2(Number("x"), Number("y")));
                this.WorldWait("outing-ticks", Number("ticks", 1)); break;
            case "outing-menu":
                if (Flag("open", true)) Game1.activeClickableMenu = new GameMenu();
                else this.CloseSocialMenu();
                this.WorldWait("outing-ticks", Number("ticks", 1)); break;
            case "outing-fish":
                this.CloseSocialMenu();
                Game1.player.Items[0] = new FishingRod(); Game1.player.CurrentToolIndex = 0;
                var bar = new BobberBar(Text("fish", "128"), 0.5f, Flag("treasure"), new List<string>(), null!, Flag("boss"), null!);
                bar.fadeIn = false; bar.fadeOut = true; bar.distanceFromCatching = Flag("caught", true) ? 1f : 0f;
                bar.treasureCaught = Flag("treasure"); bar.perfect = Flag("perfect");
                this.Helper.Reflection.GetField<float>(bar, "scale", required: false)?.SetValue(1f);
                Game1.activeClickableMenu = bar;
                this.worldTestNative = new { method = "controlled terminal state of native BobberBar", bar.whichFish, bar.distanceFromCatching, bar.treasureCaught, bar.perfect, bar.bossFish };
                this.WorldWait("outing-bobber", 2); break;
            case "outing-forage":
                Vector2 tile = Game1.player.Tile + new Vector2(1, 0);
                var forage = ItemRegistry.Create<StardewValley.Object>(Text("item", "(O)16"), Number("stack", 1));
                forage.IsSpawnedObject = true; forage.TileLocation = tile; Game1.currentLocation.objects[tile] = forage;
                uint beforeForage = Game1.stats.ItemsForaged;
                bool picked = Game1.currentLocation.checkAction(new xTile.Dimensions.Location((int)tile.X, (int)tile.Y), Game1.viewport, Game1.player);
                this.worldTestNative = new { method = "GameLocation.checkAction", picked, before = beforeForage, after = Game1.stats.ItemsForaged };
                this.WorldWait("outing-ticks", 2); break;
            case "outing-artifact":
                Game1.player.foundArtifact(Text("item", "96"), Number("count", 1));
                this.worldTestNative = new { method = "Farmer.foundArtifact", count = Number("count", 1) };
                this.WorldWait("outing-ticks", 2); break;
            case "outing-hold-gift":
                this.CloseSocialMenu(); Game1.player.CurrentToolIndex = 0;
                Game1.player.ActiveObject = ItemRegistry.Create<StardewValley.Object>(Text("item", "(O)66"));
                this.WorldWait("outing-ticks", 5); break;
            case "outing-give-gift":
                int before = Game1.player.friendshipData[npc.Name].GiftsToday;
                bool received = npc.tryToReceiveActiveObject(Game1.player, false);
                this.worldTestNative = new { method = "NPC.tryToReceiveActiveObject", received, before, after = Game1.player.friendshipData[npc.Name].GiftsToday };
                this.WorldWait("outing-ticks", 3); break;
            default: throw new InvalidOperationException("Unknown outing test command: " + operation);
        }
        return true;
    }

    private void TickOutingTestPending()
    {
        if (this.worldTestPending is not ("outing-ticks" or "outing-bobber") || this.memoryTestTicks < this.worldTestWait)
            return;
        if (this.worldTestPending == "outing-bobber")
        {
            Game1.activeClickableMenu = null;
            Game1.player.UsingTool = false; Game1.player.canMove = true;
        }
        this.WorldComplete();
    }
}
