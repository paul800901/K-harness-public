# Starts K's dedicated Chrome (or opens one of its profiles) for an AI browser
# request and minimizes the new window. Chrome ignores minimized start-up
# settings, so the window is asked to minimize itself (the same command as its
# minimize button) once it has finished showing, and focus goes back to the
# window the owner was using. A brief flash is accepted by the owner
# (2026-10-18). It always opens a regular window: the browser assistant opens
# its connection page in one for both modes.
#
# -ProfileDirectory names a profile folder that K matched to a browser
# assistant identity. When K Chrome already runs, the chrome.exe started here
# hands the request to the running Chrome and exits; the new window then
# belongs to K Chrome's browser process, so new windows of that process are
# watched instead. Windows that already existed, already-minimized windows
# (the assistant creates its own minimized) and other Chrome installations are
# never touched, and the running Chrome is never closed or restarted.
param(
  [Parameter(Mandatory = $true)][string]$Chrome,
  [Parameter(Mandatory = $true)][string]$UserDataDir,
  [string]$ProfileDirectory = ''
)
$ErrorActionPreference = 'Stop'
if ($ProfileDirectory -and $ProfileDirectory -cnotmatch '^(Default|Profile [1-9][0-9]{0,3})$') { exit 2 }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
namespace KChrome {
public static class Win {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder name, int max);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string line, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static uint Owner(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
  // Chrome browser windows of these processes, shown and not owned by another window.
  public static List<IntPtr> BrowserWindows(uint[] pids, bool skipMinimized) {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (Array.IndexOf(pids, Owner(h)) >= 0 && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero && !(skipMinimized && IsIconic(h))) {
        var name = new StringBuilder(32);
        GetClassName(h, name, name.Capacity);
        if (name.ToString() == "Chrome_WidgetWin_1") found.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  // True for the browser (not a helper) process of this user data directory.
  public static bool IsBrowserFor(string line, string expected) {
    if (String.IsNullOrEmpty(line)) return false;
    int count;
    IntPtr argv = CommandLineToArgvW(line, out count);
    if (argv == IntPtr.Zero) return false;
    try {
      string dir = null;
      int found = 0;
      for (int i = 0; i < count; i++) {
        string arg = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size));
        if (arg.StartsWith("--type=")) return false;
        if (arg.StartsWith("--user-data-dir=")) { dir = arg.Substring(16); found++; }
        else if (arg == "--user-data-dir" && i + 1 < count) { dir = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, ++i * IntPtr.Size)); found++; }
      }
      if (found != 1) return false;
      try { return String.Equals(Path.GetFullPath(dir.Trim('"')).TrimEnd('\\'), expected, StringComparison.OrdinalIgnoreCase); }
      catch { return false; }
    } finally { LocalFree(argv); }
  }
}
}
'@
$expected = [IO.Path]::GetFullPath($UserDataDir).TrimEnd('\')
function Get-KBrowserIds {
  @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
    Where-Object { [KChrome.Win]::IsBrowserFor([string]$_.CommandLine, $expected) } |
    ForEach-Object { [uint32]$_.ProcessId })
}
$running = @(Get-KBrowserIds)
$before = @{}
if ($running.Count) { foreach ($h in [KChrome.Win]::BrowserWindows([uint32[]]$running, $false)) { $before[$h.ToInt64()] = $true } }
$arguments = @(('"--user-data-dir=' + $UserDataDir + '"'))
if ($ProfileDirectory) { $arguments += ('"--profile-directory=' + $ProfileDirectory + '"') }
$arguments += @('--enable-features=CDPScreenshotNewSurface', '--new-window', 'about:blank')
# The window the owner is using right before Chrome appears (never K Chrome's own).
$previous = [KChrome.Win]::GetForegroundWindow()
$browser = Start-Process -FilePath $Chrome -ArgumentList $arguments -PassThru
$deadline = [DateTime]::UtcNow.AddSeconds(15)
$requeried = $false
while ([DateTime]::UtcNow -lt $deadline) {
  $ids = [uint32[]](@([uint32]$browser.Id) + $running)
  $window = [KChrome.Win]::BrowserWindows($ids, $true) | Where-Object { -not $before.ContainsKey($_.ToInt64()) } | Select-Object -First 1
  if ($null -eq $window) {
    $foreground = [KChrome.Win]::GetForegroundWindow()
    if ($ids -notcontains [KChrome.Win]::Owner($foreground)) { $previous = $foreground }
    # With K Chrome running, the started chrome.exe forwards the request and
    # exits. Without a running K Chrome to forward to, an exit is a failure;
    # one re-check covers a K Chrome that started meanwhile.
    if (-not $running.Count -and $browser.HasExited) {
      if ($requeried) { exit 1 }
      $requeried = $true
      $running = @(Get-KBrowserIds)
      if ($running.Count) { foreach ($h in [KChrome.Win]::BrowserWindows([uint32[]]$running, $false)) { $before[$h.ToInt64()] = $true } }
    }
    Start-Sleep -Milliseconds 20
    continue
  }
  # Minimizing during Chrome's own show sequence leaves focus on Chrome and can
  # make it save a broken restore position, so let the window settle first.
  Start-Sleep -Milliseconds 150
  # A profile set to continue where it left off may restore more than one window.
  foreach ($h in [KChrome.Win]::BrowserWindows($ids, $true)) {
    if (-not $before.ContainsKey($h.ToInt64())) { [void][KChrome.Win]::PostMessage($h, 0x0112, [IntPtr]0xF020, [IntPtr]::Zero) }
  }
  # Windows hands focus to the next window in line, which may be another program.
  Start-Sleep -Milliseconds 100
  if ($previous -ne [IntPtr]::Zero -and [KChrome.Win]::IsWindow($previous) -and $ids -notcontains [KChrome.Win]::Owner($previous) -and [KChrome.Win]::GetForegroundWindow() -ne $previous) {
    [void][KChrome.Win]::SetForegroundWindow($previous)
  }
  exit 0
}
exit 1
