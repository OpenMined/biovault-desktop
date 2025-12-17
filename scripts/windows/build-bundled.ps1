# build-bundled.ps1 - Production build WITH bundled dependencies
# Creates installable .exe (NSIS installer) with UV + Syftbox bundled

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path

Write-Host "== Production build (bundled) ==" -ForegroundColor Blue
Write-Host "This creates an installable .exe with bundled UV + Syftbox" -ForegroundColor Green
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
    $templatesSrcResolved = (Resolve-Path $templatesSrc).Path
    $templatesDirItem = Get-Item -LiteralPath $templatesDir -Force -ErrorAction SilentlyContinue
    $skipTemplatesCopy = $false

    if ($templatesDirItem -and ($templatesDirItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        $target = $templatesDirItem.Target | Select-Object -First 1
        if ($target) {
            $targetResolved = (Resolve-Path (Join-Path (Split-Path $templatesDir -Parent) $target) -ErrorAction SilentlyContinue).Path
            if ($targetResolved -and ($targetResolved -eq $templatesSrcResolved)) {
                Write-Host "Templates directory is already a symlink to templates-dev; skipping copy." -ForegroundColor Green
                $skipTemplatesCopy = $true
            }
        }
    }

    if (-not $skipTemplatesCopy -and $templatesDirItem) {
        if (Test-Path $templatesDir -PathType Leaf) {
            # On Windows with `core.symlinks=false`, the repo's templates symlink may be checked out as a file.
            # Replace it with a real directory so Tauri can bundle the templates.
            Remove-Item -Force $templatesDir
        } elseif ($templatesDirItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            # Replace symlink with real directory for bundling stability.
            Remove-Item -Recurse -Force $templatesDir
        }
    }

    if (-not $skipTemplatesCopy -and -not (Test-Path $templatesDir -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $templatesDir | Out-Null
    }

    if (-not $skipTemplatesCopy) {
        $robocopy = Get-Command robocopy.exe -ErrorAction SilentlyContinue
        if ($robocopy) {
            & $robocopy.Source $templatesSrcResolved $templatesDir /E /R:5 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
            if ($LASTEXITCODE -ge 8) {
                Write-Host "Warning: robocopy reported failures copying templates (exit code $LASTEXITCODE). Continuing build..." -ForegroundColor Yellow
            } else {
                Write-Host "Copied templates from templates-dev" -ForegroundColor Green
            }
        } else {
            Copy-Item -Path (Join-Path $templatesSrcResolved "*") -Destination $templatesDir -Recurse -Force
            Write-Host "Copied templates from templates-dev" -ForegroundColor Green
        }
    }
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
Write-Host "   Bundled deps: UV, Syftbox" -ForegroundColor Green
if ($env:PROTOC) {
    Write-Host "   PROTOC: $env:PROTOC" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Starting production build..." -ForegroundColor Blue
Write-Host "This will take several minutes..." -ForegroundColor Yellow
Write-Host ""

Push-Location $repoRoot
try {
    $tauriArgs = @("build")

    # On Windows we do NOT bundle Java/Nextflow (they run via Docker); ensure the installer doesn't ship them.
    $configOverride = Join-Path $scriptDir "tauri.windows.resources.json"

    if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
        # Local builds usually don't have the release signing key, but we still want to build/test.
        # Disable updater artifact generation to avoid the signer requirement.
        $configOverride = Join-Path $scriptDir "tauri.windows.local.json"
        Write-Host "TAURI_SIGNING_PRIVATE_KEY not set; disabling updater artifacts for this build." -ForegroundColor Yellow
    }

    $tauriArgs += @("--config", $configOverride)
    & npx tauri @tauriArgs

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
