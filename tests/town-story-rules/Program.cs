using System.Text.Json;
using StardewAgentBridge;

int checks = 0;
void Check(string name, bool pass)
{
    if (!pass) throw new InvalidOperationException(name);
    checks++;
    Console.WriteLine("PASS " + name);
}

Check("only the three intended owners are registered", TownStoryRules.Owners.Count == 3
    && TownStoryRules.Owners["gus_parcel"] == "gus" && TownStoryRules.Owners["penny_field_notes"] == "penny"
    && TownStoryRules.Owners["elliott_short_piece"] == "elliott");
Check("current menus require both load and game day", TownStoryRules.Current("load", 5, "load", 5)
    && !TownStoryRules.Current("old", 5, "new", 5) && !TownStoryRules.Current("load", 5, "load", 6)
    && !TownStoryRules.Current("load", 0, "load", 0));
Check("the parcel site includes its center and exact radius", TownStoryRules.NearSite("Town", 50, 68, "Town", 50, 68, 5)
    && TownStoryRules.NearSite("Town", 53, 72, "Town", 50, 68, 5));
Check("a corner outside the circle is not a discovered parcel", !TownStoryRules.NearSite("Town", 55, 73, "Town", 50, 68, 5));
Check("matching coordinates in another map do not count", !TownStoryRules.NearSite("Farm", 50, 68, "Town", 50, 68, 5));
Check("invalid negative site ranges cannot count", !TownStoryRules.NearSite("Town", 50, 68, "Town", 50, 68, -1));
Check("physical matching requires the new item and this branch start source", TownStoryRules.ParcelMatches(TownStoryRules.ParcelItemId, "gus_parcel@life-42", "life-42"));
Check("an ordinary Mystery Box cannot impersonate the parcel", !TownStoryRules.ParcelMatches("(O)MysteryBox", "gus_parcel@life-42", "life-42"));
Check("an unmarked or other-branch package cannot be returned", !TownStoryRules.ParcelMatches(TownStoryRules.ParcelItemId, null, "life-42")
    && !TownStoryRules.ParcelMatches(TownStoryRules.ParcelItemId, "gus_parcel@life-41", "life-42"));
Check("another story's marker does not prove this parcel", !TownStoryRules.ParcelMatches(TownStoryRules.ParcelItemId, "penny_field_notes@life-42", "life-42"));
Check("the full explanation needs both witnesses and the physical parcel", TownStoryRules.CanExplain(new[] { "emily_mark", "pierre_mark", "parcel" })
    && !TownStoryRules.CanExplain(new[] { "emily_mark", "pierre_mark" }) && !TownStoryRules.CanExplain(new[] { "parcel", "emily_mark" }));
Check("the start day cannot count as a project workday", !TownStoryRules.WorkDay(10, 10, 0, 0));
Check("stage one opens on the following game day", TownStoryRules.WorkDay(11, 10, 0, 0));
Check("stage two cannot finish on the first workday", !TownStoryRules.WorkDay(11, 10, 1, 11)
    && TownStoryRules.WorkDay(12, 10, 1, 11));
Check("completed projects cannot keep producing work events", !TownStoryRules.WorkDay(13, 10, 2, 12));
Check("invalid work histories are refused", !TownStoryRules.WorkDay(12, 10, 1, 10) && !TownStoryRules.WorkDay(1, 0, 0, 0));
Check("normal complete clock steps credit ten minutes", TownStoryRules.ClockStep(1000, 1010, true, 11, 11, "Town", "Town") == 10
    && TownStoryRules.ClockStep(1050, 1100, true, 11, 11, "Town", "Town") == 10);
Check("pausing and partial intervals credit no time", TownStoryRules.ClockStep(1000, 1000, true, 11, 11, "Town", "Town") == 0
    && TownStoryRules.ClockStep(1000, 1010, false, 11, 11, "Town", "Town") == 0);
Check("clock jumps are not simulated work", TownStoryRules.ClockStep(1000, 1030, true, 11, 11, "Town", "Town") == 0);
Check("cross-map intervals cannot become observations or work", TownStoryRules.ClockStep(1000, 1010, true, 11, 11, "Town", "Beach") == 0);
Check("saved clocks never bridge a new day", TownStoryRules.ClockStep(1000, 1010, true, 11, 12, "Town", "Town") == 0);
Check("work requires thirty qualified minutes", !TownStoryRules.WorkReady(20, true, true) && TownStoryRules.WorkReady(30, true, true)
    && !TownStoryRules.WorkReady(30, false, true) && !TownStoryRules.WorkReady(30, true, false));
Check("same-day same-map partial work can accumulate", TownStoryRules.WorkAccumulation(20, 11, "Town", 11, "Town", 10) == 30);
Check("yesterday's partial work is not labelled today's thirty minutes", TownStoryRules.WorkAccumulation(20, 11, "Town", 12, "Town", 10) == 10);
Check("changing work maps does not combine two different workplaces", TownStoryRules.WorkAccumulation(20, 11, "Town", 11, "Trailer", 10) == 10);
int retainedAfterLeaving = TownStoryRules.WorkAccumulation(10, 11, "Town", 11, "Trailer", 0);
Check("leaving a workplace clears partial work before any clock step", retainedAfterLeaving == 0);
Check("returning after a zero-credit excursion cannot reclaim old work", TownStoryRules.WorkAccumulation(retainedAfterLeaving, 11, null, 11, "Town", 10) == 10);
int retainedWhilePaused = TownStoryRules.WorkAccumulation(10, 11, "Town", 11, "Town", 0);
Check("a same-map pause preserves work without crediting paused time", retainedWhilePaused == 10
    && TownStoryRules.WorkAccumulation(retainedWhilePaused, 11, "Town", 11, "Town", 10) == 20);
Check("a new day clears saved partial work before its first clock step", TownStoryRules.WorkAccumulation(20, 11, "Town", 12, "Town", 0) == 0);
Check("a fresh partial work state starts from the observed block", TownStoryRules.WorkAccumulation(0, 0, null, 11, "Town", 10) == 10);
Check("work minutes are bounded at one stage", TownStoryRules.WorkAccumulation(30, 11, "Town", 11, "Town", 10) == 30);
Check("observations require ten minutes at an offered map", TownStoryRules.ObservationReady(10, "Forest", new[] { "Forest", "Town" })
    && !TownStoryRules.ObservationReady(9, "Forest", new[] { "Forest", "Town" })
    && !TownStoryRules.ObservationReady(30, "Beach", new[] { "Forest", "Town" }));
Check("only a source from this story can be reported", TownStoryRules.CanTell("a", "a", "story.clue", "life-2", Array.Empty<string>())
    && !TownStoryRules.CanTell("a", "b", "story.clue", "life-2", Array.Empty<string>()));
Check("reports cannot become reports of reports or future outcomes", !TownStoryRules.CanTell("a", "a", "story.told", "life-2", Array.Empty<string>())
    && !TownStoryRules.CanTell("a", "a", "story.resolved", "life-2", Array.Empty<string>()));
Check("one source can be explicitly reported only once", !TownStoryRules.CanTell("a", "a", "story.observed", "life-2", new[] { "life-2" }));
Check("a choice implicitly submits its observed source", TownStoryRules.ReportedSources(new[]
    { new LifeEvent { Kind = "story.choice", SourceId = "life-2" } }).SetEquals(new[] { "life-2" }));
Check("reading a clue or observing a field does not tell its owner", TownStoryRules.ReportedSources(new[]
    { new LifeEvent { Id = "life-2", Kind = "story.clue", ClueId = "emily_mark" }, new LifeEvent { Id = "life-3", Kind = "story.observed" } }).Count == 0);
Dictionary<string, string> clues = new() { ["emily_mark"] = "life-2", ["pierre_mark"] = "life-3", ["parcel"] = "life-4" };
Check("direct return discloses the parcel without private witness details", TownStoryRules.ResolutionSources("returned", clues).SequenceEqual(new[] { "life-4" }));
Check("explained return discloses all three pieces of evidence", TownStoryRules.ResolutionSources("explained", clues).ToHashSet().SetEquals(clues.Values));
Check("project output does not disclose unrelated investigation clues", !TownStoryRules.ResolutionSources("bright", clues).Any());
List<LifeEvent> heard = clues.Select(c => new LifeEvent { Id = c.Value, Kind = "story.clue", ClueId = c.Key }).ToList();
heard.Add(new() { Kind = "story.resolved", Outcome = "returned" });
Check("reconstructed return knowledge matches the native saved report set", TownStoryRules.ReportedSources(heard).SetEquals(new[] { "life-4" }));
Check("nonparticipants produce the independent outcome", TownStoryRules.ProjectOutcome(null) == "independent"
    && TownStoryRules.ProjectOutcome("observe") == "observe" && TownStoryRules.ProjectOutcome("bright") == "bright");
Check("directions help locate the real site without exposing coordinates", TownStoryRules.Direction(40, 60, 50, 68) == "东南"
    && TownStoryRules.Direction(60, 78, 50, 68) == "西北" && TownStoryRules.Direction(50, 60, 50, 68) == "南");
LifeEvent started = new() { Id = "life-1", Npc = "gus", Day = 10, Kind = "story.started", StoryId = "gus_parcel" };
JsonElement startWire = LifeEventWire.Encode(new[] { started })[0];
Check("start wire has exactly the shared base and story ID", startWire.EnumerateObject().Count() == 5
    && startWire.GetProperty("storyId").GetString() == "gus_parcel" && !startWire.TryGetProperty("StoryId", out _));
JsonElement clueWire = LifeEventWire.Encode(new[] { new LifeEvent
    { Id = "life-2", Npc = "gus", Day = 10, Kind = "story.clue", StoryId = "gus_parcel", ClueId = "emily_mark", Other = "emily" } })[0];
Check("witness wire preserves its source and omits absent fields", clueWire.EnumerateObject().Count() == 7
    && clueWire.GetProperty("other").GetString() == "emily" && !clueWire.TryGetProperty("venue", out _));
JsonElement workWire = LifeEventWire.Encode(new[] { new LifeEvent
    { Id = "life-3", Npc = "penny", Day = 11, Kind = "story.worked", StoryId = "penny_field_notes", Step = 1, Venue = "Town", Minutes = 30 } })[0];
Check("observed work wire carries only its actual step place and minutes", workWire.EnumerateObject().Count() == 8
    && workWire.GetProperty("step").GetInt32() == 1 && !workWire.TryGetProperty("friendship", out _));
JsonElement choiceWire = LifeEventWire.Encode(new[] { new LifeEvent
    { Id = "life-4", Npc = "penny", Day = 11, Kind = "story.choice", StoryId = "penny_field_notes", ChoiceId = "observe", SourceId = "life-2" } })[0];
Check("contributions name a fixed choice and a real source", choiceWire.EnumerateObject().Count() == 7
    && choiceWire.GetProperty("choiceId").GetString() == "observe" && choiceWire.GetProperty("sourceId").GetString() == "life-2");
LifeEvent old = new() { Id = "life-5", Npc = "leah", Day = 11, Kind = "activity.completed", Activity = "forest_walk", Minutes = 30, Friendship = 0 };
JsonElement oldWire = LifeEventWire.Encode(new[] { old })[0];
Check("new fields never contaminate the older life wire", oldWire.EnumerateObject().Count() == 7 && !oldWire.TryGetProperty("storyId", out _));
Check("old backends admit journals without any story history", TownStoryRules.Compatible(false, new[] { old }) && TownStoryRules.Compatible(false, Array.Empty<LifeEvent>()));
Check("story history requires the explicit capability before mixed replay", !TownStoryRules.Compatible(false, new[] { old, started })
    && TownStoryRules.Compatible(true, new[] { old, started }));
Console.WriteLine($"{checks}/{checks} passed; no game process or save was opened.");
