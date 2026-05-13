#Requires -Version 5.1
<#
.SYNOPSIS
    Windows orchestrator for bridge + Claude + Patchwork dashboard.

.DESCRIPTION
    Cross-platform alternative to start-all.sh for native Windows (PowerShell/cmd).
    Starts the bridge, waits for the lock file, launches Claude --ide, and
    optionally starts the Patchwork dashboard dev server and opens it in the browser.

    Run via npm:
        npm run start:bridge          # bridge only (simplest)
        npm run start-all:win         # full orchestrator (bridge + claude + dashboard)

    Or directly:
        pwsh -File scripts\start-all.ps1
        pwsh -File scripts\start-all.ps1 --no-dashboard
        pwsh -File scripts\start-all.ps1 --workspace C:\my\project --dashboard-port 3200

.PARAMETER Workspace
    Directory to open in Claude (default: current directory).

.PARAMETER Full
    Pass --full to the bridge, registering all ~95 tools including git/terminal/file ops.
    Default is slim mode (27 IDE-exclusive tools).

.PARAMETER NoDashboard
    Skip starting the Patchwork dashboard.

.PARAMETER DashboardPort
    Port for the Next.js dashboard dev server (default: 3200).

.PARAMETER BridgePort
    Port for the bridge (default: auto-assigned via lock file).

.PARAMETER Notify
    ntfy.sh topic for push notifications (optional).
#>
[CmdletBinding()]
param(
    [string]$Workspace       = ".",
    [switch]$Full,
    [switch]$NoDashboard,
    [int]   $DashboardPort   = 3200,
    [int]   $BridgePort      = 0,
    [string]$Notify          = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Resolve paths ─────────────────────────────────────────────────────────────
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$BridgeDir   = Split-Path -Parent $ScriptDir
$DashboardDir = Join-Path $BridgeDir "dashboard"

try {
    $Workspace = (Resolve-Path $Workspace).Path
} catch {
    Write-Error "Workspace directory not found: $Workspace"
    exit 1
}

# ── Helpers ───────────────────────────────────────────────────────────────────
function Write-Status($msg) { Write-Host "[orchestrator] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)     { Write-Host "[ok] $msg"           -ForegroundColor Green }
function Write-Warn($msg)   { Write-Host "[warn] $msg"         -ForegroundColor Yellow }

function Send-Notify($msg) {
    if (-not $Notify) { return }
    try {
        Invoke-RestMethod -Uri "https://ntfy.sh/$Notify" -Method Post -Body $msg -TimeoutSec 5 | Out-Null
    } catch { Write-Warn "ntfy notification failed: $_" }
}

# ── Track child processes for cleanup ─────────────────────────────────────────
$Jobs = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Stop-AllJobs {
    foreach ($p in $Jobs) {
        if (-not $p.HasExited) {
            try { $p.Kill($true) } catch { }
        }
    }
}

# Clean up on Ctrl+C or exit
$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { Stop-AllJobs }
try { [Console]::TreatControlCAsInput = $false } catch { }

# ── Build bridge args ─────────────────────────────────────────────────────────
$BridgeArgs = @("--workspace", $Workspace)
if ($BridgePort -gt 0) { $BridgeArgs += @("--port", $BridgePort) }
if ($Full)             { $BridgeArgs += "--full" }

# ── Start bridge ──────────────────────────────────────────────────────────────
Write-Status "Starting bridge (workspace: $Workspace)..."

$BridgeInfo = New-Object System.Diagnostics.ProcessStartInfo
$BridgeInfo.UseShellExecute = $false
# On Windows, npm global bins are .cmd wrappers — must invoke via cmd.exe.
# Quote each argument so workspace paths with spaces (e.g. "C:\Users\Jane Doe\...") survive.
$BridgeInfo.FileName  = "cmd.exe"
$quotedArgs = $BridgeArgs | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }
$BridgeInfo.Arguments = "/c claude-ide-bridge " + ($quotedArgs -join " ")

$BridgeProc = [System.Diagnostics.Process]::Start($BridgeInfo)
$Jobs.Add($BridgeProc)

# ── Wait for lock file ────────────────────────────────────────────────────────
Write-Status "Waiting for bridge lock file..."
$ClaudeBase = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".claude" }
$IdeDir  = Join-Path $ClaudeBase "ide"
$Deadline = (Get-Date).AddSeconds(30)
$LockFile = $null

while ((Get-Date) -lt $Deadline) {
    $locks = Get-ChildItem -Path $IdeDir -Filter "*.lock" -ErrorAction SilentlyContinue |
             Where-Object { $_.LastWriteTime -gt (Get-Date).AddSeconds(-60) }
    if ($locks) {
        # Find the lock that matches our workspace
        foreach ($lf in $locks) {
            try {
                $content = Get-Content $lf.FullName -Raw | ConvertFrom-Json
                if ($content.isBridge -and
                    ($content.workspace -replace '\\','/' ) -eq ($Workspace -replace '\\','/')) {
                    $LockFile = $lf
                    $DetectedPort = [int][System.IO.Path]::GetFileNameWithoutExtension($lf.Name)
                    break
                }
            } catch { }
        }
        if ($LockFile) { break }
    }
    Start-Sleep -Milliseconds 200
}

if (-not $LockFile) {
    Write-Error "Bridge lock file not written after 30s. Bridge may have failed to start."
    Stop-AllJobs
    exit 1
}

Write-Ok "Bridge ready on port $DetectedPort"
Send-Notify "Bridge started on port $DetectedPort"

# ── Start Claude --ide ────────────────────────────────────────────────────────
Write-Status "Starting claude --ide..."
$ClaudeInfo = New-Object System.Diagnostics.ProcessStartInfo
$ClaudeInfo.FileName  = "cmd.exe"
$ClaudeInfo.Arguments = "/c claude --ide"
$ClaudeInfo.UseShellExecute = $false
$ClaudeProc = [System.Diagnostics.Process]::Start($ClaudeInfo)
$Jobs.Add($ClaudeProc)

# ── Start dashboard ───────────────────────────────────────────────────────────
$DashProc = $null
if (-not $NoDashboard) {
    if (-not (Test-Path (Join-Path $DashboardDir "node_modules"))) {
        Write-Warn "dashboard/node_modules not found. Run 'npm ci' in the dashboard directory first, or pass -NoDashboard."
    } else {
        Write-Status "Starting dashboard on http://localhost:$DashboardPort ..."

        $env:PATCHWORK_BRIDGE_PORT = $DetectedPort
        $DashInfo = New-Object System.Diagnostics.ProcessStartInfo
        $DashInfo.FileName         = "cmd.exe"
        $DashInfo.Arguments        = "/c npx next dev -p $DashboardPort"
        $DashInfo.WorkingDirectory = $DashboardDir
        $DashInfo.UseShellExecute  = $false
        $DashProc = [System.Diagnostics.Process]::Start($DashInfo)
        $Jobs.Add($DashProc)

        # Poll until Next.js answers, then open the browser
        $DashUrl     = "http://localhost:$DashboardPort"
        $DashDeadline = (Get-Date).AddSeconds(60)
        $Opened = $false
        while ((Get-Date) -lt $DashDeadline) {
            try {
                $r = Invoke-WebRequest -Uri $DashUrl -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
                if ($r.StatusCode -lt 500) {
                    Write-Ok "Dashboard ready — opening $DashUrl"
                    Start-Process $DashUrl   # opens default browser on Windows
                    $Opened = $true
                    break
                }
            } catch { }
            Start-Sleep -Milliseconds 1000
        }
        if (-not $Opened) {
            Write-Warn "Dashboard did not respond within 60s — open $DashUrl manually."
        }
    }
}

# ── Wait ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Ok "All processes started. Press Ctrl+C to stop."
Write-Host "  Bridge PID : $($BridgeProc.Id)"
Write-Host "  Claude PID : $($ClaudeProc.Id)"
if ($DashProc) { Write-Host "  Dashboard  : http://localhost:$DashboardPort (PID $($DashProc.Id))" }
Write-Host ""

try {
    # Block until the bridge exits (primary process)
    $BridgeProc.WaitForExit()
} finally {
    Write-Status "Bridge exited — stopping all processes..."
    Stop-AllJobs
}
