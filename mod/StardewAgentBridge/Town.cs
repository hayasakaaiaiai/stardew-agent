using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>
/// Who spends each in-game hour together away from the player, so the backend can pass news between them in code
/// (docs/offscreen-news.md). Indoors the whole location counts as together; outdoors, NPCs within a few tiles of
/// each other. The player's own location is left to the scenes they can see (docs/npc-chat.md).
/// </summary>
internal sealed partial class ModEntry
{
    private const float TownTogetherTiles = 6;

    /// <summary>The latest hour not yet sent; a newer hour replaces it.</summary>
    private List<List<string>>? townPending;

    private void ClearTown() => this.townPending = null;

    private void OnTimeChanged()
    {
        if (!this.config.OffscreenNews || !this.activeLoad || this.initialSave is null || Game1.timeOfDay % 100 != 0
            || (this.memoryTest is not null && !this.townTestRunning) || this.abigailTestRequest is not null)
            return;
        List<List<string>> groups = new();
        foreach (GameLocation location in Game1.locations)
        {
            if (location == Game1.currentLocation)
                continue;
            List<NPC> here = location.characters.Where(npc => SocialNpcs.Contains(npc.Name) && !npc.IsInvisible).ToList();
            if (here.Count < 2)
                continue;
            if (!location.IsOutdoors)
            {
                groups.Add(here.Select(npc => npc.Name).ToList());
                continue;
            }
            // Outdoors, join everyone within reach of someone already in the group.
            while (here.Count > 0)
            {
                List<NPC> group = new() { here[0] };
                here.RemoveAt(0);
                for (int i = 0; i < group.Count; i++)
                {
                    List<NPC> near = here.Where(npc => Vector2.Distance(npc.Tile, group[i].Tile) <= TownTogetherTiles).ToList();
                    group.AddRange(near);
                    here.RemoveAll(near.Contains);
                }
                if (group.Count >= 2)
                    groups.Add(group.Select(npc => npc.Name).ToList());
            }
        }
        this.townPending = groups.Count > 0 ? groups : null;
    }

    /// <summary>
    /// Not during an agent conversation: the backend writes a turn under its earlier seq when the reply arrives, and
    /// the day's events must stay in order.
    /// </summary>
    private void TickTown()
    {
        if (this.townPending is null || this.talk is not null || this.initialSave is null || !this.activeLoad)
            return;
        this.Send("town.hour", new() { ["groups"] = this.townPending, ["date"] = GameState.Date() });
        this.townPending = null;
    }
}
