using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Menus;

namespace StardewAgentBridge;

/// <summary>Explicit disposable-save checks of native mail and attachments.</summary>
internal sealed partial class ModEntry
{
    private readonly List<object> letterTestChecks = new();
    private readonly List<object> letterTestPackets = new();
    private int letterTestPhase;
    private int letterTestStep;
    private int letterTestInventory;
    private string letterTestKey = "";
    private string letterTestNonce = "";
    private JsonElement letterTestPacket;
    private string[] letterTestLoadedKeys = Array.Empty<string>();
    private int LetterTestItems() => Game1.player.Items.Where(item => item?.QualifiedItemId == "(O)767").Sum(item => item!.Stack);

    private void RecordLetterTestLoad()
    {
        if (this.memoryTest is not null) this.letterTestLoadedKeys = this.letters.Keys.ToArray();
    }

    private void RecordLetterTestPacket(JsonElement list)
    {
        if (this.memoryTest is null) return;
        this.letterTestPackets.Add(new { nonce = this.loadNonce, day = this.currentDay, letters = list.Clone(),
            stored = new Dictionary<string, string>(this.letters) });
        this.MemoryTestProgress(this.memoryTestStage, "收到当前读档的来信数据。");
    }

    private void LetterCheck(bool passed, string label, object? detail = null)
    {
        this.letterTestChecks.Add(new { label, passed, detail, nonce = this.loadNonce, day = this.currentDay,
            inventory = this.LetterTestItems(), mailbox = Game1.player.mailbox.Where(key => key.StartsWith("StardewAgent.")).ToArray(),
            received = Game1.player.mailReceived.Where(key => key.StartsWith("StardewAgent.")).ToArray(), stored = this.letters.Keys.ToArray() });
        if (!passed) throw new InvalidOperationException("信件检查失败：" + label);
        this.MemoryTestProgress("mail-only", "信件检查通过：" + label);
    }

    private void BeginLetterTest()
    {
        this.CheckMemoryTestSave();
        if (this.letterTestKey.Length == 0)
        {
            using JsonDocument fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(this.memoryTest!.RunDirectory, "fixture-letter.json")));
            this.letterTestKey = fixture.RootElement.GetProperty("key").GetString()!;
            this.letterTestPacket = JsonSerializer.SerializeToElement(new[] { fixture.RootElement.Clone() });
        }
        if (!this.bubbleTestRenderHook)
        {
            this.Helper.Events.Display.Rendered += (_, _) => this.CaptureBubbleTest();
            this.bubbleTestRenderHook = true;
        }
        this.letterTestStep = 0;
        this.MemoryTestProgress("mail-only", "开始原生信箱、附件和保存检查。");
    }

    private void RepeatLetterPacket(string? nonce = null)
    {
        using JsonDocument packet = JsonDocument.Parse(JsonSerializer.Serialize(new { lineageId = this.lineageId,
            loadNonce = nonce ?? this.loadNonce, letters = this.letterTestPacket }));
        this.HandleLetters("day.letters", packet.RootElement);
    }

    private void OpenLetterTestMail()
    {
        Game1.player.mailbox.Remove(this.letterTestKey);
        Game1.player.mailbox.Insert(0, this.letterTestKey);
        Game1.currentLocation.mailbox();
        this.LetterCheck(Game1.activeClickableMenu is LetterViewerMenu, "native-mailbox-opens-" + this.letterTestPhase);
        LetterViewerMenu menu = (LetterViewerMenu)Game1.activeClickableMenu;
        this.LetterCheck(menu.itemsToGrab.Count == 1 && menu.itemsToGrab[0].item is StardewValley.Object { Quality: 0, Stack: 1 } item
            && item.QualifiedItemId == "(O)767", "one-normal-quality-card-item-" + this.letterTestPhase);
        this.LetterCheck(string.Join("", menu.mailMessage).Contains("阿比盖尔"), "localized-signature-" + this.letterTestPhase);
        this.RequestBubbleCapture(this.letterTestPhase == 0 ? "mail-with-gift" : "mail-after-rollback");
        this.letterTestStep = 1;
    }

    private void TickLetterTest()
    {
        if (this.memoryTest is not { } test) return;
        if (this.letterTestStep == 0)
        {
            if (!this.letters.ContainsKey(this.letterTestKey)) return;
            if (this.letterTestPhase == 2)
            {
                this.LetterCheck(this.LetterTestItems() == this.letterTestInventory + 1, "claimed-item-persists-after-save");
                this.LetterCheck(Game1.player.mailReceived.Contains(this.letterTestKey) && !Game1.player.mailbox.Contains(this.letterTestKey), "read-letter-not-redelivered");
                string saved = this.Helper.Data.ReadSaveData<Dictionary<string, string>>(LettersSaveKey)![this.letterTestKey];
                this.LetterCheck(saved == this.letters[this.letterTestKey] && DataLoader.Mail(Game1.content)[this.letterTestKey] == saved, "body-persists-and-reloads-asset");
                CollectionsPage archive = new(80, 32, 1120, 640) { currentTab = 7 };
                int page = archive.collections[7].FindIndex(entries => entries.Any(entry => entry.name.StartsWith(this.letterTestKey + " ")));
                this.LetterCheck(page >= 0, "letter-listed-in-native-collection");
                archive.currentPage = page;
                var entry = archive.collections[7][page].First(item => item.name.StartsWith(this.letterTestKey + " "));
                this.LetterCheck(entry.name.Contains("阿比盖尔"), "collection-title-resolves", entry.name);
                Game1.activeClickableMenu = archive;
                Point position = entry.bounds.Center;
                archive.receiveLeftClick(position.X, position.Y);
                LetterViewerMenu collection = archive.letterviewerSubMenu ?? throw new InvalidOperationException("收藏页点击未打开信件。");
                this.LetterCheck(collection.mailTitle == this.letterTestKey, "native-collection-click-reopens-letter");
                this.LetterCheck(collection.itemsToGrab.Count == 0 && collection.moneyIncluded == 0
                    && this.LetterTestItems() == this.letterTestInventory + 1, "collection-reopen-cannot-claim-again");
                this.RequestBubbleCapture("mail-collection");
                this.letterTestStep = 2;
                return;
            }
            if (this.letterTestPhase == 0)
            {
                this.letterTestInventory = this.LetterTestItems();
                this.letterTestNonce = this.loadNonce;
                string[] catalog = JsonSerializer.Deserialize<string[]>(File.ReadAllText(Path.Combine(test.RunDirectory, "gift-catalog.json")))!;
                int accepted = 0, capped = 0;
                foreach (string name in catalog)
                {
                    string? attachment = this.Attachment(name, out string refusal);
                    if (attachment is not null) accepted++;
                    else if (refusal.Contains("上限") || refusal.Contains("原价")) capped++;
                    else throw new InvalidOperationException("游戏不能识别角色卡物品：" + name);
                }
                this.LetterCheck(accepted + capped == catalog.Length, "card-gift-catalog-resolves", new { count = catalog.Length, accepted, capped });
                this.LetterCheck(this.Attachment("500 金", out _) == "money 500" && this.Attachment("501 金", out _) is null
                    && this.Attachment("铱锭", out _) is null && this.Attachment("不存在的测试物品", out _) is null, "money-and-object-price-caps");
                int count = this.letters.Count;
                this.RepeatLetterPacket("stale-load");
                this.config.SendLetters = false;
                this.RepeatLetterPacket();
                this.config.SendLetters = true;
                this.RepeatLetterPacket();
                this.LetterCheck(this.letters.Count == count && Game1.player.mailbox.Count(key => key == this.letterTestKey) == 1, "duplicates-disabled-and-stale-do-not-add-mail");
            }
            else
            {
                this.LetterCheck(this.loadNonce != this.letterTestNonce && this.LetterTestItems() == this.letterTestInventory, "unsaved-item-rolled-back");
                this.LetterCheck(!Game1.player.mailReceived.Contains(this.letterTestKey)
                    && Game1.player.mailbox.Count(key => key == this.letterTestKey) == 1, "unread-letter-reappears-after-rollback");
                this.LetterCheck(!this.letterTestLoadedKeys.Contains(this.letterTestKey), "unsaved-body-not-persisted");
            }
            this.OpenLetterTestMail();
            return;
        }
        if (this.bubbleTestCapture is not null) return;
        if (this.letterTestStep == 2)
        {
            Game1.exitActiveMenu(); Game1.dialogueUp = false; Game1.player.CanMove = true;
            this.MemoryTestProgress("return-finish", "信箱和附件验收完成，返回标题页。");
            return;
        }
        LetterViewerMenu read = (LetterViewerMenu)Game1.activeClickableMenu;
        read.scale = 1;
        read.page = read.mailMessage.Count - 1;
        Point target = read.itemsToGrab[0].bounds.Center;
        read.receiveLeftClick(target.X, target.Y);
        this.LetterCheck(this.LetterTestItems() == this.letterTestInventory + 1, "native-click-claims-exactly-one-" + this.letterTestPhase);
        this.RepeatLetterPacket();
        this.LetterCheck(Game1.player.mailReceived.Contains(this.letterTestKey) && !Game1.player.mailbox.Contains(this.letterTestKey), "read-duplicate-not-redelivered-" + this.letterTestPhase);
        Game1.exitActiveMenu(); Game1.dialogueUp = false; Game1.player.CanMove = true;
        if (this.letterTestPhase++ == 0)
        {
            Game1.ExitToTitle();
            this.MemoryTestProgress("mail-title", "不保存退出，验证来信和附件回滚。");
        }
        else
        {
            FarmHouse home = Utility.getHomeOfFarmer(Game1.player);
            Point bed = home.getBedSpot();
            this.memoryTestSleepDay = this.currentDay;
            LocationRequest request = Game1.getLocationRequest(home.NameOrUniqueName);
            request.OnWarp += () =>
            {
                this.MemoryTestProgress("mail-sleep-wait", "通过原版睡觉保存已读信和领取物品。");
                Game1.currentLocation.answerDialogueAction("Sleep_Yes", Array.Empty<string>());
            };
            this.MemoryTestProgress("warping", "返回副本的床边。");
            Game1.warpFarmer(request, bed.X, bed.Y, 2);
        }
    }
}
