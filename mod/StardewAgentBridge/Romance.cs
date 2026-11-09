using System;
using System.Collections.Generic;
using System.Linq;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>Explicit romantic plans. Dialogue cannot silently create a date or a past relationship milestone.</summary>
internal sealed partial class ModEntry
{
    private sealed class RomanceVenue
    {
        public string Map { get; set; } = "";
        public string Label { get; set; } = "";
    }

    private sealed class RomanceProfile
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public string Opening { get; set; } = "";
        public string Invitation { get; set; } = "";
        public string Closing { get; set; } = "";
        public string Focus { get; set; } = "quiet";
        public List<RomanceVenue> Venues { get; set; } = new();
    }

    private sealed class RomancePlan
    {
        public string Id { get; set; } = "";
        public string Stage { get; set; } = "planned";
        public string Venue { get; set; } = "";
        public int Day { get; set; }
        public int Time { get; set; }
        public string Preparation { get; set; } = "quiet";
        public string Initiator { get; set; } = "player";
        public string? SourceId { get; set; }
    }

    private sealed class RomanceState
    {
        public RomancePlan? Plan { get; set; }
        public int LastInvitationDay { get; set; }
    }

    private readonly Dictionary<string, RomanceProfile> romanceProfiles = new(StringComparer.Ordinal);
    private bool romanceSupported;
    private bool romanceUpgradeNotified;
    private bool RomanceCompatible => RomanceRules.Compatible(this.romanceSupported, this.lifeEvents);

    private void ReportRomanceCompatibility()
    {
        if (this.RomanceCompatible || this.romanceUpgradeNotified || !Context.IsWorldReady) return;
        this.romanceUpgradeNotified = true;
        this.Monitor.Log("当前存档含恋爱记录，请更新后端后再同步；原始记录保留。", LogLevel.Warn);
        Game1.addHUDMessage(new HUDMessage("恋爱记录需要新版后端，请同时更新后端和 Mod。", HUDMessage.error_type));
    }

    private void LoadRomanceProfiles()
    {
        this.romanceProfiles.Clear();
        try
        {
            List<RomanceProfile>? profiles = this.Helper.Data.ReadJsonFile<List<RomanceProfile>>("assets/romance-profiles.json");
            if (profiles is null || profiles.Count != RomanceRules.Npcs.Count)
                throw new InvalidOperationException("恋爱资料未包含完整角色名单。");
            foreach (RomanceProfile p in profiles)
            {
                if (!RomanceRules.Npcs.Contains(p.Id) || this.romanceProfiles.ContainsKey(p.Id)
                    || !RomanceRules.Preparation(p.Focus) || p.Venues is null || p.Venues.Count != 2
                    || p.Venues.Select(v => v.Map).Distinct().Count() != 2
                    || p.Venues.Any(v => !RomanceRules.Venues.Contains(v.Map) || string.IsNullOrWhiteSpace(v.Label))
                    || new[] { p.Name, p.Opening, p.Invitation, p.Closing }.Any(text => string.IsNullOrWhiteSpace(text) || text.Length > 400))
                    throw new InvalidOperationException("恋爱资料内容无效：" + p.Id);
                this.romanceProfiles.Add(p.Id, p);
            }
        }
        catch (Exception ex)
        {
            this.romanceProfiles.Clear();
            this.Monitor.Log("恋爱菜单暂停，原版与生活功能不受影响：" + ex.Message, LogLevel.Warn);
        }
    }

    private void ValidateRomanceSave()
    {
        if (this.lifeSave.RomanceInvitationDay < 0 || this.lifeSave.RomanceInvitationDay > AbsoluteDay())
            throw new InvalidOperationException("恋爱邀约日期无效。");
        foreach (var pair in this.lifeSave.Romance)
        {
            if (!RomanceRules.Npcs.Contains(pair.Key) || pair.Value is null || pair.Value.LastInvitationDay < 0
                || pair.Value.LastInvitationDay > AbsoluteDay())
                throw new InvalidOperationException("恋爱保存记录无效。");
            RomancePlan? p = pair.Value.Plan;
            if (p is null) continue;
            if (!p.Id.StartsWith("date-", StringComparison.Ordinal) || !long.TryParse(p.Id.AsSpan(5), out long serial)
                || serial < 1 || serial > this.lifeSave.Serial || p.Id != "date-" + serial
                || p.Stage is not ("planned" or "started") || !RomanceRules.Venues.Contains(p.Venue)
                || p.Day < 1 || p.Day > AbsoluteDay() + 1 || Array.IndexOf(RomanceRules.Times, p.Time) < 0
                || !RomanceRules.Preparation(p.Preparation) || p.Initiator is not ("player" or "npc")
                || !this.lifeEvents.Any(e => e.Kind == "romance.planned" && e.Npc == pair.Key && e.DateId == p.Id))
                throw new InvalidOperationException("恋爱计划内容无效；原始记录保留。");
        }
    }

    private RomanceState RomanceFor(NPC npc)
    {
        string id = npc.Name.ToLowerInvariant();
        if (!this.lifeSave.Romance.TryGetValue(id, out RomanceState? state))
            this.lifeSave.Romance[id] = state = new();
        return state;
    }

    private bool Romantic(NPC npc) => RomanceRules.Eligible(npc.Name.ToLowerInvariant(), GameState.Relation(npc));
    private bool CanStartRomance(NPC npc) => this.config.Romance && this.lifeSupported && this.romanceSupported && this.CanChat
        && this.RomanticProfile(npc) is not null && this.Romantic(npc) && LifeNear(npc)
        && !ColdShoulder(npc.Name) && !Game1.eventUp && !Game1.isFestival();
    private RomanceProfile? RomanticProfile(NPC npc) => this.romanceProfiles.GetValueOrDefault(npc.Name.ToLowerInvariant());

    private bool HasRomanceEntry(NPC npc) => this.romanceSupported && this.RomanticProfile(npc) is not null
        && (this.config.Romance && this.Romantic(npc)
            || this.lifeSave.Romance.GetValueOrDefault(npc.Name.ToLowerInvariant())?.Plan is not null
            || this.lifeEvents.Any(e => e.Npc == npc.Name.ToLowerInvariant() && e.Kind == "romance.completed"));

    private bool RomanceJournalSpace(int count = 1)
    {
        if (this.CanRecordLifeEvents(count)) return true;
        this.LifeNotice("生活记录暂时不能新增。现有记录会保留，正在进行的活动仍可以结束。");
        return false;
    }

    private void RomanceChoice(NPC npc, string text, IReadOnlyList<string> choices, Action<int> chosen, bool newAction = true)
    {
        this.LifeQuestion(npc, text, choices, index =>
        {
            if (newAction ? !this.CanStartRomance(npc) : !this.romanceSupported || !this.CanChat || !LifeNear(npc))
                return;
            chosen(index);
        });
    }

    private bool TryOfferRomanceInvitation(NPC npc)
    {
        if (!this.CanStartRomance(npc) || !this.CanRecordLifeEvent || this.lifeActivity is not null || this.lifeContinuation is not null)
            return false;
        RomanceState state = this.RomanceFor(npc);
        if (state.Plan is not null || !RomanceRules.Invite(this.currentDay, state.LastInvitationDay, this.lifeSave.RomanceInvitationDay))
            return false;
        int previous = state.LastInvitationDay, previousGlobal = this.lifeSave.RomanceInvitationDay;
        state.LastInvitationDay = this.currentDay;
        this.lifeSave.RomanceInvitationDay = this.currentDay;
        try { this.PersistLife(); }
        catch { state.LastInvitationDay = previous; this.lifeSave.RomanceInvitationDay = previousGlobal; return false; }
        this.RomanceChoice(npc, this.RomanticProfile(npc)!.Invitation,
            new[] { "一起安排一次约会", "今天先聊聊天", "改天再说" }, choice =>
            {
                if (choice == 0) this.PlanRomance(npc, null, "npc", null);
                else if (choice == 1) this.startFor = npc;
            });
        return true;
    }

    private void ShowRomance(NPC npc)
    {
        if (!this.romanceSupported || !this.CanChat || !LifeNear(npc) || this.RomanticProfile(npc) is null)
            return;
        RomanceState state = this.RomanceFor(npc);
        if (this.lifeActivity is { RomanceDateId: not null } active && active.Npc == npc)
        { this.ShowLifeActivities(npc); return; }
        if (state.Plan is RomancePlan plan)
        {
            if (!this.Romantic(npc))
            { this.CancelRomance(npc, plan, "relationship"); this.LifeNotice("关系已经改变，未完成的恋爱安排已结束。"); return; }
            List<(string Label, Action Action)> choices = new();
            if (this.config.Romance)
            {
                choices.Add(("按计划一起出发", () => this.StartRomance(npc, plan)));
                choices.Add(("一起改个时间或地点", () => this.PlanRomance(npc, plan, plan.Initiator, plan.SourceId)));
            }
            choices.Add(("取消这次约会", () => this.ConfirmCancelRomance(npc, plan)));
            choices.Add(("回看共同回忆", () => this.ShowRomanceMemories(npc)));
            choices.Add(("以后再说", () => { }));
            string text = $"约好第 {plan.Day} 天 {plan.Time / 100:00}:{plan.Time % 100:00} 去{RomanceRules.Place(plan.Venue)}，{PreparationLabel(plan.Preparation)}。到时在我身边一起出发，到了那里再慢慢走。";
            this.RomanceChoice(npc, text, choices.Select(c => c.Label).ToArray(), i => choices[i].Action(), newAction: false);
            return;
        }
        List<(string Label, Action Action)> menu = new();
        if (this.CanStartRomance(npc)) menu.Add(("一起安排一次约会", () => this.PlanRomance(npc, null, "player", null)));
        LifeEvent? pending = this.PendingRomanceMemory(npc);
        if (pending is not null && this.CanStartRomance(npc)) menu.Add(("选一个想记住的片段", () => this.RememberRomance(npc, pending)));
        menu.Add(("回看共同回忆", () => this.ShowRomanceMemories(npc)));
        menu.Add(("先不安排", () => { }));
        this.RomanceChoice(npc, this.Romantic(npc) ? "可以一起商量下一次约会，也可以回看我们真正经历过的日子。" : "这里保留的是过去已经发生的共同经历。",
            menu.Select(c => c.Label).ToArray(), i => menu[i].Action(), newAction: false);
    }

    private static string PreparationLabel(string value) => value == "talk" ? "留些时间聊聊" : "安静地陪着彼此";

    private void PlanRomance(NPC npc, RomancePlan? replacing, string initiator, string? sourceId)
    {
        if (!this.CanStartRomance(npc) || this.lifeActivity is not null || this.lifeContinuation is not null)
        { this.LifeNotice("先结束正在进行的活动，再一起商量约会吧。"); return; }
        if (!this.RomanceJournalSpace()) return;
        RomanceProfile profile = this.RomanticProfile(npc)!;
        LifeEvent? source = sourceId is null ? null : this.RomanceMemories(npc).FirstOrDefault(e => e.Id == sourceId);
        if (sourceId is not null && source is null) return;
        RomanceVenue[] venues = source is null ? profile.Venues.ToArray()
            : profile.Venues.Where(v => v.Map == source.Venue).ToArray();
        if (venues.Length == 0) return;
        string text = source is null ? profile.Opening : $"再去{RomanceRules.Place(source.Venue!)}一次，看看这回会留下什么回忆。";
        this.RomanceChoice(npc, text, venues.Select(v => v.Label).Append("先不安排").ToArray(), venueChoice =>
        {
            if (venueChoice >= venues.Length) return;
            RomanceVenue venue = venues[venueChoice];
            this.RomanceChoice(npc, "选哪一天？约好后也可以提前商量改期。", new[] { "今天", "明天", "先不安排" }, dayChoice =>
            {
                if (dayChoice > 1) return;
                int day = this.currentDay + dayChoice;
                int[] times = RomanceRules.Times.Where(time => RomanceRules.Plan(this.currentDay, day, time, Game1.timeOfDay)).ToArray();
                if (times.Length == 0) { this.LifeNotice("今天可选的时段已经过去，改约明天吧。"); return; }
                this.RomanceChoice(npc, "到时我们在彼此身边碰面，再一起出发。选哪个时间？",
                    times.Select(time => $"{time / 100:00}:{time % 100:00}").Append("先不安排").ToArray(), timeChoice =>
                    {
                        if (timeChoice >= times.Length) return;
                        int time = times[timeChoice];
                        string[] preparations = profile.Focus == "quiet" ? new[] { "quiet", "talk" } : new[] { "talk", "quiet" };
                        this.RomanceChoice(npc, "想怎么度过这段时间？不用准备礼物，留出时间就好。",
                            preparations.Select(PreparationLabel).Append("先不安排").ToArray(), preparationChoice =>
                            {
                                if (preparationChoice >= preparations.Length) return;
                                string preparation = preparations[preparationChoice];
                                this.RomanceChoice(npc, $"第 {day} 天 {time / 100:00}:{time % 100:00}，一起去{RomanceRules.Place(venue.Map)}，{PreparationLabel(preparation)}。在目的地实际相处 30 分钟，这样约好吗？",
                                    new[] { "就这样约好", "再想想" }, confirm =>
                                    {
                                        if (confirm == 0) this.CommitRomancePlan(npc, replacing, initiator, sourceId, venue.Map, day, time, preparation);
                                    });
                            });
                    });
            });
        });
    }

    private void CommitRomancePlan(NPC npc, RomancePlan? replacing, string initiator, string? sourceId, string venue, int day, int time, string preparation)
    {
        if (!this.CanStartRomance(npc) || !RomanceRules.Plan(this.currentDay, day, time, Game1.timeOfDay)
            || !this.RomanceJournalSpace()) return;
        RomanceState state = this.RomanceFor(npc);
        if (!ReferenceEquals(state.Plan, replacing) || replacing is { Stage: not "planned" }) return;
        int otherPlans = this.lifeSave.Romance.Values.Count(s => s.Plan is { Stage: "planned" } p && p.Day == day && p != replacing);
        if (otherPlans >= MeetsPerDay || day == this.currentDay && otherPlans + this.LifeActivityStartsToday + this.meetings.Values.Count(m => !m.Surprise) >= MeetsPerDay)
        { this.LifeNotice("这一天安排已经够多了，改个日子吧。"); return; }
        if (sourceId is not null && !this.RomanceMemories(npc).Any(e => e.Id == sourceId && e.Venue == venue)) return;
        RomancePlan plan = new()
        {
            Id = replacing?.Id ?? "date-" + (this.lifeSave.Serial + 1), Venue = venue, Day = day, Time = time,
            Preparation = preparation, Initiator = initiator, SourceId = sourceId,
        };
        state.Plan = plan;
        LifeEvent entry = new()
        {
            Npc = npc.Name.ToLowerInvariant(), Kind = replacing is null ? "romance.planned" : "romance.rescheduled",
            DateId = plan.Id, Venue = venue, DateDay = day, Time = time, Preparation = preparation,
            Relation = GameState.Relation(npc), Initiator = initiator, SourceId = replacing is null ? sourceId : null,
        };
        if (!this.AppendLifeEvent(entry)) { state.Plan = replacing; return; }
        this.LifeNotice($"已和{npc.displayName}约好第 {day} 天 {time / 100:00}:{time % 100:00} 出发去{RomanceRules.Place(venue)}。");
    }

    private void StartRomance(NPC npc, RomancePlan plan)
    {
        if (!this.CanStartRomance(npc) || this.RomanceFor(npc).Plan != plan || plan.Stage != "planned") return;
        if (!RomanceRules.Depart(this.currentDay, plan.Day, plan.Time, Game1.timeOfDay))
        { this.LifeNotice("请在约定当天的出发时间起一小时内，来到对方身边；也可以提前改期。"); return; }
        if (!this.RomanceJournalSpace(2) || !this.TryStartLifeActivity(npc, "romantic_date", romanceDateId: plan.Id, romanceVenue: plan.Venue)) return;
        plan.Stage = "started";
        if (!this.AppendLifeEvent(new LifeEvent
        {
            Npc = npc.Name.ToLowerInvariant(), Kind = "romance.started", DateId = plan.Id,
            Venue = plan.Venue, Relation = GameState.Relation(npc), Time = Game1.timeOfDay,
        }))
        {
            plan.Stage = "planned";
            if (this.lifeActivity is { } activity) { this.lifeActivity = null; this.ReleaseLifeActor(activity); }
            this.UndoLifeActivitySlot();
            return;
        }
        this.LifeNotice($"一起出发去{RomanceRules.Place(plan.Venue)}；到了那里，实际在一起的时间才计入约会。");
    }

    private void ConfirmCancelRomance(NPC npc, RomancePlan plan)
    {
        this.RomanceChoice(npc, "取消这次安排吗？正常取消不会算成失约。", new[] { "取消约会", "保留安排" }, choice =>
        {
            if (choice == 0) this.CancelRomance(npc, plan, "player");
        }, newAction: false);
    }

    private bool CancelRomance(NPC npc, RomancePlan plan, string reason)
    {
        RomanceState state = this.RomanceFor(npc);
        if (state.Plan != plan) return false;
        if (this.lifeActivity is { } activity && activity.RomanceDateId == plan.Id && activity.Npc == npc)
        { this.FinishLifeActivity(allowComplete: false, cancelReason: reason); return state.Plan is null; }
        state.Plan = null;
        if (!this.AppendLifeEvent(new LifeEvent { Npc = npc.Name.ToLowerInvariant(), Kind = "romance.cancelled", DateId = plan.Id, Reason = reason }))
        { state.Plan = plan; return false; }
        return true;
    }

    private void FinishRomanceDate(LifeActivitySession activity, bool allowComplete, string cancelReason)
    {
        NPC npc = activity.Npc;
        RomanceState state = this.RomanceFor(npc);
        RomancePlan? plan = state.Plan;
        bool matching = plan is { Stage: "started" } && plan.Id == activity.RomanceDateId;
        bool completed = matching && allowComplete && RomanceRules.Complete(activity.Minutes,
            LifeActivityRules.SameSession(activity.Nonce, activity.Day, this.loadNonce, this.currentDay), this.Romantic(npc));
        int previousPoints = Game1.player.friendshipData.TryGetValue(npc.Name, out Friendship? relation) ? relation.Points : 0;
        int previousBudget = this.friendshipToday.GetValueOrDefault(npc.Name);
        if (!this.Romantic(npc)) cancelReason = "relationship";
        int friendship = completed ? this.LifeActivityFriendship(npc, met: true) : 0;
        bool recorded = false;
        if (matching)
        {
            state.Plan = null;
            LifeEvent entry = completed ? new()
            {
                Npc = npc.Name.ToLowerInvariant(), Kind = "romance.completed", DateId = plan!.Id, Venue = plan.Venue,
                Relation = GameState.Relation(npc), Weather = GameState.Weather(), Minutes = activity.Minutes, Friendship = friendship,
            } : new() { Npc = npc.Name.ToLowerInvariant(), Kind = "romance.cancelled", DateId = plan!.Id, Reason = cancelReason };
            recorded = this.AppendLifeEvent(entry);
            if (!recorded) state.Plan = plan;
        }
        if (!recorded)
        {
            if (relation is not null) relation.Points = previousPoints;
            this.friendshipToday[npc.Name] = previousBudget;
        }
        this.lifeActivity = null;
        this.ReleaseLifeActor(activity);
        if (recorded && completed)
        {
            if (this.RomanticProfile(npc) is { } profile)
                npc.showTextAboveHead(VanillaDialogue.Escape(profile.Closing));
            this.LifeNotice($"和{npc.displayName}完成了约会。下次交谈时，可以选一个想共同记住的片段。");
        }
        else this.LifeNotice("这次约会已经结束，没有记成完成或失约。");
    }

    private void TickRomance()
    {
        if (this.memoryReady && this.bridge.IsConnected) this.ReportRomanceCompatibility();
        if (!this.CanRecordLifeEvent) return;
        foreach (var pair in this.lifeSave.Romance.ToArray())
        {
            if (pair.Value.Plan is not RomancePlan plan) continue;
            string? name = SocialNpcs.FirstOrDefault(name => name.Equals(pair.Key, StringComparison.OrdinalIgnoreCase));
            NPC? npc = name is null ? null : Game1.getCharacterFromName(name);
            if (npc is null) continue;
            if (!this.Romantic(npc)) this.CancelRomance(npc, plan, "relationship");
            else if (plan.Stage == "started" && !(this.lifeActivity?.Npc == npc && this.lifeActivity.RomanceDateId == plan.Id))
                this.CancelRomance(npc, plan, "interrupted");
            else if (plan.Stage == "planned" && RomanceRules.Expired(this.currentDay, plan.Day, plan.Time, Game1.timeOfDay))
                this.CancelRomance(npc, plan, "expired");
        }
    }

    private List<LifeEvent> RomanceMemories(NPC npc) => RomanceRules.Memories(this.lifeEvents, npc.Name.ToLowerInvariant());

    private LifeEvent? PendingRomanceMemory(NPC npc) => this.RomanceMemories(npc).LastOrDefault(completed =>
        !this.lifeEvents.Any(e => e.Kind == "romance.remembered" && e.Npc == completed.Npc && e.SourceId == completed.Id));

    private void RememberRomance(NPC npc, LifeEvent source)
    {
        if (!this.CanStartRomance(npc) || !RomanceRules.Rememberable(this.lifeEvents, npc.Name.ToLowerInvariant(), source)) return;
        if (!this.RomanceJournalSpace()) return;
        this.RomanceChoice(npc, $"回想第 {source.Day} 天在{RomanceRules.Place(source.Venue!)}的约会，你最想记住哪个片段？",
            new[] { "一起去过的地方", "那天的天气", "为彼此留下的时间", "以后再选" }, choice =>
            {
                if (choice > 2 || !RomanceRules.Rememberable(this.lifeEvents, npc.Name.ToLowerInvariant(), source)
                    || !this.RomanceJournalSpace()) return;
                if (this.AppendLifeEvent(new LifeEvent
                {
                    Npc = npc.Name.ToLowerInvariant(), Kind = "romance.remembered", DateId = source.DateId,
                    SourceId = source.Id, Detail = new[] { "place", "weather", "company" }[choice],
                })) this.LifeNotice("这个片段已经记下。以后可以一起回看，也可以再去那个地方。");
            });
    }

    private void ShowRomanceMemories(NPC npc)
    {
        List<LifeEvent> all = this.RomanceMemories(npc);
        if (all.Count == 0) { this.LifeNotice("还没有记录过完整约会。从下一次真正共同经历的日子开始记吧。"); return; }
        List<LifeEvent> shown = all.TakeLast(3).Prepend(all[0]).DistinctBy(e => e.Id).ToList();
        this.RomanceChoice(npc, "这些是实际完成过的约会。记录日期不是交往开始日。",
            shown.Select(e => $"第 {e.Day} 天 · {RomanceRules.Place(e.Venue!)}").Append("返回").ToArray(), choice =>
            {
                if (choice >= shown.Count) return;
                LifeEvent source = shown[choice];
                LifeEvent? selected = this.lifeEvents.LastOrDefault(e => e.Kind == "romance.remembered" && e.Npc == source.Npc && e.SourceId == source.Id);
                string detail = selected?.Detail switch { "place" => "你选择记住一起去过的地方。", "weather" => "你选择记住那天的天气。", "company" => "你选择记住为彼此留下的时间。", _ => "还没有选择特别想保留的片段。" };
                List<(string Label, Action Action)> options = new();
                if (this.CanStartRomance(npc) && this.RomanceFor(npc).Plan is null)
                    options.Add(("再约一次，重访这里", () => this.PlanRomance(npc, null, "player", source.Id)));
                if (this.CanStartRomance(npc) && selected is null)
                    options.Add(("选一个想记住的片段", () => this.RememberRomance(npc, source)));
                options.Add(("知道了", () => { }));
                string text = $"第 {source.Day} 天，{RomanceRules.Weather(source.Weather!)}，我们在{RomanceRules.Place(source.Venue!)}实际相处了 {source.Minutes} 分钟。{detail}";
                if (!this.Romantic(npc)) text = "这是过去的共同经历。" + text;
                this.RomanceChoice(npc, text, options.Select(o => o.Label).ToArray(), i => options[i].Action(), newAction: false);
            }, newAction: false);
    }
}
