using System.Collections.Generic;
using StardewModdingAPI;
using StardewValley;
using StardewValley.GameData.Objects;

namespace StardewAgentBridge;

/// <summary>
/// A close NPC hands the player a card gift in an agent conversation (docs/npc-in-person-gifts.md, design §8
/// gift.give). The backend picks it and keeps the weekly cooldown; the Mod allows one a day per NPC and applies the
/// same price limit as letters. The item is game state, so it is saved or discarded with the game.
/// </summary>
internal sealed partial class ModEntry
{
    /// <summary>NPCs that already handed something over today.</summary>
    private readonly HashSet<string> presentsToday = new();

    private void ClearPresentsToday() => this.presentsToday.Clear();

    private void GivePresent(NPC npc, string name)
    {
        if (!this.config.InPersonGifts || !this.activeLoad || !this.presentsToday.Add(npc.Name))
            return;
        if (this.ObjectId(name) is not string id || !Game1.objectData.TryGetValue(id, out ObjectData? data) || data.Price > MaxGiftPrice)
        {
            this.Monitor.Log($"{npc.displayName}想当面送“{name}”，但游戏里找不到或原价超过 {MaxGiftPrice} 金，没有给。", LogLevel.Warn);
            return;
        }
        Item item = ItemRegistry.Create("(O)" + id);
        // A full inventory drops it at the player's feet, like vanilla gifts that do not fit.
        if (!Game1.player.addItemToInventoryBool(item))
            Game1.createItemDebris(item, Game1.player.getStandingPosition(), Game1.player.FacingDirection);
        Game1.addHUDMessage(HUDMessage.ForItemGained(item, 1));
        this.Monitor.Log($"{npc.displayName}当面送了“{item.DisplayName}”。", LogLevel.Info);
    }
}
