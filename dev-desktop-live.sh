#!/usr/bin/env bash
set -euo pipefail

# Build and run the desktop app against hosted dev.syftbox.net using production
# build settings (bundled syftbox prod binary + tauri release build).
# Usage: BIOVAULT_HOME=/path/to/home ./dev-desktop-live.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIOVAULT_HOME="${BIOVAULT_HOME:-$HOME/Desktop/BioVaultLive}"
SYFTBOX_URL="${SYFTBOX_URL:-https://dev.syftbox.net}"
SYFTBOX_AUTH_ENABLED="${SYFTBOX_AUTH_ENABLED:-1}"

echo "[live] BIOVAULT_HOME=$BIOVAULT_HOME"
mkdir -p "$BIOVAULT_HOME"

echo "[live] Building prod syftbox bundle..."
"$ROOT_DIR/scripts/build-syftbox-prod.sh"

echo "[live] Fetching bundled deps..."
"$ROOT_DIR/scripts/fetch-bundled-deps.sh"

SYFTBOX_BIN="$ROOT_DIR/src-tauri/resources/syftbox/syftbox"
if [[ ! -x "$SYFTBOX_BIN" ]]; then
  echo "[live] ERROR: syftbox binary missing at $SYFTBOX_BIN" >&2
  exit 1
fi

export BIOVAULT_HOME
export SYFTBOX_BINARY="$SYFTBOX_BIN"
export SYFTBOX_VERSION="$(git -C "$ROOT_DIR" describe --tags --always --dirty 2>/dev/null || echo dev)"
export SYFTBOX_SERVER_URL="$SYFTBOX_URL"
export SYFTBOX_AUTH_ENABLED

echo "[live] Starting tauri build against $SYFTBOX_URL (prod settings)..."
cd "$ROOT_DIR"
bun run tauri build

echo "[live] Build complete."
