using System.Text.Json;
using StardewAgentBridge;

int checks = 0;
void Check(string name, bool pass)
{
    if (!pass) throw new InvalidOperationException(name);
    checks++;
    Console.WriteLine("PASS " + name);
}

Check("all twelve original partners admit each actual romantic relation", RomanceRules.Npcs.Count == 12
    && RomanceRules.Npcs.All(npc => new[] { "dating", "engaged", "married" }.All(relation => RomanceRules.Eligible(npc, relation))));
Check("high-heart friendship and roommates never become dates", RomanceRules.Npcs.All(npc =>
    !RomanceRules.Eligible(npc, "friend") && !RomanceRules.Eligible(npc, "roommate")) && !RomanceRules.Eligible("krobus", "married"));
Check("unknown partners and relation spellings fail closed", !RomanceRules.Eligible("Leah", "dating")
    && !RomanceRules.Eligible("leah", "dating ") && !RomanceRules.Eligible("wizard", "dating"));
Check("all offered times can be planned today or tomorrow", RomanceRules.Times.All(time =>
    RomanceRules.Plan(10, 10, time, 600) && RomanceRules.Plan(10, 11, time, 2300)));
Check("today's past slot and unsupported slots are rejected", !RomanceRules.Plan(10, 10, 1000, 1010)
    && !RomanceRules.Plan(10, 10, 1100, 600));
Check("planning accepts the current time and rejects days outside the window", RomanceRules.Plan(10, 10, 1400, 1400)
    && !RomanceRules.Plan(10, 9, 1400, 600) && !RomanceRules.Plan(10, 12, 1400, 600));
Check("invalid clocks and nonpositive game days cannot create plans", !RomanceRules.Plan(0, 0, 1000, 600)
    && !RomanceRules.Plan(10, 11, 1000, 1360) && !RomanceRules.Plan(10, 11, 1000, 2700));
Check("departure allows the exact planned time through the inclusive hour", RomanceRules.Depart(10, 10, 1000, 1000)
    && RomanceRules.Depart(10, 10, 1000, 1100) && RomanceRules.Depart(10, 10, 1700, 1800));
Check("early, late, and wrong-day departures fail", !RomanceRules.Depart(10, 10, 1000, 950)
    && !RomanceRules.Depart(10, 10, 1000, 1110) && !RomanceRules.Depart(11, 10, 1000, 1000));
Check("expiry agrees with the inclusive departure boundary", !RomanceRules.Expired(10, 10, 1400, 1500)
    && RomanceRules.Expired(10, 10, 1400, 1510));
Check("yesterday expires without expiring tomorrow", RomanceRules.Expired(11, 10, 1700, 600)
    && !RomanceRules.Expired(10, 11, 1000, 2500));
Check("every supported venue counts only its matching map", RomanceRules.Venues.All(venue =>
    RomanceRules.CountTime(venue, venue, true, true) && !RomanceRules.CountTime(venue, "Farm", true, true)));
Check("travelling, separation, and lost romance credit no time", !RomanceRules.CountTime("Forest", "Town", true, true)
    && !RomanceRules.CountTime("Forest", "Forest", false, true) && !RomanceRules.CountTime("Forest", "Forest", true, false)
    && !RomanceRules.CountTime("Farm", "Farm", true, true));
Check("thirty real minutes are necessary and sufficient", !RomanceRules.Complete(29, true, true)
    && RomanceRules.Complete(30, true, true) && RomanceRules.Complete(60, true, true));
Check("a stale load or changed relationship cannot complete", !RomanceRules.Complete(90, false, true)
    && !RomanceRules.Complete(90, true, false));
Check("clock skips do not masquerade as thirty minutes together", LifeActivityRules.ClockStep(1000, 1030, true) == 0
    && LifeActivityRules.ClockStep(1050, 1100, true) == 10);
Check("paused or separated intervals contribute no minutes", LifeActivityRules.ClockStep(1000, 1000, true) == 0
    && LifeActivityRules.ClockStep(1000, 1010, false) == 0);
Check("first existing romance may invite without a fabricated anniversary", RomanceRules.Invite(1, 0, 0));
Check("one invitation consumes the global daily opportunity", !RomanceRules.Invite(10, 0, 10)
    && !RomanceRules.Invite(10, 7, 10));
Check("NPC invitations have a persistent three-day cooldown", !RomanceRules.Invite(12, 10, 11)
    && RomanceRules.Invite(13, 10, 12));
Check("future saved invitations cannot bypass cooldown on rollback", !RomanceRules.Invite(9, 10, 10));
Check("preparation and memory choices use only supported values", RomanceRules.Preparation("quiet") && RomanceRules.Preparation("talk")
    && !RomanceRules.Preparation("gift") && RomanceRules.Detail("place") && RomanceRules.Detail("weather")
    && RomanceRules.Detail("company") && !RomanceRules.Detail("photo"));

List<LifeEvent> history = Enumerable.Range(1, 30).Select(i => new LifeEvent
{
    Id = "life-" + i, Npc = "leah", Day = i, Kind = "romance.completed", DateId = "date-" + i,
    Venue = "Forest", Weather = "sunny", Minutes = 30, Relation = "dating", Friendship = 0,
}).ToList();
history.Add(new() { Id = "life-31", Npc = "elliott", Day = 30, Kind = "romance.completed", DateId = "date-31" });
history.Add(new() { Id = "life-32", Npc = "leah", Day = 30, Kind = "activity.completed", Activity = "forest_walk" });
List<LifeEvent> retained = RomanceRules.Memories(history, "leah");
Check("bounded recall keeps first plus most recent twenty-four completions", retained.Count == 25
    && retained[0].Id == "life-1" && retained[1].Id == "life-7" && retained[^1].Id == "life-30");
Check("ordinary activities and another partner never enter romantic recall", retained.All(e => e.Npc == "leah" && e.Kind == "romance.completed"));
Check("a short history does not duplicate its first completion", RomanceRules.Memories(history.Take(3), "leah").Count == 3
    && RomanceRules.Memories(Array.Empty<LifeEvent>(), "leah").Count == 0);
Check("first and recent completions remain selectable", RomanceRules.Rememberable(history, "leah", history[0])
    && RomanceRules.Rememberable(history, "leah", history[29]));
Check("evicted middle history cannot create a new memory selection", !RomanceRules.Rememberable(history, "leah", history[1]));
Check("another partner's completion cannot become this partner's memory", !RomanceRules.Rememberable(history, "leah", history[30]));
Check("arriving or starting is never a completion source", !RomanceRules.Rememberable(history, "leah", new LifeEvent
    { Id = "life-30", Npc = "leah", Kind = "romance.started", DateId = "date-30" }));
Check("reused IDs with another date cannot impersonate a completion", !RomanceRules.Rememberable(history, "leah", new LifeEvent
    { Id = "life-30", Npc = "leah", Kind = "romance.completed", DateId = "date-999" }));
Check("unknown branch events cannot become recall sources", !RomanceRules.Rememberable(history, "leah", new LifeEvent
    { Id = "life-999", Npc = "leah", Kind = "romance.completed", DateId = "date-999" }));
history.Add(new() { Id = "life-33", Npc = "leah", Day = 30, Kind = "romance.remembered", DateId = "date-30", SourceId = "life-30", Detail = "weather" });
Check("one completion permits only one memory emphasis", !RomanceRules.Rememberable(history, "leah", history[29])
    && RomanceRules.Rememberable(history, "leah", history[0]));

LifeEvent planned = new()
{
    Id = "life-42", Npc = "leah", Day = 10, Kind = "romance.planned", DateId = "date-42", Venue = "Forest",
    DateDay = 11, Time = 1400, Preparation = "quiet", Relation = "dating", Initiator = "player", SourceId = "life-30",
};
JsonElement plan = LifeEventWire.Encode(new[] { planned })[0];
Check("plans serialize the agreed native wire names", plan.GetProperty("dateId").GetString() == "date-42"
    && plan.GetProperty("dateDay").GetInt32() == 11 && plan.GetProperty("time").GetInt32() == 1400
    && plan.GetProperty("sourceId").GetString() == "life-30" && !plan.TryGetProperty("DateId", out _));
Check("planning does not serialize absent completion or activity fields", !plan.TryGetProperty("minutes", out _)
    && !plan.TryGetProperty("friendship", out _) && !plan.TryGetProperty("activity", out _) && !plan.TryGetProperty("reason", out _));
JsonElement cancelled = LifeEventWire.Encode(new[] { new LifeEvent
    { Id = "life-43", Npc = "leah", Day = 10, Kind = "romance.cancelled", DateId = "date-42", Reason = "relationship" } })[0];
Check("breakup cancellation carries no false current relation or penalty", cancelled.EnumerateObject().Count() == 6
    && !cancelled.TryGetProperty("relation", out _) && !cancelled.TryGetProperty("friendship", out _));
JsonElement complete = LifeEventWire.Encode(new[] { history[0] })[0];
Check("zero actual friendship is retained without a second activity outcome", complete.GetProperty("friendship").GetInt32() == 0
    && complete.GetProperty("kind").GetString() == "romance.completed" && !complete.TryGetProperty("activity", out _));
LifeEvent oldLife = new() { Id = "life-1", Npc = "leah", Day = 1, Kind = "activity.completed", Activity = "forest_walk", Minutes = 30, Friendship = 8 };
JsonElement oldWire = LifeEventWire.Encode(new[] { oldLife })[0];
Check("old life wire remains free of absent romance fields", oldWire.EnumerateObject().Count() == 7
    && !oldWire.TryGetProperty("dateId", out _) && !oldWire.TryGetProperty("relation", out _));
Check("old backends still admit old life-only journals", RomanceRules.Compatible(false, new[] { oldLife })
    && RomanceRules.Compatible(false, Array.Empty<LifeEvent>()));
Check("old backends cannot receive incompatible mixed replay", !RomanceRules.Compatible(false, new[] { oldLife, planned })
    && RomanceRules.Compatible(true, new[] { oldLife, planned }));
Check("romantic company is private and uses the real thirty-minute threshold", LifeActivityRules.Activities.Contains("romantic_date")
    && !LifeActivityRules.PublicActivity("romantic_date") && !LifeActivityRules.Ready("romantic_date", 20, 999)
    && LifeActivityRules.Ready("romantic_date", 30, 0));
Check("offline release stays available while new actions stay blocked", LifeActivityRules.MenuAllowed(false, false, true, true)
    && !LifeActivityRules.MenuAllowed(false, false, false, true));
Check("old menu and return ownership cannot cross a load or game day", !LifeActivityRules.SameSession("old", 10, "new", 10)
    && !LifeActivityRules.SameSession("same", 10, "same", 11));
Check("map-level history never invents a lake coordinate", RomanceRules.Place("Mountain") == "山间");
Check("native actual weather names have known labels", new[] { "sunny", "rain", "storm", "snow", "windy" }
    .All(weather => RomanceRules.Weather(weather) != "当时的天气"));
Console.WriteLine($"{checks}/{checks} passed; no game process or save was opened.");
