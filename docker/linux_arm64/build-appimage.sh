#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-biovault/linux-arm64-builder:local}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found on PATH" >&2
  exit 1
fi

HOST_PLATFORM="linux/amd64"
POSITIONAL=()
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
      echo "Usage: $0 [--arm64|--amd64] [build|shell]" >&2
      exit 0
      ;;
    --)
      shift
      POSITIONAL+=("$@")
      break
      ;;
    -* )
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--arm64|--amd64] [build|shell]" >&2
      exit 1
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [ ${#POSITIONAL[@]} -gt 1 ]; then
  echo "Unexpected arguments: ${POSITIONAL[*]}" >&2
  echo "Usage: $0 [--arm64|--amd64] [build|shell]" >&2
  exit 1
fi

COMMAND="build"
if [ ${#POSITIONAL[@]} -eq 1 ]; then
  COMMAND="${POSITIONAL[0]}"
fi

case "${COMMAND}" in
  build|shell)
    ;;
  *)
    echo "Unknown command: ${COMMAND}" >&2
    echo "Usage: $0 [--arm64|--amd64] [build|shell]" >&2
    exit 1
    ;;
esac

export DOCKER_DEFAULT_PLATFORM="${DOCKER_DEFAULT_PLATFORM:-${HOST_PLATFORM}}"
RUN_PLATFORM="${RUN_PLATFORM:-${HOST_PLATFORM}}"

if ! docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
  if [ "${HOST_PLATFORM}" = "linux/arm64" ]; then
    "${SCRIPT_DIR}/build-image.sh" --arm64
  else
    "${SCRIPT_DIR}/build-image.sh" --amd64
  fi
fi

CACHE_ROOT="${REPO_ROOT}/.cache/docker-linux-arm64"
mkdir -p "${CACHE_ROOT}/cargo/registry" "${CACHE_ROOT}/cargo/git"

case "${COMMAND}" in
  build)
    BUILD_CMD="$(cat <<'EOF_BUILD'
set -euo pipefail
cd /workspace/biovault
export PKG_CONFIG_LIBDIR=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig
export PKG_CONFIG_SYSROOT_DIR=/
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
export CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc
export CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++
export QEMU_LD_PREFIX=/usr/aarch64-linux-gnu
export LD_LIBRARY_PATH=/usr/lib/aarch64-linux-gnu:/lib/aarch64-linux-gnu:/usr/aarch64-linux-gnu/lib:/usr/aarch64-linux-gnu/usr/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}
export RUST_BACKTRACE=1
export RUST_LOG=tauri_bundler=debug

ARCH="$(uname -m)"
echo "[preflight] Architecture: ${ARCH}"

# Check QEMU/binfmt setup
echo "[preflight] Checking QEMU ARM64 support:"
if [ -f /proc/sys/fs/binfmt_misc/qemu-aarch64 ]; then
  echo "  ✓ binfmt_misc qemu-aarch64 handler is registered"
  cat /proc/sys/fs/binfmt_misc/qemu-aarch64
else
  echo "  ✗ binfmt_misc qemu-aarch64 handler NOT found"
  echo "  Available handlers:"
  ls -la /proc/sys/fs/binfmt_misc/ 2>/dev/null || echo "  binfmt_misc not available"
fi

# Test if we can run ARM64 binaries
if [ "${ARCH}" != "aarch64" ] && [ "${ARCH}" != "arm64" ]; then
  echo "[preflight] Testing ARM64 binary execution:"
  if command -v qemu-aarch64-static >/dev/null 2>&1; then
    echo "  ✓ qemu-aarch64-static is available"
  else
    echo "  ✗ qemu-aarch64-static NOT found"
  fi
fi

case "${ARCH}" in
  aarch64|arm64)
    export APPIMAGE_EXTRACT_AND_RUN=1
    ;;
esac

npm install
npm run tauri build -- --target aarch64-unknown-linux-gnu
EOF_BUILD
)"
    ;;
  shell)
    BUILD_CMD='bash'
    ;;
  *)
    echo "Unknown command: ${COMMAND}" >&2
    echo "Usage: $0 [--arm64|--amd64] [build|shell]" >&2
    exit 1
    ;;
esac

if [ "${COMMAND}" = "shell" ]; then
  docker run --rm -it \
    --platform "${RUN_PLATFORM}" \
    -v "${REPO_ROOT}:/workspace/biovault" \
    -v "${CACHE_ROOT}/cargo/registry:/root/.cargo/registry" \
    -v "${CACHE_ROOT}/cargo/git:/root/.cargo/git" \
    -w /workspace/biovault \
    "${IMAGE_NAME}" \
    bash
else
  docker run --rm \
    --platform "${RUN_PLATFORM}" \
    -v "${REPO_ROOT}:/workspace/biovault" \
    -v "${CACHE_ROOT}/cargo/registry:/root/.cargo/registry" \
    -v "${CACHE_ROOT}/cargo/git:/root/.cargo/git" \
    -w /workspace/biovault \
    "${IMAGE_NAME}" \
    bash -lc "${BUILD_CMD}"
fi
