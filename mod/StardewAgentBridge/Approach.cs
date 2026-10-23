using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Menus;
using StardewValley.Pathfinding;

namespace StardewAgentBridge;

/// <summary>
/// An NPC that decided last night to find the player walks over once when it sees them, waits a little, and walks back
/// to where it stood (docs/npc-approach.md). Nothing goes to the backend: what it has to say comes with "继续聊".
/// </summary>
internal sealed partial class ModEntry
{
    private const float ApproachRange = 8;
    private const int ApproachMaxSteps = 16;
    private const int ApproachPathLimit = 600;
    private const int ApproachesPerDay = 3;
    private const int ApproachGapMinutes = 60;
    private const int ApproachLeadMinutes = 90;
    private const int ApproachHeadBackMinutes = 20;
    private const int ApproachWaitMinutes = 30;
    private const float ApproachLeaveRange = 6;
    private const int ApproachLatestTime = 2000;
    private const int ApproachStuckMilliseconds = 3000;

    /// <summary>NPC id from the backend (lower case) → the fewest hearts it needs, so the opening can bring its plan up.</summary>
    private readonly Dictionary<string, int> approachHearts = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> approached = new(StringComparer.OrdinalIgnoreCase);
    private int lastApproachAt = -1;
    private Approach? approach;

    private enum ApproachPhase { Walking, Waiting, Returning }

    private sealed class Approach
    {
        public Approach(NPC npc, GameLocation location)
        {
            this.Npc = npc;
            this.Location = location;
            this.Origin = npc.Position;
            this.OriginTile = npc.TilePoint;
            this.Facing = npc.FacingDirection;
            this.Destroys = npc.willDestroyObjectsUnderfoot;
        }

        public NPC Npc { get; }
        public GameLocation Location { get; }
        public Vector2 Origin { get; }
        public Point OriginTile { get; }
        public int Facing { get; }
        /// <summary>The vanilla object-breaking walk, switched off meanwhile.</summary>
        public bool Destroys { get; }
        public ApproachPhase Phase;
        public ApproachController? Controller;
        public int WaitFrom;
        public bool Talked;
        public bool Interrupted;
    }

    /// <summary>
    /// Walks a found path, then keeps the NPC until released. While an NPC's temporaryController is set, vanilla only
    /// queues its schedule (NPC.checkSchedule), so it never sets off along a route computed from where it used to stand.
    /// </summary>
    private sealed class ApproachController : PathFindController
    {
        public ApproachController(Stack<Point> path, GameLocation location, NPC npc, int facing) : base(path, location, npc, path.Last())
        {
            this.finalFacingDirection = facing;
        }

        public bool Hold;

        public override bool update(GameTime time) => base.update(time) && !this.Hold;
    }

    private bool Approaching(string name) => this.approach?.Npc.Name.Equals(name, StringComparison.OrdinalIgnoreCase) == true;

    /// <summary>Never puts an NPC back: on a new day or load the game has already placed everyone anew.</summary>
    private void ClearApproach()
    {
        if (this.approach is { } a)
            this.ReleaseApproach(a, restore: false);
        this.approachHearts.Clear();
        this.approached.Clear();
        this.lastApproachAt = -1;
    }

    /// <summary>A newer list replaces the old one, e.g. after a late consolidation; whoever already came stays counted.</summary>
    private bool HandleApproach(string type, JsonElement message)
    {
        if (type != "day.approach")
            return false;
        if (!this.IsCurrentMessage(message) || !message.TryGetProperty("npcs", out JsonElement npcs) || npcs.ValueKind != JsonValueKind.Object)
            return true;
        this.approachHearts.Clear();
        foreach (JsonProperty npc in npcs.EnumerateObject())
        {
            if (npc.Value.ValueKind == JsonValueKind.Number && npc.Value.TryGetInt32(out int hearts) && hearts is >= 0 and <= 14)
                this.approachHearts[npc.Name] = hearts;
        }
        return true;
    }

    private void TickApproach(UpdateTickedEventArgs e)
    {
        if (this.approach is { } a)
            this.UpdateApproach(a, e);
        // The scripted tests place NPCs on purpose; walking over would move them.
        else if (e.IsMultipleOf(30) && this.memoryTest is null && this.abigailTestRequest is null)
            this.TryStartApproach();
    }

    private void TryStartApproach()
    {
        if (!this.config.NpcApproach || this.approachHearts.Count == 0 && this.TodayInviter() is null || this.approached.Count >= ApproachesPerDay || !this.CanChat
            || !Context.IsPlayerFree || Game1.eventUp || Game1.isFestival() || this.talk is not null || Game1.timeOfDay >= ApproachLatestTime
            || Game1.currentLocation is not GameLocation location || !ApproachAllowedIn(location))
            return;
        if (this.lastApproachAt >= 0 && Utility.CalculateMinutesBetweenTimes(this.lastApproachAt, Game1.timeOfDay) < ApproachGapMinutes)
            return;
        Vector2 player = Game1.player.Tile;
        NPC? npc = location.characters
            .Where(c => Vector2.Distance(c.Tile, player) <= ApproachRange && this.CanApproach(c))
            .OrderBy(c => Vector2.Distance(c.Tile, player))
            .FirstOrDefault();
        if (npc is not null)
            this.StartApproach(npc, location);
    }

    /// <summary>Vanilla has its own walking for spouses on the farm, the theater and the island resort.</summary>
    private static bool ApproachAllowedIn(GameLocation location)
        => location is not (Farm or FarmHouse or MovieTheater) && !location.IsGreenhouse && !location.InIslandContext();

    private bool CanApproach(NPC npc)
    {
        // One asking the player out today comes over too, at the hearts it was chosen by (Invites.cs).
        int hearts = this.approachHearts.TryGetValue(npc.Name, out int needed) ? needed : this.InvitesToday(npc) ? InviteHearts : -1;
        if (hearts < 0 || this.approached.Contains(npc.Name) || !SocialNpcs.Contains(npc.Name)
            || npc.IsInvisible || npc.isSleeping.Value || npc.ignoreScheduleToday || ColdShoulder(npc.Name) || this.sceneParticipants.Contains(npc.Name))
            return false;
        string relation = GameState.Relation(npc);
        if (relation is "married" or "roommate" || (GameState.Hearts(npc) < hearts && relation is not ("dating" or "engaged")))
            return false;
        // Having talked today, it has already said what it came to say.
        if (Game1.player.friendshipData.TryGetValue(npc.Name, out Friendship? friendship) && friendship.TalkedToToday)
            return false;
        // Standing at a stop with nothing to do: not on its way, not in an end-of-route animation, not pacing about.
        return npc.controller is null && npc.temporaryController is null && !npc.isMoving() && !npc.doingEndOfRouteAnimation.Value
            && !npc.IsWalkingInSquare && !npc.IsReturningToEndPoint() && MinutesToNextStop(npc) >= ApproachLeadMinutes;
    }

    private static int MinutesToNextStop(NPC npc)
    {
        if (npc.queuedSchedulePaths.Count > 0)
            return 0;
        if (npc.Schedule is null)
            return int.MaxValue;
        int next = npc.Schedule.Keys.Where(time => time > Game1.timeOfDay).DefaultIfEmpty(-1).Min();
        return next < 0 ? int.MaxValue : Utility.CalculateMinutesBetweenTimes(Game1.timeOfDay, next);
    }

    private static bool NextToPlayer(PathNode node, Point player, GameLocation location, Character c)
        => Math.Abs(node.x - player.X) + Math.Abs(node.y - player.Y) == 1;

    private void StartApproach(NPC npc, GameLocation location)
    {
        Approach a = new(npc, location);
        // Vanilla NPCs walk through objects and break them; only on their own routes, not on the way to the player.
        npc.willDestroyObjectsUnderfoot = false;
        Stack<Point>? path = PathFindController.findPath(npc.TilePoint, Game1.player.TilePoint, NextToPlayer, location, npc, ApproachPathLimit);
        // Behind a counter or too far round: call out from where it stands.
        if (path is null || path.Count - 1 > ApproachMaxSteps)
            path = new Stack<Point>(new[] { npc.TilePoint });
        npc.Halt();
        a.Controller = new ApproachController(path, location, npc, -1) { Hold = true };
        npc.temporaryController = a.Controller;
        npc.faceGeneralDirection(Game1.player.getStandingPosition());
        npc.doEmote(Character.exclamationEmote);
        npc.showTextAboveHead(VanillaDialogue.Escape(Game1.player.Name) + "！");
        this.approached.Add(npc.Name);
        this.lastApproachAt = Game1.timeOfDay;
        this.approach = a;
        this.Monitor.Log($"{npc.Name} 有事找玩家，走过来（{path.Count - 1} 步）。", LogLevel.Trace);
    }

    private void UpdateApproach(Approach a, UpdateTickedEventArgs e)
    {
        NPC npc = a.Npc;
        if (!Context.IsWorldReady || npc.currentLocation != a.Location)
        {
            this.ReleaseApproach(a, restore: false); // Unloaded, or the game moved it elsewhere: it is the game's again.
            return;
        }
        // The player left the map: put it back unseen.
        if (Game1.currentLocation != a.Location)
        {
            this.ReleaseApproach(a, restore: true);
            return;
        }
        // An event may move this very NPC, which a held controller would stop; let go now and put it back afterwards.
        if (Game1.eventUp)
        {
            if (npc.temporaryController == a.Controller)
                npc.temporaryController = null;
            a.Interrupted = true;
            return;
        }
        // Vanilla clears the controller on the way back when it arrives, stays stuck for five seconds, or is put at the end
        // unseen; at any other time someone else took the NPC over.
        if (a.Interrupted || npc.temporaryController != a.Controller)
        {
            this.ReleaseApproach(a, restore: a.Interrupted || a.Phase == ApproachPhase.Returning);
            return;
        }
        bool spoken = (Game1.activeClickableMenu is DialogueBox box && box.characterDialogue?.speaker == npc)
            || this.talk?.Npc == npc || this.offerFor == npc || this.startFor == npc;
        bool busy = Game1.activeClickableMenu is not null || Game1.dialogueUp || this.talk is not null || this.offerFor is not null || this.startFor is not null;
        if (spoken)
            a.Talked = true;
        switch (a.Phase)
        {
            case ApproachPhase.Walking:
            case ApproachPhase.Returning:
                // Stop where it is to talk, also on the way back, and head back once the talk is over.
                if (spoken || a.Controller!.pathToEndPoint is not { Count: > 0 } || (a.Phase == ApproachPhase.Walking && a.Controller.pausedTimer > ApproachStuckMilliseconds))
                {
                    if (a.Phase == ApproachPhase.Returning && !spoken)
                        break; // Vanilla hands it back next frame.
                    a.Controller!.Hold = true;
                    a.Controller.pathToEndPoint?.Clear();
                    npc.Halt();
                    a.Phase = ApproachPhase.Waiting;
                    a.WaitFrom = Game1.timeOfDay;
                }
                break;
            case ApproachPhase.Waiting:
                if (busy)
                    break;
                if (e.IsMultipleOf(30))
                    npc.faceGeneralDirection(Game1.player.getStandingPosition());
                if (a.Talked || Vector2.Distance(npc.Tile, Game1.player.Tile) > ApproachLeaveRange
                    || Utility.CalculateMinutesBetweenTimes(a.WaitFrom, Game1.timeOfDay) >= ApproachWaitMinutes
                    || MinutesToNextStop(npc) <= ApproachHeadBackMinutes)
                    this.HeadBack(a);
                break;
        }
    }

    private void HeadBack(Approach a)
    {
        NPC npc = a.Npc;
        Stack<Point>? path = npc.TilePoint == a.OriginTile ? null
            : PathFindController.findPath(npc.TilePoint, a.OriginTile, PathFindController.isAtEndPoint, a.Location, npc, ApproachPathLimit);
        if (path is null)
        {
            this.ReleaseApproach(a, restore: true);
            return;
        }
        a.Controller = new ApproachController(path, a.Location, npc, a.Facing);
        npc.temporaryController = a.Controller;
        a.Phase = ApproachPhase.Returning;
    }

    private void ReleaseApproach(Approach a, bool restore)
    {
        this.approach = null;
        NPC npc = a.Npc;
        if (npc.temporaryController == a.Controller)
            npc.temporaryController = null;
        npc.willDestroyObjectsUnderfoot = a.Destroys;
        if (!restore || npc.currentLocation != a.Location)
            return;
        npc.Halt();
        npc.Position = a.Origin;
        npc.faceDirection(a.Facing);
        ResumeSchedule(npc);
    }
}
