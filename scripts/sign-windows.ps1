param(
  [string[]]$Targets = @(
    "hands\win-hands-native\bin\Release\net9.0\win-x64\publish\win-hands.exe",
    "dist\Astra Navi Desktop Setup*.exe"
  ),
  [string]$TimestampServer = "http://timestamp.digicert.com",
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$pfx = $env:ASTRA_NAVI_CERT_PFX
$pass = $env:ASTRA_NAVI_CERT_PASS
$resolved = @()
foreach ($pattern in $Targets) {
  $matches = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue
  if ($matches) { $resolved += $matches.FullName }
}

if ($DryRun) {
  @{
    action = "authenticode-sign"
    dryRun = $true
    hasCertificateEnv = [bool]($pfx -and $pass)
    timestampServer = $TimestampServer
    matchedTargets = $resolved
  } | ConvertTo-Json -Depth 4
  exit 0
}

if ([string]::IsNullOrWhiteSpace($pfx) -or -not (Test-Path $pfx)) {
  throw "ASTRA_NAVI_CERT_PFX must point to a valid .pfx code-signing certificate."
}
if ($resolved.Count -eq 0) {
  throw "No signable Windows binaries found matching target patterns."
}

$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if (-not $signtool) {
  throw "Windows SDK signtool.exe not found on PATH."
}

foreach ($file in $resolved) {
  $args = @("sign", "/fd", "SHA256", "/tr", $TimestampServer, "/td", "SHA256", "/f", $pfx)
  if (-not [string]::IsNullOrEmpty($pass)) { $args += @("/p", $pass) }
  $args += $file
  & $signtool.Source @args
  if ($LASTEXITCODE -ne 0) {
    throw "signtool failed for $file with exit code $LASTEXITCODE"
  }
}
Write-Host "Signed $($resolved.Count) file(s) successfully."
