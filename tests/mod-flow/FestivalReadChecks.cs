using System.Reflection;
using System.Runtime.CompilerServices;

internal static class FestivalReadChecks
{
    public static void Run(Assembly modAssembly, Assembly gameAssembly, Action<string, Action> test)
    {
        const BindingFlags fields = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        Type modType = modAssembly.GetType("StardewAgentBridge.ModEntry", true)!;
        Type watchType = modType.GetNestedType("FestivalWatch", BindingFlags.NonPublic)!;
        Type eventType = gameAssembly.GetType("StardewValley.Event", true)!;
        Type npcType = gameAssembly.GetType("StardewValley.NPC", true)!;
        Type gameType = gameAssembly.GetType("StardewValley.Game1", true)!;
        void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
        object? Get(object target, string name) => target.GetType().GetField(name, fields)!.GetValue(target);
        void Set(object target, string name, object? value) => target.GetType().GetField(name, fields)!.SetValue(target, value);
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
        (object Mod, object Event, object Watch) Watch(string key)
        {
            object mod = Blank(modType), festival = Blank(eventType);
            Set(festival, "actors", Activator.CreateInstance(eventType.GetField("actors", fields)!.FieldType));
            Set(festival, "farmerActors", Activator.CreateInstance(eventType.GetField("farmerActors", fields)!.FieldType));
            object watch = Activator.CreateInstance(watchType, fields, null, new object[] { festival, key }, null)!;
            return (mod, festival, watch);
        }
        void Read(object mod, object watch) => modType.GetMethod("ReadFestival", fields)!.Invoke(mod, new[] { watch });

        test("festival witnesses are the union of actual social actors across reads", () =>
        {
            var (mod, festival, watch) = Watch("winter25");
            var actors = (System.Collections.IList)Get(festival, "actors")!;
            actors.Add(Npc("Penny")); actors.Add(Npc("Penny")); actors.Add(Npc("Governor"));
            Read(mod, watch);
            actors.Clear(); actors.Add(Npc("Lewis"));
            Read(mod, watch);
            Check(((List<string>)Get(watch, "Npcs")!).SequenceEqual(new[] { "Penny", "Lewis" }), "Actors were duplicated, forgotten, or included a non-social NPC.");
        });

        test("inviting a dance and reaching but not executing its music command do not count as dancing", () =>
        {
            var (mod, festival, watch) = Watch("spring24");
            Set(festival, "eventCommands", new[] { "pause 500", "playMusic FlowerDance", "pause 500" });
            foreach (int command in new[] { 0, 1 })
            {
                eventType.GetProperty("CurrentCommand")!.SetValue(festival, command);
                Read(mod, watch);
                Check(Get(watch, "Dance") is null, "A dance was reported before its main activity started.");
            }
        });

        test("secret Santa waits for handover and reads the replacement giver from the actual scene", () =>
        {
            var (mod, festival, watch) = Watch("winter25");
            Set(festival, "secretSantaRecipient", Npc("Penny"));
            Set(festival, "mySecretSanta", Npc("Sandy"));
            Read(mod, watch);
            Check((string?)Get(watch, "SantaRecipient") == "Penny" && !(bool)Get(watch, "SantaGiven")!, "Drawing a recipient counted as handing over a gift.");
            Check(Get(watch, "SantaGiver") is null, "The giver was read before the actual scene.");
            Set(festival, "secretSantaRecipient", null); Read(mod, watch);
            Check((bool)Get(watch, "SantaGiven")! && Get(watch, "SantaGiver") is null, "Handover was lost or the pre-scene giver was accepted.");
            Set(festival, "mySecretSanta", Npc("Lewis")); Set(festival, "doingSecretSanta", true);
            Read(mod, watch);
            Check((string?)Get(watch, "SantaRecipient") == "Penny" && (string?)Get(watch, "SantaGiver") == "Lewis", "The original draw replaced the giver actually present.");
        });

        test("the governor reaction is read from the native parsed script for every level and year variant", () =>
        {
            FieldInfo year = gameType.GetField("year", BindingFlags.Static | BindingFlags.Public)!;
            object? previousYear = year.GetValue(null);
            MethodInfo parse = eventType.GetMethod("ParseCommands", BindingFlags.Public | BindingFlags.Static)!;
            try
            {
                foreach (int gameYear in new[] { 1, 2 }) for (int level = 0; level <= 6; level++)
                {
                    year.SetValue(null, gameYear);
                    var (mod, festival, watch) = Watch("summer11");
                    var data = new Dictionary<string, string>();
                    for (int candidate = 0; candidate <= 6; candidate++)
                    {
                        data["governorReaction" + candidate] = "message base" + candidate + "/pause 10";
                        data["governorReaction" + candidate + "_y2"] = "message alternate" + candidate + "/pause 10";
                    }
                    Set(festival, "festivalData", data);
                    Set(festival, "eventCommands", new[] { "pause 99" }); Read(mod, watch);
                    Check(Get(watch, "Soup") is null, "An unrelated festival script was mistaken for the governor's reaction.");
                    string script = data["governorReaction" + level + (gameYear == 2 ? "_y2" : "")];
                    Set(festival, "eventCommands", parse.Invoke(null, new object?[] { script, null }));
                    Read(mod, watch);
                    Check((int?)Get(watch, "Soup") == level, $"Wrong soup reaction for year {gameYear}, level {level}.");
                    Set(festival, "eventCommands", new[] { "pause 99" }); Read(mod, watch);
                    Check((int?)Get(watch, "Soup") == level, "A later script erased the observed reaction.");
                }
            }
            finally { year.SetValue(null, previousYear); }
        });

        test("grange shorts are observed only after judging and a later read cannot change the result", () =>
        {
            var (mod, festival, watch) = Watch("fall16");
            Set(festival, "grangeScore", -666); Read(mod, watch);
            Check(Get(watch, "Grange") is null && !(bool)Get(watch, "GrangeRead")!, "An unjudged display was remembered.");
            Set(festival, "grangeJudged", true); Read(mod, watch);
            Check((string?)Get(watch, "Grange") == "shorts", "The judged shorts result was lost.");
            Set(festival, "grangeScore", 100); Read(mod, watch);
            Check((string?)Get(watch, "Grange") == "shorts", "A later score replaced the observed outcome.");
        });
    }
}
