using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Characters;
using StardewValley.GameData.FarmAnimals;
using StardewValley.Objects;
using StardewValley.TerrainFeatures;

namespace StardewAgentBridge;

/// <summary>
/// The farm chores a close NPC does when it comes to help (docs/npc-farm-help.md): water, harvest into a chest by the
/// farmhouse, fill the troughs from the silos and empty the fish ponds; then the animals (docs/npc-farm-animals.md):
/// pick up what they laid, milk and shear, pet them as the player would, and pick up the truffles the pigs dug up. All
/// through vanilla's own paths, so the changes are saved, or lost on a reload, with the farm. The player gains no
/// experience, as from an auto-grabber or an auto-petter.
/// </summary>
internal static class FarmHelp
{
    /// <summary>Marks the chests this mod put by the farmhouse, so later visits fill the same ones.</summary>
    private const string ChestKey = "StardewAgentBridge/HelperChest";
    private const int FlowerCategory = -80;
    /// <summary>One harvest can yield a crop, seeds and a bonus item; keep room for all of them.</summary>
    private const int RoomPerHarvest = 3;
    private const int ChestSearchRadius = 6;

    /// <summary>Farm animals sleep from seven; vanilla will not let the player pet them then either.</summary>
    private const int AnimalBedtime = 1900;
    private const string Truffle = "(O)430";

    public readonly record struct Done(int Watered, int Harvested, int Fed, int Ponds, int Collected, int Milked, int Sheared, int Petted, int Truffles);

    /// <summary>Vanilla warps spouses onto the porch, but NPC pathing cannot cross the farmhouse footprint.</summary>
    public static Point VisitorStand(Farm farm)
    {
        Point stand = Utility.getHomeOfFarmer(Game1.player).getPorchStandingSpot();
        if (farm.GetMainFarmHouse() is Building home && stand.X >= home.tileX.Value && stand.X < home.tileX.Value + home.tilesWide.Value)
            stand.Y = Math.Max(stand.Y, home.tileY.Value + home.tilesHigh.Value);
        return stand;
    }

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
        (int collected, int milked, int sheared, int petted) = TendAnimals(farm);
        int truffles = PickUp(farm, obj => obj.QualifiedItemId == Truffle);
        return new Done(watered, harvested, fed, ponds, collected, milked, sheared, petted, truffles);
    }

    /// <summary>What the animals left on the floor, then the ones that need a tool, then a pat for each one not yet petted today.</summary>
    private static (int Collected, int Milked, int Sheared, int Petted) TendAnimals(Farm farm)
    {
        int collected = 0, milked = 0, sheared = 0, petted = 0;
        foreach (Building building in farm.buildings)
            if (building.GetIndoors() is AnimalHouse house)
                collected += PickUp(house, obj => !obj.bigCraftable.Value);
        foreach (FarmAnimal animal in farm.getAllFarmAnimals())
        {
            // As vanilla's auto-grabber does, with the friendship of milking by hand (Tools.MilkPail).
            if (animal.isAdult() && animal.currentProduce.Value is string produce
                && animal.GetHarvestType() == FarmAnimalHarvestType.HarvestWithTool && HasRoom(farm, 1))
            {
                StardewValley.Object item = ItemRegistry.Create<StardewValley.Object>("(O)" + produce);
                item.CanBeSetDown = false;
                item.Quality = animal.produceQuality.Value;
                if (animal.hasEatenAnimalCracker.Value)
                    item.Stack = 2;
                int stack = item.Stack;
                if (Store(farm, item) is null)
                {
                    animal.HandleStatsOnProduceCollected(item, (uint)stack);
                    animal.currentProduce.Value = null;
                    animal.friendshipTowardFarmer.Value = Math.Min(1000, animal.friendshipTowardFarmer.Value + 5);
                    animal.ReloadTextureIfNeeded();
                    if (animal.GetAnimalData()?.HarvestTool == "Shears")
                        sheared++;
                    else
                        milked++;
                }
            }
            if (Game1.timeOfDay < AnimalBedtime && !animal.wasPet.Value)
            {
                Pet(animal);
                petted++;
            }
        }
        return (collected, milked, sheared, petted);
    }

    /// <summary>The player's own pat (FarmAnimal.pet), less the experience; after an auto-petter it adds what is left.</summary>
    private static void Pet(FarmAnimal animal)
    {
        animal.wasPet.Value = true;
        animal.friendshipTowardFarmer.Value = Math.Min(1000, animal.friendshipTowardFarmer.Value + (animal.wasAutoPet.Value ? 7 : 15));
        FarmAnimalData? data = animal.GetAnimalData();
        int drain = data?.HappinessDrain ?? 0;
        if (data is not null && data.ProfessionForHappinessBoost >= 0 && Game1.player.professions.Contains(data.ProfessionForHappinessBoost))
        {
            animal.friendshipTowardFarmer.Value = Math.Min(1000, animal.friendshipTowardFarmer.Value + 15);
            animal.happiness.Value = (byte)Math.Min(255, animal.happiness.Value + Math.Max(5, 30 + drain));
        }
        animal.happiness.Value = (byte)Math.Min(255, animal.happiness.Value + Math.Max(5, 30 + drain));
        animal.doEmote(Character.heartEmote);
    }

    /// <summary>
    /// Vanilla's spawned items in a location, as the player picks them up (GameLocation.checkAction): a fresh copy into the
    /// chests, counted as foraged, at the quality they lie at. Stops once no chest has room.
    /// </summary>
    private static int PickUp(GameLocation location, Func<StardewValley.Object, bool> wanted)
    {
        Farm farm = Game1.getFarm();
        int count = 0;
        foreach ((Vector2 tile, StardewValley.Object obj) in location.objects.Pairs.ToList())
        {
            if (!obj.IsSpawnedObject || !wanted(obj))
                continue;
            Item copy = obj.getOne();
            copy.Stack = obj.Stack;
            Item? left = Store(farm, copy);
            int stored = obj.Stack - (left?.Stack ?? 0);
            if (left is null)
                location.objects.Remove(tile);
            else
                obj.Stack = left.Stack;
            Game1.stats.ItemsForaged += (uint)stored;
            count += stored;
            if (left is not null)
                break;
        }
        return count;
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
            if (feature is not HoeDirt dirt || dirt.crop is not Crop crop || !dirt.readyForHarvest() || crop.forageCrop.Value || crop.isWildSeedCrop()
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
        Point porch = VisitorStand(farm);
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
