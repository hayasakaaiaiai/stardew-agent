using System.Collections.Generic;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>
/// Gifts the player gives, so the NPC remembers them (docs/npc-gifts.md). Found by watching the vanilla gift
/// counters instead of patching the game: when one goes up, the item held a tick earlier was the gift. Quest
/// deliveries and festival gifts leave the counters alone, so they are not reported.
/// </summary>
internal sealed partial class ModEntry
{
    /// <summary>
    /// Bouquets, the mermaid's pendant, the void ghost pendant and movie tickets start dating, an engagement, a
    /// roommate or a movie through their own vanilla paths; they are never remembered as an ordinary gift.
    /// </summary>
    private static readonly HashSet<string> NotGifts = new() { "(O)458", "(O)277", "(O)460", "(O)808", "(O)809" };

    /// <summary>NPC name → gifts given today, as last seen.</summary>
    private readonly Dictionary<string, int> giftCounts = new();
    private Object? giftHeld;

    private void ResetGifts()
    {
        this.giftCounts.Clear();
        this.giftHeld = null;
        if (!Context.IsWorldReady)
            return;
        foreach (KeyValuePair<string, Friendship> pair in Game1.player.friendshipData.Pairs)
            this.giftCounts[pair.Key] = pair.Value.GiftsToday;
    }

    private void TickGifts()
    {
        if (!Context.IsWorldReady)
            return;
        Object? held = this.giftHeld;
        this.giftHeld = Game1.player.ActiveObject;
        foreach (KeyValuePair<string, Friendship> pair in Game1.player.friendshipData.Pairs)
        {
            int count = pair.Value.GiftsToday;
            int before = this.giftCounts.GetValueOrDefault(pair.Key);
            if (count == before)
                continue;
            this.giftCounts[pair.Key] = count;
            if (count < before || held is null || NotGifts.Contains(held.QualifiedItemId) || !SocialNpcs.Contains(pair.Key) || !this.activeLoad || this.syncFailed
                || Game1.getCharacterFromName(pair.Key) is not NPC npc)
                continue;
            string taste = GiftTaste(npc.getGiftTasteForThisItem(held));
            bool birthday = npc.isBirthday();
            this.Send("gift.given", new()
            {
                ["npc"] = npc.Name, ["item"] = held.DisplayName, ["taste"] = taste, ["birthday"] = birthday, ["date"] = GameState.Date(),
            });
            this.Monitor.Log($"{npc.displayName}收到礼物“{held.DisplayName}”（{taste}{(birthday ? "，生日" : "")}），已交给后端记住。", LogLevel.Trace);
            this.OutingGift(npc, taste);
        }
    }

    private static string GiftTaste(int taste) => taste switch
    {
        NPC.gift_taste_love or NPC.gift_taste_stardroptea => "love",
        NPC.gift_taste_like => "like",
        NPC.gift_taste_dislike => "dislike",
        NPC.gift_taste_hate => "hate",
        _ => "neutral",
    };
}
