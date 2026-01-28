# ARM64 Nextflow Runner

This directory contains the Docker build files for the ARM64-native Nextflow runner image.

## Overview

The ARM64 Nextflow runner is designed for:
- **Linux ARM64** systems (e.g., AWS Graviton, Apple Silicon with Docker Desktop)
- **Windows ARM64** systems (e.g., Surface Pro X, Snapdragon laptops)

Unlike x86_64, where we can extend the official `nextflow/nextflow` image, ARM64 requires building from scratch since the official image is x86_64-only.

## Contents

| File | Description |
|------|-------------|
| `Dockerfile.nextflow-runner` | Multi-stage Dockerfile for ARM64 |
| `build-nextflow-runner.sh` | Build script with configurable versions |
| `test-nextflow-runner.sh` | Test script for CI validation |

## What's Included

- **Nextflow** (Java-based workflow engine)
- **Docker CLI** (ARM64 native, for Docker Desktop integration)
- **Podman CLI** (ARM64 native, for Podman integration)
- **OpenJDK 21** (ARM64 native runtime)
- **Tini** (proper init for signal handling)

## Building

### Local Build

```bash
# Build with defaults
./build-nextflow-runner.sh

# Build with custom tag
./build-nextflow-runner.sh --tag myregistry/nextflow-runner:custom

# Build and push
./build-nextflow-runner.sh --push
```

### Build Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--tag` | `ghcr.io/openmined/nextflow-runner:25.10.2-arm64` | Image name/tag |
| `--docker-cli-version` | `28.0.1` | Docker CLI version |
| `--podman-version` | `5.3.1` | Podman version |
| `--nextflow-version` | `25.10.2` | Nextflow version |

## Testing

```bash
# Run all tests
./test-nextflow-runner.sh

# Test a specific image
IMAGE_NAME=myregistry/nextflow-runner:test ./test-nextflow-runner.sh
```

### Test Coverage

1. Image exists
2. Nextflow version check
3. Docker CLI version check
4. Podman CLI version check
5. Java version check
6. Architecture verification (arm64)
7. Basic Nextflow execution
8. Non-root user check
9. Tini init verification

## CI/CD

The GitHub Actions workflow (`.github/workflows/nextflow-runner-arm64.yml`) automatically:

1. Builds the ARM64 image on push/PR
2. Runs the test suite
3. Pushes to GHCR on merge to main
4. Creates multi-arch manifests combining amd64 and arm64

## Usage in BioVault

BioVault automatically selects the appropriate architecture:

```rust
// On ARM64, uses: ghcr.io/openmined/nextflow-runner:25.10.2-arm64
// On x86_64, uses: ghcr.io/openmined/nextflow-runner:25.10.2-amd64
// With multi-arch manifest, Docker auto-selects the right one
```

## Why ARM64 Native?

Running x86_64 containers under QEMU emulation on ARM64 causes issues:
- **Go runtime crashes**: Docker/Podman CLI (written in Go) crashes when thread creation fails under QEMU
- **Performance**: Native ARM64 is significantly faster than emulated x86_64
- **Reliability**: Native execution avoids emulation edge cases

## Version Matrix

| Component | Version | Architecture |
|-----------|---------|--------------|
| Alpine Linux | 3.21 | arm64 |
| OpenJDK | 21 | arm64 |
| Nextflow | 25.10.2 | JVM (arch-independent) |
| Docker CLI | 28.0.1 | arm64 |
| Podman | 5.3.1 | arm64 |
