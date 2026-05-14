#Requires -Version 5.1
<#
.SYNOPSIS
    Windows orchestrator launcher — bridges multiple IDE windows simultaneously.

.DESCRIPTION
    Starts the meta-bridge that coordinates multiple IDE windows. Each IDE window
    must already have the claude-ide-bridge extension running — this script
    connects to them all via the orchestrator mode.

    Run via npm:
        npm run start-orchestrator:win

    Or directly:
        pwsh -File scripts\start-orchestrator.ps1
        pwsh -File scripts\start-orchestrator.ps1 -Port 4746 -Verbose

.PARAMETER Port
    Orchestrator port (default: 4746).

.PARAMETER Notify
    ntfy.sh topic for push notifications (optional).

.PARAMETER Verbose
    Enable verbose orchestrator logging.
#>
[CmdletBinding()]
param(
    [int]   $Port    = 4746,
    [string]$Notify  = "",
    [switch]$VerboseLogging
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$BridgeDir  = Split-Path -Parent $ScriptDir

function Write-Status($msg) { Write-Host "[orchestrator] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)     { Write-Host "[ok] $msg"           -ForegroundColor Green }
function Write-Warn($msg)   { Write-Host "[warn] $msg"         -ForegroundColor Yellow }

function Send-Notify($msg) {
    if (-not $Notify) { return }
    try {
        Invoke-RestMethod -Uri "https://ntfy.sh/$Notify" -Method Post -Body $msg -TimeoutSec 5 | Out-Null
    } catch { Write-Warn "ntfy notification failed: $_" }
}

$Jobs = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Stop-AllJobs {
    foreach ($p in $Jobs) {
        if (-not $p.HasExited) { try { $p.Kill($true) } catch { } }
    }
}

$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { Stop-AllJobs }

# ── Dependency check ──────────────────────────────────────────────────────────
$claudeFound = $false
try {
    $null = & where.exe claude 2>$null
    $claudeFound = $true
} catch { }

if (-not $claudeFound) {
    Write-Error "claude CLI not found on PATH. Install from https://docs.anthropic.com/en/docs/claude-code"
    exit 1
}

# ── Build orchestrator args ───────────────────────────────────────────────────
$orchArgs = @("orchestrator", "--port", $Port)
if ($VerboseLogging) { $orchArgs += "--verbose" }

# Use dist/ (npm install) or fallback message
$distIndex = Join-Path $BridgeDir "dist\index.js"
if (-not (Test-Path $distIndex)) {
    Write-Error "dist/index.js not found. Run 'npm run build' first."
    exit 1
}

# ── Start orchestrator bridge ─────────────────────────────────────────────────
Write-Status "Starting orchestrator bridge on port $Port..."

$orchInfo = New-Object System.Diagnostics.ProcessStartInfo
$orchInfo.FileName         = "cmd.exe"
$orchInfo.Arguments        = "/c node `"$distIndex`" " + ($orchArgs -join " ")
$orchInfo.UseShellExecute  = $false
$orchInfo.WorkingDirectory = $BridgeDir
$orchProc = [System.Diagnostics.Process]::Start($orchInfo)
$Jobs.Add($orchProc)

# ── Wait for lock file ────────────────────────────────────────────────────────
$ClaudeBase = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".claude" }
$IdeDir   = Join-Path $ClaudeBase "ide"
$LockFile = Join-Path $IdeDir "$Port.lock"
$Deadline = (Get-Date).AddSeconds(20)

Write-Status "Waiting for orchestrator lock file..."
while ((Get-Date) -lt $Deadline -and -not (Test-Path $LockFile)) {
    Start-Sleep -Milliseconds 200
}

if (-not (Test-Path $LockFile)) {
    Write-Error "Orchestrator lock file not written after 20s. Bridge may have failed to start."
    Stop-AllJobs
    exit 1
}

try {
    $lockContent = Get-Content $LockFile -Raw | ConvertFrom-Json
    $token = $lockContent.authToken
} catch {
    $token = "(unknown)"
}

Write-Ok "Orchestrator ready on port $Port"
Send-Notify "Orchestrator started on port $Port"

# ── Start Claude --ide ────────────────────────────────────────────────────────
Write-Status "Starting claude --ide (connects to orchestrator)..."

$claudeEnv = [System.Collections.Generic.Dictionary[string,string]]::new()
foreach ($entry in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) {
    $claudeEnv[$entry.Key] = $entry.Value
}
$claudeEnv["CLAUDE_CODE_IDE_SKIP_VALID_CHECK"] = "true"

$claudeInfo = New-Object System.Diagnostics.ProcessStartInfo
$claudeInfo.FileName         = "cmd.exe"
$claudeInfo.Arguments        = "/c claude --ide"
$claudeInfo.UseShellExecute  = $false
foreach ($kv in $claudeEnv.GetEnumerator()) {
    $claudeInfo.EnvironmentVariables[$kv.Key] = $kv.Value
}
$claudeProc = [System.Diagnostics.Process]::Start($claudeInfo)
$Jobs.Add($claudeProc)

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Ok "Orchestrator running. Press Ctrl+C to stop all processes."
Write-Host "  Orchestrator PID : $($orchProc.Id)"
Write-Host "  Claude PID       : $($claudeProc.Id)"
Write-Host "  Port             : $Port"
Write-Host "  Token            : $($token.Substring(0, [Math]::Min(8, $token.Length)))..."
Write-Host ""
Write-Host "Each IDE window with the bridge extension running will be discovered"
Write-Host "automatically. Type /ide in Claude Code to verify the connection."
Write-Host ""

try {
    $orchProc.WaitForExit()
} finally {
    Write-Status "Orchestrator exited — stopping all processes..."
    Stop-AllJobs
}
