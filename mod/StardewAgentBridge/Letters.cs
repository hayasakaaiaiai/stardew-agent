using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.GameData.Objects;

namespace StardewAgentBridge;

/// <summary>
/// Letters NPCs write at night (docs/npc-mail.md). The mailbox and the received list are saved by the game; the
/// letter texts are kept in this Mod's save data, which is also written only when the game saves, so a load
/// without saving drops both together.
/// </summary>
internal sealed partial class ModEntry
{
    private const string LettersSaveKey = "letters";
    private const string MailAsset = "Data/mail";
    /// <summary>Nothing worth more than this is enclosed, in sale price or in money (docs/npc-mail.md §8).</summary>
    private const int MaxGiftPrice = 500;

    /// <summary>Mail key → the letter in the game's mail format, so received letters can be read again.</summary>
    private Dictionary<string, string> letters = new();

    /// <summary>Display name in the current language → object id, built on first use.</summary>
    private Dictionary<string, string>? objectIds;

    private void LoadLetters()
    {
        this.letters = this.activeLoad ? this.Helper.Data.ReadSaveData<Dictionary<string, string>>(LettersSaveKey) ?? new() : new();
        this.RecordLetterTestLoad();
        this.objectIds = null;
        this.Helper.GameContent.InvalidateCache(MailAsset);
    }

    private void OnAssetRequested(object? sender, AssetRequestedEventArgs e)
    {
        if (!e.NameWithoutLocale.IsEquivalentTo(MailAsset) || this.letters.Count == 0)
            return;
        e.Edit(asset =>
        {
            IDictionary<string, string> data = asset.AsDictionary<string, string>().Data;
            foreach ((string key, string text) in this.letters)
                data[key] = text;
        });
    }

    /// <summary>Puts this morning's letter in the mailbox unless it is already there or was read before.</summary>
    private bool HandleLetters(string type, JsonElement message)
    {
        if (type != "day.letters")
            return false;
        if (!this.config.SendLetters || !this.activeLoad || !this.IsCurrentMessage(message)
            || !message.TryGetProperty("letters", out JsonElement list) || list.ValueKind != JsonValueKind.Array)
            return true;
        foreach (JsonElement letter in list.EnumerateArray())
        {
            if (letter.ValueKind != JsonValueKind.Object)
                continue;
            string key = letter.TryGetProperty("key", out JsonElement k) && k.ValueKind == JsonValueKind.String ? k.GetString() ?? "" : "";
            string npcId = letter.TryGetProperty("npc", out JsonElement n) && n.ValueKind == JsonValueKind.String ? n.GetString() ?? "" : "";
            string text = letter.TryGetProperty("text", out JsonElement t) && t.ValueKind == JsonValueKind.String ? VanillaDialogue.Escape(t.GetString() ?? "").Trim() : "";
            string item = letter.TryGetProperty("item", out JsonElement i) && i.ValueKind == JsonValueKind.String ? i.GetString() ?? "" : "";
            string? npcName = SocialNpcs.FirstOrDefault(name => name.Equals(npcId, StringComparison.OrdinalIgnoreCase));
            if (npcName is null)
                continue;
            if (!key.StartsWith("StardewAgent.") || text.Length == 0 || this.letters.ContainsKey(key)
                || Game1.player.mailbox.Contains(key) || Game1.player.mailReceived.Contains(key))
                continue;
            string from = Game1.getCharacterFromName(npcName)?.displayName ?? npcName;
            string refusal = "";
            string? attachment = item.Length > 0 ? this.Attachment(item, out refusal) : null;
            if (item.Length > 0 && attachment is null)
                this.Monitor.Log($"{from}想随信附上“{item}”，但{refusal}，信照常寄出、不附东西。", LogLevel.Warn);
            // The vanilla attachment: the item or money is added when the player reads the letter.
            this.letters[key] = $"{text}^^   -{from}" + (attachment is null ? "" : $"%item {attachment} %%") + $"[#]{from}的来信";
            this.Helper.Data.WriteSaveData(LettersSaveKey, this.letters);
            this.Helper.GameContent.InvalidateCache(MailAsset);
            Game1.player.mailbox.Add(key);
            this.Monitor.Log($"{from}寄来一封信{(attachment is null ? "" : $"，附带“{item}”")}。", LogLevel.Info);
        }
        this.RecordLetterTestPacket(list);
        return true;
    }

    /// <summary>
    /// The mail attachment for a card gift: “500 金” is money, anything else one object by its display name. Mail
    /// attachments carry no quality, so nothing arrives with a gold or iridium star; expensive things are refused.
    /// </summary>
    private string? Attachment(string name, out string refusal)
    {
        refusal = "";
        Match money = Regex.Match(name, @"^(\d{1,5})\s*金$");
        if (money.Success)
        {
            int amount = int.Parse(money.Groups[1].Value);
            refusal = $"超过 {MaxGiftPrice} 金的上限";
            return amount <= MaxGiftPrice ? $"money {amount}" : null;
        }
        if (this.ObjectId(name) is not string id)
        {
            refusal = "游戏里找不到这个物品";
            return null;
        }
        refusal = $"它的原价超过 {MaxGiftPrice} 金";
        return Game1.objectData.TryGetValue(id, out ObjectData? data) && data.Price <= MaxGiftPrice ? $"object {id} 1" : null;
    }

    private string? ObjectId(string name)
    {
        if (this.objectIds is null)
        {
            this.objectIds = new();
            foreach (string id in Game1.objectData.Keys)
                this.objectIds.TryAdd(ItemRegistry.GetDataOrErrorItem("(O)" + id).DisplayName, id);
        }
        return this.objectIds.TryGetValue(name, out string? found) ? found : null;
    }
}
