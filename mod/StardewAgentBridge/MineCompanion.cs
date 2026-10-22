using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Monsters;
using StardewValley.Pathfinding;

namespace StardewAgentBridge;

/// <summary>
/// A close NPC met at a dungeon door goes in with the player (docs/npc-mine-companion.md): it follows them floor to floor,
/// fights beside them if it is the kind to, carries them out if they pass out, and stays until they come out or 22:00.
/// Then it walks back into its vanilla schedule from the door.
/// </summary>
internal sealed partial class ModEntry
{
    private const int CompanionEnd = 2200;
    private const int CompanionSpeed = 4;
    /// <summary>Close enough: within this many tiles it stops walking.</summary>
    private const int FollowNearTiles = 2;
    /// <summary>Further than this, or stuck for a while, it catches up at once.</summary>
    private const int FollowFarTiles = 12;
    private const int FollowPathLimit = 400;
    private const int FollowStuckTicks = 120;
    private const float FightReachTiles = 2;
    private const int FightEveryTicks = 60;
    /// <summary>Each hit takes this share of the monster's full health, so most fall in three or four.</summary>
    private const double FightShare = 0.3;
    /// <summary>What vanilla leaves the player with after passing out.</summary>
    private const int RescueHealth = 10;
    private const int ByeTicks = 90;
    /// <summary>How long before the agreed time a spouse sets off from home.</summary>
    private const int SpouseHeadStartMinutes = 30;

    /// <summary>
    /// Those who plausibly fight, with grounds in reference/wiki: Abigail practises with her sword and kills a monster in
    /// her fourteen-heart event; Sebastian sneaks into the caves and brings back bat wings and void essence; Kent served
    /// as a soldier. The rest follow without fighting.
    /// </summary>
    private static readonly HashSet<string> Fighters = new() { "Abigail", "Sebastian", "Kent" };

    /// <summary>Where the player comes out of each dungeon, so where the NPC is left when the trip ends.</summary>
    private static readonly Dictionary<string, (string Map, int X, int Y)> DungeonExits = new()
    {
        ["矿洞"] = ("Mountain", 54, 5),
        ["骷髅洞穴"] = ("Desert", 8, 6),
        ["火山"] = ("IslandNorth", 40, 24),
    };

    /// <summary>A trip with the player, kept on the appointment.</summary>
    private sealed class Trip
    {
        /// <summary>Went in with the player at least once; it is the player's company until it comes out.</summary>
        public bool Joined;
        public bool Following;
        public int Floor;
        public int Deepest;
        public int Kills;
        public bool Rescued;
        /// <summary>The player passed out; the warp out is under way.</summary>
        public bool Rescuing;
        /// <summary>Counting down to leaving at 22:00, after saying so.</summary>
        public int Bye;
        public int Stuck;
        /// <summary>A spouse goes home once out of sight.</summary>
        public bool HomeBound;
        public ApproachController? Hold;

        public Dictionary<string, object?> Fields(bool fights) => new()
        {
            ["floor"] = this.Floor, ["deepest"] = this.Deepest, ["kills"] = this.Kills, ["fights"] = fights, ["rescued"] = this.Rescued,
        };
    }

    /// <summary>Shown once the player is free after being carried out.</summary>
    private string? rescueMessage;

    /// <summary>
    /// The floor of a dungeon as the game shows it, from the location name: 0 at the entrance. Null when the location is
    /// not that dungeon (the quarry mine is level 77377, and is not part of any).
    /// </summary>
    internal static int? DungeonFloor(string place, string? location)
    {
        if (location is null)
            return null;
        int? Level(string prefix)
        {
            if (!location.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                return null;
            string digits = location[prefix.Length..].Split(':')[0];
            return int.TryParse(digits, out int level) && level >= 0 ? level : null;
        }
        int? mine = Level("UndergroundMine");
        return place switch
        {
            "矿洞" => location == "Mine" ? 0 : mine is >= 1 and <= 120 ? mine : null,
            "骷髅洞穴" => location == "SkullCave" ? 0 : mine is > 120 and not 77377 ? mine - 120 : null,
            "火山" => location == "Caldera" ? 10 : Level("VolcanoDungeon"),
            _ => null,
        };
    }

    private static bool InDungeon(string place, GameLocation? location) => DungeonFloor(place, location?.NameOrUniqueName) is not null;

    /// <summary>The trip so far, for a talk underground.</summary>
    private Dictionary<string, object?>? MeetingTrip(NPC npc)
        => this.meetings.TryGetValue(npc.Name, out Meeting? m) && m.Trip.Following ? m.Trip.Fields(Fighters.Contains(m.Npc)) : null;

    /// <summary>A spouse is fetched from home unseen and taken back the same way; it lives where vanilla walks it.</summary>
    private void WatchSpouseCompanion(Meeting m, NPC npc)
    {
        (string map, int x, int y, int facing) = m.Spot;
        if (!m.Arrived)
        {
            bool unseen = npc.currentLocation != Game1.currentLocation && Game1.currentLocation?.Name != map;
            if (Game1.timeOfDay >= m.Leave)
            {
                m.Reported = true;
                this.Monitor.Log($"{m.Npc} 一直没能出门，这次不去{m.Place}了。", LogLevel.Info);
            }
            else if (Game1.timeOfDay >= m.Depart && (unseen || Game1.timeOfDay >= m.Time))
            {
                npc.controller = null;
                npc.queuedSchedulePaths.Clear();
                Game1.warpCharacter(npc, map, new Vector2(x, y));
                npc.faceDirection(facing);
                this.HoldCompanion(m, npc, npc.currentLocation);
                m.Arrived = true;
                this.Monitor.Log($"{m.Npc} 从家里出发，到{m.Place}门口了。", LogLevel.Info);
            }
            return;
        }
        this.GreetAtMeeting(m, npc);
        if (Game1.timeOfDay >= m.Leave)
        {
            m.Trip.HomeBound = true;
            this.ReportMeeting(m, m.Leave);
        }
    }

    private void OnWarped(WarpedEventArgs e)
    {
        if (!e.IsLocalPlayer || !this.config.NpcMeetings)
            return;
        foreach (Meeting m in this.meetings.Values.Where(m => m.Dungeon && m.Applied && !m.Reported))
        {
            if (Game1.getCharacterFromName(m.Npc) is not NPC npc)
                continue;
            bool inside = InDungeon(m.Place, e.NewLocation);
            if (!m.Trip.Following)
            {
                // Through the door together: met there, still waiting there, and close enough to come along.
                if (m.Companion && m.Arrived && m.Met && inside && e.OldLocation?.Name == m.Spot.Map && npc.currentLocation == e.OldLocation
                    && Game1.timeOfDay < CompanionEnd && !InDungeon(m.Place, e.OldLocation))
                {
                    m.Trip.Joined = m.Trip.Following = true;
                    m.Destroys ??= npc.willDestroyObjectsUnderfoot;
                    npc.willDestroyObjectsUnderfoot = false;
                    this.Monitor.Log($"{m.Npc} 跟着玩家进了{m.Place}。", LogLevel.Info);
                    this.JoinPlayer(m, npc, e.NewLocation);
                }
            }
            else if (inside)
                this.JoinPlayer(m, npc, e.NewLocation);
            else
                // Out by the door, carried out, or gone some other way (a totem): it stays by the door then.
                this.EndCompanion(m, npc, beside: e.NewLocation.Name == m.Spot.Map);
        }
    }

    /// <summary>Next to the player on the floor they just reached.</summary>
    private void JoinPlayer(Meeting m, NPC npc, GameLocation location)
    {
        Vector2 tile = OpenTileNear(location, Game1.player.TilePoint) ?? Game1.player.Tile;
        npc.controller = null;
        Game1.warpCharacter(npc, location, tile);
        npc.Halt();
        npc.faceDirection(Game1.player.FacingDirection);
        this.HoldCompanion(m, npc, location);
        int floor = DungeonFloor(m.Place, location.NameOrUniqueName) ?? 0;
        m.Trip.Floor = floor;
        m.Trip.Deepest = Math.Max(m.Trip.Deepest, floor);
        m.Trip.Stuck = 0;
    }

    /// <summary>Kept by a held controller, so its schedule only queues meanwhile (as on the farm).</summary>
    private void HoldCompanion(Meeting m, NPC npc, GameLocation location)
    {
        m.Trip.Hold = new ApproachController(new Stack<Point>(new[] { npc.TilePoint }), location, npc, -1) { Hold = true };
        npc.temporaryController = m.Trip.Hold;
        npc.speed = CompanionSpeed;
    }

    /// <summary>The nearest tile around a point a character can stand on, never the point itself.</summary>
    private static Vector2? OpenTileNear(GameLocation location, Point around)
    {
        for (int radius = 1; radius <= 3; radius++)
        {
            for (int dy = -radius; dy <= radius; dy++)
            {
                for (int dx = -radius; dx <= radius; dx++)
                {
                    if (Math.Max(Math.Abs(dx), Math.Abs(dy)) != radius)
                        continue;
                    Vector2 tile = new(around.X + dx, around.Y + dy);
                    if (location.CanSpawnCharacterHere(tile) && !location.isWaterTile((int)tile.X, (int)tile.Y))
                        return tile;
                }
            }
        }
        return null;
    }

    /// <summary>Every tick: following, fighting, the rescue and leaving at 22:00; also a spouse going home.</summary>
    private void TickCompanions(UpdateTickedEventArgs e)
    {
        if (this.meetings.Count == 0 || !Context.IsWorldReady)
            return;
        if (this.rescueMessage is string message && Context.IsPlayerFree && !Game1.isWarping)
        {
            this.rescueMessage = null;
            Game1.drawObjectDialogue(message);
        }
        foreach (Meeting m in this.meetings.Values.ToList())
        {
            // At the door every tick, not every half second: a player walking straight in must still count as met.
            if (m.Dungeon && m.Companion && m.Arrived && !m.Met && !m.Reported && !m.Trip.Joined && Game1.currentLocation?.Name == m.Spot.Map
                && Game1.currentLocation.getCharacterFromName(m.Npc) is NPC waiting)
                this.GreetAtMeeting(m, waiting);
            if (!m.Trip.Following && !m.Trip.HomeBound)
                continue;
            if ((Game1.currentLocation?.getCharacterFromName(m.Npc) ?? Game1.getCharacterFromName(m.Npc)) is not NPC npc)
                continue;
            if (m.Trip.HomeBound)
            {
                this.SendSpouseHome(m, npc);
                continue;
            }
            Trip trip = m.Trip;
            // The player walks through it, as through anyone they push against long enough.
            npc.farmerPassesThrough = true;
            if (trip.Rescuing)
            {
                Game1.player.health = Math.Max(Game1.player.health, 1);
                continue;
            }
            if (Game1.player.health <= 0 && !Game1.killScreen && npc.currentLocation == Game1.currentLocation)
            {
                this.Rescue(m, npc);
                continue;
            }
            // Knocked out some way the rescue did not catch: vanilla's own rescue runs, and this trip is over.
            if (Game1.killScreen)
            {
                this.EndCompanion(m, npc, beside: false);
                continue;
            }
            if (Game1.eventUp || !Game1.shouldTimePass() || Game1.activeClickableMenu is not null || this.talk?.Npc == npc)
                continue;
            if (trip.Bye > 0)
            {
                if (--trip.Bye == 0)
                    this.EndCompanion(m, npc, beside: false);
                continue;
            }
            if (Game1.timeOfDay >= CompanionEnd)
            {
                npc.Halt();
                npc.faceGeneralDirection(Game1.player.getStandingPosition());
                npc.showTextAboveHead("太晚了，我先回去了。");
                trip.Bye = ByeTicks;
                continue;
            }
            if (npc.currentLocation != Game1.currentLocation)
            {
                if (Game1.currentLocation is GameLocation here && InDungeon(m.Place, here))
                    this.JoinPlayer(m, npc, here);
                continue;
            }
            if (trip.Hold is null || npc.temporaryController != trip.Hold)
                this.HoldCompanion(m, npc, npc.currentLocation);
            if (e.IsMultipleOf(15))
                this.FollowStep(m, npc);
            if (e.IsMultipleOf(FightEveryTicks) && Fighters.Contains(m.Npc))
                this.FightStep(m, npc);
        }
    }

    /// <summary>Walks to the player when they are a few tiles off; catches up at once when far behind or stuck.</summary>
    private void FollowStep(Meeting m, NPC npc)
    {
        Trip trip = m.Trip;
        GameLocation location = npc.currentLocation;
        Point player = Game1.player.TilePoint;
        int distance = Math.Abs(npc.TilePoint.X - player.X) + Math.Abs(npc.TilePoint.Y - player.Y);
        bool walking = trip.Hold!.pathToEndPoint is { Count: > 0 };
        if (distance <= FollowNearTiles)
        {
            if (walking && distance <= 1)
            {
                trip.Hold.pathToEndPoint!.Clear();
                npc.Halt();
            }
            if (!walking)
                npc.faceGeneralDirection(Game1.player.getStandingPosition());
            trip.Stuck = 0;
            return;
        }
        if (distance > FollowFarTiles || trip.Stuck >= FollowStuckTicks)
        {
            if (OpenTileNear(location, player) is Vector2 tile)
            {
                npc.Halt();
                npc.setTileLocation(tile);
                this.HoldCompanion(m, npc, location);
            }
            trip.Stuck = 0;
            return;
        }
        // Still on its way to where the player was a moment ago, and that is near enough.
        if (walking && Math.Abs(trip.Hold.endPoint.X - player.X) + Math.Abs(trip.Hold.endPoint.Y - player.Y) <= FollowNearTiles
            && trip.Hold.pausedTimer < 500)
            return;
        Stack<Point>? path = PathFindController.findPath(npc.TilePoint, player, NextToPlayer, location, npc, FollowPathLimit);
        if (path is null || path.Count < 2)
        {
            trip.Stuck += 15;
            return;
        }
        trip.Stuck = walking && trip.Hold.pausedTimer >= 500 ? trip.Stuck + 15 : 0;
        trip.Hold = new ApproachController(path, location, npc, -1) { Hold = true };
        npc.temporaryController = trip.Hold;
        npc.speed = CompanionSpeed;
    }

    /// <summary>
    /// Hits the nearest monster within reach, through vanilla's own damage path as the player's side: loot, quests,
    /// slayer goals and experience count as if the player had done it.
    /// </summary>
    private void FightStep(Meeting m, NPC npc)
    {
        GameLocation location = npc.currentLocation;
        Vector2 at = npc.getStandingPosition();
        Monster? target = location.characters.OfType<Monster>()
            .Where(monster => monster.Health > 0 && !monster.IsInvisible && !monster.isInvincible()
                && Vector2.Distance(monster.getStandingPosition(), at) <= FightReachTiles * Game1.tileSize)
            .OrderBy(monster => Vector2.Distance(monster.getStandingPosition(), at))
            .FirstOrDefault();
        if (target is null)
            return;
        npc.faceGeneralDirection(target.getStandingPosition());
        location.playSound("swordswipe");
        int damage = Math.Max(1, (int)Math.Ceiling(target.MaxHealth * FightShare));
        location.damageMonster(target.GetBoundingBox(), damage, damage + damage / 4, isBomb: false, knockBackModifier: 1f, addedPrecision: 0,
            critChance: 0f, critMultiplier: 1f, triggerMonsterInvincibleTimer: true, Game1.player, isProjectile: true);
        if (target.Health <= 0)
            m.Trip.Kills++;
    }

    /// <summary>
    /// Health hit zero this tick; vanilla would knock the player out next tick. Instead the NPC carries them out of the
    /// dungeon: nothing is lost, and they wake with what vanilla leaves.
    /// </summary>
    private void Rescue(Meeting m, NPC npc)
    {
        m.Trip.Rescuing = m.Trip.Rescued = true;
        Game1.player.health = 1;
        Game1.player.Halt();
        (string map, int x, int y) = DungeonExits[m.Place];
        this.Monitor.Log($"玩家在{m.Place}第 {m.Trip.Floor} 层晕倒，{m.Npc} 把玩家背出去。", LogLevel.Info);
        Game1.warpFarmer(map, x, y, 2);
    }

    /// <summary>
    /// The trip is over. The NPC is left by the door (next to the player if they came out there), then heads back into
    /// its schedule; a spouse goes home once out of sight.
    /// </summary>
    private void EndCompanion(Meeting m, NPC npc, bool beside)
    {
        Trip trip = m.Trip;
        trip.Following = false;
        trip.Bye = 0;
        (string map, int spotX, int spotY, int facing) = m.Spot;
        GameLocation outside = Game1.getLocationFromName(map);
        Vector2 tile = beside && Game1.currentLocation == outside ? OpenTileNear(outside, Game1.player.TilePoint) ?? new Vector2(spotX, spotY)
            : new Vector2(spotX, spotY);
        if (npc.temporaryController == trip.Hold)
            npc.temporaryController = null;
        trip.Hold = null;
        Game1.warpCharacter(npc, outside, tile);
        npc.Halt();
        npc.farmerPassesThrough = false;
        if (m.Destroys is bool destroys)
            npc.willDestroyObjectsUnderfoot = destroys;
        m.Destroys = null;
        if (beside)
        {
            npc.faceGeneralDirection(Game1.player.getStandingPosition());
            npc.doEmote(Character.happyEmote);
        }
        else
            npc.faceDirection(facing);
        if (trip.Rescuing)
        {
            trip.Rescuing = false;
            Game1.player.health = Math.Max(Game1.player.health, RescueHealth);
            this.rescueMessage = $"{npc.displayName}把你背出了{m.Place}。";
        }
        this.Monitor.Log($"{m.Npc} 陪玩家到{m.Place}第 {trip.Deepest} 层，打倒 {trip.Kills} 只怪物{(trip.Rescued ? "，把晕倒的玩家背了出来" : "")}。", LogLevel.Info);
        if (m.Spouse)
            trip.HomeBound = true;
        else
            this.RejoinSchedule(m, npc);
        this.ReportMeeting(m, Game1.timeOfDay);
    }

    /// <summary>
    /// From where it stands now to where the original schedule has it at this time, through vanilla's schedule pathing;
    /// the way back from the door at the end of the appointment is dropped, and so is anything queued underground.
    /// </summary>
    private void RejoinSchedule(Meeting m, NPC npc)
    {
        if (npc.Schedule is not { } schedule)
            return;
        int now = Game1.timeOfDay;
        ScheduleStop target = now < m.Leave ? m.Back : StopBefore(npc, now, inclusive: true);
        if (now < m.Leave)
            schedule.Remove(m.Leave);
        this.RouteTo(m, npc, target);
    }

    /// <summary>From where it stands to a stop of its schedule through vanilla's schedule pathing, setting off now.</summary>
    private void RouteTo(Meeting m, NPC npc, ScheduleStop target)
    {
        int now = Game1.timeOfDay;
        try
        {
            SchedulePathDescription route = npc.pathfindToNextScheduleLocation(npc.dayScheduleName.Value ?? "meeting", npc.currentLocation.NameOrUniqueName,
                npc.TilePoint.X, npc.TilePoint.Y, target.Map, target.Tile.X, target.Tile.Y, target.Facing, target.Behavior, target.Message);
            if (route.route is not { Count: > 0 })
                throw new InvalidOperationException("原版寻路找不到路");
            route.time = now;
            npc.controller = null;
            npc.queuedSchedulePaths.Clear();
            // This time's own stop is where the route goes; it must not set off again from somewhere else.
            npc.lastAttemptedSchedule = now;
            npc.queuedSchedulePaths.Add(route);
            ResumeSchedule(npc);
        }
        catch (Exception ex)
        {
            this.Monitor.Log($"{m.Npc} 回不到原日程（{ex.Message}），直接回到 {target.Map}。", LogLevel.Info);
            npc.queuedSchedulePaths.Clear();
            Game1.warpCharacter(npc, target.Map, Utility.PointToVector2(target.Tile));
            npc.faceDirection(target.Facing);
        }
    }

    /// <summary>Home to the farmhouse kitchen once the player cannot see it go; vanilla puts it to bed from there.</summary>
    private void SendSpouseHome(Meeting m, NPC npc)
    {
        if (npc.currentLocation == Game1.currentLocation)
            return;
        m.Trip.HomeBound = false;
        if (npc.temporaryController is not null)
            npc.temporaryController = null;
        npc.queuedSchedulePaths.Clear();
        FarmHouse home = Utility.getHomeOfFarmer(Game1.player);
        Game1.warpCharacter(npc, home, Utility.PointToVector2(home.getKitchenStandingSpot()));
        this.Monitor.Log($"{m.Npc} 回家了。", LogLevel.Info);
    }

    /// <summary>
    /// Before the day ends (and on a new day or load): none may stay in a dungeon level, which the game drops overnight
    /// with whoever is in it. What happened is reported with the rest of the day.
    /// </summary>
    private void ReleaseCompanions()
    {
        if (!Context.IsWorldReady)
            return;
        foreach (Meeting m in this.meetings.Values.Where(m => m.Trip.Following))
        {
            if (Game1.getCharacterFromName(m.Npc) is not NPC npc)
                continue;
            m.Trip.Following = false;
            if (npc.temporaryController == m.Trip.Hold)
                npc.temporaryController = null;
            m.Trip.Hold = null;
            npc.speed = 2;
            npc.farmerPassesThrough = false;
            if (m.Destroys is bool destroys)
                npc.willDestroyObjectsUnderfoot = destroys;
            m.Destroys = null;
            if (npc.currentLocation is MineShaft or VolcanoDungeon || InDungeon(m.Place, npc.currentLocation))
                Game1.warpCharacter(npc, m.Spot.Map, new Vector2(m.Spot.X, m.Spot.Y));
        }
    }
}
