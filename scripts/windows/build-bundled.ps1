# build-bundled.ps1 - Production build WITH bundled dependencies
# Creates installable .exe (NSIS installer) with Java, Nextflow, UV bundled

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path

Write-Host "== Production build (bundled) ==" -ForegroundColor Blue
Write-Host "This creates an installable .exe with bundled Java/Nextflow/UV" -ForegroundColor Green
Write-Host ""

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
    Write-Host "Copied templates from templates-dev" -ForegroundColor Green
}

# Set environment variables
if (-not $env:PROTOC) {
    $protocPath = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\protoc.exe"
    if (Test-Path $protocPath) {
        $env:PROTOC = $protocPath
    }
}

Write-Host ""
Write-Host "Configuration:" -ForegroundColor Green
Write-Host "   Bundled deps: Java, Nextflow, UV, Syftbox" -ForegroundColor Green
if ($env:PROTOC) {
    Write-Host "   PROTOC: $env:PROTOC" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Starting production build..." -ForegroundColor Blue
Write-Host "This will take several minutes..." -ForegroundColor Yellow
Write-Host ""

Push-Location $repoRoot
try {
    & npx tauri build

    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "== Build complete! ==" -ForegroundColor Green
        Write-Host ""
        Write-Host "Installer location:" -ForegroundColor Cyan

        $bundleDir = Join-Path $repoRoot "src-tauri\target\release\bundle"

        # Find NSIS installer
        $nsisDir = Join-Path $bundleDir "nsis"
        if (Test-Path $nsisDir) {
            $installers = Get-ChildItem -Path $nsisDir -Filter "*.exe" | Sort-Object LastWriteTime -Descending
            foreach ($installer in $installers) {
                Write-Host "   $($installer.FullName)" -ForegroundColor White
            }
        }

        # Also show MSI if it exists
        $msiDir = Join-Path $bundleDir "msi"
        if (Test-Path $msiDir) {
            $msis = Get-ChildItem -Path $msiDir -Filter "*.msi" | Sort-Object LastWriteTime -Descending
            foreach ($msi in $msis) {
                Write-Host "   $($msi.FullName)" -ForegroundColor White
            }
        }

        Write-Host ""
        Write-Host "To install, run the .exe installer above" -ForegroundColor Cyan
    } else {
        Write-Host ""
        Write-Host "Build failed!" -ForegroundColor Red
        exit 1
    }
} finally {
    Pop-Location
}
