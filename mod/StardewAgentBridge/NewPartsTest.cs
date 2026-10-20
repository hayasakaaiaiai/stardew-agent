using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Characters;
using StardewValley.Locations;

namespace StardewAgentBridge;

/// <summary>Continues the same disposable-save run with the five newly fetched commits.</summary>
internal sealed partial class ModEntry
{
    private readonly List<object> newPartsChecks = new();
    private readonly List<object> newPartsDeliveries = new();
    private readonly List<object> newPartsWorlds = new();
    private bool newPartsRunning;
    private bool newPartsDirect;
    private int newPartsStep;
    private int newPartsPhase;
    private int newPartsReceipts;
    private int newPartsBefore;
    private string newPartsItem = "";
    private string newPartsItemName = "";
    private string newPartsLastItem = "";
    private string newPartsLastName = "";
    private string newPartsLiveItem = "";
    private int newPartsLiveBefore;
    private int newPartsCandidate;
    private Dictionary<string, int> newPartsInventory = new();
    private static readonly string[] NewPartsCandidates = { "Abigail", "Linus", "Gus" };
    private int NewPartsItemCount(string id) => Game1.player.Items.Where(item => item?.QualifiedItemId == id).Sum(item => item!.Stack);
    private Dictionary<string, int> NewPartsInventory() => Game1.player.Items.Where(item => item is not null)
        .GroupBy(item => item!.QualifiedItemId).ToDictionary(group => group.Key, group => group.Sum(item => item!.Stack));

    private void NewCheck(bool passed, string label, object? detail = null)
    {
        this.newPartsChecks.Add(new { label, passed, detail, day = this.currentDay, nonce = this.loadNonce, phase = this.newPartsPhase });
        if (!passed) throw new InvalidOperationException("新增功能检查失败：" + label);
        this.MemoryTestProgress("new-parts", "新增检查通过：" + label);
    }

    private void RecordNewPartsPresent(NPC npc, Item item, int before, int debrisBefore)
    {
        this.newPartsLastItem = item.QualifiedItemId; this.newPartsLastName = item.DisplayName;
        this.newPartsDeliveries.Add(new { npc = npc.Name, name = item.DisplayName, id = item.QualifiedItemId,
            quality = item.Quality, stack = item.Stack, before, after = this.NewPartsItemCount(item.QualifiedItemId),
            debrisBefore, debrisAfter = Game1.currentLocation.debris.Count, direct = this.newPartsDirect,
            nonce = this.loadNonce, day = this.currentDay });
    }

    private bool NewPartsGate(string name)
    {
        this.MemoryTestProgress("new-parts", name);
        string path = Path.Combine(this.memoryTest!.RunDirectory, "control.json");
        if (!File.Exists(path)) return false;
        using JsonDocument data = JsonDocument.Parse(File.ReadAllText(path));
        return data.RootElement.GetProperty("requestId").GetString() == this.memoryTest.RequestId
            && data.RootElement.GetProperty("stage").GetString() == name;
    }

    private void BeginNewPartsTest()
    {
        this.newPartsRunning = true;
        Game1.player.friendshipData["Leah"] = new Friendship(1750);
        this.newPartsStep = 0;
        this.MemoryTestProgress("new-parts", "开始新增提交的原生检查。");
    }

    private void ResumeNewPartsTest()
    {
        if (this.newPartsPhase == 1) Game1.player.friendshipData["Leah"] = new Friendship(1750);
        this.newPartsStep = this.newPartsPhase == 1 ? 20 : this.newPartsPhase == 2 ? 40 : 80;
        this.WarpForMemoryTest("new-parts");
    }

    private void NewPartsTalk(string id, int next)
    {
        this.CloseSocialMenu();
        NPC npc = Game1.getCharacterFromName(id);
        npc.controller = null; npc.ignoreScheduleToday = true;
        npc.isSleeping.Value = false; npc.IsInvisible = false;
        Game1.warpCharacter(npc, Game1.currentLocation, new Vector2(5, 8));
        npc.Halt(); Game1.player.Position = new Vector2(5 * 64, 9 * 64);
        if (!Game1.player.friendshipData.ContainsKey(id)) Game1.player.friendshipData[id] = new Friendship(1750);
        this.newPartsInventory = this.NewPartsInventory();
        this.newPartsReceipts = this.newPartsDeliveries.Count;
        this.StartTalk(npc); this.newPartsStep = next;
    }

    private void NewPartsLine(string line, string label, int next)
    {
        this.memoryTestLine = line; this.memoryTestLabel = label; this.memoryTestAfterReply = "new-parts";
        this.newPartsStep = next;
        this.MemoryTestProgress("input", "通过原版输入框检查新增功能。");
        this.ChooseMemoryTestResponse(this.talk!.Options.Count);
    }

    private void NewPartsSleep()
    {
        this.CheckMemoryTestSave(); this.memoryTestSleepDay = this.currentDay;
        FarmHouse home = Utility.getHomeOfFarmer(Game1.player); Point bed = home.getBedSpot();
        LocationRequest request = Game1.getLocationRequest(home.NameOrUniqueName);
        request.OnWarp += () => { this.MemoryTestProgress(this.newsTestRunning ? "news" : "new-parts", "通过原版睡觉保存验收结果。"); Game1.currentLocation.answerDialogueAction("Sleep_Yes", Array.Empty<string>()); };
        this.MemoryTestProgress("warping", "返回床边保存新增功能结果。");
        Game1.warpFarmer(request, bed.X, bed.Y, 2);
    }

    private void NewPartsNativeDefenses()
    {
        this.newPartsDirect = true;
        int before = this.NewPartsItemCount(this.newPartsItem);
        this.config.InPersonGifts = false;
        this.GivePresent(Game1.getCharacterFromName("Sam"), this.newPartsItemName);
        this.NewCheck(this.NewPartsItemCount(this.newPartsItem) == before && !this.presentsToday.Contains("Sam"), "present-disabled");
        this.config.InPersonGifts = true;
        int delivered = this.newPartsDeliveries.Count;
        this.GivePresent(Game1.getCharacterFromName("Robin"), "不存在的验收物品");
        this.GivePresent(Game1.getCharacterFromName("Clint"), "铱锭");
        this.NewCheck(this.newPartsDeliveries.Count == delivered, "present-unknown-and-overprice-rejected");
        List<Item?> original = Game1.player.Items.ToList();
        while (Game1.player.Items.Count < Game1.player.MaxItems) Game1.player.Items.Add(null);
        for (int i = 0; i < Game1.player.MaxItems; i++) Game1.player.Items[i] = ItemRegistry.Create("(O)390", 999);
        int debris = Game1.currentLocation.debris.Count;
        this.GivePresent(Game1.getCharacterFromName("Alex"), this.newPartsItemName);
        this.NewCheck(this.NewPartsItemCount(this.newPartsItem) == 0 && Game1.currentLocation.debris.Count == debris + 1,
            "present-full-inventory-native-debris");
        Game1.currentLocation.debris.RemoveAt(Game1.currentLocation.debris.Count - 1);
        for (int i = 0; i < Game1.player.Items.Count; i++) Game1.player.Items[i] = i < original.Count ? original[i] : null;
        this.newPartsDirect = false;

        // Force an ordinary gift-counter change to verify the guard even on a special vanilla path.
        if (!Game1.player.friendshipData.ContainsKey("Sam")) Game1.player.friendshipData["Sam"] = new Friendship(1000);
        Friendship sam = Game1.player.friendshipData["Sam"]; int saved = sam.GiftsToday;
        int seq = this.seq;
        foreach (string id in new[] { "(O)458", "(O)277", "(O)460", "(O)808", "(O)809" })
        {
            this.giftHeld = ItemRegistry.Create<StardewValley.Object>(id);
            this.giftCounts["Sam"] = sam.GiftsToday; sam.GiftsToday++;
            this.TickGifts();
            this.NewCheck(this.seq == seq, "special-item-not-ordinary-gift-" + id);
        }
        sam.GiftsToday = saved; this.giftHeld = null; this.ResetGifts();
    }

    private void NewPartsHousehold(string label, string? npc, FriendshipStatus status, bool roommate, int children)
    {
        foreach (var pair in Game1.player.friendshipData.Pairs)
        {
            pair.Value.Status = FriendshipStatus.Friendly; pair.Value.RoommateMarriage = false;
        }
        Game1.player.spouse = npc;
        if (npc is not null)
        {
            if (!Game1.player.friendshipData.ContainsKey(npc)) Game1.player.friendshipData[npc] = new Friendship(2500);
            Game1.player.friendshipData[npc].Status = status; Game1.player.friendshipData[npc].RoommateMarriage = roommate;
        }
        FarmHouse home = Utility.getHomeOfFarmer(Game1.player);
        foreach (Child child in home.characters.OfType<Child>().ToArray()) home.characters.Remove(child);
        for (int i = 0; i < children; i++) home.characters.Add(new Child("验收孩子" + i, true, false, Game1.player));
        Dictionary<string, object?> world = GameState.World();
        this.newPartsWorlds.Add(new { label, world });
        var flags = (Dictionary<string, object?>)world["flags"]!;
        var partner = flags["partner"] as Dictionary<string, object?>;
        string? expected = npc is null || status == FriendshipStatus.Dating ? null : roommate ? "roommate" : status == FriendshipStatus.Engaged ? "engaged" : "married";
        this.NewCheck((expected is null ? partner is null : (string?)partner?["status"] == expected && (string?)partner?["npc"] == npc)
            && (int)flags["children"]! == children, "public-facts-native-" + label, world);
    }

    private void TickNewPartsTest()
    {
        if (!Context.IsWorldReady || this.memoryTest is not { } test) return;
        switch (this.newPartsStep)
        {
            case 0:
                if (!this.NewPartsGate("new-parts-fixed-ready")) return;
                this.config.InPersonGifts = true;
                this.NewPartsTalk("Leah", 1); break;
            case 1:
                if (!this.MemoryTestHasReply()) return;
                this.NewCheck(this.newPartsDeliveries.Count == this.newPartsReceipts + 1, "present-native-delivery-on-opening");
                this.newPartsItem = this.newPartsLastItem; this.newPartsItemName = this.newPartsLastName;
                this.newPartsBefore = this.newPartsInventory.GetValueOrDefault(this.newPartsItem);
                this.NewCheck(this.NewPartsItemCount(this.newPartsItem) == this.newPartsBefore + 1, "present-duplicate-reply-does-not-duplicate-item");
                this.RequestBubbleCapture("newparts-present"); this.newPartsStep = 2; break;
            case 2:
                if (this.bubbleTestCapture is not null) return;
                this.NewPartsNativeDefenses(); this.newPartsStep = 3; this.CloseMemoryTestTalk("new-parts"); break;
            case 3:
                this.NewPartsTalk("Leah", 4); break;
            case 4:
                if (!this.MemoryTestHasReply()) return;
                this.NewCheck(this.newPartsDeliveries.Count == this.newPartsReceipts, "present-no-second-opening-gift");
                this.newPartsStep = 5; this.CloseMemoryTestTalk("new-parts"); break;
            case 5:
                this.newPartsPhase = 1; this.ReturnSocialTest(); break;
            case 20:
                this.NewCheck(this.NewPartsItemCount(this.newPartsItem) == this.newPartsBefore && this.presentsToday.Count == 0, "present-unsaved-item-rollback");
                this.NewPartsTalk("Leah", 21); break;
            case 21:
                if (!this.MemoryTestHasReply()) return;
                this.NewCheck(this.newPartsDeliveries.Count == this.newPartsReceipts + 1 && this.NewPartsItemCount(this.newPartsItem) == this.newPartsBefore + 1,
                    "present-rollback-allows-offer-again");
                this.newPartsStep = 22; this.CloseMemoryTestTalk("new-parts"); break;
            case 22:
                this.newPartsStep = 23; this.NewPartsSleep(); break;
            case 23:
                if (!this.CanChat || Game1.activeClickableMenu is not null || Game1.newDay || this.currentDay != this.memoryTestSleepDay + 1
                    || this.savedCommit?.DayEnded != this.memoryTestSleepDay) return;
                this.newPartsPhase = 2; this.ReturnSocialTest(); break;
            case 40:
                this.NewCheck(this.NewPartsItemCount(this.newPartsItem) == this.newPartsBefore + 1, "present-real-save-reload-persists");
                this.NewPartsTalk("Leah", 41); break;
            case 41:
                if (!this.MemoryTestHasReply()) return;
                this.NewCheck(this.newPartsDeliveries.Count == this.newPartsReceipts, "present-next-day-weekly-cooldown");
                this.newPartsStep = 42; this.CloseMemoryTestTalk("new-parts"); break;
            case 42:
                this.NewPartsHousehold("single", null, FriendshipStatus.Friendly, false, 0);
                this.NewPartsHousehold("dating-private", "Abigail", FriendshipStatus.Dating, false, 0);
                this.NewPartsHousehold("engaged", "Abigail", FriendshipStatus.Engaged, false, 0);
                this.NewPartsHousehold("roommate", "Krobus", FriendshipStatus.Married, true, 0);
                this.NewPartsHousehold("married-child", "Abigail", FriendshipStatus.Married, false, 1);
                this.newPartsStep = 43; break;
            case 43:
                if (test.Offline) { this.newPartsStep = 60; break; }
                if (!this.NewPartsGate("new-parts-real-ready")) return;
                this.newPartsCandidate = 0; this.newPartsStep = 44; break;
            case 44:
                string who = NewPartsCandidates[this.newPartsCandidate];
                if (who != "Abigail") Game1.player.friendshipData[who] = new Friendship(1750);
                this.NewPartsTalk(who, 45); break;
            case 45:
                if (!this.MemoryTestHasReply()) return;
                if (this.newPartsDeliveries.Count == this.newPartsReceipts)
                {
                    this.NewCheck(true, "present-real-model-declined-" + NewPartsCandidates[this.newPartsCandidate], this.talk!.Reply);
                    if (++this.newPartsCandidate >= NewPartsCandidates.Length) throw new InvalidOperationException("三位 NPC 真实开场均未送出，当面送礼未取得真实样本。");
                    this.newPartsStep = 44; this.CloseMemoryTestTalk("new-parts"); break;
                }
                this.newPartsLiveItem = this.newPartsLastItem; this.newPartsLiveBefore = this.newPartsInventory.GetValueOrDefault(this.newPartsLiveItem);
                this.NewCheck(this.NewPartsItemCount(this.newPartsLiveItem) == this.newPartsLiveBefore + 1, "present-real-model-native-item", this.talk!.Reply);
                this.newPartsStep = 46; this.CloseMemoryTestTalk("new-parts"); break;
            case 46:
                Game1.player.friendshipData["Pierre"] = new Friendship(1000);
                this.NewPartsTalk("Pierre", 47); break;
            case 47:
                if (!this.MemoryTestHasReply()) return;
                this.NewPartsLine("阿比盖尔最近还好吗？她现在住在哪里？", "real-public-facts-pierre", 48); break;
            case 48:
                string text = this.talk!.Reply;
                this.NewCheck(text.Contains("农场") || text.Contains("嫁") || text.Contains("结婚") || text.Contains("孩子"), "public-facts-real-pierre", text);
                this.newPartsStep = 60; this.CloseMemoryTestTalk("new-parts"); break;
            case 60:
                this.newPartsPhase = 3; this.ReturnSocialTest(); break;
            case 80:
                if (this.newPartsLiveItem.Length > 0) this.NewCheck(this.NewPartsItemCount(this.newPartsLiveItem) == this.newPartsLiveBefore, "present-real-unsaved-rollback");
                var restored = (Dictionary<string, object?>)GameState.World()["flags"]!;
                this.NewCheck(restored["partner"] is null && (int)restored["children"]! == 0, "public-facts-unsaved-fixture-rollback", restored);
                this.BeginNewsTest(); break;
        }
    }
}
