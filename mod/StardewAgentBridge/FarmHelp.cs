using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Characters;
using StardewValley.Objects;
using StardewValley.TerrainFeatures;

namespace StardewAgentBridge;

/// <summary>
/// The farm chores a close NPC does when it comes to help (docs/npc-farm-help.md): water, harvest into a chest by the
/// farmhouse, fill the troughs from the silos and empty the fish ponds. All through vanilla's own paths, so the changes
/// are saved, or lost on a reload, with the farm.
/// </summary>
internal static class FarmHelp
{
    /// <summary>Marks the chests this mod put by the farmhouse, so later visits fill the same ones.</summary>
    private const string ChestKey = "StardewAgentBridge/HelperChest";
    private const int FlowerCategory = -80;
    /// <summary>One harvest can yield a crop, seeds and a bonus item; keep room for all of them.</summary>
    private const int RoomPerHarvest = 3;
    private const int ChestSearchRadius = 6;

    public readonly record struct Done(int Watered, int Harvested, int Fed, int Ponds);

    /// <summary>Hands what a harvest yields to the helper chests, like a Junimo hands it to its hut.</summary>
    private sealed class Harvester : JunimoHarvester
    {
        private readonly Func<Item, Item?> store;

        public Harvester(GameLocation farm, Func<Item, Item?> store)
        {
            this.currentLocation = farm;
            this.store = store;
        }

        public int Stored;
        public List<Item> Spilled { get; } = new();

        public override void tryToAddItemToHut(Item i)
        {
            // A chest that takes part of a stack hands back the same item with the rest.
            int stack = i.Stack;
            Item? left = this.store(i);
            this.Stored += stack - (left?.Stack ?? 0);
            if (left is not null)
                this.Spilled.Add(left);
        }
    }

    public static Done Run(Farm farm)
    {
        int watered = Water(farm);
        int harvested = Harvest(farm);
        int fed = 0;
        foreach (Building building in farm.buildings)
        {
            if (building.GetIndoors() is not AnimalHouse house || house.animalsThatLiveHere.Count == 0)
                continue;
            int before = house.objects.Values.Count(o => o.QualifiedItemId == "(O)178");
            house.feedAllAnimals();
            fed += house.objects.Values.Count(o => o.QualifiedItemId == "(O)178") - before;
        }
        int ponds = 0;
        foreach (FishPond pond in farm.buildings.OfType<FishPond>())
        {
            if (pond.output.Value is not Item output)
                continue;
            Item? left = Store(farm, output);
            pond.output.Value = left;
            if (left is null)
                ponds++;
        }
        return new Done(watered, harvested, fed, ponds);
    }

    /// <summary>Like a spouse watering in the morning: only dry soil whose crop still needs it, in the ground or in pots.</summary>
    private static int Water(Farm farm)
    {
        if (farm.IsRainingHere())
            return 0;
        IEnumerable<HoeDirt> soil = farm.terrainFeatures.Values.OfType<HoeDirt>()
            .Concat(farm.objects.Values.OfType<IndoorPot>().Select(pot => pot.hoeDirt.Value).Where(dirt => dirt is not null));
        int count = 0;
        foreach (HoeDirt dirt in soil)
        {
            if (dirt.crop is null || dirt.crop.dead.Value || dirt.isWatered() || !dirt.needsWatering())
                continue;
            dirt.state.Value = HoeDirt.watered;
            count++;
        }
        return count;
    }

    /// <summary>
    /// Ready crops in the ground, into the chests. Flowers stay, since bee houses make honey from them; so does anything
    /// that is no ordinary crop (forage, ginger). Stops once no chest has room.
    /// </summary>
    private static int Harvest(Farm farm)
    {
        Harvester harvester = new(farm, item => Store(farm, item));
        foreach ((Vector2 tile, TerrainFeature feature) in farm.terrainFeatures.Pairs.ToList())
        {
            if (feature is not HoeDirt dirt || dirt.crop is not Crop crop || !dirt.readyForHarvest() || crop.forageCrop.Value
                || ItemRegistry.GetData(crop.indexOfHarvest.Value)?.Category == FlowerCategory)
                continue;
            if (!HasRoom(farm, RoomPerHarvest))
                break;
            if (crop.harvest((int)tile.X, (int)tile.Y, dirt, harvester))
                dirt.destroyCrop(showAnimation: false);
        }
        // Only if a chest could not take everything after all: left by the door rather than lost.
        Vector2 door = Utility.PointToVector2(farm.GetMainFarmHouseEntry()) * 64f;
        foreach (Item item in harvester.Spilled)
            Game1.createItemDebris(item, door + new Vector2(32f, 96f), -1, farm);
        return harvester.Stored;
    }

    private static IEnumerable<Chest> Chests(Farm farm)
        => farm.objects.Values.OfType<Chest>().Where(chest => chest.modData.ContainsKey(ChestKey));

    private static bool HasRoom(Farm farm, int stacks)
        => Chests(farm).Any(chest => chest.GetActualCapacity() - chest.Items.CountItemStacks() >= stacks) || FreeTile(farm) is not null;

    /// <summary>Into the helper chests, adding one by the farmhouse when they are full. Returns what did not fit.</summary>
    private static Item? Store(Farm farm, Item item)
    {
        Item? left = item;
        foreach (Chest chest in Chests(farm))
        {
            left = chest.addItem(left);
            if (left is null)
                return null;
        }
        if (FreeTile(farm) is not Vector2 tile)
            return left;
        Chest added = new(playerChest: true, tileLocation: tile);
        added.modData[ChestKey] = "1";
        farm.objects.Add(tile, added);
        return added.addItem(left);
    }

    /// <summary>The nearest open tile around the farmhouse door, never on the door, the porch or soil.</summary>
    private static Vector2? FreeTile(Farm farm)
    {
        Point door = farm.GetMainFarmHouseEntry();
        Point porch = Utility.getHomeOfFarmer(Game1.player).getPorchStandingSpot();
        for (int radius = 2; radius <= ChestSearchRadius; radius++)
        {
            for (int dx = -radius; dx <= radius; dx++)
            {
                foreach (int dy in new[] { radius - Math.Abs(dx), -(radius - Math.Abs(dx)) }.Distinct())
                {
                    Vector2 tile = new(door.X + dx, door.Y + dy);
                    if (Near(tile, door) || Near(tile, porch) || farm.terrainFeatures.ContainsKey(tile) || farm.objects.ContainsKey(tile)
                        || !farm.CanItemBePlacedHere(tile))
                        continue;
                    return tile;
                }
            }
        }
        return null;
    }

    private static bool Near(Vector2 tile, Point point) => Math.Abs(tile.X - point.X) + Math.Abs(tile.Y - point.Y) <= 1;
}
