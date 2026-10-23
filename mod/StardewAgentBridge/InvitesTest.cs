using System;
using System.Linq;
using System.Text.Json;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>Controlled relationship inputs for invitations, behind WorldTest's disposable-save identity guard.</summary>
internal sealed partial class ModEntry
{
    private object InvitesTestSnapshot()
    {
        int today = (int)Game1.Date.TotalDays;
        int month = today - Game1.dayOfMonth;
        return new
        {
            today, this.inviter, this.inviterDay, this.meetingsArrived,
            days = Enumerable.Range(1, 28).Where(day => !Utility.isFestivalDay(day, Game1.season)
                && InviteDay(Game1.uniqueIDForThisGame, month + day)).ToArray(),
            eligible = SocialNpcs.Where(name => this.MayInvite(name, today)).ToArray(),
            history = SocialNpcs.Where(name => LastAsked(name) is not null).ToDictionary(name => name, name => LastAsked(name)),
        };
    }

    private bool InvitesTestCommand(string operation, JsonElement args)
    {
        if (!operation.StartsWith("invite-", StringComparison.Ordinal)) return false;
        switch (operation)
        {
            case "invite-fixture":
                this.ClearInvites();
                foreach (string name in SocialNpcs)
                {
                    Game1.player.friendshipData[name] = new Friendship(0);
                    if (!args.TryGetProperty("preserveHistory", out JsonElement keep) || !keep.GetBoolean())
                        Game1.player.modData.Remove(InvitedKey + name);
                }
                if (args.TryGetProperty("lastAsked", out JsonElement last))
                    Game1.player.modData[InvitedKey + "Abigail"] = last.GetInt32().ToString();
                break;
            case "invite-choose":
                this.worldTestNative = new { selected = this.TodayInviter() };
                break;
            default: throw new InvalidOperationException("Unknown invite test command: " + operation);
        }
        this.WorldComplete();
        return true;
    }
}
