#!/bin/bash
set -euo pipefail

# Thin wrapper around biovault-app.sh that uses a local tauri binary.
# Default profile is release for production-like performance while testing local changes.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${BIOVAULT_DEV_PROFILE:-release}"
DEV_SYQURE_BIN="${SEQURE_NATIVE_BIN:-$SCRIPT_DIR/syqure/target/release/syqure}"
FORCE_REBUILD="${BIOVAULT_DEV_REBUILD:-0}"

ARGS=()
for arg in "$@"; do
  case "$arg" in
    --release)
      PROFILE="release"
      ;;
    --debug)
      PROFILE="debug"
      ;;
    --rebuild)
      FORCE_REBUILD=1
      ;;
    *)
      ARGS+=("$arg")
      ;;
  esac
done

if [[ "$PROFILE" == "release" ]]; then
  DEV_BIN="${APP_BIN:-$SCRIPT_DIR/src-tauri/target/release/bv-desktop}"
  BUILD_CMD=(cargo build --release)
else
  DEV_BIN="${APP_BIN:-$SCRIPT_DIR/src-tauri/target/debug/bv-desktop}"
  BUILD_CMD=(cargo build)
fi

if [[ "$FORCE_REBUILD" == "1" || ! -x "$DEV_BIN" ]]; then
  if [[ "$FORCE_REBUILD" == "1" ]]; then
    echo "Forcing $PROFILE rebuild (${BUILD_CMD[*]})..."
  else
    echo "$PROFILE binary not found at $DEV_BIN"
    echo "Building $PROFILE binary (${BUILD_CMD[*]})..."
  fi
  (cd "$SCRIPT_DIR/src-tauri" && "${BUILD_CMD[@]}")
fi

if [[ ! -x "$DEV_BIN" ]]; then
  echo "$PROFILE binary not found at $DEV_BIN"
  echo "$PROFILE binary still missing at $DEV_BIN"
  exit 1
fi

if [[ ! -x "$DEV_SYQURE_BIN" ]]; then
  echo "Required local Syqure binary missing: $DEV_SYQURE_BIN"
  echo "Build it with: (cd $SCRIPT_DIR/syqure && cargo build --release)"
  exit 1
fi

echo "Launching with profile=$PROFILE APP_BIN=$DEV_BIN"

APP_BIN="$DEV_BIN" \
SEQURE_NATIVE_BIN="$DEV_SYQURE_BIN" \
SYQURE_SKIP_BUNDLE=1 \
exec "$SCRIPT_DIR/biovault-app.sh" "${ARGS[@]}"
