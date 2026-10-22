using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json;

if (args.Length != 2)
    throw new ArgumentException("Usage: ModFlowChecks <built mod DLL> <game directory>");

string modPath = Path.GetFullPath(args[0]);
string gamePath = Path.GetFullPath(args[1]);
AssemblyLoadContext.Default.Resolving += (_, name) =>
{
    foreach (string directory in new[] { Path.GetDirectoryName(modPath)!, gamePath, Path.Combine(gamePath, "smapi-internal") })
    {
        string file = Path.Combine(directory, name.Name + ".dll");
        if (File.Exists(file))
            return AssemblyLoadContext.Default.LoadFromAssemblyPath(file);
    }
    return null;
};

Assembly modAssembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(modPath);
Assembly gameAssembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(gamePath, "Stardew Valley.dll"));
Type modType = modAssembly.GetType("StardewAgentBridge.ModEntry", throwOnError: true)!;
Type talkType = modType.GetNestedType("Talk", BindingFlags.NonPublic)!;
Type dialogueType = gameAssembly.GetType("StardewValley.Dialogue", throwOnError: true)!;
Type inputType = gameAssembly.GetType("StardewValley.Menus.TitleTextInputMenu", throwOnError: true)!;
Type changedType = modType.BaseType!.Assembly.GetType("StardewModdingAPI.Events.MenuChangedEventArgs", throwOnError: true)!;
const BindingFlags Fields = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
int failures = 0;
int checks = 0;

void Check(bool condition, string message)
{
    if (!condition)
        throw new InvalidOperationException(message);
}

object? Get(object target, string name) => target.GetType().GetField(name, Fields)!.GetValue(target);
void Set(object target, string name, object? value) => target.GetType().GetField(name, Fields)!.SetValue(target, value);
object Changed(object input) => Activator.CreateInstance(changedType, Fields, binder: null, args: new object?[] { input, null }, culture: null)!;
void Call(object target, string method, params object?[] values)
{
    try
    {
        target.GetType().GetMethod(method, Fields)!.Invoke(target, values);
    }
    catch (TargetInvocationException error) when (error.InnerException is not null)
    {
        throw new InvalidOperationException($"{method} ran game work before the menu transition was observed: {error.InnerException.GetType().Name}");
    }
}

Exception? TryPending(object mod, object talk)
{
    try
    {
        Call(mod, "RunPending", talk);
        return null;
    }
    catch (Exception error)
    {
        return error;
    }
}

(object Mod, object Talk) Flow()
{
    // These checks exercise the compiled mod's event/state handlers without starting a game or touching saves.
    object mod = RuntimeHelpers.GetUninitializedObject(modType);
    object talk = RuntimeHelpers.GetUninitializedObject(talkType);
    Set(mod, "talk", talk);
    return (mod, talk);
}

void Test(string name, Action body)
{
    checks++;
    try
    {
        body();
        Console.WriteLine("PASS " + name);
    }
    catch (Exception error)
    {
        failures++;
        Console.WriteLine("FAIL " + name + ": " + error.GetBaseException());
    }
}

Test("an option stays queued until MenuChanged observes the old dialogue closing", () =>
{
    var (mod, talk) = Flow();
    object dialogue = RuntimeHelpers.GetUninitializedObject(dialogueType);
    Set(talk, "Shown", dialogue);
    Set(talk, "SayNext", "继续聊聊");
    // Vanilla closes the menu during its update; SMAPI raises MenuChanged at the start of the next tick.
    Exception? premature = TryPending(mod, talk);
    Check((string?)Get(talk, "SayNext") == "继续聊聊", "The option was consumed one tick too early.");
    Check(!(bool)Get(talk, "Waiting")!, "The next request started before the old menu was acknowledged.");
    Check(premature is null, "Running a queued option entered game logic before the close event.");
    Call(mod, "OwnDialogueClosed", dialogue);
    Check(Get(talk, "Shown") is null, "The closed dialogue was not acknowledged.");
    Check(!(bool)Get(talk, "LeaveNext")!, "A chosen option was mistaken for leaving.");
    Check((string?)Get(talk, "SayNext") == "继续聊聊", "The acknowledged option was lost.");
});

Test("submitted text stays queued until its input-menu close is observed", () =>
{
    var (mod, talk) = Flow();
    object input = RuntimeHelpers.GetUninitializedObject(inputType);
    Set(talk, "Input", input);
    Set(talk, "SayNext", "你好");
    Exception? premature = TryPending(mod, talk);
    Check((string?)Get(talk, "SayNext") == "你好", "Submitted text was consumed before MenuChanged.");
    Check(premature is null, "Submitting text entered game logic before the input close event.");
    object changed = Changed(input);
    Call(mod, "OnMenuChanged", null, changed);
    Check(Get(talk, "Input") is null, "The input close was not acknowledged.");
    Check(!(bool)Get(talk, "ReshowNext")!, "Submitted text was mistaken for cancelling input.");
});

Test("waiting for a model reply cannot run a pending close action", () =>
{
    var (mod, talk) = Flow();
    Set(talk, "Waiting", true);
    Set(talk, "LeaveNext", true);
    Exception? premature = TryPending(mod, talk);
    Check(ReferenceEquals(Get(mod, "talk"), talk), "An in-flight conversation was discarded.");
    Check(premature is null, "Waiting for a reply unexpectedly ran a pending action.");
});

Test("cancelling text input still queues the previous reply", () =>
{
    var (mod, talk) = Flow();
    object input = RuntimeHelpers.GetUninitializedObject(inputType);
    Set(talk, "Input", input);
    object changed = Changed(input);
    Call(mod, "OnMenuChanged", null, changed);
    Check(Get(talk, "Input") is null, "The cancelled input was not cleared.");
    Check((bool)Get(talk, "ReshowNext")!, "Cancelling input no longer returns to the previous reply.");
});

Test("closing a reply without choosing still queues leaving", () =>
{
    var (mod, talk) = Flow();
    object dialogue = RuntimeHelpers.GetUninitializedObject(dialogueType);
    Set(talk, "Shown", dialogue);
    Call(mod, "OwnDialogueClosed", dialogue);
    Check((bool)Get(talk, "LeaveNext")!, "A plain close no longer ends the conversation.");
});

Type outboxType = modAssembly.GetType("StardewAgentBridge.ReliableOutbox", throwOnError: true)!;
object NewOutbox() => Activator.CreateInstance(outboxType, nonPublic: true)!;
object? Invoke(object target, string method, params object?[] values) => target.GetType().GetMethod(method, Fields)!.Invoke(target, values);
int Count(object outbox) => (int)outboxType.GetProperty("Count")!.GetValue(outbox)!;
JsonElement[] Pending(object outbox) => (JsonElement[])Invoke(outbox, "Messages")!;

Test("lifecycle replay keeps the original snapshot and increasing event order", () =>
{
    object outbox = NewOutbox();
    Dictionary<string, object?> fields = new() { ["type"] = "save.saving", ["seq"] = 7, ["dayEnded"] = 1 };
    Check((bool)Invoke(outbox, "Add", 7, fields)!, "The lifecycle event was not cached.");
    fields["dayEnded"] = 2;
    Invoke(outbox, "Add", 9, new Dictionary<string, object?> { ["seq"] = 9 });
    JsonElement[] first = Pending(outbox);
    JsonElement[] replay = Pending(outbox);
    Check(first[0].GetProperty("dayEnded").GetInt32() == 1, "A later game mutation changed the pending event.");
    Check(first.Select(value => value.GetRawText()).SequenceEqual(replay.Select(value => value.GetRawText())), "Replaying changed a message.");
    Check(first[0].GetProperty("seq").GetInt32() == 7 && first[1].GetProperty("seq").GetInt32() == 9, "Replay order changed.");
});

Test("only acknowledged lifecycle events are removed and repeated acknowledgements are harmless", () =>
{
    object outbox = NewOutbox();
    foreach (int seq in new[] { 1, 2, 3 })
        Invoke(outbox, "Add", seq, new Dictionary<string, object?> { ["seq"] = seq });
    Invoke(outbox, "Acknowledge", 2);
    Invoke(outbox, "Acknowledge", 2);
    Invoke(outbox, "Acknowledge", 999);
    Check(Count(outbox) == 2, "An acknowledgement removed an unrelated event.");
    Check(Pending(outbox).Select(value => value.GetProperty("seq").GetInt32()).SequenceEqual(new[] { 1, 3 }), "Wrong events remain.");
});

Test("the lifecycle queue refuses overflow without losing accepted events", () =>
{
    object outbox = NewOutbox();
    for (int seq = 1; seq <= 2000; seq++)
        Check((bool)Invoke(outbox, "Add", seq, new Dictionary<string, object?> { ["seq"] = seq })!, "The queue filled early.");
    Check(!(bool)Invoke(outbox, "Add", 2001, new Dictionary<string, object?> { ["seq"] = 2001 })!, "Overflow was accepted.");
    Check(Count(outbox) == 2000 && Pending(outbox)[0].GetProperty("seq").GetInt32() == 1, "Overflow discarded accepted history.");
});

Test("stale load acknowledgements cannot remove the current load's pending event", () =>
{
    object mod = RuntimeHelpers.GetUninitializedObject(modType);
    object outbox = NewOutbox();
    Set(mod, "initialSave", new Dictionary<string, object?>()); Set(mod, "lineageId", "farm"); Set(mod, "loadNonce", "current");
    Set(mod, "lifecycle", outbox);
    Invoke(outbox, "Add", 4, new Dictionary<string, object?> { ["seq"] = 4 });
    using JsonDocument stale = JsonDocument.Parse("{\"type\":\"ack\",\"lineageId\":\"farm\",\"loadNonce\":\"old\",\"seq\":4}");
    Invoke(mod, "HandleSync", "ack", stale.RootElement);
    Check(Count(outbox) == 1, "An old load acknowledged the new load's event.");
    using JsonDocument current = JsonDocument.Parse("{\"type\":\"ack\",\"lineageId\":\"farm\",\"loadNonce\":\"current\",\"seq\":4}");
    Invoke(mod, "HandleSync", "ack", current.RootElement);
    Check(Count(outbox) == 0, "The correct acknowledgement was ignored.");
});

Test("late replies with the wrong nonce or request sequence never enter game UI logic", () =>
{
    var (mod, talk) = Flow();
    Set(mod, "initialSave", new Dictionary<string, object?>()); Set(mod, "lineageId", "farm"); Set(mod, "loadNonce", "current");
    foreach (string json in new[] { "{\"lineageId\":\"other\",\"loadNonce\":\"current\",\"seq\":12}", "{\"lineageId\":\"farm\",\"loadNonce\":\"old\",\"seq\":12}",
        "{\"lineageId\":\"farm\",\"loadNonce\":\"current\",\"seq\":11}", "{}" })
    {
        using JsonDocument document = JsonDocument.Parse(json);
        Check(!(bool)Invoke(mod, "IsCurrentReply", document.RootElement, 12)!, "A stale reply passed the request guard.");
    }
    using JsonDocument valid = JsonDocument.Parse("{\"lineageId\":\"farm\",\"loadNonce\":\"current\",\"seq\":12}");
    Check((bool)Invoke(mod, "IsCurrentReply", valid.RootElement, 12)!, "The current request's reply was rejected.");
});

string? previousMemoryTest = Environment.GetEnvironmentVariable("STARDEW_AGENT_TEST_MEMORY");
string testDirectory = Path.Combine(Path.GetTempPath(), "stardew-memory-guard-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(testDirectory);
Type configType = modAssembly.GetType("StardewAgentBridge.ModConfig", throwOnError: true)!;
object TestMod()
{
    object mod = RuntimeHelpers.GetUninitializedObject(modType);
    Set(mod, "config", Activator.CreateInstance(configType, nonPublic: true)!);
    return mod;
}
try
{
    Test("normal launches do not activate the memory acceptance scenario or override the backend", () =>
    {
        Environment.SetEnvironmentVariable("STARDEW_AGENT_TEST_MEMORY", null);
        object mod = TestMod();
        Invoke(mod, "ConfigureMemoryTest");
        Check(Get(mod, "memoryTest") is null, "A normal launch activated the test scenario.");
        Check((string?)configType.GetProperty("BackendUrl")!.GetValue(Get(mod, "config")) == "ws://127.0.0.1:47711", "A normal launch changed its backend.");
    });

    Test("memory acceptance rejects the original save, wrong folder, remote backend and malformed request", () =>
    {
        foreach (var invalid in new[]
        {
            (Id: "436774213", Folder: "MemoryTest_436774213", Url: "ws://127.0.0.1:12345", Request: Guid.NewGuid().ToString()),
            (Id: "1234567890", Folder: "测试_436774213", Url: "ws://127.0.0.1:12345", Request: Guid.NewGuid().ToString()),
            (Id: "1234567890", Folder: "MemoryTest_1234567890", Url: "ws://example.com:12345", Request: Guid.NewGuid().ToString()),
            (Id: "1234567890", Folder: "MemoryTest_1234567890", Url: "ws://127.0.0.1:12345", Request: "not-a-request"),
        })
        {
            string path = Path.Combine(testDirectory, "config.json");
            File.WriteAllText(path, JsonSerializer.Serialize(new { RequestId = invalid.Request, UniqueId = invalid.Id,
                SaveFolder = invalid.Folder, BackendUrl = invalid.Url, RunDirectory = testDirectory }));
            Environment.SetEnvironmentVariable("STARDEW_AGENT_TEST_MEMORY", path);
            object mod = TestMod();
            bool rejected = false;
            try { Invoke(mod, "ConfigureMemoryTest"); }
            catch (TargetInvocationException error) when (error.InnerException is InvalidOperationException) { rejected = true; }
            Check(rejected && Get(mod, "memoryTest") is null, "An unsafe acceptance configuration was accepted.");
        }
    });

    Test("an explicit isolated memory scenario uses its own loopback backend without changing saved config", () =>
    {
        string path = Path.Combine(testDirectory, "config.json");
        File.WriteAllText(path, JsonSerializer.Serialize(new { RequestId = Guid.NewGuid().ToString(), UniqueId = "1234567890",
            SaveFolder = "MemoryTest_1234567890", BackendUrl = "ws://127.0.0.1:12345", RunDirectory = testDirectory }));
        Environment.SetEnvironmentVariable("STARDEW_AGENT_TEST_MEMORY", path);
        object mod = TestMod();
        Invoke(mod, "ConfigureMemoryTest");
        Check(Get(mod, "memoryTest") is not null, "The explicit test scenario was not activated.");
        Check((string?)configType.GetProperty("BackendUrl")!.GetValue(Get(mod, "config")) == "ws://127.0.0.1:12345", "The isolated backend was not selected.");
    });
}
finally
{
    Environment.SetEnvironmentVariable("STARDEW_AGENT_TEST_MEMORY", previousMemoryTest);
    // Only the fixture file created above is removed; preserve the directory if unexpected data appeared.
    File.Delete(Path.Combine(testDirectory, "config.json"));
    if (!Directory.EnumerateFileSystemEntries(testDirectory).Any()) Directory.Delete(testDirectory);
}

object BubbleMod()
{
    object mod = TestMod();
    Set(mod, "initialSave", new Dictionary<string, object?>()); Set(mod, "lineageId", "farm"); Set(mod, "loadNonce", "current");
    foreach (string field in new[] { "bubbles", "bubblesShown", "bubbleShownAt" })
        Set(mod, field, Activator.CreateInstance(modType.GetField(field, Fields)!.FieldType)!);
    return mod;
}
JsonDocument BubblePacket(string nonce = "current", string lineage = "farm", object? lines = null) => JsonDocument.Parse(JsonSerializer.Serialize(new
{
    type = "day.bubbles", lineageId = lineage, loadNonce = nonce, seq = 0,
    npcs = new Dictionary<string, object?> { ["abigail"] = lines ?? new[] { new { text = "想做风筝", emote = "happy" } } },
}));
Test("bubble packets reject stale identities and replacements preserve already-shown lines", () =>
{
    object mod = BubbleMod();
    var cache = (System.Collections.IDictionary)Get(mod, "bubbles")!;
    foreach (var identity in new[] { ("old", "farm"), ("current", "other") })
    {
        using JsonDocument stale = BubblePacket(identity.Item1, identity.Item2);
        Check((bool)Invoke(mod, "HandleBubbles", "day.bubbles", stale.RootElement)!, "The packet was not recognized.");
        Check(cache.Count == 0, "A stale packet changed the active cache.");
    }
    using JsonDocument valid = BubblePacket();
    Invoke(mod, "HandleBubbles", "day.bubbles", valid.RootElement);
    Check(cache.Count == 1, "The current packet was not accepted.");
    var shown = (HashSet<string>)Get(mod, "bubblesShown")!;
    var times = (Dictionary<string, int>)Get(mod, "bubbleShownAt")!;
    shown.Add("Abigail\n想做风筝"); times["Abigail"] = 650;
    Invoke(mod, "HandleBubbles", "day.bubbles", valid.RootElement);
    Check(shown.Count == 1 && times["Abigail"] == 650, "Replacing a packet reset its repetition/cooldown guard.");
    Invoke(mod, "ClearBubbles");
    Check(cache.Count == 0 && shown.Count == 0 && times.Count == 0, "A day/load reset left bubble state behind.");
});
Test("disabled bubbles do not enter native game logic", () =>
{
    object mod = BubbleMod();
    configType.GetProperty("ShowBubbles")!.SetValue(Get(mod, "config"), false);
    using JsonDocument valid = BubblePacket();
    Invoke(mod, "HandleBubbles", "day.bubbles", valid.RootElement);
    Invoke(mod, "TickBubbles");
    Check(((HashSet<string>)Get(mod, "bubblesShown")!).Count == 0, "Disabled bubbles were consumed.");
});
Test("malformed bubble rows are ignored without losing valid rows", () =>
{
    object mod = BubbleMod();
    using JsonDocument packet = BubblePacket(lines: new object?[] { null, 1, "bad", new { text = 7 },
        new { text = "想做风筝", emote = 7 }, new { text = "想去矿洞", emote = "question" } });
    Invoke(mod, "HandleBubbles", "day.bubbles", packet.RootElement);
    var cache = (System.Collections.IDictionary)Get(mod, "bubbles")!;
    Check(cache.Count == 1 && ((System.Collections.IList)cache["abigail"]!).Count == 2, "Valid rows were lost with the malformed ones.");
});

Test("letter delivery ignores stale loads and disabled or inactive saves", () =>
{
    object mod = BubbleMod();
    Set(mod, "activeLoad", true);
    foreach (string nonce in new[] { "old", "current" })
    {
        configType.GetProperty("SendLetters")!.SetValue(Get(mod, "config"), nonce == "old");
        using JsonDocument packet = JsonDocument.Parse(JsonSerializer.Serialize(new { lineageId = "farm", loadNonce = nonce, letters = new object[] { null! } }));
        Check((bool)Invoke(mod, "HandleLetters", "day.letters", packet.RootElement)!, "The letter packet was not recognized.");
    }
    Set(mod, "activeLoad", false);
    configType.GetProperty("SendLetters")!.SetValue(Get(mod, "config"), true);
    using JsonDocument inactive = JsonDocument.Parse("{\"lineageId\":\"farm\",\"loadNonce\":\"current\",\"letters\":[null]}");
    Invoke(mod, "HandleLetters", "day.letters", inactive.RootElement);
});
Test("malformed letter rows are ignored before native game work", () =>
{
    object mod = BubbleMod();
    Set(mod, "activeLoad", true);
    using JsonDocument packet = JsonDocument.Parse(JsonSerializer.Serialize(new { lineageId = "farm", loadNonce = "current",
        letters = new object?[] { null, 7, "bad", new { key = 7 }, new { key = "bad", text = 7 }, new { key = "bad", text = "空" } } }));
    Invoke(mod, "HandleLetters", "day.letters", packet.RootElement);
});

Test("scene packets reject stale loads and request numbers and skip malformed rows", () =>
{
    object mod = BubbleMod();
    foreach (string field in new[] { "scenePairs", "sceneLines", "sceneParticipants" })
        Set(mod, field, Activator.CreateInstance(modType.GetField(field, Fields)!.FieldType)!);
    Set(mod, "sceneRequestSeq", 42);
    foreach (var identity in new[] { ("old", 42), ("current", 41), ("current", 42) })
    {
        using JsonDocument packet = JsonDocument.Parse(JsonSerializer.Serialize(new { lineageId = "farm", loadNonce = identity.Item1,
            seq = identity.Item2, lines = new object?[] { null, 7, "bad", new { npc = 7 },
                new { npc = "abigail", text = "今天天气不错。", emote = "happy" }, new { npc = "sebastian", text = "嗯。" } } }));
        Invoke(mod, "HandleScenes", "scene.lines", packet.RootElement);
        int count = (int)Get(mod, "sceneLines")!.GetType().GetProperty("Count")!.GetValue(Get(mod, "sceneLines"))!;
        Check(count == (identity == ("current", 42) ? 2 : 0), "A stale scene entered the queue or valid rows were lost.");
    }
    Invoke(mod, "ClearScenes");
    Check((int)Get(mod, "sceneRequestSeq")! == 0 && (int)Get(mod, "scenesToday")! == 0 && (int)Get(mod, "sceneShowing")! == 0,
        "A new load/day retained pending scenes or their daily budget.");
});
Test("ambient packets reject stale loads and request numbers, skip malformed rows, and reset with the day", () =>
{
    object mod = BubbleMod();
    foreach (string field in new[] { "ambientAskedAt", "ambientGreeted", "ambientLines" })
        Set(mod, field, Activator.CreateInstance(modType.GetField(field, Fields)!.FieldType)!);
    int Queued() => (int)Get(mod, "ambientLines")!.GetType().GetProperty("Count")!.GetValue(Get(mod, "ambientLines"))!;
    Set(mod, "ambientRequestSeq", 42);
    foreach (var identity in new[] { ("old", 42), ("current", 41), ("current", 42) })
    {
        using JsonDocument packet = JsonDocument.Parse(JsonSerializer.Serialize(new { lineageId = "farm", loadNonce = identity.Item1,
            seq = identity.Item2, lines = new object?[] { null, 7, "bad", new { npc = 7 },
                new { npc = "pierre", to = 7, text = "欢迎光临！", emote = "happy" }, new { npc = "abigail", text = "唉。" } } }));
        Check((bool)Invoke(mod, "HandleAmbient", "ambient.lines", packet.RootElement)!, "The ambient packet was not recognized.");
        Check(Queued() == (identity == ("current", 42) ? 2 : 0), "A stale ambient reply entered the queue or valid rows were lost.");
    }
    Set(mod, "ambientToday", 12); Set(mod, "lastAmbientAt", 1000); Set(mod, "ambientRequestSeq", 43);
    ((System.Collections.IDictionary)Get(mod, "ambientAskedAt")!)["Pierre"] = 1000;
    ((HashSet<string>)Get(mod, "ambientGreeted")!).Add("Pierre");
    Invoke(mod, "ClearAmbient");
    Check((int)Get(mod, "ambientRequestSeq")! == 0 && (int)Get(mod, "ambientToday")! == 0 && (int)Get(mod, "lastAmbientAt")! == -1
        && Queued() == 0 && ((System.Collections.IDictionary)Get(mod, "ambientAskedAt")!).Count == 0 && ((HashSet<string>)Get(mod, "ambientGreeted")!).Count == 0,
        "A new load/day retained the ambient budget, greetings or pending lines.");
});
Test("the final overhead line keeps its display slot and clearing the day releases it", () =>
{
    object mod = BubbleMod();
    foreach (string field in new[] { "ambientAskedAt", "ambientGreeted", "ambientLines", "scenePairs", "sceneLines", "sceneParticipants" })
        Set(mod, field, Activator.CreateInstance(modType.GetField(field, Fields)!.FieldType)!);
    bool Busy(string property) => (bool)modType.GetProperty(property, Fields)!.GetValue(mod)!;
    Set(mod, "ambientCurrentTick", (uint)100); Set(mod, "nextAmbientLineTick", (uint)280);
    Check(Busy("AmbientBusy"), "Dequeuing the last ambient line released its slot before the display interval.");
    Set(mod, "ambientCurrentTick", (uint)280);
    Check(!Busy("AmbientBusy"), "The slot stayed busy after the final ambient line finished.");
    Set(mod, "nextAmbientLineTick", (uint)400); Invoke(mod, "ClearAmbient");
    Check(!Busy("AmbientBusy"), "A reload kept the old ambient display interval.");
    Set(mod, "sceneCurrentTick", (uint)100); Set(mod, "nextSceneLineTick", (uint)280);
    Check(Busy("SceneBusy"), "Dequeuing the last scene line released its slot before the display interval.");
    Invoke(mod, "ClearScenes");
    Check(!Busy("SceneBusy"), "A reload kept the old scene display interval.");
});
Test("disabled friendship does not change the per-NPC daily total", () =>
{
    object mod = TestMod();
    Set(mod, "activeLoad", true);
    Set(mod, "friendshipToday", new Dictionary<string, int> { ["Abigail"] = 20 });
    configType.GetProperty("ChatChangesFriendship")!.SetValue(Get(mod, "config"), false);
    object npc = RuntimeHelpers.GetUninitializedObject(gameAssembly.GetType("StardewValley.NPC")!);
    Invoke(mod, "ApplyFriendship", npc, 20);
    Check(((Dictionary<string, int>)Get(mod, "friendshipToday")!)["Abigail"] == 20, "Disabled chat changed its daily budget.");
    Invoke(mod, "ClearFriendshipToday");
    Check(((Dictionary<string, int>)Get(mod, "friendshipToday")!).Count == 0, "Reset retained friendship points.");
});
Test("a festival's results are packed once it ends, wait for the conversation to close, and reset with the day", () =>
{
    Type watchType = modType.GetNestedType("FestivalWatch", BindingFlags.NonPublic)!;
    object festival = RuntimeHelpers.GetUninitializedObject(gameAssembly.GetType("StardewValley.Event")!);
    object watch = Activator.CreateInstance(watchType, Fields, binder: null, args: new object?[] { festival, "winter25" }, culture: null)!;
    ((List<string>)Get(watch, "Npcs")!).AddRange(new[] { "Penny", "Lewis" });
    Set(watch, "SantaRecipient", "Penny");
    Check(!(bool)watchType.GetProperty("HasResult")!.GetValue(watch)!, "A drawn name counted as a gift handed over.");
    Set(watch, "SantaGiven", true); Set(watch, "SantaGiver", "Lewis"); Set(watch, "SantaReceived", true);
    Check((bool)watchType.GetProperty("HasResult")!.GetValue(watch)!, "A handed-over gift was not a result.");
    var fields = (Dictionary<string, object?>)Invoke(watch, "Message")!;
    using (JsonDocument packed = JsonDocument.Parse(JsonSerializer.Serialize(fields)))
    {
        JsonElement root = packed.RootElement;
        Check(root.GetProperty("festival").GetString() == "winter25" && root.GetProperty("npcs").GetArrayLength() == 2
            && root.GetProperty("santa").GetProperty("recipient").GetString() == "Penny" && root.GetProperty("santa").GetProperty("giver").GetString() == "Lewis",
            "The gift exchange was packed wrong.");
        foreach (string empty in new[] { "dance", "contest", "grange", "soup" })
            Check(root.GetProperty(empty).ValueKind == JsonValueKind.Null, $"{empty} was not sent as null.");
    }

    object mod = BubbleMod();
    Set(mod, "lifecycle", NewOutbox());
    Set(mod, "bridge", Activator.CreateInstance(modType.GetField("bridge", Fields)!.FieldType, new Uri("ws://127.0.0.1:9"), null, "test")!);
    Set(mod, "festivalPending", fields);
    Set(mod, "talk", RuntimeHelpers.GetUninitializedObject(talkType));
    Invoke(mod, "FlushFestival");
    Check(Count(Get(mod, "lifecycle")!) == 0 && Get(mod, "festivalPending") is not null, "A festival result was sent during a conversation.");
    Set(mod, "talk", null);
    Invoke(mod, "FlushFestival");
    JsonElement[] queued = Pending(Get(mod, "lifecycle")!);
    Check(queued.Length == 1 && queued[0].GetProperty("type").GetString() == "festival.ended" && Get(mod, "festivalPending") is null,
        "A festival result was not queued as a reliable message.");
    Set(mod, "festivalWatch", watch); Set(mod, "festivalDone", festival); Set(mod, "festivalPending", fields);
    Invoke(mod, "ClearFestival");
    Check(Get(mod, "festivalWatch") is null && Get(mod, "festivalDone") is null && Get(mod, "festivalPending") is null,
        "A new load/day kept an old festival.");
});

FestivalReadChecks.Run(modAssembly, gameAssembly, Test);
ScheduleReadChecks.Run(modAssembly, gameAssembly, Test);
Test("who walks over today comes from the current load only, skips bad values, and resets with the day", () =>
{
    object mod = BubbleMod();
    foreach (string field in new[] { "approachHearts", "approached" })
        Set(mod, field, Activator.CreateInstance(modType.GetField(field, Fields)!.FieldType, StringComparer.OrdinalIgnoreCase)!);
    var hearts = (Dictionary<string, int>)Get(mod, "approachHearts")!;
    foreach (string nonce in new[] { "old", "current" })
    {
        using JsonDocument packet = JsonDocument.Parse(JsonSerializer.Serialize(new { type = "day.approach", lineageId = "farm", loadNonce = nonce, seq = 0,
            npcs = new Dictionary<string, object?> { ["abigail"] = 0, ["sam"] = 5, ["penny"] = "5", ["haley"] = -1, ["leah"] = 15, ["emily"] = 1.5, ["maru"] = null } }));
        Check((bool)Invoke(mod, "HandleApproach", "day.approach", packet.RootElement)!, "The packet was not recognized.");
        Check(hearts.Count == (nonce == "current" ? 2 : 0), "An old load's list was used, or bad values were kept.");
    }
    Check(hearts["Abigail"] == 0 && hearts["Sam"] == 5, "Ids from the backend did not match game names.");
    ((HashSet<string>)Get(mod, "approached")!).Add("Abigail");
    Set(mod, "lastApproachAt", 1000);
    Invoke(mod, "ClearApproach");
    Check(hearts.Count == 0 && ((HashSet<string>)Get(mod, "approached")!).Count == 0 && (int)Get(mod, "lastApproachAt")! == -1 && Get(mod, "approach") is null,
        "A new load/day kept who walks over, who came, or the gap.");
});
Test("walking over holds the NPC until released, so its schedule only queues meanwhile", () =>
{
    Type pointType = Type.GetType("Microsoft.Xna.Framework.Point, MonoGame.Framework", throwOnError: true)!;
    Type timeType = Type.GetType("Microsoft.Xna.Framework.GameTime, MonoGame.Framework", throwOnError: true)!;
    object path = Activator.CreateInstance(typeof(Stack<>).MakeGenericType(pointType))!;
    path.GetType().GetMethod("Push")!.Invoke(path, new[] { Activator.CreateInstance(pointType, 3, 4) });
    Type controllerType = modType.GetNestedType("ApproachController", BindingFlags.NonPublic)!;
    object controller = Activator.CreateInstance(controllerType, Fields, binder: null, args: new object?[] { path, null, null, 2 }, culture: null)!;
    Check((int)Get(controller, "finalFacingDirection")! == 2 && !(bool)Get(controller, "NPCSchedule")!, "The controller does not face back or looks like a schedule path.");
    path.GetType().GetMethod("Clear")!.Invoke(path, null);
    object time = Activator.CreateInstance(timeType)!;
    bool Update() => (bool)controllerType.GetMethod("update")!.Invoke(controller, new[] { time })!;
    Set(controller, "Hold", true);
    Check(!Update(), "A held NPC was handed back with its path done.");
    Set(controller, "Hold", false);
    Check(Update(), "A released NPC was not handed back once its path was done.");
});
Test("today's appointments come from the current load only, skip bad rows, and keep the ones already in a schedule", () =>
{
    object mod = BubbleMod();
    Set(mod, "meetings", Activator.CreateInstance(modType.GetField("meetings", Fields)!.FieldType, StringComparer.OrdinalIgnoreCase)!);
    var meetings = (System.Collections.IDictionary)Get(mod, "meetings")!;
    JsonDocument Packet(string nonce, params object?[] rows) => JsonDocument.Parse(JsonSerializer.Serialize(new { type = "day.meetings",
        lineageId = "farm", loadNonce = nonce, seq = 0, meetings = rows }));
    object?[] rows = { new { npc = "elliott", time = 700, place = "海滩" }, new { npc = "alex", time = 1405, place = "海滩" },
        new { npc = "sebastian", time = 2110, place = "海滩" },
        new { npc = "abigail", time = 1400, place = "海滩" }, new { npc = "sam", time = 1900, place = "星之果实餐吧" },
        new { npc = "penny", time = 1475, place = "海滩" }, new { npc = "haley", time = 1400, place = "你家" }, new { npc = "nobody", time = 1400, place = "海滩" },
        new { npc = 7, time = 1400, place = "海滩" }, new { npc = "leah", time = "1400", place = "海滩" }, null, "bad" };
    foreach (string nonce in new[] { "old", "current" })
    {
        using JsonDocument packet = Packet(nonce, rows);
        Check((bool)Invoke(mod, "HandleMeetings", "day.meetings", packet.RootElement)!, "The packet was not recognized.");
        Check(meetings.Count == (nonce == "current" ? 2 : 0), "An old load's list was used, or bad rows were kept.");
    }
    object abigail = meetings["Abigail"]!;
    Check((int)abigail.GetType().GetProperty("Leave")!.GetValue(abigail)! == 1530, "The NPC does not leave ninety minutes after the agreed time.");
    Set(abigail, "Applied", true);
    using (JsonDocument later = Packet("current", new { npc = "leah", time = 1000, place = "森林河边" }))
        Invoke(mod, "HandleMeetings", "day.meetings", later.RootElement);
    Check(meetings.Contains("Abigail") && meetings.Contains("Leah") && !meetings.Contains("Sam"),
        "A newer list dropped a meeting already in a schedule, or kept one that was not.");
    Invoke(mod, "ClearMeetings");
    Check(meetings.Count == 0, "A new load/day kept old appointments.");
});
Test("appointments leave ninety minutes later but by 22:00, and set off early enough but never in the past", () =>
{
    int Leave(int time) => (int)modType.GetMethod("MeetingLeave", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, new object[] { time })!;
    int Depart(int arrive, int travel, int now) => (int)modType.GetMethod("MeetingDeparture", BindingFlags.Static | BindingFlags.NonPublic)!
        .Invoke(null, new object[] { arrive, travel, now })!;
    Check(Leave(1400) == 1530 && Leave(1950) == 2120 && Leave(2100) == 2200, "Leaving time is wrong.");
    Check(Depart(1400, 30, 900) == 1320 && Depart(1400, 0, 900) == 1350, "Not setting off early enough to arrive ten minutes early.");
    Check(Depart(1400, 120, 1235) == 1240 && Depart(1400, 120, 1240) == 1250, "Set off in the past or at a tick already checked.");
});

Test("an appointment agreed today may be from 6:00, is put off to when the NPC can get there, and stays given up", () =>
{
    object mod = BubbleMod();
    Set(mod, "meetings", Activator.CreateInstance(modType.GetField("meetings", Fields)!.FieldType, StringComparer.OrdinalIgnoreCase)!);
    var meetings = (System.Collections.IDictionary)Get(mod, "meetings")!;
    JsonDocument Packet(params object[] rows) => JsonDocument.Parse(JsonSerializer.Serialize(new { type = "day.meetings", lineageId = "farm",
        loadNonce = "current", seq = 0, meetings = rows }));
    using (JsonDocument packet = Packet(new { npc = "abigail", time = 640, place = "矿洞", sameDay = true }, new { npc = "sam", time = 640, place = "海滩" }))
        Invoke(mod, "HandleMeetings", "day.meetings", packet.RootElement);
    Check(meetings.Contains("Abigail") && !meetings.Contains("Sam"), "Only one agreed today may be before 8:00 (src/bridge/memory.ts wire).");
    object abigail = meetings["Abigail"]!;
    Check((bool)abigail.GetType().GetProperty("SameDay")!.GetValue(abigail)!, "The appointment lost that it was agreed today.");
    abigail.GetType().GetProperty("Time")!.SetValue(abigail, 1150);
    Check((int)abigail.GetType().GetProperty("Leave")!.GetValue(abigail)! == 1320, "Leaving was not put off with the appointment.");
    (int, int) Soonest(int now, int walkEnds, int travel) => ((int, int))modType.GetMethod("SoonestMeeting", BindingFlags.Static | BindingFlags.NonPublic)!
        .Invoke(null, new object[] { now, walkEnds, travel })!;
    Check(Soonest(1000, 1000, 90) == (1010, 1150), "Not setting off at the next tick, or not arriving ten minutes early.");
    Check(Soonest(1000, 1035, 30) == (1040, 1120), "Set off before the walk it was on was over.");
    Check(Soonest(640, 640, 20) == (650, 800), "Came before 8:00.");
    Set(abigail, "Failed", true);
    using (JsonDocument later = Packet(new { npc = "abigail", time = 640, place = "矿洞", sameDay = true }, new { npc = "leah", time = 1500, place = "海滩", sameDay = true }))
        Invoke(mod, "HandleMeetings", "day.meetings", later.RootElement);
    Check(meetings["Abigail"] == abigail && meetings.Contains("Leah"), "A resend tried again one given up, or dropped a new one.");
});

Test("a called-off appointment is marked for undoing, never added, and one not yet in a schedule is simply given up", () =>
{
    object mod = BubbleMod();
    Set(mod, "meetings", Activator.CreateInstance(modType.GetField("meetings", Fields)!.FieldType, StringComparer.OrdinalIgnoreCase)!);
    var meetings = (System.Collections.IDictionary)Get(mod, "meetings")!;
    JsonDocument Packet(params object[] rows) => JsonDocument.Parse(JsonSerializer.Serialize(new { type = "day.meetings", lineageId = "farm",
        loadNonce = "current", seq = 0, meetings = rows }));
    using (JsonDocument packet = Packet(new { npc = "abigail", time = 1000, place = "矿洞" }, new { npc = "leah", time = 1400, place = "海滩" }))
        Invoke(mod, "HandleMeetings", "day.meetings", packet.RootElement);
    object abigail = meetings["Abigail"]!, leah = meetings["Leah"]!;
    Set(abigail, "Applied", true);
    using (JsonDocument later = Packet(new { npc = "abigail", time = 1000, place = "矿洞", calledOff = true },
        new { npc = "leah", time = 1400, place = "海滩", calledOff = true }, new { npc = "sam", time = 1500, place = "海滩", calledOff = true }))
        Invoke(mod, "HandleMeetings", "day.meetings", later.RootElement);
    Check(meetings["Abigail"] == abigail && (bool)Get(abigail, "CallOff")!, "One under way was not marked to be undone (src/bridge/memory.ts wire).");
    Check(!meetings.Contains("Leah") && !meetings.Contains("Sam"), "One not yet in a schedule, or one never sent, came back called off.");
    Check(((System.Collections.IDictionary)Get(abigail, "Replaced")!).Count == 0, "Nothing was replaced, so nothing should be put back.");
    Set(leah, "CallOff", true);
    Invoke(mod, "CallOffMeeting", leah);
    Check((bool)Get(leah, "Failed")! && (bool)Get(leah, "Reported")! && (bool)Get(leah, "CalledOff")!, "One never applied could still be applied or reported.");
});

Test("an appointment moved within today is marked to be moved, one moved to another day says where, and one that could not go is tried afresh", () =>
{
    object mod = BubbleMod();
    Set(mod, "meetings", Activator.CreateInstance(modType.GetField("meetings", Fields)!.FieldType, StringComparer.OrdinalIgnoreCase)!);
    var meetings = (System.Collections.IDictionary)Get(mod, "meetings")!;
    JsonDocument Packet(params object[] rows) => JsonDocument.Parse(JsonSerializer.Serialize(new { type = "day.meetings", lineageId = "farm",
        loadNonce = "current", seq = 0, meetings = rows }));
    using (JsonDocument packet = Packet(new { npc = "abigail", time = 1400, place = "海滩" }, new { npc = "leah", time = 1400, place = "海滩" },
        new { npc = "sam", time = 1500, place = "墓地", sameDay = true }))
        Invoke(mod, "HandleMeetings", "day.meetings", packet.RootElement);
    object abigail = meetings["Abigail"]!, leah = meetings["Leah"]!, sam = meetings["Sam"]!;
    Set(abigail, "Applied", true); Set(leah, "Applied", true); Set(sam, "Failed", true);
    using (JsonDocument later = Packet(new { npc = "abigail", time = 1500, place = "镇广场", sameDay = true },
        new { npc = "leah", time = 1400, place = "海滩", calledOff = true, movedTo = "明天（周五）15:00 在镇广场" },
        new { npc = "sam", time = 1700, place = "墓地", sameDay = true }))
        Invoke(mod, "HandleMeetings", "day.meetings", later.RootElement);
    var move = Get(abigail, "MoveTo");
    Check(meetings["Abigail"] == abigail && move is not null && move.ToString() == "(1500, 镇广场)", "A move within today was not marked (docs/npc-meetings-more.md §1).");
    Check((bool)Get(leah, "CallOff")! && (string?)Get(leah, "MovedTo") == "明天（周五）15:00 在镇广场", "A move to another day did not say where.");
    Check(meetings["Sam"] != sam && (int)modType.GetNestedType("Meeting", BindingFlags.NonPublic)!.GetProperty("Agreed")!.GetValue(meetings["Sam"])! == 1700,
        "One that could not go was not tried again at the new time.");
});

Test("one that walking cannot get there in time may appear there half an hour early, never in the past", () =>
{
    int Warp(int time, int now) => (int)modType.GetMethod("WarpDeparture", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, new object[] { time, now })!;
    Check(Warp(1400, 600) == 1330, "Not half an hour before the agreed time (docs/npc-meeting-warp.md).");
    Check(Warp(1000, 1030) == 1040 && Warp(1500, 1450) == 1500, "Right away, or too late to wait: not the next tick.");
});

Test("today's wait follows observed arrival, while tomorrow's keeps the agreed deadline and neither passes 22:00", () =>
{
    Type meetingType = modType.GetNestedType("Meeting", BindingFlags.NonPublic)!;
    object Meeting(bool sameDay) => Activator.CreateInstance(meetingType, "Abigail", 1740, "海滩", sameDay)!;
    int Leave(object m) => (int)meetingType.GetProperty("Leave")!.GetValue(m)!;
    object today = Meeting(true), tomorrow = Meeting(false);
    Check(Leave(today) == 1910, "Before arrival the estimate is still needed for planning.");
    Set(today, "ArrivedAt", 1600); Set(tomorrow, "ArrivedAt", 1600);
    Check(Leave(today) == 1730 && Leave(tomorrow) == 1910, "Observed arrival did not control only today's wait.");
    Set(today, "ArrivedAt", 1800);
    Check(Leave(today) == 1930, "A late arrival lost part of its wait.");
    Set(today, "ArrivedAt", 2150);
    Check(Leave(today) == 2200, "An observed arrival kept the NPC after 22:00.");
});

Test("an appointment moves friendship by the backend's tiers: one step up when kept, one down when stood up", () =>
{
    (int, int) Step(int hearts, string relation) => ((int, int))modType.GetMethod("FriendshipStep", BindingFlags.Static | BindingFlags.NonPublic)!
        .Invoke(null, new object[] { hearts, relation })!;
    // src/agent/friendship.ts STEPS: gain and loss per mood step.
    Check(Step(0, "stranger") == (5, 20) && Step(1, "friend") == (5, 20) && Step(2, "friend") == (10, 15) && Step(4, "friend") == (10, 15)
        && Step(5, "friend") == (15, 10) && Step(7, "friend") == (15, 10) && Step(8, "friend") == (20, 5) && Step(14, "friend") == (20, 5),
        "The tiers differ from the backend's (src/agent/friendship.ts STEPS).");
    Check(Step(3, "dating") == (20, 5) && Step(0, "married") == (20, 5) && Step(2, "roommate") == (20, 5) && Step(6, "engaged") == (20, 5),
        "A close relation is not on the top tier.");
});

Test("only an observed late arrival excuses a same-day no-show, independent of the estimated clock", () =>
{
    Type meetingType = modType.GetNestedType("Meeting", BindingFlags.NonPublic)!;
    object m = Activator.CreateInstance(meetingType, "Abigail", 1500, "海滩", true)!;
    bool Late() => (bool)meetingType.GetProperty("ComesLate")!.GetValue(m)!;
    Set(m, "ReceivedAt", 1000);
    Check(!Late(), "A route estimate counted as an observed late arrival.");
    meetingType.GetProperty("Time")!.SetValue(m, 1740); Set(m, "ArrivedAt", 1500);
    Check(!Late(), "An on-time arrival inherited its late estimate.");
    meetingType.GetProperty("Time")!.SetValue(m, 1500); Set(m, "ArrivedAt", 1600);
    Check(Late(), "An actually late arrival inherited its on-time estimate.");
    Set(m, "ReceivedAt", 1500);
    Check(!Late(), "An immediate invitation was treated as a missed future clock.");
});

Test("an outing follows the player except where monsters are, into the bathhouse or a festival, and stands at their side", () =>
{
    bool Goes(string? location) => (bool)modType.GetMethod("OutingGoes", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, new object?[] { location })!;
    Check(new[] { "Beach", "Town", "Mountain", "Mine", "SkullCave", "Desert", "FarmHouse", "Saloon", "BathHouse_Entry", "Caldera" }.All(Goes),
        "An ordinary place was left out (docs/npc-outing.md).");
    Check(!new[] { "UndergroundMine35", "UndergroundMine121", "VolcanoDungeon3", "BugLand", "BathHouse_Pool", "BathHouse_MensLocker",
        "BathHouse_WomensLocker", "Temp", null }.Any(Goes), "It followed where it should wait.");
    MethodInfo besideTiles = modType.GetMethod("BesideTiles", BindingFlags.Static | BindingFlags.NonPublic)!;
    Type pointType = besideTiles.ReturnType.GetElementType()!;
    // The game's Point, through reflection: this project does not reference MonoGame.
    string Beside(int x, int y, int facing) => string.Join(" ", ((Array)besideTiles.Invoke(null, new[] { Activator.CreateInstance(pointType, x, y)!, facing })!)
        .Cast<object>().Select(point => $"{pointType.GetField("X")!.GetValue(point)},{pointType.GetField("Y")!.GetValue(point)}"));
    Check(Beside(10, 10, 2) == "9,10 11,10" && Beside(10, 10, 0) == "9,10 11,10" && Beside(10, 10, 1) == "10,9 10,11" && Beside(10, 10, 3) == "10,9 10,11",
        "Not at the player's sides, looking the way they look.");
});

Test("on an outing it suggests only ordinary places, and a shop only while it is open", () =>
{
    bool Open(string place, int time, int day) => (bool)modType.GetMethod("OpenNow", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, new object[] { place, time, day })!;
    Check(Open("海滩", 700, 3) && Open("山上湖边", 2000, 10) && !Open("农场", 1200, 1) && !Open("矿洞", 1200, 1) && !Open("花舞节", 1200, 24),
        "The farm, a dungeon door or a festival was suggested (docs/npc-meetings-more.md §4).");
    Check(Open("杂货店", 1000, 1) && !Open("杂货店", 1000, 3) && !Open("杂货店", 1800, 1) && Open("博物馆", 1500, 3) && !Open("博物馆", 1900, 3)
        && !Open("星之果实餐吧", 1100, 1) && Open("星之果实餐吧", 2000, 1), "A shop was suggested while closed.");
});

Test("an outing reports the places first visited, at most six, in the backend's fields; only ordinary places have one", () =>
{
    Type outingType = modType.GetNestedType("Outing", BindingFlags.NonPublic)!;
    object outing = Activator.CreateInstance(outingType)!;
    foreach (string place in new[] { "海滩", "鹈鹕镇", "海滩", "山区", "煤矿森林", "博物馆", "星之果实餐吧", "杂货店" })
        outingType.GetMethod("Visit")!.Invoke(outing, new object[] { place });
    var fields = (Dictionary<string, object?>)outingType.GetMethod("Fields")!.Invoke(outing, null)!;
    // src/bridge/protocol.ts `outing`: these keys, places 1-6, fishNames at most 3.
    Check(fields.Keys.OrderBy(key => key, StringComparer.Ordinal).SequenceEqual(new[] { "artifacts", "escaped", "fish", "fishNames", "foraged", "here", "places", "treasures" }),
        "The fields differ from the backend's (src/agent/meetings.ts Outing).");
    Check(((string[])fields["places"]!).SequenceEqual(new[] { "海滩", "鹈鹕镇", "山区", "煤矿森林", "博物馆", "星之果实餐吧" }) && (string)fields["here"]! == "杂货店",
        "Places are not the first six visited, or where it is now was lost.");
    Type meetingType = modType.GetNestedType("Meeting", BindingFlags.NonPublic)!;
    bool Ordinary(string place) => (bool)meetingType.GetProperty("Ordinary")!.GetValue(Activator.CreateInstance(meetingType, "Abigail", 1400, place, false))!;
    Check(Ordinary("海滩") && Ordinary("杂货店") && !Ordinary("农场") && !Ordinary("矿洞") && !Ordinary("火山"), "The farm or a dungeon door went on an outing.");
});

Test("about one day in three someone asks the player out, the same one for a save and day, and not again within a week", () =>
{
    MethodInfo inviteDay = modType.GetMethod("InviteDay", BindingFlags.Static | BindingFlags.NonPublic)!;
    MethodInfo choose = modType.GetMethod("ChooseInviter", BindingFlags.Static | BindingFlags.NonPublic)!;
    MethodInfo lately = modType.GetMethod("AskedLately", BindingFlags.Static | BindingFlags.NonPublic)!;
    bool Day(ulong game, int day) => (bool)inviteDay.Invoke(null, new object[] { game, day })!;
    string? Choose(ulong game, int day, string[] eligible) => (string?)choose.Invoke(null, new object[] { game, day, eligible });
    int days = Enumerable.Range(1, 3000).Count(day => Day(436774213UL, day));
    Check(days > 850 && days < 1150, $"Not about one day in three: {days} of 3000 (docs/npc-invites.md).");
    Check(Enumerable.Range(1, 30).Select(day => Day(436774213UL, day)).SequenceEqual(Enumerable.Range(1, 30).Select(day => Day(436774213UL, day)))
        && Enumerable.Range(1, 60).Any(day => Day(1UL, day) != Day(2UL, day)), "Not fixed for a save, or the same for every save.");
    string[] close = { "Abigail", "Leah", "Sebastian", "Haley" };
    Check(Choose(7UL, 12, close) == Choose(7UL, 12, close.Reverse().ToArray()) && close.Contains(Choose(7UL, 12, close)),
        "The one who asks depends on the order, or is not among those who may.");
    Check(Enumerable.Range(1, 40).Select(day => Choose(7UL, day, close)).Distinct().Count() > 1, "The same one asks every day.");
    Check(Choose(7UL, 12, Array.Empty<string>()) is null, "Someone asked with nobody close enough.");
    bool Lately(int? last, int today) => (bool)lately.Invoke(null, new object?[] { last, today })!;
    Check(Lately(10, 16) && !Lately(10, 17) && !Lately(null, 3), "Not a week between two invitations from the same NPC.");
});

Test("a festival is a place an appointment can be at, the evening ones at 22:00, by vanilla's festival id, and is no outing", () =>
{
    object mod = BubbleMod();
    Set(mod, "meetings", Activator.CreateInstance(modType.GetField("meetings", Fields)!.FieldType, StringComparer.OrdinalIgnoreCase)!);
    var meetings = (System.Collections.IDictionary)Get(mod, "meetings")!;
    using JsonDocument packet = JsonDocument.Parse(JsonSerializer.Serialize(new { type = "day.meetings", lineageId = "farm", loadNonce = "current", seq = 0,
        meetings = new object[] { new { npc = "abigail", time = 2200, place = "月光水母起舞" }, new { npc = "leah", time = 2200, place = "海滩" },
            new { npc = "sam", time = 900, place = "花舞节" } } }));
    Invoke(mod, "HandleMeetings", "day.meetings", packet.RootElement);
    Check(meetings.Contains("Abigail") && meetings.Contains("Sam") && !meetings.Contains("Leah"), "22:00 is for the evening festivals only (docs/npc-meetings-more.md §3).");
    Type meetingType = modType.GetNestedType("Meeting", BindingFlags.NonPublic)!;
    Check((string?)meetingType.GetProperty("Festival")!.GetValue(meetings["Abigail"]) == "summer28"
        && (string?)meetingType.GetProperty("Festival")!.GetValue(meetings["Sam"]) == "spring24", "Not vanilla's festival id.");
    Check(!(bool)meetingType.GetProperty("Ordinary")!.GetValue(meetings["Sam"])!, "Going to a festival together became an outing.");
});

Test("farm chores are worded like the backend, and the farm is a place an appointment can be at", () =>
{
    Type doneType = modAssembly.GetType("StardewAgentBridge.FarmHelp+Done", throwOnError: true)!;
    string Text(int watered, int harvested, int fed, int ponds, int collected = 0, int milked = 0, int sheared = 0, int petted = 0, int truffles = 0)
        => (string)modType.GetMethod("FarmHelpText", BindingFlags.Static | BindingFlags.NonPublic)!
        .Invoke(null, new[] { Activator.CreateInstance(doneType, watered, harvested, fed, ponds, collected, milked, sheared, petted, truffles) })!;
    Check(Text(120, 35, 8, 2) == "浇了 120 格水、收了 35 个作物放进农舍门口的箱子、给动物添了 8 份干草、收了 2 个鱼塘的产物放进箱子"
        && Text(0, 4, 0, 0) == "收了 4 个作物放进农舍门口的箱子" && Text(0, 0, 0, 0) == "农场里没什么要干的活"
        && Text(0, 0, 0, 0, 6, 2, 1, 9, 1) == "捡了 6 个鸡舍里的产品放进箱子、挤了 2 只动物的奶、剪了 1 只羊的毛、摸了 9 只动物、捡了 1 个松露",
        "The game's message differs from what the NPC is told it did (src/agent/meetings.ts helpedText).");
    object mod = BubbleMod();
    Set(mod, "meetings", Activator.CreateInstance(modType.GetField("meetings", Fields)!.FieldType, StringComparer.OrdinalIgnoreCase)!);
    using JsonDocument packet = JsonDocument.Parse(JsonSerializer.Serialize(new { type = "day.meetings", lineageId = "farm", loadNonce = "current", seq = 0,
        meetings = new[] { new { npc = "abigail", time = 1000, place = "农场" } } }));
    Invoke(mod, "HandleMeetings", "day.meetings", packet.RootElement);
    Check(((System.Collections.IDictionary)Get(mod, "meetings")!).Contains("Abigail"), "A farm appointment was dropped.");
});

Test("dungeon floors are read from location names, each dungeon its own, and its door is where the trip ends", () =>
{
    int? Floor(string place, string? location) => (int?)modType.GetMethod("DungeonFloor", BindingFlags.Static | BindingFlags.NonPublic)!
        .Invoke(null, new object?[] { place, location });
    Check(Floor("矿洞", "Mine") == 0 && Floor("矿洞", "UndergroundMine35") == 35 && Floor("矿洞", "UndergroundMine120") == 120
        && Floor("矿洞", "UndergroundMine20:3") == 20, "Mine floors are wrong.");
    Check(Floor("矿洞", "UndergroundMine121") is null && Floor("矿洞", "UndergroundMine77377") is null && Floor("矿洞", "Mountain") is null
        && Floor("矿洞", "SkullCave") is null && Floor("矿洞", null) is null, "Something outside the mines counted as inside.");
    Check(Floor("骷髅洞穴", "SkullCave") == 0 && Floor("骷髅洞穴", "UndergroundMine121") == 1 && Floor("骷髅洞穴", "UndergroundMine245") == 125
        && Floor("骷髅洞穴", "UndergroundMine77377") is null && Floor("骷髅洞穴", "UndergroundMine50") is null && Floor("骷髅洞穴", "Desert") is null,
        "Skull Cavern floors are wrong, or the quarry mine counted.");
    Check(Floor("火山", "VolcanoDungeon0") == 0 && Floor("火山", "VolcanoDungeon9") == 9 && Floor("火山", "Caldera") == 10
        && Floor("火山", "IslandNorth") is null && Floor("火山", "Mine") is null, "Volcano floors are wrong.");
    var exits = (System.Collections.IDictionary)modType.GetField("DungeonExits", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
    var places = (System.Collections.IDictionary)modType.GetField("MeetPlaces", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
    foreach (string place in new[] { "矿洞", "骷髅洞穴", "火山" })
    {
        object exit = exits[place]!;
        string map = (string)exit.GetType().GetField("Item1")!.GetValue(exit)!;
        Check(places.Contains(place), $"{place} is not a place an appointment can be at.");
        foreach (object spot in (Array)places[place]!)
            Check((string)spot.GetType().GetField("Item1")!.GetValue(spot)! == map, $"{place}'s waiting spot is not outside its door.");
    }
    object mod = BubbleMod();
    Set(mod, "meetings", Activator.CreateInstance(modType.GetField("meetings", Fields)!.FieldType, StringComparer.OrdinalIgnoreCase)!);
    using JsonDocument packet = JsonDocument.Parse(JsonSerializer.Serialize(new { type = "day.meetings", lineageId = "farm", loadNonce = "current", seq = 0,
        meetings = new[] { new { npc = "abigail", time = 1000, place = "矿洞" }, new { npc = "kent", time = 1000, place = "骷髅洞穴" },
            new { npc = "sebastian", time = 1200, place = "火山" } } }));
    Invoke(mod, "HandleMeetings", "day.meetings", packet.RootElement);
    Check(((System.Collections.IDictionary)Get(mod, "meetings")!).Count == 3, "A dungeon appointment was dropped.");
});
Test("a trip is reported in the shape the backend accepts", () =>
{
    Type tripType = modType.GetNestedType("Trip", BindingFlags.NonPublic)!;
    object trip = Activator.CreateInstance(tripType, nonPublic: true)!;
    Set(trip, "Floor", 35); Set(trip, "Deepest", 40); Set(trip, "Kills", 12); Set(trip, "Rescued", true);
    var fields = (Dictionary<string, object?>)tripType.GetMethod("Fields")!.Invoke(trip, new object[] { true })!;
    Check(JsonSerializer.Serialize(fields) == """{"floor":35,"deepest":40,"kills":12,"fights":true,"rescued":true}""",
        "The trip fields differ from src/bridge/protocol.ts (mine).");
});

Console.WriteLine($"Mod flow checks: {checks - failures}/{checks} passed.");
return failures == 0 ? 0 : 1;
