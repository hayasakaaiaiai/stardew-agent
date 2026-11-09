using System;
using System.Collections.Generic;
using System.Linq;
using StardewModdingAPI;
using StardewValley;

namespace StardewAgentBridge;

internal sealed partial class ModEntry
{
    private sealed record LifeGoalTemplate(string Id, string Npc, string Item, string GameName, int Count, string Activity, int Minutes, string Opening, string Invitation);
    private static readonly LifeGoalTemplate[] LifeGoalTemplates =
    {
        new("leah-driftwood-v1", "Leah", "浮木", "Driftwood", 3, "forest_walk", 30,
            "我想找三块浮木留作创作材料。你愿意帮忙吗？不着急，有空再带来就好。", "一起去森林河边找找灵感"),
        new("willy-catfish-v1", "Willy", "鲶鱼", "Catfish", 1, "fishing", 20,
            "嗐，我想看看你钓到的鲶鱼。能带一条给我吗？不用着急，之后咱们还能一起钓会儿鱼。", "一起去钓鱼"),
        new("maru-copper-v1", "Maru", "铜锭", "Copper Bar", 1, "forest_walk", 30,
            "我想留一块铜锭做些材料准备。你愿意帮忙吗？等有空，我们也可以一起去森林观察自然。", "一起去森林观察自然"),
    };
    private sealed class LifeGoal
    {
        public string Stage { get; set; } = "collecting";
        public int AcceptedDay { get; set; }
        public int? DeliveredDay { get; set; }
        public int? EndedDay { get; set; }
        public string? Attempt { get; set; }
    }
    private sealed class LifeLetter
    {
        public string Key { get; set; } = "";
        public string Npc { get; set; } = "";
        public string Text { get; set; } = "";
        public int DueDay { get; set; }
        public bool Sent { get; set; }
    }
    private Action? lifeMenuNext;
    private static LifeGoalTemplate? GoalTemplate(NPC npc) => LifeGoalTemplates.FirstOrDefault(t => t.Npc == npc.Name);
    private bool HasLifeGoalEntry(NPC npc) => GoalTemplate(npc) is { } t
        && (this.lifeSave.Goals.ContainsKey(t.Id) || this.config.SharedGoals && this.CanBeginLifeGoal(npc));
    private bool CanBeginLifeGoal(NPC npc) => this.lifeSupported && this.activeLoad && GameState.Hearts(npc) >= 8
        && GameState.Relation(npc) is not ("married" or "roommate") && !ColdShoulder(npc.Name);

    // All callbacks run on the next free frame, with their original load identity checked again.
    private void AskLifeChoice(NPC npc, string text, params (string Text, Action Action)[] choices)
    {
        string nonce = this.loadNonce;
        int day = this.currentDay;
        Game1.currentLocation.createQuestionDialogue(VanillaDialogue.Escape(text),
            choices.Select((choice, index) => new Response(index.ToString(), choice.Text)).ToArray(),
            (_, answer) =>
            {
                if (!int.TryParse(answer, out int index) || index < 0 || index >= choices.Length) return;
                this.lifeMenuNext = () =>
                {
                    if (this.activeLoad && LifeGoalRules.CurrentMenu(nonce, this.loadNonce, day, this.currentDay) && this.CanChat
                        && Context.IsWorldReady && !Game1.eventUp && LifeNear(npc))
                        choices[index].Action();
                };
            });
    }
    private void LifeNotice(string text) => Game1.addHUDMessage(new HUDMessage(text, HUDMessage.newQuest_type));

    private void ShowLifeGoal(NPC npc)
    {
        if (!this.CanChat || !LifeNear(npc)) return;
        if (GoalTemplate(npc) is not { } t) return;
        if (!this.lifeSave.Goals.TryGetValue(t.Id, out LifeGoal? goal))
        {
            if (!this.config.SharedGoals || !this.CanBeginLifeGoal(npc) || !this.CanRecordLifeEvent) return;
            this.AskLifeChoice(npc, t.Opening, ("我来帮忙", () => this.AcceptLifeGoal(npc)), ("以后再说", () => { }));
            return;
        }
        if (goal.Stage == "collecting")
            this.AskLifeChoice(npc, $"还需要 {t.Count} 份{t.Item}。一次交齐，不限期。",
                ($"交付 {t.Count} 份{t.Item}", () => this.DeliverLifeGoal(npc)),
                ("先到这里", () => this.ConfirmCloseLifeGoal(npc)), ("改天再来", () => { }));
        else if (goal.Stage == "ready")
            this.AskLifeChoice(npc, $"{t.Item}已经收到，谢谢。要不要{t.Invitation}？",
                ("现在一起去", () => this.StartLifeGoalWalk(npc)),
                ("改天再去", () => { }), ("先到这里", () => this.ConfirmCloseLifeGoal(npc)));
        else if (goal.Stage == "walking") this.ShowLifeActivities(npc);
        else this.AskLifeChoice(npc, goal.Stage == "completed" ? "材料和后续活动都已经完成，这段经历会被记住。" :
            goal.DeliveredDay.HasValue ? "材料已经交付，这件事先告一段落。" : "这次没有继续收集材料。", ("知道了", () => { }));
    }

    private void AcceptLifeGoal(NPC npc)
    {
        if (GoalTemplate(npc) is not { } t || !this.CanChat || !this.config.SharedGoals || !this.CanBeginLifeGoal(npc)
            || !this.CanRecordLifeEvent || !LifeGoalRules.CanAccept(this.lifeSave.Goals.GetValueOrDefault(t.Id)?.Stage)) return;
        this.lifeSave.Goals[t.Id] = new LifeGoal { AcceptedDay = this.currentDay };
        if (!this.EmitLifeEvent(npc.Name, "goal.accepted", goal: t.Id)) { this.lifeSave.Goals.Remove(t.Id); return; }
        this.LifeNotice($"已答应{npc.displayName}：交付 {t.Count} 份{t.Item}，没有期限。");
    }

    private void DeliverLifeGoal(NPC npc)
    {
        if (GoalTemplate(npc) is not { } t || !this.lifeSupported || !this.CanChat || !this.config.SharedGoals || !this.CanRecordLifeEvent
            || !this.lifeSave.Goals.TryGetValue(t.Id, out LifeGoal? goal) || goal.Stage != "collecting") return;
        string[] ids = Game1.objectData.Where(pair => pair.Value.Name == t.GameName).Select(pair => "(O)" + pair.Key).ToArray();
        if (ids.Length != 1) { this.LifeNotice($"无法核对原版{t.Item}身份，尚未扣除材料。"); return; }
        List<(int Slot, Item Item, int Stack)> stacks = new();
        for (int i = 0; i < Game1.player.Items.Count; i++)
            if (Game1.player.Items[i] is Item item && item.QualifiedItemId == ids[0]) stacks.Add((i, item, item.Stack));
        if (!LifeGoalRules.CanDeliver(goal.Stage, stacks.Sum(s => s.Stack), t.Count)) { this.LifeNotice($"背包里还不够 {t.Count} 份{t.Item}，材料没有扣除。"); return; }
        int[]? plan = LifeGoalRules.DeliveryPlan(stacks.Select(stack => stack.Stack).ToArray(), t.Count);
        if (plan is null) return;
        try
        {
            for (int i = 0; i < stacks.Count; i++)
            {
                var stack = stacks[i];
                stack.Item.Stack -= plan[i];
                if (stack.Item.Stack == 0) Game1.player.Items[stack.Slot] = null;
            }
            goal.Stage = "ready"; goal.DeliveredDay = this.currentDay;
            if (!this.EmitLifeEvent(npc.Name, "goal.delivered", goal: t.Id, item: t.Item, count: t.Count))
                throw new InvalidOperationException("生活记录未能保存。");
        }
        catch (Exception ex)
        {
            foreach (var stack in stacks) { stack.Item.Stack = stack.Stack; Game1.player.Items[stack.Slot] = stack.Item; }
            goal.Stage = "collecting"; goal.DeliveredDay = null;
            this.PersistLife();
            this.Monitor.Log("材料交付已撤销：" + ex.Message, LogLevel.Error);
            return;
        }
        this.LifeNotice($"已交付 {t.Count} 份{t.Item}；有空时可以和{npc.displayName}{t.Invitation}。");
    }

    private void StartLifeGoalWalk(NPC npc)
    {
        if (GoalTemplate(npc) is not { } t || !this.lifeSave.Goals.TryGetValue(t.Id, out LifeGoal? goal) || goal.Stage != "ready") return;
        if (!this.config.SharedGoals || !this.CanBeginLifeGoal(npc) || !this.CanChat || !this.CanRecordLifeEvent
            || !this.config.NpcMeetings || !this.config.MeetingsGoTogether || Game1.isFestival()
            || Game1.timeOfDay < 900 || Game1.timeOfDay > 1700 || npc.Schedule is null || npc.ignoreScheduleToday)
        {
            this.LifeNotice("暂时不能同行：需 8 心、非配偶，普通日 09:00–17:00，有可用日程并开启赴约和同行。材料仍已交付。");
            return;
        }
        string attempt = Guid.NewGuid().ToString("N");
        if (!this.TryStartLifeActivity(npc, t.Activity, t.Id + "@" + attempt)) return;
        goal.Stage = "walking"; goal.Attempt = attempt;
        this.PersistLife();
    }

    private void OnLifeActivityEnded(string npc, string? boundGoal, bool completed, int minutes, int count)
    {
        if (boundGoal is null) return;
        string[] parts = boundGoal.Split('@');
        LifeGoalTemplate? t = LifeGoalTemplates.FirstOrDefault(candidate => candidate.Id == parts[0]);
        if (parts.Length != 2 || t is null || !npc.Equals(t.Npc, StringComparison.OrdinalIgnoreCase)
            || !this.lifeSave.Goals.TryGetValue(t.Id, out LifeGoal? goal) || goal.Stage != "walking" || goal.Attempt != parts[1]) return;
        string? next = LifeGoalRules.EndAttempt(goal.Stage, t.Id, goal.Attempt, boundGoal, completed, minutes, t.Minutes, count, t.Activity == "fishing");
        if (next is null) return;
        goal.Attempt = null;
        if (next != "completed")
        {
            goal.Stage = "ready"; this.PersistLife();
            this.LifeNotice("这次活动结束了。材料已经收到，以后可以再约。"); return;
        }
        goal.Stage = "completed"; goal.EndedDay = this.currentDay;
        LifeLetter letter = this.QueueLifeGoalLetter(t, completed: true);
        if (!this.EmitLifeEvent(npc, "goal.completed", activity: t.Activity, goal: t.Id, count: count, minutes: minutes))
        {
            this.lifeSave.Letters.Remove(letter); goal.Stage = "ready"; goal.EndedDay = null; this.PersistLife(); return;
        }
        this.LifeNotice($"完成了{Game1.getCharacterFromName(t.Npc)?.displayName ?? t.Npc}的共同目标。");
    }

    private void ConfirmCloseLifeGoal(NPC npc)
    {
        if (GoalTemplate(npc) is not { } t || !this.lifeSave.Goals.TryGetValue(t.Id, out LifeGoal? goal) || !LifeGoalRules.CanClose(goal.Stage)) return;
        this.AskLifeChoice(npc, goal.DeliveredDay.HasValue ? "结束这件事吗？已经交出的材料不退还，这份感谢会被保留。" : "结束这次目标吗？没有材料会被扣除。",
            ("结束目标", () => this.CloseLifeGoal(npc)), ("继续留着", () => { }));
    }

    private void CloseLifeGoal(NPC npc)
    {
        if (GoalTemplate(npc) is not { } t || !this.lifeSupported || !this.CanChat || !this.CanRecordLifeEvent || !this.lifeSave.Goals.TryGetValue(t.Id, out LifeGoal? goal)
            || !LifeGoalRules.CanClose(goal.Stage)) return;
        string previous = goal.Stage;
        goal.Stage = "closed"; goal.EndedDay = this.currentDay;
        LifeLetter? letter = goal.DeliveredDay.HasValue ? this.QueueLifeGoalLetter(t, completed: false) : null;
        if (!this.EmitLifeEvent(npc.Name, "goal.closed", goal: t.Id))
        {
            if (letter is not null) this.lifeSave.Letters.Remove(letter);
            goal.Stage = previous; goal.EndedDay = null; return;
        }
        this.LifeNotice("这件事先告一段落，已发生的经历仍会被记住。");
    }

    private LifeLetter QueueLifeGoalLetter(LifeGoalTemplate t, bool completed)
    {
        string ending = t.Activity == "fishing" ? "也谢谢你陪我钓鱼。能一起享受垂钓的时光，真不错。" : "也谢谢你陪我在林子里走走。能有人一起欣赏风景，感觉很自在。";
        LifeLetter letter = new()
        {
            Key = "StardewAgent.Life." + t.Id, Npc = t.Npc, DueDay = this.currentDay + 1,
            Text = $"谢谢你送来的{t.Item}。" + (completed ? ending : "这份心意我会记得。有空再来聊聊吧。"),
        };
        this.lifeSave.Letters.Add(letter); return letter;
    }

    private void DeliverLifeLetters()
    {
        if (!this.activeLoad || this.lifeCorrupt || !this.config.SendLetters || !Context.IsWorldReady || this.lifeSave.MailDay == this.currentDay) return;
        LifeLetter? letter = this.lifeSave.Letters.FirstOrDefault(l => !l.Sent && l.DueDay <= this.currentDay);
        if (letter is null) return;
        if (Game1.player.mailReceived.Contains(letter.Key) || Game1.player.mailbox.Contains(letter.Key))
        { letter.Sent = true; this.PersistLife(); return; }
        string name = Game1.getCharacterFromName(letter.Npc)?.displayName ?? letter.Npc;
        this.letters[letter.Key] = VanillaDialogue.Escape(letter.Text) + "^^   -" + VanillaDialogue.Escape(name) + "[#]" + VanillaDialogue.Escape(name) + "的来信";
        this.Helper.Data.WriteSaveData(LettersSaveKey, this.letters);
        this.Helper.GameContent.InvalidateCache(MailAsset);
        Game1.player.mailbox.Add(letter.Key);
        letter.Sent = true; this.lifeSave.MailDay = this.currentDay;
        this.PersistLife();
    }
}
