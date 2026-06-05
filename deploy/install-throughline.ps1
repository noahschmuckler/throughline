# Throughline orange-device installer ({{SHA}})
# A SELF-DOWNLOADING bootstrapper: the user downloads only THIS file (as
# install-throughline.ps1.txt → rename to .ps1), and it fetches the code bundle
# from the meridian-briefing distributor at run time. The zip never passes
# through the browser, so the browser/OneDrive .zip-download block is moot.
#
# Flow: download+verify+extract the bundle → register the ThroughlineServer
# logon task (node --env-file=.env server.js) → start it → open the browser at
# the in-app setup wizard, where the user picks their shared OneDrive folder
# (which writes .env and restarts the task). No PowerShell editing required.
#
# Constraints baked in (per atom_sandbox project memory):
#   - Avoid $pid as a loop var (collides with read-only $PID; body silently skipped).
#   - Do not prefix absolute paths with $env: (breaks resolution).
#   - Stop-ScheduledTask can leave the node child holding the port; kill it first.
#
# Throughline has NO npm runtime deps (node: builtins + global fetch), so there
# is no node_modules to vendor and the install cannot break on deps. State lives
# in ONE json file at THROUGHLINE_DB — on orange, a OneDrive shared folder, set
# by the setup wizard, not by hand.
#
# Switches:
#   -NoBrowser   skip opening the setup page (e.g. headless re-install)
#   -Insecure    skip TLS cert validation for the download (only if you trust the
#                host and hit a cert-trust error on a managed box)

param(
  [switch]$NoBrowser,
  [switch]$Insecure
)

$ErrorActionPreference = "Stop"

$Sha      = "{{SHA}}"
$AppName  = "throughline"
$TaskName = "ThroughlineServer"
$Port     = 8787
$Root     = Join-Path $env:USERPROFILE $AppName

# The distributor base URL (meridian-briefing on the CR DEV server). Override with
# $env:THROUGHLINE_BUNDLE_URL if the host/path differs.
$BundleBaseUrl = $env:THROUGHLINE_BUNDLE_URL
if (-not $BundleBaseUrl) { $BundleBaseUrl = "https://cdseastdev.ms.ds.uhc.com/throughline" }

$Tmp = Join-Path $env:TEMP ("throughline-dl-" + [Guid]::NewGuid().ToString("N"))
function Remove-Tmp {
  if ($Tmp -and (Test-Path -LiteralPath $Tmp)) {
    Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ""
Write-Host "Throughline installer ($Sha)" -ForegroundColor Cyan
Write-Host "------------------------------------------------------------------" -ForegroundColor Cyan

# --- 1. Download + verify + extract the bundle from the distributor ---
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($Insecure) {
  Write-Host "WARNING: -Insecure set; skipping TLS certificate validation." -ForegroundColor Yellow
  [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
}
$ZipUrl      = "$BundleBaseUrl/throughline-latest.zip"
$ManifestUrl = "$BundleBaseUrl/throughline-release.json"
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
$ZipPath = Join-Path $Tmp "throughline.zip"

# Expected hash (best-effort) — the manifest pins sha256 of the zip.
$ExpectedSha = $null
try {
  $manifest = Invoke-RestMethod -Uri $ManifestUrl -UseBasicParsing
  $ExpectedSha = $manifest.sha256
  Write-Host "Distributor reports version $($manifest.version) ($($manifest.sha))"
} catch {
  Write-Host "  (could not read release manifest; skipping hash check)" -ForegroundColor DarkGray
}

Write-Host "Downloading bundle from $ZipUrl ..."
try {
  Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipPath -UseBasicParsing
} catch {
  Write-Host "ERROR: could not download the bundle." -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  Is the CR DEV server reachable, and are you on the enterprise network?" -ForegroundColor Red
  Write-Host "  If this is a TLS/certificate error, re-run with -Insecure once you trust the host." -ForegroundColor Red
  Remove-Tmp; exit 1
}

if ($ExpectedSha) {
  $actual = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $ExpectedSha.ToLower()) {
    Write-Host "ERROR: bundle integrity check failed." -ForegroundColor Red
    Write-Host "  expected sha256 $ExpectedSha" -ForegroundColor Red
    Write-Host "  got      sha256 $actual" -ForegroundColor Red
    Write-Host "  The download may be incomplete or mid-publish — try again shortly." -ForegroundColor Red
    Remove-Tmp; exit 1
  }
  Write-Host "  integrity OK (sha256 verified)"
}

# Extract. bundle.sh zips files at the root (no wrapping dir), but tolerate a
# single wrapping subfolder just in case.
Expand-Archive -LiteralPath $ZipPath -DestinationPath $Tmp -Force
$Source = $null
if (Test-Path -LiteralPath (Join-Path $Tmp "server.js")) {
  $Source = $Tmp
} else {
  $sub = Get-ChildItem -LiteralPath $Tmp -Directory |
         Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "server.js") } |
         Select-Object -First 1
  if ($sub) { $Source = $sub.FullName }
}
if (-not $Source) {
  Write-Host "ERROR: the extracted bundle has no server.js." -ForegroundColor Red
  Remove-Tmp; exit 1
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
Remove-Tmp  # the bundle now lives in $Root; the download temp is no longer needed

# --- 5. .env handling (the setup wizard fills in ONEDRIVE_ROOT/THROUGHLINE_DB) ---
$envExamplePath = Join-Path $Root '.env.example'
if ($envBackup) {
  Set-Content -LiteralPath $envPath -Value $envBackup -NoNewline
  Write-Host "  restored your prior .env"
} elseif (Test-Path -LiteralPath $envExamplePath) {
  Copy-Item -LiteralPath $envExamplePath -Destination $envPath
  Write-Host "  created $envPath from .env.example (the setup screen finishes config)"
} else {
  Write-Host "  WARNING: no .env.example shipped; creating a minimal .env" -ForegroundColor Red
  Set-Content -LiteralPath $envPath -Value "THROUGHLINE_DB=./data/state.json`nPORT=$Port`nHOST=127.0.0.1`nLLM_PROVIDER=heuristic`n"
}

# --- 6. Verify Node is available ---
$NodeCmd = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $NodeCmd) {
  Write-Host "ERROR: 'node' not found on PATH. Install Node 20.6+ (company app store) before running this installer." -ForegroundColor Red
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

# --- 9. Verify port is up, then open the setup wizard ---
$attempt = 0
$listening = $false
while ($attempt -lt 10) {
  $hit = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($hit) { $listening = $true; break }
  Start-Sleep -Seconds 1
  $attempt++
}
if ($listening) {
  $setupUrl = "http://127.0.0.1:$Port/#/setup"
  Write-Host ""
  Write-Host "Throughline is up at http://127.0.0.1:$Port" -ForegroundColor Green
  Write-Host "  install root: $Root"
  if (-not $NoBrowser -and $env:THROUGHLINE_OPEN_DRYRUN -ne '1') {
    Write-Host "Opening the setup screen — pick your shared OneDrive folder there." -ForegroundColor Cyan
    Start-Process $setupUrl
  } else {
    Write-Host "Open $setupUrl and pick your shared OneDrive folder to finish setup." -ForegroundColor Cyan
  }
} else {
  Write-Host ""
  Write-Host "WARNING: port $Port did not come up within 10s. Check the task result:" -ForegroundColor Yellow
  Write-Host "  Get-ScheduledTaskInfo -TaskName $TaskName"
  Write-Host "  Get-WinEvent -LogName 'Microsoft-Windows-TaskScheduler/Operational' -MaxEvents 20"
  Write-Host "Common cause: Node missing, or the bundle didn't copy. Re-run this installer."
}
