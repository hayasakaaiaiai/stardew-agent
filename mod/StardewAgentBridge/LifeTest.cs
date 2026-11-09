using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Menus;

namespace StardewAgentBridge;

/// <summary>Native inputs and observations, reachable only through the disposable-save WorldTest guard.</summary>
internal sealed partial class ModEntry
{
    private int lifeTestChoice;
    private string lifeTestChoiceText = "";
    private bool lifeTestChoiceClicked;
    private int lifeTestVanillaClicks;

    private static object? LifeTestField(object target, string name)
    {
        for (Type? type = target.GetType(); type is not null; type = type.BaseType)
        {
            const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly;
            if (type.GetField(name, flags) is FieldInfo field) return field.GetValue(target);
            if (type.GetProperty(name, flags) is PropertyInfo property) return property.GetValue(target);
        }
        return null;
    }

    private static object? LifeTestItem(Item? item)
        => item is null ? null : new { id = item.QualifiedItemId, count = item.Stack, name = item.Name };

    private static Response[] LifeTestResponses(DialogueBox box)
        => LifeTestField(box, "responses") is IEnumerable responses ? responses.Cast<object>().OfType<Response>().ToArray() : Array.Empty<Response>();

    private object LifeTestSnapshot() => new
    {
        supported = this.lifeSupported, ready = this.lifeReady, corrupt = this.lifeCorrupt,
        connected = this.bridge.IsConnected, canRecord = this.CanRecordLifeEvent,
        menuType = Game1.activeClickableMenu?.GetType().Name, windowMinimized = this.TestWindowMinimized(),
        sync = new { cursor = this.lifeSync.Cursor, batchEnd = this.lifeSync.BatchEnd, request = this.lifeSync.Request, lastRequest = this.lifeSync.LastRequest },
        serial = this.lifeSave.Serial, events = LifeEventWire.Encode(this.lifeEvents),
        goals = this.lifeSave.Goals.ToDictionary(pair => pair.Key, pair => new
        {
            stage = pair.Value.Stage, acceptedDay = pair.Value.AcceptedDay, deliveredDay = pair.Value.DeliveredDay,
            endedDay = pair.Value.EndedDay, attempt = pair.Value.Attempt,
        }),
        letters = this.lifeSave.Letters.Select(letter => new { key = letter.Key, npc = letter.Npc, text = letter.Text, dueDay = letter.DueDay, sent = letter.Sent }).ToArray(),
        mailbox = Game1.player.mailbox.ToArray(), received = Game1.player.mailReceived.ToArray(), mailDay = this.lifeSave.MailDay,
        starts = this.LifeActivityStartsToday, activityDay = this.lifeSave.ActivityDay,
        activity = this.lifeActivity is not { } activity ? null : new
        {
            npc = activity.Npc.Name, activity = activity.Activity, goal = activity.Goal, minutes = activity.Minutes,
            count = activity.Count, item = activity.Item, wholeInterval = activity.WholeInterval, lastTime = activity.LastTime,
            near = LifeNear(activity.Npc), eligible = this.LifeTimeEligible(activity),
            cookingMenu = activity.CookingMenu?.GetType().Name,
        },
        continuation = this.lifeContinuation?.Previous.Npc.Name,
        returns = this.lifeActivityReturns.Select(entry => new { npc = entry.Npc.Name, entry.Nonce, entry.Day, map = entry.Movement.Out.GoBack?.Map }).ToArray(),
        inventory = Game1.player.Items.Select((item, slot) => item is null ? null : new { slot, id = item.QualifiedItemId, count = item.Stack, name = item.Name }).Where(item => item is not null).ToArray(),
        heldItem = Game1.activeClickableMenu is CraftingPage cooking ? LifeTestItem(LifeTestField(cooking, "heldItem") as Item) : null,
        debris = Game1.currentLocation.debris.Where(debris => debris.item is not null).Select(debris => LifeTestItem(debris.item)).ToArray(),
        items = Game1.player.Items.Where(item => item is not null).GroupBy(item => item.QualifiedItemId).ToDictionary(group => group.Key, group => group.Sum(item => item.Stack)),
        friendship = SocialNpcs.Where(Game1.player.friendshipData.ContainsKey).ToDictionary(id => id, id => new
        {
            points = Game1.player.friendshipData[id].Points, giftsToday = Game1.player.friendshipData[id].GiftsToday,
            status = Game1.player.friendshipData[id].Status.ToString(), roommate = Game1.player.friendshipData[id].RoommateMarriage,
            budget = this.friendshipToday.GetValueOrDefault(id),
        }),
        entries = SocialNpcs.Select(id => Game1.getCharacterFromName(id)).OfType<NPC>().Where(LifeNear).ToDictionary(npc => npc.Name, npc => new
        {
            goal = this.HasLifeGoalEntry(npc), grievance = this.LifeGrievance(npc), share = this.ShareCandidate(npc)?.Listener.Name,
            hasSchedule = npc.Schedule is not null, npc.ignoreScheduleToday,
        }),
        menu = Game1.activeClickableMenu is not DialogueBox box ? null : new
        {
            text = box.getCurrentString(), question = box.isQuestion, transitioning = box.transitioning,
            speaker = box.characterDialogue?.speaker?.Name,
            owned = box.characterDialogue is Dialogue dialogue && this.ownDialogues.TryGetValue(dialogue, out _),
            choices = LifeTestResponses(box).Select(response => response.responseText).ToArray(),
        },
        stats = new { cooked = Game1.stats.ItemsCooked, foraged = Game1.stats.ItemsForaged },
        recipes = Game1.player.recipesCooked.Pairs.ToDictionary(pair => pair.Key, pair => pair.Value),
        saved = Game1.player.modData.GetValueOrDefault(LifeSaveKey),
    };

    private bool LifeTestCommand(string operation, JsonElement args)
    {
        if (!operation.StartsWith("life-", StringComparison.Ordinal)) return false;
        string Text(string key, string fallback = "") => args.TryGetProperty(key, out JsonElement value) ? value.GetString()! : fallback;
        int Number(string key, int fallback = 0) => args.TryGetProperty(key, out JsonElement value) ? value.GetInt32() : fallback;
        bool Flag(string key, bool fallback = false) => args.TryGetProperty(key, out JsonElement value) ? value.GetBoolean() : fallback;
        NPC npc = this.SocialActor(Text("npc", "Leah"));
        switch (operation)
        {
            case "life-snapshot": this.WorldComplete(); break;
            case "life-vanilla-open":
                if (this.talk is not null) throw new InvalidOperationException("Close the Agent conversation before opening vanilla dialogue.");
                this.CloseSocialMenu();
                Game1.drawDialogue(npc);
                this.worldTestNative = new { method = "Game1.drawDialogue", npc = npc.Name };
                this.WorldWait("life-ticks", 45); break;
            case "life-vanilla-finish":
                if (Game1.activeClickableMenu is not DialogueBox { characterDialogue: Dialogue nativeDialogue }
                    || this.ownDialogues.TryGetValue(nativeDialogue, out _) || this.talk is not null)
                    throw new InvalidOperationException("Expected an actual vanilla NPC dialogue before the offer transition.");
                this.lifeTestVanillaClicks = 0;
                this.WorldWait("life-vanilla-finish", 45); break;
            case "life-gift":
                this.CloseSocialMenu();
                Game1.player.CurrentToolIndex = Number("slot");
                if (Game1.player.ActiveObject is not StardewValley.Object gift)
                    throw new InvalidOperationException("The selected native inventory slot does not hold a gift.");
                int giftsBefore = Game1.player.friendshipData[npc.Name].GiftsToday;
                int stackBefore = gift.Stack;
                string giftId = gift.QualifiedItemId;
                bool received = npc.tryToReceiveActiveObject(Game1.player, false);
                this.worldTestNative = new
                {
                    method = "NPC.tryToReceiveActiveObject", received, id = giftId, stackBefore,
                    stackAfter = Game1.player.Items[Number("slot")]?.Stack ?? 0,
                    giftsBefore, giftsAfter = Game1.player.friendshipData[npc.Name].GiftsToday,
                };
                this.WorldWait("life-ticks", 45); break;
            case "life-setup":
                this.CloseSocialMenu();
                if (args.TryGetProperty("time", out _)) Game1.timeOfDay = Number("time");
                if (args.TryGetProperty("hearts", out _)) Game1.player.friendshipData[npc.Name] = new Friendship(Number("hearts", 8) * 250);
                if (!Game1.player.friendshipData.ContainsKey(npc.Name)) Game1.player.friendshipData[npc.Name] = new Friendship(2000);
                if (args.TryGetProperty("spouse", out _) || args.TryGetProperty("roommate", out _))
                {
                    bool married = Flag("spouse") || Flag("roommate");
                    Game1.player.spouse = married ? npc.Name : null;
                    Game1.player.friendshipData[npc.Name].Status = married ? FriendshipStatus.Married : FriendshipStatus.Friendly;
                    Game1.player.friendshipData[npc.Name].RoommateMarriage = Flag("roommate");
                }
                if (Flag("kitchen"))
                {
                    Game1.player.HouseUpgradeLevel = Math.Max(Game1.player.HouseUpgradeLevel, 1);
                    FarmHouse home = Utility.getHomeOfFarmer(Game1.player);
                    home.setMapForUpgradeLevel(Game1.player.HouseUpgradeLevel);
                    Game1.player.cookingRecipes["Fried Egg"] = 0;
                }
                if (Flag("clearItems")) for (int slot = 0; slot < Game1.player.Items.Count; slot++) Game1.player.Items[slot] = null;
                if (args.TryGetProperty("items", out JsonElement items))
                    foreach (JsonElement item in items.EnumerateArray())
                    {
                        int slot = item.GetProperty("slot").GetInt32();
                        Game1.player.Items[slot] = ItemRegistry.Create(item.GetProperty("id").GetString()!, item.GetProperty("count").GetInt32());
                    }
                if (args.TryGetProperty("map", out _))
                {
                    string map = Text("map"); int x = Number("x", 30), y = Number("y", 20);
                    this.TownPlace(npc.Name, map, x + 1, y); npc.temporaryController = null; npc.ignoreScheduleToday = Flag("ignore");
                    npc.queuedSchedulePaths.Clear();
                    Game1.warpFarmer(map, x, y, 2);
                }
                this.WorldWait("life-ticks", 45); break;
            case "life-menu":
                this.CloseSocialMenu();
                switch (Text("kind", "activity"))
                {
                    case "goal": this.ShowLifeGoal(npc); break;
                    case "activity": this.ShowLifeActivities(npc); break;
                    case "share": this.ShareLifeActivity(npc); break;
                    case "apology": this.ApologizeInPerson(npc); break;
                    case "dinner": this.ShowLifeDinner(npc); break;
                    default: throw new InvalidOperationException("Unknown life menu kind.");
                }
                this.WorldWait("life-ticks", 45); break;
            case "life-choose":
                this.lifeTestChoice = Number("index", -1); this.lifeTestChoiceText = Text("text"); this.lifeTestChoiceClicked = false;
                this.WorldWait("life-choice", 45); break;
            case "life-close":
                this.CloseSocialMenu(); this.WorldWait("life-ticks", 45); break;
            case "life-observe":
                this.actionTestClockRunning = Flag("clock");
                this.WorldWait("life-observe", Number("ticks", 60)); break;
            case "life-forage":
                this.CloseSocialMenu();
                GameLocation forageLocation = Game1.currentLocation;
                Vector2[] forageOffsets = { new(-1, 0), new(0, 1), new(0, -1), new(1, 0), new(-1, 1), new(1, 1), new(-1, -1), new(1, -1) };
                Vector2? forageTile = forageOffsets.Select(offset => Game1.player.Tile + offset).Cast<Vector2?>().FirstOrDefault(candidate =>
                {
                    Vector2 tile = candidate!.Value;
                    Rectangle bounds = new((int)tile.X * 64, (int)tile.Y * 64, 64, 64);
                    return forageLocation.CanItemBePlacedHere(tile) && !forageLocation.objects.ContainsKey(tile)
                        && !forageLocation.characters.Any(character => character.GetBoundingBox().Intersects(bounds));
                });
                if (forageTile is not Vector2 pickedTile) throw new InvalidOperationException("No adjacent clear tile for native forage pickup.");
                var forage = ItemRegistry.Create<StardewValley.Object>(Text("item", "(O)16"), Number("stack", 1));
                forage.IsSpawnedObject = true; forage.TileLocation = pickedTile;
                forageLocation.objects.Add(pickedTile, forage);
                uint forageBefore = Game1.stats.ItemsForaged;
                int inventoryBefore = Game1.player.Items.Where(item => item?.QualifiedItemId == forage.QualifiedItemId).Sum(item => item!.Stack);
                bool picked = forageLocation.checkAction(new xTile.Dimensions.Location((int)pickedTile.X, (int)pickedTile.Y), Game1.viewport, Game1.player);
                this.worldTestNative = new
                {
                    method = "GameLocation.checkAction on clear adjacent forage tile", picked, map = forageLocation.NameOrUniqueName,
                    x = pickedTile.X, y = pickedTile.Y, id = forage.QualifiedItemId,
                    before = forageBefore, after = Game1.stats.ItemsForaged, inventoryBefore,
                    inventoryAfter = Game1.player.Items.Where(item => item?.QualifiedItemId == forage.QualifiedItemId).Sum(item => item!.Stack),
                    remains = forageLocation.objects.ContainsKey(pickedTile), menu = Game1.activeClickableMenu?.GetType().Name,
                };
                this.WorldWait("life-ticks", 45); break;
            case "life-cook":
                if (Game1.activeClickableMenu is not CraftingPage page) throw new InvalidOperationException("Native kitchen is not open.");
                if (LifeTestField(page, "heldItem") is Item) throw new InvalidOperationException("Put down the previous held item before cooking another recipe.");
                if (LifeTestField(page, "pagesOfCraftingRecipes") is not IEnumerable pages) throw new InvalidOperationException("Native recipe pages unavailable.");
                ClickableTextureComponent? recipeButton = null;
                int recipePage = 0, foundPage = -1;
                foreach (object candidate in pages)
                {
                    if (candidate is IDictionary recipes)
                        foreach (DictionaryEntry entry in recipes)
                            if (entry.Value is CraftingRecipe recipe && recipe.name == Text("recipe", "Fried Egg") && entry.Key is ClickableTextureComponent button)
                            { recipeButton = button; foundPage = recipePage; }
                    recipePage++;
                }
                if (recipeButton is null) throw new InvalidOperationException("Requested native recipe not visible.");
                this.Helper.Reflection.GetField<int>(page, "currentCraftingPage").SetValue(foundPage);
                uint cookedBefore = Game1.stats.ItemsCooked;
                Dictionary<string, int> itemsBefore = Game1.player.Items.Where(item => item is not null).GroupBy(item => item.QualifiedItemId)
                    .ToDictionary(group => group.Key, group => group.Sum(item => item.Stack));
                page.receiveLeftClick(recipeButton.bounds.Center.X, recipeButton.bounds.Center.Y);
                Item? cookedItem = LifeTestField(page, "heldItem") as Item;
                object? heldBefore = LifeTestItem(cookedItem);
                string? cookedId = cookedItem?.QualifiedItemId;
                int? placedSlot = null;
                if (cookedItem is not null)
                {
                    if (LifeTestField(page, "inventory") is not InventoryMenu inventory) throw new InvalidOperationException("Native cooking inventory unavailable.");
                    int slot = Enumerable.Range(0, Math.Min(inventory.actualInventory.Count, inventory.inventory.Count))
                        .FirstOrDefault(index => inventory.actualInventory[index] is null, -1);
                    if (slot < 0) throw new InvalidOperationException("No empty native inventory slot for the cooked item.");
                    Rectangle bounds = inventory.inventory[slot].bounds;
                    // Put down the vanilla-created item with the same inventory click a player would use.
                    page.receiveLeftClick(bounds.Center.X, bounds.Center.Y);
                    placedSlot = slot;
                }
                this.worldTestNative = new
                {
                    method = "CraftingPage.receiveLeftClick recipe then native inventory slot", recipe = Text("recipe", "Fried Egg"),
                    before = cookedBefore, after = Game1.stats.ItemsCooked, heldBefore,
                    heldAfter = LifeTestItem(LifeTestField(page, "heldItem") as Item), placedSlot, cookedId,
                    productBefore = cookedId is null ? 0 : itemsBefore.GetValueOrDefault(cookedId),
                    productAfter = cookedId is null ? 0 : Game1.player.Items.Where(item => item?.QualifiedItemId == cookedId).Sum(item => item!.Stack),
                };
                this.WorldWait("life-ticks", 45); break;
            default: throw new InvalidOperationException("Unknown life test command: " + operation);
        }
        return true;
    }

    private void TickLifeTestPending()
    {
        if (this.worldTestPending == "life-vanilla-finish")
        {
            if (Game1.activeClickableMenu is DialogueBox { characterDialogue: Dialogue dialogue } box)
            {
                if (this.ownDialogues.TryGetValue(dialogue, out _) || this.talk is not null)
                    throw new InvalidOperationException("The vanilla transition unexpectedly entered Agent dialogue.");
                if (box.isQuestion) throw new InvalidOperationException("Refusing to choose an unrelated vanilla dialogue answer.");
                if (!box.transitioning)
                {
                    box.finishTyping(); box.receiveLeftClick(0, 0);
                    this.lifeTestVanillaClicks++;
                    this.worldTestWait = this.memoryTestTicks + 45;
                }
                return;
            }
            if (this.memoryTestTicks >= this.worldTestWait && this.offerFor is null)
            {
                this.worldTestNative = new { method = "DialogueBox.receiveLeftClick -> MenuChanged -> Offer", clicks = this.lifeTestVanillaClicks };
                this.WorldComplete();
            }
        }
        else if (this.worldTestPending == "life-choice")
        {
            if (!this.lifeTestChoiceClicked)
            {
                if (Game1.activeClickableMenu is not DialogueBox { transitioning: false } box) return;
                Response[] responses = LifeTestResponses(box);
                int index = this.lifeTestChoice >= 0 ? this.lifeTestChoice : Array.FindIndex(responses, response => response.responseText.Contains(this.lifeTestChoiceText, StringComparison.Ordinal));
                if (index < 0 || index >= responses.Length)
                    throw new InvalidOperationException("Native life choice unavailable: " + this.lifeTestChoiceText + "; choices=" + string.Join(" / ", responses.Select(response => response.responseText)));
                box.finishTyping(); box.selectedResponse = index; box.receiveLeftClick(0, 0);
                this.lifeTestChoiceClicked = true; this.worldTestWait = this.memoryTestTicks + 60;
                this.worldTestNative = new { method = "DialogueBox.receiveLeftClick", index, text = responses[index].responseText };
            }
            if (this.memoryTestTicks >= this.worldTestWait && this.lifeMenuNext is null && this.lifeMenuAction is null)
                this.WorldComplete();
        }
        else if (this.worldTestPending is "life-ticks" or "life-observe")
        {
            if (this.memoryTestTicks >= this.worldTestWait && !Game1.isWarping)
            {
                this.WorldComplete();
            }
        }
    }
}
