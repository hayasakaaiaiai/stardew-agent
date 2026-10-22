using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Pathfinding;

namespace StardewAgentBridge;

/// <summary>
/// Appointments on the farm (docs/npc-farm-help.md). Vanilla schedule pathing never routes through the farm
/// (WarpPathfindingCache.IgnoreLocationNames), so the schedule only takes the NPC to the bus stop by the farm gate; the
/// mod walks it in to the porch and, when it is time to go, back out to the same spot, where the schedule picks it up.
/// A close NPC does the chores on arrival. A spouse already lives here and only does the chores.
/// </summary>
internal sealed partial class ModEntry
{
    private const string FarmPlace = "农场";
    private const int FarmHelpHearts = 8;
    private const int FarmPathLimit = 5000;

    /// <summary>Where one comes out at the bus stop from the farm, and on the farm from the bus stop.</summary>
    private static (Point BusArrival, Point FarmEntry, Point FarmExit) FarmGates()
    {
        Farm farm = Game1.getFarm();
        GameLocation bus = Game1.getLocationFromName("BusStop");
        Point exit = farm.getWarpPointTo("BusStop");
        Point arrival = exit == Point.Zero ? Point.Zero : farm.getWarpPointTarget(exit);
        Point toFarm = bus.getWarpPointTo("Farm");
        Point entry = toFarm == Point.Zero ? Point.Zero : bus.getWarpPointTarget(toFarm);
        if (arrival == Point.Zero || entry == Point.Zero)
            throw new InvalidOperationException("找不到农场和巴士站之间的出入口");
        // Farmer warps land outside the NPCBarrier strip. NPCs must start and stop on its farm side.
        int width = farm.map.Layers[0].LayerWidth, height = farm.map.Layers[0].LayerHeight;
        Point InsideGate(Point tile)
        {
            Point inside = new(Math.Clamp(tile.X, 0, width - 1), Math.Clamp(tile.Y, 0, height - 1));
            Point inward = inside.X == 0 ? new Point(1, 0) : inside.X == width - 1 ? new Point(-1, 0)
                : inside.Y == 0 ? new Point(0, 1) : inside.Y == height - 1 ? new Point(0, -1) : Point.Zero;
            if (inward == Point.Zero) return inside;
            inside += inward;
            while (farm.doesTileHaveProperty(inside.X, inside.Y, "NPCBarrier", "Back") is not null)
            {
                inside += inward;
                if (inside.X < 0 || inside.Y < 0 || inside.X >= width || inside.Y >= height)
                    throw new InvalidOperationException("农场出入口的 NPC 障碍带没有内侧落点");
            }
            return inside;
        }
        return (arrival, InsideGate(entry), InsideGate(exit));
    }

    /// <summary>A reachable spot in front of the porch; the second visitor stands one tile further out.</summary>
    private static Point FarmStand(int slot) => FarmHelp.VisitorStand(Game1.getFarm()) + new Point(0, slot);

    /// <summary>Extra walking from the farm gate to the porch, counted in tiles like a schedule route.</summary>
    private static int FarmWalkSteps()
    {
        (_, Point entry, _) = FarmGates();
        Point stand = FarmStand(0);
        return Math.Abs(entry.X - stand.X) + Math.Abs(entry.Y - stand.Y);
    }

    private void WatchFarm(Meeting m, NPC npc)
    {
        Farm farm = Game1.getFarm();
        if (m.Spouse)
        {
            this.WatchSpouseHelp(m, npc, farm);
            return;
        }
        (Point arrival, Point entry, Point exit) = FarmGates();
        switch (m.Stage)
        {
            case 0:
                if (Game1.timeOfDay >= m.Depart && npc.currentLocation?.Name == "BusStop" && npc.controller is null && !npc.isMoving()
                    && Math.Abs(npc.TilePoint.X - arrival.X) + Math.Abs(npc.TilePoint.Y - arrival.Y) <= 1)
                    this.EnterFarm(m, npc, farm, entry);
                else if (Game1.timeOfDay >= m.Leave)
                    this.ReportMeeting(m, m.Leave);
                break;
            case 1:
                this.GreetAtMeeting(m, npc);
                if (Game1.timeOfDay >= m.Leave)
                    this.LeaveFarm(m, npc, farm, exit, arrival);
                break;
            case 2:
                if (npc.temporaryController != m.Hold || m.Hold!.pathToEndPoint is not { Count: > 0 } || m.Hold.pausedTimer > ApproachStuckMilliseconds
                    || Game1.currentLocation != farm)
                    this.WarpOut(m, npc, arrival);
                break;
        }
    }

    private void EnterFarm(Meeting m, NPC npc, Farm farm, Point entry)
    {
        // Vanilla NPCs walk through objects and break them; not the player's farm.
        m.Destroys = npc.willDestroyObjectsUnderfoot;
        npc.willDestroyObjectsUnderfoot = false;
        Game1.warpCharacter(npc, farm, Utility.PointToVector2(entry));
        Point stand = FarmStand(m.Slot);
        Stack<Point>? path = PathFindController.findPath(entry, stand, PathFindController.isAtEndPoint, farm, npc, FarmPathLimit);
        if (path is null)
        {
            npc.setTileLocation(Utility.PointToVector2(stand));
            path = new Stack<Point>(new[] { stand });
        }
        // Held there until it is time to go, so the schedule's way back waits in the queue.
        m.Hold = new ApproachController(path, farm, npc, 2) { Hold = true };
        npc.temporaryController = m.Hold;
        m.Stage = 1;
        m.Arrived = true;
        this.Monitor.Log($"{m.Npc} 到农场了（{path.Count - 1} 步走到门廊）。", LogLevel.Info);
        if (m.Helps)
            this.DoFarmChores(m, npc, farm);
    }

    private void LeaveFarm(Meeting m, NPC npc, Farm farm, Point exit, Point arrival)
    {
        // Seen leaving by the gate when the player is here; otherwise straight back to the bus stop.
        Stack<Point>? path = Game1.currentLocation == farm
            ? PathFindController.findPath(npc.TilePoint, exit, PathFindController.isAtEndPoint, farm, npc, FarmPathLimit) : null;
        if (path is null)
        {
            this.WarpOut(m, npc, arrival);
            return;
        }
        m.Hold = new ApproachController(path, farm, npc, -1) { Hold = true };
        npc.temporaryController = m.Hold;
        m.Stage = 2;
    }

    private void WarpOut(Meeting m, NPC npc, Point arrival)
    {
        if (npc.temporaryController == m.Hold)
            npc.temporaryController = null;
        npc.Halt();
        Game1.warpCharacter(npc, "BusStop", arrival);
        if (m.Destroys is bool destroys)
            npc.willDestroyObjectsUnderfoot = destroys;
        m.Destroys = null;
        m.Stage = 3;
        // The way back was computed from this very spot and has been waiting in the queue.
        ResumeSchedule(npc);
        this.ReportMeeting(m, m.Leave);
    }

    /// <summary>A spouse is already home: the chores at the agreed time, if it is on the farm or in the farmhouse then.</summary>
    private void WatchSpouseHelp(Meeting m, NPC npc, Farm farm)
    {
        if (m.Stage == 0 && Game1.timeOfDay >= m.Time)
        {
            if (npc.currentLocation is Farm or FarmHouse)
            {
                m.Stage = 1;
                m.Arrived = true;
                this.DoFarmChores(m, npc, farm);
            }
            else
            {
                m.Reported = true;
                this.Monitor.Log($"{m.Npc} 到点时不在农场，这次不帮忙。", LogLevel.Info);
                return;
            }
        }
        if (m.Stage != 1)
            return;
        this.GreetAtMeeting(m, npc);
        if (Game1.timeOfDay >= m.Leave)
            this.ReportMeeting(m, m.Leave);
    }

    private void DoFarmChores(Meeting m, NPC npc, Farm farm)
    {
        FarmHelp.Done done = FarmHelp.Run(farm);
        m.Helped = done;
        string summary = FarmHelpText(done);
        this.Monitor.Log($"{m.Npc} 帮忙干了农活：{summary}", LogLevel.Info);
        Game1.addHUDMessage(new HUDMessage($"{npc.displayName}来帮忙：{summary}", HUDMessage.newQuest_type));
    }

    /// <summary>The same wording as the backend's helpedText (src/agent/meetings.ts), for the game's own message.</summary>
    private static string FarmHelpText(FarmHelp.Done done)
    {
        List<string> parts = new();
        if (done.Watered > 0)
            parts.Add($"浇了 {done.Watered} 格水");
        if (done.Harvested > 0)
            parts.Add($"收了 {done.Harvested} 个作物放进农舍门口的箱子");
        if (done.Fed > 0)
            parts.Add($"给动物添了 {done.Fed} 份干草");
        if (done.Ponds > 0)
            parts.Add($"收了 {done.Ponds} 个鱼塘的产物放进箱子");
        return parts.Count > 0 ? string.Join("、", parts) : "农场里没什么要干的活";
    }

    private static Dictionary<string, object?> HelpedFields(FarmHelp.Done done) => new()
    {
        ["watered"] = done.Watered, ["harvested"] = done.Harvested, ["fed"] = done.Fed, ["ponds"] = done.Ponds,
    };

    /// <summary>A stop that came due while something held the NPC was only queued; set off now, as vanilla does.</summary>
    private static void ResumeSchedule(NPC npc)
    {
        if (npc.queuedSchedulePaths.Count == 0 || npc.controller is not null || npc.temporaryController is not null)
            return;
        npc.currentScheduleDelay = -1f;
        npc.checkSchedule(Game1.timeOfDay);
        npc.currentScheduleDelay = 0f;
    }

    /// <summary>Hands back a visitor the day ended on, and the object-breaking walk vanilla gives NPCs.</summary>
    private void ReleaseFarmVisitors()
    {
        foreach (Meeting m in this.meetings.Values)
        {
            if (m.Destroys is not bool destroys || Game1.getCharacterFromName(m.Npc) is not NPC npc)
                continue;
            if (npc.temporaryController == m.Hold)
                npc.temporaryController = null;
            npc.willDestroyObjectsUnderfoot = destroys;
            m.Destroys = null;
        }
    }
}
