param(
    [string]$BioVaultHome = $(if ($env:BIOVAULT_HOME) { $env:BIOVAULT_HOME } else { Join-Path $env:USERPROFILE "Desktop\\BioVault" }),
    [switch]$WipeKeys,
    [switch]$WipeAppData
)

$ErrorActionPreference = "Stop"

function Remove-ItemWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$MaxAttempts = 30,
        [int]$DelayMs = 300
    )

    for ($i = 1; $i -le $MaxAttempts; $i++) {
        try {
            if (Test-Path -LiteralPath $Path) {
                Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
            }
            return
        } catch {
            $msg = $_.Exception.Message
            $hresult = $_.Exception.HResult
            $retryable = ($msg -match "being used by another process") -or ($msg -match "Access is denied") -or ($hresult -eq -2147024864)
            if (-not $retryable -or $i -eq $MaxAttempts) {
                throw
            }
            Start-Sleep -Milliseconds $DelayMs
        }
    }
}

Write-Host ""
Write-Host "BioVault reset" -ForegroundColor Cyan
Write-Host "  Home:        $BioVaultHome"
Write-Host "  Wipe keys:   $WipeKeys"
Write-Host "  Wipe AppData:$WipeAppData"
Write-Host ""

$confirm = Read-Host "This will stop processes and delete data. Type YES to continue"
if ($confirm -ne "YES") {
    Write-Host "Aborted."
    exit 1
}

Write-Host ""
Write-Host "Stopping processes..." -ForegroundColor Yellow

Get-Process bv-desktop -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process syftbox -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

& taskkill.exe /IM syftbox.exe /T /F 2>$null | Out-Null
& taskkill.exe /IM jupyter-lab.exe /T /F 2>$null | Out-Null
& taskkill.exe /IM jupyter.exe /T /F 2>$null | Out-Null

# Best-effort: kill python/uv processes that look related to Jupyter/BioVault.
$home = $BioVaultHome
Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -in @("python.exe", "pythonw.exe", "uv.exe")) -and (
        ($_.CommandLine -match "jupyter") -or
        ($home -and $_.CommandLine -like "*$home*")
    )
} | ForEach-Object {
    & taskkill.exe /PID $_.ProcessId /T /F 2>$null | Out-Null
}

Write-Host "Deleting data..." -ForegroundColor Yellow

$homePath = (Resolve-Path -LiteralPath $BioVaultHome -ErrorAction SilentlyContinue).Path
if ($homePath -and (Test-Path -LiteralPath $homePath)) {
    $sycPath = Join-Path $homePath ".syc"
    $sycBackup = $null

    if (-not $WipeKeys -and (Test-Path -LiteralPath $sycPath)) {
        $sycBackup = Join-Path $env:TEMP (".syc-backup-" + [DateTime]::UtcNow.ToString("yyyyMMddHHmmss"))
        Move-Item -LiteralPath $sycPath -Destination $sycBackup -Force
    }

    try {
        Remove-ItemWithRetry -Path $homePath
    } finally {
        if ($sycBackup -and (Test-Path -LiteralPath $sycBackup)) {
            New-Item -ItemType Directory -Force -Path $homePath | Out-Null
            Move-Item -LiteralPath $sycBackup -Destination (Join-Path $homePath ".syc") -Force
        }
    }
}

# Remove the BIOVAULT_HOME pointer file (if present)
$pointer = Join-Path $env:APPDATA "BioVault\\home_path"
if (Test-Path -LiteralPath $pointer) {
    Remove-ItemWithRetry -Path $pointer
}

if ($WipeAppData) {
    $roaming = Join-Path $env:APPDATA "BioVault"
    $local = Join-Path $env:LOCALAPPDATA "BioVault"
    if (Test-Path -LiteralPath $roaming) { Remove-ItemWithRetry -Path $roaming }
    if (Test-Path -LiteralPath $local) { Remove-ItemWithRetry -Path $local }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
