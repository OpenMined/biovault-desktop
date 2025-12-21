Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\\..")).Path

$syftboxDir = Join-Path $repoRoot "biovault\\syftbox"
$outDir = Join-Path $syftboxDir "bin"
$outBin = Join-Path $outDir "syftbox-dev.exe"

$resourceDir = Join-Path $repoRoot "src-tauri\\resources\\syftbox"
$resourceBin = Join-Path $resourceDir "syftbox-dev.exe"

if (-not (Test-Path $syftboxDir)) {
  throw "Missing syftbox checkout at: $syftboxDir"
}

Push-Location $syftboxDir
try {
  $version = "dev"
  $revision = "HEAD"
  try { $version = (git describe --tags --always --dirty 2>$null) } catch {}
  try { $revision = (git rev-parse --short HEAD 2>$null) } catch {}
  $buildDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

  New-Item -ItemType Directory -Force -Path $outDir | Out-Null

  $ldFlags = @(
    "-s", "-w",
    "-X", "github.com/openmined/syftbox/internal/version.Version=$version",
    "-X", "github.com/openmined/syftbox/internal/version.Revision=$revision",
    "-X", "github.com/openmined/syftbox/internal/version.BuildDate=$buildDate"
  )

  Write-Host "[syftbox] Building client -> $outBin" -ForegroundColor Cyan
  Write-Host "[syftbox] Version=$version Revision=$revision BuildDate=$buildDate" -ForegroundColor Cyan

  & go build -ldflags ($ldFlags -join " ") -o $outBin ./cmd/client
  if ($LASTEXITCODE -ne 0) { throw "go build failed with exit code $LASTEXITCODE" }
  if (-not (Test-Path $outBin)) { throw "Expected output not found: $outBin" }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $resourceDir | Out-Null
Copy-Item -Force -LiteralPath $outBin -Destination $resourceBin

Write-Host "[syftbox] Build complete: $outBin" -ForegroundColor Green
Write-Host "[syftbox] Copied to resources: $resourceBin" -ForegroundColor Green

