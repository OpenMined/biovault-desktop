#!/usr/bin/env bash
set -euo pipefail

# Run the desktop app against hosted dev.syftbox.net using dev settings
# (embedded syftbox-rs backend + npm dev server).
# Usage: BIOVAULT_HOME=/path/to/home ./dev-desktop-live.sh [--email you@example.com]

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$ROOT_DIR}"
BIOVAULT_HOME="${BIOVAULT_HOME:-$HOME/Desktop/BioVaultLive}"
SYFTBOX_URL="${SYFTBOX_URL:-https://dev.syftbox.net}"
SYFTBOX_AUTH_ENABLED="${SYFTBOX_AUTH_ENABLED:-1}"
SYFTBOX_EMAIL="${SYFTBOX_EMAIL:-${CLIENT_EMAIL:-client1@sandbox.local}}"
BV_SYFTBOX_BACKEND="embedded"

WORKSPACE_ROOT="$WORKSPACE_ROOT" "$ROOT_DIR/scripts/ensure-workspace-deps.sh" \
  "biovault/cli/Cargo.toml" \
  "syftbox-sdk/Cargo.toml" \
  "syftbox/rust/Cargo.toml"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email)
      SYFTBOX_EMAIL="${2:?--email requires a value}"
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--email you@example.com]"
      exit 0
      ;;
    *)
      break
      ;;
  esac
  shift
done

echo "[live] BIOVAULT_HOME=$BIOVAULT_HOME"
mkdir -p "$BIOVAULT_HOME"

echo "[live] Building syftbox-rs (embedded)..."
"$ROOT_DIR/scripts/build-syftbox-rust.sh"

export BIOVAULT_HOME
export BV_SYFTBOX_BACKEND
unset SYFTBOX_BINARY SYFTBOX_VERSION
export SYFTBOX_SERVER_URL="$SYFTBOX_URL"
export SYFTBOX_AUTH_ENABLED
export SYFTBOX_EMAIL
export SYFTBOX_CONFIG_PATH="$BIOVAULT_HOME/syftbox/config.json"
export SYFTBOX_DATA_DIR="$BIOVAULT_HOME"
export SYC_VAULT="$BIOVAULT_HOME/.syc"

export BIOVAULT_DEV_MODE=1
export BIOVAULT_DEV_SYFTBOX=1
export BIOVAULT_DISABLE_PROFILES=1
export BIOVAULT_DEBUG_BANNER=1

echo "[live] Starting dev server against $SYFTBOX_URL (embedded syftbox-rs)..."
cd "$ROOT_DIR"
npm run dev

echo "[live] Dev server exited."
