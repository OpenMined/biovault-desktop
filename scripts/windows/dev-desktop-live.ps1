[CmdletBinding()]
param(
  [string] $SyftboxUrl = $env:SYFTBOX_URL,
  [string] $BioVaultHome = $env:BIOVAULT_CONFIG,
  [switch] $SkipBundleDeps,
  [switch] $SkipNextflowRunnerBuild,
  [switch] $PullNextflowRunnerBase
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Get script and repo directories
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path

if ([string]::IsNullOrWhiteSpace($SyftboxUrl)) {
  $SyftboxUrl = "https://dev.syftbox.net"
}

# Default BioVault home if not provided
if ([string]::IsNullOrWhiteSpace($BioVaultHome)) {
  $BioVaultHome = Join-Path $env:USERPROFILE "Desktop\BioVault"
}

Write-Host "== Dev Desktop (live server) ==" -ForegroundColor Blue
Write-Host "  SYFTBOX_URL: $SyftboxUrl" -ForegroundColor Cyan
Write-Host "  BIOVAULT_HOME: $BioVaultHome" -ForegroundColor Cyan
Write-Host ""

if (-not $SkipBundleDeps) {
  Write-Host "== Bundling deps (Windows) ==" -ForegroundColor Blue
  & (Join-Path $scriptDir "bundle-deps.ps1")
  if ($LASTEXITCODE -ne 0) { throw "bundle-deps.ps1 failed with exit code $LASTEXITCODE" }
  Write-Host ""
} else {
  Write-Host "== Skipping bundle-deps.ps1 ==" -ForegroundColor Yellow
  Write-Host ""
}

if (-not $SkipNextflowRunnerBuild) {
  $docker = (Get-Command docker.exe -ErrorAction SilentlyContinue)
  if (-not $docker) { $docker = (Get-Command docker -ErrorAction SilentlyContinue) }

  if ($docker) {
    Write-Host "== Prebuilding Nextflow runner image (Windows) ==" -ForegroundColor Blue
    $runnerScript = Join-Path $repoRoot "docker\windows\build-nextflow-runner.ps1"
    if (-not (Test-Path $runnerScript)) { throw "Missing script: $runnerScript" }
    if ($PullNextflowRunnerBase) {
      & powershell -ExecutionPolicy Bypass -File $runnerScript -Pull
    } else {
      & powershell -ExecutionPolicy Bypass -File $runnerScript
    }
    if ($LASTEXITCODE -ne 0) { throw "build-nextflow-runner.ps1 failed with exit code $LASTEXITCODE" }
    Write-Host ""
  } else {
    Write-Host "== Skipping Nextflow runner build (docker not found) ==" -ForegroundColor Yellow
    Write-Host ""
  }
} else {
  Write-Host "== Skipping Nextflow runner build ==" -ForegroundColor Yellow
  Write-Host ""
}

Write-Host "== Force rebuilding biovault dependency... ==" -ForegroundColor Blue
Push-Location (Join-Path $repoRoot "src-tauri")
try {
  & cargo clean -p biovault
} finally {
  Pop-Location
}
Write-Host "Cleaned biovault package cache" -ForegroundColor Green

# Environment variables
$env:BIOVAULT_HOME = $BioVaultHome
New-Item -ItemType Directory -Force -Path $env:BIOVAULT_HOME | Out-Null

# Map SYFTBOX_URL -> SYFTBOX_SERVER_URL (what the app reads)
$env:SYFTBOX_SERVER_URL = $SyftboxUrl
if (-not $env:SYFTBOX_AUTH_ENABLED) { $env:SYFTBOX_AUTH_ENABLED = "1" }

# Help any codepaths that use syftbox-sdk defaults (instead of BioVault config) find the right files on Windows.
$syftboxConfigPath = Join-Path $BioVaultHome "syftbox\config.json"
$env:SYFTBOX_CONFIG_PATH = $syftboxConfigPath
$env:SYFTBOX_DATA_DIR = $BioVaultHome

# Best-effort: propagate email for SDK calls that rely on SYFTBOX_EMAIL.
if (-not $env:SYFTBOX_EMAIL) {
  $configYamlPath = Join-Path $BioVaultHome "config.yaml"
  if (Test-Path $configYamlPath) {
    $match = Select-String -Path $configYamlPath -Pattern '^\s*email\s*:\s*(.+?)\s*$' -AllMatches | Select-Object -First 1
    if ($match -and $match.Matches.Count -gt 0) {
      $emailValue = $match.Matches[0].Groups[1].Value.Trim()
      $emailValue = $emailValue.Trim("'").Trim('"')
      if (-not [string]::IsNullOrWhiteSpace($emailValue)) {
        $env:SYFTBOX_EMAIL = $emailValue
      }
    }
  }
}

# Prefer bundled syftbox.exe produced by bundle-deps.ps1
$syftboxExe = Join-Path $repoRoot "src-tauri\resources\syftbox\syftbox.exe"
$syftboxFallback = Join-Path $repoRoot "src-tauri\resources\syftbox\syftbox"
if (Test-Path $syftboxExe) {
  $env:SYFTBOX_BINARY = $syftboxExe
} elseif (Test-Path $syftboxFallback) {
  $env:SYFTBOX_BINARY = $syftboxFallback
}

try {
  $env:SYFTBOX_VERSION = (git -C $repoRoot describe --tags --always --dirty 2>$null)
} catch {
  if (-not $env:SYFTBOX_VERSION) { $env:SYFTBOX_VERSION = "dev" }
}

# Set PROTOC if not already set
if (-not $env:PROTOC) {
  $protocPath = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\protoc.exe"
  if (Test-Path $protocPath) {
    $env:PROTOC = $protocPath
  }
}

Write-Host ""
Write-Host "Configuration:" -ForegroundColor Green
Write-Host "   BIOVAULT_HOME: $env:BIOVAULT_HOME" -ForegroundColor Yellow
Write-Host "   SYFTBOX_SERVER_URL: $env:SYFTBOX_SERVER_URL" -ForegroundColor Yellow
Write-Host "   SYFTBOX_AUTH_ENABLED: $env:SYFTBOX_AUTH_ENABLED" -ForegroundColor Yellow
Write-Host "   SYFTBOX_CONFIG_PATH: $env:SYFTBOX_CONFIG_PATH" -ForegroundColor Yellow
Write-Host "   SYFTBOX_DATA_DIR: $env:SYFTBOX_DATA_DIR" -ForegroundColor Yellow
if ($env:SYFTBOX_EMAIL) { Write-Host "   SYFTBOX_EMAIL: $env:SYFTBOX_EMAIL" -ForegroundColor Yellow }
if ($env:SYFTBOX_BINARY) { Write-Host "   SYFTBOX_BINARY: $env:SYFTBOX_BINARY" -ForegroundColor Yellow }
if ($env:SYFTBOX_VERSION) { Write-Host "   SYFTBOX_VERSION: $env:SYFTBOX_VERSION" -ForegroundColor Yellow }
if ($env:PROTOC) { Write-Host "   PROTOC: $env:PROTOC" -ForegroundColor Yellow }
Write-Host ""

Write-Host "Starting Tauri dev server..." -ForegroundColor Blue
Write-Host ""

Push-Location $repoRoot
try {
  # Use `npx tauri dev` on Windows to avoid relying on bash-based npm scripts.
  & npx tauri dev
} finally {
  Pop-Location
}
