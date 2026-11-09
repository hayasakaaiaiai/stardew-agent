using System;
using System.Collections.Generic;
using System.Linq;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>Authored chapters advance from native observations and explicit inventory operations.</summary>
internal sealed partial class ModEntry
{
    private readonly Dictionary<string, LongGoalDefinition> longGoals = new(StringComparer.Ordinal);
    private readonly Dictionary<string, StoryInterval> longGoalObservations = new(StringComparer.Ordinal);
    private readonly Dictionary<string, StoryInterval> longGoalWork = new(StringComparer.Ordinal);
    private bool goalsSupported;
    private bool goalsUpgradeNotified;
    private int longGoalMenuGeneration;
    private bool LongGoalsCompatible => LongGoalRules.Compatible(this.goalsSupported, this.lifeEvents);
    private bool LongGoalMenusReady => this.activeLoad && Context.IsWorldReady && this.lifeSupported && this.goalsSupported
        && this.CanChat && !Game1.eventUp && !Game1.isFestival();
    private bool LongGoalClockRunning => this.LongGoalMenusReady && this.config.LongGoals && !Game1.isWarping
        && Game1.activeClickableMenu is null && !Game1.dialogueUp && Game1.shouldTimePass();

    private void LoadLongGoals()
    {
        this.longGoals.Clear();
        try
        {
            LongGoalFile? file = this.Helper.Data.ReadJsonFile<LongGoalFile>("assets/long-goals.json");
            if (file is null || file.Version != 1 || file.Goals is null || file.Goals.Count != LongGoalRules.Owners.Count
                || file.Goals.Any(goal => !LongGoalRules.Definition(goal)) || file.Goals.Select(goal => goal.Id).Distinct().Count() != file.Goals.Count)
                throw new InvalidOperationException("长期目标资料不完整或格式无效。");
            foreach (LongGoalDefinition goal in file.Goals) this.longGoals.Add(goal.Id, goal);
        }
        catch (Exception ex) { this.longGoals.Clear(); this.Monitor.Log("长期目标暂停，已有记录保留：" + ex.Message, LogLevel.Warn); }
    }

    private void ValidateLongGoalSave()
    {
        if (!LongGoalRules.SaveVersion(this.lifeSave.Version, this.lifeEvents)
            || this.lifeEvents.Where(LongGoalRules.IsLongGoal).Any(e => e.LongGoalId is null || !this.lifeSave.LongGoals.ContainsKey(e.LongGoalId)))
            throw new InvalidOperationException("长期目标日志与生活存档版本不一致；原始记录保留。");
        foreach (var pair in this.lifeSave.LongGoals)
            if (!this.longGoals.TryGetValue(pair.Key, out LongGoalDefinition? definition)
                || !LongGoalRules.ValidState(definition, pair.Value, this.lifeEvents, AbsoluteDay()))
                throw new InvalidOperationException("长期目标章节与原始记录不一致；原始记录保留。");
    }

    private void ReportLongGoalCompatibility()
    {
        if (this.LongGoalsCompatible || this.goalsUpgradeNotified || !Context.IsWorldReady || !this.memoryReady
            || !this.bridge.IsConnected || this.bridge.Generation != this.announcedGeneration) return;
        this.goalsUpgradeNotified = true;
        this.Monitor.Log("当前存档含分章长期目标，请同时更新后端和 Mod。", LogLevel.Warn);
        Game1.addHUDMessage(new HUDMessage("长期目标记录需要新版后端，请同时更新后端和 Mod。", HUDMessage.error_type));
    }

    private void ClearLongGoalIntervals()
    {
        this.longGoalObservations.Clear(); this.longGoalWork.Clear(); this.longGoalMenuGeneration++;
    }

    private static string LongGoalIntervalKey(LongGoalDefinition goal, int chapter) => goal.Id + ":" + chapter;
    private static NPC? LongGoalNpc(LongGoalDefinition goal)
    {
        string? name = SocialNpcs.FirstOrDefault(n => n.Equals(goal.Owner, StringComparison.OrdinalIgnoreCase));
        return name is null ? null : Game1.getCharacterFromName(name);
    }
    private LifeEvent? LongGoalDependency(LongGoalDefinition goal) => goal.RequiresStory is null ? null
        : this.lifeEvents.LastOrDefault(e => e.Kind == "story.resolved" && e.StoryId == goal.RequiresStory && e.Npc == goal.Owner);
    private bool HasLongGoalEntry(NPC npc) => this.goalsSupported && this.longGoals.Values.Any(goal => goal.Owner == npc.Name.ToLowerInvariant()
        && (this.config.LongGoals || this.lifeSave.LongGoals.ContainsKey(goal.Id)));

    private void LongGoalQuestion(NPC? npc, string text, IReadOnlyList<(string Label, Action Action)> options, bool field = false, int page = 0)
    {
        bool Ready() => field ? this.StoryMenusReady && this.config.TownStories || this.LongGoalMenusReady && this.config.LongGoals : this.LongGoalMenusReady;
        if (!Ready() || npc is not null && (!LifeNear(npc) || ColdShoulder(npc.Name))) return;
        string nonce = this.loadNonce;
        int day = this.currentDay, generation = ++this.longGoalMenuGeneration;
        List<(string Label, Action Action)> visible = options.Skip(page * 5).Take(5).ToList();
        if ((page + 1) * 5 < options.Count) visible.Add(("下一页", () => this.LongGoalQuestion(npc, text, options, field, page + 1)));
        if (page > 0) visible.Add(("上一页", () => this.LongGoalQuestion(npc, text, options, field, page - 1)));
        Game1.currentLocation.createQuestionDialogue(VanillaDialogue.Escape(text),
            visible.Select((option, index) => new Response(index.ToString(), VanillaDialogue.Escape(option.Label))).ToArray(), (_, answer) =>
            {
                if (!int.TryParse(answer, out int index) || index < 0 || index >= visible.Count) return;
                this.lifeMenuNext = () =>
                {
                    if (generation != this.longGoalMenuGeneration || !TownStoryRules.Current(nonce, day, this.loadNonce, this.currentDay)
                        || !Ready() || npc is not null && (!LifeNear(npc) || ColdShoulder(npc.Name))) return;
                    this.longGoalMenuGeneration++;
                    visible[index].Action();
                };
            });
    }

    private bool LongGoalSpace()
    {
        if (this.CanRecordLifeEvent) return true;
        this.LifeNotice("长期目标暂时无法新增记录，已有章节和材料记录会保留。"); return false;
    }
    private bool LongGoalEvent(LongGoalDefinition goal, string kind, int? chapter = null, string? contribution = null,
        string? source = null, string? item = null, int? count = null, string? choice = null, string? venue = null,
        string? weather = null, int? minutes = null, int? step = null, string? outcome = null, string? dependency = null)
        => this.AppendLifeEvent(new LifeEvent
        {
            Npc = goal.Owner, Kind = kind, LongGoalId = goal.Id, ChapterId = chapter, ContributionId = contribution,
            SourceId = source, ItemId = item, Count = count, ChoiceId = choice, Venue = venue, Weather = weather,
            Minutes = minutes, Step = step, Outcome = outcome, DependencySourceId = dependency,
        });

    private bool LongGoalEditable(LongGoalDefinition goal, LongGoalState state, int chapter, NPC? npc = null)
        => this.LongGoalMenusReady && this.config.LongGoals && this.lifeSave.LongGoals.TryGetValue(goal.Id, out LongGoalState? actual)
            && ReferenceEquals(state, actual) && chapter is >= 1 and <= 3
            && (npc is null || npc.Name.Equals(goal.Owner, StringComparison.OrdinalIgnoreCase) && LifeNear(npc) && !ColdShoulder(npc.Name))
            && LongGoalRules.Editable(chapter, LongGoalRules.CurrentChapter(state), this.currentDay, LongGoalRules.OpenedDay(state, chapter),
                state.Chapters[chapter - 1].WorkStep, state.Chapters[chapter - 1].Outcome);

    private void ShowLongGoals(NPC npc)
    {
        if (!this.LongGoalMenusReady || !LifeNear(npc)) return;
        LongGoalDefinition? goal = this.longGoals.Values.SingleOrDefault(g => g.Owner == npc.Name.ToLowerInvariant());
        if (goal is null) return;
        if (!this.lifeSave.LongGoals.TryGetValue(goal.Id, out LongGoalState? state))
        {
            if (!this.config.LongGoals) return;
            LifeEvent? dependency = this.LongGoalDependency(goal);
            if (!LongGoalRules.DependencyReady(goal, dependency, this.currentDay))
            {
                this.LongGoalQuestion(npc, dependency is null ? "先把之前那一页完成，再聊接下来的长期打算吧。" : "之前那一页刚完成，另一天再聊接下来的打算吧。",
                    new[] { ("改天再来", (Action)(() => { })) });
                return;
            }
            this.LongGoalQuestion(npc, goal.Opening + "\n这件事会分三章慢慢做。不用承诺帮忙，之后也可以只来看看进展。", new[]
            {
                ("我想听听，也记下这个打算", (Action)(() => this.StartLongGoal(npc, goal))), ("以后再聊", (Action)(() => { })),
            });
            return;
        }
        List<(string Label, Action Action)> options = new();
        int current = LongGoalRules.CurrentChapter(state), completed = state.Chapters.Count(c => c.Outcome is not null);
        string summary = goal.Title + $"\n已完成 {completed}／3 章。";
        if (current > 0)
        {
            LongGoalChapter chapter = goal.Chapters[current - 1]; LongGoalChapterState progress = state.Chapters[current - 1];
            summary += $"\n第 {current} 章：{chapter.Title}。";
            if (!LongGoalRules.ChapterAvailable(current, this.currentDay, LongGoalRules.OpenedDay(state, current))) summary += " 前一章刚告一段落，另一天再继续。";
            else
            {
                summary += " " + chapter.Opening + (progress.WorkStep switch
                { 0 => " 还在准备第一轮整理。", 1 => " 第一轮已经整理好，另一天会继续收尾。", _ => " 两轮工作已经完成，章节正在记下。" });
                if (this.LongGoalEditable(goal, state, current, npc))
                {
                    LongGoalContribution contribution = chapter.Contribution;
                    if (progress.ContributionId is null)
                    {
                        if (contribution.Kind == "material")
                            options.Add(($"交付 {contribution.Count} 份{contribution.Label}", () => this.ConfirmLongGoalMaterial(npc, goal, state, current)));
                        else if (progress.ObservationId is not null)
                            options.Add(("告诉对方本章的现场观察", () => this.ConfirmLongGoalObservation(npc, goal, state, current)));
                        else summary += $" {contribution.Hint} 按 {this.config.StoryInvestigationKey} 可以记下观察。";
                    }
                    if (progress.ContributionId is not null && progress.ChoiceId is null)
                        options.Add(("为本章提出一个方案", () => this.ChooseLongGoalDirection(npc, goal, state, current)));
                }
                if (progress.ContributionId is not null) summary += " 你对这一章的帮助已经记下。";
                if (progress.ChoiceId is not null) summary += " 也记下了你选择的方向。";
            }
        }
        else options.Add(("打开完成的合册", () => this.ShowLongGoalCollection(npc, state)));
        for (int i = 0; i < 3; i++)
        {
            int index = i;
            if (state.Chapters[i].Outcome is not null) options.Add(($"重读第 {i + 1} 章：{state.Chapters[i].ResultTitle}", () => this.ReadLongGoalChapter(npc, state.Chapters[index])));
        }
        if (!this.config.LongGoals) summary += " 长期目标已暂停，完成的章节仍可阅读。";
        options.Add(("先忙你的，我以后再来", () => { }));
        this.LongGoalQuestion(npc, summary, options);
    }

    private void StartLongGoal(NPC npc, LongGoalDefinition goal)
    {
        if (!this.LongGoalMenusReady || !this.config.LongGoals || !LifeNear(npc) || this.lifeSave.LongGoals.ContainsKey(goal.Id) || !this.LongGoalSpace()) return;
        LifeEvent? dependency = this.LongGoalDependency(goal);
        if (!LongGoalRules.DependencyReady(goal, dependency, this.currentDay)) return;
        LongGoalState state = new() { StartId = "life-" + (this.lifeSave.Serial + 1), StartedDay = this.currentDay, DependencySourceId = dependency?.Id };
        this.lifeSave.LongGoals.Add(goal.Id, state);
        if (!this.LongGoalEvent(goal, "longgoal.started", dependency: dependency?.Id)) { this.lifeSave.LongGoals.Remove(goal.Id); return; }
        this.longGoalObservations.Remove(LongGoalIntervalKey(goal, 1)); this.longGoalWork.Remove(LongGoalIntervalKey(goal, 1));
        this.LifeNotice($"已记下：{goal.Title}。不参与时，对方也会按实际空闲时间继续。");
    }

    private void ReadLongGoalChapter(NPC npc, LongGoalChapterState chapter)
    {
        if (chapter.Outcome is null) return;
        this.LongGoalQuestion(npc, chapter.ResultTitle + "\n" + chapter.ResultText, new[] { ("读完这一章", (Action)(() => { })) });
    }
    private void ShowLongGoalCollection(NPC npc, LongGoalState state)
    {
        if (LongGoalRules.CurrentChapter(state) != 0) return;
        List<(string Label, Action Action)> options = state.Chapters.Select((chapter, i) =>
            ($"第 {i + 1} 章：{chapter.ResultTitle}", (Action)(() => this.ReadLongGoalChapter(npc, chapter)))).ToList();
        options.Add(("合上稿本", () => { }));
        this.LongGoalQuestion(npc, state.CollectionTitle + "\n" + state.CollectionIntro + "\n" + state.CollectionClosing, options);
    }

    private void ConfirmLongGoalObservation(NPC npc, LongGoalDefinition goal, LongGoalState state, int chapterId)
    {
        if (!this.LongGoalEditable(goal, state, chapterId, npc)) return;
        LongGoalChapter chapter = goal.Chapters[chapterId - 1]; LongGoalChapterState progress = state.Chapters[chapterId - 1];
        if (progress.ObservationId is null || progress.ContributionId is not null || chapter.Contribution.Kind != "observation") return;
        string place = chapter.Contribution.Venues.Single(v => v.Map == progress.ObservationVenue).Label;
        this.LongGoalQuestion(npc, $"告诉对方：我在{place}正常观察了 {progress.ObservationMinutes} 分钟，当时{RomanceRules.Weather(progress.ObservationWeather!)}。", new[]
        {
            ("把这次观察告诉对方", (Action)(() =>
            {
                if (!this.LongGoalEditable(goal, state, chapterId, npc) || progress.ObservationId is null || progress.ContributionId is not null || !this.LongGoalSpace()) return;
                progress.ContributionId = "life-" + (this.lifeSave.Serial + 1);
                if (!this.LongGoalEvent(goal, "longgoal.contributed", chapterId, chapter.Contribution.Id, source: progress.ObservationId))
                { progress.ContributionId = null; return; }
                this.LifeNotice("已经当面说明本章的观察。之后还可以另选一个方案。");
            })),
            ("先不说", (Action)(() => { })),
        });
    }

    private void ConfirmLongGoalMaterial(NPC npc, LongGoalDefinition goal, LongGoalState state, int chapterId)
    {
        if (!this.LongGoalEditable(goal, state, chapterId, npc)) return;
        LongGoalContribution contribution = goal.Chapters[chapterId - 1].Contribution;
        if (contribution.Kind != "material" || state.Chapters[chapterId - 1].ContributionId is not null) return;
        this.LongGoalQuestion(npc, $"一次交付并消耗 {contribution.Count} 份{contribution.Label}？用途：{contribution.Purpose}。这与普通送礼分开，不必为了项目勉强收集。", new[]
        {
            ("确认交付这些材料", (Action)(() => this.DeliverLongGoalMaterial(npc, goal, state, chapterId))),
            ("先不交", (Action)(() => { })),
        });
    }

    private void DeliverLongGoalMaterial(NPC npc, LongGoalDefinition goal, LongGoalState state, int chapterId)
    {
        if (!this.LongGoalEditable(goal, state, chapterId, npc) || !this.LongGoalSpace()) return;
        LongGoalContribution contribution = goal.Chapters[chapterId - 1].Contribution; LongGoalChapterState progress = state.Chapters[chapterId - 1];
        if (contribution.Kind != "material" || progress.ContributionId is not null) return;
        var stacks = Game1.player.Items.Select((item, slot) => (Item: item, Slot: slot, Stack: item?.Stack ?? 0))
            .Where(s => s.Item is not null && s.Item.QualifiedItemId == contribution.ItemId).ToArray();
        if (!LongGoalRules.Material(contribution.ItemId, contribution.ItemId, stacks.Sum(s => s.Stack), contribution.Count))
        { this.LifeNotice($"背包里还不够 {contribution.Count} 份{contribution.Label}，材料没有扣除。"); return; }
        try
        {
            bool saved = LongGoalRules.Deliver(stacks.Select(s => (s.Slot, s.Item!, s.Stack)).ToArray(), contribution.Count,
                (item, count) => item.Stack = count, (slot, item) => Game1.player.Items[slot] = item, () =>
            {
                progress.ContributionId = "life-" + (this.lifeSave.Serial + 1);
                return this.LongGoalEvent(goal, "longgoal.contributed", chapterId, contribution.Id, item: contribution.ItemId, count: contribution.Count);
            });
            if (!saved) { progress.ContributionId = null; return; }
        }
        catch (Exception ex)
        {
            progress.ContributionId = null;
            this.Monitor.Log("长期目标材料交付已撤销：" + ex.Message, LogLevel.Error); return;
        }
        this.LifeNotice($"已交付 {contribution.Count} 份{contribution.Label}。这份帮助已经记下，还可以另选本章方案。");
    }

    private void ChooseLongGoalDirection(NPC npc, LongGoalDefinition goal, LongGoalState state, int chapterId)
    {
        if (!this.LongGoalEditable(goal, state, chapterId, npc)) return;
        LongGoalChapterState progress = state.Chapters[chapterId - 1];
        if (progress.ContributionId is null || progress.ChoiceId is not null) return;
        List<(string Label, Action Action)> choices = goal.Chapters[chapterId - 1].Choices.Select(choice => (choice.Label, (Action)(() =>
        {
            if (!this.LongGoalEditable(goal, state, chapterId, npc) || progress.ContributionId is null || progress.ChoiceId is not null || !this.LongGoalSpace()) return;
            progress.ChoiceId = choice.Id;
            if (!this.LongGoalEvent(goal, "longgoal.choice", chapterId, source: progress.ContributionId, choice: choice.Id)) { progress.ChoiceId = null; return; }
            Game1.drawObjectDialogue(VanillaDialogue.Escape(choice.Text));
        }))).ToList();
        choices.Add(("先按你的想法继续", () => { }));
        this.LongGoalQuestion(npc, "这次帮助已经记下。你还想给这一章哪个方向？", choices);
    }

    private bool TryOpenTownFieldMenu()
    {
        if ((!this.StoryMenusReady || !this.config.TownStories) && (!this.LongGoalMenusReady || !this.config.LongGoals)
            || Game1.activeClickableMenu is not null || this.talk is not null || Game1.dialogueUp) return false;
        List<(string Label, Action Action)> choices = new();
        this.AddStoryFieldOptions(choices);
        if (this.LongGoalMenusReady && this.config.LongGoals)
            foreach (LongGoalDefinition goal in this.longGoals.Values)
            {
                if (!this.lifeSave.LongGoals.TryGetValue(goal.Id, out LongGoalState? state)) continue;
                int current = LongGoalRules.CurrentChapter(state);
                if (current == 0 || !this.LongGoalEditable(goal, state, current) || state.Chapters[current - 1].ObservationId is not null
                    || goal.Chapters[current - 1].Contribution.Kind != "observation") continue;
                choices.Add(($"观察：{goal.Title}·第 {current} 章", () => this.RecordLongGoalObservation(goal, state, current)));
            }
        if (choices.Count == 0) { this.LifeNotice("目前没有需要现场调查或观察的项目。"); return true; }
        choices.Add(("暂时不调查", () => { }));
        this.LongGoalQuestion(null, "想记下哪件事的现场观察？请实际到本章地点，正常观察一会儿。", choices, field: true);
        return true;
    }

    private void RecordLongGoalObservation(LongGoalDefinition goal, LongGoalState state, int chapterId)
    {
        if (!this.LongGoalEditable(goal, state, chapterId) || !this.LongGoalSpace()) return;
        LongGoalChapter chapter = goal.Chapters[chapterId - 1]; LongGoalChapterState progress = state.Chapters[chapterId - 1];
        string map = Game1.currentLocation.Name;
        if (progress.ObservationId is not null || chapter.Contribution.Kind != "observation") return;
        if (!this.longGoalObservations.TryGetValue(LongGoalIntervalKey(goal, chapterId), out StoryInterval? interval)
            || interval.Day != this.currentDay || interval.Map != map || !LongGoalRules.ObservationReady(chapter, interval.Minutes, map))
        { this.LifeNotice(chapter.Contribution.Hint + " 在同一地点正常观察满 10 游戏分钟后，再记下本章见闻。"); return; }
        progress.ObservationId = "life-" + (this.lifeSave.Serial + 1); progress.ObservationVenue = map;
        progress.ObservationWeather = GameState.Weather(); progress.ObservationMinutes = interval.Minutes;
        if (!this.LongGoalEvent(goal, "longgoal.observed", chapterId, chapter.Contribution.Id, venue: map,
            weather: progress.ObservationWeather, minutes: progress.ObservationMinutes))
        { progress.ObservationId = null; progress.ObservationVenue = null; progress.ObservationWeather = null; progress.ObservationMinutes = 0; return; }
        this.LifeNotice("本章现场观察已记下。回到对方面前明确告诉对方后，才算参与了这一章。");
    }

    private bool LongGoalWorkerEligible(LongGoalDefinition goal, LongGoalState state, int chapterId, NPC? npc)
    {
        if (npc is null || npc.currentLocation is null || npc.IsInvisible || !this.CanRecordLifeEvent) return false;
        LongGoalChapterState chapter = state.Chapters[chapterId - 1];
        bool controlled = npc.controller is not null || npc.temporaryController is not null || npc.ignoreScheduleToday
            || this.IsLifeActivityNpc(npc.Name) || this.Approaching(npc.Name) || this.sceneParticipants.Contains(npc.Name)
            || this.talk?.Npc == npc || this.offerFor == npc || this.startFor == npc
            || this.lifeActivityReturns.Any(r => r.Npc == npc)
            || this.meetings.TryGetValue(npc.Name, out Meeting? meeting) && !meeting.Reported && !meeting.Failed;
        bool building = npc.Name == "Robin" && (Game1.player.daysUntilHouseUpgrade.Value > 0
            || Game1.getFarm().buildings.Any(b => b.daysOfConstructionLeft.Value > 0 || b.daysUntilUpgrade.Value > 0));
        return LongGoalRules.Worker(this.LongGoalClockRunning, Game1.timeOfDay, npc.isSleeping.Value, npc.isMoving(), controlled, building)
            && LongGoalRules.Workplace(goal.Owner, npc.currentLocation.Name, LongGoalRules.ActualSpouse(goal.Owner, Game1.player.spouse, GameState.Relation(npc)))
            && chapter.Outcome is null && LongGoalRules.WorkDay(this.currentDay, LongGoalRules.OpenedDay(state, chapterId), chapter.WorkStep, chapter.LastWorkDay);
    }

    private void TickLongGoalIntervals()
    {
        if (!this.activeLoad || !Context.IsWorldReady) return;
        this.ReportLongGoalCompatibility();
        foreach (LongGoalDefinition goal in this.longGoals.Values)
        {
            if (!this.lifeSave.LongGoals.TryGetValue(goal.Id, out LongGoalState? state)) continue;
            int current = LongGoalRules.CurrentChapter(state);
            if (current == 0) continue;
            LongGoalChapterState chapter = state.Chapters[current - 1]; string key = LongGoalIntervalKey(goal, current);
            string map = Game1.currentLocation.Name;
            StoryInterval observation = this.StoryIntervalFor(this.longGoalObservations, key, map);
            observation.Whole &= this.LongGoalClockRunning && this.LongGoalEditable(goal, state, current)
                && goal.Chapters[current - 1].Contribution.Venues.Any(v => v.Map == map);
            NPC? npc = LongGoalNpc(goal); string workMap = npc?.currentLocation?.Name ?? "";
            int retained = LongGoalRules.Accumulate(chapter.WorkMinutes, chapter.WorkAccumDay, chapter.WorkMap, this.currentDay, workMap, 0);
            if (retained != chapter.WorkMinutes)
            { chapter.WorkMinutes = retained; chapter.WorkMap = null; chapter.WorkAccumDay = this.currentDay; this.PersistLife(); }
            StoryInterval work = this.StoryIntervalFor(this.longGoalWork, key, workMap);
            work.Whole &= this.LongGoalWorkerEligible(goal, state, current, npc);
            if (chapter.WorkStep == 2 && this.config.LongGoals && this.LongGoalMenusReady && this.CanRecordLifeEvent
                && this.CompleteLongGoalChapter(goal, state, current)) this.LifeNotice($"{goal.Title}的第 {current} 章已经写好，下次见面可以读一读。");
        }
    }

    private void LongGoalsTimeChanged()
    {
        if (!this.activeLoad || !Context.IsWorldReady) return;
        foreach (LongGoalDefinition goal in this.longGoals.Values)
        {
            if (!this.lifeSave.LongGoals.TryGetValue(goal.Id, out LongGoalState? state)) continue;
            int current = LongGoalRules.CurrentChapter(state); if (current == 0) continue;
            LongGoalChapterState chapter = state.Chapters[current - 1]; string key = LongGoalIntervalKey(goal, current);
            string map = Game1.currentLocation.Name;
            StoryInterval observation = this.StoryIntervalFor(this.longGoalObservations, key, map);
            bool observe = this.LongGoalClockRunning && this.LongGoalEditable(goal, state, current) && chapter.ObservationId is null
                && goal.Chapters[current - 1].Contribution.Venues.Any(v => v.Map == map);
            observation.Minutes = Math.Min(10, observation.Minutes + LongGoalRules.ClockStep(observation.LastTime, Game1.timeOfDay,
                observation.Whole && observe, observation.Day, this.currentDay, observation.Map, map, false));
            observation.LastTime = Game1.timeOfDay; observation.Whole = observe;
            NPC? npc = LongGoalNpc(goal); string workMap = npc?.currentLocation?.Name ?? "";
            StoryInterval work = this.StoryIntervalFor(this.longGoalWork, key, workMap);
            bool eligible = this.LongGoalWorkerEligible(goal, state, current, npc);
            int added = LongGoalRules.ClockStep(work.LastTime, Game1.timeOfDay, work.Whole && eligible, work.Day, this.currentDay, work.Map, workMap, true);
            work.LastTime = Game1.timeOfDay; work.Whole = eligible;
            if (added == 0) continue;
            chapter.WorkMinutes = LongGoalRules.Accumulate(chapter.WorkMinutes, chapter.WorkAccumDay, chapter.WorkMap, this.currentDay, workMap, added);
            chapter.WorkAccumDay = this.currentDay; chapter.WorkMap = workMap;
            if (chapter.WorkMinutes < 30) { this.PersistLife(); continue; }
            int oldStep = chapter.WorkStep, oldDay = chapter.LastWorkDay;
            chapter.WorkStep++; chapter.LastWorkDay = this.currentDay; chapter.WorkMinutes = 0; chapter.WorkMap = null;
            if (!this.LongGoalEvent(goal, "longgoal.worked", current, venue: workMap, minutes: 30, step: chapter.WorkStep))
            { chapter.WorkStep = oldStep; chapter.LastWorkDay = oldDay; chapter.WorkMinutes = 30; chapter.WorkMap = workMap; }
            work.Whole = false;
        }
    }

    private bool CompleteLongGoalChapter(LongGoalDefinition goal, LongGoalState state, int chapterId)
    {
        LongGoalChapterState chapter = state.Chapters[chapterId - 1];
        if (chapter.WorkStep != 2 || chapter.Outcome is not null || !this.CanRecordLifeEvent) return false;
        LongGoalChapter definition = goal.Chapters[chapterId - 1]; string outcome = LongGoalRules.Outcome(chapter.ChoiceId);
        LongGoalOutput output = definition.Outputs.Single(o => o.Id == outcome);
        chapter.CompletionId = "life-" + (this.lifeSave.Serial + 1); chapter.CompletedDay = this.currentDay;
        chapter.Outcome = outcome; chapter.ResultTitle = output.Title; chapter.ResultText = output.Text + LongGoalRules.ContributionNote(definition, chapter);
        if (chapterId == 3)
        { state.CollectionTitle = goal.CollectionTitle; state.CollectionIntro = goal.CollectionIntro; state.CollectionClosing = goal.CollectionClosing; }
        if (!this.LongGoalEvent(goal, "longgoal.completed", chapterId, outcome: outcome))
        {
            chapter.CompletionId = null; chapter.CompletedDay = 0; chapter.Outcome = null; chapter.ResultTitle = null; chapter.ResultText = null;
            if (chapterId == 3) { state.CollectionTitle = null; state.CollectionIntro = null; state.CollectionClosing = null; }
            return false;
        }
        this.longGoalObservations.Remove(LongGoalIntervalKey(goal, chapterId)); this.longGoalWork.Remove(LongGoalIntervalKey(goal, chapterId));
        return true;
    }
}
