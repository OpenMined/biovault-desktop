#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-biovault/linux-arm64-builder:local}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found on PATH" >&2
  exit 1
fi

echo "[docker] Ensuring qemu-aarch64 binfmt is registered..."
if ! docker run --rm --privileged tonistiigi/binfmt --install arm64 >/dev/null 2>&1; then
  echo "[docker] Failed to register binfmt for arm64 via tonistiigi/binfmt" >&2
  exit 1
fi
echo "[docker] binfmt registration complete"

if ! docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
  "${SCRIPT_DIR}/build-image.sh"
fi

CACHE_ROOT="${REPO_ROOT}/.cache/docker-linux-arm64"
mkdir -p "${CACHE_ROOT}/cargo/registry" "${CACHE_ROOT}/cargo/git"

COMMAND=${1:-build}
case "${COMMAND}" in
  build)
BUILD_CMD='set -euo pipefail
cd /workspace/biovault
export PKG_CONFIG_LIBDIR=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig
export PKG_CONFIG_SYSROOT_DIR=/
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
export CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc
export CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++
export APPIMAGE_EXTRACT_AND_RUN=1
npm install
npm run tauri build -- --target aarch64-unknown-linux-gnu'
    ;;
  shell)
    BUILD_CMD='bash'
    ;;
  *)
    echo "Unknown command: ${COMMAND}" >&2
    echo "Usage: $0 [build|shell]" >&2
    exit 1
    ;;
esac

if [ "${COMMAND}" = "shell" ]; then
  docker run --rm -it \
    --platform linux/amd64 \
    -v "${REPO_ROOT}:/workspace/biovault" \
    -v "${CACHE_ROOT}/cargo/registry:/root/.cargo/registry" \
    -v "${CACHE_ROOT}/cargo/git:/root/.cargo/git" \
    -w /workspace/biovault \
    "${IMAGE_NAME}" \
    bash
else
  docker run --rm \
    --platform linux/amd64 \
    -v "${REPO_ROOT}:/workspace/biovault" \
    -v "${CACHE_ROOT}/cargo/registry:/root/.cargo/registry" \
    -v "${CACHE_ROOT}/cargo/git:/root/.cargo/git" \
    -w /workspace/biovault \
    "${IMAGE_NAME}" \
    bash -lc "${BUILD_CMD}"
fi
