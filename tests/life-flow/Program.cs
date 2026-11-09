using StardewAgentBridge;

int checks = 0;
void Check(bool condition, string name) { if (!condition) throw new Exception(name); checks++; }
void Throws(Action action, string name) { try { action(); } catch (InvalidOperationException) { checks++; return; } throw new Exception(name); }

Check(LifeGoalRules.CanAccept(null), "A new branch can accept a goal.");
foreach (string stage in new[] { "collecting", "ready", "walking", "completed", "closed" })
    Check(!LifeGoalRules.CanAccept(stage), "An existing goal cannot be accepted twice: " + stage);
Check(!LifeGoalRules.CanDeliver("collecting", 2, 3), "Insufficient inventory stays untouched.");
Check(LifeGoalRules.CanDeliver("collecting", 3, 3), "Exact inventory allows delivery.");
Check(!LifeGoalRules.CanDeliver("ready", 99, 3), "A repeated delivery is rejected even with extra items.");
Check(LifeGoalRules.DeliveryPlan(new[] { 2, 1, 10 }, 3)!.SequenceEqual(new[] { 2, 1, 0 }), "Three materials are taken across stacks, and later stacks remain untouched.");
Check(LifeGoalRules.DeliveryPlan(new[] { 2 }, 3) is null, "Partial delivery has no mutation plan.");
Check(LifeGoalRules.DeliveryPlan(new[] { 0, 5 }, 3)!.SequenceEqual(new[] { 0, 3 }), "Empty slots do not change the quantity.");
Check(LifeGoalRules.DeliveryPlan(new[] { -1, 10 }, 3) is null, "Corrupt stacks are rejected.");
Check(!LifeGoalRules.CurrentMenu("old", "new", 12, 12), "Old-load menu callbacks cannot consume inventory.");
Check(!LifeGoalRules.CurrentMenu("same", "same", 12, 13), "Previous-day menu callbacks cannot consume inventory.");
Check(LifeGoalRules.CanClose("ready") && !LifeGoalRules.CanClose("completed"), "A paid goal may close once without recreating its reward.");
Check(LifeGoalRules.EndAttempt("walking", "g", "b", "g@a", true, 90, 30, 0, false) is null, "An old attempt cannot complete a new attempt.");
Check(LifeGoalRules.EndAttempt("walking", "g", "b", "other@b", true, 90, 30, 0, false) is null, "An unrelated walk cannot complete this story.");
Check(LifeGoalRules.EndAttempt("walking", "g", "b", "g@b", false, 10, 30, 0, false) == "ready", "Cancellation preserves paid materials for retry.");
Check(LifeGoalRules.EndAttempt("walking", "g", "b", "g@b", true, 29, 30, 0, false) == "ready", "A short walk is not complete.");
Check(LifeGoalRules.EndAttempt("walking", "g", "b", "g@b", true, 30, 30, 0, false) == "completed", "An observed complete walk may finish.");
Check(LifeGoalRules.EndAttempt("walking", "g", "b", "g@b", true, 20, 20, 0, true) == "ready", "Fishing time without a catch is not complete.");
Check(LifeGoalRules.EndAttempt("walking", "g", "b", "g@b", true, 20, 20, 1, true) == "completed", "A fishing attempt requires both time and a catch.");
Check(LifeGoalRules.OrderedEventIds(new[] { "life-1", "life-2", "life-7" }, 7), "A saved journal can replay an ordered sparse sequence.");
Check(!LifeGoalRules.OrderedEventIds(new[] { "life-2", "life-1" }, 2), "Out-of-order saved evidence is not replayed.");
Check(!LifeGoalRules.OrderedEventIds(new[] { "life-1", "life-1" }, 1), "Duplicate saved IDs are rejected.");
Check(!LifeGoalRules.OrderedEventIds(new[] { "life-3" }, 2), "The saved serial cannot trail the journal.");
Check(!LifeGoalRules.OrderedEventIds(new[] { "life-01" }, 1), "Noncanonical serial IDs are rejected.");

LifeSyncCursor replay = new();
Check(replay.Next(65) == (0, 32, false), "Replay starts with a bounded batch.");
replay.Sent(32, 1);
Throws(() => replay.Next(65), "Unacknowledged batches cannot be advanced.");
Check(!replay.Acknowledge(999) && replay.Cursor == 0, "Unrelated ACKs do not advance replay.");
Check(replay.Acknowledge(1) && replay.Next(65) == (32, 32, false), "ACK advances exactly one batch.");
replay.Sent(32, 2); replay.Acknowledge(2);
Check(replay.Next(65) == (64, 1, true), "The last batch contains the exact remainder.");
replay.Sent(1, 3);
Check(!replay.Complete(1, 65), "A stale ready cannot unlock a later batch.");
Check(replay.Complete(3, 65) && replay.Request == 3, "Early final-ready still leaves an outstanding ACK barrier.");
replay.Acknowledge(3);
Check(replay.Ready && replay.Cursor == 65 && replay.Request == 0, "Final ready and ACK complete replay.");
replay.Reset();
Check(!replay.Ready && replay.Next(65) == (0, 32, false), "Reconnect resets the barrier and replays saved facts from the beginning.");
replay.Sent(32, 10); replay.Acknowledge(10);
replay.Sent(32, 11); replay.Acknowledge(11);
replay.Sent(1, 12);
Check(!replay.Complete(12, 66), "An event appended during the final flight keeps conversation blocked.");
replay.Acknowledge(12);
Check(replay.Next(66) == (65, 1, true), "The newly appended fact is sent next, without losing history.");
replay.Reset();
Check(replay.Next(0) == (0, 0, true), "Empty saves still perform a final capability barrier.");
replay.Sent(0, 20); replay.Acknowledge(20);
Check(replay.Complete(20, 0), "An empty journal unlocks only after matching ready.");
var wire = LifeEventWire.Encode(new[] { new LifeEvent { Id = "life-1", Npc = "leah", Day = 1, Kind = "goal.accepted", Goal = "leah-driftwood-v1" } });
Check(wire[0].GetProperty("id").GetString() == "life-1" && wire[0].GetProperty("npc").GetString() == "leah", "Wire keys match the strict backend schema.");
Check(!wire[0].TryGetProperty("item", out _) && !wire[0].TryGetProperty("friendship", out _) && !wire[0].TryGetProperty("activity", out _), "Absent optional values are omitted rather than sent as invalid nulls.");
var points = LifeEventWire.Encode(new[] { new LifeEvent { Id = "life-2", Npc = "leah", Day = 1, Kind = "activity.completed", Activity = "forest_walk", Minutes = 30, Count = 0, Friendship = 0 } });
Check(points[0].GetProperty("friendship").GetInt32() == 0 && points[0].GetProperty("count").GetInt32() == 0, "Meaningful zero facts survive wire serialization.");
Console.WriteLine($"生活目标与同步规则：{checks}/{checks} 通过（无游戏程序集）。");
