# podman.ps1 - Manage Podman machines on Windows
# Usage:
#   .\podman.ps1 --wsl      # Stop all, start WSL machine
#   .\podman.ps1 --hyperv   # Stop all, start Hyper-V machine
#   .\podman.ps1 --stop     # Stop all machines
#   .\podman.ps1 --status   # Show status of all machines

# Parse --style arguments (Unix convention)
$wsl = $args -contains "--wsl"
$hyperv = $args -contains "--hyperv"
$stop = $args -contains "--stop"
$status = $args -contains "--status"
$help = $args -contains "--help" -or $args -contains "-h"

if ($help -or ($args.Count -eq 0) -or (-not $wsl -and -not $hyperv -and -not $stop -and -not $status)) {
    Write-Host "Usage: .\podman.ps1 [option]" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  --wsl      Stop all machines, start WSL machine (podman-machine-default)"
    Write-Host "  --hyperv   Stop all machines, start Hyper-V machine (podman-machine-hyperv)"
    Write-Host "  --stop     Stop all running machines"
    Write-Host "  --status   Show status of all machines (both providers)"
    Write-Host "  --help     Show this help"
    Write-Host ""
    Write-Host "Note: Podman can only have ONE active machine at a time across all providers."
    Write-Host "      WSL and Hyper-V machines are managed separately but conflict when running."
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  .\podman.ps1 --status    # Check what's running"
    Write-Host "  .\podman.ps1 --hyperv    # Switch to Hyper-V for CI testing"
    Write-Host "  .\podman.ps1 --wsl       # Switch to WSL for dev"
    Write-Host "  .\podman.ps1 --stop      # Stop everything"
    exit 0
}

function Stop-AllMachines {
    # Stop WSL machines
    $env:CONTAINERS_MACHINE_PROVIDER = "wsl"
    $wslMachines = podman machine list --format "{{.Name}}|{{.Running}}" 2>$null
    foreach ($line in $wslMachines -split "`n") {
        $parts = $line.Trim() -split "\|"
        if ($parts.Count -ge 2 -and $parts[0] -and $parts[1].Trim() -eq "true") {
            $name = $parts[0].Trim()
            Write-Host "Stopping WSL machine '$name'..." -ForegroundColor Yellow
            podman machine stop $name 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  Stopped" -ForegroundColor Green
            }
        }
    }

    # Stop Hyper-V machines
    $env:CONTAINERS_MACHINE_PROVIDER = "hyperv"
    $hypervMachines = podman machine list --format "{{.Name}}|{{.Running}}" 2>$null
    foreach ($line in $hypervMachines -split "`n") {
        $parts = $line.Trim() -split "\|"
        if ($parts.Count -ge 2 -and $parts[0] -and $parts[1].Trim() -eq "true") {
            $name = $parts[0].Trim()
            Write-Host "Stopping Hyper-V machine '$name'..." -ForegroundColor Yellow
            podman machine stop $name 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  Stopped" -ForegroundColor Green
            }
        }
    }
}

function Show-Status {
    Write-Host "=== Podman Machines ===" -ForegroundColor Cyan
    Write-Host ""

    Write-Host "WSL Machines:" -ForegroundColor Yellow
    $env:CONTAINERS_MACHINE_PROVIDER = "wsl"
    podman machine list 2>$null
    Write-Host ""

    Write-Host "Hyper-V Machines:" -ForegroundColor Yellow
    $env:CONTAINERS_MACHINE_PROVIDER = "hyperv"
    podman machine list 2>$null
    Write-Host ""

    # Show active connection
    Write-Host "Active Connection:" -ForegroundColor Cyan
    podman system connection list 2>$null | Select-String -Pattern "\*"
}

if ($status) {
    Show-Status
    exit 0
}

if ($stop) {
    Write-Host "Stopping all Podman machines..." -ForegroundColor Cyan
    Stop-AllMachines
    Write-Host ""
    Write-Host "Done!" -ForegroundColor Green
    exit 0
}

if ($wsl) {
    $machineName = "podman-machine-default"

    Write-Host "Switching to WSL machine..." -ForegroundColor Cyan
    Write-Host ""

    # Stop all machines first
    Stop-AllMachines

    # Set provider for WSL
    $env:CONTAINERS_MACHINE_PROVIDER = "wsl"

    # Check if machine exists
    $exists = podman machine inspect $machineName 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Creating WSL machine '$machineName'..." -ForegroundColor Yellow
        podman machine init $machineName
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Failed to create machine. Is WSL installed?" -ForegroundColor Red
            Write-Host "Install WSL: wsl --install" -ForegroundColor Yellow
            exit 1
        }
    }

    Write-Host "Starting $machineName..." -ForegroundColor Yellow
    podman machine start $machineName
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to start machine" -ForegroundColor Red
        exit 1
    }

    # Set as default connection (try non-root first, fall back to -root)
    $connectionSet = $false
    foreach ($connName in @($machineName, "$machineName-root")) {
        $existingConn = podman system connection list --format "{{.Name}}" 2>$null | Where-Object { $_ -eq $connName }
        if ($existingConn) {
            podman system connection default $connName 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "Set default connection to '$connName'" -ForegroundColor Green
                $connectionSet = $true
                break
            }
        }
    }
    if (-not $connectionSet) {
        Write-Host "Warning: Could not set default connection." -ForegroundColor DarkYellow
    }

    Write-Host ""
    Write-Host "WSL machine is ready!" -ForegroundColor Green
    Write-Host "Test with: podman run --rm hello-world" -ForegroundColor Gray
    exit 0
}

if ($hyperv) {
    $machineName = "podman-machine-hyperv"

    Write-Host "Switching to Hyper-V machine..." -ForegroundColor Cyan
    Write-Host ""

    # Stop all machines first
    Stop-AllMachines

    # Set provider for Hyper-V
    $env:CONTAINERS_MACHINE_PROVIDER = "hyperv"

    # Check if machine exists
    $exists = podman machine inspect $machineName 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Creating Hyper-V machine '$machineName'..." -ForegroundColor Yellow
        Write-Host "(This may take a minute...)" -ForegroundColor Gray
        podman machine init $machineName --cpus 4 --memory 4096
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Failed to create machine. Is Hyper-V enabled?" -ForegroundColor Red
            Write-Host "Enable: Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All" -ForegroundColor Yellow
            exit 1
        }
    }

    Write-Host "Starting $machineName..." -ForegroundColor Yellow
    podman machine start $machineName
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to start machine" -ForegroundColor Red
        exit 1
    }

    # Set as default connection (try non-root first, fall back to -root)
    $connectionSet = $false
    foreach ($connName in @($machineName, "$machineName-root")) {
        $existingConn = podman system connection list --format "{{.Name}}" 2>$null | Where-Object { $_ -eq $connName }
        if ($existingConn) {
            podman system connection default $connName 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "Set default connection to '$connName'" -ForegroundColor Green
                $connectionSet = $true
                break
            }
        }
    }
    if (-not $connectionSet) {
        Write-Host "Warning: Could not set default connection." -ForegroundColor DarkYellow
    }

    Write-Host ""
    Write-Host "Hyper-V machine is ready!" -ForegroundColor Green
    Write-Host "Test with: podman run --rm hello-world" -ForegroundColor Gray
    Write-Host ""
    Write-Host "For CI testing, run: .\test.ps1" -ForegroundColor Cyan
    exit 0
}
