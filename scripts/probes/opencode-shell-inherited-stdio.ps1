# Shell inherited-stdio regression for the bundled Codey OpenCode backend.
#
# Starts the bundled `opencode serve`, creates a session, and drives the public
# `POST /session/:id/shell` endpoint with a command that:
#   foreground process -> spawns a detached descendant -> descendant inherits
#   stdout/stderr -> descendant stays alive ~15s -> foreground exits immediately.
#
# The endpoint must return well before the descendant's lifetime (the bug waited
# for stdio EOF), and the foreground stdout marker must be preserved.
#
# Uses only the bundled binary: never the system PATH.
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Bin = if ($env:CODEY_OPENCODE_BIN) { $env:CODEY_OPENCODE_BIN } else { Join-Path $Root 'vendor\opencode\opencode.exe' }
if (-not (Test-Path $Bin)) {
  throw "OpenCode binary not found: $Bin. Run pnpm prepare:opencode first."
}

$Version = (& $Bin --version 2>&1 | Select-Object -First 1).ToString().Trim()
if ($Version -notmatch '1\.18\.31') { throw "Expected OpenCode 1.18.31, got: $Version" }

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { throw 'node executable not found on PATH (required to launch the detached descendant fixture).' }

$DescendantHoldMs = 15000
$MaxReturnMs = 5000

$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ("codey-opencode-shell-hang-" + [guid]::NewGuid().ToString('N'))
$Workspace = Join-Path $Temp 'workspace'
$Data = Join-Path $Temp 'data'
$Config = Join-Path $Temp 'config'
$Cache = Join-Path $Temp 'cache'
$Stdout = Join-Path $Temp 'stdout.log'
$Stderr = Join-Path $Temp 'stderr.log'
New-Item -ItemType Directory -Force -Path $Workspace, $Data, $Config, $Cache | Out-Null

$Detach = Join-Path $Temp 'detach.cjs'
$PidFile = Join-Path $Temp 'grandchild.pid'
$DetachSource = @"
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const pidFile = process.argv[2]
const holdMs = Number(process.argv[3] || "15000")
const code = 'process.stdout.write("grandchild-out\\n"); setTimeout(() => process.exit(0), ' + holdMs + ")"
const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: ["ignore", "inherit", "inherit"] })
child.unref()
fs.writeFileSync(pidFile, String(child.pid))
process.stdout.write("foreground-out\n")
process.exit(0)
"@
Set-Content -Path $Detach -Value $DetachSource -Encoding ASCII

$Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$Listener.Start()
$Port = ([System.Net.IPEndPoint]$Listener.LocalEndpoint).Port
$Listener.Stop()

$Password = [guid]::NewGuid().ToString('N')
$Old = @{
  XDG_DATA_HOME = $env:XDG_DATA_HOME
  XDG_CONFIG_HOME = $env:XDG_CONFIG_HOME
  XDG_CACHE_HOME = $env:XDG_CACHE_HOME
  OPENCODE_SERVER_USERNAME = $env:OPENCODE_SERVER_USERNAME
  OPENCODE_SERVER_PASSWORD = $env:OPENCODE_SERVER_PASSWORD
  OPENCODE_CONFIG_CONTENT = $env:OPENCODE_CONFIG_CONTENT
  OPENCODE_DISABLE_AUTOUPDATE = $env:OPENCODE_DISABLE_AUTOUPDATE
}
$Process = $null
$GrandchildPid = $null

try {
  $env:XDG_DATA_HOME = $Data
  $env:XDG_CONFIG_HOME = $Config
  $env:XDG_CACHE_HOME = $Cache
  $env:OPENCODE_SERVER_USERNAME = 'codey'
  $env:OPENCODE_SERVER_PASSWORD = $Password
  $env:OPENCODE_CONFIG_CONTENT = '{"autoupdate":false,"share":"disabled"}'
  $env:OPENCODE_DISABLE_AUTOUPDATE = '1'

  $Process = Start-Process -FilePath $Bin -ArgumentList @('serve','--hostname=127.0.0.1',"--port=$Port",'--log-level=WARN') `
    -WorkingDirectory $Workspace -WindowStyle Hidden -PassThru -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr

  $Base = "http://127.0.0.1:$Port"
  $Token = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("codey:$Password"))
  $Auth = @{ Authorization = "Basic $Token" }
  $Ready = $false
  for ($i = 0; $i -lt 150; $i++) {
    if ($Process.HasExited) {
      $err = if (Test-Path $Stderr) { Get-Content $Stderr -Raw } else { '' }
      throw "OpenCode exited before health check. $err"
    }
    try {
      $Health = Invoke-RestMethod -Uri "$Base/global/health" -Headers $Auth -Method Get -TimeoutSec 2
      if ($Health.healthy -eq $true) { $Ready = $true; break }
    } catch { Start-Sleep -Milliseconds 100 }
  }
  if (-not $Ready) { throw 'Timed out waiting for OpenCode health endpoint.' }
  if ($Health.version -ne '1.18.31') { throw "Health version mismatch: $($Health.version)" }

  $Directory = [uri]::EscapeDataString($Workspace)
  $Headers = @{
    Authorization = "Basic $Token"
    'x-opencode-directory' = $Directory
    'Content-Type' = 'application/json'
  }

  $Session = Invoke-RestMethod -Uri "$Base/session" -Headers $Headers -Method Post -Body '{"title":"Codey shell hang probe"}'
  if (-not $Session.id) { throw 'Session create returned no id.' }

  $Command = '& ' + (@($Node, $Detach, $PidFile) | ForEach-Object { '"' + ($_ -replace '\\','/') + '"' }) -join ' '
  $Body = @{ agent = 'build'; command = $Command } | ConvertTo-Json -Compress

  Write-Host "Descendant lifetime: $DescendantHoldMs ms; endpoint budget: $MaxReturnMs ms"
  $Started = [System.Diagnostics.Stopwatch]::StartNew()
  $Response = Invoke-WebRequest -Uri "$Base/session/$($Session.id)/shell" -Headers $Headers -Method Post -Body $Body -UseBasicParsing -TimeoutSec 120
  $Started.Stop()
  $ElapsedMs = [int]$Started.ElapsedMilliseconds
  $Content = $Response.Content

  if (Test-Path $PidFile) { $GrandchildPid = [int](Get-Content $PidFile -Raw).Trim() }

  $HasMarker = $Content -match 'foreground-out'
  Write-Host "HTTP status: $($Response.StatusCode)"
  Write-Host "Elapsed: $ElapsedMs ms"
  Write-Host "Foreground marker preserved: $HasMarker"

  if (-not $HasMarker) { throw 'Foreground stdout marker missing from shell output.' }
  if ($ElapsedMs -ge $MaxReturnMs) {
    throw "Shell endpoint waited $ElapsedMs ms, which is not below $MaxReturnMs ms; inherited-stdio hang is NOT fixed."
  }

  Write-Host "PASS shell endpoint returned in $ElapsedMs ms (descendant lived ${DescendantHoldMs} ms)"
}
finally {
  if ($GrandchildPid) { Stop-Process -Id $GrandchildPid -Force -ErrorAction SilentlyContinue }
  if ($Process -and -not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    try { $Process.WaitForExit(3000) } catch {}
  }
  foreach ($key in $Old.Keys) {
    [Environment]::SetEnvironmentVariable($key, $Old[$key], 'Process')
  }
  Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}
