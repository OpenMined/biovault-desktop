#!/usr/bin/env pwsh
# Setup script for biovault-desktop workspace (Windows)
# Clones all dependencies as siblings in the SAME directory
#
# This script supports two modes:
# 1. Standalone: When biovault-desktop is cloned alone, clones all deps as siblings
# 2. Repo-managed: When in a repo-managed workspace, exits early (deps already synced)
#
# After running, the directory structure will be:
#   parent/
#   ├── biovault-desktop/  (this repo)
#   ├── biovault/
#   ├── syftbox-sdk/
#   ├── syft-crypto-core/
#   ├── syftbox/
#   ├── biovault-beaver/
#   ├── sbenv/
#   └── bioscript/

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$ParentDir = Split-Path -Parent $RepoRoot

Write-Host "Setting up biovault-desktop workspace..."
Write-Host "  REPO_ROOT: $RepoRoot"
Write-Host "  PARENT_DIR: $ParentDir"

# Configure git to use HTTPS instead of SSH for GitHub (needed for CI)
git config --global url."https://github.com/".insteadOf "git@github.com:"

# Check if we're in a repo-managed workspace (parent has .repo)
if (Test-Path (Join-Path $ParentDir ".repo")) {
    Write-Host "Detected repo-managed parent workspace - dependencies already synced"
    exit 0
}

# Clone helper function
function Clone-IfMissing {
    param(
        [string]$Name,
        [string]$Url,
        [string]$Branch = $null
    )

    $Dest = Join-Path $ParentDir $Name
    if (Test-Path $Dest) {
        Write-Host "$Name already exists at $Dest"
    } else {
        Write-Host "Cloning $Name to $Dest..."
        if ($Branch) {
            git clone -b $Branch $Url $Dest
        } else {
            git clone $Url $Dest
        }
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to clone $Name"
        }
    }
}

# Clone all dependencies
Clone-IfMissing -Name "biovault" -Url "https://github.com/OpenMined/biovault.git"
Clone-IfMissing -Name "syftbox-sdk" -Url "https://github.com/OpenMined/syftbox-sdk.git"
Clone-IfMissing -Name "syft-crypto-core" -Url "https://github.com/OpenMined/syft-crypto-core.git"
Clone-IfMissing -Name "syftbox" -Url "https://github.com/OpenMined/syftbox.git" -Branch "madhava/biovault"
Clone-IfMissing -Name "biovault-beaver" -Url "https://github.com/OpenMined/biovault-beaver.git"
Clone-IfMissing -Name "sbenv" -Url "https://github.com/OpenMined/sbenv.git"
Clone-IfMissing -Name "bioscript" -Url "https://github.com/OpenMined/bioscript.git"

# Setup nested dependencies for syftbox-sdk
$SyftboxSdkSetup = Join-Path $ParentDir "syftbox-sdk/scripts/setup-workspace.ps1"
if (Test-Path $SyftboxSdkSetup) {
    Write-Host "Setting up syftbox-sdk dependencies..."
    Push-Location (Join-Path $ParentDir "syftbox-sdk")
    try {
        & $SyftboxSdkSetup
    } finally {
        Pop-Location
    }
}

# Setup nested dependencies for biovault
$BiovaultSetup = Join-Path $ParentDir "biovault/scripts/setup-workspace.ps1"
if (Test-Path $BiovaultSetup) {
    Write-Host "Setting up biovault dependencies..."
    Push-Location (Join-Path $ParentDir "biovault")
    try {
        & $BiovaultSetup
    } finally {
        Pop-Location
    }
}

# Create junctions from repo root to parent deps (for compatibility with old paths)
# Windows uses junctions instead of symlinks (no admin required)
function Create-Junction {
    param([string]$Name)

    $Link = Join-Path $RepoRoot $Name
    $Target = Join-Path $ParentDir $Name

    if (-not (Test-Path $Link)) {
        cmd /c mklink /J $Link $Target
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Created junction: $Name -> $Target"
        } else {
            Write-Warning "Failed to create junction for $Name"
        }
    }
}

Create-Junction "biovault"
Create-Junction "syftbox-sdk"
Create-Junction "syft-crypto-core"
Create-Junction "syftbox"
Create-Junction "biovault-beaver"
Create-Junction "sbenv"
Create-Junction "bioscript"

Write-Host ""
Write-Host "Workspace setup complete!"
Write-Host "Dependencies are at:"
Write-Host "  $ParentDir\biovault"
Write-Host "  $ParentDir\syftbox-sdk"
Write-Host "  $ParentDir\syft-crypto-core"
Write-Host "  $ParentDir\syftbox"
Write-Host "  $ParentDir\biovault-beaver"
Write-Host "  $ParentDir\sbenv"
Write-Host "  $ParentDir\bioscript"
