#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-biovault/linux-arm64-builder:local}"
CONTEXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found on PATH" >&2
  exit 1
fi

HOST_PLATFORM="linux/amd64"
while (($#)); do
  case "$1" in
    --arm64)
      HOST_PLATFORM="linux/arm64"
      shift
      ;;
    --amd64)
      HOST_PLATFORM="linux/amd64"
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--arm64|--amd64]" >&2
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--arm64|--amd64]" >&2
      exit 1
      ;;
  esac
done

export DOCKER_DEFAULT_PLATFORM="${DOCKER_DEFAULT_PLATFORM:-${HOST_PLATFORM}}"
BUILD_PLATFORM="${BUILD_PLATFORM:-${HOST_PLATFORM}}"
BUILD_OUTPUT="${BUILD_OUTPUT:---load}"

echo "[docker] Building ${IMAGE_NAME} (platform ${BUILD_PLATFORM})..."

if command -v docker-buildx >/dev/null 2>&1 || docker buildx version >/dev/null 2>&1; then
  docker buildx build \
    --platform "${BUILD_PLATFORM}" \
    ${BUILD_OUTPUT} \
    --tag "${IMAGE_NAME}" \
    "${CONTEXT_DIR}"
else
  docker build \
    --platform "${BUILD_PLATFORM}" \
    --tag "${IMAGE_NAME}" \
    "${CONTEXT_DIR}"
fi

echo "[docker] Image ready: ${IMAGE_NAME}"
