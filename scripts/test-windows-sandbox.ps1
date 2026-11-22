param(
  [ValidateSet("sandbox", "secondary-desktop")]
  [string]$Mode = "secondary-desktop",
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$DesktopName = "AiChanIsolatedTest"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$bridge = Join-Path $PSScriptRoot "..\hands\win_hands.ps1"
if (-not (Test-Path $bridge)) {
  throw "Missing Windows bridge script at $bridge"
}

if ($Mode -eq "sandbox") {
  $wsbFile = Join-Path $env:TEMP "ai-chan-sandbox.wsb"
  $sandboxPath = "C:\Users\WDAGUtilityAccount\Desktop\ai-chan"
  $xml = @"
<Configuration>
  <VGpu>Enable</VGpu>
  <Networking>Disable</Networking>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <ProtectedClient>Enable</ProtectedClient>
  <PrinterRedirection>Disable</PrinterRedirection>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <MemoryInMB>4096</MemoryInMB>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$RepoPath</HostFolder>
      <SandboxFolder>$sandboxPath</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$sandboxPath\scripts\test-windows-sandbox.ps1" -Mode secondary-desktop</Command>
  </LogonCommand>
</Configuration>
"@
  Set-Content -Path $wsbFile -Value $xml -Encoding UTF8
  Write-Host "Generated locked-down Windows Sandbox config: $wsbFile"
  $exe = Get-Command WindowsSandbox.exe -ErrorAction SilentlyContinue
  if (-not $exe) {
    Write-Warning "WindowsSandbox.exe not found (Windows Pro/Enterprise feature disabled). Config written only."
    exit 0
  }
  Start-Process -FilePath $exe.Source -ArgumentList $wsbFile -Wait
  exit 0
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinIsoDesktop {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateDesktop(string lpszDesktop, IntPtr lpszDevice, IntPtr pDevmode, uint dwFlags, uint dwDesiredAccess, IntPtr lpsa);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr GetThreadDesktop(uint dwThreadId);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetThreadDesktop(IntPtr hDesktop);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool CloseDesktop(IntPtr hDesktop);
  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();
}
"@

$origDesktop = [WinIsoDesktop]::GetThreadDesktop([WinIsoDesktop]::GetCurrentThreadId())
$secDesktop = [WinIsoDesktop]::CreateDesktop($DesktopName, [IntPtr]::Zero, [IntPtr]::Zero, 0, 0x10000000, [IntPtr]::Zero)
if ($secDesktop -eq [IntPtr]::Zero) {
  throw "Failed to allocate isolated Win32 secondary desktop '$DesktopName'."
}

try {
  if (-not [WinIsoDesktop]::SetThreadDesktop($secDesktop)) {
    throw "Failed to bind test thread to secondary desktop '$DesktopName'."
  }
  $layoutJson = "{}" | & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $bridge layout
  $null = $layoutJson | ConvertFrom-Json
  $gameJson = "{}" | & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $bridge game-state
  $null = $gameJson | ConvertFrom-Json
  Write-Host "Secondary Win32 desktop smoke test PASSED on '$DesktopName'."
} finally {
  [void][WinIsoDesktop]::SetThreadDesktop($origDesktop)
  [void][WinIsoDesktop]::CloseDesktop($secDesktop)
}
