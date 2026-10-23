using System;
using System.Runtime.InteropServices;

namespace StardewAgentBridge;

internal sealed partial class ModEntry
{
    [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern void SDL_EnableScreenSaver();

    [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int SDL_IsScreenSaverEnabled();

    /// <summary>MonoGame explicitly disables SDL's screensaver; opt-in tests release that display request.</summary>
    private void AllowTestDisplaySleep()
    {
        if (this.memoryTest is not null && OperatingSystem.IsWindows())
            SDL_EnableScreenSaver();
    }

    private bool? TestDisplaySleepAllowed() => this.memoryTest is not null && OperatingSystem.IsWindows()
        ? SDL_IsScreenSaverEnabled() != 0 : null;
}
