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

Console.WriteLine($"Mod flow checks: {checks - failures}/{checks} passed.");
return failures == 0 ? 0 : 1;
