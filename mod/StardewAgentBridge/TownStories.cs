using System;
using System.Collections.Generic;
using System.Linq;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.GameData.Objects;

namespace StardewAgentBridge;

/// <summary>Story actions use native menus and observed game facts; generated dialogue never executes them.</summary>
internal sealed partial class ModEntry
{
    private sealed class TownStoryFile
    {
        public int Version { get; set; }
        public List<TownStoryTemplate> Stories { get; set; } = new();
    }
    private sealed class TownStoryTemplate
    {
        public string Id { get; set; } = "";
        public string Kind { get; set; } = "";
        public string Owner { get; set; } = "";
        public string Title { get; set; } = "";
        public string Opening { get; set; } = "";
        public List<string> References { get; set; } = new();
        public List<TownStoryClue> Clues { get; set; } = new();
        public TownStorySite? Site { get; set; }
        public List<TownStoryVenue> ObservationVenues { get; set; } = new();
        public List<string> WorkVenues { get; set; } = new();
        public List<TownStoryChoice> Choices { get; set; } = new();
        public List<TownStoryEnding> Endings { get; set; } = new();
    }
    private sealed class TownStoryClue
    {
        public string Id { get; set; } = "";
        public string? Witness { get; set; }
        public string Text { get; set; } = "";
    }
    private sealed class TownStorySite
    {
        public string Map { get; set; } = "";
        public int X { get; set; }
        public int Y { get; set; }
        public int Radius { get; set; }
        public string Label { get; set; } = "";
        public string Hint { get; set; } = "";
    }
    private sealed class TownStoryVenue
    {
        public string Map { get; set; } = "";
        public string Label { get; set; } = "";
    }
    private sealed class TownStoryChoice
    {
        public string Id { get; set; } = "";
        public string Label { get; set; } = "";
        public string Text { get; set; } = "";
    }
    private sealed class TownStoryEnding
    {
        public string Id { get; set; } = "";
        public string Title { get; set; } = "";
        public string Text { get; set; } = "";
    }
    private sealed class TownStoryState
    {
        public string StartId { get; set; } = "";
        public int StartedDay { get; set; }
        public Dictionary<string, string> Clues { get; set; } = new();
        public string? ObservationId { get; set; }
        public string? ObservationVenue { get; set; }
        public string? ObservationWeather { get; set; }
        public string? ChoiceId { get; set; }
        public int WorkStep { get; set; }
        public int LastWorkDay { get; set; }
        public int WorkMinutes { get; set; }
        public int WorkAccumDay { get; set; }
        public string? WorkMap { get; set; }
        public string? Outcome { get; set; }
        public string? ResultTitle { get; set; }
        public string? ResultText { get; set; }
        public HashSet<string> Reported { get; set; } = new();
    }
    private sealed class StoryInterval
    {
        public int Day;
        public int LastTime;
        public string Map = "";
        public bool Whole;
        public int Minutes;
    }

    private readonly Dictionary<string, TownStoryTemplate> townStories = new(StringComparer.Ordinal);
    private readonly Dictionary<string, StoryInterval> storyObservations = new(StringComparer.Ordinal);
    private readonly Dictionary<string, StoryInterval> storyWorkIntervals = new(StringComparer.Ordinal);
    private bool storiesSupported;
    private bool storiesUpgradeNotified;
    private int storyMenuGeneration;
    private bool StoriesCompatible => TownStoryRules.Compatible(this.storiesSupported, this.lifeEvents);
    private bool StoryMenusReady => this.activeLoad && Context.IsWorldReady && this.lifeSupported && this.storiesSupported
        && this.CanChat && !Game1.eventUp && !Game1.isFestival();

    private void LoadTownStories()
    {
        this.townStories.Clear();
        try
        {
            TownStoryFile? file = this.Helper.Data.ReadJsonFile<TownStoryFile>("assets/town-stories.json");
            if (file is null || file.Version != 1 || file.Stories is null || file.Stories.Count != 3)
                throw new InvalidOperationException("缺少完整的小镇故事资料。");
            foreach (TownStoryTemplate story in file.Stories)
            {
                if (!TownStoryRules.Owners.TryGetValue(story.Id, out string? owner) || story.Owner != owner || this.townStories.ContainsKey(story.Id)
                    || string.IsNullOrWhiteSpace(story.Title) || string.IsNullOrWhiteSpace(story.Opening)
                    || story.Endings is null || story.Endings.Count < 2 || story.Endings.Any(e => string.IsNullOrWhiteSpace(e.Id) || string.IsNullOrWhiteSpace(e.Text))
                    || story.Endings.Select(e => e.Id).Distinct().Count() != story.Endings.Count)
                    throw new InvalidOperationException("小镇故事资料无效：" + story.Id);
                if (story.Id == "gus_parcel")
                {
                    if (story.Kind != "investigation" || story.Site is null || story.Site.Map != "Town" || story.Site.Radius is < 1 or > 10
                        || story.Clues is null || story.Clues.Count != 3 || story.Clues.Select(c => c.Id).Distinct().Count() != 3
                        || !story.Clues.Any(c => c.Id == "emily_mark" && c.Witness == "emily")
                        || !story.Clues.Any(c => c.Id == "pierre_mark" && c.Witness == "pierre")
                        || !story.Clues.Any(c => c.Id == "parcel" && c.Witness is null)
                        || !new[] { "returned", "explained" }.All(id => story.Endings.Any(e => e.Id == id)))
                        throw new InvalidOperationException("包裹调查资料无效。");
                }
                else if (story.Kind != "project" || story.WorkVenues is null || story.WorkVenues.Count == 0
                    || story.ObservationVenues is null || story.ObservationVenues.Count != 2 || story.Choices is null || story.Choices.Count != 2
                    || story.Choices.Select(c => c.Id).Distinct().Count() != 2
                    || !story.Endings.Any(e => e.Id == "independent") || story.Choices.Any(c => !story.Endings.Any(e => e.Id == c.Id)))
                    throw new InvalidOperationException("长期目标资料无效。");
                this.townStories.Add(story.Id, story);
            }
        }
        catch (Exception ex)
        {
            this.townStories.Clear();
            this.Monitor.Log("小镇故事暂停，其他功能保持可用：" + ex.Message, LogLevel.Warn);
        }
    }

    private void ValidateStorySave()
    {
        foreach (var pair in this.lifeSave.Stories)
        {
            TownStoryState state = pair.Value;
            if (!TownStoryRules.Owners.TryGetValue(pair.Key, out string? owner) || state is null
                || state.StartedDay < 1 || state.StartedDay > AbsoluteDay() || state.Clues is null || state.Reported is null
                || !this.lifeEvents.Any(e => e.Id == state.StartId && e.Kind == "story.started" && e.StoryId == pair.Key && e.Npc == owner && e.Day == state.StartedDay)
                || state.WorkStep is < 0 or > 2 || state.WorkMinutes is < 0 or > 30
                || state.WorkAccumDay < 0 || state.WorkAccumDay > AbsoluteDay()
                || state.WorkStep == 0 && state.LastWorkDay != 0 || state.WorkStep > 0 && (state.LastWorkDay <= state.StartedDay || state.LastWorkDay > AbsoluteDay())
                || state.Clues.Any(c => !this.lifeEvents.Any(e => e.Id == c.Value && e.Kind == "story.clue" && e.ClueId == c.Key && e.StoryId == pair.Key))
                || state.ObservationId is not null && !this.lifeEvents.Any(e => e.Id == state.ObservationId && e.Kind == "story.observed" && e.StoryId == pair.Key)
                || state.ChoiceId is not null && !this.lifeEvents.Any(e => e.Kind == "story.choice" && e.StoryId == pair.Key && e.ChoiceId == state.ChoiceId)
                || state.Outcome is not null && (!this.lifeEvents.Any(e => e.Kind == "story.resolved" && e.StoryId == pair.Key && e.Outcome == state.Outcome)
                    || string.IsNullOrWhiteSpace(state.ResultTitle) || string.IsNullOrWhiteSpace(state.ResultText)))
                throw new InvalidOperationException("小镇故事保存记录无效；保留原始记录。");
            LifeEvent[] events = this.lifeEvents.Where(e => e.StoryId == pair.Key).ToArray();
            LifeEvent? observed = events.SingleOrDefault(e => e.Kind == "story.observed");
            LifeEvent? choice = events.SingleOrDefault(e => e.Kind == "story.choice");
            LifeEvent? ended = events.SingleOrDefault(e => e.Kind == "story.resolved");
            LifeEvent[] work = events.Where(e => e.Kind == "story.worked").ToArray();
            if (events.Count(e => e.Kind == "story.started") != 1 || events.Count(e => e.Kind == "story.clue") != state.Clues.Count
                || observed?.Id != state.ObservationId || observed?.Venue != state.ObservationVenue || observed?.Weather != state.ObservationWeather
                || choice?.ChoiceId != state.ChoiceId || ended?.Outcome != state.Outcome || work.Length != state.WorkStep
                || (work.LastOrDefault()?.Day ?? 0) != state.LastWorkDay || !state.Reported.SetEquals(TownStoryRules.ReportedSources(events)))
                throw new InvalidOperationException("小镇故事进度与原始记录不一致；保留原始记录。");
        }
    }

    private void ReportStoryCompatibility()
    {
        if (this.StoriesCompatible || this.storiesUpgradeNotified || !Context.IsWorldReady || !this.memoryReady
            || !this.bridge.IsConnected || this.bridge.Generation != this.announcedGeneration) return;
        this.storiesUpgradeNotified = true;
        this.Monitor.Log("当前存档含小镇故事记录，请同时更新后端和 Mod 后再同步。", LogLevel.Warn);
        Game1.addHUDMessage(new HUDMessage("小镇故事记录需要新版后端，请同时更新后端和 Mod。", HUDMessage.error_type));
    }

    private void OnStoryAssetRequested(object? sender, AssetRequestedEventArgs e)
    {
        // Register even when disabled so an existing saved quest object keeps its native identity and sprite.
        if (!e.NameWithoutLocale.IsEquivalentTo("Data/Objects")) return;
        e.Edit(asset =>
        {
            IDictionary<string, ObjectData> data = asset.AsDictionary<string, ObjectData>().Data;
            if (!data.TryGetValue("MysteryBox", out ObjectData? sprite)) return;
            data["StardewAgent_StoryParcel"] = new ObjectData
            {
                Name = "StardewAgent Story Parcel", DisplayName = "格斯的备货包裹", Description = "贴着有些模糊的备货标记。请交还给格斯。",
                Type = "Quest", Category = 0, Price = 0, Texture = sprite.Texture, SpriteIndex = sprite.SpriteIndex,
                Edibility = -300, CanBeGivenAsGift = false, CanBeTrashed = false,
                ExcludeFromFishingCollection = true, ExcludeFromShippingCollection = true, ExcludeFromRandomSale = true,
            };
        });
    }

    private void ClearStoryIntervals()
    {
        this.storyObservations.Clear();
        this.storyWorkIntervals.Clear();
        this.storyMenuGeneration++;
    }

    private bool HasStoryEntry(NPC npc) => this.storiesSupported && this.townStories.Values.Any(story =>
        story.Owner == npc.Name.ToLowerInvariant() && (this.config.TownStories || this.lifeSave.Stories.ContainsKey(story.Id))
        || this.config.TownStories && this.lifeSave.Stories.TryGetValue(story.Id, out TownStoryState? state)
            && state.Outcome is null && story.Clues.Any(clue => clue.Witness == npc.Name.ToLowerInvariant()));

    private void StoryQuestion(NPC? npc, string text, IReadOnlyList<(string Label, Action Action)> options)
    {
        if (!this.StoryMenusReady || npc is not null && (!LifeNear(npc) || ColdShoulder(npc.Name))) return;
        string nonce = this.loadNonce;
        int day = this.currentDay, generation = ++this.storyMenuGeneration;
        Game1.currentLocation.createQuestionDialogue(VanillaDialogue.Escape(text),
            options.Select((choice, index) => new Response(index.ToString(), VanillaDialogue.Escape(choice.Label))).ToArray(), (_, answer) =>
            {
                if (!int.TryParse(answer, out int choice) || choice < 0 || choice >= options.Count) return;
                this.lifeMenuNext = () =>
                {
                    if (generation != this.storyMenuGeneration || !TownStoryRules.Current(nonce, day, this.loadNonce, this.currentDay)
                        || !this.StoryMenusReady || npc is not null && (!LifeNear(npc) || ColdShoulder(npc.Name))) return;
                    this.storyMenuGeneration++;
                    options[choice].Action();
                };
            });
    }

    private bool StorySpace(int count = 1)
    {
        if (this.CanRecordLifeEvents(count)) return true;
        this.LifeNotice("故事记录暂时无法新增，已有进度和物件会保留。");
        return false;
    }

    private bool StoryEvent(TownStoryTemplate story, string kind, string? clue = null, string? other = null,
        string? venue = null, string? weather = null, int? minutes = null, string? source = null, string? choice = null,
        int? step = null, string? outcome = null)
        => this.AppendLifeEvent(new LifeEvent
        {
            Npc = story.Owner, Kind = kind, StoryId = story.Id, ClueId = clue, Other = other,
            Venue = venue, Weather = weather, Minutes = minutes, SourceId = source, ChoiceId = choice, Step = step, Outcome = outcome,
        });

    private void ShowTownStories(NPC npc)
    {
        if (!this.StoryMenusReady || !LifeNear(npc)) return;
        string id = npc.Name.ToLowerInvariant();
        List<(string Label, Action Action)> options = new();
        foreach (TownStoryTemplate story in this.townStories.Values)
        {
            if (story.Owner == id && (this.config.TownStories || this.lifeSave.Stories.ContainsKey(story.Id)))
                options.Add((story.Title, () => this.ShowOwnedStory(npc, story)));
            if (this.config.TownStories && this.lifeSave.Stories.TryGetValue(story.Id, out TownStoryState? state) && state.Outcome is null)
                foreach (TownStoryClue clue in story.Clues.Where(c => c.Witness == id))
                    options.Add(($"问问{story.Title}的线索", () => this.AskStoryWitness(npc, story, clue)));
        }
        options.Add(("以后再聊", () => { }));
        this.StoryQuestion(npc, "想聊哪件事？", options);
    }

    private void ShowOwnedStory(NPC npc, TownStoryTemplate story)
    {
        if (!this.lifeSave.Stories.TryGetValue(story.Id, out TownStoryState? state))
        {
            if (!this.config.TownStories) return;
            this.StoryQuestion(npc, story.Opening, new[]
            {
                (story.Kind == "investigation" ? "我来留意线索" : "我记住了，也想看看你的进展", (Action)(() => this.StartTownStory(npc, story))),
                ("以后再聊", (Action)(() => { })),
            });
            return;
        }
        if (state.Outcome is not null)
        {
            this.StoryQuestion(npc, state.ResultTitle + "\n" + state.ResultText, new[] { ("以后还可以再读", (Action)(() => { })) });
            return;
        }
        List<(string Label, Action Action)> choices = new();
        string summary;
        if (story.Kind == "investigation")
        {
            summary = state.Clues.ContainsKey("parcel") ? "你的调查记录：已经找到包裹。可以把它交还，也可以先汇报见闻。" : "你的调查记录：" + story.Site!.Hint + $" 到附近后按 {this.config.StoryInvestigationKey} 调查。";
            if (state.Clues.ContainsKey("parcel"))
            {
                choices.Add(("直接交还包裹", () => this.ConfirmParcelReturn(npc, story, state, "returned")));
                if (TownStoryRules.CanExplain(state.Clues.Keys))
                    choices.Add(("说明标记混淆，再交还包裹", () => this.ConfirmParcelReturn(npc, story, state, "explained")));
            }
            choices.Add(("回看已取得的线索", () => this.ReviewStoryClues(npc, story, state)));
        }
        else
        {
            summary = state.WorkStep switch
            {
                0 => "我已经有了打算，接下来会找空闲的时间做第一轮整理。",
                1 => "第一轮整理已经做完。另一天有空时，我会继续把这一页完成。",
                _ => "两轮整理已经完成，成品正在记下。",
            };
            if (state.ChoiceId is null && this.config.TownStories)
            {
                if (state.ObservationId is null)
                    summary += $" 你也可以到{string.Join("或", story.ObservationVenues.Select(v => v.Label))}观察一会儿，按 {this.config.StoryInvestigationKey} 记下见闻，再回来聊。";
                else choices.Add(("用这次观察提个建议", () => this.ChooseStoryContribution(npc, story, state)));
            }
            else if (state.ChoiceId is not null) summary += " 你提过的建议已经留在这一页里。";
        }
        if (this.config.TownStories)
            foreach (LifeEvent source in this.lifeEvents.Where(e => e.StoryId == story.Id
                && e.Kind is "story.clue" or "story.observed" && !state.Reported.Contains(e.Id)).ToArray())
                choices.Add((source.Kind == "story.observed" ? "告诉对方我的现场观察" : "汇报一条新线索", () => this.TellStorySource(npc, story, state, source)));
        choices.Add(("先忙你的，我改天再来看", () => { }));
        this.StoryQuestion(npc, summary, choices);
    }

    private void StartTownStory(NPC npc, TownStoryTemplate story)
    {
        if (!this.StoryMenusReady || !this.config.TownStories || !LifeNear(npc) || this.lifeSave.Stories.ContainsKey(story.Id) || !this.StorySpace()) return;
        TownStoryState state = new() { StartedDay = this.currentDay, StartId = "life-" + (this.lifeSave.Serial + 1) };
        this.lifeSave.Stories.Add(story.Id, state);
        if (!this.StoryEvent(story, "story.started")) { this.lifeSave.Stories.Remove(story.Id); return; }
        this.LifeNotice($"已记下：{story.Title}。" + (story.Kind == "project" ? "不参与时，对方也会在有空时继续。" : $"按 {this.config.StoryInvestigationKey} 查看附近调查。"));
    }

    private void AskStoryWitness(NPC npc, TownStoryTemplate story, TownStoryClue clue)
    {
        if (!this.config.TownStories || !this.lifeSave.Stories.TryGetValue(story.Id, out TownStoryState? state) || state.Outcome is not null
            || clue.Witness != npc.Name.ToLowerInvariant()) return;
        if (state.Clues.ContainsKey(clue.Id))
        {
            this.StoryQuestion(npc, clue.Text, new[] { ("我记住了", (Action)(() => { })) });
            return;
        }
        this.StoryQuestion(npc, "想听听我知道的那一部分吗？", new[]
        {
            ("听听这条线索", (Action)(() =>
            {
                if (!this.config.TownStories || state.Outcome is not null || state.Clues.ContainsKey(clue.Id) || !this.StorySpace()) return;
                state.Clues[clue.Id] = "life-" + (this.lifeSave.Serial + 1);
                if (!this.StoryEvent(story, "story.clue", clue: clue.Id, other: clue.Witness)) { state.Clues.Remove(clue.Id); return; }
                Game1.drawObjectDialogue(VanillaDialogue.Escape(clue.Text));
            })),
            ("稍后再问", (Action)(() => { })),
        });
    }

    private void ReviewStoryClues(NPC npc, TownStoryTemplate story, TownStoryState state)
    {
        string text = string.Join("\n", story.Clues.Where(c => state.Clues.ContainsKey(c.Id)).Select(StoryClueText));
        this.StoryQuestion(npc, text.Length == 0 ? "你的调查笔记里还没有线索。" : "你的调查笔记：\n" + text,
            new[] { ("知道了", (Action)(() => { })) });
    }

    private void TellStorySource(NPC npc, TownStoryTemplate story, TownStoryState state, LifeEvent source)
    {
        if (!this.config.TownStories || state.Outcome is not null || !TownStoryRules.CanTell(story.Id, source.StoryId ?? "", source.Kind, source.Id, state.Reported)) return;
        string text = source.Kind == "story.clue" ? StoryClueText(story.Clues.Single(c => c.Id == source.ClueId))
            : $"第 {source.Day} 天，我在{StoryVenueLabel(story, source.Venue!)}观察了 {source.Minutes} 分钟，当时{RomanceRules.Weather(source.Weather!)}。";
        this.StoryQuestion(npc, "把这条见闻告诉对方？\n" + text, new[]
        {
            ("就这样告诉对方", (Action)(() =>
            {
                if (!this.config.TownStories || state.Outcome is not null || state.Reported.Contains(source.Id) || !this.StorySpace()) return;
                state.Reported.Add(source.Id);
                if (!this.StoryEvent(story, "story.told", source: source.Id)) { state.Reported.Remove(source.Id); return; }
                this.LifeNotice("已经当面说明这条见闻。");
            })),
            ("先不说", (Action)(() => { })),
        });
    }

    private void ConfirmParcelReturn(NPC npc, TownStoryTemplate story, TownStoryState state, string outcome)
    {
        this.StoryQuestion(npc, "交还这件备货包裹？这会从背包中取走包裹。", new[]
        {
            ("确认交还", (Action)(() => this.ReturnStoryParcel(npc, story, state, outcome))),
            ("先留在背包里", (Action)(() => { })),
        });
    }

    private void ReturnStoryParcel(NPC npc, TownStoryTemplate story, TownStoryState state, string outcome)
    {
        if (!this.StoryMenusReady || !LifeNear(npc) || state.Outcome is not null || !state.Clues.ContainsKey("parcel")
            || outcome == "explained" && !TownStoryRules.CanExplain(state.Clues.Keys) || !this.StorySpace()) return;
        int slot = -1;
        for (int i = 0; i < Game1.player.Items.Count; i++)
            if (Game1.player.Items[i] is Item item && TownStoryRules.ParcelMatches(item.QualifiedItemId,
                item.modData.TryGetValue(TownStoryRules.ParcelMarkKey, out string? marker) ? marker : null, state.StartId)) { slot = i; break; }
        if (slot < 0) { this.LifeNotice("请把调查时找到的那件包裹带在背包里，箱子里的包裹需要先取回。"); return; }
        Item parcel = Game1.player.Items[slot];
        int oldStack = parcel.Stack;
        parcel.Stack--;
        if (parcel.Stack == 0) Game1.player.Items[slot] = null;
        if (!this.ResolveStory(story, state, outcome))
        {
            parcel.Stack = oldStack; Game1.player.Items[slot] = parcel;
            return;
        }
        Game1.drawObjectDialogue(VanillaDialogue.Escape(state.ResultTitle + "\n" + state.ResultText));
    }

    private void ChooseStoryContribution(NPC npc, TownStoryTemplate story, TownStoryState state)
    {
        if (!this.config.TownStories || state.Outcome is not null || state.ChoiceId is not null || state.ObservationId is null) return;
        List<(string Label, Action Action)> choices = story.Choices.Select(choice => (choice.Label, (Action)(() =>
        {
            if (!this.config.TownStories || state.Outcome is not null || state.ChoiceId is not null || state.ObservationId is null || !this.StorySpace()) return;
            state.ChoiceId = choice.Id;
            bool newlyReported = state.Reported.Add(state.ObservationId);
            if (!this.StoryEvent(story, "story.choice", source: state.ObservationId, choice: choice.Id))
            { state.ChoiceId = null; if (newlyReported) state.Reported.Remove(state.ObservationId); return; }
            Game1.drawObjectDialogue(VanillaDialogue.Escape(choice.Text));
        }))).ToList();
        choices.Add(("再想想", () => { }));
        this.StoryQuestion(npc, $"你在{StoryVenueLabel(story, state.ObservationVenue!)}记下的那次观察，想怎样用在这一页里？", choices);
    }

    private bool ResolveStory(TownStoryTemplate story, TownStoryState state, string outcome)
    {
        if (state.Outcome is not null || !this.CanRecordLifeEvent) return false;
        TownStoryEnding? ending = story.Endings.SingleOrDefault(e => e.Id == outcome);
        if (ending is null) return false;
        state.Outcome = outcome; state.ResultTitle = ending.Title; state.ResultText = ending.Text;
        if (story.Kind == "project" && state.ChoiceId is not null)
            state.ResultText += $"\n这次还用上了你在{StoryVenueLabel(story, state.ObservationVenue!)}、{RomanceRules.Weather(state.ObservationWeather!)}时记下的观察。";
        string[] newlyReported = TownStoryRules.ResolutionSources(outcome, state.Clues).Where(state.Reported.Add).ToArray();
        if (!this.StoryEvent(story, "story.resolved", outcome: outcome))
        { state.Outcome = null; state.ResultTitle = null; state.ResultText = null; state.Reported.ExceptWith(newlyReported); return false; }
        return true;
    }

    private static string StoryVenueLabel(TownStoryTemplate story, string map)
        => story.ObservationVenues.FirstOrDefault(v => v.Map == map)?.Label ?? RomanceRules.Place(map);

    private static string StoryClueText(TownStoryClue clue) => (clue.Witness switch
        { "emily" => "艾米丽的证词：", "pierre" => "皮埃尔的证词：", _ => "现场发现：" }) + clue.Text;

    private bool TryOpenStoryFieldMenu()
    {
        if (!this.StoryMenusReady || !this.config.TownStories || Game1.activeClickableMenu is not null || this.talk is not null) return false;
        List<(string Label, Action Action)> options = new();
        foreach (TownStoryTemplate story in this.townStories.Values)
        {
            if (!this.lifeSave.Stories.TryGetValue(story.Id, out TownStoryState? state) || state.Outcome is not null) continue;
            if (story.Kind == "investigation" && !state.Clues.ContainsKey("parcel"))
                options.Add(($"调查：{story.Site!.Label}", () => this.SearchStoryParcel(story, state)));
            if (story.Kind == "project" && state.ObservationId is null)
                options.Add(($"记录观察：{story.Title}", () => this.RecordStoryObservation(story, state)));
        }
        if (options.Count == 0) { this.LifeNotice("目前没有需要现场调查或观察的故事。"); return true; }
        options.Add(("暂时不调查", () => { }));
        this.StoryQuestion(null, "想调查哪件事？请实际到线索地点，观察需要在同一地点正常度过一会儿。", options);
        return true;
    }

    private void SearchStoryParcel(TownStoryTemplate story, TownStoryState state)
    {
        if (!this.config.TownStories || state.Outcome is not null || state.Clues.ContainsKey("parcel") || !this.StorySpace()) return;
        TownStorySite site = story.Site!;
        if (!TownStoryRules.NearSite(Game1.currentLocation.Name, Game1.player.TilePoint.X, Game1.player.TilePoint.Y, site.Map, site.X, site.Y, site.Radius))
        {
            string direction = Game1.currentLocation.Name == site.Map ? TownStoryRules.Direction(Game1.player.TilePoint.X, Game1.player.TilePoint.Y, site.X, site.Y) : "";
            Game1.drawObjectDialogue(VanillaDialogue.Escape(site.Hint + (direction.Length > 0 ? $" 再往{direction}边靠近{site.Label}一些，然后调查周围。" : "")));
            return;
        }
        if (!Game1.objectData.ContainsKey("StardewAgent_StoryParcel")) { this.LifeNotice("包裹资料尚未加载，现场记录保持未取得。"); return; }
        StardewValley.Object parcel = (StardewValley.Object)ItemRegistry.Create(TownStoryRules.ParcelItemId);
        parcel.questItem.Value = true;
        parcel.modData[TownStoryRules.ParcelMarkKey] = "gus_parcel@" + state.StartId;
        var inventoryBefore = Game1.player.Items.Select((item, slot) => (Item: item, Slot: slot, Stack: item?.Stack ?? 0)).ToArray();
        if (!Game1.player.addItemToInventoryBool(parcel)) { this.LifeNotice("背包没有空位。包裹仍留在这里，整理背包后再调查。"); return; }
        state.Clues["parcel"] = "life-" + (this.lifeSave.Serial + 1);
        if (!this.StoryEvent(story, "story.clue", clue: "parcel"))
        {
            foreach (var before in inventoryBefore)
            { if (before.Item is not null) before.Item.Stack = before.Stack; Game1.player.Items[before.Slot] = before.Item; }
            state.Clues.Remove("parcel");
            return;
        }
        Game1.addHUDMessage(HUDMessage.ForItemGained(parcel, 1));
        Game1.drawObjectDialogue(VanillaDialogue.Escape(story.Clues.Single(c => c.Id == "parcel").Text));
    }

    private void RecordStoryObservation(TownStoryTemplate story, TownStoryState state)
    {
        string map = Game1.currentLocation.Name;
        if (!this.config.TownStories || state.Outcome is not null || state.ObservationId is not null || !this.StorySpace()) return;
        if (!this.storyObservations.TryGetValue(story.Id, out StoryInterval? observation) || observation.Day != this.currentDay || observation.Map != map
            || !TownStoryRules.ObservationReady(observation.Minutes, map, story.ObservationVenues.Select(v => v.Map).ToArray()))
        { this.LifeNotice($"先在{string.Join("或", story.ObservationVenues.Select(v => v.Label))}正常观察满 10 游戏分钟，再记下这次见闻。"); return; }
        state.ObservationId = "life-" + (this.lifeSave.Serial + 1); state.ObservationVenue = map; state.ObservationWeather = GameState.Weather();
        if (!this.StoryEvent(story, "story.observed", venue: map, weather: state.ObservationWeather, minutes: observation.Minutes))
        { state.ObservationId = null; state.ObservationVenue = null; state.ObservationWeather = null; return; }
        this.LifeNotice("地点和当时的天气已经记下。回到对方身边，还可以告诉对方或提出建议。");
    }

    private bool StoryClockRunning => this.activeLoad && Context.IsWorldReady && this.config.TownStories && this.StoryMenusReady
        && !Game1.isWarping && Game1.activeClickableMenu is null && Game1.shouldTimePass();

    private bool StoryWorkerEligible(TownStoryTemplate story, TownStoryState state, NPC? npc)
        => this.StoryClockRunning && this.CanRecordLifeEvent && state.Outcome is null && TownStoryRules.WorkDay(this.currentDay, state.StartedDay, state.WorkStep, state.LastWorkDay)
            && npc is not null && !npc.IsInvisible && !npc.isSleeping.Value && npc.currentLocation is not null && story.WorkVenues.Contains(npc.currentLocation.Name)
            && !npc.isMoving() && npc.controller is null && npc.temporaryController is null && !npc.ignoreScheduleToday
            && !this.IsLifeActivityNpc(npc.Name) && !this.Approaching(npc.Name) && !this.sceneParticipants.Contains(npc.Name)
            && this.talk?.Npc != npc && this.offerFor != npc && this.startFor != npc
            && !this.lifeActivityReturns.Any(returning => returning.Npc == npc)
            && (!this.meetings.TryGetValue(npc.Name, out Meeting? meeting) || meeting.Reported || meeting.Failed);

    private static NPC? StoryNpc(TownStoryTemplate story)
    {
        string? name = SocialNpcs.FirstOrDefault(candidate => candidate.Equals(story.Owner, StringComparison.OrdinalIgnoreCase));
        return name is null ? null : Game1.getCharacterFromName(name);
    }

    private StoryInterval StoryIntervalFor(Dictionary<string, StoryInterval> intervals, string id, string map)
    {
        if (!intervals.TryGetValue(id, out StoryInterval? interval) || interval.Day != this.currentDay || interval.Map != map)
            intervals[id] = interval = new() { Day = this.currentDay, LastTime = Game1.timeOfDay, Map = map, Whole = false };
        return interval;
    }

    private void TickStoryIntervals()
    {
        if (!this.activeLoad || !Context.IsWorldReady) return;
        this.ReportStoryCompatibility();
        foreach (TownStoryTemplate story in this.townStories.Values.Where(story => story.Kind == "project"))
        {
            if (!this.lifeSave.Stories.TryGetValue(story.Id, out TownStoryState? state) || state.Outcome is not null) continue;
            string playerMap = Game1.currentLocation.Name;
            StoryInterval observation = this.StoryIntervalFor(this.storyObservations, story.Id, playerMap);
            observation.Whole &= this.StoryClockRunning && story.ObservationVenues.Any(v => v.Map == playerMap);
            NPC? npc = StoryNpc(story);
            string workMap = npc?.currentLocation?.Name ?? "";
            int retainedMinutes = TownStoryRules.WorkAccumulation(state.WorkMinutes, state.WorkAccumDay, state.WorkMap,
                this.currentDay, workMap, 0);
            if (retainedMinutes != state.WorkMinutes)
            {
                // Clear on the observed transition, even if no full clock step occurs in the new map.
                state.WorkMinutes = retainedMinutes; state.WorkMap = null; state.WorkAccumDay = this.currentDay;
                this.PersistLife();
            }
            StoryInterval work = this.StoryIntervalFor(this.storyWorkIntervals, story.Id, workMap);
            work.Whole &= this.StoryWorkerEligible(story, state, npc);
            if (state.WorkStep == 2 && this.config.TownStories && this.StoryMenusReady && this.CanRecordLifeEvent
                && this.ResolveStory(story, state, TownStoryRules.ProjectOutcome(state.ChoiceId)))
                this.LifeNotice($"{story.Title}已经有了成品。下次见面可以读一读。");
        }
    }

    private void StoryTimeChanged()
    {
        if (!this.activeLoad || !Context.IsWorldReady) return;
        foreach (TownStoryTemplate story in this.townStories.Values.Where(story => story.Kind == "project"))
        {
            if (!this.lifeSave.Stories.TryGetValue(story.Id, out TownStoryState? state) || state.Outcome is not null) continue;
            string map = Game1.currentLocation.Name;
            StoryInterval observation = this.StoryIntervalFor(this.storyObservations, story.Id, map);
            bool observe = this.StoryClockRunning && state.ObservationId is null && story.ObservationVenues.Any(v => v.Map == map);
            observation.Minutes = Math.Min(10, observation.Minutes + TownStoryRules.ClockStep(observation.LastTime, Game1.timeOfDay,
                observation.Whole && observe, observation.Day, this.currentDay, observation.Map, map));
            observation.LastTime = Game1.timeOfDay; observation.Whole = observe;
            NPC? npc = StoryNpc(story);
            string workMap = npc?.currentLocation?.Name ?? "";
            StoryInterval work = this.StoryIntervalFor(this.storyWorkIntervals, story.Id, workMap);
            bool working = this.StoryWorkerEligible(story, state, npc);
            int added = TownStoryRules.ClockStep(work.LastTime, Game1.timeOfDay, work.Whole && working, work.Day, this.currentDay, work.Map, workMap);
            work.LastTime = Game1.timeOfDay; work.Whole = working;
            if (added == 0) continue;
            state.WorkMinutes = TownStoryRules.WorkAccumulation(state.WorkMinutes, state.WorkAccumDay, state.WorkMap, this.currentDay, workMap, added);
            state.WorkMap = workMap; state.WorkAccumDay = this.currentDay;
            if (!TownStoryRules.WorkReady(state.WorkMinutes, working, state.WorkMap == workMap)) { this.PersistLife(); continue; }
            if (!this.CanRecordLifeEvent) { this.PersistLife(); continue; }
            int previousStep = state.WorkStep, previousDay = state.LastWorkDay;
            state.WorkStep++; state.LastWorkDay = this.currentDay; state.WorkMinutes = 0; state.WorkMap = null;
            if (!this.StoryEvent(story, "story.worked", venue: workMap, minutes: 30, step: state.WorkStep))
            { state.WorkStep = previousStep; state.LastWorkDay = previousDay; state.WorkMinutes = 30; state.WorkMap = workMap; }
            work.Whole = false;
        }
    }
}
