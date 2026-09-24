function global:__wmuxColorRef([string]$Value) {
  if ($Value -notmatch '^#([0-9a-fA-F]{6})$') { throw 'invalid wmux console color' }
  $Rgb = [Convert]::ToUInt32($Matches[1], 16)
  return (($Rgb -band 0xff0000) -shr 16) -bor ($Rgb -band 0x00ff00) -bor (($Rgb -band 0x0000ff) -shl 16)
}

function global:__wmuxApplyConsoleTheme {
  try {
    $Ansi = @($env:WMUX_TERMINAL_ANSI_PALETTE -split ',')
    if ($Ansi.Count -ne 16 -or -not $env:WMUX_TERMINAL_BACKGROUND -or -not $env:WMUX_TERMINAL_FOREGROUND) { return }
    if (-not ('WmuxConsoleTheme.Native' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace WmuxConsoleTheme {
  [StructLayout(LayoutKind.Sequential)]
  public struct Coord { public short X; public short Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct SmallRect { public short Left; public short Top; public short Right; public short Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct ScreenBufferInfoEx {
    public uint Size;
    public Coord BufferSize;
    public Coord CursorPosition;
    public ushort Attributes;
    public SmallRect Window;
    public Coord MaximumWindowSize;
    public ushort PopupAttributes;
    [MarshalAs(UnmanagedType.Bool)] public bool FullscreenSupported;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public uint[] ColorTable;
  }

  public static class Native {
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetConsoleScreenBufferInfoEx(IntPtr output, ref ScreenBufferInfoEx info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetConsoleScreenBufferInfoEx(IntPtr output, ref ScreenBufferInfoEx info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetConsoleTextAttribute(IntPtr output, ushort attributes);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetConsoleWindowInfo(IntPtr output, bool absolute, ref SmallRect window);

    public static bool Apply(uint[] colors) {
      if (colors == null || colors.Length != 16) return false;
      IntPtr output = GetStdHandle(-11);
      var info = new ScreenBufferInfoEx {
        Size = (uint)Marshal.SizeOf<ScreenBufferInfoEx>(),
        ColorTable = new uint[16],
      };
      if (!GetConsoleScreenBufferInfoEx(output, ref info)) return false;
      info.ColorTable = colors;
      info.Attributes = (ushort)((info.Attributes & 0xff00) | 0x07);
      info.PopupAttributes = (ushort)((info.PopupAttributes & 0xff00) | 0x07);
      var window = info.Window;
      if (!SetConsoleScreenBufferInfoEx(output, ref info)) return false;
      // SetConsoleScreenBufferInfoEx reads the window rectangle one cell
      // smaller than GetConsoleScreenBufferInfoEx reports it, so writing the
      // info back shrinks the console. Under ConPTY that leaves the console a
      // row shorter than the terminal it renders into, and every absolute
      // cursor move lands one row off. Restore the exact pane geometry.
      var applied = new ScreenBufferInfoEx {
        Size = (uint)Marshal.SizeOf<ScreenBufferInfoEx>(),
        ColorTable = new uint[16],
      };
      if (GetConsoleScreenBufferInfoEx(output, ref applied)
        && (applied.Window.Right - applied.Window.Left != window.Right - window.Left
          || applied.Window.Bottom - applied.Window.Top != window.Bottom - window.Top)) {
        SetConsoleWindowInfo(output, true, ref window);
      }
      return SetConsoleTextAttribute(output, info.Attributes);
    }
  }
}
'@ -ErrorAction Stop
    }

    # ConsoleColor uses the Windows BGR bit order, while terminal palettes use ANSI order.
    $AnsiForWindows = @(0, 4, 2, 6, 1, 5, 3, 7, 8, 12, 10, 14, 9, 13, 11, 15)
    $Colors = [uint32[]]::new(16)
    for ($Index = 0; $Index -lt 16; $Index++) {
      $Colors[$Index] = __wmuxColorRef $Ansi[$AnsiForWindows[$Index]]
    }
    # ConPTY flattens the inherited default attributes into explicit RGB. Give
    # those two semantic slots the terminal's actual default colors.
    $Colors[0] = __wmuxColorRef $env:WMUX_TERMINAL_BACKGROUND
    $Colors[7] = __wmuxColorRef $env:WMUX_TERMINAL_FOREGROUND
    if ([WmuxConsoleTheme.Native]::Apply($Colors)) {
      [Console]::BackgroundColor = [ConsoleColor]::Black
      [Console]::ForegroundColor = [ConsoleColor]::Gray
      [Console]::Clear()
    }
  } catch {}
}

__wmuxApplyConsoleTheme
