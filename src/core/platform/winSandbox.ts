import { isAbsolute } from "node:path";

export interface WindowsSandboxOptions {
  /** Absolute Windows host path (e.g. `C:\Users\brandon\Projects\AI Chan`) mapped into the Sandbox. */
  repoPath: string;
  /** Keep host files immutable by default so integration tests cannot write outside Sandbox RAM. */
  readOnly?: boolean;
  /** Sandbox RAM budget in MB (clamped safely to [2048, 32768]). */
  memoryMb?: number;
  /** Optional command executed automatically inside the Sandbox once logged in. */
  logonCommand?: string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isAbsoluteHostPath(target: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(target) || isAbsolute(target);
}

/**
 * Generates a locked-down Windows Sandbox (`.wsb`) configuration file for offline testing
 * Win32/UIA/WGC/SendInput integrations with networking, mic, and clipboard disabled.
 */
export function generateWindowsSandboxConfig(options: WindowsSandboxOptions): string {
  const repoPath = options.repoPath.trim();
  if (!repoPath || !isAbsoluteHostPath(repoPath)) {
    throw new Error(`Windows Sandbox requires an absolute repoPath (got "${options.repoPath}").`);
  }
  const readOnly = options.readOnly ?? true;
  const memoryMb = Math.min(32_768, Math.max(2048, Math.round(options.memoryMb ?? 4096)));
  const sandboxFolder = "C:\\Users\\WDAGUtilityAccount\\Desktop\\ai-chan";
  const defaultCommand = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${sandboxFolder}\\scripts\\test-windows-sandbox.ps1" -Mode secondary-desktop`;
  const logonCommand = (options.logonCommand ?? defaultCommand).trim();

  return [
    "<Configuration>",
    "  <VGpu>Enable</VGpu>",
    "  <Networking>Disable</Networking>",
    "  <AudioInput>Disable</AudioInput>",
    "  <VideoInput>Disable</VideoInput>",
    "  <ProtectedClient>Enable</ProtectedClient>",
    "  <PrinterRedirection>Disable</PrinterRedirection>",
    "  <ClipboardRedirection>Disable</ClipboardRedirection>",
    `  <MemoryInMB>${memoryMb}</MemoryInMB>`,
    "  <MappedFolders>",
    "    <MappedFolder>",
    `      <HostFolder>${escapeXml(repoPath)}</HostFolder>`,
    `      <SandboxFolder>${escapeXml(sandboxFolder)}</SandboxFolder>`,
    `      <ReadOnly>${readOnly ? "true" : "false"}</ReadOnly>`,
    "    </MappedFolder>",
    "  </MappedFolders>",
    "  <LogonCommand>",
    `    <Command>${escapeXml(logonCommand)}</Command>`,
    "  </LogonCommand>",
    "</Configuration>",
    "",
  ].join("\n");
}

export interface SecondaryDesktopOptions {
  desktopName?: string;
  testCommand: string;
}

/**
 * Generates a self-cleaning PowerShell + Win32 `CreateDesktop` harness that executes UIA/SendInput
 * smoke tests on a private hidden Windows desktop, always restoring the caller's thread desktop
 * and closing the handle in `finally`.
 */
export function generateSecondaryDesktopScript(options: SecondaryDesktopOptions): string {
  const name = (options.desktopName ?? "AiChanTestDesktop").replace(/[^A-Za-z0-9_-]/g, "");
  if (!name) throw new Error("Secondary desktop name must contain alphanumeric characters.");
  const command = options.testCommand.trim();
  if (!command) throw new Error("Secondary desktop harness requires a testCommand.");

  return [
    "Set-StrictMode -Version Latest",
    '$ErrorActionPreference = "Stop"',
    "Add-Type @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class SecondaryDesktopNative {",
    '  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
    "  public static extern IntPtr CreateDesktop(string lpszDesktop, IntPtr lpszDevice, IntPtr pDevmode, uint dwFlags, uint dwDesiredAccess, IntPtr lpsa);",
    '  [DllImport("user32.dll", SetLastError = true)]',
    "  public static extern IntPtr GetThreadDesktop(uint dwThreadId);",
    '  [DllImport("user32.dll", SetLastError = true)]',
    "  public static extern bool SetThreadDesktop(IntPtr hDesktop);",
    '  [DllImport("user32.dll", SetLastError = true)]',
    "  public static extern bool CloseDesktop(IntPtr hDesktop);",
    '  [DllImport("kernel32.dll")]',
    "  public static extern uint GetCurrentThreadId();",
    "}",
    "'@",
    "$originalDesktop = [SecondaryDesktopNative]::GetThreadDesktop([SecondaryDesktopNative]::GetCurrentThreadId())",
    `$desktop = [SecondaryDesktopNative]::CreateDesktop("${name}", [IntPtr]::Zero, [IntPtr]::Zero, 0, 0x10000000, [IntPtr]::Zero)`,
    "if ($desktop -eq [IntPtr]::Zero) { throw 'CreateDesktop failed.' }",
    "try {",
    "  if (-not [SecondaryDesktopNative]::SetThreadDesktop($desktop)) { throw 'SetThreadDesktop failed.' }",
    `  ${command}`,
    "} finally {",
    "  [void][SecondaryDesktopNative]::SetThreadDesktop($originalDesktop)",
    "  [void][SecondaryDesktopNative]::CloseDesktop($desktop)",
    "}",
    "",
  ].join("\n");
}
