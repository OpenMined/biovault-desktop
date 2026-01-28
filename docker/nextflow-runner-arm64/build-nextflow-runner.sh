#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default values - can be overridden via environment or flags
IMAGE_NAME="${IMAGE_NAME:-ghcr.io/openmined/nextflow-runner:25.10.2-arm64}"
DOCKER_CLI_VERSION="${DOCKER_CLI_VERSION:-28.0.1}"
PODMAN_VERSION="${PODMAN_VERSION:-5.3.1}"
NEXTFLOW_VERSION="${NEXTFLOW_VERSION:-25.10.2}"
PLATFORM="${PLATFORM:-linux/arm64}"

usage() {
  cat >&2 <<EOF
Usage: $0 [OPTIONS]

Build the ARM64-native Nextflow runner image with Docker and Podman CLI.

Options:
  --tag <image>              Image name/tag (default: ${IMAGE_NAME})
  --docker-cli-version <ver> Docker CLI version (default: ${DOCKER_CLI_VERSION})
  --podman-version <ver>     Podman version (default: ${PODMAN_VERSION})
  --nextflow-version <ver>   Nextflow version (default: ${NEXTFLOW_VERSION})
  --platform <platform>      Build platform (default: ${PLATFORM})
  --push                     Push image after building
  --help, -h                 Show this help message

Environment overrides:
  IMAGE_NAME           (default: ${IMAGE_NAME})
  DOCKER_CLI_VERSION   (default: ${DOCKER_CLI_VERSION})
  PODMAN_VERSION       (default: ${PODMAN_VERSION})
  NEXTFLOW_VERSION     (default: ${NEXTFLOW_VERSION})
  PLATFORM             (default: ${PLATFORM})

Examples:
  # Build locally
  $0

  # Build and push
  $0 --push

  # Build with custom tag
  $0 --tag myregistry/nextflow-runner:latest
EOF
}

PUSH_IMAGE=0

while (($#)); do
  case "$1" in
    --tag)
      IMAGE_NAME="${2:-}"
      shift 2
      ;;
    --docker-cli-version)
      DOCKER_CLI_VERSION="${2:-}"
      shift 2
      ;;
    --podman-version)
      PODMAN_VERSION="${2:-}"
      shift 2
      ;;
    --nextflow-version)
      NEXTFLOW_VERSION="${2:-}"
      shift 2
      ;;
    --platform)
      PLATFORM="${2:-}"
      shift 2
      ;;
    --push)
      PUSH_IMAGE=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

# Validate required values
if [ -z "${IMAGE_NAME}" ]; then
  echo "Error: IMAGE_NAME is required" >&2
  usage
  exit 1
fi

# Find docker binary
DOCKER_BIN="docker"
if ! command -v "${DOCKER_BIN}" >/dev/null 2>&1; then
  echo "Error: docker not found on PATH" >&2
  exit 1
fi

echo "========================================"
echo "Building ARM64 Nextflow Runner"
echo "========================================"
echo "Image:            ${IMAGE_NAME}"
echo "Platform:         ${PLATFORM}"
echo "Docker CLI:       ${DOCKER_CLI_VERSION}"
echo "Podman:           ${PODMAN_VERSION}"
echo "Nextflow:         ${NEXTFLOW_VERSION}"
echo "========================================"

# Build the image
"${DOCKER_BIN}" build \
  --platform "${PLATFORM}" \
  -f "${SCRIPT_DIR}/Dockerfile.nextflow-runner" \
  --build-arg "DOCKER_CLI_VERSION=${DOCKER_CLI_VERSION}" \
  --build-arg "PODMAN_VERSION=${PODMAN_VERSION}" \
  --build-arg "NEXTFLOW_VERSION=${NEXTFLOW_VERSION}" \
  -t "${IMAGE_NAME}" \
  "${SCRIPT_DIR}"

echo ""
echo "✅ Image built: ${IMAGE_NAME}"

# Push if requested
if [ "${PUSH_IMAGE}" = "1" ]; then
  echo ""
  echo "Pushing ${IMAGE_NAME}..."
  "${DOCKER_BIN}" push "${IMAGE_NAME}"
  echo "✅ Image pushed: ${IMAGE_NAME}"
fi

echo ""
echo "To test the image, run:"
echo "  ${SCRIPT_DIR}/test-nextflow-runner.sh"
