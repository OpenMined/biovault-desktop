#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-biovault/linux-arm64-builder:local}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found on PATH" >&2
  exit 1
fi

if [ "${SKIP_BINFMT_REGISTRATION:-0}" != "1" ]; then
  echo "[docker] Ensuring qemu-aarch64 binfmt is registered..."
  if docker run --rm --privileged tonistiigi/binfmt --install arm64; then
    echo "[docker] binfmt registration via tonistiigi/binfmt complete"
  elif docker run --rm --privileged multiarch/qemu-user-static --reset -p yes; then
    echo "[docker] binfmt registration via multiarch/qemu-user-static complete"
  else
    echo "[docker] Failed to register binfmt for arm64" >&2
    echo "[docker] Set SKIP_BINFMT_REGISTRATION=1 to bypass (AppImage build may fail)" >&2
    exit 1
  fi
else
  echo "[docker] Skipping binfmt registration (SKIP_BINFMT_REGISTRATION=1)"
fi

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
export QEMU_LD_PREFIX=/usr/aarch64-linux-gnu
export LD_LIBRARY_PATH=/usr/lib/aarch64-linux-gnu:/lib/aarch64-linux-gnu:/usr/aarch64-linux-gnu/lib:/usr/aarch64-linux-gnu/usr/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}
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
