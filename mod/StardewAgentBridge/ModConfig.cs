namespace StardewAgentBridge;

internal sealed class ModConfig
{
    /// <summary>The backend started with `npm run bridge`.</summary>
    public string BackendUrl { get; set; } = "ws://127.0.0.1:47711";

    /// <summary>Whether to ask "继续聊？" after a vanilla dialogue with a social NPC.</summary>
    public bool OfferContinueChat { get; set; } = true;

    /// <summary>How long to wait for the first word of a reply before giving up.</summary>
    public int ReplyTimeoutSeconds { get; set; } = 20;
}
