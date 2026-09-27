$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Bin = if ($env:CODEY_OPENCODE_BIN) { $env:CODEY_OPENCODE_BIN } else { Join-Path $Root 'vendor\opencode\opencode.exe' }
if (-not (Test-Path $Bin)) {
  throw "OpenCode binary not found: $Bin. Run pnpm prepare:opencode first."
}

$Version = (& $Bin --version 2>&1 | Select-Object -First 1).ToString().Trim()
if ($Version -notmatch '1\.18\.31') { throw "Expected OpenCode 1.18.31, got: $Version" }

$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ("codey-opencode-smoke-" + [guid]::NewGuid().ToString('N'))
$Workspace = Join-Path $Temp 'workspace'
$Data = Join-Path $Temp 'data'
$Config = Join-Path $Temp 'config'
$Cache = Join-Path $Temp 'cache'
$Stdout = Join-Path $Temp 'stdout.log'
$Stderr = Join-Path $Temp 'stderr.log'
New-Item -ItemType Directory -Force -Path $Workspace,$Data,$Config,$Cache | Out-Null

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
  $Headers = @{ Authorization = "Basic $Token" }
  $Ready = $false
  for ($i = 0; $i -lt 150; $i++) {
    if ($Process.HasExited) {
      $err = if (Test-Path $Stderr) { Get-Content $Stderr -Raw } else { '' }
      throw "OpenCode exited before health check. $err"
    }
    try {
      $Health = Invoke-RestMethod -Uri "$Base/global/health" -Headers $Headers -Method Get -TimeoutSec 2
      if ($Health.healthy -eq $true) { $Ready = $true; break }
    } catch { Start-Sleep -Milliseconds 100 }
  }
  if (-not $Ready) { throw 'Timed out waiting for OpenCode health endpoint.' }
  if ($Health.version -ne '1.18.31') { throw "Health version mismatch: $($Health.version)" }

  $Directory = [uri]::EscapeDataString($Workspace)
  $InstanceHeaders = @{
    Authorization = "Basic $Token"
    'x-opencode-directory' = $Directory
    'Content-Type' = 'application/json'
  }
  $Session = Invoke-RestMethod -Uri "$Base/session" -Headers $InstanceHeaders -Method Post -Body '{"title":"Codey smoke"}'
  if (-not $Session.id) { throw 'Session create returned no id.' }

  $Fetched = Invoke-RestMethod -Uri "$Base/session/$($Session.id)" -Headers $InstanceHeaders -Method Get
  if ($Fetched.id -ne $Session.id) { throw 'Session get returned a different id.' }

  $Abort = Invoke-RestMethod -Uri "$Base/session/$($Session.id)/abort" -Headers $InstanceHeaders -Method Post
  Write-Host "PASS OpenCode $($Health.version) health"
  Write-Host "PASS session create/get $($Session.id)"
  Write-Host "PASS session abort endpoint returned $Abort"
}
finally {
  if ($Process -and -not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    try { $Process.WaitForExit(3000) } catch {}
  }
  foreach ($key in $Old.Keys) {
    [Environment]::SetEnvironmentVariable($key, $Old[$key], 'Process')
  }
  Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}
