using System;
using System.Runtime.InteropServices;
using StardewValley;

namespace StardewAgentBridge;

internal sealed partial class ModEntry
{
    [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern void SDL_MinimizeWindow(IntPtr window);

    [DllImport("SDL2.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern uint SDL_GetWindowFlags(IntPtr window);

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

    /// <summary>Only an explicitly requested isolated World run can minimize its own game window.</summary>
    private void MinimizeRequestedTestWindow()
    {
        if (this.memoryTest is { World: true, MinimizeWindow: true } && OperatingSystem.IsWindows())
            SDL_MinimizeWindow(Game1.game1.Window.Handle);
    }

    private bool? TestWindowMinimized() => this.memoryTest is { World: true, MinimizeWindow: true } && OperatingSystem.IsWindows()
        ? (SDL_GetWindowFlags(Game1.game1.Window.Handle) & 0x40u) != 0 : null;
}
