param(
  [ValidateSet("auto", "azure", "pfx", "signpath", "self-signed-test")]
  [string]$Provider = "auto",
  [ValidateSet("auto", "public", "private")]
  [string]$ProfileMode = "auto",
  [string[]]$Targets = @(
    "hands\win-hands-native\bin\Release\net9.0\win-x64\publish\win-hands.exe",
    "dist\Astra Navi Desktop Setup*.exe",
    "dist\Astra Navi Desktop*.exe",
    "dist\win-unpacked\Astra Navi Desktop.exe"
  ),
  [string]$TimestampServer = "",
  [string]$ExpectedPublisherPattern = "Astra Navi",
  [string]$AssertNoThirdPartyResignDir = "",
  [switch]$VerifyOnly,
  [bool]$SkipAlreadySigned = $true,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$azEndpoint = $env:AZURE_CODE_SIGNING_ENDPOINT
$azAccount = $env:AZURE_CODE_SIGNING_ACCOUNT
$azPublicProfile = $env:AZURE_CODE_SIGNING_CERT_PROFILE
$azPrivateProfile = $env:AZURE_CODE_SIGNING_CERT_PROFILE_PRIVATE
$azProfile = switch ($ProfileMode) {
  "public" { $azPublicProfile }
  "private" {
    if (-not [string]::IsNullOrWhiteSpace($azPrivateProfile)) { $azPrivateProfile } else { $azPublicProfile }
  }
  default {
    if (-not [string]::IsNullOrWhiteSpace($azPublicProfile)) { $azPublicProfile } else { $azPrivateProfile }
  }
}
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

$effectiveTimestampServers = if (-not [string]::IsNullOrWhiteSpace($TimestampServer)) {
  @($TimestampServer)
} elseif ($resolvedProvider -eq "azure") {
  @("http://timestamp.acs.microsoft.com")
} else {
  @("http://timestamp.digicert.com", "http://timestamp.sectigo.com", "http://tsa.starfieldtech.com")
}
$effectiveTimestamp = $effectiveTimestampServers[0]

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
  "self-signed-test" {
    $true
  }
  default {
    (-not [string]::IsNullOrWhiteSpace($pfx)) -and (Test-Path $pfx)
  }
}

$resolvedList = [System.Collections.Generic.List[string]]::new()
$seenPaths = @{}
foreach ($pattern in $Targets) {
  $matches = @(Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue)
  foreach ($m in $matches) {
    if (-not $seenPaths.ContainsKey($m.FullName)) {
      $seenPaths[$m.FullName] = $true
      $resolvedList.Add($m.FullName)
    }
  }
}
$resolved = @($resolvedList)

if ($DryRun) {
  @{
    action = "authenticode-sign"
    dryRun = $true
    provider = $resolvedProvider
    profileMode = $ProfileMode
    azureProfileConfigured = (-not [string]::IsNullOrWhiteSpace($azProfile))
    rfc3161 = $true
    hasCredentials = $hasCreds
    timestampServer = $effectiveTimestamp
    timestampFallbackServers = $effectiveTimestampServers
    skipAlreadySigned = [bool]$SkipAlreadySigned
    matchedTargets = $resolved
  } | ConvertTo-Json -Depth 4
  exit 0
}

function Find-SigntoolExe {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  $sdkBins = @(Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending)
  if ($sdkBins.Count -gt 0) {
    return $sdkBins[0].FullName
  }
  throw "Windows SDK signtool.exe not found on PATH or under Windows Kits."
}

function Import-TrustedRootCertificate {
  param([string]$CerPath)
  try {
    Import-Certificate -FilePath $CerPath -CertStoreLocation "Cert:\LocalMachine\Root" | Out-Null
    return "Cert:\LocalMachine\Root"
  } catch {
    Import-Certificate -FilePath $CerPath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
    return "Cert:\CurrentUser\Root"
  }
}

function Import-OptionalPrivateTrustRoot {
  if (-not [string]::IsNullOrWhiteSpace($env:AZURE_PRIVATE_TRUST_ROOT_CER_B64)) {
    $rootCer = Join-Path ([System.IO.Path]::GetTempPath()) "azure-private-root-$([System.Guid]::NewGuid().ToString('N')).cer"
    try {
      $cleanB64 = ($env:AZURE_PRIVATE_TRUST_ROOT_CER_B64 -replace '\s+', '')
      [IO.File]::WriteAllBytes($rootCer, [Convert]::FromBase64String($cleanB64))
      $storeUsed = Import-TrustedRootCertificate -CerPath $rootCer
      Write-Host "Imported AZURE_PRIVATE_TRUST_ROOT_CER_B64 into $storeUsed."
    } finally {
      Remove-Item -Path $rootCer -Force -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-VerifySignature {
  param([string]$SigntoolExe, [string]$FilePath)
  $sig = Get-AuthenticodeSignature -FilePath $FilePath
  if ($sig.Status -ne "Valid") {
    throw "Get-AuthenticodeSignature failed for ${FilePath}: Status=$($sig.Status) ($($sig.StatusMessage))"
  }
  if ($null -eq $sig.SignerCertificate) {
    throw "Get-AuthenticodeSignature missing SignerCertificate for $FilePath"
  }
  if ($null -eq $sig.TimeStamperCertificate) {
    throw "RFC 3161 timestamp missing (TimeStamperCertificate is null) for $FilePath — 72-hour Azure certificates require timestamping."
  }
  & $SigntoolExe verify /pa /v $FilePath | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "signtool verify failed for $FilePath with exit code $LASTEXITCODE"
  }
  Write-Host ("VERIFIED: {0} | Status={1} | Signer={2} | NotAfter={3:u} | Timestamp={4}" -f `
    $FilePath, $sig.Status, $sig.SignerCertificate.Subject, $sig.SignerCertificate.NotAfter, $sig.TimeStamperCertificate.Subject)
}

function Test-ShouldSkipSigning {
  param([string]$FilePath, [string]$PublisherPattern, [bool]$SkipOwn)
  $sig = Get-AuthenticodeSignature -FilePath $FilePath
  if ($sig.Status -eq "Valid" -and $null -ne $sig.SignerCertificate) {
    $subject = $sig.SignerCertificate.Subject
    if ($subject -notmatch $PublisherPattern) {
      Write-Host "Skipping already-signed third-party binary ($subject): $FilePath"
      return $true
    }
    if ($SkipOwn -and $null -ne $sig.TimeStamperCertificate) {
      Write-Host "Skipping already-signed & timestamped binary ($subject): $FilePath"
      return $true
    }
  }
  return $false
}

function Invoke-SigntoolSignWithTsa {
  param(
    [string]$SigntoolExe,
    [string[]]$BaseArgs,
    [string[]]$TimestampServers,
    [string]$FilePath
  )
  $lastCode = 1
  foreach ($tsa in $TimestampServers) {
    $signArgs = @("sign") + $BaseArgs + @("/tr", $tsa, "/td", "SHA256", $FilePath)
    & $SigntoolExe @signArgs
    $lastCode = $LASTEXITCODE
    if ($lastCode -eq 0) {
      return $tsa
    }
    Write-Warning "Timestamp server $tsa returned exit code $lastCode for $FilePath; trying next server."
  }
  throw "signtool sign failed for $FilePath across timestamp servers ($($TimestampServers -join ', ')); last exit code $lastCode"
}

if ($resolved.Count -eq 0) {
  throw "No signable Windows binaries found matching target patterns: $($Targets -join ', ')"
}

Import-OptionalPrivateTrustRoot

if ($VerifyOnly) {
  $signtoolExe = Find-SigntoolExe
  foreach ($file in $resolved) {
    Invoke-VerifySignature -SigntoolExe $signtoolExe -FilePath $file
  }
  if (-not [string]::IsNullOrWhiteSpace($AssertNoThirdPartyResignDir)) {
    $appExe = Join-Path $AssertNoThirdPartyResignDir "Astra Navi Desktop.exe"
    if (-not (Test-Path $appExe)) {
      throw "Cannot assert third-party DLL non-resign: missing $appExe"
    }
    $appSig = Get-AuthenticodeSignature -FilePath $appExe
    if ($null -eq $appSig.SignerCertificate) {
      throw "Expected $appExe to be signed before checking third-party DLLs."
    }
    $ourThumb = $appSig.SignerCertificate.Thumbprint
    $dlls = @(Get-ChildItem -Path $AssertNoThirdPartyResignDir -Filter "*.dll" -Recurse -File -ErrorAction SilentlyContinue)
    $reSigned = [System.Collections.Generic.List[string]]::new()
    foreach ($dll in $dlls) {
      $dllSig = Get-AuthenticodeSignature -FilePath $dll.FullName
      if ($null -ne $dllSig.SignerCertificate -and $dllSig.SignerCertificate.Thumbprint -eq $ourThumb) {
        $reSigned.Add($dll.FullName)
      }
    }
    if ($reSigned.Count -gt 0) {
      throw "Third-party DLL(s) were unexpectedly signed with our certificate ($ourThumb): $($reSigned -join ', ')"
    }
    Write-Host "VERIFIED third-party integrity: $($dlls.Count) DLL(s) under $AssertNoThirdPartyResignDir untouched (none signed by $ourThumb)."
  }
  Write-Host "Post-sign verification passed for $($resolved.Count) file(s)."
  exit 0
}

if (-not $hasCreds) {
  throw "Signing credentials for provider '$resolvedProvider' (profileMode '$ProfileMode') are not configured."
}

$toSignList = [System.Collections.Generic.List[string]]::new()
foreach ($file in $resolved) {
  if (-not (Test-ShouldSkipSigning -FilePath $file -PublisherPattern $ExpectedPublisherPattern -SkipOwn $SkipAlreadySigned)) {
    $toSignList.Add($file)
  }
}
$toSign = @($toSignList)

if ($toSign.Count -eq 0) {
  $signtoolExe = Find-SigntoolExe
  foreach ($file in $resolved) {
    Invoke-VerifySignature -SigntoolExe $signtoolExe -FilePath $file
  }
  Write-Host "All $($resolved.Count) target file(s) already validly signed and timestamped."
  exit 0
}

if ($resolvedProvider -eq "signpath") {
  $tempZip = Join-Path ([System.IO.Path]::GetTempPath()) "astranavi-signpath-$([System.Guid]::NewGuid().ToString('N')).zip"
  try {
    Compress-Archive -Path $toSign -DestinationPath $tempZip -Force
    $headers = @{ Authorization = "Bearer $spToken" }
    $submitUrl = "https://app.signpath.io/API/v1/$spOrg/Integrations/GitHub/SigningRequests"
    $form = @{
      ProjectSlug = $spProject
      SigningPolicySlug = $spPolicy
      ArtifactConfigurationSlug = $spArtifactConfig
      Artifact = Get-Item -Path $tempZip
    }
    $response = Invoke-RestMethod -Method Post -Uri $submitUrl -Headers $headers -Form $form
    Write-Host "Submitted $($toSign.Count) file(s) to SignPath Foundation (request: $($response | ConvertTo-Json -Compress))."
  } finally {
    Remove-Item -Path $tempZip -Force -ErrorAction SilentlyContinue
  }
  exit 0
}

$signtoolExe = Find-SigntoolExe

if ($resolvedProvider -eq "azure") {
  $dlibPath = $azDlib
  if ([string]::IsNullOrWhiteSpace($dlibPath) -or -not (Test-Path $dlibPath)) {
    $candidates = @(Get-ChildItem -Path @(
      "$env:RUNNER_TEMP\trusted-signing\Microsoft.Trusted.Signing.Client.*\bin\x64\Azure.CodeSigning.Dlib.dll",
      "$env:USERPROFILE\.nuget\packages\microsoft.trusted.signing.client\*\bin\x64\Azure.CodeSigning.Dlib.dll",
      "${env:ProgramFiles}\Microsoft Azure Artifact Signing\Client\x64\Azure.CodeSigning.Dlib.dll",
      "$env:LOCALAPPDATA\Microsoft\AzureArtifactSigning\Azure.CodeSigning.Dlib.dll",
      "tools\Azure.CodeSigning.Dlib.dll"
    ) -ErrorAction SilentlyContinue | Sort-Object FullName -Descending)
    if ($candidates.Count -gt 0) { $dlibPath = $candidates[0].FullName }
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
    foreach ($file in $toSign) {
      Invoke-SigntoolSignWithTsa `
        -SigntoolExe $signtoolExe `
        -BaseArgs @("/v", "/fd", "SHA256", "/dlib", $dlibPath, "/dmdf", $metaPath) `
        -TimestampServers $effectiveTimestampServers `
        -FilePath $file | Out-Null
    }
  } finally {
    Remove-Item -Path $metaPath -Force -ErrorAction SilentlyContinue
  }
  foreach ($file in $resolved) {
    Invoke-VerifySignature -SigntoolExe $signtoolExe -FilePath $file
  }
  Write-Host "Signed and verified $($toSign.Count) file(s) via Azure Artifact Signing (profile '$azProfile')."
  exit 0
}

if ($resolvedProvider -eq "self-signed-test") {
  $thumb = $env:ASTRA_NAVI_TEST_CERT_THUMBPRINT
  $existing = if (-not [string]::IsNullOrWhiteSpace($thumb)) {
    Get-Item -Path "Cert:\CurrentUser\My\$thumb" -ErrorAction SilentlyContinue
  } else {
    $null
  }
  if ($null -eq $existing) {
    $cert = New-SelfSignedCertificate `
      -Type CodeSigningCert `
      -Subject "CN=Astra Navi CI Signing Dry-Run (UNTRUSTED TEST)" `
      -CertStoreLocation "Cert:\CurrentUser\My" `
      -KeyExportPolicy NonExportable `
      -NotAfter (Get-Date).AddHours(72)
    $thumb = $cert.Thumbprint
    $tmpCer = Join-Path ([System.IO.Path]::GetTempPath()) "astranavi-ci-test-$thumb.cer"
    try {
      Export-Certificate -Cert $cert -FilePath $tmpCer | Out-Null
      $storeUsed = Import-TrustedRootCertificate -CerPath $tmpCer
    } finally {
      Remove-Item -Path $tmpCer -Force -ErrorAction SilentlyContinue
    }
    if ($env:GITHUB_ENV) {
      "ASTRA_NAVI_TEST_CERT_THUMBPRINT=$thumb" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
    }
    Write-Host "Created ephemeral 72h CI test signing certificate ($thumb) and trusted it in $storeUsed on this runner."
  } else {
    Write-Host "Reusing ephemeral CI test signing certificate ($thumb)."
  }
  foreach ($file in $toSign) {
    Invoke-SigntoolSignWithTsa `
      -SigntoolExe $signtoolExe `
      -BaseArgs @("/v", "/fd", "SHA256", "/sha1", $thumb) `
      -TimestampServers $effectiveTimestampServers `
      -FilePath $file | Out-Null
  }
  foreach ($file in $resolved) {
    Invoke-VerifySignature -SigntoolExe $signtoolExe -FilePath $file
  }
  Write-Host "Dry-run signed and verified $($toSign.Count) file(s) with ephemeral 72h test cert + RFC 3161 timestamp."
  exit 0
}

foreach ($file in $toSign) {
  $baseArgs = @("/v", "/fd", "SHA256", "/f", $pfx)
  if (-not [string]::IsNullOrEmpty($pass)) { $baseArgs += @("/p", $pass) }
  Invoke-SigntoolSignWithTsa `
    -SigntoolExe $signtoolExe `
    -BaseArgs $baseArgs `
    -TimestampServers $effectiveTimestampServers `
    -FilePath $file | Out-Null
}
foreach ($file in $resolved) {
  Invoke-VerifySignature -SigntoolExe $signtoolExe -FilePath $file
}
Write-Host "Signed and verified $($toSign.Count) file(s) via PFX certificate."
