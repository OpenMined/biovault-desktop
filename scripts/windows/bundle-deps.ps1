Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\\.." )).Path
$cfgPath = Join-Path $repoRoot "scripts\\bundled-deps.json"
if (-not (Test-Path $cfgPath)) {
  throw "Missing config: $cfgPath"
}
$cfg = Get-Content -Raw $cfgPath | ConvertFrom-Json

# Detect architecture - allow override via environment variable
$arch = $env:BIOVAULT_TARGET_ARCH
if (-not $arch) {
  $cpuArch = $null
  try {
    $cpuArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  } catch {
    # Older .NET/PowerShell may not expose OSArchitecture
  }
  if (-not $cpuArch) {
    try {
      $cpuArch = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    } catch {
      # Older .NET/PowerShell may not expose ProcessArchitecture
    }
  }
  if (-not $cpuArch) {
    $cpuArch = $env:PROCESSOR_ARCHITECTURE
    if (-not $cpuArch -and $env:PROCESSOR_ARCHITEW6432) {
      $cpuArch = $env:PROCESSOR_ARCHITEW6432
    }
  }

  $cpuArch = ([string]$cpuArch).ToLower()
  switch ($cpuArch) {
    "arm64" { $arch = "aarch64" }
    "x64"   { $arch = "x86_64" }
    "x86"   { $arch = "x86_64" }  # Treat x86 as x86_64 for now
    "amd64" { $arch = "x86_64" }
    default { $arch = "x86_64" }
  }
}

$platform = "windows-$arch"
Write-Host "Building for platform: $platform" -ForegroundColor Cyan

$outBundled = Join-Path $repoRoot "src-tauri\\resources\\bundled"
$outSyftbox = Join-Path $repoRoot "src-tauri\\resources\\syftbox"
$keepTemp = ($env:BIOVAULT_KEEP_TEMP -eq "1")

New-Item -ItemType Directory -Force -Path $outBundled, $outSyftbox | Out-Null
$bundledReadme = Join-Path $outBundled "README.txt"
if (-not (Test-Path $bundledReadme)) {
  Set-Content -Path $bundledReadme -Value "Placeholder for bundled dependencies" -Encoding UTF8
}

function Download([string]$url, [string]$dest, [int]$attempts = 3) {
  for ($i = 1; $i -le $attempts; $i++) {
    try {
      Write-Host "Downloading $url"

      $curlCmd = Get-Command curl.exe -ErrorAction SilentlyContinue
      $curl = if ($curlCmd) { $curlCmd.Source } else { $null }
      if ($curl) {
        & $curl "-fL" "--retry" "$attempts" "--retry-all-errors" "--retry-delay" "2" "-o" "$dest" "$url" | Out-Null
      } else {
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -Headers @{"User-Agent"="biovault-desktop"}
      }

      if (-not (Test-Path $dest)) {
        throw "Download did not produce output file: $dest"
      }
      if ((Get-Item $dest).Length -le 0) {
        throw "Downloaded file is empty: $dest"
      }

      try { Unblock-File -Path $dest -ErrorAction SilentlyContinue } catch {}
      return
    } catch {
      if ($i -ge $attempts) { throw }
      Write-Host "Download failed (attempt $i/$attempts): $($_.Exception.Message)" -ForegroundColor Yellow
      Start-Sleep -Seconds (2 * $i)
    }
  }
}

function Get-GitHubJson([string]$url, [int]$attempts = 3) {
  for ($i = 1; $i -le $attempts; $i++) {
    try {
      return Invoke-RestMethod -Uri $url -Headers @{
        "User-Agent" = "biovault-desktop"
        "Accept"     = "application/vnd.github+json"
      }
    } catch {
      if ($i -ge $attempts) { throw }
      Start-Sleep -Seconds (2 * $i)
    }
  }
}

function New-TempDir([string]$prefix) {
  $p = Join-Path $env:TEMP ("$prefix" + [guid]::NewGuid().ToString("n"))
  New-Item -ItemType Directory -Force -Path $p | Out-Null
  return $p
}

function Resolve-JavaHomeFromExtract([string]$extractRoot) {
  $topDirs = @(Get-ChildItem -Path $extractRoot -Directory -ErrorAction SilentlyContinue)
  if ($topDirs.Count -eq 1) {
    return $topDirs[0].FullName
  }

  $release = Get-ChildItem -Recurse -File -Path $extractRoot -Filter release -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($release) {
    return $release.Directory.FullName
  }

  $javaExeAny = Get-ChildItem -Recurse -File -Path $extractRoot -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ieq "java.exe" } |
    Select-Object -First 1
  if ($javaExeAny) {
    return (Split-Path (Split-Path $javaExeAny.FullName -Parent) -Parent)
  }

  return $null
}

function Resolve-NextflowVersion([string]$raw) {
  $v = $raw.Trim()
  if ($v.StartsWith("v")) { $v = $v.Substring(1) }
  if ($v -ne "latest") { return $v }
  $latest = Get-GitHubJson "https://api.github.com/repos/nextflow-io/nextflow/releases/latest"
  $tag = [string]$latest.tag_name
  if ($tag.StartsWith("v")) { $tag = $tag.Substring(1) }
  if (-not $tag) { throw "Could not resolve latest Nextflow tag" }
  return $tag
}

function Resolve-NextflowDistJarUrl([string]$versionTag) {
  # The GitHub release provides a self-contained dist launcher that embeds the boot jar as a ZIP payload.
  # We download that file and extract the embedded jar locally.
  return "https://github.com/nextflow-io/nextflow/releases/download/v$versionTag/nextflow-$versionTag-dist"
}

function Extract-EmbeddedZipPayload([string]$sourcePath, [string]$destPath) {
  if (-not (Test-Path $sourcePath)) {
    throw "Missing source file: $sourcePath"
  }

  $pattern = [byte[]](0x0A,0x50,0x4B,0x03,0x04) # \nPK\x03\x04
  $fs = [System.IO.File]::OpenRead($sourcePath)
  try {
    $bufSize = 1024 * 1024
    $buf = New-Object byte[] $bufSize
    $prev = New-Object byte[] 4
    $offset = 0L
    $start = -1L

    while (($read = $fs.Read($buf, 0, $buf.Length)) -gt 0) {
      $scan = New-Object byte[] ($read + 4)
      [System.Array]::Copy($prev, 0, $scan, 0, 4)
      [System.Array]::Copy($buf, 0, $scan, 4, $read)

      for ($i = 0; $i -le $scan.Length - $pattern.Length; $i++) {
        $ok = $true
        for ($j = 0; $j -lt $pattern.Length; $j++) {
          if ($scan[$i + $j] -ne $pattern[$j]) { $ok = $false; break }
        }
        if ($ok) {
          $start = ($offset - 4) + ($i + 1) # point to the 'P' in PK..
          break
        }
      }

      if ($start -ge 0) { break }

      if ($read -ge 4) {
        [System.Array]::Copy($buf, $read - 4, $prev, 0, 4)
      } else {
        for ($k = 0; $k -lt 4; $k++) { $prev[$k] = 0 }
        [System.Array]::Copy($buf, 0, $prev, 4 - $read, $read)
      }

      $offset += $read
    }

    if ($start -lt 0) {
      throw "Could not find embedded ZIP payload in: $sourcePath"
    }

    $fs2 = [System.IO.File]::OpenRead($sourcePath)
    $out = [System.IO.File]::Create($destPath)
    try {
      $fs2.Position = $start
      $fs2.CopyTo($out)
    } finally {
      $out.Dispose()
      $fs2.Dispose()
    }
  } finally {
    $fs.Dispose()
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($destPath)
  try {
    $manifest = $zip.Entries | Where-Object { $_.FullName -eq "META-INF/MANIFEST.MF" } | Select-Object -First 1
    if (-not $manifest) {
      throw "Extracted payload is not a jar/zip with a manifest: $destPath"
    }
  } finally {
    $zip.Dispose()
  }
}

Write-Host "== Building syftbox.exe for bundling =="
$syftboxExe = Join-Path $outSyftbox "syftbox.exe"
Push-Location (Join-Path $repoRoot "biovault\\syftbox")
try {
  $version = (git describe --tags --always --dirty 2>$null)
  if (-not $version) { $version = "dev" }
  $rev = (git rev-parse --short HEAD 2>$null)
  if (-not $rev) { $rev = "HEAD" }
  $date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

  $ldflags = "-s -w " +
    "-X github.com/openmined/syftbox/internal/version.Version=$version " +
    "-X github.com/openmined/syftbox/internal/version.Revision=$rev " +
    "-X github.com/openmined/syftbox/internal/version.BuildDate=$date"

  # Set Go environment for cross-compilation
  $env:GO111MODULE = "on"
  $env:GOOS = "windows"
  $env:GOARCH = switch ($arch) {
    "aarch64" { "arm64" }
    "x86_64"  { "amd64" }
    default   { "amd64" }
  }
  Write-Host "  Building for GOOS=$($env:GOOS) GOARCH=$($env:GOARCH)"
  & go build "-ldflags=$ldflags" -o $syftboxExe ".\\cmd\\client"
} finally {
  Pop-Location
}

# =============================================================================
# SKIP Java and Nextflow on Windows
# On Windows, Nextflow runs via Docker container (nextflow/nextflow image)
# which includes its own Java runtime. This avoids Windows signal handling
# issues and reduces installer size by ~200MB.
# =============================================================================
Write-Host ""
Write-Host "== Skipping Java (runs via Docker container on Windows) ==" -ForegroundColor Yellow
Write-Host "== Skipping Nextflow (runs via Docker container on Windows) ==" -ForegroundColor Yellow
Write-Host ""

# Create placeholder directories so Tauri build doesn't fail
$javaDest = Join-Path $outBundled ("java\\$platform")
$nxfDest = Join-Path $outBundled ("nextflow\\$platform")
New-Item -ItemType Directory -Force -Path $javaDest | Out-Null
New-Item -ItemType Directory -Force -Path $nxfDest | Out-Null
Set-Content -Path (Join-Path $javaDest "README.txt") -Value "Java runs via Docker container on Windows" -Encoding UTF8
Set-Content -Path (Join-Path $nxfDest "README.txt") -Value "Nextflow runs via Docker container on Windows" -Encoding UTF8

<#
# DISABLED: Java bundling - not needed on Windows (Docker provides it)
Write-Host "== Fetching Java (Temurin JRE) =="
$javaMajor = [int]$cfg.java.major
$javaDest = Join-Path $outBundled ("java\\$platform")
Remove-Item -Recurse -Force $javaDest -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $javaDest | Out-Null

$tmp = New-TempDir "biovault-java-"
try {
  $metaPath = Join-Path $tmp "meta.json"
  $api = "https://api.adoptium.net/v3/assets/latest/$javaMajor/hotspot?architecture=x64&os=windows&image_type=jre&jvm_impl=hotspot&heap_size=normal&vendor=eclipse&archive_type=zip"
  Download $api $metaPath

  $meta = Get-Content -Raw $metaPath | ConvertFrom-Json
  $zipUrl = $meta[0].binary.package.link
  if (-not $zipUrl) { throw "Failed to resolve Java download URL from Adoptium metadata" }

  $zipPath = Join-Path $tmp "java.zip"
  Download $zipUrl $zipPath

  $extractRoot = Join-Path $tmp "extract"
  Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force

  $javaHome = Resolve-JavaHomeFromExtract $extractRoot
  if (-not $javaHome) {
    throw "Could not resolve Java home from extracted archive"
  }

  $javaExe = Join-Path $javaHome "bin\\java.exe"
  if (-not (Test-Path $javaExe)) {
    $javawExe = Join-Path $javaHome "bin\\javaw.exe"
    if (Test-Path $javawExe) {
      throw "Found javaw.exe but not java.exe under: $javaHome (need java.exe for CLI output)"
    }

    $hint = (Get-ChildItem -Recurse -File -Path $extractRoot -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^java(w)?\\.exe$' } |
      Select-Object -First 10 FullName | ForEach-Object { "  $_" }) -join "`n"
    throw "Could not find bin\\java.exe in extracted JRE. Candidates:\n$hint"
  }

  Copy-Item -Recurse -Force (Join-Path $javaHome "*") $javaDest
} catch {
  Write-Host "Java extraction failed: $($_.Exception.Message)" -ForegroundColor Red
  if (Test-Path (Join-Path $tmp "extract")) {
    Write-Host "Top-level extracted entries:" -ForegroundColor Yellow
    Get-ChildItem (Join-Path $tmp "extract") | Select-Object -First 30 Name,Mode
  }
  throw
} finally {
  if (-not $keepTemp) {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  } else {
    Write-Host "Keeping temp dir: $tmp" -ForegroundColor Yellow
  }
}

Write-Host "== Fetching Nextflow (dist payload; run via java -jar) =="
$nxfVer = Resolve-NextflowVersion ([string]$cfg.nextflow.version)
$nxfDest = Join-Path $outBundled ("nextflow\\$platform")
Remove-Item -Recurse -Force $nxfDest -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $nxfDest | Out-Null

$nextflowJarUrl = $env:NEXTFLOW_JAR_URL
if (-not $nextflowJarUrl) { $nextflowJarUrl = $env:NEXTFLOW_URL }
if (-not $nextflowJarUrl) { $nextflowJarUrl = Resolve-NextflowDistJarUrl $nxfVer }

$tmp = New-TempDir "biovault-nextflow-"
try {
  $distPath = Join-Path $tmp "nextflow-dist"
  Download $nextflowJarUrl $distPath 5

  if ((Get-Item $distPath).Length -lt 20000000) {
    throw "Downloaded Nextflow dist file looks too small (possible truncated download): $((Get-Item $distPath).Length) bytes"
  }

  $nxfJar = Join-Path $nxfDest "nextflow.jar"
  Extract-EmbeddedZipPayload $distPath $nxfJar

  $wrapperSrc = Join-Path $repoRoot "scripts\\windows\\nextflow-wrapper\\main.go"
  if (-not (Test-Path $wrapperSrc)) {
    throw "Missing nextflow wrapper source: $wrapperSrc"
  }
  $wrapperExe = Join-Path $nxfDest "nextflow.exe"
  Write-Host "Building nextflow.exe wrapper..."
  & go build -o $wrapperExe $wrapperSrc
  if (-not (Test-Path $wrapperExe)) {
    throw "Failed to build nextflow.exe wrapper at: $wrapperExe"
  }
} finally {
  if (-not $keepTemp) {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  } else {
    Write-Host "Keeping temp dir: $tmp" -ForegroundColor Yellow
  }
}
# END DISABLED Java/Nextflow bundling
#>

Write-Host "== Fetching uv =="
$uvVer = ([string]$cfg.uv.version).TrimStart("v")
$uvDest = Join-Path $outBundled ("uv\\$platform")
Remove-Item -Recurse -Force $uvDest -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $uvDest | Out-Null

# Map arch to UV release naming
$uvArch = switch ($arch) {
  "aarch64" { "aarch64" }
  "x86_64"  { "x86_64" }
  default   { "x86_64" }
}
$uvUrl = "https://github.com/astral-sh/uv/releases/download/$uvVer/uv-$uvArch-pc-windows-msvc.zip"
Write-Host "  UV URL: $uvUrl"

$tmp = New-TempDir "biovault-uv-"
try {
  $uvZip = Join-Path $tmp "uv.zip"
  Download $uvUrl $uvZip
  $uvExtract = Join-Path $tmp "extract"
  Expand-Archive -Path $uvZip -DestinationPath $uvExtract -Force
  $uvExe = Get-ChildItem -Recurse -File $uvExtract -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ieq "uv.exe" } |
    Select-Object -First 1
  if (-not $uvExe) { throw "Could not find uv.exe in extracted archive" }
  Copy-Item -Force $uvExe.FullName (Join-Path $uvDest "uv.exe")
} finally {
  if (-not $keepTemp) {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  } else {
    Write-Host "Keeping temp dir: $tmp" -ForegroundColor Yellow
  }
}

Write-Host "== Smoke test =="
$uvExe = Join-Path $uvDest "uv.exe"

& $syftboxExe -v
& $uvExe --version

Write-Host ""
Write-Host "Done. Bundled deps at: $outBundled" -ForegroundColor Green
Write-Host "Syftbox at: $syftboxExe" -ForegroundColor Green
Write-Host ""
Write-Host "Note: Java and Nextflow are NOT bundled on Windows." -ForegroundColor Yellow
Write-Host "      Nextflow will run via Docker container (nextflow/nextflow image)." -ForegroundColor Yellow
Write-Host "      Make sure Docker Desktop is installed and running." -ForegroundColor Yellow
