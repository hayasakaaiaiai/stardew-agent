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
        Console.WriteLine("FAIL " + name + ": " + error.Message);
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
    Set(watch, "SantaGiven", true); Set(watch, "SantaGiver", "Lewis");
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
    object?[] rows = { new { npc = "abigail", time = 1400, place = "海滩" }, new { npc = "sam", time = 1900, place = "星之果实餐吧" },
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

Test("farm chores are worded like the backend, and the farm is a place an appointment can be at", () =>
{
    Type doneType = modAssembly.GetType("StardewAgentBridge.FarmHelp+Done", throwOnError: true)!;
    string Text(int watered, int harvested, int fed, int ponds) => (string)modType.GetMethod("FarmHelpText", BindingFlags.Static | BindingFlags.NonPublic)!
        .Invoke(null, new[] { Activator.CreateInstance(doneType, watered, harvested, fed, ponds) })!;
    Check(Text(120, 35, 8, 2) == "浇了 120 格水、收了 35 个作物放进农舍门口的箱子、给动物添了 8 份干草、收了 2 个鱼塘的产物放进箱子"
        && Text(0, 4, 0, 0) == "收了 4 个作物放进农舍门口的箱子" && Text(0, 0, 0, 0) == "农场里没什么要干的活",
        "The game's message differs from what the NPC is told it did (src/agent/meetings.ts helpedText).");
    object mod = BubbleMod();
    Set(mod, "meetings", Activator.CreateInstance(modType.GetField("meetings", Fields)!.FieldType, StringComparer.OrdinalIgnoreCase)!);
    using JsonDocument packet = JsonDocument.Parse(JsonSerializer.Serialize(new { type = "day.meetings", lineageId = "farm", loadNonce = "current", seq = 0,
        meetings = new[] { new { npc = "abigail", time = 1000, place = "农场" } } }));
    Invoke(mod, "HandleMeetings", "day.meetings", packet.RootElement);
    Check(((System.Collections.IDictionary)Get(mod, "meetings")!).Contains("Abigail"), "A farm appointment was dropped.");
});

Console.WriteLine($"Mod flow checks: {checks - failures}/{checks} passed.");
return failures == 0 ? 0 : 1;
