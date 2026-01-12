Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\\..")).Path

$syftboxDir = Join-Path $repoRoot "syftbox"
if (-not (Test-Path $syftboxDir)) {
  $syftboxDir = Join-Path $repoRoot "biovault\\syftbox"
}

$resourceDir = Join-Path $repoRoot "src-tauri\\resources\\syftbox"
New-Item -ItemType Directory -Force -Path $resourceDir | Out-Null

$impl = $env:SYFTBOX_IMPL
$backend = $env:BV_SYFTBOX_BACKEND
$useGo = ($impl -and $impl -eq "go") -or ($backend -and $backend -eq "process")

if (-not (Test-Path $syftboxDir)) {
  throw "Missing syftbox checkout at: $syftboxDir"
}

if ($useGo) {
  $outDir = Join-Path $syftboxDir "bin"
  $outBin = Join-Path $outDir "syftbox-dev.exe"
  $resourceBin = Join-Path $resourceDir "syftbox.exe"

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

    Write-Host "[syftbox] Building Go client -> $outBin" -ForegroundColor Cyan
    Write-Host "[syftbox] Version=$version Revision=$revision BuildDate=$buildDate" -ForegroundColor Cyan

    & go build -ldflags ($ldFlags -join " ") -o $outBin ./cmd/client
    if ($LASTEXITCODE -ne 0) { throw "go build failed with exit code $LASTEXITCODE" }
    if (-not (Test-Path $outBin)) { throw "Expected output not found: $outBin" }
  } finally {
    Pop-Location
  }

  Copy-Item -Force -LiteralPath $outBin -Destination $resourceBin
  Write-Host "[syftbox] Build complete: $outBin" -ForegroundColor Green
  Write-Host "[syftbox] Copied to resources: $resourceBin" -ForegroundColor Green
  exit 0
}

$rustDir = Join-Path $syftboxDir "rust"
if (-not (Test-Path (Join-Path $rustDir "Cargo.toml"))) {
  throw "Syftbox Rust manifest not found at: $rustDir\\Cargo.toml"
}

Push-Location $rustDir
try {
  Write-Host "[syftbox] Building Rust client (embedded)..." -ForegroundColor Cyan
  & cargo build --release
  if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$bin = Join-Path $rustDir "target\\release\\syftbox-rs.exe"
if (-not (Test-Path $bin)) {
  throw "Rust syftbox binary not found at $bin"
}

$resourceBin = Join-Path $resourceDir "syftbox.exe"
Copy-Item -Force -LiteralPath $bin -Destination $resourceBin
Write-Host "[syftbox] Rust build complete: $bin" -ForegroundColor Green
Write-Host "[syftbox] Copied to resources: $resourceBin" -ForegroundColor Green
