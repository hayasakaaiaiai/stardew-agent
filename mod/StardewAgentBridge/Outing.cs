using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Pathfinding;
using StardewValley.Tools;

namespace StardewAgentBridge;

/// <summary>
/// Met somewhere ordinary, the NPC stays with the player until it leaves (docs/npc-outing.md): it follows them map to map
/// as a mine companion does, stands beside them when they stop or fish, and shows a vanilla emote at what they do. It
/// says nothing of its own; what it saw goes to the backend for the talk there and the memory afterwards.
/// </summary>
internal sealed partial class ModEntry
{
    /// <summary>The player standing still this long counts as stopping.</summary>
    private const int OutingStopTicks = 120;
    /// <summary>At most one emote this often, so a handful picked up in a row shows one.</summary>
    private const int OutingEmoteGapTicks = 180;
    private const int OutingPlaces = 6;
    private const int OutingFishNames = 3;
    /// <summary>Together this long, with this long still to go, it may suggest somewhere (docs/npc-meetings-more.md §4).</summary>
    private const int OutingSuggestAfterMinutes = 30;
    private const int OutingSuggestBeforeLeaveMinutes = 40;
    /// <summary>The player out of sight or far behind this long while it leads: it gives up and comes back.</summary>
    private const int OutingLeadWaitTicks = 600;
    private const float OutingLeadFarTiles = 15;

    /// <summary>What the NPC saw, and what it is watching for.</summary>
    private sealed class Outing
    {
        public bool Together;
        /// <summary>Places as the game shows them, in the order first visited.</summary>
        public readonly List<string> Places = new();
        public string Here = "";
        public int Fish;
        public readonly List<string> FishNames = new();
        public int Escaped;
        public int Treasures;
        public int Foraged;
        public int Artifacts;
        /// <summary>The player's own counts as last seen, so only what happens with the NPC there counts.</summary>
        public uint ForagedSeen;
        public int ArtifactsSeen;
        public BobberBar? Bar;
        public bool BarSettled;
        public Point PlayerTile;
        public int Still;
        public int EmoteAfter;
        /// <summary>An emote for a gift, once vanilla's own reply has closed.</summary>
        public int? GiftEmote;
        /// <summary>Counting down to leaving, after saying so.</summary>
        public int Bye;
        /// <summary>No way back by vanilla's pathing: it goes there directly once the player cannot see it go.</summary>
        public ScheduleStop? GoBack;
        /// <summary>When they met, for when to suggest somewhere; once suggested, never again this outing.</summary>
        public int Since;
        public bool Suggested;
        /// <summary>Where it is leading the player, by the maps on the way, and how long the player has not followed.</summary>
        public string? Leading;
        public (string Map, int X, int Y, int Facing) LeadSpot;
        public string[] LeadMaps = Array.Empty<string>();
        public int LeadAway;

        public bool Started => this.Places.Count > 0;

        public void Visit(string place)
        {
            this.Here = place;
            if (!this.Places.Contains(place) && this.Places.Count < OutingPlaces)
                this.Places.Add(place);
        }

        public Dictionary<string, object?> Fields() => new()
        {
            ["places"] = this.Places.ToArray(), ["here"] = this.Here, ["fish"] = this.Fish, ["fishNames"] = this.FishNames.ToArray(),
            ["escaped"] = this.Escaped, ["treasures"] = this.Treasures, ["foraged"] = this.Foraged, ["artifacts"] = this.Artifacts,
        };
    }

    /// <summary>
    /// Not where monsters are, which takes a trip arranged at a dungeon door, nor further into the bathhouse than its
    /// lobby, nor a festival's own map.
    /// </summary>
    internal static bool OutingGoes(string? location) => location is not null
        && !location.StartsWith("UndergroundMine", StringComparison.Ordinal) && !location.StartsWith("VolcanoDungeon", StringComparison.Ordinal)
        && location is not ("BugLand" or "BathHouse_MensLocker" or "BathHouse_WomensLocker" or "BathHouse_Pool" or "Temp");

    /// <summary>The two tiles at the player's sides, looking the way they look: left and right, or above and below.</summary>
    internal static Point[] BesideTiles(Point player, int facing) => facing is 0 or 2
        ? new[] { new Point(player.X - 1, player.Y), new Point(player.X + 1, player.Y) }
        : new[] { new Point(player.X, player.Y - 1), new Point(player.X, player.Y + 1) };

    private bool OnOuting(string name) => this.meetings.TryGetValue(name, out Meeting? m) && m.Out.Together;

    /// <summary>The outing so far, for a talk while together.</summary>
    private Dictionary<string, object?>? MeetingOuting(NPC npc)
        => this.meetings.TryGetValue(npc.Name, out Meeting? m) && m.Out.Together ? m.Out.Fields() : null;

    private static int ArtifactsFound() => Game1.player.archaeologyFound.Values.Sum(found => found.Length > 0 ? found[0] : 0);

    /// <summary>
    /// From meeting on, together until it leaves: the way back from the place is dropped and taken from wherever it is
    /// then, as when a mine trip ends.
    /// </summary>
    private void StartOuting(Meeting m, NPC npc)
    {
        Outing o = m.Out;
        o.Together = true;
        npc.Schedule?.Remove(m.ReturnAt);
        o.ForagedSeen = Game1.stats.ItemsForaged;
        o.ArtifactsSeen = ArtifactsFound();
        o.PlayerTile = Game1.player.TilePoint;
        o.Visit(GameState.PlaceName(npc.currentLocation.NameOrUniqueName));
        o.Since = Game1.timeOfDay;
        m.Destroys ??= npc.willDestroyObjectsUnderfoot;
        npc.willDestroyObjectsUnderfoot = false;
        this.HoldCompanion(m, npc, npc.currentLocation);
        this.Monitor.Log($"{m.Npc} 和玩家在{m.Place}碰上面了，跟着玩家到 {m.Leave}。", LogLevel.Info);
    }

    /// <summary>Next to the player on the map they just reached, as a mine companion is.</summary>
    private void JoinOuting(Meeting m, NPC npc, GameLocation location)
    {
        Vector2 tile = OpenTileNear(location, Game1.player.TilePoint) ?? Game1.player.Tile;
        npc.controller = null;
        Game1.warpCharacter(npc, location, tile);
        npc.Halt();
        npc.faceDirection(Game1.player.FacingDirection);
        this.HoldCompanion(m, npc, location);
        m.Trip.Stuck = 0;
        m.Out.Still = 0;
        m.Out.Visit(GameState.PlaceName(location.NameOrUniqueName));
        m.Out.Leading = null;
    }

    /// <summary>Through a door together; where it does not go, it stays and waits where it was.</summary>
    private void OutingWarped(WarpedEventArgs e)
    {
        foreach (Meeting m in this.meetings.Values.Where(m => m.Out.Together && !m.Reported && m.Out.Bye == 0))
        {
            if ((m.Trip.Actor ?? Game1.getCharacterFromName(m.Npc)) is not NPC npc || npc.currentLocation == e.NewLocation
                || !OutingGoes(e.NewLocation.NameOrUniqueName))
                continue;
            string? leading = m.Out.Leading;
            bool onTheWay = leading is not null && m.Out.LeadMaps.Contains(e.NewLocation.Name);
            this.JoinOuting(m, npc, e.NewLocation);
            // Ahead of it on the way: it comes along and leads on from there.
            if (onTheWay)
            {
                m.Out.Leading = leading;
                this.LeadOn(m, npc);
            }
        }
    }

    /// <summary>Every tick: what the player does, following or standing beside them, and leaving when the time comes.</summary>
    private void TickOutings(UpdateTickedEventArgs e)
    {
        if (this.meetings.Count == 0 || !Context.IsWorldReady)
            return;
        foreach (Meeting m in this.meetings.Values)
        {
            Outing o = m.Out;
            if (!o.Together && o.GoBack is null || (m.Trip.Actor ?? Game1.getCharacterFromName(m.Npc)) is not NPC npc)
                continue;
            bool near = npc.currentLocation == Game1.currentLocation;
            if (o.GoBack is ScheduleStop stop)
            {
                if (!near && !Game1.isWarping)
                {
                    o.GoBack = null;
                    Game1.warpCharacter(npc, stop.Map, Utility.PointToVector2(stop.Tile));
                    npc.faceDirection(stop.Facing);
                    this.Monitor.Log($"{m.Npc} 趁玩家看不见回到了 {stop.Map}。", LogLevel.Info);
                }
                continue;
            }
            this.WatchPlayer(m, npc, near);
            if (Game1.eventUp || !Game1.shouldTimePass() || Game1.isWarping || Game1.activeClickableMenu is not null || this.talk?.Npc == npc)
                continue;
            if (o.Bye > 0)
            {
                if (--o.Bye == 0)
                    this.EndOuting(m, npc);
                continue;
            }
            if (Game1.timeOfDay >= m.Leave)
            {
                this.OutingBye(m, npc, "我该回去了。");
                continue;
            }
            if (o.Leading is not null)
            {
                this.TickLead(m, npc, near);
                continue;
            }
            if (!near)
            {
                // Back from somewhere it does not go, and come out somewhere else.
                if (Game1.currentLocation is GameLocation here && OutingGoes(here.NameOrUniqueName))
                    this.JoinOuting(m, npc, here);
                continue;
            }
            npc.farmerPassesThrough = true;
            if (m.Trip.Hold is null || npc.temporaryController != m.Trip.Hold)
                this.HoldCompanion(m, npc, npc.currentLocation);
            if (!o.Suggested && e.IsMultipleOf(60) && Context.IsPlayerFree && !Fishing()
                && Utility.CalculateMinutesBetweenTimes(o.Since, Game1.timeOfDay) >= OutingSuggestAfterMinutes
                && Utility.CalculateMinutesBetweenTimes(Game1.timeOfDay, m.Leave) >= OutingSuggestBeforeLeaveMinutes)
            {
                o.Suggested = true;
                if (this.SuggestPlace(m, npc))
                    continue;
            }
            if (e.IsMultipleOf(15))
            {
                if (o.Still >= OutingStopTicks || Fishing())
                    this.StandBeside(m, npc);
                else
                    this.FollowStep(m, npc);
            }
        }
    }

    private static bool Fishing() => Game1.player.CurrentTool is FishingRod rod && rod.inUse();

    /// <summary>Somewhere it would go: not the farm, a dungeon door or a festival, and a shop only while open.</summary>
    internal static bool OpenNow(string place, int time, int dayOfMonth) => place switch
    {
        FarmPlace => false,
        "杂货店" => time >= 900 && time < 1700 && dayOfMonth % 7 != 3,
        "博物馆" => time >= 800 && time < 1800,
        "星之果实餐吧" => time >= 1200,
        _ => !DungeonExits.ContainsKey(place) && !FestivalPlaces.ContainsKey(place),
    };

    /// <summary>
    /// "要不要去山上湖边看看？", and off it goes (docs/npc-meetings-more.md §4): one of the ordinary places on another map,
    /// preferring where its own day would have taken it, chosen the same way for the same save, day and NPC.
    /// </summary>
    private bool SuggestPlace(Meeting m, NPC npc)
    {
        string here = npc.currentLocation.Name;
        string[] places = MeetPlaces.Keys.Where(place => MeetPlaces[place].Length > 0 && MeetPlaces[place][0].Map != here
            && OpenNow(place, Game1.timeOfDay, Game1.dayOfMonth)).ToArray();
        HashSet<string> hers = m.Original.Values.Select(stop => stop.targetLocationName).ToHashSet();
        string[] liked = places.Where(place => hers.Contains(MeetPlaces[place][0].Map)).ToArray();
        string? place = (liked.Length > 0 ? liked : places)
            .OrderBy(place => InviteMix(Game1.uniqueIDForThisGame ^ InviteMix((ulong)Game1.Date.TotalDays) ^ InviteName(m.Npc + place))).FirstOrDefault();
        if (place is null)
            return false;
        var spot = MeetPlaces[place][0];
        Outing o = m.Out;
        o.Leading = place;
        o.LeadSpot = spot;
        o.LeadMaps = WarpPathfindingCache.GetLocationRoute(here, spot.Map, npc.Gender) ?? new[] { here, spot.Map };
        o.LeadAway = 0;
        if (!this.LeadOn(m, npc))
            return false;
        npc.showTextAboveHead($"要不要去{place}看看？");
        this.Monitor.Log($"{m.Npc} 提议去{place}，带玩家过去。", LogLevel.Info);
        return true;
    }

    /// <summary>Off along vanilla's schedule pathing from where it stands; without a way there, it does not lead.</summary>
    private bool LeadOn(Meeting m, NPC npc)
    {
        Outing o = m.Out;
        var spot = o.LeadSpot;
        SchedulePathDescription? route = null;
        try
        {
            route = npc.pathfindToNextScheduleLocation(npc.dayScheduleName.Value ?? "meeting", npc.currentLocation.NameOrUniqueName, npc.TilePoint.X,
                npc.TilePoint.Y, spot.Map, spot.X, spot.Y, spot.Facing, null, null);
        }
        catch (Exception ex) { this.Monitor.Log($"{m.Npc} 找不到去{o.Leading}的路：{ex.Message}", LogLevel.Trace); }
        if (route?.route is not { Count: > 0 })
        {
            o.Leading = null;
            return false;
        }
        route.time = Game1.timeOfDay;
        if (npc.temporaryController == m.Trip.Hold)
            npc.temporaryController = null;
        m.Trip.Hold = null;
        npc.controller = null;
        npc.queuedSchedulePaths.Clear();
        npc.lastAttemptedSchedule = Game1.timeOfDay;
        npc.queuedSchedulePaths.Add(route);
        ResumeSchedule(npc);
        return true;
    }

    /// <summary>
    /// While it leads: there, it stops and goes on following; the player out of sight (and not on the way) or far
    /// behind for ten seconds, it gives up and comes back to them as when following.
    /// </summary>
    private void TickLead(Meeting m, NPC npc, bool near)
    {
        Outing o = m.Out;
        var spot = o.LeadSpot;
        bool walking = npc.controller is not null || npc.queuedSchedulePaths.Count > 0 || npc.isMoving();
        if (npc.currentLocation.Name == spot.Map && Math.Abs(npc.TilePoint.X - spot.X) + Math.Abs(npc.TilePoint.Y - spot.Y) <= 1 && !walking)
        {
            o.Leading = null;
            o.Visit(GameState.PlaceName(spot.Map));
            this.HoldCompanion(m, npc, npc.currentLocation);
            this.Monitor.Log($"{m.Npc} 带玩家到了{GameState.PlaceName(spot.Map)}。", LogLevel.Info);
            return;
        }
        bool following = near && Vector2.Distance(npc.Tile, Game1.player.Tile) <= OutingLeadFarTiles
            || !near && o.LeadMaps.Contains(Game1.currentLocation?.Name) && o.LeadAway < OutingLeadWaitTicks;
        o.LeadAway = near && following ? 0 : o.LeadAway + 1;
        if (o.LeadAway < OutingLeadWaitTicks && walking)
            return;
        o.Leading = null;
        npc.controller = null;
        npc.queuedSchedulePaths.Clear();
        this.Monitor.Log($"{m.Npc} 没等到玩家跟上，不去{o.LeadSpot.Map}了。", LogLevel.Info);
    }

    /// <summary>
    /// Counts what the player does while the NPC is there to see it, with an emote: a fish caught (an exclamation for a
    /// treasure, a legendary fish or a perfect catch), one that got away, forage picked up, an artifact dug up.
    /// </summary>
    private void WatchPlayer(Meeting m, NPC npc, bool near)
    {
        Outing o = m.Out;
        Point tile = Game1.player.TilePoint;
        o.Still = tile == o.PlayerTile && !Game1.player.isMoving() ? o.Still + 1 : 0;
        o.PlayerTile = tile;
        // The minigame knows how it went once it starts to fade out.
        if (Game1.activeClickableMenu is BobberBar bar)
        {
            if (bar != o.Bar)
            {
                o.Bar = bar;
                o.BarSettled = false;
            }
            if (!o.BarSettled && bar.fadeOut && (bar.distanceFromCatching >= 1f || bar.distanceFromCatching <= 0f))
            {
                o.BarSettled = true;
                if (near && bar.distanceFromCatching >= 1f)
                {
                    o.Fish++;
                    string name = ItemRegistry.GetDataOrErrorItem(bar.whichFish).DisplayName;
                    if (!o.FishNames.Contains(name) && o.FishNames.Count < OutingFishNames)
                        o.FishNames.Add(name);
                    if (bar.treasureCaught)
                        o.Treasures++;
                    OutingEmote(o, npc, bar.treasureCaught || bar.bossFish || bar.perfect ? Character.exclamationEmote : Character.happyEmote);
                }
                else if (near)
                {
                    o.Escaped++;
                    OutingEmote(o, npc, Character.sadEmote);
                }
            }
        }
        uint foraged = Game1.stats.ItemsForaged;
        if (near && foraged > o.ForagedSeen)
        {
            o.Foraged += (int)(foraged - o.ForagedSeen);
            OutingEmote(o, npc, Character.happyEmote);
        }
        o.ForagedSeen = foraged;
        int artifacts = ArtifactsFound();
        if (near && artifacts > o.ArtifactsSeen)
        {
            o.Artifacts += artifacts - o.ArtifactsSeen;
            OutingEmote(o, npc, Character.exclamationEmote);
        }
        o.ArtifactsSeen = artifacts;
        if (o.GiftEmote is int gift && near && Context.IsPlayerFree && Game1.activeClickableMenu is null && Game1.ticks >= o.EmoteAfter)
        {
            o.GiftEmote = null;
            OutingEmote(o, npc, gift);
        }
    }

    private static void OutingEmote(Outing o, NPC npc, int emote)
    {
        if (Game1.ticks < o.EmoteAfter)
            return;
        o.EmoteAfter = Game1.ticks + OutingEmoteGapTicks;
        npc.doEmote(emote);
    }

    /// <summary>After vanilla's reply to a gift: a heart for one it loves or likes, a sigh for one it dislikes or hates.</summary>
    private void OutingGift(NPC npc, string taste)
    {
        if (this.meetings.TryGetValue(npc.Name, out Meeting? m) && m.Out.Together)
            m.Out.GiftEmote = taste switch { "love" or "like" => Character.heartEmote, "dislike" or "hate" => Character.sadEmote, _ => null };
    }

    /// <summary>
    /// The player has stopped, or is fishing: to whichever side of them is nearer and free, looking the way they look.
    /// With no room at either side it keeps close as it would anyway.
    /// </summary>
    private void StandBeside(Meeting m, NPC npc)
    {
        Trip trip = m.Trip;
        GameLocation location = npc.currentLocation;
        int facing = Game1.player.FacingDirection;
        Point beside = BesideTiles(Game1.player.TilePoint, facing)
            .Where(tile => tile == npc.TilePoint || location.CanSpawnCharacterHere(Utility.PointToVector2(tile)) && !location.isWaterTile(tile.X, tile.Y))
            .OrderBy(tile => Math.Abs(tile.X - npc.TilePoint.X) + Math.Abs(tile.Y - npc.TilePoint.Y))
            .DefaultIfEmpty(new Point(-1, -1))
            .First();
        if (beside.X < 0)
        {
            this.FollowStep(m, npc);
            return;
        }
        bool walking = trip.Hold!.pathToEndPoint is { Count: > 0 };
        if (npc.TilePoint == beside && !walking)
        {
            npc.faceDirection(facing);
            trip.Stuck = 0;
            return;
        }
        if (walking && trip.Hold.endPoint == beside && trip.Hold.pausedTimer < 500)
            return;
        Stack<Point>? path = PathFindController.findPath(npc.TilePoint, beside, PathFindController.isAtEndPoint, location, npc, FollowPathLimit);
        if (path is null || path.Count < 2)
        {
            this.FollowStep(m, npc);
            return;
        }
        trip.Hold = new ApproachController(path, location, npc, facing) { Hold = true };
        npc.temporaryController = trip.Hold;
        npc.speed = CompanionSpeed;
    }

    /// <summary>A word where the player can see it, then off; out of sight it simply goes.</summary>
    private void OutingBye(Meeting m, NPC npc, string word)
    {
        // Wherever it was leading, it stops for the goodbye.
        if (m.Out.Leading is not null)
        {
            m.Out.Leading = null;
            npc.controller = null;
            npc.queuedSchedulePaths.Clear();
        }
        if (npc.currentLocation != Game1.currentLocation)
        {
            this.EndOuting(m, npc);
            return;
        }
        npc.Halt();
        npc.faceGeneralDirection(Game1.player.getStandingPosition());
        npc.showTextAboveHead(word);
        m.Out.Bye = ByeTicks;
    }

    /// <summary>Let go, back into its schedule from where it is (put back as it was if called off), and reported.</summary>
    private void EndOuting(Meeting m, NPC npc)
    {
        this.ReleaseOuting(m, npc);
        this.Monitor.Log($"{m.Npc} 和玩家一起去过{string.Join("、", m.Out.Places)}，看玩家钓到 {m.Out.Fish} 条鱼、跑了 {m.Out.Escaped} 条，"
            + $"捡了 {m.Out.Foraged} 个采集物，挖到 {m.Out.Artifacts} 件古物。", LogLevel.Info);
        this.RejoinSchedule(m, npc, warpInSight: false);
        this.ReportMeeting(m, Math.Min(Game1.timeOfDay, m.Leave));
    }

    private void ReleaseOuting(Meeting m, NPC npc)
    {
        m.Out.Together = false;
        m.Out.Bye = 0;
        if (npc.temporaryController == m.Trip.Hold)
            npc.temporaryController = null;
        m.Trip.Hold = null;
        npc.speed = 2;
        npc.farmerPassesThrough = false;
        if (m.Destroys is bool destroys)
            npc.willDestroyObjectsUnderfoot = destroys;
        m.Destroys = null;
    }

    /// <summary>Before the day ends (and on a new day or load): let go of whoever is still together; the game places them anew.</summary>
    private void ReleaseOutings()
    {
        if (!Context.IsWorldReady)
            return;
        foreach (Meeting m in this.meetings.Values.Where(m => m.Out.Together))
        {
            if ((m.Trip.Actor ?? Game1.getCharacterFromName(m.Npc)) is NPC npc)
                this.ReleaseOuting(m, npc);
        }
    }
}
