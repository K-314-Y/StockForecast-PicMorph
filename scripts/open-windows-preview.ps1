# Windows viewer only. Development and Git pushes happen on Linux.
$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverScript = Join-Path $PSScriptRoot 'windows-preview-server.mjs'
$url = 'http://127.0.0.1:8891/game'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes'

function Assert-Exit($message) {
  if ($LASTEXITCODE -ne 0) { throw $message }
}

try {
  if (!(Test-Path (Join-Path $repo '.git'))) { throw 'Git mirror is missing.' }
  if (!(Test-Path $serverScript)) { throw 'Preview server script is missing.' }
  $remote = (& git -C $repo remote get-url origin).Trim()
  Assert-Exit 'Cannot read repository remote.'
  if ($remote -ne 'git@github.com:K-314-Y/StockForecast-PicMorph.git') {
    throw 'Unexpected repository remote. Refusing to synchronize.'
  }
  $branch = (& git -C $repo branch --show-current).Trim()
  Assert-Exit 'Cannot read repository branch.'
  if ($branch -ne 'main') { throw 'Viewer is not on the main branch.' }
  $edits = & git -C $repo status --porcelain
  Assert-Exit 'Cannot inspect viewer checkout.'
  if ($edits) { throw 'Viewer source has local changes. Will not overwrite them.' }

  Write-Host 'Checking Linux-developed source on GitHub (SSH)...'
  & git -C $repo fetch --quiet origin main
  if ($LASTEXITCODE -eq 0) {
    & git -C $repo merge --ff-only --quiet origin/main
    Assert-Exit 'Updates cannot be fast-forwarded. No source was overwritten.'
  } else {
    Write-Warning 'GitHub update unavailable; opening the last verified local copy.'
  }

  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8891 -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' })
  foreach($listener in $listeners) {
    $other = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction Stop
    $commandLine = [string]$other.CommandLine
    if ($commandLine -notlike '*windows-preview-server.mjs*' -or
        $commandLine -notlike "*$serverScript*") {
      throw 'Port 8891 belongs to another program. Refusing to close it.'
    }
    Stop-Process -Id $listener.OwningProcess -ErrorAction Stop
  }

  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $quotedScript='"' + $serverScript + '"'
  $p = Start-Process -FilePath $node -ArgumentList $quotedScript -WorkingDirectory $repo -WindowStyle Hidden -PassThru
  $ready = $false
  for($i=0; $i -lt 28; $i++) {
    Start-Sleep -Milliseconds 250
    if ($p.HasExited) { throw 'Preview server stopped unexpectedly.' }
    try {
      $response=Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing
      if ($response.StatusCode -eq 200 -and $response.Content -match 'Creature Lab') {
        $ready=$true
        break
      }
    } catch {}
  }
  if (!$ready) {
    if (!$p.HasExited) { Stop-Process -Id $p.Id -ErrorAction SilentlyContinue }
    throw 'Preview did not become healthy on localhost:8891.'
  }

  $hash=(& git -C $repo rev-parse --short HEAD).Trim()
  Write-Host "Windows preview ready. Git revision: $hash"
  Write-Host "Open: $url"
  $chrome = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Google\Chrome\Application\chrome.exe')
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($chrome) { Start-Process -FilePath $chrome -ArgumentList @($url) }
  else { Start-Process $url }
  exit 0
} catch {
  Write-Error ("Windows preview failed: " + $_.Exception.Message)
  exit 1
}
