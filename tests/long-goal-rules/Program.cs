using System.Text.Json;
using StardewAgentBridge;

int checks = 0;
void Check(string name, bool pass)
{
    if (!pass) throw new InvalidOperationException(name);
    checks++; Console.WriteLine("PASS " + name);
}
JsonSerializerOptions json = new() { PropertyNameCaseInsensitive = true };
T Copy<T>(T value) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(value, json), json)!;
LongGoalFile file = JsonSerializer.Deserialize<LongGoalFile>(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "long-goals.json")), json)!;
Check("all seven project definitions load from the production asset", file.Version == 1 && file.Goals.Count == 7 && file.Goals.All(LongGoalRules.Definition));
Check("all twenty-one chapters have three distinct readable outputs", file.Goals.Sum(g => g.Chapters.Count) == 21
    && file.Goals.SelectMany(g => g.Chapters).All(c => c.Outputs.Count == 3 && c.Outputs.Select(o => o.Text).Distinct().Count() == 3));

(LongGoalState State, List<LifeEvent> Events) History(LongGoalDefinition definition, string mode, string[]? chapterModes = null)
{
    List<LifeEvent> events = new(); int serial = 0;
    LifeEvent Add(string kind, int day, int? chapter = null)
    {
        LifeEvent entry = new() { Id = "life-" + ++serial, Npc = definition.Owner, Day = day, Kind = kind, LongGoalId = definition.Id, ChapterId = chapter };
        events.Add(entry); return entry;
    }
    LifeEvent? dependency = null;
    if (definition.RequiresStory is not null)
    {
        dependency = new() { Id = "life-" + ++serial, Npc = definition.Owner, Day = 4, Kind = "story.resolved", StoryId = definition.RequiresStory, Outcome = "independent" };
        events.Add(dependency);
    }
    LifeEvent started = Add("longgoal.started", 5); started.DependencySourceId = dependency?.Id;
    LongGoalState state = new() { StartId = started.Id, StartedDay = 5, DependencySourceId = dependency?.Id };
    for (int i = 0; i < 3; i++)
    {
        LongGoalChapter chapter = definition.Chapters[i]; LongGoalChapterState progress = state.Chapters[i];
        string chapterMode = chapterModes?[i] ?? mode;
        int opened = LongGoalRules.OpenedDay(state, i + 1), contributionDay = i == 0 ? opened : opened + 1;
        if (chapterMode != "none")
        {
            if (chapter.Contribution.Kind == "observation")
            {
                LifeEvent observed = Add("longgoal.observed", contributionDay, i + 1);
                observed.ContributionId = chapter.Contribution.Id; observed.Venue = chapter.Contribution.Venues[0].Map; observed.Weather = "rain"; observed.Minutes = 10;
                progress.ObservationId = observed.Id; progress.ObservationVenue = observed.Venue; progress.ObservationWeather = observed.Weather; progress.ObservationMinutes = 10;
            }
            LifeEvent contributed = Add("longgoal.contributed", contributionDay, i + 1); contributed.ContributionId = chapter.Contribution.Id;
            if (chapter.Contribution.Kind == "observation") contributed.SourceId = progress.ObservationId;
            else { contributed.ItemId = chapter.Contribution.ItemId; contributed.Count = chapter.Contribution.Count; }
            progress.ContributionId = contributed.Id;
            if (chapterMode is "a" or "b")
            {
                LifeEvent choice = Add("longgoal.choice", contributionDay, i + 1); choice.ChoiceId = chapterMode; choice.SourceId = contributed.Id;
                progress.ChoiceId = chapterMode;
            }
        }
        for (int step = 1; step <= 2; step++)
        {
            LifeEvent worked = Add("longgoal.worked", opened + step, i + 1); worked.Step = step; worked.Venue = definition.WorkVenues[0]; worked.Minutes = 30;
            progress.WorkStep = step; progress.LastWorkDay = worked.Day; progress.WorkAccumDay = worked.Day;
        }
        LifeEvent completed = Add("longgoal.completed", opened + 2, i + 1); completed.Outcome = LongGoalRules.Outcome(progress.ChoiceId);
        progress.CompletionId = completed.Id; progress.CompletedDay = completed.Day; progress.Outcome = completed.Outcome;
        LongGoalOutput output = chapter.Outputs.Single(o => o.Id == completed.Outcome);
        progress.ResultTitle = output.Title; progress.ResultText = output.Text + LongGoalRules.ContributionNote(chapter, progress);
    }
    state.CollectionTitle = definition.CollectionTitle; state.CollectionIntro = definition.CollectionIntro; state.CollectionClosing = definition.CollectionClosing;
    return (state, events);
}
foreach (LongGoalDefinition definition in file.Goals)
{
    foreach (string mode in new[] { "none", "helped", "a", "b" })
    {
        var history = History(definition, mode);
        Check(definition.Id + " " + mode + " validates all three native chapters", LongGoalRules.ValidState(definition, history.State, history.Events, 11));
        Check(definition.Id + " " + mode + " survives serialization without extra work", LongGoalRules.ValidState(definition, Copy(history.State), Copy(history.Events), 11));
        Check(definition.Id + " " + mode + " needs six distinct workdays", history.Events.Where(e => e.Kind == "longgoal.worked").Select(e => e.Day).Distinct().Count() == 6
            && history.State.Chapters[2].CompletedDay - history.State.StartedDay == 6);
        Check(definition.Id + " " + mode + " reads only the three selected products", history.State.Chapters.All(c => c.Outcome == (mode is "a" or "b" ? mode : "default"))
            && history.State.Chapters.All(c => mode == "none" ? !c.ResultText!.Contains("本章也记下") : c.ResultText!.Contains("本章也记下")));
    }
    var mixed = History(definition, "none", new[] { "a", "none", "b" });
    Check(definition.Id + " binds each collected chapter to its own participation", LongGoalRules.ValidState(definition, mixed.State, mixed.Events, 11)
        && mixed.State.Chapters.Select(c => c.Outcome).SequenceEqual(new[] { "a", "default", "b" }) && mixed.State.Chapters[1].ContributionId is null);
}
LongGoalDefinition leah = file.Goals.Single(g => g.Owner == "leah"), penny = file.Goals.Single(g => g.Owner == "penny");
void Invalid(string name, Action<LongGoalState, List<LifeEvent>> change, LongGoalDefinition? definition = null)
{
    definition ??= leah; var h = History(definition, "a"); change(h.State, h.Events);
    Check(name, !LongGoalRules.ValidState(definition, h.State, h.Events, 11));
}
Invalid("future chapters cannot accept an observation", (_, events) => events.First(e => e.Kind == "longgoal.observed").ChapterId = 2);
Invalid("chapter one cannot use a future source", (_, events) => events.First(e => e.Kind == "longgoal.contributed").SourceId = "life-999");
Invalid("another chapter's source cannot support a choice", (_, events) => events.First(e => e.Kind == "longgoal.choice").SourceId = events.Last(e => e.Kind == "longgoal.contributed").Id);
Invalid("observations are not a direct choice source", (_, events) => events.First(e => e.Kind == "longgoal.choice").SourceId = events.First(e => e.Kind == "longgoal.observed").Id);
Invalid("two work stages cannot occur on one day", (_, events) => events.First(e => e.Kind == "longgoal.worked" && e.Step == 2).Day = 6);
Invalid("first work cannot occur on the opening day", (_, events) => events.First(e => e.Kind == "longgoal.worked").Day = 5);
Invalid("later chapters cannot receive help on the previous completion day", (_, events) => events.First(e => e.Kind == "longgoal.contributed" && e.ChapterId == 2).Day = 7);
Invalid("work at an unrelated map is rejected", (_, events) => events.First(e => e.Kind == "longgoal.worked").Venue = "Hospital");
Invalid("a short work record cannot complete a stage", (_, events) => events.First(e => e.Kind == "longgoal.worked").Minutes = 20);
Invalid("a short observation cannot form a source", (_, events) => events.First(e => e.Kind == "longgoal.observed").Minutes = 9);
Invalid("unknown weather cannot form a source", (_, events) => events.First(e => e.Kind == "longgoal.observed").Weather = "fog");
Invalid("materials must match their exact qualified item ID", (_, events) => events.First(e => e.Kind == "longgoal.contributed" && e.ChapterId == 2).ItemId = "(O)709");
Invalid("materials must match the exact authored quantity", (_, events) => events.First(e => e.Kind == "longgoal.contributed" && e.ChapterId == 2).Count = 5);
Invalid("material and observation contribution fields cannot mix", (_, events) => events.First(e => e.Kind == "longgoal.contributed" && e.ChapterId == 2).SourceId = "life-1");
Invalid("a hidden observation cannot carry material fields", (_, events) => events.First(e => e.Kind == "longgoal.observed").ItemId = "(O)388");
Invalid("extra friendship fields cannot enter long-term history", (_, events) => events.First(e => e.Kind == "longgoal.worked").Friendship = 5);
Invalid("completed output must match the chosen direction", (_, events) => events.First(e => e.Kind == "longgoal.completed").Outcome = "b");
Invalid("altering the saved choice without its source is detected", (state, _) => state.Chapters[0].ChoiceId = "b");
Invalid("saved readable chapters cannot disappear", (state, _) => state.Chapters[0].ResultText = null);
Invalid("a future completion date is refused", (_, events) => events.Last().Day = 12);
Invalid("wrong owners cannot advance a project", (_, events) => events.First(e => e.Kind == "longgoal.worked").Npc = "gus");
Invalid("finished projects cannot accept another event", (_, events) => events.Add(new() { Id = "life-900", Npc = "leah", Day = 11, Kind = "longgoal.observed", LongGoalId = leah.Id, ChapterId = 3 }));
Invalid("dependency requires the actual prior story result", (_, events) => events[0].Kind = "story.started", penny);
Invalid("dependency must belong to the same owner", (_, events) => events[0].Npc = "gus", penny);
Invalid("dependency must be from an earlier day", (_, events) => events[0].Day = 5, penny);
Invalid("dependency must precede the start serial", (_, events) => { events[0].Id = "life-999"; events[1].DependencySourceId = "life-999"; }, penny);

var unstarted = new LongGoalState { StartId = "life-1", StartedDay = 5 };
var startOnly = new List<LifeEvent> { new() { Id = "life-1", Npc = "leah", Day = 5, Kind = "longgoal.started", LongGoalId = leah.Id } };
Check("an unhelped newly started project is a valid old-day snapshot", LongGoalRules.ValidState(leah, unstarted, startOnly, 5));
unstarted.Chapters[0].WorkMinutes = 20; unstarted.Chapters[0].WorkAccumDay = 6; unstarted.Chapters[0].WorkMap = "Forest";
Check("saved partial work is valid without falsely recording a stage", LongGoalRules.ValidState(leah, unstarted, startOnly, 6));
Check("partial work resets at the next day without awarding credit", LongGoalRules.Accumulate(20, 6, "Forest", 7, "Forest", 0) == 0);
int departed = LongGoalRules.Accumulate(10, 6, "Forest", 6, "Beach", 0);
Check("a zero-clock map excursion erases old workplace credit", departed == 0 && LongGoalRules.Accumulate(departed, 6, null, 6, "Forest", 10) == 10);
Check("same-place paused work stays saved but gains no minutes", LongGoalRules.Accumulate(20, 6, "Forest", 6, "Forest", 0) == 20);
Check("work only becomes eligible after the opening day", !LongGoalRules.WorkDay(5, 5, 0, 0) && LongGoalRules.WorkDay(6, 5, 0, 0));
Check("each second stage needs a new day", !LongGoalRules.WorkDay(6, 5, 1, 6) && LongGoalRules.WorkDay(7, 5, 1, 6));
Check("future chapter menus remain locked on the previous completion day", !LongGoalRules.ChapterAvailable(2, 7, 7) && LongGoalRules.ChapterAvailable(2, 8, 7));
Check("the initial observation may start after the initial meeting", LongGoalRules.ChapterAvailable(1, 5, 5));
Check("work two freezes all further contributions", !LongGoalRules.Editable(1, 1, 7, 5, 2, null));
Check("a stale chapter callback cannot act on the next chapter", !LongGoalRules.Editable(1, 2, 8, 5, 1, null));
Check("sleeping actors are never workers", !LongGoalRules.Worker(true, 900, true, false, false, false));
Check("walking actors are never workers", !LongGoalRules.Worker(true, 900, false, true, false, false));
Check("controlled actors and construction never count", !LongGoalRules.Worker(true, 900, false, false, true, false)
    && !LongGoalRules.Worker(true, 900, false, false, false, true));
Check("disabled or paused clocks never count", !LongGoalRules.Worker(false, 900, false, false, false, false));
Check("normal daytime work remains available", LongGoalRules.Worker(true, 900, false, false, false, false));
Check("nighttime stationary actors are not workers", !LongGoalRules.Worker(true, 2100, false, false, false, false)
    && !LongGoalRules.Worker(true, 750, false, false, false, false));
Check("only full in-window ten-minute steps count", LongGoalRules.ClockStep(800, 810, true, 6, 6, "Forest", "Forest", true) == 10
    && LongGoalRules.ClockStep(1950, 2000, true, 6, 6, "Forest", "Forest", true) == 10);
Check("window-edge partial work is not backfilled", LongGoalRules.ClockStep(750, 800, true, 6, 6, "Forest", "Forest", true) == 0
    && LongGoalRules.ClockStep(2000, 2010, true, 6, 6, "Forest", "Forest", true) == 0);
Check("clock skips and interrupted intervals do not count", LongGoalRules.ClockStep(900, 930, true, 6, 6, "Forest", "Forest", true) == 0
    && LongGoalRules.ClockStep(900, 910, false, 6, 6, "Forest", "Forest", false) == 0);
foreach (string owner in new[] { "penny", "elliott", "leah", "maru" })
    Check(owner + " only works in the player's farmhouse as their actual spouse", LongGoalRules.Workplace(owner, "FarmHouse", true) && !LongGoalRules.Workplace(owner, "FarmHouse", false));
Check("other NPCs do not gain a farmhouse workplace", !LongGoalRules.Workplace("robin", "FarmHouse", true)
    && !LongGoalRules.Workplace("linus", "FarmHouse", true));
Check("engagement and roommate labels do not become marriage evidence", !LongGoalRules.ActualSpouse("leah", "Leah", "engaged")
    && !LongGoalRules.ActualSpouse("leah", "Leah", "roommate") && LongGoalRules.ActualSpouse("leah", "Leah", "married"));
Check("another spouse name cannot authorize home work", !LongGoalRules.ActualSpouse("leah", "Penny", "married"));
Check("Maru's clinic shift is not private project work", !LongGoalRules.Workplace("maru", "Hospital", false));

var observedOnly = new LongGoalChapterState { ObservationId = "life-2", ObservationVenue = "Forest", ObservationWeather = "rain", ObservationMinutes = 10 };
Check("unreported observations are absent from readable contribution notes", LongGoalRules.ContributionNote(leah.Chapters[0], observedOnly) == "");
observedOnly.ContributionId = "life-3";
Check("help with no chosen direction is still acknowledged", LongGoalRules.Outcome(observedOnly.ChoiceId) == "default"
    && LongGoalRules.ContributionNote(leah.Chapters[0], observedOnly).Contains("当面分享"));
Check("material acknowledgments do not invent collection or manufacture", LongGoalRules.ContributionNote(leah.Chapters[1], new() { ContributionId = "life-4" }).Contains("交付 4")
    && !LongGoalRules.ContributionNote(leah.Chapters[1], new() { ContributionId = "life-4" }).Contains("采集"));

var first = new StackItem { Count = 2, Identity = "wood-one" }; var second = new StackItem { Count = 5, Identity = "wood-two" };
StackItem?[] bag = { first, null, second };
var stacks = new[] { (Slot: 0, Item: first, Stack: 2), (Slot: 2, Item: second, Stack: 5) };
bool saved = LongGoalRules.Deliver(stacks, 4, (item, value) => item.Count = value, (slot, item) => bag[slot] = item, () => true);
Check("successful delivery consumes the fixed count across exact slots", saved && bag[0] is null && ReferenceEquals(bag[2], second) && second.Count == 3);
first.Count = 2; second.Count = 5; bag[0] = first;
saved = LongGoalRules.Deliver(stacks, 4, (item, value) => item.Count = value, (slot, item) => bag[slot] = item, () => false);
Check("failed event append restores exact objects slots and quantities", !saved && ReferenceEquals(bag[0], first) && ReferenceEquals(bag[2], second) && first.Count == 2 && second.Count == 5);
bool threw = false;
try { LongGoalRules.Deliver(stacks, 4, (item, value) => item.Count = value, (slot, item) => bag[slot] = item, () => throw new IOException("disk failure")); }
catch (IOException) { threw = true; }
Check("a throwing writer also restores exact inventory", threw && ReferenceEquals(bag[0], first) && ReferenceEquals(bag[2], second) && first.Count == 2 && second.Count == 5);
bool attempted = false;
saved = LongGoalRules.Deliver(stacks, 8, (item, value) => item.Count = value, (slot, item) => bag[slot] = item, () => { attempted = true; return true; });
Check("insufficient materials never mutate inventory or append an event", !saved && !attempted && first.Count == 2 && second.Count == 5);
Check("similar names cannot substitute another qualified item", !LongGoalRules.Material("(O)709", "(O)388", 99, 4));

var full = History(leah, "a");
Check("new history requires the explicit capability", !LongGoalRules.Compatible(false, full.Events) && LongGoalRules.Compatible(true, full.Events));
Check("old life and story histories do not require the new capability", LongGoalRules.Compatible(false, new[] { new LifeEvent { Kind = "story.started" }, new LifeEvent { Kind = "goal.accepted" } }));
Check("only a new long-term event upgrades the native save version", LongGoalRules.VersionAfterEvent(1, "goal.delivered") == 1
    && LongGoalRules.VersionAfterEvent(1, "story.started") == 1 && LongGoalRules.VersionAfterEvent(1, "longgoal.started") == 2);
Check("v1 with new history is rejected instead of losing new fields", !LongGoalRules.SaveVersion(1, full.Events) && LongGoalRules.SaveVersion(2, full.Events));
Check("empty legacy saves remain version one", LongGoalRules.SaveVersion(1, Array.Empty<LifeEvent>()) && !LongGoalRules.SaveVersion(4, Array.Empty<LifeEvent>()));
JsonElement oldWire = LifeEventWire.Encode(new[] { new LifeEvent { Id = "life-1", Npc = "gus", Day = 1, Kind = "story.started", StoryId = "gus_parcel" } })[0];
Check("new fields never appear on the old story wire", oldWire.EnumerateObject().Count() == 5 && !oldWire.TryGetProperty("chapterId", out _));
JsonElement materialWire = LifeEventWire.Encode(full.Events.Where(e => e.Kind == "longgoal.contributed" && e.ChapterId == 2))[0];
Check("material wire carries exact fields without a fabricated observation", materialWire.EnumerateObject().Count() == 9
    && materialWire.GetProperty("itemId").GetString() == "(O)388" && !materialWire.TryGetProperty("sourceId", out _));
JsonElement choiceWire = LifeEventWire.Encode(full.Events.Where(e => e.Kind == "longgoal.choice").Take(1))[0];
Check("choice wire links the real contribution event", choiceWire.EnumerateObject().Count() == 8 && choiceWire.TryGetProperty("sourceId", out _));
Console.WriteLine($"{checks}/{checks} passed; no game process or save was opened.");

sealed class StackItem
{
    public string Identity { get; set; } = "";
    public int Count { get; set; }
}
