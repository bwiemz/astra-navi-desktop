param(
  [ValidateSet("auto", "azure", "pfx", "signpath")]
  [string]$Provider = "auto",
  [string[]]$Targets = @(
    "hands\win-hands-native\bin\Release\net9.0\win-x64\publish\win-hands.exe",
    "dist\Astra Navi Desktop Setup*.exe",
    "dist\Astra Navi Desktop*.exe",
    "dist\win-unpacked\Astra Navi Desktop.exe"
  ),
  [string]$TimestampServer = "",
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$azEndpoint = $env:AZURE_CODE_SIGNING_ENDPOINT
$azAccount = $env:AZURE_CODE_SIGNING_ACCOUNT
$azProfile = $env:AZURE_CODE_SIGNING_CERT_PROFILE
$azDlib = $env:AZURE_CODE_SIGNING_DLIB

$spToken = $env:SIGNPATH_API_TOKEN
$spOrg = $env:SIGNPATH_ORG_SLUG
$spProject = $env:SIGNPATH_PROJECT_SLUG
$spPolicy = if ($env:SIGNPATH_SIGNING_POLICY) { $env:SIGNPATH_SIGNING_POLICY } else { "release-signing" }
$spArtifactConfig = if ($env:SIGNPATH_ARTIFACT_CONFIGURATION) { $env:SIGNPATH_ARTIFACT_CONFIGURATION } else { "initial" }

$pfx = $env:ASTRA_NAVI_CERT_PFX
$pass = $env:ASTRA_NAVI_CERT_PASS

$resolvedProvider = $Provider
if ($resolvedProvider -eq "auto") {
  if (-not [string]::IsNullOrWhiteSpace($azEndpoint) -and -not [string]::IsNullOrWhiteSpace($azAccount) -and -not [string]::IsNullOrWhiteSpace($azProfile)) {
    $resolvedProvider = "azure"
  } elseif (-not [string]::IsNullOrWhiteSpace($spToken) -and -not [string]::IsNullOrWhiteSpace($spOrg) -and -not [string]::IsNullOrWhiteSpace($spProject)) {
    $resolvedProvider = "signpath"
  } else {
    $resolvedProvider = "pfx"
  }
}

$effectiveTimestamp = $TimestampServer
if ([string]::IsNullOrWhiteSpace($effectiveTimestamp)) {
  $effectiveTimestamp = if ($resolvedProvider -eq "azure") { "http://timestamp.acs.microsoft.com" } else { "http://timestamp.digicert.com" }
}

$hasCreds = switch ($resolvedProvider) {
  "azure" {
    (-not [string]::IsNullOrWhiteSpace($azEndpoint)) -and
    (-not [string]::IsNullOrWhiteSpace($azAccount)) -and
    (-not [string]::IsNullOrWhiteSpace($azProfile))
  }
  "signpath" {
    (-not [string]::IsNullOrWhiteSpace($spToken)) -and
    (-not [string]::IsNullOrWhiteSpace($spOrg)) -and
    (-not [string]::IsNullOrWhiteSpace($spProject))
  }
  default {
    (-not [string]::IsNullOrWhiteSpace($pfx)) -and (Test-Path $pfx)
  }
}

$resolved = @()
$seenPaths = @{}
foreach ($pattern in $Targets) {
  $matches = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue
  foreach ($m in $matches) {
    if (-not $seenPaths.ContainsKey($m.FullName)) {
      $seenPaths[$m.FullName] = $true
      $resolved += $m.FullName
    }
  }
}

if ($DryRun) {
  @{
    action = "authenticode-sign"
    dryRun = $true
    provider = $resolvedProvider
    rfc3161 = $true
    hasCredentials = $hasCreds
    timestampServer = $effectiveTimestamp
    matchedTargets = $resolved
  } | ConvertTo-Json -Depth 4
  exit 0
}

if ($resolved.Count -eq 0) {
  throw "No signable Windows binaries found matching target patterns."
}
if (-not $hasCreds) {
  throw "Signing credentials for provider '$resolvedProvider' are not configured."
}

function Invoke-VerifySignature {
  param([string]$SigntoolExe, [string]$FilePath)
  & $SigntoolExe verify /pa /v $FilePath
  if ($LASTEXITCODE -ne 0) {
    throw "signtool verify failed for $FilePath with exit code $LASTEXITCODE"
  }
}

if ($resolvedProvider -eq "signpath") {
  $tempZip = Join-Path ([System.IO.Path]::GetTempPath()) "astranavi-signpath-$([System.Guid]::NewGuid().ToString('N')).zip"
  try {
    Compress-Archive -Path $resolved -DestinationPath $tempZip -Force
    $headers = @{ Authorization = "Bearer $spToken" }
    $submitUrl = "https://app.signpath.io/API/v1/$spOrg/Integrations/GitHub/SigningRequests"
    $form = @{
      ProjectSlug = $spProject
      SigningPolicySlug = $spPolicy
      ArtifactConfigurationSlug = $spArtifactConfig
      Artifact = Get-Item -Path $tempZip
    }
    $response = Invoke-RestMethod -Method Post -Uri $submitUrl -Headers $headers -Form $form
    Write-Host "Submitted $($resolved.Count) file(s) to SignPath Foundation (request: $($response | ConvertTo-Json -Compress))."
  } finally {
    Remove-Item -Path $tempZip -Force -ErrorAction SilentlyContinue
  }
  exit 0
}

$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if (-not $signtool) {
  $sdkBins = Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending
  if ($sdkBins -and $sdkBins.Count -gt 0) {
    $signtool = Get-Command $sdkBins[0].FullName
  }
}
if (-not $signtool) {
  throw "Windows SDK signtool.exe not found on PATH or under Windows Kits."
}

if ($resolvedProvider -eq "azure") {
  $dlibPath = $azDlib
  if ([string]::IsNullOrWhiteSpace($dlibPath) -or -not (Test-Path $dlibPath)) {
    $candidate = Get-ChildItem -Path @(
      "$env:USERPROFILE\.nuget\packages\microsoft.trusted.signing.client\*\bin\x64\Azure.CodeSigning.Dlib.dll",
      "$env:LOCALAPPDATA\Microsoft\AzureArtifactSigning\Azure.CodeSigning.Dlib.dll",
      "tools\Azure.CodeSigning.Dlib.dll"
    ) -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($candidate) { $dlibPath = $candidate.FullName }
  }
  if ([string]::IsNullOrWhiteSpace($dlibPath) -or -not (Test-Path $dlibPath)) {
    throw "AZURE_CODE_SIGNING_DLIB must point to Azure.CodeSigning.Dlib.dll from Microsoft.Trusted.Signing.Client."
  }
  $metaPath = Join-Path ([System.IO.Path]::GetTempPath()) "azure-signing-$([System.Guid]::NewGuid().ToString('N')).json"
  try {
    @{
      Endpoint = $azEndpoint
      CodeSigningAccountName = $azAccount
      CertificateProfileName = $azProfile
    } | ConvertTo-Json | Set-Content -Path $metaPath -Encoding UTF8
    foreach ($file in $resolved) {
      & $signtool.Source sign /v /fd SHA256 /tr $effectiveTimestamp /td SHA256 /dlib $dlibPath /dmdf $metaPath $file
      if ($LASTEXITCODE -ne 0) {
        throw "Azure Artifact Signing signtool failed for $file with exit code $LASTEXITCODE"
      }
      Invoke-VerifySignature -SigntoolExe $signtool.Source -FilePath $file
    }
  } finally {
    Remove-Item -Path $metaPath -Force -ErrorAction SilentlyContinue
  }
  Write-Host "Signed and verified $($resolved.Count) file(s) via Azure Artifact Signing."
  exit 0
}

foreach ($file in $resolved) {
  $signArgs = @("sign", "/v", "/fd", "SHA256", "/tr", $effectiveTimestamp, "/td", "SHA256", "/f", $pfx)
  if (-not [string]::IsNullOrEmpty($pass)) { $signArgs += @("/p", $pass) }
  $signArgs += $file
  & $signtool.Source @signArgs
  if ($LASTEXITCODE -ne 0) {
    throw "signtool failed for $file with exit code $LASTEXITCODE"
  }
  Invoke-VerifySignature -SigntoolExe $signtool.Source -FilePath $file
}
Write-Host "Signed and verified $($resolved.Count) file(s) via PFX certificate."
