# Clean-room Windows 11 VM verification script for packaged Astra Navi Desktop builds.
# Designed to run on a blank Windows 11 machine with NO Node.js, Python, or .NET SDK installed.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\verify-clean-windows.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\verify-clean-windows.ps1 -InstallDir "C:\Users\User\AppData\Local\Programs\Astra Navi Desktop" -RequireBootstrap
param(
  [string]$InstallDir = "",
  [switch]$RequireBootstrap,
  [switch]$LaunchSmoke
)

$ErrorActionPreference = "Stop"
$failures = 0
$warnings = 0

function Report-Pass([string]$label, [string]$detail) {
  Write-Host "[PASS] $label - $detail" -ForegroundColor Green
}

function Report-Warn([string]$label, [string]$detail) {
  $script:warnings++
  Write-Host "[WARN] $label - $detail" -ForegroundColor Yellow
}

function Report-Fail([string]$label, [string]$detail) {
  $script:failures++
  Write-Host "[FAIL] $label - $detail" -ForegroundColor Red
}

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Astra Navi Desktop"),
    (Join-Path $env:ProgramFiles "Astra Navi Desktop"),
    (Join-Path ${env:ProgramFiles(x86)} "Astra Navi Desktop")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path (Join-Path $candidate "Astra Navi Desktop.exe"))) {
      $InstallDir = $candidate
      break
    }
  }
}

if ([string]::IsNullOrWhiteSpace($InstallDir) -or -not (Test-Path $InstallDir)) {
  Report-Fail "InstallDir" "Could not locate installed Astra Navi Desktop folder. Pass -InstallDir <path>."
  exit 1
}

Report-Pass "InstallDir" $InstallDir

$appExe = Join-Path $InstallDir "Astra Navi Desktop.exe"
if (Test-Path $appExe) {
  Report-Pass "Main Executable" $appExe
  $sig = Get-AuthenticodeSignature -FilePath $appExe
  if ($sig.Status -eq "Valid") {
    Report-Pass "Main Executable Signature" "$($sig.SignerCertificate.Subject)"
  } elseif ($sig.Status -eq "NotSigned") {
    Report-Warn "Main Executable Signature" "Unsigned build (SmartScreen warning expected until Release signing is wired)"
  } else {
    Report-Fail "Main Executable Signature" "Invalid signature status: $($sig.Status) ($($sig.StatusMessage))"
  }
} else {
  Report-Fail "Main Executable" "Missing $appExe"
}

$resourcesDir = Join-Path $InstallDir "resources"
$requiredResources = @(
  "assets\icon.ico",
  "assets\models\ai-navigator\LICENSE.txt",
  "browser-bridge\manifest.json",
  "browser-bridge\native-host.mjs",
  "browser-bridge\install-host.mjs",
  "voice-server\server.py"
)
foreach ($rel in $requiredResources) {
  $full = Join-Path $resourcesDir $rel
  if (Test-Path $full) {
    Report-Pass "Resource $rel" "present"
  } else {
    Report-Fail "Resource $rel" "missing ($full)"
  }
}

$winHandsCandidates = @(
  (Join-Path $resourcesDir "hands\win-hands-native\win-hands.exe"),
  (Join-Path $resourcesDir "hands\win-hands-native\bin\win-hands.exe"),
  (Join-Path $resourcesDir "hands\win-hands-native\bin\Release\net9.0\win-x64\publish\win-hands.exe"),
  (Join-Path $resourcesDir "hands\win-hands.exe")
)
$winHandsExe = $winHandsCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($winHandsExe) {
  Report-Pass "Resource win-hands.exe" $winHandsExe
  $whSig = Get-AuthenticodeSignature -FilePath $winHandsExe
  if ($whSig.Status -eq "Valid") {
    Report-Pass "WinHands Signature" "$($whSig.SignerCertificate.Subject)"
  } elseif ($whSig.Status -eq "NotSigned") {
    Report-Warn "WinHands Signature" "Unsigned native binary"
  } else {
    Report-Fail "WinHands Signature" "Invalid signature status: $($whSig.Status)"
  }

  try {
    $pingOut = & $winHandsExe ping 2>&1
    if ($LASTEXITCODE -ne 0) {
      Report-Fail "WinHands ping" "Exited $LASTEXITCODE : $pingOut"
    } else {
      $pingJson = $pingOut | ConvertFrom-Json
      if ($pingJson.alive -eq $true) {
        Report-Pass "WinHands ping" "alive=true platform=$($pingJson.platform) arch=$($pingJson.arch) nativeAot=$($pingJson.nativeAot)"
      } else {
        Report-Fail "WinHands ping" "Unexpected response: $pingOut"
      }
    }
  } catch {
    Report-Fail "WinHands ping" $_.Exception.Message
  }

  try {
    $verOut = & $winHandsExe version 2>&1
    if ($LASTEXITCODE -ne 0) {
      Report-Fail "WinHands version" "Exited $LASTEXITCODE : $verOut"
    } else {
      $verJson = $verOut | ConvertFrom-Json
      Report-Pass "WinHands version" "$($verJson.name) $($verJson.version)"
    }
  } catch {
    Report-Fail "WinHands version" $_.Exception.Message
  }
}

# Post-bootstrap / clean-room runtime checks
$bridgeDir = Join-Path $env:LOCALAPPDATA "AstraNavi\BrowserBridge"
$chromeManifest = Join-Path $bridgeDir "app.astranavi.dom_bridge.chrome.json"
$firefoxManifest = Join-Path $bridgeDir "app.astranavi.dom_bridge.firefox.json"
$bridgeKeys = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\app.astranavi.dom_bridge",
  "HKCU:\Software\Chromium\NativeMessagingHosts\app.astranavi.dom_bridge",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\app.astranavi.dom_bridge",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\app.astranavi.dom_bridge",
  "HKCU:\Software\Mozilla\NativeMessagingHosts\app.astranavi.dom_bridge"
)

if ((Test-Path $chromeManifest) -and (Test-Path $firefoxManifest)) {
  Report-Pass "Browser Bridge Manifests" "$chromeManifest & $firefoxManifest"
} elseif ($RequireBootstrap) {
  Report-Fail "Browser Bridge Manifests" "Missing manifests under $bridgeDir"
} else {
  Report-Warn "Browser Bridge Manifests" "Not registered yet (run in-app setup wizard or bootstrap browser-bridge)"
}

$registeredKeys = 0
foreach ($key in $bridgeKeys) {
  if (Test-Path $key) {
    $registeredKeys++
  }
}
if ($registeredKeys -eq $bridgeKeys.Count) {
  Report-Pass "Browser Bridge Registry" "$registeredKeys / $($bridgeKeys.Count) HKCU keys present"
} elseif ($registeredKeys -gt 0) {
  Report-Warn "Browser Bridge Registry" "$registeredKeys / $($bridgeKeys.Count) HKCU keys present"
} elseif ($RequireBootstrap) {
  Report-Fail "Browser Bridge Registry" "No NativeMessagingHosts HKCU keys registered"
} else {
  Report-Warn "Browser Bridge Registry" "0 HKCU keys registered yet"
}

$dataDir = if (-not [string]::IsNullOrWhiteSpace($env:ASTRA_NAVI_DATA_DIR)) {
  $env:ASTRA_NAVI_DATA_DIR
} elseif (-not [string]::IsNullOrWhiteSpace($env:AI_CHAN_DATA_DIR)) {
  $env:AI_CHAN_DATA_DIR
} elseif (-not [string]::IsNullOrWhiteSpace($env:XDG_DATA_HOME)) {
  Join-Path $env:XDG_DATA_HOME "astra-navi"
} else {
  Join-Path $env:USERPROFILE ".local\share\astra-navi"
}
$modelsDir = if (-not [string]::IsNullOrWhiteSpace($env:ASTRA_NAVI_MODELS_DIR)) {
  $env:ASTRA_NAVI_MODELS_DIR
} else {
  Join-Path $dataDir "models"
}
$voicePy = Join-Path $dataDir "voice-env\Scripts\python.exe"
$ocrDir = Join-Path $modelsDir "ocr"
$startMenuLnk = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Astra Navi Desktop.lnk"

if (Test-Path $voicePy) {
  Report-Pass "Bootstrap Voice Env" $voicePy
} elseif ($RequireBootstrap) {
  Report-Fail "Bootstrap Voice Env" "Missing $voicePy"
} else {
  Report-Warn "Bootstrap Voice Env" "Optional Python voice server not bootstrapped yet (built-in Kokoro active)"
}

if ((Test-Path (Join-Path $ocrDir "det.onnx")) -and (Test-Path (Join-Path $ocrDir "rec.onnx")) -and (Test-Path (Join-Path $ocrDir "dict.txt"))) {
  Report-Pass "Bootstrap OCR Models" $ocrDir
} elseif ($RequireBootstrap) {
  Report-Fail "Bootstrap OCR Models" "Missing OCR model files in $ocrDir"
} else {
  Report-Warn "Bootstrap OCR Models" "Optional OCR models not downloaded yet"
}

if (Test-Path $startMenuLnk) {
  Report-Pass "Start Menu Shortcut" $startMenuLnk
} else {
  Report-Warn "Start Menu Shortcut" "Not present at $startMenuLnk"
}

if ($LaunchSmoke -and (Test-Path $appExe)) {
  try {
    $proc = Start-Process -FilePath $appExe -PassThru
    Start-Sleep -Seconds 5
    $proc.Refresh()
    if (-not $proc.HasExited) {
      Report-Pass "App Launch Smoke" "Process $($proc.Id) stayed running for 5s without immediate crash"
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    } else {
      Report-Fail "App Launch Smoke" "Process exited prematurely with code $($proc.ExitCode)"
    }
  } catch {
    Report-Fail "App Launch Smoke" $_.Exception.Message
  }
}

Write-Host ""
Write-Host "Clean-room verification summary: $failures failures, $warnings warnings."
if ($failures -gt 0) {
  exit 1
}
exit 0
