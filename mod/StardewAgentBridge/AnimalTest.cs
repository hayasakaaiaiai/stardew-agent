using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Objects;

namespace StardewAgentBridge;

/// <summary>Animal and friendship probes, dispatched only after the disposable World identity guard.</summary>
internal sealed partial class ModEntry
{
    private const string TestAnimalKey = "StardewAgentBridge/TestAnimal";
    private readonly Dictionary<string, object> animalPetReference = new();

    private object AnimalSnapshot()
    {
        Farm farm = Game1.getFarm();
        return new
        {
            farming = Game1.player.experiencePoints[0], foraging = Game1.player.experiencePoints[2], Game1.stats.ItemsForaged,
            animals = farm.getAllFarmAnimals().Where(a => a.modData.ContainsKey(TestAnimalKey)).Select(a => new
            {
                label = a.modData[TestAnimalKey], type = a.type.Value, age = a.age.Value,
                friendship = a.friendshipTowardFarmer.Value, happiness = a.happiness.Value,
                petted = a.wasPet.Value, auto = a.wasAutoPet.Value, produce = a.currentProduce.Value,
                quality = a.produceQuality.Value, cracker = a.hasEatenAnimalCracker.Value,
                map = a.currentLocation?.NameOrUniqueName,
            }).ToArray(),
            ground = new GameLocation[] { farm }.Concat(farm.buildings.Select(b => b.GetIndoors()).OfType<AnimalHouse>())
                .SelectMany(location => location.objects.Pairs.Select(pair => new
                {
                    map = location.NameOrUniqueName, x = pair.Key.X, y = pair.Key.Y, id = pair.Value.QualifiedItemId,
                    stack = pair.Value.Stack, quality = pair.Value.Quality, spawned = pair.Value.IsSpawnedObject,
                })).ToArray(),
            reference = this.animalPetReference,
        };
    }

    private void PrepareAnimalTest(int stack, bool full, bool blocked, bool professional, bool auto)
    {
        this.PrepareFarmTest(full, blocked, 3);
        Farm farm = Game1.getFarm();
        farm.animals.Clear(); farm.terrainFeatures.Clear();
        foreach (Vector2 tile in farm.objects.Pairs.Where(pair => pair.Value is IndoorPot).Select(pair => pair.Key).ToArray()) farm.objects.Remove(tile);
        foreach (FishPond pond in farm.buildings.OfType<FishPond>()) pond.output.Value = null;
        Building coop = farm.buildings.First(b => b.buildingType.Value == "Coop");
        AnimalHouse house = (AnimalHouse)coop.GetIndoors();
        house.animals.Clear(); house.animalsThatLiveHere.Clear(); house.objects.Clear();
        Building barn = new("Deluxe Barn", new Vector2(10, 35));
        barn.modData[FarmTestBuildingKey] = "1"; barn.daysOfConstructionLeft.Value = 0; farm.buildings.Add(barn); barn.load();
        AnimalHouse barnHouse = (AnimalHouse)barn.GetIndoors();
        barnHouse.animals.Clear(); barnHouse.animalsThatLiveHere.Clear(); barnHouse.objects.Clear();
        Game1.player.professions.Clear();
        this.animalPetReference.Clear();
        long id = 987655000;
        void Animal(string label, string type, Building home, bool outside = false, bool baby = false, bool petted = false, bool cracker = false, int quality = 0)
        {
            FarmAnimal animal = new(type, ++id, Game1.player.UniqueMultiplayerID) { home = home };
            animal.age.Value = baby ? 0 : animal.GetAnimalData()!.DaysToMature + 1;
            animal.modData[TestAnimalKey] = label;
            animal.friendshipTowardFarmer.Value = 200; animal.happiness.Value = 100;
            animal.wasPet.Value = petted; animal.wasAutoPet.Value = auto;
            animal.hasEatenAnimalCracker.Value = cracker; animal.produceQuality.Value = quality;
            animal.currentProduce.Value = animal.GetHarvestType() == StardewValley.GameData.FarmAnimals.FarmAnimalHarvestType.HarvestWithTool
                ? animal.GetProduceID(new Random(17)) : null;
            if (professional && animal.GetAnimalData()!.ProfessionForHappinessBoost is int profession && profession >= 0
                && !Game1.player.professions.Contains(profession)) Game1.player.professions.Add(profession);
            AnimalHouse indoors = (AnimalHouse)home.GetIndoors();
            indoors.animalsThatLiveHere.Add(id);
            GameLocation location = outside ? farm : indoors;
            animal.currentLocation = location; animal.setTileLocation(outside ? new Vector2(25, 20) : new Vector2(4, 4));
            location.animals.Add(id, animal);
            FarmAnimal reference = new(type, id + 100, Game1.player.UniqueMultiplayerID) { home = home, currentLocation = location };
            reference.age.Value = animal.age.Value; reference.friendshipTowardFarmer.Value = 200; reference.happiness.Value = 100;
            reference.wasAutoPet.Value = auto;
            if (!petted && Game1.timeOfDay < 1900) reference.pet(Game1.player);
            this.animalPetReference[label] = new { friendship = reference.friendshipTowardFarmer.Value, happiness = reference.happiness.Value };
        }
        Animal("chicken", "White Chicken", coop);
        Animal("rabbit-petted", "Rabbit", coop, petted: true);
        Animal("cow", "White Cow", barn, cracker: true, quality: 4);
        Animal("goat-outside", "Goat", barn, outside: true, quality: 1);
        Animal("sheep", "Sheep", barn, quality: 2);
        Animal("baby", "White Cow", barn, baby: true);
        Animal("pig", "Pig", barn, outside: true);
        void Floor(GameLocation location, int x, int y, string item, int amount, bool spawned, int quality = 0)
        {
            StardewValley.Object obj = ItemRegistry.Create<StardewValley.Object>(item, amount, quality);
            obj.IsSpawnedObject = spawned; location.objects[new Vector2(x, y)] = obj;
        }
        Floor(house, 2, 4, "(O)176", stack, true, 2);
        Floor(house, 3, 4, "(O)442", 1, true);
        Floor(house, 4, 4, "(BC)104", 1, true);
        Floor(house, 5, 4, "(BC)165", 1, true);
        Floor(house, 6, 4, "(BC)101", 1, true);
        Floor(house, 7, 4, "(O)184", 1, false);
        Floor(farm, 28, 28, "(O)430", 1, true);
        Floor(farm, 29, 28, "(O)430", 1, false);
    }

    private bool AnimalTestCommand(string operation, JsonElement args)
    {
        if (operation is not ("animals-fixture" or "animals-inspect" or "friendship-inspect" or "friendship-fixture")) return false;
        int Number(string key, int fallback) => args.TryGetProperty(key, out JsonElement value) ? value.GetInt32() : fallback;
        bool Flag(string key) => args.TryGetProperty(key, out JsonElement value) && value.GetBoolean();
        if (operation == "animals-fixture")
        {
            this.PrepareAnimalTest(Number("stack", 1), Flag("full"), Flag("blocked"), Flag("professional"), Flag("auto"));
            if (Flag("partial"))
                Game1.getFarm().objects.Values.OfType<Chest>().Single(chest => chest.modData.ContainsKey(FarmTestChestKey))
                    .Items[0] = ItemRegistry.Create("(O)176", 998, 2);
        }
        if (operation is "friendship-inspect" or "friendship-fixture")
        {
            string npc = args.TryGetProperty("npc", out JsonElement name) ? name.GetString()! : "Abigail";
            if (operation == "friendship-fixture")
            {
                Game1.player.friendshipData[npc].Points = Number("points", 2000);
                Game1.player.stats.Set("Book_Friendship", (uint)Number("book", 0));
            }
            this.worldTestNative = new { npc, points = Game1.player.friendshipData[npc].Points, total = this.friendshipToday.GetValueOrDefault(npc),
                book = Game1.player.stats.Get("Book_Friendship") };
        }
        else this.worldTestNative = this.AnimalSnapshot();
        this.WorldComplete(); return true;
    }
}
