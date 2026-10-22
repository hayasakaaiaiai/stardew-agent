using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Pathfinding;

namespace StardewAgentBridge;

/// <summary>
/// NPCs keep yesterday's appointments with the player (docs/npc-meetings.md): two stops go into today's vanilla
/// schedule, there and back, so the game's own schedule pathing walks them across maps. When it is over, the backend
/// is told whether the player came, so the NPC remembers.
/// </summary>
internal sealed partial class ModEntry
{
    /// <summary>The same as the backend's MEET_MINUTES and its 22:00 limit (src/agent/meetings.ts).</summary>
    private const int MeetMinutes = 90;
    private const int MeetEnd = 2200;
    private const int MeetsPerDay = 3;
    /// <summary>Arrive this much before the agreed time.</summary>
    private const int MeetEarlyMinutes = 10;
    private const float MeetGreetRange = 6;

    /// <summary>
    /// Tiles vanilla schedules already stand NPCs on, so schedule pathing reaches them (docs/npc-meetings.md §4.1). A
    /// second NPC meeting at the same place takes the second tile.
    /// </summary>
    private static readonly Dictionary<string, (string Map, int X, int Y, int Facing)[]> MeetPlaces = new()
    {
        ["海滩"] = new[] { ("Beach", 30, 34, 2), ("Beach", 27, 34, 2) },
        ["镇广场"] = new[] { ("Town", 50, 68, 1), ("Town", 52, 61, 2) },
        ["墓地"] = new[] { ("Town", 47, 87, 0) },
        ["山上湖边"] = new[] { ("Mountain", 44, 18, 1), ("Mountain", 43, 17, 1) },
        ["森林河边"] = new[] { ("Forest", 66, 50, 2), ("Forest", 68, 50, 2) },
        ["博物馆"] = new[] { ("ArchaeologyHouse", 11, 9, 0), ("ArchaeologyHouse", 16, 9, 0) },
        ["星之果实餐吧"] = new[] { ("Saloon", 20, 19, 3), ("Saloon", 16, 20, 0) },
        ["杂货店"] = new[] { ("SeedShop", 13, 20, 0), ("SeedShop", 10, 20, 0) },
        // Worked out when needed: the schedule only reaches the bus stop by the farm gate (FarmVisits.cs).
        [FarmPlace] = Array.Empty<(string, int, int, int)>(),
        // Outside each dungeon's door (MineCompanion.cs); the desert one is where Abigail stands at the Desert Festival.
        ["矿洞"] = new[] { ("Mountain", 56, 6, 3), ("Mountain", 52, 7, 1) },
        ["骷髅洞穴"] = new[] { ("Desert", 8, 10, 0), ("Desert", 9, 10, 0) },
        ["火山"] = new[] { ("IslandNorth", 38, 26, 1), ("IslandNorth", 43, 26, 3) },
    };

    private sealed class Meeting
    {
        public Meeting(string npc, int time, string place)
        {
            this.Npc = npc;
            this.Time = time;
            this.Place = place;
            this.Leave = MeetingLeave(time);
        }

        /// <summary>The game name.</summary>
        public string Npc { get; }
        public int Time { get; }
        public string Place { get; }
        public int Leave { get; }
        public (string Map, int X, int Y, int Facing) Spot;
        /// <summary>When it sets off; before that its own schedule may already have it near the place.</summary>
        public int Depart;
        public bool Applied;
        public bool Failed;
        public bool Arrived;
        public bool Met;
        public bool Reported;
        public bool Farm => this.Place == FarmPlace;
        public bool Dungeon => DungeonExits.ContainsKey(this.Place);
        /// <summary>Lives on the farm already, so its schedule is left alone (FarmVisits.cs), or it is fetched (MineCompanion.cs).</summary>
        public bool Spouse;
        /// <summary>Close enough to do the farm chores.</summary>
        public bool Helps;
        public FarmHelp.Done? Helped;
        /// <summary>Goes into the dungeon with the player once they have met at the door (MineCompanion.cs).</summary>
        public bool Companion;
        /// <summary>Where the original schedule has the NPC when it leaves, i.e. where the way back goes.</summary>
        public ScheduleStop Back;
        public readonly Trip Trip = new();
        /// <summary>A farm visit: 0 on the way, 1 on the farm, 2 walking out, 3 gone.</summary>
        public int Stage;
        /// <summary>Which of the place's spots, counting others meeting there today.</summary>
        public int Slot;
        /// <summary>The vanilla object-breaking walk, switched off on the farm; null when not changed.</summary>
        public bool? Destroys;
        public ApproachController? Hold;
    }

    /// <summary>Where a schedule has an NPC at some time: the end of a route, with how it stands there.</summary>
    private readonly record struct ScheduleStop(string Map, Point Tile, int Facing, string? Behavior, string? Message);

    /// <summary>The end of the last route that sets off before (or at) a time; where the NPC is now if none has set off yet.</summary>
    private static ScheduleStop StopBefore(NPC npc, int time, bool inclusive)
    {
        SchedulePathDescription? last = npc.Schedule.Where(pair => inclusive ? pair.Key <= time : pair.Key < time)
            .OrderBy(pair => pair.Key).Select(pair => pair.Value).LastOrDefault();
        return last is null ? new(npc.currentLocation.NameOrUniqueName, npc.TilePoint, npc.FacingDirection, null, null)
            : new(last.targetLocationName, last.targetTile, last.facingDirection, last.endOfRouteBehavior, last.endOfRouteMessage);
    }

    /// <summary>Game name → today's appointment.</summary>
    private readonly Dictionary<string, Meeting> meetings = new(StringComparer.OrdinalIgnoreCase);

    private void ClearMeetings()
    {
        this.ReleaseFarmVisitors();
        this.ReleaseCompanions();
        this.meetings.Clear();
    }

    /// <summary>HHMM ninety minutes after the agreed time, at 22:00 at the latest.</summary>
    private static int MeetingLeave(int time) => Math.Min(Utility.ModifyTime(time, MeetMinutes), MeetEnd);

    /// <summary>When to set off so as to arrive early, never before the next ten-minute tick.</summary>
    private static int MeetingDeparture(int arrive, int travelMinutes, int now)
    {
        int depart = Utility.ConvertMinutesToTime(Utility.ConvertTimeToMinutes(arrive) - travelMinutes - MeetEarlyMinutes);
        return Math.Max(depart, Utility.ModifyTime(now - now % 10, 10));
    }

    /// <summary>
    /// A newer list replaces appointments not yet put into a schedule, e.g. after a late consolidation; ones already in
    /// a schedule stay until the day ends.
    /// </summary>
    private bool HandleMeetings(string type, JsonElement message)
    {
        if (type != "day.meetings")
            return false;
        if (!this.IsCurrentMessage(message) || !message.TryGetProperty("meetings", out JsonElement list) || list.ValueKind != JsonValueKind.Array)
            return true;
        foreach (string pending in this.meetings.Where(pair => !pair.Value.Applied).Select(pair => pair.Key).ToList())
            this.meetings.Remove(pending);
        foreach (JsonElement item in list.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("npc", out JsonElement id) || id.ValueKind != JsonValueKind.String
                || !item.TryGetProperty("time", out JsonElement time) || time.ValueKind != JsonValueKind.Number || !time.TryGetInt32(out int hhmm) || hhmm is < 600 or > 2200 || hhmm % 100 > 59
                || !item.TryGetProperty("place", out JsonElement place) || place.ValueKind != JsonValueKind.String || !MeetPlaces.ContainsKey(place.GetString()!))
                continue;
            string? name = SocialNpcs.FirstOrDefault(npc => npc.Equals(id.GetString(), StringComparison.OrdinalIgnoreCase));
            if (name is not null && !this.meetings.ContainsKey(name) && this.meetings.Count < MeetsPerDay)
                this.meetings[name] = new Meeting(name, hhmm, place.GetString()!);
        }
        return true;
    }

    /// <summary>Puts appointments into today's schedules, then watches them: arrival, the player coming, the end.</summary>
    private void TickMeetings()
    {
        if (!this.config.NpcMeetings || this.meetings.Count == 0 || !Context.IsWorldReady || !this.activeLoad || Game1.eventUp)
            return;
        foreach (Meeting m in this.meetings.Values)
        {
            if (!m.Applied && !m.Failed)
                this.ApplyMeeting(m);
            else if (m.Applied && !m.Reported)
                this.WatchMeeting(m);
        }
    }

    private void ApplyMeeting(Meeting m)
    {
        NPC? npc = Game1.getCharacterFromName(m.Npc);
        string relation = npc is null ? "stranger" : GameState.Relation(npc);
        bool spouse = relation is "married" or "roommate";
        string? why = npc is null || npc.IsInvisible ? "今天不在"
            : spouse && !m.Farm && !m.Dungeon ? "配偶和室友的日程不改"
            : !spouse && (npc.Schedule is null || npc.ignoreScheduleToday) ? "今天没有原版日程"
            : Utility.ModifyTime(Game1.timeOfDay, MeetEarlyMinutes) >= m.Time ? "收到时已经来不及"
            : null;
        int taken = this.meetings.Values.Count(other => other != m && other.Applied && other.Place == m.Place);
        if (why is null && !m.Farm && taken >= MeetPlaces[m.Place].Length)
            why = "这个地点的位置都有人约了";
        if (why is null)
        {
            m.Slot = taken;
            bool close = spouse || relation is "dating" or "engaged" || GameState.Hearts(npc!) >= FarmHelpHearts;
            m.Helps = m.Farm && close;
            m.Companion = m.Dungeon && close && this.config.NpcMineCompanion;
            m.Spouse = spouse;
            if (spouse && m.Dungeon)
            {
                // Spouses' days are vanilla's own; they are fetched from home unseen instead (MineCompanion.cs).
                m.Spot = MeetPlaces[m.Place][taken];
                m.Depart = MeetingDeparture(m.Time, SpouseHeadStartMinutes, Game1.timeOfDay);
            }
            else if (spouse)
                m.Depart = m.Time;
            else
            {
                try
                {
                    m.Spot = m.Farm ? ("BusStop", FarmGates().BusArrival.X, FarmGates().BusArrival.Y, 3) : MeetPlaces[m.Place][taken];
                    why = this.PlanMeeting(npc!, m);
                }
                catch (Exception ex) { why = "算不出路线：" + ex.Message; }
            }
        }
        if (why is not null)
        {
            m.Failed = true;
            this.Monitor.Log($"{m.Npc} 今天 {m.Time} 在{m.Place}的约定不去了：{why}", LogLevel.Info);
            return;
        }
        m.Applied = true;
    }

    /// <summary>
    /// Replaces the stops between setting off and leaving with two: to the place, and back to where the original schedule
    /// has the NPC at the end. Later stops were computed from there, so their routes still fit. Null when done.
    /// </summary>
    private string? PlanMeeting(NPC npc, Meeting m)
    {
        Dictionary<int, SchedulePathDescription> schedule = npc.Schedule;
        int now = Game1.timeOfDay;
        string key = npc.dayScheduleName.Value ?? "meeting";
        (string Map, int X, int Y, int Facing) spot = m.Spot;
        SchedulePathDescription Go(ScheduleStop from)
            => npc.pathfindToNextScheduleLocation(key, from.Map, from.Tile.X, from.Tile.Y, spot.Map, spot.X, spot.Y, spot.Facing, null, null);

        // Setting off earlier can mean setting off from an earlier stop; settle in at most two more rounds.
        int farmSteps = m.Farm ? FarmWalkSteps() : 0;
        ScheduleStop from = StopBefore(npc, m.Time, inclusive: false);
        SchedulePathDescription go = Go(from);
        int depart = MeetingDeparture(m.Time, TravelMinutes(go.route, farmSteps), now);
        for (int round = 0; round < 2 && StopBefore(npc, depart, inclusive: false) != from; round++)
        {
            from = StopBefore(npc, depart, inclusive: false);
            go = Go(from);
            depart = MeetingDeparture(m.Time, TravelMinutes(go.route, farmSteps), now);
        }
        if (StopBefore(npc, depart, inclusive: false) != from)
            return "出发的位置算不准";
        if (depart >= m.Leave)
            return "来不及在约定时间到";
        ScheduleStop back = StopBefore(npc, m.Leave, inclusive: true);
        SchedulePathDescription ret = npc.pathfindToNextScheduleLocation(key, spot.Map, spot.X, spot.Y, back.Map, back.Tile.X, back.Tile.Y,
            back.Facing, back.Behavior, back.Message);
        if (go.route is not { Count: > 0 } || ret.route is not { Count: > 0 })
            return "原版寻路找不到路";
        foreach (int replaced in schedule.Keys.Where(time => time >= depart && time <= m.Leave).ToList())
            schedule.Remove(replaced);
        go.time = depart;
        ret.time = m.Leave;
        m.Depart = depart;
        m.Back = back;
        schedule[depart] = go;
        schedule[m.Leave] = ret;
        this.Monitor.Log($"{m.Npc} 今天 {depart} 从{from.Map}出发，{m.Time} 前到{m.Place}（{spot.Map} {spot.X},{spot.Y}），{m.Leave} 回{back.Map}。", LogLevel.Info);
        return null;
    }

    /// <summary>The same estimate as vanilla's arrival-time schedules (NPC.parseMasterScheduleImpl): two pixels a tick.</summary>
    private static int TravelMinutes(Stack<Point>? route, int extraSteps = 0)
    {
        int steps = extraSteps;
        Point? previous = null;
        foreach (Point point in route ?? new Stack<Point>())
        {
            if (previous is { } p && Math.Abs(p.X - point.X) + Math.Abs(p.Y - point.Y) == 1)
                steps++;
            previous = point;
        }
        int ticksPerTenMinutes = Game1.realMilliSecondsPerGameTenMinutes / 1000 * 60;
        return (int)Math.Round(steps * 64 / 2f / ticksPerTenMinutes) * 10;
    }

    /// <summary>Whether this NPC is waiting at its appointment right now.</summary>
    private bool AtMeeting(NPC npc)
    {
        if (!this.meetings.TryGetValue(npc.Name, out Meeting? m) || !m.Applied || m.Reported)
            return false;
        if (m.Trip.Following)
            return true;
        if (Game1.timeOfDay < m.Depart || Game1.timeOfDay > m.Leave)
            return false;
        if (m.Farm)
            return m.Stage == 1 && (npc.currentLocation is Farm || (m.Spouse && npc.currentLocation is StardewValley.Locations.FarmHouse));
        if (npc.currentLocation?.Name != m.Spot.Map)
            return false;
        return Math.Abs(npc.TilePoint.X - m.Spot.X) + Math.Abs(npc.TilePoint.Y - m.Spot.Y) <= 2;
    }

    private void WatchMeeting(Meeting m)
    {
        if (Game1.getCharacterFromName(m.Npc) is not NPC npc)
            return;
        if (m.Farm)
        {
            this.WatchFarm(m, npc);
            return;
        }
        // Underground it is the player's company until they come out (MineCompanion.cs).
        if (m.Trip.Joined)
            return;
        if (m.Dungeon && m.Spouse)
        {
            this.WatchSpouseCompanion(m, npc);
            return;
        }
        if (!m.Arrived && npc.controller is null && !npc.isMoving() && this.AtMeeting(npc))
            m.Arrived = true;
        this.GreetAtMeeting(m, npc);
        if (Game1.timeOfDay >= m.Leave)
            this.ReportMeeting(m, m.Leave);
    }

    /// <summary>Once, when the player comes within a few tiles of the NPC waiting there.</summary>
    private void GreetAtMeeting(Meeting m, NPC npc)
    {
        if (!m.Arrived || m.Met || !this.AtMeeting(npc) || Game1.currentLocation != npc.currentLocation || !Context.IsPlayerFree
            || Vector2.Distance(npc.Tile, Game1.player.Tile) > MeetGreetRange)
            return;
        m.Met = true;
        npc.faceGeneralDirection(Game1.player.getStandingPosition());
        npc.doEmote(Character.happyEmote);
        npc.showTextAboveHead(VanillaDialogue.Escape(Game1.player.Name) + "！");
    }

    /// <summary>The chores this NPC did on the farm today, for its talk there.</summary>
    private Dictionary<string, object?>? MeetingHelped(NPC npc)
        => this.meetings.TryGetValue(npc.Name, out Meeting? m) && m.Helped is FarmHelp.Done done ? HelpedFields(done) : null;

    /// <summary>Talking to the NPC at the place counts as coming; the backend is told so the talk knows too.</summary>
    private bool MeetingTalk(NPC npc)
    {
        if (!this.AtMeeting(npc))
            return false;
        this.meetings[npc.Name].Met = true;
        return true;
    }

    /// <summary>When the day ends before the NPC leaves: report what happened so far, if the agreed time has come.</summary>
    private void EndMeetings()
    {
        foreach (Meeting m in this.meetings.Values.Where(m => m.Applied && !m.Reported && Game1.timeOfDay >= m.Time))
            this.ReportMeeting(m, m.Trip.Joined ? Game1.timeOfDay : Math.Min(Game1.timeOfDay, m.Leave));
    }

    /// <summary>Only an NPC that got there remembers waiting; one held up on the way says nothing.</summary>
    private void ReportMeeting(Meeting m, int left)
    {
        m.Reported = true;
        if (!m.Arrived)
        {
            this.Monitor.Log($"{m.Npc} 没走到{m.Place}，不记这次约定。", LogLevel.Info);
            return;
        }
        Dictionary<string, object?> fields = new()
        {
            ["npc"] = m.Npc, ["place"] = m.Place, ["time"] = m.Time, ["left"] = left, ["met"] = m.Met, ["date"] = GameState.Date(),
        };
        if (m.Helped is FarmHelp.Done done)
            fields["helped"] = HelpedFields(done);
        if (m.Trip.Joined)
            fields["mine"] = m.Trip.Fields(Fighters.Contains(m.Npc));
        this.Send("meet.ended", fields);
    }
}
