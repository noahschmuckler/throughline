<#
.SYNOPSIS
  Probe the Optum cdsapi single_response endpoint to find out whether a model
  tier (esp. gpt-mini, the atomize 'reason' tier) is actually live.

.DESCRIPTION
  Throughline's atomize step calls cdsapi with tier 'reason' = gpt-mini. On a
  big braindump that call sometimes returns an HTTP 200 with an EMPTY body, and
  the app silently degrades to the heuristic draft (see T20/T30). This script
  reproduces that call directly so you can tell apart:
    - network/VPN down            (Step 1 TCP fails)
    - gpt-mini broken/decommed    (mini empty, gpt-5.4 works)
    - length/timeout issue        (mini ok short, empty on long)
    - gateway-wide problem        (everything empty)
    - JSON-suffix prompt issue    (plain ok, -Json empty)

  Mirrors shared/llm.js callCdsApi: POST {system:'',user,model,verbose:false},
  and in JSON mode appends the same "raw JSON only / Begin with {" suffix the
  app sends for atomize. ASCII-only on purpose (Windows PowerShell 5.1 reads
  BOM-less files as Win-1252, so Unicode chars would corrupt the parse).

.PARAMETER Url
  cdsapi endpoint. Defaults to the on-network gateway; pass your .env CDSAPI_URL
  if it overrides. Step 0 auto-reads .env if present.

.PARAMETER Model
  Override the model probed (default cycles the tiers).

.PARAMETER TimeoutSec
  Per-request timeout. Default 300.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\test-cdsapi.ps1
#>
[CmdletBinding()]
param(
  [string]$Url,
  [string]$Model,
  [int]$TimeoutSec = 300
)

$ErrorActionPreference = 'Continue'
$DefaultUrl = 'http://cdsapi.ms.ds.uhc.com:8080/single_response'

# ---- Step 0: discover URL/model from .env if present ----------------------
$envPath = Join-Path $env:USERPROFILE 'throughline\.env'
$envUrl = $null; $envModel = $null; $envProvider = $null
if (Test-Path $envPath) {
  Write-Host "Reading overrides from $envPath" -ForegroundColor DarkGray
  foreach ($line in Get-Content $envPath) {
    if ($line -match '^\s*CDSAPI_URL\s*=\s*(.+?)\s*$')   { $envUrl = $Matches[1].Trim('"').Trim("'") }
    if ($line -match '^\s*LLM_MODEL\s*=\s*(.+?)\s*$')    { $envModel = $Matches[1].Trim('"').Trim("'") }
    if ($line -match '^\s*LLM_PROVIDER\s*=\s*(.+?)\s*$') { $envProvider = $Matches[1].Trim('"').Trim("'") }
  }
} else {
  Write-Host "No .env at $envPath (using defaults)" -ForegroundColor DarkGray
}
if (-not $Url) { if ($envUrl) { $Url = $envUrl } else { $Url = $DefaultUrl } }

$provDisplay = if ($envProvider) { $envProvider } else { '(unset -> app would use heuristic!)' }

Write-Host ""
Write-Host "cdsapi probe" -ForegroundColor Cyan
Write-Host "  URL:          $Url"
Write-Host "  LLM_PROVIDER: $provDisplay"
if ($envModel) { Write-Host "  LLM_MODEL:    $envModel  (pins ALL tiers to this one model)" -ForegroundColor Yellow }
Write-Host ""

# ---- Step 1: reachability -------------------------------------------------
$uri = [System.Uri]$Url
Write-Host "[Step 1] TCP reachability to $($uri.Host):$($uri.Port) ..." -ForegroundColor Cyan
$tcp = Test-NetConnection -ComputerName $uri.Host -Port $uri.Port -WarningAction SilentlyContinue
if ($tcp.TcpTestSucceeded) {
  Write-Host "  TcpTestSucceeded: True  (gateway reachable, on-network)" -ForegroundColor Green
} else {
  Write-Host "  TcpTestSucceeded: False -> network/VPN problem, not the model. Stopping." -ForegroundColor Red
  return
}
Write-Host ""

# ---- helper: one probe ----------------------------------------------------
function Invoke-CdsProbe {
  param([string]$ProbeModel, [string]$User, [switch]$Json, [string]$Label)
  $u = $User
  if ($Json) {
    $u = "$User`n`nIMPORTANT: respond with raw JSON only - no prose, no markdown fences. Begin with { and end with }."
  }
  $payload = @{ system=''; user=$u; model=$ProbeModel; verbose=$false } | ConvertTo-Json -Compress
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $res = Invoke-WebRequest -Uri $Url -Method Post -ContentType 'application/json' -Body $payload -UseBasicParsing -TimeoutSec $TimeoutSec
    $sw.Stop()
    if ($res.Content) { $len = $res.Content.Length } else { $len = 0 }
    if ($len -gt 0) { $color = 'Green' } else { $color = 'Red' }
    $secs = $sw.Elapsed.TotalSeconds
    Write-Host ("  [{0,-22}] HTTP {1} | {2,6:n1}s | {3} chars" -f $Label, $res.StatusCode, $secs, $len) -ForegroundColor $color
    if ($len -gt 0) {
      $end = [Math]::Min(280, $len)
      $preview = $res.Content.Substring(0, $end) -replace '\s+', ' '
      Write-Host ("      body: {0}" -f $preview) -ForegroundColor DarkGray
    } else {
      Write-Host "      body: EMPTY -- this is the silent-degrade failure mode" -ForegroundColor DarkYellow
    }
  } catch {
    $sw.Stop()
    $secs = $sw.Elapsed.TotalSeconds
    Write-Host ("  [{0,-22}] ERROR after {1,6:n1}s: {2}" -f $Label, $secs, $_.Exception.Message) -ForegroundColor Red
  }
}

# ---- Step 2: the probes ---------------------------------------------------
$tiny = 'Reply with exactly the single word: pong.'
$para = "The team reviewed the urgent care dashboard, provider throughput, billing trends, and upcoming shift scheduling. "
$long = $para * 120   # ~13 KB, comparable to a real braindump

Write-Host "[Step 2] Model probes (per-request timeout ${TimeoutSec}s)" -ForegroundColor Cyan

if ($Model) {
  Invoke-CdsProbe -ProbeModel $Model -User $tiny -Label "$Model tiny"
  Invoke-CdsProbe -ProbeModel $Model -User ("Summarize this in one sentence:`n`n$long") -Label "$Model long"
  Invoke-CdsProbe -ProbeModel $Model -User ("Extract action items as JSON from:`n`n$long") -Json -Label "$Model long+json"
} else {
  Write-Host "  A) liveness -- does each tier answer a tiny prompt?" -ForegroundColor DarkCyan
  Invoke-CdsProbe -ProbeModel 'gpt-mini' -User $tiny -Label 'gpt-mini tiny'
  Invoke-CdsProbe -ProbeModel 'gpt-5.4'  -User $tiny -Label 'gpt-5.4 tiny'
  Invoke-CdsProbe -ProbeModel 'gpt-nano' -User $tiny -Label 'gpt-nano tiny'
  Write-Host "  C) length hypothesis -- does gpt-mini choke on a big dump?" -ForegroundColor DarkCyan
  Invoke-CdsProbe -ProbeModel 'gpt-mini' -User ("Summarize this in one sentence:`n`n$long") -Label 'gpt-mini long'
  Write-Host "  D) app replica -- gpt-mini in JSON mode on a big dump (the atomize call)" -ForegroundColor DarkCyan
  Invoke-CdsProbe -ProbeModel 'gpt-mini' -User ("Extract action items as JSON from:`n`n$long") -Json -Label 'gpt-mini long+json'
  Write-Host "     control -- gpt-5.4 on the same big dump (the escalate alternative)" -ForegroundColor DarkCyan
  Invoke-CdsProbe -ProbeModel 'gpt-5.4'  -User ("Summarize this in one sentence:`n`n$long") -Label 'gpt-5.4 long'
}

Write-Host ""
Write-Host "Verdict guide:" -ForegroundColor Cyan
Write-Host "  mini empty, 5.4 works         -> gpt-mini broken/decommed -> retire it (T30)"
Write-Host "  mini tiny ok, long/json empty -> length/timeout issue -> escalate atomize to 5.4"
Write-Host "  everything empty              -> gateway-wide; re-test before concluding"
Write-Host "  green = got a body; red 0 chars = the silent-degrade failure reproduced"
Write-Host ""
