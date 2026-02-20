Param(
    [string]$OutDir = "$env:USERPROFILE\\Desktop"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$gitBash = "C:\\Program Files\\Git\\bin\\bash.exe"
if (-not (Test-Path $gitBash)) {
    throw "Git Bash not found at $gitBash"
}

Write-Host "Using Git Bash: $gitBash" -ForegroundColor Cyan

# Ensure bash scripts are using LF line endings if they were checked out with CRLF.
& $gitBash -lc "cd '$PSScriptRoot' && git config core.autocrlf input && git restore -- scripts/*.sh" | Out-Null

Write-Host "Fetching bundled deps..." -ForegroundColor Cyan
& $gitBash -lc "cd '$PSScriptRoot' && bash ./scripts/fetch-bundled-deps.sh"

Write-Host "Materializing templates..." -ForegroundColor Cyan
& $gitBash -lc "cd '$PSScriptRoot' && bash ./scripts/materialize-templates.sh"

Write-Host "Building Tauri release..." -ForegroundColor Cyan
Push-Location $PSScriptRoot
npm run tauri -- build
Pop-Location

$bundleDir = Join-Path $PSScriptRoot "src-tauri\\target\\release\\bundle"
if (-not (Test-Path $bundleDir)) {
    throw "Bundle directory not found: $bundleDir"
}

$exe = Get-ChildItem -Path $bundleDir -Recurse -Filter "*.exe" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $exe) {
    throw "No .exe found under $bundleDir"
}

if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}

$dest = Join-Path $OutDir $exe.Name
Copy-Item -Path $exe.FullName -Destination $dest -Force
Write-Host "Copied installer to $dest" -ForegroundColor Green
