# Throughline - register the auto-start scheduled task, running IN PLACE from
# this git clone (no file copying). This is the right path when the repo is
# cloned via GitHub Desktop: to update later you just Sync, then restart the
# task. Run it from inside the clone:
#
#   cd C:\Users\<you>\Documents\GitHub\throughline
#   powershell -ExecutionPolicy Bypass -File deploy\register-task.ps1
#
# ASCII-only / no here-strings so encoding + line endings don't matter.

$ErrorActionPreference = "Stop"

$TaskName = "ThroughlineServer"
$Port     = 8787

# Repo root = the parent of this script's folder (deploy\).
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path (Join-Path $ScriptDir "..")).Path

Write-Host ""
Write-Host "Throughline task setup (in-place from clone)" -ForegroundColor Cyan
Write-Host "------------------------------------------------------------------" -ForegroundColor Cyan
Write-Host "Repo root: $Root"

# --- 1. Sanity: is this actually the throughline clone? ---
if (-not (Test-Path -LiteralPath (Join-Path $Root "server.js"))) {
  Write-Host "ERROR: server.js not found in $Root." -ForegroundColor Red
  Write-Host "Run this from deploy\ inside the cloned repo, after a GitHub Desktop Sync." -ForegroundColor Red
  exit 1
}

# --- 2. Node present and new enough for --env-file (20.6+)? ---
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
  Write-Host "ERROR: 'node' not on PATH. Install Node 20.6+ (LTS) and reopen the terminal." -ForegroundColor Red
  exit 1
}
$verRaw = (& node --version).TrimStart('v')   # e.g. 20.11.1
$verParts = $verRaw.Split('.')
$major = [int]$verParts[0]; $minor = [int]$verParts[1]
Write-Host "Node: v$verRaw"
if ($major -lt 20 -or ($major -eq 20 -and $minor -lt 6)) {
  Write-Host "ERROR: Node v$verRaw is too old. The task launches with --env-file, which needs Node 20.6+." -ForegroundColor Red
  Write-Host "Update Node and re-run." -ForegroundColor Red
  exit 1
}

# --- 3. .env: create from example if missing (gitignored, never synced) ---
$envPath    = Join-Path $Root ".env"
$envExample = Join-Path $Root ".env.example"
if (-not (Test-Path -LiteralPath $envPath)) {
  Copy-Item -LiteralPath $envExample -Destination $envPath
  Write-Host ""
  Write-Host "Created .env from .env.example. EDIT IT before relying on it:" -ForegroundColor Yellow
  Write-Host "  THROUGHLINE_DB = your OneDrive shared path, e.g." -ForegroundColor Yellow
  Write-Host "    C:\Users\$env:USERNAME\OneDrive - <org>\Throughline\state.json" -ForegroundColor Yellow
  Write-Host "  LLM_PROVIDER = cdsapi" -ForegroundColor Yellow
  Write-Host ""
} else {
  Write-Host ".env already present (preserved)."
}

# --- 4. Stop a prior task + free the port (orphan-node gotcha) ---
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Stopping prior '$TaskName'..." -ForegroundColor Yellow
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}
try {
  $owners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($ownerPid in $owners) {
    Write-Host "  killing PID $ownerPid (port $Port owner)" -ForegroundColor Yellow
    Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
  }
} catch {
  Write-Host "  (no port owner found)" -ForegroundColor DarkGray
}

# --- 5. Register the task: runs node from the clone dir at every logon ---
$Action    = New-ScheduledTaskAction -Execute "node.exe" -Argument "--env-file=.env server.js" -WorkingDirectory $Root
$Trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$Settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null
Write-Host "Task '$TaskName' registered (runs as $env:USERNAME at logon, from the clone)." -ForegroundColor Green

# --- 6. Start + verify ---
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
$attempt = 0; $listening = $false
while ($attempt -lt 10) {
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $listening = $true; break }
  Start-Sleep -Seconds 1; $attempt++
}
Write-Host ""
if ($listening) {
  Write-Host "Throughline is up at http://127.0.0.1:$Port" -ForegroundColor Green
} else {
  Write-Host "WARNING: port $Port did not come up in 10s." -ForegroundColor Yellow
  Write-Host "  Check: Get-ScheduledTaskInfo -TaskName $TaskName" -ForegroundColor Yellow
  Write-Host "  Common cause: .env's THROUGHLINE_DB folder doesn't exist yet - create the OneDrive Throughline\ folder first." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "To UPDATE later: GitHub Desktop -> Sync, then:" -ForegroundColor Cyan
Write-Host "  Stop-ScheduledTask -TaskName $TaskName ; Start-ScheduledTask -TaskName $TaskName" -ForegroundColor Cyan
