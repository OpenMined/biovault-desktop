#!/usr/bin/env pwsh
# win.ps1 - Run bash scripts from PowerShell via Git Bash
# Usage: .\win.ps1 ./test-scenario.sh --pipelines-collab --interactive

$GitBash = "C:\Program Files\Git\bin\bash.exe"

if (-not (Test-Path $GitBash)) {
    Write-Host "Git Bash not found at $GitBash" -ForegroundColor Red
    exit 1
}

$useDesktop = $false
$desktopWait = $false
$sessionId = $null
$psexecPath = $null
$autoDesktop = $true
$skipAutoDesktop = $false
$forwardArgs = @()

function Get-ActiveSessionId {
    $sessions = @()
    try { $sessions = & query session 2>$null } catch { $sessions = @() }
    foreach ($line in $sessions) {
        if ($line -match '\s+(\d+)\s+Active') {
            return $Matches[1]
        }
    }
    $explorer = Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($explorer) { return $explorer.SessionId }
    return $null
}

function Get-CurrentSessionId {
    try {
        return (Get-Process -Id $PID -ErrorAction Stop).SessionId
    } catch {
        return $null
    }
}

function Resolve-PsExecPath {
    param([string]$Override)
    if ($Override) { return $Override }
    $psexecCmd = Get-Command psexec -ErrorAction SilentlyContinue
    if ($psexecCmd) { return $psexecCmd.Source }
    $defaultPsexec = "C:\Tools\PSTools\PsExec.exe"
    if (Test-Path $defaultPsexec) { return $defaultPsexec }
    return $null
}

for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = $args[$i]
    switch ($arg) {
        "--desktop" { $useDesktop = $true; continue }
        "--desktop-wait" { $useDesktop = $true; $desktopWait = $true; continue }
        "--no-desktop" { $autoDesktop = $false; continue }
        "--desktop-internal" { $skipAutoDesktop = $true; continue }
        "--session" {
            if ($i + 1 -ge $args.Count) { Write-Host "Missing value for --session" -ForegroundColor Red; exit 1 }
            $sessionId = $args[++$i]; continue
        }
        "--psexec" {
            if ($i + 1 -ge $args.Count) { Write-Host "Missing value for --psexec" -ForegroundColor Red; exit 1 }
            $psexecPath = $args[++$i]; continue
        }
        default { $forwardArgs += $arg }
    }
}

if (-not $useDesktop -and $autoDesktop -and -not $skipAutoDesktop) {
    $currentSessionId = Get-CurrentSessionId
    $activeSessionId = Get-ActiveSessionId
    if ($activeSessionId -and $currentSessionId -and ($activeSessionId -ne $currentSessionId)) {
        $resolvedPsExec = Resolve-PsExecPath -Override $psexecPath
        if (-not $resolvedPsExec -or -not (Test-Path $resolvedPsExec)) {
            Write-Host "PsExec not found; running in current session $currentSessionId (active session is $activeSessionId)." -ForegroundColor Yellow
        } else {
            $wd = (Get-Location).Path
            $psArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath, "--desktop-internal") + $forwardArgs
            $psexecArgs = @("-accepteula", "-i", $activeSessionId, "-w", $wd)
            $psexecArgs += @("powershell.exe") + $psArgs
            & $resolvedPsExec @psexecArgs
            exit $LASTEXITCODE
        }
    }
}

if ($useDesktop) {
    $psexecPath = Resolve-PsExecPath -Override $psexecPath
    if (-not $psexecPath -or -not (Test-Path $psexecPath)) {
        Write-Host "PsExec not found. Install Sysinternals PsExec and ensure it's on PATH or pass --psexec <path> (default: C:\\Tools\\PSTools\\PsExec.exe)." -ForegroundColor Red
        exit 1
    }
    if (-not $sessionId) { $sessionId = Get-ActiveSessionId }
    if (-not $sessionId) {
        Write-Host "Could not determine active desktop session. Pass --session <id>." -ForegroundColor Red
        exit 1
    }

    $wd = (Get-Location).Path
    $psArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath, "--desktop-internal") + $forwardArgs
    $psexecArgs = @("-accepteula", "-i", $sessionId, "-w", $wd)
    if (-not $desktopWait) { $psexecArgs += "-d" }
    $psexecArgs += @("powershell.exe") + $psArgs
    & $psexecPath @psexecArgs
    exit $LASTEXITCODE
}

if ($forwardArgs.Count -eq 0) {
    Write-Host "Usage: .\win.ps1 [--desktop [--session <id>] [--desktop-wait] [--psexec <path>]] <script> [args...]" -ForegroundColor Yellow
    Write-Host "Auto-desktop: by default, win.ps1 will re-run in the active desktop session when invoked from a different session. Use --no-desktop to disable." -ForegroundColor Yellow
    Write-Host "Example: .\win.ps1 ./test-scenario.sh --pipelines-collab --interactive"
    Write-Host "Example (desktop): .\win.ps1 --desktop --session 1 ./test-scenario.sh --pipelines-collab --interactive"
    exit 1
}

# Convert Windows path to Unix path for the script
$script = $forwardArgs[0]
$scriptArgs = if ($forwardArgs.Count -gt 1) { @($forwardArgs[1..($forwardArgs.Count-1)]) } else { @() }

# Get current directory in Unix format
$unixPath = (Get-Location).Path -replace '\\', '/' -replace '^([A-Za-z]):', '/$1'
$unixPath = $unixPath.ToLower() -replace '^/([a-z])', '/$1'

function Convert-ToUnixPath {
    param([string]$Path)
    $resolved = Resolve-Path -Path $Path -ErrorAction Stop
    $unix = $resolved.Path -replace '\\', '/' -replace '^([A-Za-z]):', '/$1'
    return ($unix.ToLower() -replace '^/([a-z])', '/$1')
}

# Convert script path to Unix format (resolve relative paths)
$scriptUnix = Convert-ToUnixPath $script


# Key Windows tool paths to add (converted to Unix format)
# Order matters - put preferred paths first
$toolPaths = @(
    "$env:USERPROFILE\.local\bin"
    "$env:USERPROFILE\.cargo\bin"
    "$env:LOCALAPPDATA\Programs\Python\Python311"
    "$env:LOCALAPPDATA\Programs\Python\Python311\Scripts"
    "$env:PROGRAMFILES\nodejs"
    "$env:PROGRAMFILES\Go\bin"
    "$env:USERPROFILE\go\bin"
    "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Google.Protobuf_Microsoft.Winget.Source_8wekyb3d8bbwe\bin"
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links"
    "$env:PROGRAMFILES\Bun\bin"
    "$env:USERPROFILE\.bun\bin"
)

# Find uv-managed Python and add to paths
$uvPythonBase = "$env:APPDATA\uv\python"
if (Test-Path $uvPythonBase) {
    $pythonDirs = Get-ChildItem -Path $uvPythonBase -Directory -Filter "cpython-3.11*" | Select-Object -First 1
    if ($pythonDirs) {
        $toolPaths = @($pythonDirs.FullName) + @("$($pythonDirs.FullName)\Scripts") + $toolPaths
    }
}

$unixToolPaths = @()
foreach ($p in $toolPaths) {
    $expanded = [Environment]::ExpandEnvironmentVariables($p)
    if (Test-Path $expanded) {
        if ($expanded -match '^([A-Za-z]):(.*)') {
            $drive = $Matches[1].ToLower()
            $rest = $Matches[2] -replace '\\', '/'
            $unixToolPaths += "/$drive$rest"
        }
    }
}
$extraPath = ($unixToolPaths -join ':')

# Build the command with PATH additions
$cmd = @"
export PATH="$extraPath`:`$PATH"
cd '$unixPath'

# On Windows, python3 might not exist but python does
# Create function wrappers that work in subshells (aliases don't)
if ! command -v python3 &> /dev/null && command -v python &> /dev/null; then
    python3() { python "`$@"; }
    export -f python3
fi

$scriptUnix "`$@"
"@

Write-Host "Running: $script $($scriptArgs -join ' ')" -ForegroundColor Cyan
Write-Host "PATH additions: $extraPath" -ForegroundColor DarkGray
Write-Host ""

# Debug: show command being run
# Write-Host "CMD: $cmd" -ForegroundColor DarkGray

# Write command to temp file and execute
$tempScript = [System.IO.Path]::GetTempFileName() + ".sh"
[System.IO.File]::WriteAllText($tempScript, $cmd, [System.Text.UTF8Encoding]::new($false))
# Convert temp path to Unix format for bash
$unixTempScript = $tempScript -replace '\\', '/' -replace '^([A-Za-z]):', '/$1'
$unixTempScript = $unixTempScript.ToLower() -replace '^/([a-z])', '/$1'
$scriptArgsList = @($scriptArgs)

try {
    & $GitBash $unixTempScript @scriptArgsList
} finally {
    Remove-Item $tempScript -ErrorAction SilentlyContinue
}
