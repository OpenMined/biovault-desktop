#!/usr/bin/env bash
set -euo pipefail

# Build and run the desktop app against hosted dev.syftbox.net using production
# build settings (bundled syftbox prod binary + tauri release build).
# Usage: BIOVAULT_HOME=/path/to/home ./dev-desktop-live.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$ROOT_DIR}"
BIOVAULT_HOME="${BIOVAULT_HOME:-$HOME/Desktop/BioVaultLive}"
SYFTBOX_URL="${SYFTBOX_URL:-https://dev.syftbox.net}"
SYFTBOX_AUTH_ENABLED="${SYFTBOX_AUTH_ENABLED:-1}"
BV_SYFTBOX_BACKEND="${BV_SYFTBOX_BACKEND:-embedded}"

WORKSPACE_ROOT="$WORKSPACE_ROOT" "$ROOT_DIR/scripts/ensure-workspace-deps.sh" \
  "biovault/cli/Cargo.toml" \
  "syftbox-sdk/Cargo.toml" \
  "syftbox/rust/Cargo.toml"

if [[ "$BV_SYFTBOX_BACKEND" == "process" ]]; then
  SYFTBOX_DIR="${SYFTBOX_DIR:-$WORKSPACE_ROOT/syftbox}"
  if [[ ! -d "$SYFTBOX_DIR" && -d "$WORKSPACE_ROOT/biovault/syftbox" ]]; then
    SYFTBOX_DIR="$WORKSPACE_ROOT/biovault/syftbox"
  fi
  if [[ ! -d "$SYFTBOX_DIR" ]]; then
    echo "[live] ERROR: syftbox repo not found at $SYFTBOX_DIR" >&2
    echo "[live] Fix: run ./repo --init && ./repo sync from $WORKSPACE_ROOT" >&2
    exit 1
  fi
  export SYFTBOX_DIR
fi

echo "[live] BIOVAULT_HOME=$BIOVAULT_HOME"
mkdir -p "$BIOVAULT_HOME"

echo "[live] Fetching bundled deps..."
"$ROOT_DIR/scripts/fetch-bundled-deps.sh"

if [[ "$BV_SYFTBOX_BACKEND" == "process" ]]; then
  echo "[live] Building prod syftbox bundle..."
  "$ROOT_DIR/scripts/build-syftbox-prod.sh"

  SYFTBOX_BIN="$ROOT_DIR/src-tauri/resources/syftbox/syftbox"
  if [[ ! -x "$SYFTBOX_BIN" ]]; then
    echo "[live] ERROR: syftbox binary missing at $SYFTBOX_BIN" >&2
    exit 1
  fi
fi

export BIOVAULT_HOME
export BV_SYFTBOX_BACKEND
if [[ "$BV_SYFTBOX_BACKEND" == "process" ]]; then
  export SYFTBOX_BINARY="$SYFTBOX_BIN"
  export SYFTBOX_VERSION="$(git -C "$ROOT_DIR" describe --tags --always --dirty 2>/dev/null || echo dev)"
else
  unset SYFTBOX_BINARY SYFTBOX_VERSION
fi
export SYFTBOX_SERVER_URL="$SYFTBOX_URL"
export SYFTBOX_AUTH_ENABLED

echo "[live] Starting tauri build against $SYFTBOX_URL (prod settings)..."
cd "$ROOT_DIR"
bun run tauri build

echo "[live] Build complete."
