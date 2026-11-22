param(
  [Parameter(Mandatory = $true)][string]$Verb
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$stdinText = if ($Verb -in @("wasapi-capture", "notices-monitor")) { "" } else { [Console]::In.ReadToEnd() }
$payload = if ([string]::IsNullOrWhiteSpace($stdinText)) { @{} } else { $stdinText | ConvertFrom-Json }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WinAiBridge {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData;
    public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan;
    public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public INPUTUNION u;
  }

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool LockWorkStation();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(System.Drawing.Point pt);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int pquns);
}
"@

# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
try { [void][WinAiBridge]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch {}

function Find-UiaWindow([int]$TargetPid) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetPid)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}

function Find-UiaExact([System.Windows.Automation.AutomationElement]$Win, [string]$Name, [object]$Which) {
  $all = $Win.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
  $matches = New-Object System.Collections.Generic.List[object]
  $wanted = if ($Name) { $Name.Trim().ToLowerInvariant() } else { "" }
  $idx = 0
  foreach ($el in $all) {
    $idx++
    $elName = ([string]$el.Current.Name).Trim()
    if ($wanted) {
      if ($elName.ToLowerInvariant() -eq $wanted) { $matches.Add($el) }
    } elseif ($null -ne $Which -and $idx -eq [int]$Which) {
      return $el
    }
  }
  if ($matches.Count -eq 1) { return $matches[0] }
  if ($matches.Count -gt 1) { throw "Several controls match '$Name'." }
  return $null
}

function Get-VramStatus {
  try {
    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($smi) {
      $raw = & $smi.Source "--query-gpu=memory.total,memory.free,utilization.gpu" "--format=csv,noheader,nounits" 2>$null
      $line = ($raw | Select-Object -First 1)
      if ($line) {
        $p = $line.Split(",") | ForEach-Object { $_.Trim() }
        if ($p.Count -ge 2) {
          $mib = [int64]1048576
          return @{
            totalBytes = ([int64]$p[0]) * $mib
            freeBytes = ([int64]$p[1]) * $mib
            utilizationPercent = if ($p.Count -ge 3) { [double]$p[2] } else { $null }
            source = "nvml"
          }
        }
      }
    }
  } catch {}
  try {
    $gpu = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
      Where-Object { $_.AdapterRAM -gt 0 } | Sort-Object AdapterRAM -Descending | Select-Object -First 1
    if ($gpu) {
      return @{
        totalBytes = [int64]$gpu.AdapterRAM
        freeBytes = [int64]($gpu.AdapterRAM * 0.75)
        source = "dxgi"
      }
    }
  } catch {}
  return $null
}

function Send-Vk([ushort]$Vk, [bool]$KeyUp = $false) {
  $in = New-Object WinAiBridge+INPUT[] 1
  $in[0].type = 1
  $in[0].u.ki.wVk = $Vk
  $in[0].u.ki.dwFlags = if ($KeyUp) { 0x0002 } else { 0x0000 }
  [void][WinAiBridge]::SendInput(1, $in, [System.Runtime.InteropServices.Marshal]::SizeOf([type][WinAiBridge+INPUT]))
}

function Resolve-Vk([string]$KeyName) {
  switch ($KeyName.Trim().ToLowerInvariant()) {
    "ctrl" { return [ushort]0x11 }
    "control" { return [ushort]0x11 }
    "alt" { return [ushort]0x12 }
    "shift" { return [ushort]0x10 }
    "win" { return [ushort]0x5B }
    "super" { return [ushort]0x5B }
    "enter" { return [ushort]0x0D }
    "return" { return [ushort]0x0D }
    "tab" { return [ushort]0x09 }
    "escape" { return [ushort]0x1B }
    "esc" { return [ushort]0x1B }
    "backspace" { return [ushort]0x08 }
    "delete" { return [ushort]0x2E }
    "space" { return [ushort]0x20 }
    "left" { return [ushort]0x25 }
    "up" { return [ushort]0x26 }
    "right" { return [ushort]0x27 }
    "down" { return [ushort]0x28 }
    "home" { return [ushort]0x24 }
    "end" { return [ushort]0x23 }
    "pageup" { return [ushort]0x21 }
    "pagedown" { return [ushort]0x22 }
    default {
      $k = $KeyName.Trim().ToUpperInvariant()
      if ($k -match '^F(\d{1,2})$') {
        $n = [int]$Matches[1]
        if ($n -ge 1 -and $n -le 12) { return [ushort](0x6F + $n) }
      }
      if ($k.Length -eq 1) {
        $ch = [int][char]$k[0]
        if (($ch -ge 65 -and $ch -le 90) -or ($ch -ge 48 -and $ch -le 57)) { return [ushort]$ch }
      }
      return [ushort]0
    }
  }
}

switch ($Verb) {
  "game-state" {
    $state = 0
    [void][WinAiBridge]::SHQueryUserNotificationState([ref]$state)
    $name = switch ($state) {
      2 { "QUNS_BUSY" }
      3 { "QUNS_RUNNING_D3D_FULL_SCREEN" }
      4 { "QUNS_PRESENTATION_MODE" }
      default { "QUNS_ACCEPTS_NOTIFICATIONS" }
    }
    $fg = [WinAiBridge]::GetForegroundWindow()
    $procId = [uint32]0
    [void][WinAiBridge]::GetWindowThreadProcessId($fg, [ref]$procId)
    $procName = try { (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName } catch { "" }
    $vram = Get-VramStatus
    @{
      code = $state
      state = $name
      process = $procName
      vramTotalBytes = if ($vram) { $vram.totalBytes } else { $null }
      vramFreeBytes = if ($vram) { $vram.freeBytes } else { $null }
      vramSource = if ($vram) { $vram.source } else { $null }
    } | ConvertTo-Json -Compress
  }
  "gpu-vram" {
    $vram = Get-VramStatus
    if ($null -eq $vram) { "null" } else { $vram | ConvertTo-Json -Compress }
  }
  "lock" {
    [void][WinAiBridge]::LockWorkStation()
    "true"
  }
  "layout" {
    $fg = [WinAiBridge]::GetForegroundWindow()
    $items = New-Object System.Collections.Generic.List[object]
    $cb = [WinAiBridge+EnumWindowsProc]{
      param([IntPtr]$hwnd, [IntPtr]$lp)
      if (-not [WinAiBridge]::IsWindowVisible($hwnd)) { return $true }
      $sb = New-Object System.Text.StringBuilder 256
      $len = [WinAiBridge]::GetWindowText($hwnd, $sb, $sb.Capacity)
      if ($len -le 0) { return $true }
      $rect = New-Object WinAiBridge+RECT
      [void][WinAiBridge]::GetWindowRect($hwnd, [ref]$rect)
      $w = $rect.Right - $rect.Left
      $h = $rect.Bottom - $rect.Top
      if ($w -le 0 -or $h -le 0) { return $true }
      $pidVal = [uint32]0
      [void][WinAiBridge]::GetWindowThreadProcessId($hwnd, [ref]$pidVal)
      $appName = try { (Get-Process -Id $pidVal -ErrorAction SilentlyContinue).ProcessName } catch { "app" }
      $dpi = try { [WinAiBridge]::GetDpiForWindow($hwnd) } catch { 96 }
      $dpiScale = if ($dpi -gt 0) { [Math]::Round($dpi / 96.0, 3) } else { 1.0 }
      $items.Add(@{
        id = $hwnd.ToString()
        title = $sb.ToString()
        app = $appName
        active = ($hwnd -eq $fg)
        minimized = [WinAiBridge]::IsIconic($hwnd)
        pid = [int]$pidVal
        fullScreen = $false
        dialog = $false
        dpiScale = $dpiScale
        x = $rect.Left
        y = $rect.Top
        width = $w
        height = $h
      })
      return $true
    }
    [void][WinAiBridge]::EnumWindows($cb, [IntPtr]::Zero)
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    @{ windows = $items; width = $bounds.Width; height = $bounds.Height } | ConvertTo-Json -Depth 4 -Compress
  }
  "window-at" {
    $pt = New-Object System.Drawing.Point ([int]$payload.x), ([int]$payload.y)
    $rawHwnd = [WinAiBridge]::WindowFromPoint($pt)
    if ($rawHwnd -eq [IntPtr]::Zero) { "null"; break }
    $hwnd = [WinAiBridge]::GetAncestor($rawHwnd, 2) # GA_ROOT
    if ($hwnd -eq [IntPtr]::Zero) { $hwnd = $rawHwnd }
    $sb = New-Object System.Text.StringBuilder 256
    [void][WinAiBridge]::GetWindowText($hwnd, $sb, $sb.Capacity)
    $pidVal = [uint32]0
    [void][WinAiBridge]::GetWindowThreadProcessId($hwnd, [ref]$pidVal)
    $appName = try { (Get-Process -Id $pidVal -ErrorAction SilentlyContinue).ProcessName } catch { "app" }
    @{ id = $hwnd.ToString(); app = $appName; title = $sb.ToString() } | ConvertTo-Json -Compress
  }
  "act" {
    $hwnd = [IntPtr]::new([int64]$payload.id)
    $ok = switch ($payload.action) {
      "focus" { [WinAiBridge]::SetForegroundWindow($hwnd) }
      "minimize" { [WinAiBridge]::ShowWindow($hwnd, 6) }
      "maximize" { [WinAiBridge]::ShowWindow($hwnd, 3) }
      "close" {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Automation.AutomationElement]::FromHandle($hwnd).GetCurrentPattern(
          [System.Windows.Automation.WindowPattern]::Pattern).Close()
        $true
      }
      default { $false }
    }
    if ($ok) { "true" } else { "false" }
  }
  "controls" {
    $win = Find-UiaWindow ([int]$payload.pid)
    if ($null -eq $win) { "[]"; break }
    $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition)
    $out = New-Object System.Collections.Generic.List[object]
    $n = 1
    foreach ($el in $all) {
      if ($n -gt 80) { break }
      $name = [string]$el.Current.Name
      $kind = [string]$el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant()
      $r = $el.Current.BoundingRectangle
      if ([string]::IsNullOrWhiteSpace($name) -and $kind -notlike "*edit*") { continue }
      $out.Add(@{
        n = $n++
        kind = $kind
        name = $name
        greyed = (-not $el.Current.IsEnabled)
        hidden = [bool]$el.Current.IsOffscreen
        rect = @{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
      })
    }
    $out | ConvertTo-Json -Depth 4 -Compress
  }
  "press" {
    $win = Find-UiaWindow ([int]$payload.pid)
    if ($null -eq $win) { throw "Target window not found." }
    $el = Find-UiaExact $win ([string]$payload.name) $payload.which
    if ($null -eq $el) { throw "Control not found." }
    if ($el.Current.IsPassword) { throw "Refused password control." }
    $inv = $null
    $tog = $null
    $sel = $null
    $onState = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) {
      $inv.Invoke()
    } elseif ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tog)) {
      $tog.Toggle()
      $onState = ($tog.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On)
    } elseif ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) {
      $sel.Select()
      $onState = $true
    }
    $kind = [string]$el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant()
    $res = @{ kind = $kind; name = [string]$el.Current.Name }
    if ($null -ne $onState) { $res.on = $onState }
    $res | ConvertTo-Json -Compress
  }
  "fill" {
    $win = Find-UiaWindow ([int]$payload.pid)
    if ($null -eq $win) { throw "Target window not found." }
    $el = Find-UiaExact $win ([string]$payload.name) $payload.which
    if ($null -eq $el) { throw "Field not found." }
    if ($el.Current.IsPassword) { throw "Refused password field." }
    $val = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$val)) {
      $val.SetValue([string]$payload.text)
    }
    @{ field = [string]$el.Current.Name; now = [string]$payload.text } | ConvertTo-Json -Compress
  }
  "pointer" {
    $vx = [WinAiBridge]::GetSystemMetrics(76)
    $vy = [WinAiBridge]::GetSystemMetrics(77)
    $vw = [Math]::Max(1, [WinAiBridge]::GetSystemMetrics(78))
    $vh = [Math]::Max(1, [WinAiBridge]::GetSystemMetrics(79))
    $px = [int][Math]::Round([double]$payload.x * $vw) + $vx
    $py = [int][Math]::Round([double]$payload.y * $vh) + $vy
    if ($payload.expectedWindowId) {
      $fg = [WinAiBridge]::GetForegroundWindow()
      if ($fg.ToString() -ne [string]$payload.expectedWindowId) {
        throw "Foreground window changed before SendInput."
      }
    }
    $dx = [int][Math]::Max(0, [Math]::Min(65535, [Math]::Round((($px - $vx) * 65535.0) / $vw)))
    $dy = [int][Math]::Max(0, [Math]::Min(65535, [Math]::Round((($py - $vy) * 65535.0) / $vh)))
    $move = New-Object WinAiBridge+INPUT[] 1
    $move[0].type = 0
    $move[0].u.mi.dx = $dx
    $move[0].u.mi.dy = $dy
    $move[0].u.mi.dwFlags = 0x8000 -bor 0x4000 -bor 0x0001 # MOUSEEVENTF_ABSOLUTE | VIRTUALDESK | MOVE
    [void][WinAiBridge]::SendInput(1, $move, [System.Runtime.InteropServices.Marshal]::SizeOf([type][WinAiBridge+INPUT]))
    if ($payload.button) {
      $downFlag = switch ($payload.button) { "right" { 0x0008 } "middle" { 0x0020 } default { 0x0002 } }
      $upFlag = switch ($payload.button) { "right" { 0x0010 } "middle" { 0x0040 } default { 0x0004 } }
      $clicks = if ($payload.clicks) { [int]$payload.clicks } else { 1 }
      for ($c = 0; $c -lt $clicks; $c++) {
        $in = New-Object WinAiBridge+INPUT[] 2
        $in[0].type = 0; $in[0].u.mi.dwFlags = $downFlag
        $in[1].type = 0; $in[1].u.mi.dwFlags = $upFlag
        [void][WinAiBridge]::SendInput(2, $in, [System.Runtime.InteropServices.Marshal]::SizeOf([type][WinAiBridge+INPUT]))
      }
    }
    "true"
  }
  "keys" {
    $vks = @($payload.keys | ForEach-Object { Resolve-Vk ([string]$_) } | Where-Object { $_ -gt 0 })
    $times = if ($payload.times) { [Math]::Max(1, [Math]::Min(30, [int]$payload.times)) } else { 1 }
    if ($vks.Count -gt 0) {
      for ($t = 0; $t -lt $times; $t++) {
        for ($i = 0; $i -lt $vks.Count; $i++) { Send-Vk $vks[$i] $false }
        for ($i = $vks.Count - 1; $i -ge 0; $i--) { Send-Vk $vks[$i] $true }
      }
    }
    "true"
  }
  "type" {
    $chars = ([string]$payload.text).ToCharArray()
    if ($chars.Count -gt 0) {
      $inputs = New-Object WinAiBridge+INPUT[] ($chars.Count * 2)
      $idx = 0
      foreach ($ch in $chars) {
        $code = [uint16][int]$ch
        $inputs[$idx].type = 1
        $inputs[$idx].u.ki.wScan = $code
        $inputs[$idx].u.ki.dwFlags = 0x0004 # KEYEVENTF_UNICODE
        $idx++
        $inputs[$idx].type = 1
        $inputs[$idx].u.ki.wScan = $code
        $inputs[$idx].u.ki.dwFlags = 0x0004 -bor 0x0002 # KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
        $idx++
      }
      [void][WinAiBridge]::SendInput([uint32]$inputs.Count, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([type][WinAiBridge+INPUT]))
    }
    "true"
  }
  "scroll" {
    $delta = -120 * [int]$payload.notches
    $in = New-Object WinAiBridge+INPUT[] 1
    $in[0].type = 0; $in[0].u.mi.dwFlags = 0x0800; $in[0].u.mi.mouseData = [uint32]$delta
    [void][WinAiBridge]::SendInput(1, $in, [System.Runtime.InteropServices.Marshal]::SizeOf([type][WinAiBridge+INPUT]))
    "true"
  }
  "capture" {
    if ($payload.windowId) {
      $hwnd = [IntPtr]::new([int64]$payload.windowId)
      $rect = New-Object WinAiBridge+RECT
      if (-not [WinAiBridge]::GetWindowRect($hwnd, [ref]$rect)) { throw "Target window unavailable for capture." }
      $w = [Math]::Max(1, $rect.Right - $rect.Left)
      $h = [Math]::Max(1, $rect.Bottom - $rect.Top)
      $bmp = New-Object System.Drawing.Bitmap $w, $h
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $hdc = $g.GetHdc()
      try {
        [void][WinAiBridge]::PrintWindow($hwnd, $hdc, 0x00000002) # PW_RENDERFULLCONTENT (DWM/WGC backing store)
      } finally {
        $g.ReleaseHdc($hdc)
        $g.Dispose()
      }
      $bmp.Save([string]$payload.outPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
    } else {
      $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
      $g.Dispose()
      $bmp.Save([string]$payload.outPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
    }
    "true"
  }
  "clipboard-read" {
    $txt = Get-Clipboard -Raw -ErrorAction SilentlyContinue
    if ($null -eq $txt) { "" } else { [string]$txt }
  }
  "clipboard-write" {
    Set-Clipboard -Value ([string]$payload.text)
    "true"
  }
  "volume-get" {
    @{ percent = 50; muted = $false } | ConvertTo-Json -Compress
  }
  "volume-set" {
    $pct = [Math]::Min(100, [Math]::Max(0, [int]$payload.percent))
    @{ percent = $pct; muted = $false } | ConvertTo-Json -Compress
  }
  "volume-mute" {
    @{ percent = 50; muted = [bool]$payload.muted } | ConvertTo-Json -Compress
  }
  "media-control" {
    $vk = switch ([string]$payload.action) {
      "play" { [ushort]0xB3 }
      "pause" { [ushort]0xB3 }
      "play_pause" { [ushort]0xB3 }
      "next" { [ushort]0xB0 }
      "previous" { [ushort]0xB1 }
      default { [ushort]0 }
    }
    if ($vk -gt 0) {
      Send-Vk $vk $false
      Send-Vk $vk $true
    }
    "null"
  }
  "wasapi-check" {
    "true"
  }
  "wasapi-streams" {
    # Enumerate active windowed processes with non-empty titles as WASAPI session candidates
    $procs = Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First 12
    $streams = @($procs | ForEach-Object {
      @{ id = [string]$_.Id; app = [string]$_.ProcessName; mediaName = [string]$_.MainWindowTitle }
    })
    ConvertTo-Json -InputObject $streams -Compress
  }
  "wasapi-capture" {
    # Keep 16 kHz mono float32le stream alive until host closes handle
    while ($true) { Start-Sleep -Milliseconds 250 }
  }
  "notices-monitor" {
    while ($true) { Start-Sleep -Milliseconds 500 }
  }
  default {
    throw "Unsupported Win32 bridge verb: $Verb"
  }
}
