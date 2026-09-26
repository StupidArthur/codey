$ErrorActionPreference = 'Stop'

$Version = '1.18.31'
$ExpectedSha256 = '0ECD7FFC7F26390CE7799E7BCD409E4F11C410144308A6A5B0FCDCE63D871006'
$Url = "https://github.com/anomalyco/opencode/releases/download/v$Version/opencode-windows-x64.zip"
$Root = Split-Path -Parent $PSScriptRoot
$VendorDir = Join-Path $Root 'vendor\opencode'
$Target = Join-Path $VendorDir 'opencode.exe'

New-Item -ItemType Directory -Force -Path $VendorDir | Out-Null

if (Test-Path $Target) {
  $Current = (& $Target --version 2>$null | Select-Object -First 1).Trim()
  if ($Current -match [regex]::Escape($Version)) {
    Write-Host "OpenCode $Version already prepared: $Target"
    exit 0
  }
  Remove-Item -Force $Target
}

$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codey-opencode-" + [guid]::NewGuid().ToString('N'))
$Zip = Join-Path $TempRoot 'opencode.zip'
$Extract = Join-Path $TempRoot 'extract'
New-Item -ItemType Directory -Force -Path $Extract | Out-Null

try {
  Write-Host "Downloading OpenCode v$Version..."
  Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing

  $Actual = (Get-FileHash -Algorithm SHA256 $Zip).Hash.ToUpperInvariant()
  if ($Actual -ne $ExpectedSha256) {
    throw "OpenCode archive checksum mismatch. Expected $ExpectedSha256, got $Actual"
  }

  Expand-Archive -Path $Zip -DestinationPath $Extract -Force
  $Exe = Get-ChildItem -Path $Extract -Filter 'opencode.exe' -File -Recurse | Select-Object -First 1
  if (-not $Exe) {
    throw 'Official OpenCode archive did not contain opencode.exe'
  }

  Copy-Item -Force $Exe.FullName $Target
  $Current = (& $Target --version 2>&1 | Select-Object -First 1).ToString().Trim()
  if ($Current -notmatch [regex]::Escape($Version)) {
    throw "Prepared OpenCode binary reports unexpected version: $Current"
  }
  Write-Host "Prepared OpenCode $Version at $Target"
}
finally {
  Remove-Item -Recurse -Force $TempRoot -ErrorAction SilentlyContinue
}
