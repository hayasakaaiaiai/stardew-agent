using StardewAgentBridge;

int checks = 0;
void Check(string name, bool pass)
{
    if (!pass) throw new InvalidOperationException(name);
    checks++;
    Console.WriteLine("PASS " + name);
}

Check("walking cannot finish at arrival", !LifeActivityRules.Ready("forest_walk", 0, 0));
Check("forest walk needs thirty observed minutes", !LifeActivityRules.Ready("forest_walk", 20, 0) && LifeActivityRules.Ready("forest_walk", 30, 0));
Check("a spouse walk obeys the same time threshold", !LifeActivityRules.Ready("spouse_walk", 29, 99) && LifeActivityRules.Ready("spouse_walk", 30, 0));
Check("fishing needs both company and an actual catch", !LifeActivityRules.Ready("fishing", 90, 0)
    && !LifeActivityRules.Ready("fishing", 10, 1) && LifeActivityRules.Ready("fishing", 20, 1));
Check("foraging needs both company and an actual pickup", !LifeActivityRules.Ready("foraging", 90, 0)
    && !LifeActivityRules.Ready("foraging", 10, 2) && LifeActivityRules.Ready("foraging", 20, 1));
Check("cooking is completed by an actual dish, not elapsed time", !LifeActivityRules.Ready("cooking", 90, 0) && LifeActivityRules.Ready("cooking", 0, 1));
Check("a dinner needs a real portion", !LifeActivityRules.Ready("home_dinner", 90, 0) && LifeActivityRules.Ready("home_dinner", 0, 1));
Check("unknown activities cannot complete", !LifeActivityRules.Ready("teleport", 999, 999));
Check("normal clock and hour boundary advance equally", LifeActivityRules.ClockStep(1310, 1320, true) == 10 && LifeActivityRules.ClockStep(1350, 1400, true) == 10);
Check("pausing or splitting company credits no time", LifeActivityRules.ClockStep(1310, 1310, true) == 0 && LifeActivityRules.ClockStep(1310, 1320, false) == 0);
Check("clock jumps and rollback do not invent company", LifeActivityRules.ClockStep(1310, 1400, true) == 0 && LifeActivityRules.ClockStep(1310, 1300, true) == 0);
Check("invalid times and overnight rollover are rejected", LifeActivityRules.ClockStep(1360, 1410, true) == 0 && LifeActivityRules.ClockStep(2600, 600, true) == 0);
Check("a known friendship is symmetric", LifeActivityRules.AreFriends("leah", "elliott") && LifeActivityRules.AreFriends("elliott", "leah"));
Check("strangers and self-talk cannot become social propagation", !LifeActivityRules.AreFriends("leah", "george") && !LifeActivityRules.AreFriends("leah", "leah"));
Check("family activities are private", !LifeActivityRules.PublicActivity("spouse_walk") && !LifeActivityRules.PublicActivity("home_dinner"));
Check("public outdoor activities can be shared", LifeActivityRules.PublicActivity("forest_walk") && LifeActivityRules.PublicActivity("foraging") && LifeActivityRules.PublicActivity("fishing"));
var miss = (Id: "life-1", Kind: "activity.missed", Day: 1, SourceId: (string?)null);
var apology = (Id: "life-2", Kind: "relationship.apology", Day: 2, SourceId: (string?)"life-1");
var success = (Id: "life-3", Kind: "activity.completed", Day: 3, SourceId: (string?)null);
Check("a successful activity alone does not erase an unaddressed grievance", LifeActivityRules.UnrepairedMiss(new[] { miss, success }) == "life-1");
Check("an apology alone still needs future action", LifeActivityRules.UnrepairedMiss(new[] { miss, apology }) == "life-1");
Check("an apology followed by real success repairs the grievance", LifeActivityRules.UnrepairedMiss(new[] { miss, apology, success }) is null);
Check("an unknown apology source cannot repair a grievance", LifeActivityRules.UnrepairedMiss(new[] { miss, apology with { SourceId = "missing" }, success }) == "life-1");
Check("a completed goal and its activity do not repair twice on one day", LifeActivityRules.UnrepairedMiss(new[] {
    miss, apology, miss with { Id = "life-4" }, apology with { Id = "life-5", SourceId = "life-4" },
    success, success with { Id = "life-6", Kind = "goal.completed" },
}) == "life-4");
Check("a pending actor return belongs only to its original load and day", LifeActivityRules.SameSession("load-a", 7, "load-a", 7)
    && !LifeActivityRules.SameSession("load-a", 7, "load-a", 8) && !LifeActivityRules.SameSession("load-a", 7, "load-b", 7));
var pendingReturns = new[] { (Nonce: "old-load", Day: 7), (Nonce: "load-a", Day: 6), (Nonce: "load-a", Day: 7) };
Check("stale returns cannot move tomorrow's actors", pendingReturns.Count(p => LifeActivityRules.SameSession(p.Nonce, p.Day, "load-a", 8)) == 0);
Check("reloading does not resurrect an older return", pendingReturns.Count(p => LifeActivityRules.SameSession(p.Nonce, p.Day, "load-b", 7)) == 0);
Check("normal actions still require ready supported sync", LifeActivityRules.MenuAllowed(true, true, false, false)
    && !LifeActivityRules.MenuAllowed(false, true, false, false) && !LifeActivityRules.MenuAllowed(true, false, false, false));
Check("offline exit permits only the current activity", LifeActivityRules.MenuAllowed(false, true, true, true)
    && !LifeActivityRules.MenuAllowed(false, true, true, false));
Check("an active session never authorizes new offline actions", !LifeActivityRules.MenuAllowed(false, true, false, true));
Check("backend capability loss still permits releasing an existing actor", LifeActivityRules.MenuAllowed(false, false, true, true)
    && !LifeActivityRules.MenuAllowed(false, false, false, true));
Check("dinner and outdoor starts share inclusive nine-to-nineteen bounds", LifeActivityRules.StartTime(900)
    && LifeActivityRules.StartTime(1900) && !LifeActivityRules.StartTime(850) && !LifeActivityRules.StartTime(1910)
    && !LifeActivityRules.StartTime(2200));
Console.WriteLine($"{checks}/{checks} passed; no game process or save was opened.");
