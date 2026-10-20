using System.Collections.Generic;
using System.Linq;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>
/// Reads what the backend needs from the game. Values are raw flags; the backend words them for the model
/// (src/bridge/world.ts), so all prompt text stays in one place.
/// </summary>
internal static class GameState
{
    public static Dictionary<string, object?> Date() => new()
    {
        ["year"] = Game1.year,
        ["season"] = Game1.currentSeason,
        ["day"] = Game1.dayOfMonth,
        ["time"] = Game1.timeOfDay,
    };

    public static string Weather()
    {
        if (Game1.isLightning)
            return "storm";
        if (Game1.isRaining)
            return "rain";
        if (Game1.isSnowing)
            return "snow";
        return Game1.isDebrisWeather ? "windy" : "sunny";
    }

    public static Dictionary<string, object?> World() => new()
    {
        ["date"] = Date(),
        ["weather"] = Weather(),
        ["location"] = Game1.currentLocation?.DisplayName ?? "",
        ["flags"] = Flags(),
    };

    public static Dictionary<string, object?> Player() => new()
    {
        ["name"] = Game1.player.Name,
        ["gender"] = Game1.player.IsMale ? "male" : "female",
        ["farm"] = Game1.player.farmName.Value,
    };

    public static int Hearts(NPC npc) => Hearts(npc.Name);

    public static int Hearts(string name) => Game1.player.getFriendshipHeartLevelForNPC(name);

    public static string Relation(NPC npc) => Relation(npc.Name);

    public static string Relation(string name)
    {
        if (!Game1.player.friendshipData.TryGetValue(name, out Friendship? friendship))
            return "stranger";
        if (friendship.IsRoommate())
            return "roommate";
        if (friendship.IsMarried())
            return "married";
        if (friendship.IsEngaged())
            return "engaged";
        return friendship.IsDating() ? "dating" : "friend";
    }

    public static string[] SeenEvents() => Game1.player.eventsSeen.ToArray();

    /// <summary>What the companion robot needs while the game is closed (docs/companion-device.md §13.2).</summary>
    public static Dictionary<string, object?> Snapshot(IEnumerable<string> npcs) => new()
    {
        ["label"] = Constants.SaveFolderName ?? "",
        ["npcs"] = npcs.ToDictionary(name => name, name => (object?)new Dictionary<string, object?>
        {
            ["hearts"] = Hearts(name),
            ["relation"] = Relation(name),
        }),
        ["seenEvents"] = SeenEvents(),
        ["world"] = World(),
    };

    /// <summary>Story progress shared by the whole farm, so it is read from the main player.</summary>
    private static Dictionary<string, object?> Flags()
    {
        Farmer main = Game1.MasterPlayer;
        string communityCenter = main.mailReceived.Contains("ccIsComplete") || main.hasCompletedCommunityCenter()
            ? "restored"
            : main.mailReceived.Contains("JojaMember") ? "joja" : "pending";
        return new()
        {
            ["communityCenter"] = communityCenter,
            ["busRepaired"] = main.mailReceived.Contains("ccVault"),
            ["understandsDwarves"] = Game1.player.canUnderstandDwarves,
            ["pamHouse"] = main.mailReceived.Contains("pamHouseUpgrade"),
            ["islandOpen"] = main.mailReceived.Contains("willyBoatFixed"),
            ["leoMoved"] = main.mailReceived.Contains("leoMoved"),
        };
    }
}
