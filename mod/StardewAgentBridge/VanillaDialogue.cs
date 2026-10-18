using System;
using System.Collections.Generic;
using System.Text;
using StardewValley;

namespace StardewAgentBridge;

/// <summary>Builds the agent's reply as a vanilla NPC dialogue, so it looks and behaves like the game's own (docs/game-bridge.md §4).</summary>
internal static class VanillaDialogue
{
    /// <summary>Portrait commands from <see cref="Dialogue"/>; neutral needs none.</summary>
    private static readonly Dictionary<string, string> Emotions = new()
    {
        ["happy"] = "$h", ["sad"] = "$s", ["special"] = "$u", ["blush"] = "$l", ["angry"] = "$a",
    };

    /// <summary>Characters the dialogue parser treats as commands, e.g. "[184]" gives an item and "@" becomes the player's name.</summary>
    private static readonly Dictionary<char, char> Escapes = new()
    {
        ['#'] = '＃', ['$'] = '＄', ['@'] = '＠', ['%'] = '％', ['{'] = '｛', ['}'] = '｝',
        ['*'] = '＊', ['^'] = '＾', ['['] = '［', [']'] = '］', ['|'] = '｜',
    };

    /// <summary>
    /// A dialogue showing <paramref name="reply"/> with the given responses in the same box, like an NPC's own question.
    /// With no responses it is a plain line. <paramref name="answered"/> receives the chosen index.
    /// </summary>
    public static Dialogue Create(NPC npc, string reply, string emotion, IReadOnlyList<string> responses, Action<int>? answered)
    {
        StringBuilder text = new(Escape(reply));
        if (Emotions.TryGetValue(emotion, out string? command))
            text.Append(command);
        for (int i = 0; i < responses.Count; i++)
            text.Append($"#$r agent{i} 0 agent{i}#").Append(Escape(responses[i]));

        Dialogue dialogue = new(npc, null, text.ToString());
        if (answered is not null && responses.Count > 0)
        {
            // Bypasses the vanilla response handling, including its built-in friendship change.
            dialogue.answerQuestionBehavior = index =>
            {
                answered(index);
                return true;
            };
        }
        return dialogue;
    }

    /// <summary>Makes model text safe for the dialogue parser; drops emoji and control characters the fonts cannot draw.</summary>
    public static string Escape(string text)
    {
        StringBuilder result = new(text.Length);
        foreach (char c in text)
        {
            if (char.IsSurrogate(c) || (char.IsControl(c) && c != '\n'))
                continue;
            result.Append(c == '\n' ? ' ' : Escapes.TryGetValue(c, out char safe) ? safe : c);
        }
        return result.ToString().Trim();
    }
}
