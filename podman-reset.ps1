param(
  [string]$MachineName = "podman-hyperv",
  [switch]$Rootful,
  [switch]$InitIfMissing
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Get-Command podman -ErrorAction SilentlyContinue)) {
  throw "podman CLI not found on PATH"
}

$env:CONTAINERS_MACHINE_PROVIDER = "hyperv"

Write-Host "Resetting Podman Hyper-V machine: $MachineName" -ForegroundColor Cyan

$inspect = $null
try {
  $inspect = & podman machine inspect $MachineName 2>$null
} catch {
  $inspect = $null
}

if (-not $inspect) {
  if (-not $InitIfMissing) {
    throw "Podman machine '$MachineName' not found. Re-run with -InitIfMissing to create it."
  }
  Write-Host "Initializing Podman machine '$MachineName'..." -ForegroundColor Yellow
  & podman machine init $MachineName
}

Write-Host "Stopping Podman machine '$MachineName'..." -ForegroundColor Yellow
try {
  & podman machine stop $MachineName
} catch {
  Write-Host "Podman machine stop failed (may already be stopped): $($_.Exception.Message)" -ForegroundColor DarkYellow
}

if ($Rootful) {
  Write-Host "Setting rootful mode for '$MachineName'..." -ForegroundColor Yellow
  & podman machine set --rootful $MachineName
}

Write-Host "Starting Podman machine '$MachineName'..." -ForegroundColor Yellow
& podman machine start $MachineName

$connectionName = if ($Rootful) { "$MachineName-root" } else { $MachineName }
try {
  & podman system connection default $connectionName
} catch {
  Write-Host "Warning: failed to set default connection '$connectionName'." -ForegroundColor DarkYellow
  & podman system connection list
}

Write-Host "Waiting for Podman socket..." -ForegroundColor Yellow
$ready = $false
for ($i = 1; $i -le 6; $i++) {
  try {
    & podman info | Out-Host
    if ($LASTEXITCODE -eq 0) {
      $ready = $true
      break
    }
  } catch {
    # Ignore and retry
  }
  Start-Sleep -Seconds 2
}

if (-not $ready) {
  throw "Podman did not become ready. Check 'podman system connection list' and machine logs."
}

Write-Host "Podman is ready. Running 'podman ps'..." -ForegroundColor Green
& podman ps
