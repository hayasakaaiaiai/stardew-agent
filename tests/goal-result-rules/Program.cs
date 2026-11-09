using System.Text.Json;
using StardewAgentBridge;

int checks = 0;
void Check(string name, bool value) { if (!value) throw new InvalidOperationException(name); checks++; Console.WriteLine("PASS " + name); }
JsonSerializerOptions json = new() { PropertyNameCaseInsensitive = true };
T Copy<T>(T value) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(value, json), json)!;
GoalResultFile file = JsonSerializer.Deserialize<GoalResultFile>(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "goal-results.json")), json)!;
Check("the production asset defines seven practices and fourteen checkpoints", file.Version == 1 && file.Practices.Count == 7
    && file.Practices.All(GoalResultRules.Definition) && file.Practices.Sum(p => p.Checkpoints.Count) == 14);
Check("every authored operation has two complete choices", file.Practices.Sum(p => p.PlanChoices.Count + p.FinishChoices.Count + p.ReviewChoices.Count
    + p.Checkpoints.Sum(c => c.Choices.Count)) == 70);

List<LifeEvent> History(GoalResultDefinition definition, string plan = "a", string checkpoint = "a", string finish = "a", string review = "a")
{
    List<LifeEvent> events = new(); int serial = 0;
    for (int chapter = 1; chapter <= 3; chapter++) events.Add(new()
    { Id = "life-" + ++serial, Npc = definition.Owner, Day = chapter, Kind = "longgoal.completed", LongGoalId = definition.ProjectId, ChapterId = chapter, Outcome = "a" });
    LifeEvent Add(string kind, int day = 5)
    {
        LifeEvent entry = new() { Id = "life-" + ++serial, Npc = definition.Owner, Day = day, Kind = kind, ProjectId = definition.ProjectId };
        events.Add(entry); return entry;
    }
    var notified = Add("goalresult.notified"); notified.ChapterId = 3; notified.SourceId = "life-3";
    var started = Add("goalresult.started"); started.SourceId = "life-3"; started.ChoiceId = plan;
    for (int point = 1; point <= definition.Checkpoints.Count; point++)
    {
        var entry = Add("goalresult.checkpoint"); entry.AttemptId = started.Id; entry.Point = point; entry.Venue = definition.Venue;
        entry.X = point == 2 ? 16 : point == 3 && definition.Owner == "robin" ? 12 : 10;
        entry.Y = point == 3 ? definition.Owner == "robin" ? 11 : 16 : 10;
        entry.Time = 900 + point * 10; entry.Weather = "rain"; entry.Minutes = point * 10;
        entry.Count = definition.Mode == "walk" ? 0 : 1; entry.ChoiceId = checkpoint;
    }
    string lastPoint = events[^1].Id;
    var completed = Add("goalresult.completed"); completed.AttemptId = started.Id; completed.SourceId = lastPoint;
    completed.Minutes = definition.Minutes; completed.Count = definition.Mode == "walk" ? 0 : definition.Owner == "linus" && checkpoint == "b" ? 2 : 1;
    completed.ChoiceId = finish;
    var reviewed = Add("goalresult.reviewed", 6); reviewed.SourceId = completed.Id; reviewed.ChoiceId = review;
    return events;
}
GoalResultState Saved(GoalResultDefinition definition, List<LifeEvent> events)
{
    GoalResultState state = GoalResultRules.Replay(definition, events, 6) ?? throw new InvalidOperationException("fixture replay failed");
    if (GoalResultRules.Completed(state) is GoalResultAttempt completed)
    {
        GoalResultRules.BuildReceipt(definition, state, completed);
        if (state.ReviewId is not null) state.ReviewText = GoalResultRules.ReviewText(definition, completed, state.ReviewChoiceId!);
    }
    return state;
}
foreach (GoalResultDefinition definition in file.Practices)
{
    foreach (string value in new[] { "a", "b" }) foreach (string ending in new[] { "a", "b" })
    {
        List<LifeEvent> events = History(definition, value, value, ending, value);
        GoalResultState state = Saved(definition, events);
        Check(definition.ProjectId + value + ending + " replays the chosen route and real action", GoalResultRules.ValidState(definition, state, events, 6));
        Check(definition.ProjectId + value + ending + " survives save reload without phantom actors", GoalResultRules.ValidState(definition, Copy(state), Copy(events), 6)
            && GoalResultRules.Active(Copy(state)) is null);
        Check(definition.ProjectId + value + ending + " receipt includes actual selected plan checkpoint and finish", state.ReceiptPages[0].Text == definition.PlanChoices.Single(c => c.Id == value).Text
            && state.ReceiptPages[1].Text.Contains(definition.Checkpoints[0].Choices.Single(c => c.Id == value).Text)
            && state.ReceiptPages[^1].Text == definition.FinishChoices.Single(c => c.Id == ending).Text
            && state.ReviewText!.Contains(definition.ReviewChoices.Single(c => c.Id == value).Text));
    }
}
GoalResultDefinition penny = file.Practices.Single(p => p.Owner == "penny"), leah = file.Practices.Single(p => p.Owner == "leah"),
    robin = file.Practices.Single(p => p.Owner == "robin"), willy = file.Practices.Single(p => p.Owner == "willy"), linus = file.Practices.Single(p => p.Owner == "linus");
void Invalid(string name, Action<List<LifeEvent>> mutate, GoalResultDefinition? definition = null, string checkpoint = "a")
{
    definition ??= penny; var events = History(definition, checkpoint: checkpoint); mutate(events);
    Check(name, GoalResultRules.Replay(definition, events, 6) is null);
}
Invalid("practice needs the owner's third completed chapter", e => e.First(v => v.Kind == "goalresult.started").SourceId = "life-2");
Invalid("future completion sources cannot unlock a practice", e => e.First(v => v.Kind == "goalresult.started").SourceId = e.Last(v => v.Kind == "goalresult.completed").Id);
Invalid("a different project cannot supply the collection", e => e[2].LongGoalId = "leah_form_study");
Invalid("a different owner cannot supply the collection", e => e[2].Npc = "gus");
Invalid("notification only names the latest completed chapter", e => { var n = e.First(v => v.Kind == "goalresult.notified"); n.ChapterId = 1; n.SourceId = "life-1"; });
Invalid("a duplicate chapter notification cannot be replayed as new", e => { var n = Copy(e.First(v => v.Kind == "goalresult.notified")); n.Id = "life-999"; n.Day = 6; e.Add(n); });
Invalid("completed practices cannot start a second attempt", e => { var n = Copy(e.First(v => v.Kind == "goalresult.started")); n.Id = "life-999"; n.Day = 6; e.Add(n); });
Invalid("parallel active attempts are rejected", e =>
{ e.RemoveAll(v => v.Kind is "goalresult.completed" or "goalresult.reviewed"); var n = Copy(e.First(v => v.Kind == "goalresult.started")); n.Id = "life-999"; n.Day = 6; e.Add(n); });
Invalid("stale attempts cannot add checkpoints", e => e.First(v => v.Kind == "goalresult.checkpoint").AttemptId = "life-999");
Invalid("later checkpoint indices cannot skip ahead", e => e.First(v => v.Kind == "goalresult.checkpoint").Point = 2);
Invalid("same coordinates on another map are not the venue", e => e.First(v => v.Kind == "goalresult.checkpoint").Venue = "Farm");
Invalid("coordinates outside the bounded game map are rejected", e => e.First(v => v.Kind == "goalresult.checkpoint").X = 501);
Invalid("five-minute partial clock readings cannot be checkpoints", e => e.First(v => v.Kind == "goalresult.checkpoint").Time = 915);
Invalid("invalid sixty-minute game clocks are rejected", e => e.First(v => v.Kind == "goalresult.checkpoint").Time = 960);
Invalid("unknown weather is rejected", e => e.First(v => v.Kind == "goalresult.checkpoint").Weather = "fog");
Invalid("first checkpoint needs ten actual minutes", e => e.First(v => v.Kind == "goalresult.checkpoint").Minutes = 0);
Invalid("first checkpoint cannot have more company than elapsed time", e => e.First(v => v.Kind == "goalresult.checkpoint").Minutes = 20);
Invalid("a later point cannot invent fifty minutes in ten clock minutes", e => e.Last(v => v.Kind == "goalresult.checkpoint").Minutes = 60);
Invalid("a stationary second checkpoint cannot meet the route", e => e.Last(v => v.Kind == "goalresult.checkpoint").X = 15);
Invalid("Leah requires every pair of positions to be apart", e => { var p = e.Last(v => v.Kind == "goalresult.checkpoint"); p.X = 16; p.Y = 11; }, leah);
Invalid("Robin must actually return close to the first point", e => { var p = e.Last(v => v.Kind == "goalresult.checkpoint"); p.X = 14; p.Y = 10; }, robin);
Invalid("walking does not inherit an unrelated forage count", e => e.First(v => v.Kind == "goalresult.checkpoint").Count = 1);
Invalid("Willy needs an actual catch at the checkpoint", e => e.First(v => v.Kind == "goalresult.checkpoint").Count = 0, willy);
Invalid("Linus needs actual gathering at the checkpoint", e => e.First(v => v.Kind == "goalresult.checkpoint").Count = 0, linus);
Invalid("Linus two-item choice requires at least two by completion", e => e.First(v => v.Kind == "goalresult.completed").Count = 1, linus, "b");
Invalid("completed action totals cannot fall below a checkpoint", e => e.First(v => v.Kind == "goalresult.completed").Count = 0, willy);
Invalid("completion cannot refer to an earlier checkpoint", e => e.First(v => v.Kind == "goalresult.completed").SourceId = e.First(v => v.Kind == "goalresult.checkpoint").Id);
Invalid("completion cannot skip required minutes", e => e.First(v => v.Kind == "goalresult.completed").Minutes = 20);
Invalid("completion cannot continue on a new game day", e => e.First(v => v.Kind == "goalresult.completed").Day = 6);
Invalid("review requires a later day", e => e.Last().Day = 5);
Invalid("review must refer to completion rather than a checkpoint", e => e.Last().SourceId = e.First(v => v.Kind == "goalresult.checkpoint").Id);
Invalid("review cannot be repeated", e => { var r = Copy(e.Last()); r.Id = "life-999"; e.Add(r); });
Invalid("ordinary activity and friendship fields never enter practice", e => e.First(v => v.Kind == "goalresult.completed").Friendship = 10);
Invalid("events beyond the loaded game day are rejected", e => e.Last().Day = 7);

foreach (string reason in new[] { "player", "interrupted", "load" })
{
    List<LifeEvent> events = History(penny).TakeWhile(e => e.Kind != "goalresult.completed").ToList();
    var started = events.First(e => e.Kind == "goalresult.started");
    int day = reason == "player" ? 5 : 6;
    events.Add(new() { Id = "life-30", Npc = penny.Owner, Day = day, Kind = "goalresult.cancelled", ProjectId = penny.ProjectId, AttemptId = started.Id, Reason = reason });
    GoalResultState state = Saved(penny, events);
    Check(reason + " cancellation keeps evidence but creates no completion receipt", GoalResultRules.ValidState(penny, state, events, 6)
        && GoalResultRules.Active(state) is null && GoalResultRules.Completed(state) is null && state.ReceiptPages.Count == 0);
    events.Add(new() { Id = "life-31", Npc = penny.Owner, Day = day, Kind = "goalresult.started", ProjectId = penny.ProjectId, SourceId = "life-3", ChoiceId = "b" });
    Check(reason + " allows a fresh separately identified retry", GoalResultRules.Replay(penny, events, 6) is { } retry && GoalResultRules.Active(retry)?.Id == "life-31");
    events.Add(new() { Id = "life-32", Npc = penny.Owner, Day = day, Kind = "goalresult.checkpoint", ProjectId = penny.ProjectId, AttemptId = started.Id,
        Point = 1, Venue = "Forest", X = 10, Y = 10, Time = 1000, Weather = "rain", Minutes = 10, Count = 0, ChoiceId = "a" });
    Check(reason + " retry cannot reuse the cancelled controller's attempt", GoalResultRules.Replay(penny, events, 6) is null);
}
var pendingEvents = History(penny).TakeWhile(e => e.Kind != "goalresult.checkpoint").ToList();
var pending = Saved(penny, pendingEvents);
Check("a loaded active attempt has only evidence and no restored controller", GoalResultRules.ValidState(penny, Copy(pending), Copy(pendingEvents), 6)
    && GoalResultRules.Active(pending)?.Points.Count == 0 && pending.ReceiptText is null);
var invalidPlayerCancel = Copy(pendingEvents); invalidPlayerCancel.Add(new() { Id = "life-30", Npc = penny.Owner, Day = 6, Kind = "goalresult.cancelled",
    ProjectId = penny.ProjectId, AttemptId = GoalResultRules.Active(pending)!.Id, Reason = "player" });
Check("later-day recovery cannot pretend the player cancelled yesterday", GoalResultRules.Replay(penny, invalidPlayerCancel, 6) is null);
Check("reading a cancelled or active attempt cannot unlock review", !GoalResultRules.Review(GoalResultRules.Active(pending), null, 7));

var completeEvents = History(penny); var cache = Saved(penny, completeEvents);
cache.ReceiptText += " 还建造了一栋房屋。";
Check("receipt prose without event-derived evidence is rejected", !GoalResultRules.ValidState(penny, cache, completeEvents, 6));
cache = Saved(penny, completeEvents); cache.ReceiptPages[1].Text = "另一条尚未选择的路线";
Check("unselected checkpoint text cannot replace the receipt", !GoalResultRules.ValidState(penny, cache, completeEvents, 6));
cache = Saved(penny, completeEvents); cache.ReviewText = "已经再次完成一次行动。";
Check("review text cannot invent a second practice", !GoalResultRules.ValidState(penny, cache, completeEvents, 6));
cache = Saved(penny, completeEvents); cache.Attempts[0].Points[0].X++;
Check("saved positions must agree with the journal", !GoalResultRules.ValidState(penny, cache, completeEvents, 6));

Check("seven hearts cannot bypass existing friendship rules", !GoalResultRules.Friendship(7, "friend") && !GoalResultRules.Friendship(7, "dating"));
Check("eight hearts spouse and roommate use existing eligibility", GoalResultRules.Friendship(8, "friend") && GoalResultRules.Friendship(2, "married") && GoalResultRules.Friendship(2, "roommate"));
Check("correct map proximity and unpaused time can count", GoalResultRules.Together("Forest", "Forest", true, true, false, false));
Check("off-map action and distant actors never count", !GoalResultRules.Together("Forest", "Town", true, true, false, false)
    && !GoalResultRules.Together("Forest", "Forest", false, true, false, false));
Check("menus pauses and warp intervals never count", !GoalResultRules.Together("Forest", "Forest", true, true, true, false)
    && !GoalResultRules.Together("Forest", "Forest", true, false, false, false) && !GoalResultRules.Together("Forest", "Forest", true, true, false, true));
Check("ordinary whole clock steps credit exactly ten minutes", LifeActivityRules.ClockStep(950, 1000, true) == 10 && LifeActivityRules.ClockStep(900, 930, true) == 0
    && LifeActivityRules.ClockStep(900, 910, false) == 0);
Check("new results require v3 while old saves remain readable", GoalResultRules.SaveVersion(1, Array.Empty<LifeEvent>()) && GoalResultRules.SaveVersion(2, Array.Empty<LifeEvent>())
    && GoalResultRules.SaveVersion(3, completeEvents) && !GoalResultRules.SaveVersion(2, completeEvents) && !GoalResultRules.SaveVersion(5, completeEvents));
Check("a new long goal event must never downgrade a v3 save", LongGoalRules.VersionAfterEvent(3, "longgoal.completed") == 3 && LongGoalRules.SaveVersion(3, completeEvents));
Check("the first result event upgrades and older domains preserve v3", GoalResultRules.VersionAfterEvent(2, "goalresult.started") == 3
    && GoalResultRules.VersionAfterEvent(3, "story.started") == 3 && LongGoalRules.VersionAfterEvent(1, "longgoal.started") == 2);
Check("old backends admit only journals without new result events", GoalResultRules.Compatible(false, Array.Empty<LifeEvent>())
    && !GoalResultRules.Compatible(false, completeEvents) && GoalResultRules.Compatible(true, completeEvents));
JsonElement pointWire = LifeEventWire.Encode(completeEvents.Where(e => e.Kind == "goalresult.checkpoint").Take(1))[0];
Check("checkpoint wire includes only the fifteen required native fields", pointWire.EnumerateObject().Count() == 15
    && pointWire.GetProperty("x").GetInt32() == 10 && pointWire.GetProperty("attemptId").GetString() == "life-5" && !pointWire.TryGetProperty("friendship", out _));
JsonElement oldWire = LifeEventWire.Encode(new[] { new LifeEvent { Id = "life-1", Day = 1, Npc = "leah", Kind = "longgoal.started", LongGoalId = "leah_form_study" } })[0];
Check("old long-goal events carry none of the new practice fields", oldWire.EnumerateObject().Count() == 5 && !oldWire.TryGetProperty("projectId", out _));
Console.WriteLine($"{checks}/{checks} passed; no game process or save was opened.");
