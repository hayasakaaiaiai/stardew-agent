using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Monsters;
using StardewValley.Pathfinding;

namespace StardewAgentBridge;

/// <summary>Native fixtures behind WorldTest's disposable-save identity guard; no production join/rescue calls.</summary>
internal sealed partial class ModEntry
{
    private string mineTestNpc = "Abigail";
    private string mineTestPlace = "矿洞";
    private readonly List<Monster> mineTestMonsters = new();
    private readonly HashSet<Point> mineTestTravel = new();
    private uint mineTestKilledBefore;
    private int mineTestGuildBefore;
    private int mineTestExperienceBefore;
    private Vector2? mineTestObstacle;
    private bool mineTestPostDamage;

    private object MineTestSnapshot() => new
    {
        player = new
        {
            Game1.player.health, Game1.player.maxHealth, Game1.player.Money, Game1.killScreen,
            kills = Game1.player.stats.MonstersKilled, guild = Game1.player.stats.getMonstersKilled("Green Slime"),
            experience = Game1.player.experiencePoints[4], unconscious = Game1.player.stats.TimesUnconscious,
            items = Game1.player.Items.Select(item => item is null ? null : new { id = item.QualifiedItemId, item.Stack, item.Quality }).ToArray(),
        },
        meetings = this.meetings.Values.Where(m => m.Dungeon).Select(m =>
        {
            NPC? npc = m.Trip.Actor ?? Game1.currentLocation?.getCharacterFromName(m.Npc) ?? Game1.getCharacterFromName(m.Npc);
            return new
            {
                m.Npc, m.Place, m.Companion, m.Dungeon, m.Time, m.Depart, m.Leave, m.Arrived, m.Met, m.Reported,
                m.Trip.Joined, m.Trip.Following, m.Trip.HomeBound, m.Trip.Floor, m.Trip.Deepest, m.Trip.Kills,
                m.Trip.Rescued, m.Trip.Rescuing, m.Trip.Bye,
                actor = npc is null ? null : new
                {
                    map = npc.currentLocation?.NameOrUniqueName, x = npc.TilePoint.X, y = npc.TilePoint.Y, npc.speed,
                    pass = npc.farmerPassesThrough, destroys = npc.willDestroyObjectsUnderfoot,
                    temporary = npc.temporaryController is not null, controller = npc.controller is not null,
                },
            };
        }).ToArray(),
        targets = this.mineTestMonsters.Select(monster => new { monster.Health, monster.MaxHealth, x = monster.TilePoint.X, y = monster.TilePoint.Y }).ToArray(),
        actualKills = Game1.player.stats.MonstersKilled - this.mineTestKilledBefore,
        guildDelta = Game1.player.stats.getMonstersKilled("Green Slime") - this.mineTestGuildBefore,
        experienceDelta = Game1.player.experiencePoints[4] - this.mineTestExperienceBefore,
        debris = Game1.currentLocation?.debris.Count ?? 0,
        obstacle = this.mineTestObstacle is not Vector2 rock ? null : new
        { x = rock.X, y = rock.Y, exists = Game1.currentLocation!.objects.ContainsKey(rock), id = Game1.currentLocation.objects.TryGetValue(rock, out var stone) ? stone.QualifiedItemId : null },
        travel = this.mineTestTravel.Select(tile => new { tile.X, tile.Y }).ToArray(),
    };

    private void ClearMineTestRoom()
    {
        GameLocation location = Game1.currentLocation;
        foreach (Monster monster in location.characters.OfType<Monster>().ToArray()) location.characters.Remove(monster);
        Point player = Game1.player.TilePoint;
        foreach (Vector2 tile in location.objects.Keys.ToArray())
            if (Math.Abs(tile.X - player.X) <= 12 && Math.Abs(tile.Y - player.Y) <= 12) location.objects.Remove(tile);
        foreach (Vector2 tile in location.terrainFeatures.Keys.ToArray())
            if (Math.Abs(tile.X - player.X) <= 12 && Math.Abs(tile.Y - player.Y) <= 12) location.terrainFeatures.Remove(tile);
        this.mineTestMonsters.Clear();
        this.mineTestObstacle = null;
        Game1.player.health = Game1.player.maxHealth;
        Game1.player.Stamina = Game1.player.MaxStamina;
    }

    private bool MineTestCommand(string operation, JsonElement args)
    {
        if (!operation.StartsWith("mine-", StringComparison.Ordinal)) return false;
        string Text(string key, string fallback = "") => args.TryGetProperty(key, out JsonElement value) ? value.GetString()! : fallback;
        int Number(string key, int fallback = 0) => args.TryGetProperty(key, out JsonElement value) ? value.GetInt32() : fallback;
        bool Flag(string key, bool fallback = false) => args.TryGetProperty(key, out JsonElement value) ? value.GetBoolean() : fallback;
        this.mineTestNpc = Text("npc", this.mineTestNpc);
        this.mineTestPlace = Text("place", this.mineTestPlace);
        NPC npc = this.SocialActor(this.mineTestNpc);
        switch (operation)
        {
            case "mine-unlock":
                // Calendar-only fixtures retain the source save's day counter and landslide state.
                Game1.player.stats.DaysPlayed = Math.Max(Game1.player.stats.DaysPlayed, 6);
                Game1.getLocationFromName("Mountain").DayUpdate(Game1.dayOfMonth);
                foreach (string key in Game1.content.Load<Dictionary<string, string>>("Data/Events/Mine").Keys)
                    Game1.player.eventsSeen.Add(key.Split('/')[0]);
                this.WorldComplete(); break;
            case "mine-probe":
                var spot = this.meetings[npc.Name].Spot;
                var probes = new List<object>();
                for (int y = spot.Y - 4; y <= spot.Y + 4; y++)
                    for (int x = spot.X - 4; x <= spot.X + 4; x++)
                    {
                        var path = PathFindController.findPath(npc.TilePoint, new Point(x, y), PathFindController.isAtEndPoint, npc.currentLocation, npc, 2000);
                        probes.Add(new { x, y, count = path?.Count, spawn = npc.currentLocation.CanSpawnCharacterHere(new Vector2(x, y)),
                            water = npc.currentLocation.isWaterTile(x, y), barrier = npc.currentLocation.doesTileHaveProperty(x, y, "NPCBarrier", "Back") });
                    }
                var go = npc.pathfindToNextScheduleLocation("mine-probe", npc.currentLocation.Name, npc.TilePoint.X, npc.TilePoint.Y, spot.Map, spot.X, spot.Y, 2, null, null);
                var back = npc.pathfindToNextScheduleLocation("mine-probe", spot.Map, spot.X, spot.Y, npc.currentLocation.Name, npc.TilePoint.X, npc.TilePoint.Y, 2, null, null);
                this.worldTestNative = new { source = npc.TilePoint, go = go.route?.Count, back = back.route?.Count, probes }; this.WorldComplete(); break;
            case "mine-topology":
                var door = MeetPlaces[this.mineTestPlace][0];
                var fromHome = npc.pathfindToNextScheduleLocation("mine-topology", npc.currentLocation.Name, npc.TilePoint.X, npc.TilePoint.Y, door.Map, door.X, door.Y, 2, null, null);
                var toHome = npc.pathfindToNextScheduleLocation("mine-topology", door.Map, door.X, door.Y, npc.currentLocation.Name, npc.TilePoint.X, npc.TilePoint.Y, 2, null, null);
                this.worldTestNative = new { map = npc.currentLocation.Name, x = npc.TilePoint.X, y = npc.TilePoint.Y, go = fromHome.route?.Count, back = toHome.route?.Count };
                this.WorldComplete(); break;
            case "mine-start":
                this.mineTestTravel.Clear();
                this.actionTestNpc = this.mineTestNpc;
                Meeting visit = this.meetings[npc.Name];
                this.actionTestSpeed = Number("speed", 2);
                this.actionTestClockRunning = Flag("natural");
                Game1.timeOfDay = this.actionTestClockRunning ? Utility.ModifyTime(visit.Depart, -10) : visit.Depart;
                Game1.gameTimeInterval = 0;
                if (!this.actionTestClockRunning) npc.checkSchedule(Game1.timeOfDay);
                this.WorldWait("mine-arrive"); break;
            case "mine-enter":
            case "mine-level":
                this.CloseSocialMenu();
                int floor = Number("floor");
                this.worldTestTarget = this.mineTestPlace == "矿洞" ? floor == 0 ? "Mine" : "UndergroundMine" + floor
                    : this.mineTestPlace == "骷髅洞穴" ? floor == 0 ? "SkullCave" : "UndergroundMine" + (floor + 120)
                    : floor == 10 ? "Caldera" : "VolcanoDungeon" + floor;
                Game1.player.health = Game1.player.maxHealth;
                if (floor > 0 && this.mineTestPlace != "火山") Game1.enterMine(this.mineTestPlace == "矿洞" ? floor : floor + 120);
                else Game1.warpFarmer(this.worldTestTarget, Number("x", this.mineTestPlace == "火山" ? 31 : 18), Number("y", this.mineTestPlace == "火山" ? 52 : 13), 2);
                this.WorldWait("mine-level"); break;
            case "mine-room": this.ClearMineTestRoom(); this.WorldComplete(); break;
            case "mine-collision":
                bool previous = npc.farmerPassesThrough;
                Vector2 position = Game1.player.Position;
                bool invincible = Game1.player.temporarilyInvincible;
                bool blocked, allowed;
                try
                {
                    // Vanilla ignores collision while invincible or already overlapping the NPC.
                    Game1.player.setTileLocation(npc.Tile + new Vector2(4, 0));
                    Game1.player.temporarilyInvincible = false;
                    Game1.player.TemporaryPassableTiles.Clear();
                    npc.farmerPassesThrough = false;
                    blocked = Game1.currentLocation.isCollidingPosition(npc.GetBoundingBox(), Game1.viewport, Game1.player);
                    npc.farmerPassesThrough = true;
                    allowed = Game1.currentLocation.isCollidingPosition(npc.GetBoundingBox(), Game1.viewport, Game1.player);
                }
                finally { npc.farmerPassesThrough = previous; Game1.player.Position = position; Game1.player.temporarilyInvincible = invincible; }
                this.worldTestNative = new { blocked, allowed }; this.WorldComplete(); break;
            case "mine-follow":
            case "mine-far":
                this.mineTestTravel.Clear();
                bool far = operation == "mine-far";
                Point origin = npc.TilePoint;
                Vector2? target = null;
                Stack<Point>? chosenPath = null;
                int size = Game1.currentLocation.map.Layers[0].LayerWidth;
                int height = Game1.currentLocation.map.Layers[0].LayerHeight;
                for (int y = 1; y < height - 1 && target is null; y++)
                    for (int x = 1; x < size - 1 && target is null; x++)
                    {
                        int distance = Math.Abs(x - origin.X) + Math.Abs(y - origin.Y);
                        if (distance < (far ? 15 : 6) || distance > (far ? 20 : 8) || !Game1.currentLocation.CanSpawnCharacterHere(new Vector2(x, y))) continue;
                        var path = PathFindController.findPath(origin, new Point(x, y), PathFindController.isAtEndPoint, Game1.currentLocation, npc, 1000);
                        if (far || path is { Count: >= 6 and <= 12 }) { target = new Vector2(x, y); chosenPath = path; }
                    }
                if (target is null) throw new InvalidOperationException("找不到跟随夹具的空格。");
                if (Flag("blocked") && chosenPath is { Count: >= 6 })
                {
                    Point middle = chosenPath.ToArray()[chosenPath.Count / 2];
                    this.mineTestObstacle = new Vector2(middle.X, middle.Y);
                    Game1.currentLocation.objects[this.mineTestObstacle.Value] = (StardewValley.Object)ItemRegistry.Create("(O)343");
                }
                Game1.player.setTileLocation(target.Value);
                this.WorldWait("mine-follow"); break;
            case "mine-combat":
                this.ClearMineTestRoom();
                this.mineTestKilledBefore = Game1.player.stats.MonstersKilled;
                this.mineTestGuildBefore = Game1.player.stats.getMonstersKilled("Green Slime");
                this.mineTestExperienceBefore = Game1.player.experiencePoints[4];
                for (int i = 0; i < Number("count", 1); i++)
                {
                    GreenSlime slime = new(npc.Position + new Vector2(Game1.tileSize, 0), 0)
                    { Health = 1, MaxHealth = 1, DamageToFarmer = 0 };
                    Game1.currentLocation.characters.Add(slime); this.mineTestMonsters.Add(slime);
                }
                this.WorldWait("mine-combat", 300); break;
            case "mine-damage":
                this.ClearMineTestRoom();
                this.mineTestPostDamage = Flag("post");
                this.WorldWait("mine-damage-ready"); break;
            case "mine-menu":
                if (Flag("target"))
                {
                    this.mineTestMonsters.Clear();
                    GreenSlime paused = new(npc.Position + new Vector2(Game1.tileSize, 0), 0) { Health = 250, MaxHealth = 250, DamageToFarmer = 0 };
                    Game1.currentLocation.characters.Add(paused); this.mineTestMonsters.Add(paused);
                }
                Game1.activeClickableMenu = new GameMenu(); this.WorldWait("mine-timed", Number("ticks", 120)); break;
            case "mine-inspect": this.WorldComplete(); break;
            case "mine-hud":
                this.worldTestNative = new { hud = Game1.hudMessages.Select(message => message.message).ToArray() };
                this.WorldComplete(); break;
            default: throw new InvalidOperationException("Unknown mine fixture command: " + operation);
        }
        return true;
    }

    private void TickMineTestPending()
    {
        if (!this.worldTestPending.StartsWith("mine-", StringComparison.Ordinal)) return;
        NPC npc = this.meetings.TryGetValue(this.mineTestNpc, out Meeting? tracked) && tracked.Trip.Actor is NPC actor
            ? actor : Game1.currentLocation?.getCharacterFromName(this.mineTestNpc) ?? this.SocialActor(this.mineTestNpc);
        this.mineTestTravel.Add(npc.TilePoint);
        if (this.worldTestPending == "mine-damage-ready" && !Game1.isWarping && !Game1.fadeToBlack && this.CanChat)
        {
            Game1.player.temporarilyInvincible = false; Game1.player.temporaryInvincibilityTimer = 0;
            if (!Game1.player.CanBeDamaged()) throw new InvalidOperationException("原版仍在保护玩家，不能证明致命伤拦截。");
            Game1.player.health = 1;
            GreenSlime damager = new(Game1.player.Position, 0) { Health = 1000000, MaxHealth = 1000000, DamageToFarmer = 10000 };
            damager.currentLocation = Game1.currentLocation!;
            if (this.mineTestPostDamage)
            {
                Game1.player.takeDamage(10000, overrideParry: true, damager);
                if (Game1.player.health > 0) throw new InvalidOperationException("原版伤害没有打空血量，不能把它算作救援通过。");
            }
            else Game1.currentLocation!.characters.Add(damager);
            this.WorldWait("mine-rescue");
        }
        else if (this.worldTestPending == "mine-arrive")
        {
            npc.speed = this.actionTestSpeed;
            if (this.meetings[npc.Name].Arrived && npc.controller is null)
            {
                npc.speed = 2; this.actionTestClockRunning = false; this.WorldComplete();
            }
        }
        else if (this.worldTestPending == "mine-level" && Game1.currentLocation?.NameOrUniqueName == this.worldTestTarget && !Game1.isWarping && this.CanChat)
            this.WorldComplete();
        else if (this.worldTestPending == "mine-follow" && Math.Abs(npc.TilePoint.X - Game1.player.TilePoint.X) + Math.Abs(npc.TilePoint.Y - Game1.player.TilePoint.Y) <= 2)
            this.WorldComplete();
        else if (this.worldTestPending == "mine-combat" && (this.mineTestMonsters.All(monster => monster.Health <= 0) || this.memoryTestTicks >= this.worldTestWait))
            this.WorldComplete();
        else if (this.worldTestPending == "mine-timed" && this.memoryTestTicks >= this.worldTestWait)
            this.WorldComplete();
        else if (this.worldTestPending == "mine-rescue")
        {
            if (Game1.killScreen) this.WorldComplete("原版死亡判定先于陪同救援。");
            else if (this.meetings[npc.Name].Trip is { Rescued: true, Rescuing: false } && !Game1.isWarping && Game1.player.health >= 10)
                this.WorldComplete();
        }
    }
}
