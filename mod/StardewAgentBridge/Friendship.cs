using System;
using System.Collections.Generic;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>
/// Agent conversations move vanilla friendship (docs/npc-friendship.md, design §8 friendship.adjust). The backend
/// already keeps each NPC's daily total in range; the Mod checks it again before changing the game. The change is
/// game state, so it is saved or discarded with the game like everything else.
/// </summary>
internal sealed partial class ModEntry
{
    private const int FriendshipDayMin = -40;
    private const int FriendshipDayMax = 30;

    /// <summary>NPC name → points changed by agent conversations today.</summary>
    private readonly Dictionary<string, int> friendshipToday = new();

    private void ClearFriendshipToday() => this.friendshipToday.Clear();

    private void ApplyFriendship(NPC npc, int points)
    {
        if (!this.config.ChatChangesFriendship || points == 0 || !this.activeLoad)
            return;
        int before = this.friendshipToday.GetValueOrDefault(npc.Name);
        int after = Math.Clamp(before + points, FriendshipDayMin, FriendshipDayMax);
        if (after == before)
            return;
        this.friendshipToday[npc.Name] = after;
        Game1.player.changeFriendship(after - before, npc);
        this.Monitor.Log($"和{npc.displayName}聊天，好感 {after - before:+#;-#}（今天合计 {after:+#;-#;0}）。", LogLevel.Info);
    }
}
