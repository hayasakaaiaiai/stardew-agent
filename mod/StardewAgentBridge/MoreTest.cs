using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Monsters;
using StardewValley.Objects;

namespace StardewAgentBridge;

/// <summary>Native mining inputs and a player following the NPC's real route; guarded by WorldTest.</summary>
internal sealed partial class ModEntry
{
    private readonly HashSet<string> moreLeadTravel = new();
    private Vector2? moreStoneTile;
    private Vector2? moreBarrelTile;

    private object MoreTestSnapshot() => new
    {
        rocks = Game1.stats.RocksCrushed, mining = Game1.player.experiencePoints[Farmer.miningSkill],
        level = Game1.player.miningLevel.Value, levels = Game1.player.newLevels.Count,
        ladder = Game1.currentLocation is MineShaft mine ? (bool?)mine.ladderHasSpawned : null,
        stone = this.moreStoneTile is not Vector2 tile ? null : new
        {
            exists = Game1.currentLocation.objects.TryGetValue(tile, out StardewValley.Object? stone),
            health = stone?.MinutesUntilReady, id = stone?.QualifiedItemId,
        },
        barrel = this.moreBarrelTile is Vector2 barrel && Game1.currentLocation.objects.TryGetValue(barrel, out var box) && box is BreakableContainer,
        loot = Game1.currentLocation.debris.Select(debris => debris.item?.QualifiedItemId).ToArray(),
        items = Game1.player.Items.Where(item => item is not null).GroupBy(item => item.QualifiedItemId)
            .ToDictionary(group => group.Key, group => group.Sum(item => item.Stack)),
        mined = this.meetings.Values.Where(m => m.Dungeon).ToDictionary(m => m.Npc, m => m.Trip.Mined),
        travel = this.moreLeadTravel.ToArray(),
    };

    private bool MoreTestCommand(string operation, JsonElement args)
    {
        if (!operation.StartsWith("more-", StringComparison.Ordinal)) return false;
        string name = args.TryGetProperty("npc", out JsonElement id) ? id.GetString()! : "Abigail";
        NPC npc = this.meetings.TryGetValue(name, out Meeting? meeting) && meeting.Trip.Actor is NPC actor ? actor : this.SocialActor(name);
        switch (operation)
        {
            case "more-inspect": this.WorldComplete(); break;
            case "more-lead-follow":
                this.moreLeadTravel.Clear(); this.WorldWait("more-lead", 9000); break;
            case "more-stones":
                this.ClearMineTestRoom();
                Game1.player.setTileLocation(npc.Tile + new Vector2(0, 1));
                Vector2 tile = npc.Tile + new Vector2(1, 0);
                this.moreStoneTile = tile;
                var stone = ItemRegistry.Create<StardewValley.Object>("(O)751");
                stone.TileLocation = tile; stone.MinutesUntilReady = 3;
                Game1.currentLocation.objects[tile] = stone;
                if (args.TryGetProperty("boundary", out JsonElement boundary) && boundary.GetBoolean())
                {
                    Game1.player.experiencePoints[Farmer.miningSkill] = 99;
                    Game1.player.miningLevel.Value = 0;
                }
                this.moreBarrelTile = npc.Tile + new Vector2(-1, 0);
                Game1.currentLocation.objects[this.moreBarrelTile.Value] = new BreakableContainer(this.moreBarrelTile.Value, "118");
                if (Game1.currentLocation is MineShaft mine)
                {
                    mine.stonesLeftOnThisLevel = 1;
                    mine.ladderHasSpawned = false;
                }
                if (args.TryGetProperty("monster", out JsonElement monster) && monster.GetBoolean())
                {
                    GreenSlime slime = new(npc.Position + new Vector2(0, -64), 0) { Health = 250, MaxHealth = 250, DamageToFarmer = 0 };
                    Game1.currentLocation.characters.Add(slime); this.mineTestMonsters.Add(slime);
                }
                this.WorldComplete(); break;
            default: throw new InvalidOperationException("Unknown more test command: " + operation);
        }
        return true;
    }

    private void TickMoreTestPending()
    {
        if (this.worldTestPending != "more-lead") return;
        Meeting? m = this.meetings.Values.FirstOrDefault(m => m.Out.Started);
        NPC? npc = m is null ? null : m.Trip.Actor ?? Game1.getCharacterFromName(m.Npc);
        if (npc is null) { this.WorldComplete("带路测试的 NPC 丢失。"); return; }
        this.moreLeadTravel.Add($"{npc.currentLocation.NameOrUniqueName}:{npc.TilePoint.X},{npc.TilePoint.Y}");
        if (m!.Out.Leading is null || this.memoryTestTicks >= this.worldTestWait) { this.WorldComplete(); return; }
        if (Game1.isWarping || Game1.eventUp || Game1.activeClickableMenu is not null) return;
        Vector2 behind = npc.Tile + (npc.FacingDirection switch
        {
            0 => new Vector2(0, 2), 1 => new Vector2(-2, 0), 2 => new Vector2(0, -2), _ => new Vector2(2, 0),
        });
        if (npc.currentLocation != Game1.currentLocation)
            Game1.warpFarmer(npc.currentLocation.NameOrUniqueName, (int)behind.X, (int)behind.Y, 2);
        else if (Vector2.Distance(Game1.player.Tile, npc.Tile) > 4)
            Game1.player.setTileLocation(behind);
    }
}
