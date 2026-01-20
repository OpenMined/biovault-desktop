#!/bin/bash
# Development script for the new SvelteKit UI with the existing Tauri backend
#
# This script:
# 1. Sets up environment variables for BioVault
# 2. Starts the SvelteKit dev server in bv-desktop-new/
# 3. Runs cargo tauri dev with the new-ui config
#
# Usage: ./dev-new-ui.sh
# Or with custom home: BIOVAULT_HOME=/path/to/home ./dev-new-ui.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Set up BioVault environment (same as dev-desktop-live.sh)
export BIOVAULT_HOME="${BIOVAULT_HOME:-$HOME/Desktop/BioVaultLive}"
export BV_SYFTBOX_BACKEND="embedded"
export SYFTBOX_SERVER_URL="${SYFTBOX_URL:-https://dev.syftbox.net}"
export SYFTBOX_AUTH_ENABLED="${SYFTBOX_AUTH_ENABLED:-1}"
export SYFTBOX_CONFIG_PATH="$BIOVAULT_HOME/syftbox/config.json"
export SYFTBOX_DATA_DIR="$BIOVAULT_HOME"
export SYC_VAULT="$SYFTBOX_DATA_DIR/.syc"
export BIOVAULT_DEV_MODE=1
export BIOVAULT_DEBUG_BANNER=1

echo "[new-ui] BIOVAULT_HOME=$BIOVAULT_HOME"
mkdir -p "$BIOVAULT_HOME"

# Cleanup function
cleanup() {
    echo "Cleaning up..."
    kill $VITE_PID 2>/dev/null || true
}
trap cleanup EXIT

# Start SvelteKit dev server in background
echo "Starting SvelteKit dev server..."
cd bv-desktop-new
bun run dev &
VITE_PID=$!
cd "$SCRIPT_DIR"

# Wait for Vite to be ready
echo "Waiting for dev server to start..."
sleep 3

# Run Tauri with the new UI config
echo "Starting Tauri with new UI..."
cd src-tauri
bunx tauri dev --config tauri.conf.new-ui.json
