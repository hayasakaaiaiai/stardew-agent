using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Text;
using Microsoft.Xna.Framework.Graphics;

namespace StardewAgentBridge;

/// <summary>
/// The game's fonts throw on characters they lack, and the model occasionally produces rare characters or emoji.
/// Everything shown in the menu goes through here first.
/// </summary>
internal static class SafeText
{
    private static readonly ConditionalWeakTable<SpriteFont, HashSet<char>> Glyphs = new();

    public static string For(SpriteFont font, string text)
    {
        HashSet<char> glyphs = Glyphs.GetValue(font, f => new HashSet<char>(f.Characters));
        char fallback = font.DefaultCharacter is char d && glyphs.Contains(d) ? d : glyphs.Contains('?') ? '?' : ' ';
        StringBuilder result = new(text.Length);
        foreach (char c in text)
            result.Append(c == '\n' || glyphs.Contains(c) ? c : fallback);
        return result.ToString();
    }
}
