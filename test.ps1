# BioVault Pipelines Collab Test Script
# Usage: .\test.ps1 [--interactive] [--jupyter]

param(
    [switch]$interactive,
    [switch]$jupyter,
    [switch]$help
)

if ($help) {
    Write-Host "Usage: .\test.ps1 [options]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  --interactive    Run with visible browser windows"
    Write-Host "  --jupyter        Run jupyter-collab test instead of pipelines-collab"
    Write-Host "  --help           Show this help"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  .\test.ps1                        # Run pipelines-collab headless"
    Write-Host "  .\test.ps1 --interactive          # Run pipelines-collab with visible browser"
    Write-Host "  .\test.ps1 --jupyter              # Run jupyter-collab headless"
    Write-Host "  .\test.ps1 --jupyter --interactive # Run jupyter-collab with visible browser"
    exit 0
}

# Fix npm IS_WSL bug on Windows
$env:IS_WSL = "0"

# Podman/Container configuration for Hyper-V (matching CI)
$env:CONTAINERS_MACHINE_PROVIDER = "hyperv"
$env:BIOVAULT_CONTAINER_RUNTIME = "podman"
$env:BIOVAULT_HYPERV_MOUNT = "1"
$env:BIOVAULT_HYPERV_HOST_DIR = "$env:SystemDrive\bvtemp"
$env:BIOVAULT_KEEP_HYPERV_HOST_DIR = "1"
$env:BV_FORCE_REBUILD = "0"

# Stop any conflicting WSL machines first
Write-Host "Checking for conflicting Podman machines..." -ForegroundColor Cyan
$machineList = podman machine list --format "{{.Name}}|{{.VMType}}|{{.Running}}" 2>$null
$hypervMachineFromList = $null
foreach ($line in $machineList -split "`n") {
    $parts = $line -split "\|"
    if ($parts.Count -ge 3) {
        $name = $parts[0].Trim()
        $vmType = $parts[1].Trim()
        $running = $parts[2].Trim()
        if ($vmType -eq "wsl" -and $running -eq "true") {
            Write-Host "Stopping WSL machine '$name' (conflicts with Hyper-V)..." -ForegroundColor Yellow
            podman machine stop $name 2>$null
        }
        if ($vmType -eq "hyperv" -and -not $hypervMachineFromList) {
            $hypervMachineFromList = $name
        }
    }
}

# Check if Podman Hyper-V machine exists and is running
# Note: Must set provider BEFORE listing machines, otherwise only WSL machines show
$env:CONTAINERS_MACHINE_PROVIDER = "hyperv"
$machineName = if ($hypervMachineFromList) { $hypervMachineFromList } else { "podman-hyperv" }
Write-Host "Checking Podman Hyper-V machine status..." -ForegroundColor Cyan
$machineInfo = $null
try {
    $machineInfoRaw = podman machine inspect $machineName 2>$null
    if ($LASTEXITCODE -eq 0 -and $machineInfoRaw) {
        $machineInfo = $machineInfoRaw | ConvertFrom-Json
        if ($machineInfo -is [Array]) {
            $machineInfo = $machineInfo[0]
        }
    }
} catch {
    $machineInfo = $null
}

if (-not $machineInfo) {
    Write-Host "Creating Podman Hyper-V machine '$machineName'..." -ForegroundColor Yellow
    podman machine init $machineName --cpus 4 --memory 4096
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to create Hyper-V machine. Make sure Hyper-V is enabled." -ForegroundColor Red
        exit 1
    }
    $machineInfo = $null
    try {
        $machineInfoRaw = podman machine inspect $machineName 2>$null
        if ($LASTEXITCODE -eq 0 -and $machineInfoRaw) {
            $machineInfo = $machineInfoRaw | ConvertFrom-Json
            if ($machineInfo -is [Array]) {
                $machineInfo = $machineInfo[0]
            }
        }
    } catch {
        $machineInfo = $null
    }
}

$machineState = $machineInfo.State
if ($machineState -ne "running") {
    Write-Host "Starting Podman Hyper-V machine '$machineName'..." -ForegroundColor Yellow
    $startOutput = podman machine start $machineName 2>&1
    if ($LASTEXITCODE -ne 0 -and $startOutput -notmatch "already .*running") {
        Write-Host "Failed to start Podman Hyper-V machine" -ForegroundColor Red
        Write-Host $startOutput
        Write-Host "Try: podman machine start $machineName" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "Podman Hyper-V machine started" -ForegroundColor Green
} else {
    Write-Host "Podman Hyper-V machine is running" -ForegroundColor Green
}

# Set as default connection (try non-root first, fall back to -root)
$connectionSet = $false
$availableConnections = @(podman system connection list --format "{{.Name}}" 2>$null | ForEach-Object { $_.Trim() })
$preferredConnections = @(
    $machineName,
    "$machineName-root",
    "podman-hyperv",
    "podman-hyperv-root",
    "podman-machine-hyperv",
    "podman-machine-hyperv-root"
)
foreach ($connName in $preferredConnections) {
    if (-not $connName) { continue }
    if ($availableConnections -contains $connName) {
        podman system connection default $connName 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Set default connection to '$connName'" -ForegroundColor Green
            $connectionSet = $true
            break
        }
    }
}
if (-not $connectionSet) {
    Write-Host "Warning: Could not set default connection for Hyper-V machine." -ForegroundColor DarkYellow
    Write-Host "Available connections:" -ForegroundColor Gray
    podman system connection list
}

function Test-PodmanConnection {
    $result = podman run --rm hello-world 2>&1
    if ($LASTEXITCODE -ne 0) {
        return @{ Ok = $false; Output = $result }
    }
    return @{ Ok = $true; Output = $result }
}

# Verify Podman works (retry once after restart if needed)
Write-Host "Verifying Podman connection..." -ForegroundColor Cyan
$testResult = Test-PodmanConnection
if (-not $testResult.Ok) {
    Write-Host "Podman test failed; restarting machine and retrying..." -ForegroundColor Yellow
    podman machine stop $machineName 2>$null
    podman machine start $machineName 2>&1 | Out-Host
    $testResult = Test-PodmanConnection
}
if (-not $testResult.Ok) {
    Write-Host "Podman test failed. Check your Podman installation." -ForegroundColor Red
    Write-Host $testResult.Output
    exit 1
}
Write-Host "Podman is working" -ForegroundColor Green

# Kill any leftover test processes
Write-Host "Cleaning up leftover processes..." -ForegroundColor Cyan
Get-Process -Name "bv-desktop" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Build the test command
$scenario = if ($jupyter) { "--jupyter-collab biovault-beaver/notebooks/02-advanced-features.json" } else { "--pipelines-collab" }
$interactiveFlag = if ($interactive) { "--interactive" } else { "" }

Write-Host ""
Write-Host "Running test: $scenario $interactiveFlag" -ForegroundColor Cyan
Write-Host "Environment:" -ForegroundColor Gray
Write-Host "  CONTAINERS_MACHINE_PROVIDER = $env:CONTAINERS_MACHINE_PROVIDER" -ForegroundColor Gray
Write-Host "  BIOVAULT_CONTAINER_RUNTIME = $env:BIOVAULT_CONTAINER_RUNTIME" -ForegroundColor Gray
Write-Host ""

# Run the test
.\win.ps1 ./test-scenario.sh $scenario $interactiveFlag
