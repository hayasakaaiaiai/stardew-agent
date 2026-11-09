using System.Text.Json;
using StardewAgentBridge;

int passed = 0;
void Check(string name, bool condition)
{
    if (!condition) throw new Exception("FAIL: " + name);
    passed++;
}
T Clone<T>(T value) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(value, LifeEventWire.Json), LifeEventWire.Json)!;
TownCaseFile file = JsonSerializer.Deserialize<TownCaseFile>(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "cases.json")),
    new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
Check("the exact four shared production cases are accepted", file.Version == 1 && file.Cases.Count == 4
    && file.Cases.All(TownCaseRules.Definition) && file.Cases.Select(c => c.Id).ToHashSet().SetEquals(TownCaseRules.Owners.Keys));
TownCaseDefinition route = file.Cases.Single(c => c.Id == "caroline_route_notes");
TownCaseDefinition sample = file.Cases.Single(c => c.Id == "clint_sample_labels");
TownCaseDefinition weather = file.Cases.Single(c => c.Id == "evelyn_blank_record");
TownCaseDefinition presence = file.Cases.Single(c => c.Id == "marnie_two_contexts");

List<LifeEvent> Flow(TownCaseDefinition definition, string ending = "a", bool reports = false)
{
    List<LifeEvent> events = new(); int day = 10;
    LifeEvent Add(LifeEvent entry)
    { entry.Id = "life-" + (events.Count + 1); entry.Npc = definition.Owner; entry.StoryId = definition.Id; entry.Day = day; events.Add(entry); return entry; }
    Add(new() { Kind = "story.started" });
    foreach (TownCaseClue clue in definition.Clues) Add(new() { Kind = "story.clue", ClueId = clue.Id, Other = clue.Witness });
    foreach (TownCaseInspection inspection in definition.Inspections)
    {
        if (inspection.LaterDay == true) day++;
        LifeEvent entry = new() { Kind = "story.inspected", ClueId = inspection.Id, Venue = inspection.Venue,
            X = inspection.Site?.X ?? 10, Y = inspection.Site?.Y ?? 10, Time = inspection.From is int from ? from + 10 : 1200, Minutes = 10 };
        if (inspection.Mode == "site")
        { entry.Weather = "sunny"; if (inspection.After is not null) entry.SourceId = events.Single(e => e.ClueId == inspection.After).Id; }
        if (inspection.Mode == "sample") { entry.ItemId = inspection.ItemId; entry.Count = 1; }
        if (inspection.Mode == "presence") { entry.Subject = "marnie"; entry.SubjectX = 10; entry.SubjectY = 18; }
        Add(entry);
    }
    if (reports) foreach (LifeEvent source in events.Where(e => e.Kind is "story.clue" or "story.inspected").ToArray()) Add(new() { Kind = "story.told", SourceId = source.Id });
    Add(new() { Kind = "story.resolved", Outcome = ending });
    return events;
}
void Reject(TownCaseDefinition definition, string name, Action<List<LifeEvent>> mutate)
{
    List<LifeEvent> events = Flow(definition); mutate(events);
    Check(name, TownCaseRules.Replay(definition, events, 30) is null);
}

foreach (TownCaseDefinition definition in file.Cases)
{
    foreach (string outcome in new[] { "a", "b" })
    {
        foreach (bool reports in new[] { false, true })
        {
            List<LifeEvent> events = Flow(definition, outcome, reports);
            TownCaseState? state = TownCaseRules.Replay(definition, events, 30);
            TownCaseEnding ending = definition.Endings.Single(e => e.Id == outcome);
            Check($"{definition.Id}/{outcome}/{reports} reconstructs its exact readable ending", state is not null && state.ResultTitle == ending.Title
                && state.ResultText == ending.Text && state.Outcome == outcome && state.Sources.Count == 4 && state.Reported.SetEquals(state.Sources.Values));
            Check($"{definition.Id}/{outcome}/{reports} survives native JSON save reload", state is not null && TownCaseRules.ValidState(Clone(state), state));
        }
    }
    List<LifeEvent> complete = Flow(definition);
    TownCaseState before = TownCaseRules.Replay(definition, complete.Take(5), 30)!;
    Check(definition.Id + " collecting and reading sources does not tell the owner", before.Reported.Count == 0 && before.Outcome is null && TownCaseRules.Ready(definition, before));
    TownCaseState after = TownCaseRules.Replay(definition, complete, 30)!;
    TownCaseState forged = Clone(after); forged.ResultText += " invented reward";
    Check(definition.Id + " rejects an unsupported result cache", !TownCaseRules.ValidState(forged, after));
    forged = Clone(before); forged.Reported.Add(before.Sources.Values.First());
    Check(definition.Id + " rejects invented owner knowledge", !TownCaseRules.ValidState(forged, before));
    forged = Clone(after); forged.Sources[definition.Inspections[0].Id] = "life-999";
    Check(definition.Id + " rejects substituted source IDs", !TownCaseRules.ValidState(forged, after));
    Reject(definition, definition.Id + " cannot end before four sources", list => list.RemoveAt(3));
    Reject(definition, definition.Id + " cannot borrow another owner", list => list[1].Npc = "gus");
    Reject(definition, definition.Id + " cannot replace the actual witness", list => list[1].Other = "gus");
    Reject(definition, definition.Id + " cannot use a fixed parcel as a witness", list => list[1].ClueId = "parcel");
    Reject(definition, definition.Id + " cannot duplicate one witness", list => { list[2].ClueId = list[1].ClueId; list[2].Other = list[1].Other; });
    Reject(definition, definition.Id + " cannot add a source after closure", list => { var extra = Clone(list[1]); extra.Id = "life-7"; extra.Day = list[^1].Day; list.Add(extra); });
    Reject(definition, definition.Id + " cannot restart a completed case", list => { var extra = Clone(list[0]); extra.Id = "life-7"; extra.Day = list[^1].Day; list.Add(extra); });
    Reject(definition, definition.Id + " cannot invent a third resolution", list => list[^1].Outcome = "explained");
    Reject(definition, definition.Id + " cannot backdate newer records", list => list[^1].Day = 9);
    Reject(definition, definition.Id + " cannot use future game days", list => list[^1].Day = 31);
    Reject(definition, definition.Id + " cannot repeat an event serial", list => list[1].Id = list[0].Id);
    Reject(definition, definition.Id + " cannot move serials backwards", list => list[1].Id = "life-99");
    Reject(definition, definition.Id + " cannot add unrelated fields to a start", list => list[0].Subject = "marnie");
    Reject(definition, definition.Id + " cannot add unrelated fields to an ending", list => list[^1].Friendship = 20);
    Reject(definition, definition.Id + " cannot place inspected evidence in a witness event", list => { list[3].Kind = "story.clue"; list[3].Other = definition.Owner; });
    Reject(definition, definition.Id + " cannot forge an unconfigured site", list => list[3].Venue = "Farm");
    Reject(definition, definition.Id + " rejects partial ten-minute evidence", list => list[3].Minutes = 9);
    Reject(definition, definition.Id + " rejects inflated observation time", list => list[3].Minutes = 20);
    Reject(definition, definition.Id + " rejects missing coordinates", list => list[3].X = null);
    Reject(definition, definition.Id + " rejects negative coordinates", list => list[3].X = -1);
    Reject(definition, definition.Id + " rejects out of range coordinates", list => list[3].Y = 501);
    Reject(definition, definition.Id + " rejects partial time ticks", list => list[3].Time = 1201);
    Reject(definition, definition.Id + " rejects invalid clock minutes", list => list[3].Time = 1260);
    Reject(definition, definition.Id + " rejects observations after closing time", list => list[3].Time = 2210);
    foreach (string source in new[] { "life-999", "life-1", "life-6" })
        Reject(definition, definition.Id + " rejects unsupported report " + source, list => list[^1] = new() { Id = "life-6", Npc = definition.Owner,
            StoryId = definition.Id, Day = list[^1].Day, Kind = "story.told", SourceId = source });
    List<LifeEvent> duplicate = Flow(definition, reports: true);
    duplicate[6].SourceId = duplicate[5].SourceId;
    Check(definition.Id + " cannot report the same source twice", TownCaseRules.Replay(definition, duplicate, 30) is null);
    TownCaseDefinition changed = Clone(definition); changed.Owner = "gus";
    Check(definition.Id + " configuration rejects an unexpected owner", !TownCaseRules.Definition(changed));
    changed = Clone(definition); changed.Clues[0].Text += "#bad";
    Check(definition.Id + " configuration rejects vanilla command characters", !TownCaseRules.Definition(changed));
    changed = Clone(definition); changed.Inspections[0].Minutes = 20;
    Check(definition.Id + " configuration rejects drifted observation requirements", !TownCaseRules.Definition(changed));
}

TownCaseInspection square = route.Inspections[0];
Check("site circle includes its exact radius", TownCaseRules.AtSite(square, "Town", 53, 72));
Check("square corners outside the circle are not inside", !TownCaseRules.AtSite(square, "Town", 55, 73));
Check("coordinates in another map do not count", !TownCaseRules.AtSite(square, "Forest", 50, 68));
Reject(route, "route observations cannot fabricate weather", list => list[3].Weather = "fog");
Reject(route, "route observations must include weather", list => list[3].Weather = null);
Reject(route, "route observations do not accept sample fields", list => list[3].ItemId = "(O)378");
Reject(route, "route observations cannot reference unrelated sources", list => list[3].SourceId = "life-2");
Reject(route, "route observations cannot escape their actual radius", list => list[3].X = 60);
Reject(route, "separate route sites cannot share a false venue", list => list[4].Venue = "Town");

TownCaseInspection copper = sample.Inspections[0];
Check("copper ore uses exact qualified identity in the current backpack", TownCaseRules.Sample(copper, new[] { ("(O)378", 1) }));
Check("sample matching never accepts a copper bar", !TownCaseRules.Sample(copper, new[] { ("(O)334", 99) }));
Check("sample matching never accepts an unqualified ID", !TownCaseRules.Sample(copper, new[] { ("378", 1) }));
Check("removed or zero-sized samples fail final confirmation", !TownCaseRules.Sample(copper, Array.Empty<(string, int)>()) && !TownCaseRules.Sample(copper, new[] { ("(O)378", 0) }));
var inventory = new[] { ("(O)378", 37), ("(O)380", 4) };
Check("checking one sample leaves the entire inventory untouched", TownCaseRules.Sample(copper, inventory) && inventory[0].Item2 == 37 && inventory[1].Item2 == 4);
Reject(sample, "sample evidence cannot claim a bar", list => list[3].ItemId = "(O)334");
Reject(sample, "sample evidence records one explicitly checked item", list => list[3].Count = 37);
Reject(sample, "sample evidence cannot omit its item", list => list[3].ItemId = null);
Reject(sample, "interior sample evidence does not accept global weather", list => list[3].Weather = "sunny");
Reject(sample, "sample evidence cannot pretend to have another subject", list => list[3].Subject = "clint");

List<LifeEvent> days = Flow(weather);
Check("a later visit with the same weather is valid", TownCaseRules.Replay(weather, days, 30) is not null && days[3].Weather == days[4].Weather);
days[4].Weather = "rain";
Check("a later visit with different weather is also valid", TownCaseRules.Replay(weather, days, 30) is not null);
Reject(weather, "same-day revisit is not a cross-day source", list => list[4].Day = list[3].Day);
Reject(weather, "revisit must name its exact first inspection", list => list[4].SourceId = "life-2");
Reject(weather, "revisit cannot omit its first source", list => list[4].SourceId = null);
Reject(weather, "revisit cannot refer to itself", list => list[4].SourceId = list[4].Id);
TownCaseState initial = TownCaseRules.Replay(weather, Flow(weather).Take(4), 30)!;
Check("next-day requirement prevents accumulating the revisit on the first day", !TownCaseRules.Dependency(weather.Inspections[1], initial, Flow(weather), 10)
    && TownCaseRules.Dependency(weather.Inspections[1], initial, Flow(weather), 11));

TownCaseInspection ranch = presence.Inspections[0];
Check("actual presence permits exactly eight tiles", TownCaseRules.Present(ranch, 900, 10, 10, "marnie", "AnimalShop", 10, 18, true, true));
Check("subject nine tiles away is not present", !TownCaseRules.Present(ranch, 1000, 10, 10, "marnie", "AnimalShop", 10, 19, true, true));
Check("another NPC cannot satisfy the subject condition", !TownCaseRules.Present(ranch, 1000, 10, 10, "shane", "AnimalShop", 10, 10, true, true));
Check("another map cannot satisfy the subject condition", !TownCaseRules.Present(ranch, 1000, 10, 10, "marnie", "Saloon", 10, 10, true, true));
Check("sleeping or invisible subjects cannot be used", !TownCaseRules.Present(ranch, 1000, 10, 10, "marnie", "AnimalShop", 10, 10, false, true)
    && !TownCaseRules.Present(ranch, 1000, 10, 10, "marnie", "AnimalShop", 10, 10, true, false));
Check("presence outside the real clock window fails", !TownCaseRules.Present(ranch, 850, 10, 10, "marnie", "AnimalShop", 10, 10, true, true)
    && !TownCaseRules.Present(ranch, 1610, 10, 10, "marnie", "AnimalShop", 10, 10, true, true));
Reject(presence, "presence records cannot be completed at the opening instant", list => list[3].Time = 900);
Reject(presence, "night presence cannot be completed at its opening instant", list => list[4].Time = 1700);
Reject(presence, "presence records cannot invent the witness field", list => list[3].Other = "marnie");
Reject(presence, "presence records cannot omit subject coordinates", list => list[3].SubjectX = null);
Reject(presence, "presence records cannot place the subject beyond eight tiles", list => list[3].SubjectY = 19);
Reject(presence, "presence records require the actual subject identity", list => list[3].Subject = "shane");
Reject(presence, "interior presence records do not accept weather", list => list[3].Weather = "rain");
List<LifeEvent> lastMinute = Flow(presence); lastMinute[3].Time = 1600; lastMinute[4].Time = 2200;
Check("the inclusive last full ten-minute window remains valid", TownCaseRules.Replay(presence, lastMinute, 30) is not null);

TownCaseClock clock = new();
TownCaseRules.TickClock(clock, 10, "Town", 1000, true, true);
TownCaseRules.AdvanceClock(clock, 10, "Town", 1010, true, true);
Check("arrival during a running clock interval does not claim its whole duration", clock.Minutes == 0);
TownCaseRules.AdvanceClock(clock, 10, "Town", 1020, true, true);
Check("the first complete uninterrupted interval produces ten minutes", clock.Minutes == 10);
TownCaseRules.TickClock(clock, 10, "Town", 1020, true, false);
Check("opening the record menu preserves an already completed observation", clock.Minutes == 10 && !clock.Whole);
TownCaseRules.AdvanceClock(clock, 10, "Town", 1030, true, false);
Check("paused time cannot add evidence minutes", clock.Minutes == 10 && !clock.Whole);
TownCaseRules.TickClock(clock, 10, "Town", 1030, false, false);
Check("leaving the site clears completed but unrecorded minutes even without a clock step", clock.Minutes == 0);
TownCaseRules.TickClock(clock, 10, "Town", 1030, true, true);
TownCaseRules.AdvanceClock(clock, 10, "Town", 1040, true, true);
Check("returning to the site cannot reclaim the old candidate", clock.Minutes == 0);
TownCaseRules.AdvanceClock(clock, 10, "Town", 1050, true, true);
TownCaseRules.TickClock(clock, 10, "Forest", 1050, true, true);
Check("map changes clear unrecorded evidence immediately", clock.Minutes == 0 && !clock.Whole);
TownCaseRules.AdvanceClock(clock, 10, "Forest", 1100, true, true);
TownCaseRules.AdvanceClock(clock, 10, "Forest", 1110, true, true);
TownCaseRules.TickClock(clock, 11, "Forest", 600, true, true);
Check("overnight time never carries an unfinished candidate", clock.Minutes == 0 && !clock.Whole && clock.Day == 11);
clock = new() { Day = 11, Map = "Town", LastTime = 1000, Whole = true };
TownCaseRules.AdvanceClock(clock, 11, "Town", 1030, true, true);
Check("a thirty-minute clock jump cannot fabricate a valid ten-minute step", clock.Minutes == 0);
TownCaseRules.TickClock(clock, 11, "Town", 1030, true, false);
TownCaseRules.TickClock(clock, 11, "Town", 1030, true, true);
TownCaseRules.AdvanceClock(clock, 11, "Town", 1040, true, true);
Check("a pause invalidates the partial interval even after closing the menu", clock.Minutes == 0);
TownCaseRules.AdvanceClock(clock, 11, "Town", 1050, true, true);
TownCaseRules.TickClock(clock, 11, "Town", 1050, false, true);
Check("a subject leaving range clears its unrecorded candidate", clock.Minutes == 0);
Check("a loaded game starts with an empty transient clock", new TownCaseClock().Minutes == 0 && !new TownCaseClock().Whole);

LifeEvent oldStory = new() { Id = "life-1", Npc = "gus", Day = 10, Kind = "story.started", StoryId = "gus_parcel" };
LifeEvent newStory = Flow(route)[0];
Check("old story history does not require the new capability", TownCaseRules.Compatible(false, new[] { oldStory }));
Check("mixed history is blocked without casesProtocol", !TownCaseRules.Compatible(false, new[] { oldStory, newStory }) && TownCaseRules.Compatible(true, new[] { newStory }));
Check("old story events never upgrade the life version", TownCaseRules.VersionAfterEvent(1, oldStory) == 1 && TownCaseRules.VersionAfterEvent(3, oldStory) == 3);
Check("the first successful case event requires v4", TownCaseRules.VersionAfterEvent(1, newStory) == 4 && TownCaseRules.VersionAfterEvent(3, newStory) == 4);
Check("legacy saves remain acceptable before their first case", Enumerable.Range(1, 4).All(v => TownCaseRules.SaveVersion(v, new[] { oldStory })));
Check("case history cannot hide in a pre-v4 save", !TownCaseRules.SaveVersion(3, new[] { newStory }) && TownCaseRules.SaveVersion(4, new[] { newStory }));
Check("future versions are rejected intact", !TownCaseRules.SaveVersion(5, Array.Empty<LifeEvent>()));
Check("older result and long-goal events cannot downgrade a v4 save", GoalResultRules.VersionAfterEvent(4, "goalresult.started") == 4
    && LongGoalRules.VersionAfterEvent(4, "longgoal.started") == 4 && GoalResultRules.SaveVersion(4, Array.Empty<LifeEvent>()) && LongGoalRules.SaveVersion(4, Array.Empty<LifeEvent>()));
Check("unknown IDs do not get the new case exemption", !TownCaseRules.IsCaseId("unknown_case") && !TownCaseRules.IsCaseId("gus_parcel"));
Check("legacy story wire remains unchanged", LifeEventWire.Encode(new[] { oldStory })[0].EnumerateObject().Count() == 5);
LifeEvent nativePresence = Flow(presence)[3];
JsonElement wire = LifeEventWire.Encode(new[] { nativePresence })[0];
Check("presence has exact subject fields and no witness or weather", wire.GetProperty("subject").GetString() == "marnie"
    && wire.TryGetProperty("subjectX", out _) && wire.TryGetProperty("subjectY", out _) && !wire.TryGetProperty("other", out _) && !wire.TryGetProperty("weather", out _));
Check("wire serialization retains every evidence field", TownCaseRules.Shape(presence, Clone(nativePresence)));
Console.WriteLine($"town-case-rules: {passed}/{passed} passed");
