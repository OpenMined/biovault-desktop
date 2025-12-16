Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Get script and repo directories
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path

Write-Host "== Force rebuilding biovault submodule... ==" -ForegroundColor Blue

Push-Location (Join-Path $repoRoot "src-tauri")
try {
    & cargo clean -p biovault
} finally {
    Pop-Location
}
Write-Host "Cleaned biovault package cache" -ForegroundColor Green

# Set BioVault paths
$bvPath = Join-Path $repoRoot "biovault\bv"

# Use custom config if BIOVAULT_CONFIG is set, otherwise use Desktop\BioVault
if ($env:BIOVAULT_CONFIG) {
    $env:BIOVAULT_HOME = $env:BIOVAULT_CONFIG
    Write-Host "Using config directory: $env:BIOVAULT_HOME" -ForegroundColor Yellow
} else {
    $env:BIOVAULT_HOME = Join-Path $env:USERPROFILE "Desktop\BioVault"
}

# Create config directory if it doesn't exist
New-Item -ItemType Directory -Force -Path $env:BIOVAULT_HOME | Out-Null

# Override bv binary path
$env:BIOVAULT_PATH = $bvPath

# Set PROTOC if not already set
if (-not $env:PROTOC) {
    $protocPath = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\protoc.exe"
    if (Test-Path $protocPath) {
        $env:PROTOC = $protocPath
    }
}

# Set syftbox environment variables for dev builds
$syftboxBinary = Join-Path $repoRoot "biovault\syftbox\bin\syftbox-dev.exe"
if (Test-Path $syftboxBinary) {
    $env:SYFTBOX_BINARY = $syftboxBinary
    $env:SYFTBOX_VERSION = "dev"
}

Write-Host ""
Write-Host "Configuration:" -ForegroundColor Green
Write-Host "   Database: $env:BIOVAULT_HOME\biovault.db" -ForegroundColor Yellow
Write-Host "   CLI binary: $env:BIOVAULT_PATH" -ForegroundColor Yellow
if ($env:SYFTBOX_BINARY) {
    Write-Host "   Syftbox binary: $env:SYFTBOX_BINARY" -ForegroundColor Yellow
}
if ($env:PROTOC) {
    Write-Host "   PROTOC: $env:PROTOC" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Starting Tauri dev server..." -ForegroundColor Blue
Write-Host ""

# Run Tauri dev from repo root
Push-Location $repoRoot
try {
    & npx tauri dev
} finally {
    Pop-Location
}
