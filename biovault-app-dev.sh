#!/bin/bash
set -euo pipefail

# Thin wrapper around biovault-app.sh that uses the local debug binary.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEBUG_BIN="${APP_BIN:-$SCRIPT_DIR/src-tauri/target/debug/bv-desktop}"
DEV_SYQURE_BIN="${SEQURE_NATIVE_BIN:-$SCRIPT_DIR/syqure/target/release/syqure}"
FORCE_REBUILD="${BIOVAULT_DEV_REBUILD:-0}"

ARGS=()
for arg in "$@"; do
  case "$arg" in
    --rebuild)
      FORCE_REBUILD=1
      ;;
    *)
      ARGS+=("$arg")
      ;;
  esac
done

if [[ "$FORCE_REBUILD" == "1" || ! -x "$DEBUG_BIN" ]]; then
  if [[ "$FORCE_REBUILD" == "1" ]]; then
    echo "Forcing debug rebuild (cargo build)..."
  else
    echo "Debug binary not found at $DEBUG_BIN"
    echo "Building debug binary (cargo build)..."
  fi
  (cd "$SCRIPT_DIR/src-tauri" && cargo build)
fi

if [[ ! -x "$DEBUG_BIN" ]]; then
  echo "Debug binary not found at $DEBUG_BIN"
  echo "Debug binary still missing at $DEBUG_BIN"
  exit 1
fi

if [[ ! -x "$DEV_SYQURE_BIN" ]]; then
  echo "Required local Syqure binary missing: $DEV_SYQURE_BIN"
  echo "Build it with: (cd $SCRIPT_DIR/syqure && cargo build --release)"
  exit 1
fi

APP_BIN="$DEBUG_BIN" \
SEQURE_NATIVE_BIN="$DEV_SYQURE_BIN" \
SYQURE_SKIP_BUNDLE=1 \
exec "$SCRIPT_DIR/biovault-app.sh" "${ARGS[@]}"
