param(
    [switch] $SkipSyftboxBuild,
    [switch] $SkipRun
)

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

# Set BioVault CLI (prefer PATH `bv` so this works on Windows)
$bvPath = "bv"

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

# Force Rust (embedded) SyftBox backend for Windows dev mode
$env:BV_SYFTBOX_BACKEND = "embedded"

# Dev mode flags (enables DEV MODE banner + extra UI)
if (-not $env:BIOVAULT_DEV_MODE) { $env:BIOVAULT_DEV_MODE = "1" }
if (-not $env:BIOVAULT_DEV_SYFTBOX) { $env:BIOVAULT_DEV_SYFTBOX = "1" }

# Build syftbox-dev.exe (optional, but matches ./dev-desktop.sh behavior)
if (-not $SkipSyftboxBuild) {
    Write-Host "== Building SyftBox (dev) ==" -ForegroundColor Blue
    & (Join-Path $scriptDir "build-syftbox-dev.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "build-syftbox-dev.ps1 failed with exit code $LASTEXITCODE"
    }
    Write-Host ""
}

# Set PROTOC if not already set
if (-not $env:PROTOC) {
    $protocPath = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\protoc.exe"
    if (Test-Path $protocPath) {
        $env:PROTOC = $protocPath
    }
}

# Use local syftbox binary if available (built above or prebuilt)
$syftboxBinary = Join-Path $repoRoot "biovault\syftbox\bin\syftbox-dev.exe"
$syftboxResourceDev = Join-Path $repoRoot "src-tauri\resources\syftbox\syftbox-dev.exe"
if (Test-Path $syftboxBinary) {
    $env:SYFTBOX_BINARY = $syftboxBinary
} elseif (Test-Path $syftboxResourceDev) {
    $env:SYFTBOX_BINARY = $syftboxResourceDev
}

try {
    $syftboxVersion = (git -C $repoRoot describe --tags --always --dirty 2>$null)
    if ($syftboxVersion) { $env:SYFTBOX_VERSION = $syftboxVersion }
} catch {
    if (-not $env:SYFTBOX_VERSION) { $env:SYFTBOX_VERSION = "dev" }
}

if ($env:SYFTBOX_BINARY) {
    $syftboxBinDir = Split-Path -Parent $env:SYFTBOX_BINARY
    if ($syftboxBinDir) {
        $env:PATH = "$syftboxBinDir;$env:PATH"
    }
}

Write-Host ""
Write-Host "Configuration:" -ForegroundColor Green
Write-Host "   Database: $env:BIOVAULT_HOME\biovault.db" -ForegroundColor Yellow
Write-Host "   CLI binary: $env:BIOVAULT_PATH" -ForegroundColor Yellow
Write-Host "   BIOVAULT_DEV_MODE: $env:BIOVAULT_DEV_MODE" -ForegroundColor Yellow
Write-Host "   BIOVAULT_DEV_SYFTBOX: $env:BIOVAULT_DEV_SYFTBOX" -ForegroundColor Yellow
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
    if (-not $SkipRun) {
        & npx tauri dev
    } else {
        Write-Host "SkipRun set; not launching Tauri." -ForegroundColor Yellow
    }
} finally {
    Pop-Location
}
