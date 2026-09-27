$ErrorActionPreference = 'Stop'

# Codey's pinned backend artifact.
#
# This is NOT the official OpenCode release archive. It is our own immutable
# build: official OpenCode 1.18.31 plus the Windows inherited-stdio shell fixes
# from StupidArthur/opencode-fork:
#   93dbf6f64cbf6402549289cf2eb56ee4c2474c57  ShellTool / cross-spawn
#   cf50cd4e9294aaf260e0742ffffefca9181fd64d  public /session/:id/shell
# The release tag is pinned so the URL can never drift to "latest"; both the
# archive and the extracted binary are verified against fixed SHA-256 digests.
$Version = '1.18.31'
$Repo = 'StupidArthur/opencode-fork'
$ReleaseTag = 'codey-opencode-v1.18.31-p1'
$AssetName = 'opencode-windows-x64-codey.zip'
$Url = "https://github.com/$Repo/releases/download/$ReleaseTag/$AssetName"
$ExpectedZipSha256 = '7E311D2AFAA775F705CB251524F48A57FE0D1336D7EA0261E8E9C4C48F272AA5'
$ExpectedExeSha256 = '03CA853EAAE717FA45A5E8BC180707F865E82F7DF6089816EBAA6988B67D259A'

$Root = Split-Path -Parent $PSScriptRoot
$VendorDir = Join-Path $Root 'vendor\opencode'
$Target = Join-Path $VendorDir 'opencode.exe'

New-Item -ItemType Directory -Force -Path $VendorDir | Out-Null

if (Test-Path $Target) {
  $ExistingSha = (Get-FileHash -Algorithm SHA256 $Target).Hash.ToUpperInvariant()
  if ($ExistingSha -eq $ExpectedExeSha256) {
    $Current = (& $Target --version 2>$null | Select-Object -First 1).ToString().Trim()
    if ($Current -match [regex]::Escape($Version)) {
      Write-Host "Codey OpenCode $Version already prepared: $Target"
      exit 0
    }
  }
  Remove-Item -Force $Target
}

$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codey-opencode-" + [guid]::NewGuid().ToString('N'))
$Zip = Join-Path $TempRoot 'opencode.zip'
$Extract = Join-Path $TempRoot 'extract'
New-Item -ItemType Directory -Force -Path $Extract | Out-Null

try {
  Write-Host "Downloading Codey OpenCode $Version backend ($Repo@$ReleaseTag)..."
  try {
    Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing
  } catch {
    throw "Download failure: could not download $Url. $($_.Exception.Message)"
  }

  $ActualZip = (Get-FileHash -Algorithm SHA256 $Zip).Hash.ToUpperInvariant()
  if ($ActualZip -ne $ExpectedZipSha256) {
    throw "Checksum mismatch: archive SHA256 $ActualZip does not match pinned $ExpectedZipSha256"
  }

  Expand-Archive -Path $Zip -DestinationPath $Extract -Force
  $Exe = Get-ChildItem -Path $Extract -Filter 'opencode.exe' -File -Recurse | Select-Object -First 1
  if (-not $Exe) {
    throw 'Binary missing: the pinned artifact archive did not contain opencode.exe'
  }

  Copy-Item -Force $Exe.FullName $Target

  $ActualExe = (Get-FileHash -Algorithm SHA256 $Target).Hash.ToUpperInvariant()
  if ($ActualExe -ne $ExpectedExeSha256) {
    Remove-Item -Force $Target -ErrorAction SilentlyContinue
    throw "Checksum mismatch: extracted opencode.exe SHA256 $ActualExe does not match pinned $ExpectedExeSha256"
  }

  $Current = (& $Target --version 2>&1 | Select-Object -First 1).ToString().Trim()
  if ($Current -notmatch [regex]::Escape($Version)) {
    Remove-Item -Force $Target -ErrorAction SilentlyContinue
    throw "Version mismatch: prepared binary reports '$Current', expected $Version"
  }

  Write-Host "Prepared Codey OpenCode $Version ($Repo@$ReleaseTag) at $Target"
  Write-Host "opencode.exe SHA256: $ActualExe"
}
finally {
  Remove-Item -Recurse -Force $TempRoot -ErrorAction SilentlyContinue
}
