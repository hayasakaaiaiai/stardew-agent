using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Objects;
using StardewValley.Pathfinding;
using StardewValley.TerrainFeatures;

namespace StardewAgentBridge;

/// <summary>Disposable World fixtures. The outer World runner verifies the save identity before dispatching commands.</summary>
internal sealed partial class ModEntry
{
    private const string FarmTestChestKey = "StardewAgentBridge/HelperChest";
    private const string FarmTestCropKey = "StardewAgentBridge/TestCrop";
    private const string FarmTestBuildingKey = "StardewAgentBridge/TestBuilding";
    private readonly HashSet<Point> farmTestTravel = new();

    private object FarmTestSnapshot()
    {
        Farm farm = Game1.getFarm();
        object PointFields(Point point) => new { point.X, point.Y };
        object Soil(HoeDirt dirt, Vector2 tile, bool pot) => new
        {
            x = tile.X, y = tile.Y, pot, state = dirt.state.Value, watered = dirt.isWatered(), needsWater = dirt.needsWatering(),
            label = dirt.modData.TryGetValue(FarmTestCropKey, out string name) ? name : "",
            crop = dirt.crop is not { } crop ? null : new
            {
                id = crop.indexOfHarvest.Value, ready = dirt.readyForHarvest(), dead = crop.dead.Value,
                forage = crop.forageCrop.Value, phase = crop.currentPhase.Value, day = crop.dayOfCurrentPhase.Value,
                regrows = crop.RegrowsAfterHarvest(),
            },
        };
        return new
        {
            door = PointFields(farm.GetMainFarmHouseEntry()), porch = PointFields(FarmStand(0)),
            gates = new { bus = PointFields(FarmGates().BusArrival), entry = PointFields(FarmGates().FarmEntry), exit = PointFields(FarmGates().FarmExit) },
            rain = farm.IsRainingHere(), hay = farm.piecesOfHay.Value,
            soils = farm.terrainFeatures.Pairs.Where(pair => pair.Value is HoeDirt).Select(pair => Soil((HoeDirt)pair.Value, pair.Key, false))
                .Concat(farm.objects.Pairs.Where(pair => pair.Value is IndoorPot).Select(pair => Soil(((IndoorPot)pair.Value).hoeDirt.Value, pair.Key, true))).ToArray(),
            chests = farm.objects.Pairs.Where(pair => pair.Value is Chest).Select(pair => new
            {
                x = pair.Key.X, y = pair.Key.Y, helper = pair.Value.modData.ContainsKey(FarmTestChestKey),
                items = ((Chest)pair.Value).Items.Where(item => item is not null).Select(item => new { id = item.QualifiedItemId, stack = item.Stack, quality = item.Quality }).ToArray(),
            }).ToArray(),
            buildings = farm.buildings.Select(building => new
            {
                type = building.buildingType.Value,
                tile = new { X = building.tileX.Value, Y = building.tileY.Value },
                size = new { X = building.tilesWide.Value, Y = building.tilesHigh.Value },
                dataSize = new { X = building.GetData()?.Size.X, Y = building.GetData()?.Size.Y },
                dataDoor = new { X = building.GetData()?.HumanDoor.X, Y = building.GetData()?.HumanDoor.Y },
                sortOffset = building.GetData()?.SortTileOffset,
                feed = building.GetIndoors() is AnimalHouse house ? house.objects.Values.Count(item => item.QualifiedItemId == "(O)178") : 0,
                output = building is FishPond pond && pond.output.Value is { } item ? new { id = item.QualifiedItemId, stack = item.Stack } : null,
            }).ToArray(),
            objects = farm.objects.Pairs.Select(pair => new { x = pair.Key.X, y = pair.Key.Y, id = pair.Value.QualifiedItemId }).ToArray(),
            debris = farm.debris.Select(item => item.item?.QualifiedItemId).ToArray(),
        };
    }

    private void PrepareFarmTest(bool full, bool blocked, int hay)
    {
        Farm farm = Game1.getFarm();
        farm.objects.Clear(); farm.terrainFeatures.Clear(); farm.debris.Clear();
        foreach (Building building in farm.buildings.Where(building => building.modData.ContainsKey(FarmTestBuildingKey)).ToArray())
            farm.buildings.Remove(building);
        farm.largeTerrainFeatures.Clear(); farm.resourceClumps.Clear();
        void CropAt(string label, string seed, int x, bool mature, bool watered = false, bool dead = false)
        {
            Vector2 tile = new(x, 25);
            Crop crop = new(seed, x, 25, farm);
            if (mature) crop.growCompletely();
            crop.dead.Value = dead;
            HoeDirt soil = new(watered ? HoeDirt.watered : HoeDirt.dry, farm) { crop = crop };
            soil.modData[FarmTestCropKey] = label;
            farm.terrainFeatures.Add(tile, soil);
        }
        CropAt("parsnip", "472", 30, true);
        CropAt("blueberry", "481", 31, true);
        CropAt("flower", "427", 32, true);
        CropAt("wild", "495", 33, true);
        CropAt("young", "472", 34, false);
        CropAt("already-watered", "472", 35, false, watered: true);
        CropAt("dead", "472", 36, false, dead: true);
        farm.terrainFeatures.Add(new Vector2(37, 25), new HoeDirt(HoeDirt.dry, farm));
        HoeDirt ginger = new(HoeDirt.dry, farm) { crop = new Crop(true, "2", 39, 25, farm) };
        ginger.modData[FarmTestCropKey] = "ginger";
        farm.terrainFeatures.Add(new Vector2(39, 25), ginger);
        Vector2 potTile = new(38, 25);
        IndoorPot pot = new(potTile);
        pot.hoeDirt.Value.crop = new Crop("472", 38, 25, farm);
        pot.hoeDirt.Value.state.Value = HoeDirt.dry;
        pot.hoeDirt.Value.modData[FarmTestCropKey] = "pot";
        farm.objects.Add(potTile, pot);

        Building coop = new("Coop", new Vector2(30, 35));
        coop.modData[FarmTestBuildingKey] = "1";
        coop.daysOfConstructionLeft.Value = 0;
        farm.buildings.Add(coop); coop.load();
        AnimalHouse house = (AnimalHouse)coop.GetIndoors();
        house.objects.Clear();
        long animalId = 987654321;
        FarmAnimal chicken = new("White Chicken", animalId, Game1.player.UniqueMultiplayerID) { home = coop };
        house.animals.Add(animalId, chicken); house.animalsThatLiveHere.Add(animalId);
        Building silo = new("Silo", new Vector2(40, 35));
        silo.modData[FarmTestBuildingKey] = "1";
        silo.daysOfConstructionLeft.Value = 0; farm.buildings.Add(silo); silo.load(); farm.piecesOfHay.Value = hay;
        FishPond pond = new(new Vector2(45, 35));
        pond.modData[FarmTestBuildingKey] = "1";
        pond.daysOfConstructionLeft.Value = 0; farm.buildings.Add(pond); pond.load();
        pond.fishType.Value = "128"; pond.currentOccupants.Value = 1;
        pond.output.Value = ItemRegistry.Create<StardewValley.Object>("(O)812", 3);

        Point door = farm.GetMainFarmHouseEntry();
        Vector2 chestTile = new(door.X - 2, door.Y + 2);
        Chest chest = new(playerChest: true, tileLocation: chestTile);
        chest.modData[FarmTestChestKey] = "1";
        if (full)
            for (int i = 0; i < chest.GetActualCapacity(); i++) chest.Items.Add(ItemRegistry.Create("(O)390", 999));
        farm.objects[chestTile] = chest;
        Point gate = FarmGates().FarmEntry;
        Vector2 fenceTile = new(gate.X - 2, gate.Y + 2);
        farm.objects[fenceTile] = new Fence(fenceTile, "322", false);
        if (blocked)
        {
            for (int dx = -6; dx <= 6; dx++)
            for (int dy = -6; dy <= 6; dy++)
            {
                Vector2 tile = new(door.X + dx, door.Y + dy);
                int distance = Math.Abs(dx) + Math.Abs(dy);
                if (distance >= 2 && distance <= 6 && !farm.objects.ContainsKey(tile))
                    farm.objects[tile] = ItemRegistry.Create<StardewValley.Object>("(O)390");
            }
        }
    }

    private bool FarmTestCommand(string operation, JsonElement args)
    {
        if (!operation.StartsWith("farm-", StringComparison.Ordinal)) return false;
        string Text(string key, string fallback = "") => args.TryGetProperty(key, out JsonElement value) ? value.GetString()! : fallback;
        int Number(string key, int fallback = 0) => args.TryGetProperty(key, out JsonElement value) ? value.GetInt32() : fallback;
        bool Flag(string key, bool fallback = false) => args.TryGetProperty(key, out JsonElement value) ? value.GetBoolean() : fallback;
        switch (operation)
        {
            case "farm-probe":
                Farm probeFarm = Game1.getFarm();
                NPC probeNpc = this.SocialActor(Text("npc", "Abigail"));
                GameLocation oldMap = probeNpc.currentLocation; Vector2 oldTile = probeNpc.Tile;
                bool oldDestroys = probeNpc.willDestroyObjectsUnderfoot;
                Point entry = FarmGates().FarmEntry, stand = FarmStand(0);
                probeNpc.willDestroyObjectsUnderfoot = false;
                Game1.warpCharacter(probeNpc, probeFarm, Utility.PointToVector2(entry));
                try
                {
                    var cells = new List<object>();
                    for (int y = 14; y <= 22; y++)
                    for (int x = 64; x <= 79; x++)
                        cells.Add(new { x, y, blocked = probeFarm.isCollidingPosition(new Rectangle(x * 64 + 1, y * 64 + 1, 62, 62), Game1.viewport,
                            false, 0, false, probeNpc, pathfinding: true), barrier = probeFarm.doesTileHaveProperty(x, y, "NPCBarrier", "Back") });
                    this.worldTestNative = new { cells, paths = new[] { entry, entry + new Point(-1, 0), entry + new Point(-2, 0), new Point(70, 20) }.Select(start => new
                    {
                        start = new { start.X, start.Y }, end = new { stand.X, stand.Y },
                        count = PathFindController.findPath(start, stand, PathFindController.isAtEndPoint, probeFarm, probeNpc, FarmPathLimit)?.Count,
                    }).ToArray() };
                }
                finally { probeNpc.willDestroyObjectsUnderfoot = oldDestroys; Game1.warpCharacter(probeNpc, oldMap, oldTile); }
                this.WorldComplete(); break;
            case "farm-friendship":
                Friendship friendship = new(Number("hearts", 8) * 250);
                if (Text("relation").Length > 0)
                {
                    var status = friendship.GetType().GetProperty("Status")!;
                    status.SetValue(friendship, Enum.Parse(status.PropertyType, Text("relation")));
                }
                Game1.player.friendshipData[Text("npc", "Abigail")] = friendship;
                this.WorldComplete(); break;
            case "farm-fixture": this.PrepareFarmTest(Flag("full"), Flag("blocked"), Number("hay", 3)); this.WorldComplete(); break;
            case "farm-run":
                this.worldTestNative = FarmHelp.Run(Game1.getFarm()); this.WorldComplete(); break;
            case "farm-watch":
                foreach (Meeting meeting in this.meetings.Values.Where(m => m.Applied && !m.Reported)) this.WatchMeeting(meeting);
                this.WorldComplete(); break;
            case "farm-start":
            case "farm-exit":
                this.actionTestNpc = Text("npc", "Abigail");
                this.actionTestSpeed = Number("speed", 2);
                NPC actor = this.SocialActor(this.actionTestNpc);
                Meeting visit = this.meetings[actor.Name];
                bool leaving = operation == "farm-exit";
                this.worldTestTarget = leaving ? "gone" : "porch";
                this.farmTestTravel.Clear();
                this.actionTestClockRunning = Flag("natural");
                Game1.timeOfDay = this.actionTestClockRunning ? Utility.ModifyTime(visit.Depart, -10) : leaving ? visit.Leave : visit.Depart;
                Game1.gameTimeInterval = 0;
                if (!this.actionTestClockRunning) actor.checkSchedule(Game1.timeOfDay);
                this.WorldWait("farm-visit"); break;
            case "farm-wait":
                this.actionTestNpc = Text("npc", "Abigail");
                this.actionTestSpeed = Number("speed", 2);
                this.worldTestTarget = Text("until", "porch");
                this.WorldWait("farm-visit"); break;
            default: throw new InvalidOperationException("Unknown farm fixture command: " + operation);
        }
        return true;
    }

    private void TickFarmTestPending()
    {
        if (this.worldTestPending != "farm-visit") return;
        NPC npc = this.SocialActor(this.actionTestNpc);
        npc.speed = this.actionTestSpeed;
        if (npc.currentLocation is Farm) this.farmTestTravel.Add(npc.TilePoint);
        if (!this.meetings.TryGetValue(npc.Name, out Meeting? meeting)) return;
        bool ready = this.worldTestTarget == "gone" ? meeting.Stage == 3 && npc.controller is null && npc.temporaryController is null
            : meeting.Stage == 1 && (meeting.Spouse || npc.TilePoint == FarmStand(meeting.Slot)) && !npc.isMoving();
        if (!ready) return;
        this.worldTestNative = new { farmTravel = this.farmTestTravel.Select(tile => new { tile.X, tile.Y }).ToArray() };
        npc.speed = 2; this.actionTestClockRunning = false; this.WorldComplete();
    }
}
