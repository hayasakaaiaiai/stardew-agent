using System;
using System.Collections.Generic;
using System.Linq;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>Original UI, observed outings, durable receipts and source-bound follow-up.</summary>
internal sealed partial class ModEntry
{
    private readonly Dictionary<string, GoalResultDefinition> goalResults = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> goalResultRecoveries = new(StringComparer.Ordinal);
    private bool resultsSupported;
    private bool resultsUpgradeNotified;
    private DateTime goalResultNoticeAfter;
    private bool GoalResultsCompatible => GoalResultRules.Compatible(this.resultsSupported, this.lifeEvents);
    private bool GoalResultMenusReady => this.activeLoad && Context.IsWorldReady && this.resultsSupported && this.lifeSupported
        && this.CanChat && !Game1.eventUp && !Game1.isFestival();

    private void LoadGoalResults()
    {
        this.goalResults.Clear();
        try
        {
            GoalResultFile? file = this.Helper.Data.ReadJsonFile<GoalResultFile>("assets/goal-results.json");
            if (file is null || file.Version != 1 || file.Practices is null || file.Practices.Count != 7
                || file.Practices.Any(p => !GoalResultRules.Definition(p)) || file.Practices.Select(p => p.ProjectId).Distinct().Count() != 7)
                throw new InvalidOperationException("成果实践资料不完整或格式无效。");
            foreach (GoalResultDefinition definition in file.Practices) this.goalResults.Add(definition.ProjectId, definition);
        }
        catch (Exception ex) { this.goalResults.Clear(); this.Monitor.Log("成果实践暂停，已有记录保留：" + ex.Message, LogLevel.Warn); }
    }

    private void ValidateGoalResultSave()
    {
        if (!GoalResultRules.SaveVersion(this.lifeSave.Version, this.lifeEvents)
            || this.lifeEvents.Where(GoalResultRules.IsResult).Any(e => e.ProjectId is null || !this.lifeSave.GoalResults.ContainsKey(e.ProjectId))
            || this.lifeEvents.Where(e => e.Kind == "goalresult.notified").GroupBy(e => e.Day).Any(group => group.Count() > 1))
            throw new InvalidOperationException("成果实践日志与保存格式不一致；原始记录保留。");
        foreach (var pair in this.lifeSave.GoalResults)
            if (!this.goalResults.TryGetValue(pair.Key, out GoalResultDefinition? definition)
                || !GoalResultRules.ValidState(definition, pair.Value, this.lifeEvents, AbsoluteDay()))
                throw new InvalidOperationException("成果实践进度与原始记录不一致；原始记录保留。");
    }

    private void ClearGoalResults()
    {
        this.goalResultRecoveries.Clear(); this.resultsUpgradeNotified = false; this.goalResultNoticeAfter = DateTime.MinValue;
    }
    private void QueueGoalResultRecovery()
    {
        foreach (GoalResultState state in this.lifeSave.GoalResults.Values)
            if (GoalResultRules.Active(state) is GoalResultAttempt active) this.goalResultRecoveries[active.Id] = "load";
    }
    private void ReportGoalResultCompatibility()
    {
        if (this.GoalResultsCompatible || this.resultsUpgradeNotified || !Context.IsWorldReady || !this.memoryReady
            || !this.bridge.IsConnected || this.bridge.Generation != this.announcedGeneration) return;
        this.resultsUpgradeNotified = true;
        this.Monitor.Log("当前存档含成果实践记录，请同时更新后端和 Mod。", LogLevel.Warn);
        Game1.addHUDMessage(new HUDMessage("成果实践记录需要新版后端，请同时更新后端和 Mod。", HUDMessage.error_type));
    }
    private bool GoalResultEvent(GoalResultDefinition definition, string kind, string? source = null, string? choice = null,
        string? attempt = null, GoalResultPoint? point = null, int? minutes = null, int? count = null, string? reason = null, int? chapter = null)
        => this.AppendLifeEvent(new LifeEvent
        {
            Npc = definition.Owner, Kind = kind, ProjectId = definition.ProjectId, SourceId = source, ChoiceId = point?.ChoiceId ?? choice,
            AttemptId = attempt, Point = point?.Point, Venue = point?.Venue, X = point?.X, Y = point?.Y, Time = point?.Time,
            Weather = point?.Weather, Minutes = point?.Minutes ?? minutes, Count = point?.Count ?? count, Reason = reason, ChapterId = chapter,
        });
    private GoalResultState GoalResultStateFor(string project, out bool created)
    {
        created = !this.lifeSave.GoalResults.TryGetValue(project, out GoalResultState? state);
        if (created) this.lifeSave.GoalResults[project] = state = new();
        return state!;
    }
    private void GoalResultQuestion(NPC npc, string text, IReadOnlyList<(string Label, Action Action)> choices, bool existing = false, int page = 0)
    {
        bool Ready() => this.GoalResultMenusReady || existing && this.HasLifeActivityExit(npc);
        if (!Ready()) return;
        List<(string Label, Action Action)> visible = choices.Skip(page * 4).Take(4).ToList();
        if ((page + 1) * 4 < choices.Count) visible.Add(("下一页", () => this.GoalResultQuestion(npc, text, choices, existing, page + 1)));
        if (page > 0) visible.Add(("上一页", () => this.GoalResultQuestion(npc, text, choices, existing, page - 1)));
        this.LifeQuestion(npc, text, visible.Select(c => c.Label).ToArray(), index =>
        {
            if (Ready() && index >= 0 && index < visible.Count) visible[index].Action();
        }, allowExistingExit: existing);
    }

    private bool CanStartGoalResult(NPC npc, string project)
    {
        if (!this.GoalResultMenusReady || !this.config.ProjectPractice || !this.goalResults.TryGetValue(project, out GoalResultDefinition? definition)
            || !npc.Name.Equals(definition.Owner, StringComparison.OrdinalIgnoreCase) || !LifeNear(npc)
            || !GoalResultRules.Dependency(definition, GoalResultRules.ChapterSource(definition, this.lifeEvents, 3), this.currentDay, 3)) return false;
        return !this.lifeSave.GoalResults.TryGetValue(project, out GoalResultState? state)
            || GoalResultRules.Active(state) is null && GoalResultRules.Completed(state) is null;
    }

    private void ShowGoalResult(NPC npc, string project)
    {
        if (!this.goalResults.TryGetValue(project, out GoalResultDefinition? definition) || !LifeNear(npc)) return;
        if (this.lifeActivity is { } session && session.GoalResultProjectId == project && session.Npc == npc)
        { this.ShowGoalResultPractice(session); return; }
        if (!this.GoalResultMenusReady) return;
        this.lifeSave.GoalResults.TryGetValue(project, out GoalResultState? state);
        GoalResultAttempt? completed = state is null ? null : GoalResultRules.Completed(state);
        if (completed is not null)
        {
            List<(string Label, Action Action)> choices = new() { ("打开这次实践回执", () => this.ShowGoalResultReceipt(npc, state!)) };
            this.AddGoalResultSourceChoice(npc, project, choices);
            if (state!.ReviewId is not null) choices.Add(("重读回访批注", () => this.ReadGoalResultPage(npc, "这次实践的回访", state.ReviewText!)));
            else if (this.config.ProjectPractice && GoalResultRules.Review(completed, state.ReviewId, this.currentDay))
                choices.Add(("回访这次实践", () => this.ReviewGoalResult(npc, definition, state, completed)));
            choices.Add(("以后再聊", () => { }));
            this.GoalResultQuestion(npc, definition.Title + "已经完成。回执保留了当时的实际记录。" + (state.ReviewId is null && this.currentDay <= completed.EndDay ? "另一天再来，可以谈谈这次的体会。" : ""), choices);
            return;
        }
        if (state is not null && GoalResultRules.Active(state) is not null)
        { this.GoalResultQuestion(npc, "上一段同行正在结束和恢复日程，请稍后再开始。", new[] { ("稍后再来", (Action)(() => { })) }); return; }
        if (!this.config.ProjectPractice)
        { this.GoalResultQuestion(npc, "成果实践已暂停，已有合册和回执仍会保留。", new[] { ("知道了", (Action)(() => { })) }); return; }
        if (!GoalResultRules.Dependency(definition, GoalResultRules.ChapterSource(definition, this.lifeEvents, 3), this.currentDay, 3)) return;
        if (!GoalResultRules.Friendship(GameState.Hearts(npc), GameState.Relation(npc)))
        { this.GoalResultQuestion(npc, "合册随时可以读。一起去实践仍需达到 8 心，或已经是配偶、室友。", new[] { ("以后再一起去", (Action)(() => { })) }); return; }
        List<(string Label, Action Action)> plans = definition.PlanChoices.Select(choice => (choice.Label, (Action)(() => this.StartGoalResult(npc, definition, choice.Id)))).ToList();
        this.AddGoalResultSourceChoice(npc, project, plans);
        plans.Add(("这次先不去", () => { }));
        string origin = this.lifeSave.LongGoals.TryGetValue(project, out LongGoalState? longGoal) ? $"\n这次用到已经完成的《{longGoal.CollectionTitle}》。" : "";
        this.GoalResultQuestion(npc, definition.Opening + origin + $"\n要一起去{definition.VenueLabel}，有效同行至少 {definition.Minutes} 分钟。开始占用今天一次共同活动额度，完成时需要你明确确认。", plans);
    }

    private void AddGoalResultSourceChoice(NPC npc, string project, List<(string Label, Action Action)> choices)
    {
        if (this.lifeSave.LongGoals.TryGetValue(project, out LongGoalState? source) && LongGoalRules.CurrentChapter(source) == 0)
            choices.Add(("回看这次来源合册与稿页", () => this.ShowLongGoalCollection(npc, source)));
    }

    private void StartGoalResult(NPC npc, GoalResultDefinition definition, string choice)
    {
        if (!this.CanStartGoalResult(npc, definition.ProjectId) || !GoalResultRules.Choice(choice) || !this.CanRecordLifeEvent) return;
        LifeEvent? source = GoalResultRules.ChapterSource(definition, this.lifeEvents, 3);
        if (source is null) return;
        string attemptId = "life-" + (this.lifeSave.Serial + 1);
        if (!this.TryStartLifeActivity(npc, "project_practice", practiceProjectId: definition.ProjectId, practiceAttemptId: attemptId)) return;
        GoalResultState state = this.GoalResultStateFor(definition.ProjectId, out bool created);
        GoalResultAttempt attempt = new() { Id = attemptId, Day = this.currentDay, SourceId = source.Id, PlanChoiceId = choice };
        state.Attempts.Add(attempt);
        if (!this.GoalResultEvent(definition, "goalresult.started", source: source.Id, choice: choice))
        {
            state.Attempts.Remove(attempt); if (created) this.lifeSave.GoalResults.Remove(definition.ProjectId);
            if (this.lifeActivity is { } failed) { this.lifeActivity = null; this.ReleaseLifeActor(failed); }
            this.UndoLifeActivitySlot();
            return;
        }
        npc.showTextAboveHead(VanillaDialogue.Escape("走吧，我们一起去试一试。"));
        this.LifeNotice($"和{npc.displayName}开始{definition.Title}。在{definition.VenueLabel}同行，再次交谈可记录、完成或结束尝试。");
    }

    private bool GoalResultLocalAction(LifeActivitySession session)
        => this.activeLoad && Context.IsWorldReady && this.resultsSupported && this.config.ProjectPractice && this.CanRecordLifeEvent
            && ReferenceEquals(this.lifeActivity, session) && session.Nonce == this.loadNonce && session.Day == AbsoluteDay()
            && LifeNear(session.Npc) && !Game1.eventUp && !Game1.isFestival();
    private bool GoalResultSession(LifeActivitySession session, out GoalResultDefinition definition, out GoalResultState state, out GoalResultAttempt attempt)
    {
        definition = null!; state = null!; attempt = null!;
        if (session.GoalResultProjectId is null || !this.goalResults.TryGetValue(session.GoalResultProjectId, out definition!)
            || !this.lifeSave.GoalResults.TryGetValue(session.GoalResultProjectId, out state!)) return false;
        attempt = GoalResultRules.Active(state)!;
        return attempt is not null && attempt.Id == session.GoalResultAttemptId;
    }
    private bool GoalResultEvidenceNear(LifeActivitySession session)
        => session.GoalResultProjectId is string project && this.goalResults.TryGetValue(project, out GoalResultDefinition? definition)
            && session.Nonce == this.loadNonce && session.Day == AbsoluteDay() && LifeNear(session.Npc)
            && Game1.currentLocation.Name == definition.Venue && !Game1.eventUp && !Game1.isFestival() && !Game1.isWarping;
    private bool GoalResultTimeEligible(LifeActivitySession session)
        => this.GoalResultEvidenceNear(session) && this.goalResults.TryGetValue(session.GoalResultProjectId!, out GoalResultDefinition? definition)
            && GoalResultRules.Together(definition.Venue, Game1.currentLocation.Name, LifeNear(session.Npc), Game1.shouldTimePass(),
                Game1.activeClickableMenu is not null || Game1.dialogueUp, Game1.isWarping);
    private void UpdateGoalResultCount(LifeActivitySession session)
    {
        if (session.GoalResultProjectId is null || !this.goalResults.TryGetValue(session.GoalResultProjectId, out GoalResultDefinition? definition)) return;
        session.Count = Math.Min(999, definition.Mode == "fishing" ? session.Movement.Out.Fish : definition.Mode == "foraging" ? session.Movement.Out.Foraged : 0);
    }
    private GoalResultPoint CurrentGoalResultPoint(LifeActivitySession session, GoalResultAttempt attempt, string choice) => new()
    {
        Id = "life-" + (this.lifeSave.Serial + 1), Point = attempt.Points.Count + 1, Venue = Game1.currentLocation.Name,
        X = Game1.player.TilePoint.X, Y = Game1.player.TilePoint.Y, Time = Game1.timeOfDay, Weather = GameState.Weather(),
        Minutes = session.Minutes, Count = session.Count, ChoiceId = choice,
    };
    private static string GoalResultRequirement(GoalResultDefinition definition)
        => definition.Owner switch
        {
            "robin" => "共记录三次：第二处离首处至少 6 格，第三处回到首处 3 格内；每次之间再有效同行 10 分钟。",
            "leah" => "共记录三处，两两相隔至少 6 格；每次之间再有效同行 10 分钟。",
            "willy" => "在海滩近处真正钓获至少一条鱼，再记录一次。",
            "linus" => "在森林近处真正采集至少一件，再记录一次；若选择至少两件再收尾，最终总量需要至少两件。",
            _ => "共记录两处，相隔至少 6 格；两次之间再有效同行 10 分钟。",
        };

    private void ShowGoalResultPractice(LifeActivitySession session)
    {
        if (!this.GoalResultSession(session, out GoalResultDefinition definition, out _, out GoalResultAttempt attempt)) return;
        List<(string Label, Action Action)> choices = new() { ("继续同行", () => { }) };
        if (this.GoalResultLocalAction(session))
        {
            if (attempt.Points.Count < definition.Checkpoints.Count)
                choices.Add(($"记录第 {attempt.Points.Count + 1} 处", () => this.ShowGoalResultCheckpoint(session)));
            if (GoalResultRules.Ready(definition, attempt, this.currentDay, session.Minutes, session.Count))
                choices.Add(("完成实践，选择收尾", () => this.ShowGoalResultFinish(session)));
        }
        choices.Add(("结束本次尝试", () => this.FinishGoalResultPractice(session, false, "player")));
        string count = definition.Mode == "walk" ? "" : $"；实际{(definition.Mode == "fishing" ? "钓获" : "采集")} {session.Count} 个";
        this.GoalResultQuestion(session.Npc, $"{definition.Title}：在{definition.VenueLabel}有效同行 {session.Minutes}／{definition.Minutes} 分钟{count}，已记录 {attempt.Points.Count}／{definition.Checkpoints.Count} 处。\n首个记录至少同行 10 分钟。{GoalResultRequirement(definition)}\n只有明确选择完成才会结算；90 分钟上限或日终会结束尝试。", choices, existing: true);
    }
    private void ShowGoalResultCheckpoint(LifeActivitySession session)
    {
        if (!this.GoalResultLocalAction(session) || !this.GoalResultSession(session, out GoalResultDefinition definition, out _, out GoalResultAttempt attempt)) return;
        GoalResultPoint candidate = this.CurrentGoalResultPoint(session, attempt, "a");
        if (!this.GoalResultEvidenceNear(session) || !GoalResultRules.Checkpoint(definition, attempt.Points, candidate))
        { this.LifeNotice($"暂时不能记录：请在{definition.VenueLabel}和对方靠近，首点至少同行 10 分钟。" + GoalResultRequirement(definition)); return; }
        GoalResultCheckpoint checkpoint = definition.Checkpoints[attempt.Points.Count];
        List<(string Label, Action Action)> choices = checkpoint.Choices.Select(choice => (choice.Label, (Action)(() =>
        {
            if (!this.GoalResultLocalAction(session) || !this.GoalResultEvidenceNear(session) || !this.GoalResultSession(session, out _, out _, out GoalResultAttempt current)
                || current != attempt || current.Points.Count != checkpoint.Point - 1) return;
            GoalResultPoint point = this.CurrentGoalResultPoint(session, attempt, choice.Id);
            if (!GoalResultRules.Checkpoint(definition, attempt.Points, point)) return;
            attempt.Points.Add(point);
            if (!this.GoalResultEvent(definition, "goalresult.checkpoint", attempt: attempt.Id, point: point)) { attempt.Points.Remove(point); return; }
            Game1.drawObjectDialogue(VanillaDialogue.Escape(choice.Text));
        }))).ToList();
        choices.Add(("先不记下", () => { }));
        this.GoalResultQuestion(session.Npc, checkpoint.Prompt, choices, existing: true);
    }
    private void ShowGoalResultFinish(LifeActivitySession session)
    {
        if (!this.GoalResultLocalAction(session) || !this.GoalResultSession(session, out GoalResultDefinition definition, out _, out GoalResultAttempt attempt)
            || !GoalResultRules.Ready(definition, attempt, this.currentDay, session.Minutes, session.Count)) return;
        List<(string Label, Action Action)> choices = definition.FinishChoices.Select(choice =>
            (choice.Label, (Action)(() => this.FinishGoalResultPractice(session, true, "player", choice.Id)))).ToList();
        choices.Add(("暂时不完成", () => { }));
        this.GoalResultQuestion(session.Npc, "实际要求已经达到。选择这次的收尾方式，并完成实践？", choices, existing: true);
    }

    private void FinishGoalResultPractice(LifeActivitySession session, bool complete, string reason, string? choice = null)
    {
        if (!ReferenceEquals(this.lifeActivity, session)) return;
        if (!this.GoalResultSession(session, out GoalResultDefinition definition, out GoalResultState state, out GoalResultAttempt attempt))
        { this.lifeActivity = null; this.ReleaseGoalResultActor(session); return; }
        if (complete)
        {
            if (!this.GoalResultLocalAction(session) || !GoalResultRules.Choice(choice)
                || !GoalResultRules.Ready(definition, attempt, this.currentDay, session.Minutes, session.Count)) return;
            attempt.EndId = "life-" + (this.lifeSave.Serial + 1); attempt.EndDay = this.currentDay; attempt.EndKind = "completed";
            attempt.Minutes = session.Minutes; attempt.Count = session.Count; attempt.FinishChoiceId = choice;
            GoalResultRules.BuildReceipt(definition, state, attempt);
            if (!this.GoalResultEvent(definition, "goalresult.completed", source: attempt.Points[^1].Id, choice: choice,
                attempt: attempt.Id, minutes: session.Minutes, count: session.Count))
            {
                attempt.EndId = null; attempt.EndDay = 0; attempt.EndKind = null; attempt.Minutes = 0; attempt.Count = 0; attempt.FinishChoiceId = null;
                state.ReceiptTitle = null; state.ReceiptText = null; state.ReceiptPages.Clear();
                this.LifeNotice("回执暂时没有保存，实践还未结算，可以重试或结束尝试。"); return;
            }
        }
        else
        {
            if (reason == "player" && this.currentDay != attempt.Day) reason = "interrupted";
            if (!this.CancelGoalResult(definition, attempt, reason)) this.goalResultRecoveries[attempt.Id] = reason;
        }
        this.lifeActivity = null;
        this.ReleaseGoalResultActor(session);
        this.LifeNotice(complete ? $"和{session.Npc.displayName}完成了{definition.Title}。回执已经保存，另一天可以回访。" : "这次实践已结束，未记成完成；以后可以重新开始。");
    }
    private void ReleaseGoalResultActor(LifeActivitySession session)
    {
        if (!Game1.eventUp) { this.ReleaseLifeActor(session); return; }
        // A vanilla event may own the actor now. Remove only our held controller, without rerouting the event actor.
        this.ReleaseOuting(session.Movement, session.Npc);
        session.Npc.speed = session.OriginalSpeed; session.Npc.farmerPassesThrough = session.OriginalPasses;
    }
    private bool CancelGoalResult(GoalResultDefinition definition, GoalResultAttempt attempt, string reason)
    {
        if (!this.CanRecordLifeEvent || attempt.EndId is not null || this.currentDay < attempt.Day) return false;
        attempt.EndId = "life-" + (this.lifeSave.Serial + 1); attempt.EndDay = this.currentDay; attempt.EndKind = "cancelled"; attempt.Reason = reason;
        if (!this.GoalResultEvent(definition, "goalresult.cancelled", attempt: attempt.Id, reason: reason))
        { attempt.EndId = null; attempt.EndDay = 0; attempt.EndKind = null; attempt.Reason = null; return false; }
        this.goalResultRecoveries.Remove(attempt.Id); return true;
    }

    private void ShowGoalResultReceipt(NPC npc, GoalResultState state)
    {
        if (GoalResultRules.Completed(state) is null) return;
        List<(string Label, Action Action)> choices = state.ReceiptPages.Select(page => (page.Title, (Action)(() => this.ReadGoalResultPage(npc, page.Title, page.Text)))).ToList();
        choices.Add(("合上回执", () => { }));
        this.GoalResultQuestion(npc, state.ReceiptTitle + "\n" + state.ReceiptText, choices);
    }
    private void ReadGoalResultPage(NPC npc, string title, string text)
        => this.GoalResultQuestion(npc, title + "\n" + text, new[] { ("读完这一页", (Action)(() => { })) });
    private void ReviewGoalResult(NPC npc, GoalResultDefinition definition, GoalResultState state, GoalResultAttempt completed)
    {
        if (!this.GoalResultMenusReady || !this.config.ProjectPractice || !GoalResultRules.Review(completed, state.ReviewId, this.currentDay)) return;
        List<(string Label, Action Action)> choices = definition.ReviewChoices.Select(choice => (choice.Label, (Action)(() =>
        {
            if (!this.GoalResultMenusReady || !this.config.ProjectPractice || !LifeNear(npc) || !this.CanRecordLifeEvent
                || !GoalResultRules.Review(completed, state.ReviewId, this.currentDay)) return;
            state.ReviewId = "life-" + (this.lifeSave.Serial + 1); state.ReviewDay = this.currentDay; state.ReviewChoiceId = choice.Id;
            state.ReviewText = GoalResultRules.ReviewText(definition, completed, choice.Id);
            if (!this.GoalResultEvent(definition, "goalresult.reviewed", source: completed.EndId, choice: choice.Id))
            { state.ReviewId = null; state.ReviewDay = 0; state.ReviewChoiceId = null; state.ReviewText = null; return; }
            Game1.drawObjectDialogue(VanillaDialogue.Escape(state.ReviewText));
        }))).ToList();
        choices.Add(("晚点再谈", () => { }));
        this.GoalResultQuestion(npc, definition.ReviewIntro, choices);
    }

    private void TickGoalResults(UpdateTickedEventArgs e)
    {
        if (!this.activeLoad || !Context.IsWorldReady) return;
        this.ReportGoalResultCompatibility();
        if (this.lifeActivity is { GoalResultProjectId: not null } active
            && (!this.config.ProjectPractice || active.Day != AbsoluteDay() || Game1.eventUp || Game1.isFestival()))
            this.FinishGoalResultPractice(active, false, "interrupted");
        if (!e.IsMultipleOf(60) || !this.GoalResultMenusReady) return;
        foreach (var pair in this.lifeSave.GoalResults)
        {
            GoalResultAttempt? attempt = GoalResultRules.Active(pair.Value);
            if (attempt is null || this.lifeActivity?.GoalResultAttemptId == attempt.Id || !this.goalResults.TryGetValue(pair.Key, out GoalResultDefinition? definition)) continue;
            string reason = this.goalResultRecoveries.GetValueOrDefault(attempt.Id) ?? "interrupted";
            if (reason == "player" && attempt.Day != this.currentDay) reason = "interrupted";
            this.CancelGoalResult(definition, attempt, reason);
            return;
        }
        this.TryNotifyGoalResult();
    }
    private void TryNotifyGoalResult()
    {
        if (!this.config.ProjectPractice || !this.CanRecordLifeEvent || !Context.IsPlayerFree || !Game1.shouldTimePass()
            || Game1.activeClickableMenu is not null || Game1.dialogueUp || Game1.isWarping || Fishing() || Game1.timeOfDay is < 800 or >= 2000
            || this.talk is not null || this.offerFor is not null || this.startFor is not null || this.lifeActivity is not null || this.lifeContinuation is not null
            || DateTime.UtcNow < this.goalResultNoticeAfter || this.lifeEvents.Any(entry => entry.Kind == "goalresult.notified" && entry.Day == this.currentDay)) return;
        foreach (NPC npc in Game1.currentLocation.characters.Where(LifeNear).OrderBy(n => n.Name))
        {
            if (npc.isSleeping.Value || npc.IsInvisible || npc.ignoreScheduleToday && !LifeSpouse(npc) || npc.isMoving() || npc.controller is not null || npc.temporaryController is not null
                || npc.doingEndOfRouteAnimation.Value || npc.IsWalkingInSquare || npc.IsReturningToEndPoint() || ColdShoulder(npc.Name)
                || this.Approaching(npc.Name) || this.OnOuting(npc.Name) || this.sceneParticipants.Contains(npc.Name)
                || this.lifeActivityReturns.Any(r => r.Npc == npc) || this.meetings.TryGetValue(npc.Name, out Meeting? meeting) && !meeting.Reported && !meeting.Failed) continue;
            GoalResultDefinition? definition = this.goalResults.Values.SingleOrDefault(p => p.Owner == npc.Name.ToLowerInvariant());
            if (definition is null) continue;
            LifeEvent? source = this.lifeEvents.LastOrDefault(entry => entry.Kind == "longgoal.completed" && entry.LongGoalId == definition.ProjectId);
            if (source?.ChapterId is not int chapter) continue;
            if (this.lifeSave.GoalResults.TryGetValue(definition.ProjectId, out GoalResultState? existing) && existing.Notified.ContainsKey(chapter)) continue;
            string message = chapter == 3 ? "三章已经合好了。有空可以来读，也可以一起试一试。" : $"第 {chapter} 章已经整理好了，有空来读一读吧。";
            this.goalResultNoticeAfter = DateTime.UtcNow.AddSeconds(60);
            try { npc.showTextAboveHead(VanillaDialogue.Escape(message)); npc.doEmote(Character.exclamationEmote); }
            catch (Exception ex) { this.Monitor.Log("成果提醒未能显示：" + ex.Message, LogLevel.Trace); return; }
            GoalResultState state = this.GoalResultStateFor(definition.ProjectId, out bool created);
            state.Notified[chapter] = "life-" + (this.lifeSave.Serial + 1);
            if (!this.GoalResultEvent(definition, "goalresult.notified", source: source.Id, chapter: chapter))
            { state.Notified.Remove(chapter); if (created) this.lifeSave.GoalResults.Remove(definition.ProjectId); }
            return;
        }
    }
}
