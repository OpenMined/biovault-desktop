[CmdletBinding()]
param(
  [string] $BioVaultConfig = $env:BIOVAULT_CONFIG,
  [switch] $SkipSyftboxBuild,
  [switch] $SkipRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path $PSScriptRoot).Path
$script = Join-Path $repoRoot "scripts\\windows\\dev-desktop.ps1"

if (-not (Test-Path $script)) {
  throw "Missing Windows dev script: $script"
}

if ([string]::IsNullOrWhiteSpace($BioVaultConfig)) {
  $BioVaultConfig = Join-Path $env:USERPROFILE "Desktop\\BioVault"
}

$env:BIOVAULT_CONFIG = $BioVaultConfig

Write-Host "== Dev Desktop (Windows) ==" -ForegroundColor Blue
Write-Host "  BIOVAULT_CONFIG: $BioVaultConfig" -ForegroundColor Cyan
Write-Host ""

& powershell -NoProfile -ExecutionPolicy Bypass -File $script @(
  $(if ($SkipSyftboxBuild) { "-SkipSyftboxBuild" } else { $null }),
  $(if ($SkipRun) { "-SkipRun" } else { $null })
) | Where-Object { $_ -ne $null }
