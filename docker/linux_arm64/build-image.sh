#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-biovault/linux-arm64-builder:local}"
CONTEXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found on PATH" >&2
  exit 1
fi

echo "[docker] Building ${IMAGE_NAME} (platform linux/amd64)..."
docker buildx build \
  --platform linux/amd64 \
  --load \
  --tag "${IMAGE_NAME}" \
  "${CONTEXT_DIR}"

echo "[docker] Image ready: ${IMAGE_NAME}"
