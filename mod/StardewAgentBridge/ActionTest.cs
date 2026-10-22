using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Pathfinding;

namespace StardewAgentBridge;

/// <summary>Opt-in World-test fixtures; movement itself always runs through the production/native controllers.</summary>
internal sealed partial class ModEntry
{
    private string actionTestNpc = "";
    private string actionTestMap = "";
    private Point actionTestTile;
    private int actionTestSpeed = 2;
    private bool actionTestClockRunning;

    private object ActionSnapshot() => new
    {
        approached = this.approached.ToArray(), this.lastApproachAt, clockRunning = this.actionTestClockRunning,
        eligible = new Dictionary<string, int>(this.approachHearts),
        approach = this.approach is not { } a ? null : new
        {
            npc = a.Npc.Name, phase = a.Phase.ToString(), a.Talked, a.Interrupted, a.WaitFrom,
            origin = new { x = a.OriginTile.X, y = a.OriginTile.Y, facing = a.Facing },
            path = a.Controller?.pathToEndPoint?.Count, hold = a.Controller?.Hold,
        },
        meetings = this.meetings.Values.Select(m => new
        {
            m.Npc, m.Time, m.Place, m.Leave, m.Depart, m.Applied, m.Failed, m.Arrived, m.Met, m.Reported,
            m.Stage, m.Helps, m.Spouse, m.Helped, m.Destroys,
            spot = new { map = m.Spot.Map, x = m.Spot.X, y = m.Spot.Y },
        }).ToArray(),
        routes = this.actionTestNpc.Length == 0 || Game1.getCharacterFromName(this.actionTestNpc) is not NPC npc ? null
            : npc.Schedule?.OrderBy(pair => pair.Key).Select(pair => new
            {
                time = pair.Key, map = pair.Value.targetLocationName, x = pair.Value.targetTile.X, y = pair.Value.targetTile.Y,
                facing = pair.Value.facingDirection, behavior = pair.Value.endOfRouteBehavior, steps = pair.Value.route?.Count,
            }).ToArray(),
    };

    private bool ActionCommand(string operation, JsonElement args)
    {
        if (!operation.StartsWith("action-", StringComparison.Ordinal)) return false;
        string Text(string key, string fallback = "") => args.TryGetProperty(key, out JsonElement value) ? value.GetString()! : fallback;
        int Number(string key, int fallback = 0) => args.TryGetProperty(key, out JsonElement value) ? value.GetInt32() : fallback;
        bool Flag(string key, bool fallback = false) => args.TryGetProperty(key, out JsonElement value) ? value.GetBoolean() : fallback;
        string id = Text("npc", "Abigail");
        switch (operation)
        {
            case "action-reset":
                this.CloseSocialMenu();
                if (this.approach is { } active) this.ReleaseApproach(active, restore: true);
                this.ClearApproach(); this.ClearMeetings(); this.ClearAmbient(); this.ClearScenes();
                this.config.NpcApproach = true; this.config.NpcMeetings = false; this.config.BackstageScenes = false;
                this.actionTestNpc = ""; this.actionTestClockRunning = false; this.WorldComplete(); break;
            case "action-place":
                this.actionTestNpc = id;
                NPC npc = this.SocialActor(id);
                this.TownPlace(id, Text("map", "Town"), Number("x", 50), Number("y", 68));
                npc.temporaryController = null; npc.queuedSchedulePaths.Clear();
                this.Helper.Reflection.GetField<int>(npc, "lastAttemptedSchedule").SetValue(-1);
                this.Helper.Reflection.GetField<bool>(npc, "freezeMotion").SetValue(false);
                npc.doingEndOfRouteAnimation.Value = false; npc.ignoreScheduleToday = Flag("ignore");
                npc.faceDirection(Number("facing", 2));
                Friendship friendship = new(Number("hearts", 8) * 250) { TalkedToToday = Flag("talked") };
                if (Text("relation").Length > 0)
                {
                    var status = friendship.GetType().GetProperty("Status")!;
                    status.SetValue(friendship, Enum.Parse(status.PropertyType, Text("relation")));
                }
                friendship.RoommateMarriage = Flag("roommate");
                Game1.player.friendshipData[id] = friendship;
                this.Helper.Reflection.GetProperty<Dictionary<int, SchedulePathDescription>>(npc, "Schedule").SetValue(new());
                if (!Flag("noSchedule"))
                {
                    string map = Text("map", "Town");
                    var route = npc.pathfindToNextScheduleLocation("action-test", map,
                        npc.TilePoint.X, npc.TilePoint.Y, map, Number("targetX", 47), Number("targetY", 87), 0, null, null);
                    route.time = Number("next", 2000); npc.Schedule[route.time] = route;
                }
                else this.Helper.Reflection.GetProperty<Dictionary<int, SchedulePathDescription>>(npc, "Schedule").SetValue(null!);
                if (Flag("busy")) npc.temporaryController = new ApproachController(new Stack<Point>(new[] { npc.TilePoint }), npc.currentLocation, npc, 2) { Hold = true };
                this.WorldComplete(); break;
            case "action-approach-list":
                this.HandleApproach("day.approach", JsonSerializer.SerializeToElement(new
                {
                    lineageId = this.lineageId, loadNonce = this.loadNonce, seq = 0, npcs = args.GetProperty("npcs"),
                })); this.WorldComplete(); break;
            case "action-approach-start":
                this.TryStartApproach(); this.WorldComplete(); break;
            case "action-approach-wait": this.WorldWait("action-waiting"); break;
            case "action-approach-return": this.WorldWait("action-returned"); break;
            case "action-route":
            case "action-flow-route":
            case "action-route-wait":
                this.actionTestNpc = id;
                this.actionTestSpeed = Math.Clamp(Number("speed", 2), 2, 8);
                NPC actor = this.SocialActor(id);
                var stop = actor.Schedule[Number("time")];
                this.actionTestMap = stop.targetLocationName; this.actionTestTile = stop.targetTile;
                if (operation == "action-route-wait") { this.WorldWait("action-route"); break; }
                actor.ignoreScheduleToday = false; actor.followSchedule = true;
                this.actionTestClockRunning = operation == "action-flow-route";
                Game1.timeOfDay = this.actionTestClockRunning ? Number("start", Utility.ModifyTime(Number("time"), -10)) : Number("time");
                Game1.gameTimeInterval = 0;
                if (!this.actionTestClockRunning) actor.checkSchedule(Game1.timeOfDay);
                this.WorldWait("action-route"); break;
            case "action-schedule-due":
                Game1.timeOfDay = Number("time"); this.SocialActor(id).checkSchedule(Game1.timeOfDay);
                this.WorldComplete(); break;
            case "action-meetings":
                this.actionTestNpc = id; this.config.NpcMeetings = Flag("enabled", true);
                this.HandleMeetings("day.meetings", JsonSerializer.SerializeToElement(new
                {
                    lineageId = this.lineageId, loadNonce = this.loadNonce, seq = 0, meetings = args.GetProperty("meetings"),
                })); this.TickMeetings(); this.WorldComplete(); break;
            case "action-observe": this.actionTestNpc = id; this.WorldComplete(); break;
            case "action-camera":
                Game1.forceSnapOnNextViewportUpdate = true;
                Game1.UpdateViewPort(true, Game1.player.StandingPixel);
                this.WorldWait("ticks", 30); break;
            case "action-vanilla-talk":
                this.CloseSocialMenu(); NPC speaker = this.SocialActor(id);
                Game1.drawDialogue(speaker); this.WorldWait("ticks", 60); break;
            case "action-close-menu": this.CloseSocialMenu(); this.WorldWait("action-menu-closed", 30); break;
            default: throw new InvalidOperationException("未知动作测试命令：" + operation);
        }
        return true;
    }

    private void TickActionTestPending()
    {
        this.TickMineTestPending();
        this.TickFarmTestPending();
        if (this.worldTestPending == "action-menu-closed")
        {
            // Closing vanilla dialogue can enqueue the normal "continue chatting" question on the next update.
            this.CloseSocialMenu();
            if (this.memoryTestTicks >= this.worldTestWait) this.WorldComplete();
        }
        if (this.worldTestPending == "action-waiting" && this.approach?.Phase == ApproachPhase.Waiting) this.WorldComplete();
        if (this.worldTestPending == "action-returned" && this.approach is null) this.WorldComplete();
        if (this.worldTestPending == "action-route")
        {
            NPC npc = this.SocialActor(this.actionTestNpc);
            npc.speed = this.actionTestSpeed;
            if (npc.currentLocation.NameOrUniqueName == this.actionTestMap && npc.controller is null && npc.temporaryController is null
                && npc.TilePoint == this.actionTestTile)
            {
                npc.speed = 2;
                this.actionTestClockRunning = false;
                this.WorldComplete();
            }
        }
    }

    private void TraceActionTest()
    {
        if (this.actionTestNpc.Length == 0 || this.memoryTestTicks % 60 != 0 || !Context.IsWorldReady) return;
        NPC npc = this.SocialActor(this.actionTestNpc);
        File.AppendAllText(Path.Combine(this.memoryTest!.RunDirectory, "actions-trajectory.jsonl"), JsonSerializer.Serialize(new
        {
            command = this.worldTestCommand, npc = npc.Name, time = Game1.timeOfDay, map = npc.currentLocation?.NameOrUniqueName,
            x = npc.TilePoint.X, y = npc.TilePoint.Y, controller = npc.controller is not null, temporary = npc.temporaryController is not null,
            speed = npc.speed,
        }) + "\n");
    }
}
