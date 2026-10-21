using System.Collections.Generic;
using System.Linq;
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

    public static int Hearts(NPC npc) => Game1.player.getFriendshipHeartLevelForNPC(npc.Name);

    /// <summary>
    /// Today's schedule as the game computed it, stop by stop, for the backend to word (docs/npc-schedules.md). Null
    /// without one: on festival days, when an event has taken the NPC over, or for NPCs who never have one.
    /// </summary>
    public static List<Dictionary<string, object?>>? Schedule(NPC npc)
    {
        if (npc.Schedule is null || npc.Schedule.Count == 0 || npc.ignoreScheduleToday)
            return null;
        return npc.Schedule.OrderBy(stop => stop.Key).Take(24).Select(stop => new Dictionary<string, object?>
        {
            ["time"] = stop.Key,
            ["place"] = PlaceName(stop.Value.targetLocationName),
            // A "bed" stop is parsed into the NPC's home with this end behavior.
            ["sleep"] = stop.Value.endOfRouteBehavior?.EndsWith("_sleep") == true,
        }).ToList();
    }

    /// <summary>Adds the NPC's <c>schedule</c> to a message's fields if it has one; the backend rejects a null.</summary>
    public static Dictionary<string, object?> AddSchedule(Dictionary<string, object?> fields, NPC npc)
    {
        if (Schedule(npc) is { } stops)
            fields["schedule"] = stops;
        return fields;
    }

    /// <summary>Schedules by game name, for messages about several NPCs; NPCs without one are left out.</summary>
    public static Dictionary<string, object?> Schedules(IEnumerable<NPC> npcs)
    {
        Dictionary<string, object?> found = new();
        foreach (NPC npc in npcs)
            if (Schedule(npc) is { } stops)
                found[npc.Name] = stops;
        return found;
    }

    /// <summary>The place as the game shows it, within the protocol's 50 characters; the map name if it has none.</summary>
    private static string PlaceName(string map)
    {
        string? shown = Game1.getLocationFromName(map)?.DisplayName;
        string name = string.IsNullOrWhiteSpace(shown) ? map : shown;
        return name.Length > 50 ? name[..50] : name;
    }

    public static string Relation(NPC npc)
    {
        if (!Game1.player.friendshipData.TryGetValue(npc.Name, out Friendship? friendship))
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
            ["partner"] = Partner(main),
            ["children"] = main.getChildrenCount(),
        };
    }

    /// <summary>Whom the player is engaged to, married to or living with; the whole town knows (docs/world-public-facts.md).</summary>
    private static Dictionary<string, object?>? Partner(Farmer player)
    {
        foreach (KeyValuePair<string, Friendship> pair in player.friendshipData.Pairs)
        {
            string? status = pair.Value.IsRoommate() ? "roommate" : pair.Value.IsMarried() ? "married" : pair.Value.IsEngaged() ? "engaged" : null;
            if (status is not null)
                return new() { ["npc"] = pair.Key, ["status"] = status };
        }
        return null;
    }
}
