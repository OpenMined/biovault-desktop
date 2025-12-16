[CmdletBinding()]
param(
  [string] $Tag = $env:IMAGE_NAME,
  [string] $Base = $env:NEXTFLOW_BASE_IMAGE,
  [string] $DockerCliVersion = $env:DOCKER_CLI_VERSION,
  [switch] $Pull
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Tag)) { $Tag = 'biovault/nextflow-runner:25.10.2' }
if ([string]::IsNullOrWhiteSpace($Base)) { $Base = 'nextflow/nextflow:25.10.2' }
if ([string]::IsNullOrWhiteSpace($DockerCliVersion)) { $DockerCliVersion = '28.0.1' }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dockerfile = Join-Path $scriptDir 'Dockerfile.nextflow-runner'

if (-not (Test-Path $dockerfile)) {
  throw "Dockerfile not found: $dockerfile"
}

$docker = (Get-Command docker.exe -ErrorAction SilentlyContinue)
if (-not $docker) { $docker = (Get-Command docker -ErrorAction SilentlyContinue) }
if (-not $docker) { throw "docker not found on PATH" }

Write-Host "[docker] Building $Tag (base $Base, docker-cli $DockerCliVersion)..."

if ($Pull) {
  & $docker.Source pull $Base | Write-Output
}

& $docker.Source build `
  -f $dockerfile `
  --build-arg "NEXTFLOW_BASE_IMAGE=$Base" `
  --build-arg "DOCKER_CLI_VERSION=$DockerCliVersion" `
  -t $Tag `
  $scriptDir | Write-Output

Write-Host "[docker] Image ready: $Tag"

