using System;
using System.Collections.Generic;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>
/// Agent conversations move vanilla friendship (docs/npc-friendship.md, design §8 friendship.adjust). The backend
/// already keeps each NPC's daily total in range; the Mod checks it again before changing the game. Appointments kept or
/// missed move it too, in the same daily range (docs/npc-meeting-friendship.md). The change is game state, so it is
/// saved or discarded with the game like everything else.
/// </summary>
internal sealed partial class ModEntry
{
    private const int FriendshipDayMin = -40;
    private const int FriendshipDayMax = 30;

    /// <summary>NPC name → points changed by agent conversations today.</summary>
    private readonly Dictionary<string, int> friendshipToday = new();

    private void ClearFriendshipToday() => this.friendshipToday.Clear();

    /// <summary>
    /// Points for one step up and one step down by how well the NPC knows the player; the same table as the backend's
    /// STEPS (src/agent/friendship.ts): a stranger is hard to win over and quick to take offence, a close friend the reverse.
    /// </summary>
    private static (int Gain, int Loss) FriendshipStep(int hearts, string relation)
        => relation is "dating" or "engaged" or "married" or "roommate" || hearts >= 8 ? (20, 5)
            : hearts >= 5 ? (15, 10) : hearts >= 2 ? (10, 15) : (5, 20);

    private void ApplyFriendship(NPC npc, int points)
    {
        if (this.config.ChatChangesFriendship)
            this.ChangeFriendshipToday(npc, points, $"和{npc.displayName}聊天");
    }

    /// <summary>Changes friendship within the day's range; returns what actually changed. `what` starts the log line.</summary>
    private int ChangeFriendshipToday(NPC npc, int points, string what)
    {
        if (points == 0 || !this.activeLoad)
            return 0;
        int before = this.friendshipToday.GetValueOrDefault(npc.Name);
        int after = Math.Clamp(before + points, FriendshipDayMin, FriendshipDayMax);
        if (after == before)
            return 0;
        this.friendshipToday[npc.Name] = after;
        Game1.player.changeFriendship(after - before, npc);
        this.Monitor.Log($"{what}，好感 {after - before:+#;-#}（今天合计 {after:+#;-#;0}）。", LogLevel.Info);
        return after - before;
    }
}
