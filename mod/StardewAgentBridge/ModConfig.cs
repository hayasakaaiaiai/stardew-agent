namespace StardewAgentBridge;

internal sealed class ModConfig
{
    /// <summary>The backend started with `npm run bridge`.</summary>
    public string BackendUrl { get; set; } = "ws://127.0.0.1:47711";

    /// <summary>Whether to ask "继续聊？" after a vanilla dialogue with a social NPC.</summary>
    public bool OfferContinueChat { get; set; } = true;

    /// <summary>How long to wait for the first word of a reply before giving up.</summary>
    public int ReplyTimeoutSeconds { get; set; } = 20;

    /// <summary>Whether NPCs mutter last night's lines over their heads when the player is near (docs/npc-bubbles.md).</summary>
    public bool ShowBubbles { get; set; } = true;

    /// <summary>Whether NPCs' letters go into the mailbox (docs/npc-mail.md).</summary>
    public bool SendLetters { get; set; } = true;

    /// <summary>Whether two NPCs standing together near the player chat over their heads (docs/npc-chat.md).</summary>
    public bool NpcChat { get; set; } = true;

    /// <summary>Whether what the player says in agent conversations raises or lowers vanilla friendship (docs/npc-friendship.md).</summary>
    public bool ChatChangesFriendship { get; set; } = true;

    /// <summary>Whether a close NPC may hand the player something from its card in an agent conversation (docs/npc-in-person-gifts.md).</summary>
    public bool InPersonGifts { get; set; } = true;

    /// <summary>Whether NPCs who spend an hour together away from the player pass news on (docs/offscreen-news.md).</summary>
    public bool OffscreenNews { get; set; } = true;

    /// <summary>
    /// Whether NPCs who spend an hour together away from the player chat and remember it (docs/scheduler.md §4).
    /// Rides on the hourly report, so it needs <see cref="OffscreenNews"/>.
    /// </summary>
    public bool BackstageScenes { get; set; } = true;

    /// <summary>Whether NPCs near the player say a line over their heads or greet the player (docs/ambient-lines.md).</summary>
    public bool AmbientLines { get; set; } = true;

    /// <summary>Whether the NPCs at a festival remember what happened there (docs/festival-memories.md).</summary>
    public bool FestivalMemories { get; set; } = true;

    /// <summary>Whether an NPC with something to tell the player walks over when it sees them (docs/npc-approach.md).</summary>
    public bool NpcApproach { get; set; } = true;

    /// <summary>Whether an NPC goes where it agreed to meet the player yesterday, changing today's schedule (docs/npc-meetings.md).</summary>
    public bool NpcMeetings { get; set; } = true;
}
