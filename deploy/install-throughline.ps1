# Throughline orange-device installer ({{SHA}})
# Mirrors the atom_sandbox deployment pattern: tailscale -> iPhone -> OneDrive -> & <path>.
#
# Constraints baked in (per atom_sandbox project memory):
#   - Avoid using $pid as a loop variable (collides with the read-only $PID
#     auto-var; loop body is silently skipped). We use $ownerPid.
#   - Do not prefix absolute paths with $env: (it breaks resolution).
#   - Stop-ScheduledTask can leave the node child alive holding the port;
#     always kill the port owner before starting.
#
# Throughline differs from atom_sandbox in two ways that matter here:
#   - It has NO npm runtime deps (only node: builtins + global fetch), so there
#     is no node_modules to vendor and the install cannot break on deps.
#   - State lives in ONE json file at $env:THROUGHLINE_DB. On orange you point
#     that at a OneDrive shared folder so you and Natalia share one project DB.
#     The scheduled task therefore launches with `--env-file=.env` so the path
#     and provider you set in .env are picked up.
#
# Expects: a sibling directory throughline-{{SHA}}/ (or throughline/) on disk
# next to this script, containing the unzipped bundle.

$ErrorActionPreference = "Stop"

$Sha      = "{{SHA}}"
$AppName  = "throughline"
$TaskName = "ThroughlineServer"
$Port     = 8787
$Root     = Join-Path $env:USERPROFILE $AppName

Write-Host ""
Write-Host "Throughline installer ($Sha)" -ForegroundColor Cyan
Write-Host "------------------------------------------------------------------" -ForegroundColor Cyan

# --- 1. Locate the unzipped bundle next to this script ---
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Candidates = @(
  (Join-Path $ScriptDir "$AppName-$Sha"),
  (Join-Path $ScriptDir $AppName)
)
$Source = $null
foreach ($candidate in $Candidates) {
  if (Test-Path -LiteralPath $candidate -PathType Container) { $Source = $candidate; break }
}
if (-not $Source) {
  Write-Host "ERROR: could not find an extracted bundle at any of:" -ForegroundColor Red
  foreach ($c in $Candidates) { Write-Host "  - $c" -ForegroundColor Red }
  Write-Host "Extract throughline-$Sha.zip alongside this installer first." -ForegroundColor Red
  exit 1
}
Write-Host "Source: $Source"

# --- 2. Stop prior scheduled task if it exists ---
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Stopping prior scheduled task '$TaskName'..." -ForegroundColor Yellow
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

# --- 3. Kill any process holding port $Port (orphan node from prior run) ---
Write-Host "Checking port $Port for orphan process..."
try {
  $owners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($ownerPid in $owners) {
    Write-Host "  killing PID $ownerPid (port $Port owner)" -ForegroundColor Yellow
    Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
  }
} catch {
  Write-Host "  (no port owner found, or Get-NetTCPConnection unavailable)" -ForegroundColor DarkGray
}

# --- 4. Copy bundle into install location (preserve .env + any local data) ---
$envBackup = $null
$envPath   = Join-Path $Root '.env'
if (Test-Path -LiteralPath $envPath) {
  $envBackup = Get-Content -LiteralPath $envPath -Raw
  Write-Host "Preserving existing .env" -ForegroundColor DarkGray
}
if (Test-Path -LiteralPath $Root) {
  Write-Host "Removing prior install at $Root (keeping a .env copy)..." -ForegroundColor Yellow
  Remove-Item -LiteralPath $Root -Recurse -Force
}
Write-Host "Copying bundle to $Root..."
New-Item -Force -ItemType Directory -Path $Root | Out-Null
Copy-Item -Path (Join-Path $Source '*') -Destination $Root -Recurse -Force

# --- 5. .env handling ---
$envExamplePath = Join-Path $Root '.env.example'
if ($envBackup) {
  Set-Content -LiteralPath $envPath -Value $envBackup -NoNewline
  Write-Host "  restored your prior .env"
} elseif (Test-Path -LiteralPath $envExamplePath) {
  Copy-Item -LiteralPath $envExamplePath -Destination $envPath
  Write-Host "  created $envPath from .env.example" -ForegroundColor Yellow
  Write-Host "  >>> EDIT IT NOW: set THROUGHLINE_DB to your OneDrive path and LLM_PROVIDER=cdsapi <<<" -ForegroundColor Yellow
} else {
  Write-Host "  WARNING: no .env.example shipped; creating a minimal .env" -ForegroundColor Red
  Set-Content -LiteralPath $envPath -Value "THROUGHLINE_DB=./data/state.json`nPORT=$Port`nHOST=127.0.0.1`nLLM_PROVIDER=heuristic`n"
}

# --- 6. Verify Node is available ---
$NodeCmd = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $NodeCmd) {
  Write-Host "ERROR: 'node' not found on PATH. Install Node 20.6+ before running this installer." -ForegroundColor Red
  exit 1
}
$NodeVersion = (& node --version)
Write-Host "Node detected: $NodeVersion"

# --- 7. Register scheduled task: runs at logon, restarts on failure, no admin ---
# Launches with --env-file=.env so THROUGHLINE_DB + LLM_PROVIDER are loaded.
$Action    = New-ScheduledTaskAction -Execute "node.exe" -Argument "--env-file=.env server.js" -WorkingDirectory $Root
$Trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$Settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null
Write-Host "Scheduled task '$TaskName' registered (runs as $env:USERNAME at logon)" -ForegroundColor Green

# --- 8. Start it now ---
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

# --- 9. Verify port is up ---
$attempt = 0
$listening = $false
while ($attempt -lt 10) {
  $hit = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($hit) { $listening = $true; break }
  Start-Sleep -Seconds 1
  $attempt++
}
if ($listening) {
  Write-Host ""
  Write-Host "Throughline is up at http://127.0.0.1:$Port" -ForegroundColor Green
  Write-Host "  install root: $Root"
  Write-Host "  state DB:     whatever THROUGHLINE_DB points at in $Root\.env"
  Write-Host ""
  Write-Host "If you just created .env, edit it (THROUGHLINE_DB + LLM_PROVIDER) then run:" -ForegroundColor Yellow
  Write-Host "  Stop-ScheduledTask -TaskName $TaskName ; Start-ScheduledTask -TaskName $TaskName" -ForegroundColor Yellow
} else {
  Write-Host ""
  Write-Host "WARNING: port $Port did not come up within 10s. Check the task result:" -ForegroundColor Yellow
  Write-Host "  Get-ScheduledTaskInfo -TaskName $TaskName"
  Write-Host "  Get-WinEvent -LogName 'Microsoft-Windows-TaskScheduler/Operational' -MaxEvents 20"
  Write-Host "Common cause: .env has --env-file pointing at a missing file, or THROUGHLINE_DB folder doesn't exist yet."
}
