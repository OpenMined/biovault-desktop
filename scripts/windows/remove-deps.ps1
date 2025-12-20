# remove-deps.ps1 - Uninstall dependencies for testing the installer flow
# Removes: UV, Java (OpenJDK), and bundled resources

Set-StrictMode -Version Latest
$ErrorActionPreference = "SilentlyContinue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path

Write-Host "== Removing dependencies for testing ==" -ForegroundColor Blue
Write-Host ""

# Uninstall UV via winget
Write-Host "Uninstalling UV..." -ForegroundColor Yellow
winget uninstall astral-sh.uv --silent 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "   UV uninstalled" -ForegroundColor Green
} else {
    Write-Host "   UV not installed or already removed" -ForegroundColor Gray
}

# Uninstall Java via winget
Write-Host "Uninstalling Java (OpenJDK 17)..." -ForegroundColor Yellow
winget uninstall Microsoft.OpenJDK.17 --silent 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "   Java uninstalled" -ForegroundColor Green
} else {
    Write-Host "   Java not installed or already removed" -ForegroundColor Gray
}

# Uninstall Docker Desktop via winget
Write-Host "Uninstalling Docker Desktop..." -ForegroundColor Yellow
winget uninstall Docker.DockerDesktop --silent 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "   Docker Desktop uninstalled" -ForegroundColor Green
} else {
    Write-Host "   Docker Desktop not installed or already removed" -ForegroundColor Gray
}

# Remove bundled resources
Write-Host "Removing bundled resources..." -ForegroundColor Yellow
$bundledDir = Join-Path $repoRoot "src-tauri\resources\bundled"
if (Test-Path $bundledDir) {
    Remove-Item -Recurse -Force $bundledDir -ErrorAction SilentlyContinue
    Write-Host "   Removed $bundledDir" -ForegroundColor Green
} else {
    Write-Host "   Bundled directory doesn't exist" -ForegroundColor Gray
}

Write-Host ""
Write-Host "== Done ==" -ForegroundColor Green
Write-Host ""
Write-Host "To test the installer UI, run:" -ForegroundColor Cyan
Write-Host "   .\scripts\windows\dev.ps1" -ForegroundColor White
Write-Host ""
Write-Host "To rebuild with bundled deps, run:" -ForegroundColor Cyan
Write-Host "   .\scripts\windows\dev-bundled.ps1" -ForegroundColor White
