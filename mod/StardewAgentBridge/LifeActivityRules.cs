using System;
using System.Collections.Generic;

namespace StardewAgentBridge;

/// <summary>Pure completion and clock rules shared by live activities and offline checks.</summary>
internal static class LifeActivityRules
{
    internal static readonly HashSet<string> Activities = new(StringComparer.Ordinal)
    {
        "forest_walk", "foraging", "fishing", "cooking", "spouse_walk", "home_dinner",
    };

    internal static bool SameSession(string nonce, int day, string currentNonce, int currentDay)
        => nonce == currentNonce && day == currentDay;

    internal static bool MenuAllowed(bool canChat, bool supported, bool allowExistingExit, bool hasExistingExit)
        => canChat && supported || allowExistingExit && hasExistingExit;

    internal static bool StartTime(int time) => time >= 900 && time <= 1900;

    internal static bool Ready(string activity, int minutes, int count) => activity switch
    {
        "forest_walk" or "spouse_walk" => minutes >= 30,
        "foraging" or "fishing" => minutes >= 20 && count >= 1,
        "cooking" or "home_dinner" => count >= 1,
        _ => false,
    };

    /// <summary>Only an observed ordinary ten-minute tick is eligible; time jumps never credit company.</summary>
    internal static int ClockStep(int previous, int current, bool together)
    {
        if (!together || previous < 600 || current > 2600 || previous % 100 >= 60 || current % 100 >= 60)
            return 0;
        int elapsed = (current / 100 * 60 + current % 100) - (previous / 100 * 60 + previous % 100);
        return elapsed == 10 ? elapsed : 0;
    }

    internal static bool PublicActivity(string activity) => activity is "forest_walk" or "foraging" or "fishing" or "cooking";

    internal static readonly (string A, string B)[] Friends =
    {
        ("leah", "elliott"), ("sam", "sebastian"), ("sam", "abigail"),
        ("sebastian", "abigail"), ("maru", "penny"), ("emily", "sandy"),
    };

    internal static bool AreFriends(string a, string b) => Array.Exists(Friends,
        pair => pair.A == a && pair.B == b || pair.A == b && pair.B == a);

    /// <summary>Replays only objective repair evidence, matching the bounded backend grievance queue.</summary>
    internal static string? UnrepairedMiss(IEnumerable<(string Id, string Kind, int Day, string? SourceId)> events)
    {
        List<(string Id, bool Apologized)> grievances = new();
        int lastTrustDay = -1;
        foreach (var entry in events)
        {
            if (entry.Kind == "activity.missed")
            {
                grievances.Add((entry.Id, false));
                if (grievances.Count > 3)
                    grievances.RemoveAt(0);
            }
            else if (entry.Kind == "relationship.apology")
            {
                int index = entry.SourceId is string source ? grievances.FindIndex(item => item.Id == source) : grievances.Count - 1;
                if (index >= 0)
                    grievances[index] = (grievances[index].Id, true);
            }
            else if ((entry.Kind is "activity.completed" or "goal.completed") && lastTrustDay != entry.Day)
            {
                lastTrustDay = entry.Day;
                int index = grievances.FindIndex(item => item.Apologized);
                if (index >= 0)
                    grievances.RemoveAt(index);
            }
        }
        return grievances.Count == 0 ? null : grievances[^1].Id;
    }

    internal static string Label(string activity) => activity switch
    {
        "forest_walk" => "森林散步", "foraging" => "一起采集", "fishing" => "陪你钓鱼",
        "cooking" => "一起做饭", "spouse_walk" => "一起出门走走", "home_dinner" => "一起吃饭", _ => "活动",
    };
}
