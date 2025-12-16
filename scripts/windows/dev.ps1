# dev.ps1 - Quick dev build WITHOUT bundled dependencies
# Use this to test the auto-installer UI flow (like ARM64 users would experience)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path

Write-Host "== Dev build (unbundled) ==" -ForegroundColor Blue
Write-Host "This build has NO bundled Java/Nextflow/UV - tests the installer UI" -ForegroundColor Yellow
Write-Host ""

# Create placeholder directories for Tauri resources (required for build)
$bundledDir = Join-Path $repoRoot "src-tauri\resources\bundled"
New-Item -ItemType Directory -Force -Path (Join-Path $bundledDir "java") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $bundledDir "nextflow") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $bundledDir "uv") | Out-Null
Set-Content -Path (Join-Path $bundledDir "README.txt") -Value "Bundled dependencies (placeholder)" -Encoding UTF8

# Create syftbox placeholder if needed
$syftboxDir = Join-Path $repoRoot "src-tauri\resources\syftbox"
New-Item -ItemType Directory -Force -Path $syftboxDir | Out-Null
$syftboxPlaceholder = Join-Path $syftboxDir "syftbox"
if (-not (Test-Path $syftboxPlaceholder)) {
    # Create empty placeholder file
    Set-Content -Path $syftboxPlaceholder -Value "" -Encoding UTF8
}

# Copy templates if they exist
$templatesDir = Join-Path $repoRoot "src-tauri\resources\templates"
$templatesSrc = Join-Path $repoRoot "templates-dev"
if ((Test-Path $templatesSrc) -and -not (Test-Path $templatesDir)) {
    New-Item -ItemType Directory -Force -Path $templatesDir | Out-Null
    Copy-Item -Path (Join-Path $templatesSrc "*") -Destination $templatesDir -Recurse -Force
}

# Set environment variables
if (-not $env:PROTOC) {
    $protocPath = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\protoc.exe"
    if (Test-Path $protocPath) {
        $env:PROTOC = $protocPath
    }
}

Write-Host "Configuration:" -ForegroundColor Green
Write-Host "   Bundled deps: NONE (placeholder directories only)" -ForegroundColor Yellow
if ($env:PROTOC) {
    Write-Host "   PROTOC: $env:PROTOC" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Starting Tauri dev server..." -ForegroundColor Blue
Write-Host ""

Push-Location $repoRoot
try {
    & npx tauri dev
} finally {
    Pop-Location
}
