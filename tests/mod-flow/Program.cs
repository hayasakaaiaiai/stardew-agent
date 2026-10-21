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

Console.WriteLine($"Mod flow checks: {checks - failures}/{checks} passed.");
return failures == 0 ? 0 : 1;
