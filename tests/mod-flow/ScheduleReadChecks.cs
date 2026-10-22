using System.Collections;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;

internal static class ScheduleReadChecks
{
    public static void Run(Assembly modAssembly, Assembly gameAssembly, Action<string, Action> test)
    {
        const BindingFlags fields = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        const BindingFlags statics = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
        Type stateType = modAssembly.GetType("StardewAgentBridge.GameState", true)!;
        Type npcType = gameAssembly.GetType("StardewValley.NPC", true)!;
        Type gameType = gameAssembly.GetType("StardewValley.Game1", true)!;
        Type locationType = gameAssembly.GetType("StardewValley.GameLocation", true)!;
        PropertyInfo scheduleProperty = npcType.GetProperty("Schedule")!;
        Type stopType = scheduleProperty.PropertyType.GenericTypeArguments[1];
        void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
        void Set(object target, string name, object? value) => target.GetType().GetField(name, fields)!.SetValue(target, value);
        object? Get(object target, string name) => target.GetType().GetField(name, fields)!.GetValue(target);
        object Blank(Type type)
        {
            object value = RuntimeHelpers.GetUninitializedObject(type);
            GC.SuppressFinalize(value);
            return value;
        }
        object Npc(string name)
        {
            object npc = Blank(npcType);
            Type? owner = npcType;
            FieldInfo? nameField = null;
            while (owner is not null && nameField is null) { nameField = owner.GetField("name", fields); owner = owner.BaseType; }
            object netName = Activator.CreateInstance(nameField!.FieldType)!;
            netName.GetType().GetProperty("Value")!.SetValue(netName, name);
            nameField.SetValue(npc, netName);
            return npc;
        }
        IDictionary Stops(object npc, params (int Time, string Map, string? End)[] stops)
        {
            var schedule = (IDictionary)Activator.CreateInstance(scheduleProperty.PropertyType)!;
            foreach (var stop in stops)
            {
                object path = Blank(stopType);
                Set(path, "targetLocationName", stop.Map); Set(path, "endOfRouteBehavior", stop.End);
                schedule.Add(stop.Time, path);
            }
            scheduleProperty.SetValue(npc, schedule);
            return schedule;
        }
        object? Schedule(object npc) => stateType.GetMethod("Schedule", statics)!.Invoke(null, new[] { npc });
        Dictionary<string, object?> Add(object npc) => (Dictionary<string, object?>)stateType.GetMethod("AddSchedule", statics)!
            .Invoke(null, new object[] { new Dictionary<string, object?>(), npc })!;

        test("NPCs without a usable schedule omit it rather than sending null", () =>
        {
            object npc = Npc("Harvey");
            Check(Schedule(npc) is null && !Add(npc).ContainsKey("schedule"), "A missing schedule was sent as null.");
            Stops(npc);
            Check(Schedule(npc) is null && !Add(npc).ContainsKey("schedule"), "An empty schedule was sent.");
            Stops(npc, (900, "Hospital", null)); Set(npc, "ignoreScheduleToday", true);
            Check(Schedule(npc) is null && !Add(npc).ContainsKey("schedule"), "An ignored schedule reached the prompt.");
        });

        void World(Action<IDictionary> run)
        {
            FieldInfo instanceField = gameType.GetField("game1", statics)!;
            FieldInfo lookupField = gameType.GetField("_locationLookup", statics)!;
            object? previousInstance = instanceField.GetValue(null), previousLookup = lookupField.GetValue(null);
            object instance = Blank(gameType);
            Set(instance, "_locations", Activator.CreateInstance(typeof(List<>).MakeGenericType(locationType)));
            var lookup = (IDictionary)Activator.CreateInstance(lookupField.FieldType)!;
            instanceField.SetValue(null, instance); lookupField.SetValue(null, lookup);
            try { run(lookup); }
            finally { instanceField.SetValue(null, previousInstance); lookupField.SetValue(null, previousLookup); }
        }
        void Place(IDictionary lookup, string map, string display)
        {
            object location = Blank(locationType);
            locationType.GetProperty("DisplayName")!.SetValue(location, display);
            lookup.Add(map, location);
        }

        test("native schedules are sorted, localized and identify sleep without changing the vanilla schedule", () => World(lookup =>
        {
            Place(lookup, "Hospital", "诊所"); Place(lookup, "Town", "鹈鹕镇"); Place(lookup, "HarveyRoom", "哈维的房间");
            object npc = Npc("Harvey");
            IDictionary original = Stops(npc, (2200, "HarveyRoom", "harvey_sleep"), (1730, "Hospital", "harvey_read"), (1200, "Town", null));
            using JsonDocument packed = JsonDocument.Parse(JsonSerializer.Serialize(Add(npc)));
            JsonElement stops = packed.RootElement.GetProperty("schedule");
            Check(stops.EnumerateArray().Select(stop => stop.GetProperty("time").GetInt32()).SequenceEqual(new[] { 1200, 1730, 2200 }), "Stops were not in chronological order.");
            Check(stops[0].GetProperty("place").GetString() == "鹈鹕镇" && stops[1].GetProperty("place").GetString() == "诊所", "Map IDs replaced the available display names.");
            Check(!stops[1].GetProperty("sleep").GetBoolean() && stops[2].GetProperty("sleep").GetBoolean(), "The sleep end behavior was read incorrectly.");
            Check(ReferenceEquals(original, scheduleProperty.GetValue(npc)) && original.Count == 3, "Reading a schedule changed the game's schedule.");
        }));

        test("schedule maps fall back safely, display names fit the protocol and multi-NPC maps omit missing schedules", () => World(lookup =>
        {
            Place(lookup, "BlankDisplay", ""); Place(lookup, "LongDisplay", new string('地', 60));
            object present = Npc("Harvey"), absent = Npc("Krobus");
            Stops(present, (900, "BlankDisplay", null), (1000, "LongDisplay", null), (1100, "MissingMap", null));
            Array npcs = Array.CreateInstance(npcType, 2); npcs.SetValue(present, 0); npcs.SetValue(absent, 1);
            object combined = stateType.GetMethod("Schedules", statics)!.Invoke(null, new object[] { npcs })!;
            using JsonDocument packed = JsonDocument.Parse(JsonSerializer.Serialize(combined));
            JsonElement root = packed.RootElement;
            Check(root.EnumerateObject().Count() == 1 && !root.TryGetProperty("Krobus", out _), "A schedule-less NPC was sent with a null value.");
            JsonElement stops = root.GetProperty("Harvey");
            Check(stops[0].GetProperty("place").GetString() == "BlankDisplay" && stops[2].GetProperty("place").GetString() == "MissingMap", "A missing display name lost its map fallback.");
            Check(stops[1].GetProperty("place").GetString()!.Length == 50, "A long display name exceeds the protocol limit.");
        }));

        test("disabled backstage scenes keep the reliable town groups and places but omit hearts weather and schedules", () =>
        {
            Type modType = modAssembly.GetType("StardewAgentBridge.ModEntry", true)!;
            object mod = Blank(modType);
            object config = Activator.CreateInstance(modAssembly.GetType("StardewAgentBridge.ModConfig", true)!, true)!;
            config.GetType().GetProperty("BackstageScenes")!.SetValue(config, false);
            Set(mod, "config", config); Set(mod, "activeLoad", true); Set(mod, "initialSave", new Dictionary<string, object?>());
            Set(mod, "lineageId", "farm"); Set(mod, "loadNonce", "load");
            Set(mod, "lifecycle", Activator.CreateInstance(modAssembly.GetType("StardewAgentBridge.ReliableOutbox", true)!, true));
            Set(mod, "bridge", Activator.CreateInstance(modType.GetField("bridge", fields)!.FieldType, new Uri("ws://127.0.0.1:9"), null, "test"));
            Set(mod, "townPending", new List<List<string>> { new() { "Pam", "Gus" } }); Set(mod, "townPlaces", new List<string> { "星之果实餐吧" });
            modType.GetMethod("TickTown", fields)!.Invoke(mod, null);
            object outbox = Get(mod, "lifecycle")!;
            JsonElement[] packets = (JsonElement[])outbox.GetType().GetMethod("Messages")!.Invoke(outbox, null)!;
            Check(packets.Length == 1 && packets[0].GetProperty("type").GetString() == "town.hour", "The town hour stopped being reliable when backstage scenes were disabled.");
            JsonElement packet = packets[0];
            Check(packet.GetProperty("groups")[0].GetArrayLength() == 2 && packet.GetProperty("places")[0].GetString() == "星之果实餐吧", "Places and groups no longer match.");
            Check(!packet.TryGetProperty("hearts", out _) && !packet.TryGetProperty("weather", out _) && !packet.TryGetProperty("schedules", out _), "Disabled backstage scenes sent model-only metadata.");
            Check(Get(mod, "townPending") is null, "The same hour remained queued for a second send.");
        });
    }
}
