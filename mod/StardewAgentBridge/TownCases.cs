using System;
using System.Collections.Generic;
using System.Linq;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentBridge;

internal sealed partial class ModEntry
{
    private readonly Dictionary<string, TownCaseDefinition> townCases = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TownCaseClock> caseClocks = new(StringComparer.Ordinal);
    private bool casesSupported;
    private bool casesUpgradeNotified;
    private int caseMenuGeneration;
    private bool CasesCompatible => TownCaseRules.Compatible(this.casesSupported, this.lifeEvents);
    private bool CaseMenusReady => this.activeLoad && Context.IsWorldReady && this.lifeSupported && this.storiesSupported
        && this.casesSupported && this.CanChat && !Game1.eventUp && !Game1.isFestival();

    private void LoadTownCases()
    {
        this.townCases.Clear();
        try
        {
            TownCaseFile? file = this.Helper.Data.ReadJsonFile<TownCaseFile>("assets/town-cases.json");
            if (file is null || file.Version != 1 || file.Cases is null || file.Cases.Count != TownCaseRules.Owners.Count
                || file.Cases.Any(c => c is null || !TownCaseRules.Definition(c)) || file.Cases.Select(c => c.Id).Distinct().Count() != file.Cases.Count)
                throw new InvalidOperationException("四条调查资料缺失或无效。");
            foreach (TownCaseDefinition definition in file.Cases) this.townCases.Add(definition.Id, definition);
        }
        catch (Exception ex)
        { this.townCases.Clear(); this.Monitor.Log("新增调查暂停，其他内容保持可用：" + ex.Message, LogLevel.Warn); }
    }

    private void ValidateCaseSave()
    {
        if (!TownCaseRules.SaveVersion(this.lifeSave.Version, this.lifeEvents)
            || this.lifeSave.Cases.Keys.Any(id => !TownCaseRules.IsCaseId(id))
            || !this.lifeSave.Cases.Keys.ToHashSet().SetEquals(this.lifeEvents.Where(TownCaseRules.IsCase).Select(e => e.StoryId!)))
            throw new InvalidOperationException("新增调查保存版本或来源无效；原始记录保留。");
        foreach (var pair in this.lifeSave.Cases)
            if (pair.Value is null || !this.townCases.TryGetValue(pair.Key, out TownCaseDefinition? definition)
                || !TownCaseRules.ValidState(pair.Value, TownCaseRules.Replay(definition, this.lifeEvents, AbsoluteDay())))
                throw new InvalidOperationException("调查笔记与原始来源不一致；原始记录保留。");
    }

    private void ReportCaseCompatibility()
    {
        if (this.CasesCompatible || this.casesUpgradeNotified || !Context.IsWorldReady || !this.memoryReady
            || !this.bridge.IsConnected || this.bridge.Generation != this.announcedGeneration) return;
        this.casesUpgradeNotified = true;
        this.Monitor.Log("当前存档含新增调查，请同时更新后端和 Mod 后同步。", LogLevel.Warn);
        Game1.addHUDMessage(new HUDMessage("调查记录需要新版后端，请同时更新后端和 Mod。", HUDMessage.error_type));
    }

    private void ClearCaseClocks()
    { this.caseClocks.Clear(); this.caseMenuGeneration++; }

    private bool HasCaseEntry(NPC npc) => this.casesSupported && this.townCases.Values.Any(definition =>
        definition.Owner == npc.Name.ToLowerInvariant() && (this.config.TownCases || this.lifeSave.Cases.ContainsKey(definition.Id))
        || this.config.TownCases && this.lifeSave.Cases.TryGetValue(definition.Id, out TownCaseState? state)
            && state.Outcome is null && definition.Clues.Any(c => c.Witness == npc.Name.ToLowerInvariant()));

    private void AddCaseNpcOptions(NPC npc, List<(string Label, Action Action)> options)
    {
        if (!this.CaseMenusReady) return;
        string id = npc.Name.ToLowerInvariant();
        foreach (TownCaseDefinition definition in this.townCases.Values)
        {
            if (definition.Owner == id && (this.config.TownCases || this.lifeSave.Cases.ContainsKey(definition.Id)))
                options.Add((definition.Title, () => this.ShowOwnedCase(npc, definition)));
            if (this.config.TownCases && this.lifeSave.Cases.TryGetValue(definition.Id, out TownCaseState? state) && state.Outcome is null)
                foreach (TownCaseClue clue in definition.Clues.Where(c => c.Witness == id))
                    options.Add(($"询问：{definition.Title}", () => this.AskCaseWitness(npc, definition, clue)));
        }
    }

    private void CaseQuestion(NPC? npc, string text, IReadOnlyList<(string Label, Action Action)> options, bool shared = false, int page = 0)
    {
        bool Ready() => shared ? this.StoryMenusReady || this.CaseMenusReady : this.CaseMenusReady;
        if (!Ready() || npc is not null && (!LifeNear(npc) || ColdShoulder(npc.Name))) return;
        string nonce = this.loadNonce;
        int day = this.currentDay, generation = ++this.caseMenuGeneration;
        List<(string Label, Action Action)> visible = options.Skip(page * 4).Take(4).ToList();
        if ((page + 1) * 4 < options.Count) visible.Add(("下一页", () => this.CaseQuestion(npc, text, options, shared, page + 1)));
        if (page > 0) visible.Add(("上一页", () => this.CaseQuestion(npc, text, options, shared, page - 1)));
        Game1.currentLocation.createQuestionDialogue(VanillaDialogue.Escape(text),
            visible.Select((option, index) => new Response(index.ToString(), VanillaDialogue.Escape(option.Label))).ToArray(), (_, answer) =>
            {
                if (!int.TryParse(answer, out int index) || index < 0 || index >= visible.Count) return;
                this.lifeMenuNext = () =>
                {
                    if (generation != this.caseMenuGeneration || !TownStoryRules.Current(nonce, day, this.loadNonce, this.currentDay)
                        || !Ready() || npc is not null && (!LifeNear(npc) || ColdShoulder(npc.Name))) return;
                    this.caseMenuGeneration++;
                    visible[index].Action();
                };
            });
    }

    private bool CaseEditable(TownCaseDefinition definition, TownCaseState state) => this.CaseMenusReady && this.config.TownCases
        && state.Outcome is null && this.lifeSave.Cases.TryGetValue(definition.Id, out TownCaseState? current) && ReferenceEquals(current, state);

    private bool CommitCase(TownCaseDefinition definition, LifeEvent entry)
    {
        if (!this.CaseMenusReady || !this.config.TownCases || !this.CanRecordLifeEvent)
        { this.LifeNotice("调查暂时不能新增记录，已有笔记会保留。"); return false; }
        entry.Id = "life-" + (this.lifeSave.Serial + 1); entry.Day = this.currentDay; entry.Npc = definition.Owner; entry.StoryId = definition.Id;
        TownCaseState? next = TownCaseRules.Replay(definition, this.lifeEvents.Append(entry), this.currentDay);
        if (next is null) { this.LifeNotice("这条记录的来源或现场条件已变化，请重新查看调查笔记。"); return false; }
        this.lifeSave.Cases.TryGetValue(definition.Id, out TownCaseState? previous);
        this.lifeSave.Cases[definition.Id] = next;
        if (this.AppendLifeEvent(entry)) return true;
        if (previous is null) this.lifeSave.Cases.Remove(definition.Id); else this.lifeSave.Cases[definition.Id] = previous;
        return false;
    }

    private void ShowOwnedCase(NPC npc, TownCaseDefinition definition)
    {
        if (!this.lifeSave.Cases.TryGetValue(definition.Id, out TownCaseState? state))
        {
            if (!this.config.TownCases) return;
            this.CaseQuestion(npc, definition.Opening + $"\n开案后按 {this.config.StoryInvestigationKey} 查看现场核验；没有期限，也不消耗样品。", new[]
            {
                ("我来核对这些线索", (Action)(() =>
                {
                    if (this.lifeSave.Cases.ContainsKey(definition.Id) || !LifeNear(npc)) return;
                    if (this.CommitCase(definition, new() { Kind = "story.started" })) this.LifeNotice("已记下：" + definition.Title + "。现场要求可以在调查笔记中回看。");
                })),
                ("以后再聊", (Action)(() => { })),
            });
            return;
        }
        List<(string Label, Action Action)> choices = new() { ("查看我的调查笔记", () => this.ShowCaseNotes(npc, definition, state)) };
        string summary;
        if (state.Outcome is not null)
        {
            summary = "这件事已经结案，可以随时回看选定的处理方案和实际来源。";
            choices.Insert(0, ("重读结案页：" + state.ResultTitle, () => this.CaseQuestion(npc, state.ResultTitle + "\n" + state.ResultText,
                new[] { ("读完了", (Action)(() => { })) })));
        }
        else
        {
            int clues = definition.Clues.Count(c => state.Sources.ContainsKey(c.Id)), inspections = definition.Inspections.Count(i => state.Sources.ContainsKey(i.Id));
            summary = $"你的调查笔记：已取得 {clues}/2 份证词、{inspections}/2 份现场记录。阅读笔记不会自动把见闻告诉对方。";
            if (this.config.TownCases)
            {
                foreach (var source in state.Sources.Where(s => !state.Reported.Contains(s.Value)))
                    choices.Add(("汇报：" + CaseSourceLabel(definition, source.Key), () => this.TellCaseSource(npc, definition, state, source.Value)));
                if (TownCaseRules.Ready(definition, state))
                    foreach (TownCaseEnding ending in definition.Endings)
                        choices.Add(("结案：" + ending.Label, () => this.ConfirmCaseResolution(npc, definition, state, ending)));
            }
            else summary += " 新调查推进已关闭，已有笔记仍可阅读。";
        }
        choices.Add(("以后再聊", () => { }));
        this.CaseQuestion(npc, definition.Title + "\n" + summary, choices);
    }

    private static NPC? CaseNpc(string id)
    {
        string? name = SocialNpcs.FirstOrDefault(n => n.Equals(id, StringComparison.OrdinalIgnoreCase));
        return name is null ? null : Game1.getCharacterFromName(name);
    }
    private static string CaseName(string id) => CaseNpc(id)?.displayName ?? id;
    private static string CaseSourceLabel(TownCaseDefinition definition, string clueId)
        => definition.Clues.FirstOrDefault(c => c.Id == clueId)?.Label ?? definition.Inspections.Single(i => i.Id == clueId).Label;
    private string CaseSourceText(TownCaseDefinition definition, LifeEvent source)
    {
        if (source.Kind == "story.clue")
        {
            TownCaseClue clue = definition.Clues.Single(c => c.Id == source.ClueId);
            return CaseName(clue.Witness) + "的证词：\n" + clue.Text;
        }
        TownCaseInspection inspection = definition.Inspections.Single(i => i.Id == source.ClueId);
        string time = $"{source.Time / 100:00}:{source.Time % 100:00}";
        string text = $"第 {source.Day} 天 {time}，在{inspection.Label}正常观察了 {source.Minutes} 分钟。";
        if (inspection.Mode == "site") text += $"当时{RomanceRules.Weather(source.Weather!)}，记录位置为地图格 {source.X}、{source.Y}。";
        if (inspection.Mode == "sample") text += $"核对了背包中的{inspection.ItemLabel} {source.Count} 份，没有取走或消耗；不代表采矿经历。";
        if (inspection.Mode == "presence")
        {
            double distance = Math.Sqrt(Math.Pow(source.X!.Value - source.SubjectX!.Value, 2) + Math.Pow(source.Y!.Value - source.SubjectY!.Value, 2));
            text += $"玛妮本人清醒在场，与我相距 {distance:0.#} 格。这只记录当时在场，不证明营业或能够交易。";
        }
        if (source.SourceId is not null)
        {
            LifeEvent first = this.lifeEvents.Single(e => e.Id == source.SourceId);
            text += $"这是对第 {first.Day} 天首次记录的另日复查；不补写两次之间的空白。";
        }
        return text;
    }

    private void ShowCaseNotes(NPC npc, TownCaseDefinition definition, TownCaseState state)
    {
        List<(string Label, Action Action)> choices = new();
        foreach (TownCaseClue clue in definition.Clues)
            choices.Add(((state.Sources.ContainsKey(clue.Id) ? "已取得：" : "待询问：") + clue.Label, () =>
            {
                string text = state.Sources.TryGetValue(clue.Id, out string? id)
                    ? this.CaseSourceText(definition, this.lifeEvents.Single(e => e.Id == id)) + (state.Reported.Contains(id) ? "\n已向主人公说明。" : "\n尚未向主人公汇报。")
                    : "还没有听过这份证词。请实际找到" + CaseName(clue.Witness) + "，当面询问。";
                this.CaseQuestion(npc, "你的调查笔记：\n" + text, new[] { ("返回笔记", (Action)(() => this.ShowCaseNotes(npc, definition, state))) });
            }));
        foreach (TownCaseInspection inspection in definition.Inspections)
            choices.Add(((state.Sources.ContainsKey(inspection.Id) ? "已核验：" : "现场要求：") + inspection.Label, () =>
            {
                string text = inspection.Hint + $"\n到场后按 {this.config.StoryInvestigationKey} 记录；需完整正常 10 游戏分钟。";
                if (state.Sources.TryGetValue(inspection.Id, out string? id)) text += "\n实际记录：" + this.CaseSourceText(definition, this.lifeEvents.Single(e => e.Id == id))
                    + (state.Reported.Contains(id) ? "\n已向主人公说明。" : "\n尚未向主人公汇报。");
                this.CaseQuestion(npc, "你的调查笔记：\n" + text, new[] { ("返回笔记", (Action)(() => this.ShowCaseNotes(npc, definition, state))) });
            }));
        choices.Add(("收起笔记", () => { }));
        this.CaseQuestion(npc, "你的调查笔记：" + definition.Title + "。这里的阅读不会生成汇报。", choices);
    }

    private void AskCaseWitness(NPC npc, TownCaseDefinition definition, TownCaseClue clue)
    {
        if (!this.lifeSave.Cases.TryGetValue(definition.Id, out TownCaseState? state) || !this.CaseEditable(definition, state)
            || clue.Witness != npc.Name.ToLowerInvariant() || !LifeNear(npc)) return;
        if (state.Sources.ContainsKey(clue.Id))
        { this.CaseQuestion(npc, CaseName(clue.Witness) + "的证词：\n" + clue.Text, new[] { ("我记住了", (Action)(() => { })) }); return; }
        this.CaseQuestion(npc, "关于“" + definition.Title + "”，要听听我知道的那部分吗？", new[]
        {
            ("听听这份证词", (Action)(() =>
            {
                if (!this.CaseEditable(definition, state) || !LifeNear(npc)) return;
                if (this.CommitCase(definition, new() { Kind = "story.clue", ClueId = clue.Id, Other = clue.Witness }))
                    Game1.drawObjectDialogue(VanillaDialogue.Escape(CaseName(clue.Witness) + "的证词：\n" + clue.Text));
            })),
            ("稍后再问", (Action)(() => { })),
        });
    }

    private void TellCaseSource(NPC npc, TownCaseDefinition definition, TownCaseState state, string sourceId)
    {
        if (!this.CaseEditable(definition, state) || state.Reported.Contains(sourceId) || !state.Sources.Values.Contains(sourceId)) return;
        LifeEvent source = this.lifeEvents.Single(e => e.Id == sourceId);
        this.CaseQuestion(npc, "把这份实际见闻告诉对方？\n" + this.CaseSourceText(definition, source), new[]
        {
            ("就这样告诉对方", (Action)(() =>
            {
                if (this.CaseEditable(definition, state) && LifeNear(npc) && this.CommitCase(definition, new() { Kind = "story.told", SourceId = sourceId }))
                    this.LifeNotice("已当面说明这份来源。");
            })),
            ("先不汇报", (Action)(() => { })),
        });
    }

    private void ConfirmCaseResolution(NPC npc, TownCaseDefinition definition, TownCaseState state, TownCaseEnding ending)
    {
        if (!this.CaseEditable(definition, state) || !TownCaseRules.Ready(definition, state)) return;
        this.CaseQuestion(npc, "这会当面说明两份证词和两份现场记录，并按以下方案结案：\n" + ending.Label + "。结案后仍能阅读笔记和结案页。", new[]
        {
            ("确认这个处理方案", (Action)(() =>
            {
                if (this.CaseEditable(definition, state) && LifeNear(npc) && this.CommitCase(definition, new() { Kind = "story.resolved", Outcome = ending.Id }))
                    Game1.drawObjectDialogue(VanillaDialogue.Escape(ending.Title + "\n" + ending.Text));
            })),
            ("先不结案", (Action)(() => { })),
        });
    }

    private void AddCaseFieldOptions(List<(string Label, Action Action)> choices)
    {
        if (!this.CaseMenusReady || !this.config.TownCases) return;
        foreach (TownCaseDefinition definition in this.townCases.Values)
            if (this.lifeSave.Cases.TryGetValue(definition.Id, out TownCaseState? state) && state.Outcome is null)
                foreach (TownCaseInspection inspection in definition.Inspections.Where(i => !state.Sources.ContainsKey(i.Id)))
                    choices.Add(($"核验：{inspection.Label}", () => this.ConfirmCaseInspection(definition, state, inspection)));
    }

    private static string CaseClockKey(TownCaseDefinition definition, TownCaseInspection inspection) => definition.Id + ":" + inspection.Id;
    private bool CasePhysical(TownCaseDefinition definition, TownCaseState state, TownCaseInspection inspection)
    {
        if (!this.activeLoad || !Context.IsWorldReady || !this.config.TownCases || state.Outcome is not null || state.Sources.ContainsKey(inspection.Id)
            || Game1.eventUp || Game1.isFestival() || Game1.isWarping || !TownCaseRules.Time(Game1.timeOfDay)
            || !TownCaseRules.Dependency(inspection, state, this.lifeEvents, this.currentDay)
            || !TownCaseRules.AtSite(inspection, Game1.currentLocation.Name, Game1.player.TilePoint.X, Game1.player.TilePoint.Y)) return false;
        if (inspection.Mode != "presence") return true;
        NPC? subject = CaseNpc(inspection.Subject!);
        return subject is not null && LifeNear(subject) && TownCaseRules.Present(inspection, Game1.timeOfDay, Game1.player.TilePoint.X, Game1.player.TilePoint.Y,
            subject.Name.ToLowerInvariant(), subject.currentLocation?.Name, subject.TilePoint.X, subject.TilePoint.Y, !subject.isSleeping.Value, !subject.IsInvisible)
            && !this.sceneParticipants.Contains(subject.Name);
    }
    private bool CaseClockRunning => this.CaseMenusReady && Game1.activeClickableMenu is null && !Game1.dialogueUp
        && this.talk is null && !Game1.isWarping && Game1.shouldTimePass();

    private bool CaseInspectionReady(TownCaseDefinition definition, TownCaseState state, TownCaseInspection inspection)
    {
        if (!this.CaseEditable(definition, state) || !this.CasePhysical(definition, state, inspection)
            || !this.caseClocks.TryGetValue(CaseClockKey(definition, inspection), out TownCaseClock? clock)
            || clock.Day != this.currentDay || clock.Map != Game1.currentLocation.Name || clock.Minutes != 10) return false;
        return inspection.Mode != "sample" || TownCaseRules.Sample(inspection,
            Game1.player.Items.Where(item => item is not null).Select(item => (item.QualifiedItemId, item.Stack)));
    }

    private void ConfirmCaseInspection(TownCaseDefinition definition, TownCaseState state, TownCaseInspection inspection)
    {
        if (!this.CaseEditable(definition, state) || state.Sources.ContainsKey(inspection.Id)) return;
        if (!this.CaseInspectionReady(definition, state, inspection))
        {
            string direction = inspection.Site is not null && Game1.currentLocation.Name == inspection.Venue
                ? TownStoryRules.Direction(Game1.player.TilePoint.X, Game1.player.TilePoint.Y, inspection.Site.X, inspection.Site.Y) : "";
            this.CaseQuestion(null, inspection.Hint + (direction.Length > 0 ? "\n再向" + direction + "靠近指定地点。" : "")
                + "\n尚未满足本次记录条件。请关闭菜单，在合格现场完整观察 10 游戏分钟后再记录。", new[] { ("知道了", (Action)(() => { })) });
            return;
        }
        string text = inspection.Hint + (inspection.Mode == "sample" ? $"\n只核对背包中的 {inspection.ItemLabel} 1 份，不消耗、不交付。" : "\n记录当下的实际现场；不会自动告诉主人公。");
        this.CaseQuestion(null, text, new[]
        {
            ("确认记录这次核验", (Action)(() => this.RecordCaseInspection(definition, state, inspection))),
            ("先不记录", (Action)(() => { })),
        });
    }

    private void RecordCaseInspection(TownCaseDefinition definition, TownCaseState state, TownCaseInspection inspection)
    {
        // The menu can pause time. Every physical condition, including the sample or subject, is checked again here.
        if (!this.CaseInspectionReady(definition, state, inspection)) { this.LifeNotice("现场条件已变化，请重新核验。"); return; }
        LifeEvent entry = new()
        {
            Kind = "story.inspected", ClueId = inspection.Id, Venue = Game1.currentLocation.Name,
            X = Game1.player.TilePoint.X, Y = Game1.player.TilePoint.Y, Time = Game1.timeOfDay, Minutes = 10,
        };
        if (inspection.Mode == "site")
        { entry.Weather = GameState.Weather(); if (inspection.After is not null) entry.SourceId = state.Sources[inspection.After]; }
        else if (inspection.Mode == "sample") { entry.ItemId = inspection.ItemId; entry.Count = 1; }
        else
        {
            NPC subject = CaseNpc(inspection.Subject!)!;
            entry.Subject = inspection.Subject; entry.SubjectX = subject.TilePoint.X; entry.SubjectY = subject.TilePoint.Y;
        }
        if (!this.CommitCase(definition, entry)) return;
        this.caseClocks.Remove(CaseClockKey(definition, inspection));
        Game1.drawObjectDialogue(VanillaDialogue.Escape("你的现场笔记：\n" + this.CaseSourceText(definition, entry) + "\n回到主人公面前可以明确汇报。"));
    }

    private void TickCaseClocks(bool boundary = false)
    {
        if (!this.activeLoad || !Context.IsWorldReady) return;
        this.ReportCaseCompatibility();
        foreach (TownCaseDefinition definition in this.townCases.Values)
            if (this.lifeSave.Cases.TryGetValue(definition.Id, out TownCaseState? state))
                foreach (TownCaseInspection inspection in definition.Inspections)
                {
                    string key = CaseClockKey(definition, inspection);
                    if (state.Outcome is not null || state.Sources.ContainsKey(inspection.Id)) { this.caseClocks.Remove(key); continue; }
                    if (!this.caseClocks.TryGetValue(key, out TownCaseClock? clock)) this.caseClocks[key] = clock = new();
                    bool eligible = this.CasePhysical(definition, state, inspection), running = this.CaseClockRunning;
                    if (boundary) TownCaseRules.AdvanceClock(clock, this.currentDay, Game1.currentLocation.Name, Game1.timeOfDay, eligible, running);
                    else TownCaseRules.TickClock(clock, this.currentDay, Game1.currentLocation.Name, Game1.timeOfDay, eligible, running);
                }
    }
}
