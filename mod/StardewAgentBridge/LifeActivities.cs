using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Menus;

namespace StardewAgentBridge;

/// <summary>Explicit native-menu activities. Only actual game outcomes produce persistent life facts.</summary>
internal sealed partial class ModEntry
{
    private sealed class LifeActivitySession
    {
        public NPC Npc = null!;
        public Meeting Movement = null!;
        public string Activity = "";
        public string? Goal;
        public string? RomanceDateId;
        public string? RomanceVenue;
        public string? GoalResultProjectId;
        public string? GoalResultAttemptId;
        public string Nonce = "";
        public int Day;
        public int LastTime;
        public int Minutes;
        public int Count;
        public bool WholeInterval;
        public uint CookedSeen;
        public Dictionary<string, int> RecipesSeen = new();
        public string? Item;
        public int OriginalSpeed;
        public bool OriginalPasses;
        public IClickableMenu? CookingMenu;
        public DateTime CookingOpeningUntil;
    }

    private sealed record LifeActivityContinuation(LifeActivitySession Previous, DateTime Until);

    private LifeActivitySession? lifeActivity;
    private LifeActivityContinuation? lifeContinuation;
    private readonly List<(Meeting Movement, NPC Npc, string Nonce, int Day)> lifeActivityReturns = new();
    private int lifeMenuGeneration;

    private bool IsLifeActivityNpc(string name) => this.lifeActivity?.Npc.Name.Equals(name, StringComparison.OrdinalIgnoreCase) == true
        || this.lifeContinuation?.Previous.Npc.Name.Equals(name, StringComparison.OrdinalIgnoreCase) == true;

    private bool HasLifeActivityExit(NPC npc)
    {
        LifeActivitySession? current = this.lifeActivity ?? this.lifeContinuation?.Previous;
        return this.activeLoad && current is not null && current.Npc == npc && LifeNear(npc)
            && LifeActivityRules.SameSession(current.Nonce, current.Day, this.loadNonce, AbsoluteDay());
    }

    private Dictionary<string, object?>? LifeActivityOuting(NPC npc)
        => this.lifeActivity is { } activity && activity.Npc == npc ? activity.Movement.Out.Fields() : null;

    private Dictionary<string, object?>? LifeActivitySnapshot(NPC npc)
    {
        if (this.lifeActivity is not { } activity || activity.Npc != npc || activity.GoalResultProjectId is not null)
            return null;
        Dictionary<string, object?> snapshot = new()
        {
            ["activity"] = activity.Activity, ["minutes"] = activity.Minutes, ["count"] = activity.Count,
        };
        if (activity.Goal is string goal)
            snapshot["goal"] = goal.Split('@')[0];
        return snapshot;
    }

    private static bool LifeNear(NPC npc) => Context.IsWorldReady && npc.currentLocation == Game1.currentLocation
        && Vector2.Distance(npc.Tile, Game1.player.Tile) <= 8 && !npc.IsInvisible;

    private static bool LifeSpouse(NPC npc) => GameState.Relation(npc) is "married" or "roommate";

    /// <summary>The ordinary conversation's extra native menu; callbacks recheck location and load identity.</summary>
    private void ShowLifeActivities(NPC npc)
    {
        if (!LifeNear(npc) || !LifeActivityRules.MenuAllowed(this.CanChat, this.lifeSupported, true, this.HasLifeActivityExit(npc)))
            return;
        if (this.lifeContinuation is { } continuation)
        {
            if (continuation.Previous.Npc != npc)
                return;
            this.LifeQuestion(npc, "正在等待上一项活动的记录确认，再一起做饭。也可以先各自回到日程。",
                new[] { "再等等", "结束这次等待" }, choice =>
                {
                    if (choice == 1 && this.lifeContinuation == continuation)
                        this.CancelLifeContinuation();
                }, allowExistingExit: true);
            return;
        }
        if (this.lifeActivity is { } active)
        {
            if (active.Npc != npc)
            {
                Game1.drawObjectDialogue($"先结束和{active.Npc.displayName}的活动吧。");
                return;
            }
            if (active.GoalResultProjectId is not null) { this.ShowGoalResultPractice(active); return; }
            string progress = $"{LifeActivityRules.Label(active.Activity)}：实际在一起 {active.Minutes} 分钟";
            if (active.Activity is "foraging" or "fishing")
                progress += $"，{(active.Activity == "fishing" ? "钓到" : "采集到")} {active.Count} 个。需要至少 20 分钟和 1 个实际收获。";
            else
                progress += "。散步需要至少 30 分钟。";
            if (active.RomanceVenue is string venue)
                progress = $"恋人约会：在{RomanceRules.Place(venue)}实际在一起 {active.Minutes} 分钟；需要 30 分钟。前往目的地的路程不计入。";
            List<string> choices = new() { "继续", LifeActivityRules.Ready(active.Activity, active.Minutes, active.Count) ? "结束这次活动" : "今天先回去" };
            bool canCook = this.CanChat && this.config.LifeActivities && active.Activity is not ("cooking" or "romantic_date") && Game1.currentLocation is FarmHouse
                && Game1.currentLocation.GetFridge(true) is not null;
            if (canCook)
                choices.Add("结束这次活动，接着一起做饭");
            this.LifeQuestion(npc, progress, choices, choice =>
            {
                if (this.lifeActivity != active)
                    return;
                if (choice == 1)
                    this.FinishLifeActivity(allowComplete: true, cancelReason: "player");
                else if (choice == 2 && canCook)
                    this.ContinueLifeWithCooking(active);
            }, allowExistingExit: true);
            return;
        }
        if (!this.config.LifeActivities && !this.config.LifeSocial)
            return;
        List<(string Label, Action Run)> options = new();
        bool close = GameState.Hearts(npc) >= 8 || LifeSpouse(npc);
        if (close && this.config.LifeActivities)
        {
            if (LifeSpouse(npc))
            {
                options.Add(("一起出门走走（30 分钟）", () => this.TryStartLifeActivity(npc, "spouse_walk")));
                options.Add(("一起吃饭（分享 1 份熟食）", () => this.ShowLifeDinner(npc)));
            }
            else
                options.Add(("去森林散步（30 分钟）", () => this.TryStartLifeActivity(npc, "forest_walk")));
            if (npc.Name is "Leah" or "Linus" or "Emily" or "Sandy" or "Leo")
                options.Add(("一起采集（20 分钟，实际采到 1 个）", () => this.TryStartLifeActivity(npc, "foraging")));
            if (npc.Name is "Willy" or "Elliott" or "Linus" or "Sebastian" || LifeSpouse(npc))
                options.Add(("陪我钓鱼（20 分钟，实际钓到 1 条）", () => this.TryStartLifeActivity(npc, "fishing")));
            options.Add(("一起做饭（需要在农舍厨房）", () => this.TryStartLifeActivity(npc, "cooking")));
        }
        if (this.config.LifeSocial && this.HasLifeGrievance(npc))
            options.Add(("为之前失约道歉", () => this.ApologizeInPerson(npc)));
        if (this.config.LifeSocial && this.ShareCandidate(npc) is not null)
            options.Add(("和在场的朋友聊聊共同经历", () => this.ShareLifeActivity(npc)));
        options.Add(("先不做什么", () => { }));
        this.LifeQuestion(npc, close ? "今天想一起做点什么？" : "我们可以先聊聊彼此的相处。熟悉以后再一起活动。",
            options.Select(option => option.Label).ToArray(), index => options[index].Run());
    }

    private void LifeQuestion(NPC npc, string text, IReadOnlyList<string> options, Action<int> chosen, bool allowExistingExit = false)
    {
        int generation = ++this.lifeMenuGeneration;
        string nonce = this.loadNonce;
        int day = AbsoluteDay();
        Dialogue dialogue = VanillaDialogue.Create(npc, text, "neutral", options, index =>
        {
            if (generation != this.lifeMenuGeneration || nonce != this.loadNonce || day != AbsoluteDay()
                || !LifeActivityRules.MenuAllowed(this.CanChat, this.lifeSupported, allowExistingExit, this.HasLifeActivityExit(npc))
                || !LifeNear(npc) || Game1.eventUp || Game1.isFestival()
                || index < 0 || index >= options.Count)
                return;
            this.lifeMenuGeneration++;
            // The old dialogue's closing animation must finish before another native menu opens.
            this.lifeMenuAction = () =>
            {
                if (nonce == this.loadNonce && day == AbsoluteDay()
                    && LifeActivityRules.MenuAllowed(this.CanChat, this.lifeSupported, allowExistingExit, this.HasLifeActivityExit(npc)) && LifeNear(npc)
                    && !Game1.eventUp && !Game1.isFestival())
                    chosen(index);
            };
        });
        this.ownDialogues.Add(dialogue, new object());
        npc.CurrentDialogue.Push(dialogue);
        Game1.drawDialogue(npc);
    }

    private Action? lifeMenuAction;

    /// <summary>Starts company immediately where both characters actually stand; no teleport to the goal.</summary>
    private bool TryStartLifeActivity(NPC npc, string activity, string? goal = null, string? romanceDateId = null, string? romanceVenue = null,
        string? practiceProjectId = null, string? practiceAttemptId = null)
    {
        string? why = !this.lifeSupported || !this.CanChat || !this.CanRecordLifeEvents(goal is null ? 1 : 2) ? "等生活记录同步完成后再开始吧。"
            : !this.config.LifeActivities && goal is null && romanceDateId is null && practiceProjectId is null ? "生活活动开关尚未开启。"
            : this.lifeActivity is not null ? "已经有一项活动正在进行。"
            : this.lifeContinuation is not null ? "正在等待上一项活动结束。"
            : (!LifeActivityRules.Activities.Contains(activity) && activity != "project_practice") || activity == "home_dinner" ? "这个活动不能这样开始。"
            : activity == "project_practice" && (practiceProjectId is null || practiceAttemptId is null || !this.CanStartGoalResult(npc, practiceProjectId))
                ? "合册或成果实践状态已经改变，请重新查看。"
            : activity == "romantic_date" && (romanceDateId is null || romanceVenue is null || !RomanceRules.Venues.Contains(romanceVenue)
                || !this.CanStartRomance(npc)) ? "恋爱关系或约会安排已经改变。"
            : !LifeNear(npc) ? "先走到对方身边吧。"
            : ColdShoulder(npc.Name) || Game1.eventUp || Game1.isFestival() ? "现在不方便一起活动。"
            : practiceProjectId is not null && (npc.isSleeping.Value || npc.IsInvisible || npc.ignoreScheduleToday && !LifeSpouse(npc) || npc.isMoving()
                || npc.controller is not null || npc.temporaryController is not null || npc.doingEndOfRouteAnimation.Value || npc.IsWalkingInSquare
                || npc.IsReturningToEndPoint() || this.Approaching(npc.Name) || this.sceneParticipants.Contains(npc.Name)) ? "等对方清醒、空闲下来再一起实践吧。"
            : !this.config.NpcMeetings || !this.config.MeetingsGoTogether ? "请先启用赴约和一起逛。"
            : GameState.Hearts(npc) < 8 && !LifeSpouse(npc) && romanceDateId is null ? "再熟悉一些以后一起去吧。"
            : activity == "spouse_walk" && !LifeSpouse(npc) ? "这项家庭活动需要配偶或室友。"
            : !LifeActivityRules.StartTime(Game1.timeOfDay) ? "现在太早或太晚了，明天再安排吧。"
            : this.meetings.TryGetValue(npc.Name, out Meeting? meeting) && !meeting.Reported && !meeting.Failed
                ? "已经有其他约定，先完成或取消那一项吧。"
            : this.meetings.Values.Count(m => !m.Surprise) + this.LifeActivityStartsToday >= MeetsPerDay
                ? "今天的共同活动和约定已经够多了，明天再去吧。"
            : this.lifeEvents.Count(e => e.Day == AbsoluteDay() && e.Npc == npc.Name.ToLowerInvariant()
                && e.Kind == "activity.completed" && e.Activity == activity) > 0 && goal is null ? "今天已经一起做过这件事，明天再来吧。"
            : null;
        if (why is null && activity == "cooking")
        {
            if (Game1.currentLocation is not FarmHouse || Game1.currentLocation.GetFridge(true) is null)
                why = "需要两个人一起在有厨房的农舍里。先一起走到厨房附近吧。";
            else if (!Game1.player.cookingRecipes.Pairs.Any())
                why = "先学会一道菜，再一起准备吧。";
        }
        if (why is not null)
        {
            Game1.drawObjectDialogue(why);
            return false;
        }
        if (!this.ReserveLifeActivitySlot())
            return false;
        // An old failed return route must never warp this actor during a newly accepted activity.
        this.lifeActivityReturns.RemoveAll(returning => returning.Npc == npc);
        Meeting movement = new(npc.Name, Game1.timeOfDay, "森林河边", sameDay: true)
        {
            Origin = new ScheduleStop(npc.currentLocation.NameOrUniqueName, npc.TilePoint, npc.FacingDirection, null, null),
            ReceivedAt = Game1.timeOfDay,
            ArrivedAt = Game1.timeOfDay,
            Met = true,
            Applied = true,
            Spouse = LifeSpouse(npc),
            ReturnAt = -1,
        };
        if (npc.Schedule is not null)
            foreach (var stop in npc.Schedule)
                movement.Original[stop.Key] = stop.Value;
        LifeActivitySession session = new()
        {
            Npc = npc, Movement = movement, Activity = activity, Goal = goal, Nonce = this.loadNonce,
            RomanceDateId = romanceDateId, RomanceVenue = romanceVenue,
            GoalResultProjectId = practiceProjectId, GoalResultAttemptId = practiceAttemptId,
            Day = AbsoluteDay(), LastTime = Game1.timeOfDay, WholeInterval = false,
            CookedSeen = Game1.stats.ItemsCooked, OriginalSpeed = npc.speed, OriginalPasses = npc.farmerPassesThrough,
            RecipesSeen = Game1.player.recipesCooked.Pairs.ToDictionary(pair => pair.Key, pair => pair.Value),
        };
        try
        {
            npc.controller = null;
            npc.queuedSchedulePaths.Clear();
            this.lifeActivity = session;
            this.StartOuting(movement, npc);
            // This activity already has an explicit objective, so a random change of destination is inappropriate.
            movement.Out.Suggested = true;
            session.WholeInterval = this.LifeTimeEligible(session);
            if (activity == "cooking")
            {
                session.CookingOpeningUntil = DateTime.UtcNow.AddSeconds(25);
                Game1.currentLocation.ActivateKitchen();
                session.CookingMenu = Game1.activeClickableMenu as CraftingPage;
            }
            else if (practiceProjectId is null)
            {
                npc.showTextAboveHead(activity == "forest_walk" ? "我们一起去森林走走吧。" : "走吧，我陪你。 ");
                Game1.addHUDMessage(new HUDMessage($"和{npc.displayName}开始{LifeActivityRules.Label(activity)}；再次交谈可以结束。", HUDMessage.newQuest_type));
            }
            return true;
        }
        catch (Exception ex)
        {
            this.lifeActivity = null;
            this.ReleaseLifeActor(session);
            this.UndoLifeActivitySlot();
            this.Monitor.Log($"共同活动未能开始：{ex.Message}", LogLevel.Warn);
            Game1.drawObjectDialogue("这次活动暂时无法开始，先留到下次吧。");
            return false;
        }
    }

    private bool LifeTimeEligible(LifeActivitySession session) => LifeNear(session.Npc) && !Game1.eventUp
        && !Game1.isFestival() && !Game1.isWarping && Game1.activeClickableMenu is null
        && (session.Activity != "forest_walk" || Game1.currentLocation.Name == "Forest")
        && (session.RomanceDateId is null || RomanceRules.CountTime(session.RomanceVenue!, Game1.currentLocation.Name, true, this.Romantic(session.Npc)))
        && (session.GoalResultProjectId is null || this.GoalResultTimeEligible(session));

    private void LifeActivitiesTimeChanged()
    {
        if (this.lifeActivity is not { } activity)
            return;
        bool eligible = this.LifeTimeEligible(activity);
        activity.Minutes += LifeActivityRules.ClockStep(activity.LastTime, Game1.timeOfDay, activity.WholeInterval && eligible);
        activity.LastTime = Game1.timeOfDay;
        activity.WholeInterval = eligible;
    }

    private void TickLifeActivities(UpdateTickedEventArgs e)
    {
        if (!Context.IsWorldReady)
            return;
        this.TickLifeContinuation();
        foreach (var returning in this.lifeActivityReturns.ToArray())
        {
            if (!LifeActivityRules.SameSession(returning.Nonce, returning.Day, this.loadNonce, AbsoluteDay()))
            {
                this.lifeActivityReturns.Remove(returning);
                continue;
            }
            if (returning.Movement.Out.GoBack is ScheduleStop back && returning.Npc.currentLocation != Game1.currentLocation && !Game1.isWarping)
            {
                Game1.warpCharacter(returning.Npc, back.Map, Utility.PointToVector2(back.Tile));
                returning.Npc.faceDirection(back.Facing);
                returning.Movement.Out.GoBack = null;
            }
            if (returning.Movement.Out.GoBack is null)
                this.lifeActivityReturns.Remove(returning);
        }
        if (this.lifeMenuAction is { } action && Game1.activeClickableMenu is null && !Game1.dialogueUp)
        {
            this.lifeMenuAction = null;
            action();
        }
        if (this.lifeActivity is not { } activity)
            return;
        if (activity.Nonce != this.loadNonce || activity.Day != AbsoluteDay())
        {
            this.ClearLifeActivities();
            return;
        }
        NPC npc = activity.Npc;
        if (activity.RomanceDateId is not null && !this.Romantic(npc))
        {
            this.FinishLifeActivity(allowComplete: false, cancelReason: "relationship");
            return;
        }
        bool near = LifeNear(npc);
        activity.WholeInterval &= this.LifeTimeEligible(activity);
        this.WatchPlayer(activity.Movement, npc, activity.GoalResultProjectId is null ? near : this.GoalResultEvidenceNear(activity));
        if (activity.GoalResultProjectId is not null) this.UpdateGoalResultCount(activity);
        if (activity.Activity == "foraging")
            activity.Count = activity.Movement.Out.Foraged;
        if (activity.Activity == "fishing")
            activity.Count = activity.Movement.Out.Fish;
        if (activity.Activity == "cooking")
        {
            // Vanilla may acquire fridge locks asynchronously before creating its cooking page.
            if (activity.CookingMenu is null)
            {
                if (Game1.activeClickableMenu is CraftingPage cooking)
                    activity.CookingMenu = cooking;
                else
                {
                    if (DateTime.UtcNow >= activity.CookingOpeningUntil || !near || Game1.eventUp || this.Helper.Input.IsDown(SButton.Escape))
                    {
                        this.lifeActivity = null;
                        this.ReleaseLifeActor(activity);
                        this.UndoLifeActivitySlot();
                        Game1.addHUDMessage(new HUDMessage("厨房没有准备好，这次没有计入共同活动。", HUDMessage.error_type));
                    }
                    return;
                }
            }
            uint cooked = Game1.stats.ItemsCooked;
            if (near && Game1.activeClickableMenu == activity.CookingMenu && cooked > activity.CookedSeen)
            {
                activity.Count += (int)(cooked - activity.CookedSeen);
                foreach (var recipe in Game1.player.recipesCooked.Pairs)
                    if (recipe.Value > activity.RecipesSeen.GetValueOrDefault(recipe.Key))
                        activity.Item = recipe.Key.StartsWith("(", StringComparison.Ordinal) ? recipe.Key : "(O)" + recipe.Key;
            }
            activity.CookedSeen = cooked;
            activity.RecipesSeen = Game1.player.recipesCooked.Pairs.ToDictionary(pair => pair.Key, pair => pair.Value);
            if (Game1.activeClickableMenu != activity.CookingMenu)
                this.FinishLifeActivity(allowComplete: true);
            return;
        }
        if (Game1.timeOfDay >= 2200 || Utility.CalculateMinutesBetweenTimes(activity.Movement.Out.Since, Game1.timeOfDay) >= 90)
        {
            this.FinishLifeActivity(allowComplete: true);
            return;
        }
        if (Game1.eventUp || !Game1.shouldTimePass() || Game1.isWarping || Game1.activeClickableMenu is not null || this.talk?.Npc == npc)
            return;
        if (npc.currentLocation != Game1.currentLocation)
            return;
        if (e.IsMultipleOf(15))
        {
            if (npc.temporaryController != activity.Movement.Trip.Hold)
                this.HoldCompanion(activity.Movement, npc, npc.currentLocation);
            if (Fishing() || !Game1.player.isMoving())
                this.StandBeside(activity.Movement, npc);
            else
                this.FollowStep(activity.Movement, npc);
        }
    }

    private void LifeActivitiesWarped(WarpedEventArgs e)
    {
        if (!e.IsLocalPlayer || this.lifeActivity is not { } activity)
            return;
        activity.WholeInterval = false;
        if (activity.Activity == "cooking" || !OutingGoes(e.NewLocation.NameOrUniqueName))
        {
            this.FinishLifeActivity(allowComplete: false);
            return;
        }
        this.JoinOuting(activity.Movement, activity.Npc, e.NewLocation);
    }

    private void ContinueLifeWithCooking(LifeActivitySession previous)
    {
        if (this.lifeActivity != previous || previous.GoalResultProjectId is not null || !this.config.LifeActivities || !this.lifeSupported || !this.CanChat
            || !LifeNear(previous.Npc) || Game1.currentLocation is not FarmHouse || Game1.currentLocation.GetFridge(true) is null)
            return;
        if (!Game1.player.cookingRecipes.Pairs.Any() || this.meetings.Values.Count(m => !m.Surprise) + this.LifeActivityStartsToday >= MeetsPerDay
            || !LifeActivityRules.StartTime(Game1.timeOfDay)
            || this.lifeEvents.Any(entry => entry.Npc == previous.Npc.Name.ToLowerInvariant() && entry.Day == AbsoluteDay()
                && entry.Kind == "activity.completed" && entry.Activity == "cooking"))
        {
            Game1.drawObjectDialogue("需要学会一道菜，在 9 点到 19 点间开始，并为今天尚未完成的做饭活动留出次数。");
            return;
        }
        this.lifeContinuation = new(previous, DateTime.UtcNow.AddSeconds(25));
        this.FinishLifeActivity(allowComplete: true, keepActor: true);
        Game1.addHUDMessage(new HUDMessage("一起准备做饭；等待活动记录确认，按 Esc 可取消。", HUDMessage.newQuest_type));
    }

    private void TickLifeContinuation()
    {
        if (this.lifeContinuation is not { } next)
            return;
        LifeActivitySession previous = next.Previous;
        if (previous.Nonce != this.loadNonce || previous.Day != AbsoluteDay())
        {
            this.ClearLifeActivities();
            return;
        }
        if (DateTime.UtcNow >= next.Until || !LifeNear(previous.Npc) || Game1.currentLocation is not FarmHouse
            || Game1.eventUp || this.Helper.Input.IsDown(SButton.Escape))
        {
            this.CancelLifeContinuation();
            return;
        }
        if (!this.lifeSupported || !this.CanChat || Game1.activeClickableMenu is not null || Game1.dialogueUp)
            return;
        this.lifeContinuation = null;
        this.ReleaseOuting(previous.Movement, previous.Npc);
        previous.Npc.speed = previous.OriginalSpeed;
        previous.Npc.farmerPassesThrough = previous.OriginalPasses;
        if (!this.TryStartLifeActivity(previous.Npc, "cooking") && !this.lifeActivityReturns.Any(returning => returning.Npc == previous.Npc))
            this.ReleaseLifeActor(previous);
    }

    private void CancelLifeContinuation()
    {
        if (this.lifeContinuation is not { } next)
            return;
        this.lifeContinuation = null;
        this.ReleaseLifeActor(next.Previous);
    }

    private void FinishLifeActivity(bool allowComplete, bool keepActor = false, string cancelReason = "interrupted")
    {
        if (this.lifeActivity is not { } activity)
            return;
        if (activity.GoalResultProjectId is not null)
        {
            // Timeouts, day end and generic exits must never turn into explicit practice completion.
            this.FinishGoalResultPractice(activity, false, cancelReason);
            return;
        }
        if (activity.RomanceDateId is not null)
        {
            this.FinishRomanceDate(activity, allowComplete, cancelReason);
            return;
        }
        bool completed = allowComplete && LifeActivityRules.Ready(activity.Activity, activity.Minutes, activity.Count)
            && (activity.Activity != "cooking" || activity.Item is not null);
        if (!this.CanRecordLifeEvents(completed && activity.Goal is not null ? 2 : 1))
            completed = false;
        int previousPoints = Game1.player.friendshipData.TryGetValue(activity.Npc.Name, out Friendship? relation) ? relation.Points : 0;
        int previousBudget = this.friendshipToday.GetValueOrDefault(activity.Npc.Name);
        int friendship = this.LifeActivityFriendship(activity.Npc,
            activity.Activity == "cooking" ? completed : activity.Minutes > 0);
        if (!this.EmitLifeEvent(activity.Npc.Name, completed ? "activity.completed" : "activity.cancelled",
            activity: activity.Activity, goal: activity.Goal?.Split('@')[0], count: activity.Count, minutes: activity.Minutes,
            item: completed ? activity.Item : null, friendship: friendship))
        {
            // Release the NPC even if the journal is unavailable, but never claim an unrecorded completion.
            completed = false;
            if (relation is not null)
                relation.Points = previousPoints;
            this.friendshipToday[activity.Npc.Name] = previousBudget;
            this.Monitor.Log("活动记录未能保存；没有记成完成。", LogLevel.Warn);
        }
        this.lifeActivity = null;
        if (!keepActor)
            this.ReleaseLifeActor(activity);
        if (activity.Goal is not null)
            this.OnLifeActivityEnded(activity.Npc.Name, activity.Goal, completed, activity.Minutes, activity.Count);
        if (Context.IsWorldReady)
            Game1.addHUDMessage(new HUDMessage(completed ? $"和{activity.Npc.displayName}完成了{LifeActivityRules.Label(activity.Activity)}。"
                : $"和{activity.Npc.displayName}结束了这次活动。", HUDMessage.newQuest_type));
    }

    private int LifeActivityFriendship(NPC npc, bool met)
    {
        if (!met || !this.CanRecordLifeEvent || !this.config.MeetingsChangeFriendship || LifeSpouse(npc))
            return 0;
        return this.ChangeFriendshipToday(npc, FriendshipStep(GameState.Hearts(npc), GameState.Relation(npc)).Gain,
            $"和{npc.displayName}一起活动");
    }

    private void ReleaseLifeActor(LifeActivitySession activity)
    {
        NPC npc = activity.Npc;
        this.ReleaseOuting(activity.Movement, npc);
        npc.speed = activity.OriginalSpeed;
        npc.farmerPassesThrough = activity.OriginalPasses;
        npc.controller = null;
        npc.queuedSchedulePaths.Clear();
        ScheduleStop target = activity.Movement.Spouse && LifeSpouse(npc)
            ? new ScheduleStop(Utility.getHomeOfFarmer(Game1.player).NameOrUniqueName, Utility.getHomeOfFarmer(Game1.player).getKitchenStandingSpot(), 2, null, null)
            : OriginalStop(activity.Movement, Game1.timeOfDay);
        this.RouteTo(activity.Movement, npc, target, warpInSight: false);
        if (activity.Movement.Out.GoBack is not null)
            this.lifeActivityReturns.Add((activity.Movement, npc, activity.Nonce, activity.Day));
    }

    private void EndLifeActivitiesForDay()
    {
        this.lifeMenuAction = null;
        this.lifeMenuGeneration++;
        this.CancelLifeContinuation();
        this.FinishLifeActivity(allowComplete: true);
        // Vanilla places every NPC for tomorrow; today's fallback return is no longer authoritative.
        this.lifeActivityReturns.Clear();
    }

    private void ClearLifeActivities()
    {
        this.lifeMenuAction = null;
        this.lifeMenuGeneration++;
        LifeActivitySession? activity = this.lifeActivity ?? this.lifeContinuation?.Previous;
        if (activity is not null)
        {
            // A load/title transition must not create new facts or route characters in the new save.
            if (activity.Npc.temporaryController == activity.Movement.Trip.Hold)
                activity.Npc.temporaryController = null;
            activity.Npc.speed = activity.OriginalSpeed;
            activity.Npc.farmerPassesThrough = activity.OriginalPasses;
            if (activity.Movement.Destroys is bool destroys)
                activity.Npc.willDestroyObjectsUnderfoot = destroys;
        }
        this.lifeActivity = null;
        this.lifeContinuation = null;
        this.lifeActivityReturns.Clear();
    }

    private void ShowLifeDinner(NPC npc)
    {
        if (!this.lifeSupported || !this.config.LifeActivities || !this.CanChat || !LifeSpouse(npc) || !LifeNear(npc) || Game1.currentLocation is not FarmHouse)
        {
            Game1.drawObjectDialogue("回到农舍，和配偶或室友在一起时再吃饭吧。");
            return;
        }
        if (!LifeActivityRules.StartTime(Game1.timeOfDay))
        {
            Game1.drawObjectDialogue("一起吃饭需要在 9 点到 19 点间开始，明天再准备吧。");
            return;
        }
        if (this.lifeEvents.Any(e => e.Npc == npc.Name.ToLowerInvariant() && e.Day == AbsoluteDay() && e.Kind == "activity.completed" && e.Activity == "home_dinner"))
        {
            Game1.drawObjectDialogue("今天已经一起吃过饭了，明天再准备一顿吧。");
            return;
        }
        var meals = Game1.player.Items.Select((item, slot) => (Item: item, Slot: slot))
            .Where(pair => pair.Item is StardewValley.Object food && food.Category == StardewValley.Object.CookingCategory && food.Edibility > 0)
            .Take(8).ToArray();
        if (meals.Length == 0)
        {
            Game1.drawObjectDialogue("背包里需要一份可以吃的熟食。可以先一起做饭。 ");
            return;
        }
        string[] labels = meals.Select(meal => $"分享 {meal.Item!.DisplayName}（消耗 1 份）").Append("下次再吃").ToArray();
        this.LifeQuestion(npc, "用背包里的一份熟食一起吃顿饭，选哪一道？", labels, choice =>
        {
            if (choice >= meals.Length || !this.config.LifeActivities || this.lifeActivity is not null || this.lifeContinuation is not null
                || !LifeSpouse(npc) || !LifeNear(npc) || Game1.currentLocation is not FarmHouse || !this.CanRecordLifeEvent
                || !LifeActivityRules.StartTime(Game1.timeOfDay)
                || this.lifeEvents.Any(entry => entry.Npc == npc.Name.ToLowerInvariant() && entry.Day == AbsoluteDay()
                    && entry.Kind == "activity.completed" && entry.Activity == "home_dinner"))
                return;
            var meal = meals[choice];
            Item? item = Game1.player.Items[meal.Slot];
            if (!ReferenceEquals(item, meal.Item) || item.Stack < 1)
                return;
            if (!this.ReserveLifeActivitySlot())
                return;
            item.Stack--;
            if (item.Stack == 0)
                Game1.player.Items[meal.Slot] = null;
            int previousPoints = Game1.player.friendshipData.TryGetValue(npc.Name, out Friendship? relationship) ? relationship.Points : 0;
            int previousBudget = this.friendshipToday.GetValueOrDefault(npc.Name);
            if (!this.EmitLifeEvent(npc.Name, "activity.completed", activity: "home_dinner", item: item.QualifiedItemId, count: 1, minutes: 0,
                friendship: this.LifeActivityFriendship(npc, met: true)))
            {
                if (relationship is not null)
                    relationship.Points = previousPoints;
                this.friendshipToday[npc.Name] = previousBudget;
                item.Stack++;
                Game1.player.Items[meal.Slot] = item;
                this.UndoLifeActivitySlot();
                return;
            }
            npc.faceGeneralDirection(Game1.player.getStandingPosition());
            npc.doEmote(Character.happyEmote);
            Game1.drawObjectDialogue($"你和{npc.displayName}分享了一份{item.DisplayName}，一起吃了顿饭。");
        });
    }

    private void ApologizeInPerson(NPC npc)
    {
        if (!this.lifeSupported || !this.config.LifeSocial || !this.CanChat || !LifeNear(npc) || !this.HasLifeGrievance(npc))
            return;
        if (this.lifeEvents.Any(e => e.Npc == npc.Name.ToLowerInvariant() && e.Day == AbsoluteDay() && e.Kind == "relationship.apology"))
        {
            Game1.drawObjectDialogue("今天已经表达过歉意了，接下来用实际行动兑现吧。");
            return;
        }
        this.LifeQuestion(npc, "认真为之前没有赴约道歉？道歉不会直接增加好感，之后兑现约定才会慢慢修复信任。",
            new[] { "对不起，之后我会认真赴约", "先不说" }, choice =>
            {
                if (choice == 0 && this.LifeGrievance(npc) is string source && this.EmitLifeEvent(npc.Name, "relationship.apology", sourceId: source))
                    npc.showTextAboveHead("我听到了。以后用行动来说吧。");
            });
    }

    private string? LifeGrievance(NPC npc) => LifeActivityRules.UnrepairedMiss(this.lifeEvents
        .Where(entry => entry.Npc == npc.Name.ToLowerInvariant()).Select(entry => (entry.Id, entry.Kind, entry.Day, entry.SourceId)));

    private bool HasLifeGrievance(NPC npc) => this.LifeGrievance(npc) is not null;

    private (LifeEvent Source, NPC Listener)? ShareCandidate(NPC speaker)
    {
        string id = speaker.Name.ToLowerInvariant();
        LifeEvent? source = this.lifeEvents.LastOrDefault(e => e.Npc == id && e.Day >= AbsoluteDay() - 7
            && (e.Kind == "activity.completed" && e.Activity is string a && LifeActivityRules.PublicActivity(a)
                || e.Kind == "goal.completed"));
        if (source is null || !LifeNear(speaker))
            return null;
        foreach (NPC friend in speaker.currentLocation.characters)
        {
            string other = friend.Name.ToLowerInvariant();
            if (!LifeActivityRules.AreFriends(id, other) || !LifeNear(friend) || Vector2.Distance(speaker.Tile, friend.Tile) > 8)
                continue;
            if (this.lifeEvents.Any(e => e.Kind == "social.shared" && e.Npc == id && e.Other == other && e.SourceId == source.Id))
                continue;
            return (source, friend);
        }
        return null;
    }

    private void ShareLifeActivity(NPC speaker)
    {
        if (!this.lifeSupported || !this.config.LifeSocial || !this.CanChat || this.ShareCandidate(speaker) is not { } candidate)
            return;
        string label = candidate.Source.Kind == "goal.completed" ? "完成了一件共同的小目标" : LifeActivityRules.Label(candidate.Source.Activity!);
        this.LifeQuestion(speaker, $"{candidate.Listener.displayName}就在旁边。愿意聊聊我们一起{label}的经历吗？",
            new[] { "一起聊聊", "这次不说" }, choice =>
            {
                if (choice != 0 || this.ShareCandidate(speaker) is not { } current || current.Source.Id != candidate.Source.Id
                    || current.Listener != candidate.Listener)
                    return;
                if (this.EmitLifeEvent(speaker.Name, "social.shared", activity: candidate.Source.Activity,
                    other: candidate.Listener.Name.ToLowerInvariant(), sourceId: candidate.Source.Id))
                {
                    speaker.showTextAboveHead($"我和农场主一起{label}，挺开心的。 ");
                    candidate.Listener.faceGeneralDirection(speaker.getStandingPosition());
                    candidate.Listener.doEmote(Character.happyEmote);
                }
            });
    }
}
