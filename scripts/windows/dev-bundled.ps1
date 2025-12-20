# dev-bundled.ps1 - Full dev build WITH bundled dependencies
# Downloads Java, Nextflow, UV and bundles them before running

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path

Write-Host "== Dev build (bundled) ==" -ForegroundColor Blue
Write-Host "This build includes bundled Java/Nextflow/UV" -ForegroundColor Green
Write-Host ""

$env:BV_BUNDLE_SYFTBOX = "1"
$env:BV_SYFTBOX_DEFAULT_BACKEND = "process"
$env:TAURI_CONFIG = (Join-Path $repoRoot "src-tauri\\tauri.conf.go.json")

# Run the bundle-deps script first
Write-Host "Running bundle-deps.ps1 to download dependencies..." -ForegroundColor Yellow
& (Join-Path $scriptDir "bundle-deps.ps1")

if ($LASTEXITCODE -ne 0) {
    Write-Host "bundle-deps.ps1 failed!" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Copy templates if they exist
$templatesDir = Join-Path $repoRoot "src-tauri\resources\templates"
$templatesSrc = Join-Path $repoRoot "templates-dev"
if (Test-Path $templatesSrc) {
    if (Test-Path $templatesDir -PathType Leaf) {
        # On Windows with `core.symlinks=false`, the repo's templates symlink may be checked out as a file.
        # Replace it with a real directory so Tauri can bundle the templates.
        Remove-Item -Force $templatesDir
    }

    if (-not (Test-Path $templatesDir -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $templatesDir | Out-Null
    }

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
Write-Host "   Bundled deps: Java, Nextflow, UV" -ForegroundColor Green
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
