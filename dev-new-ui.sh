#!/usr/bin/env bash
set -euo pipefail

# Launch a single BioVault Desktop instance with the NEW UI (src)
#
# Usage:
#   ./dev-new-ui.sh [--client EMAIL] [--reset] [--path DIR]
#
# Examples:
#   ./dev-new-ui.sh                          # Default client
#   ./dev-new-ui.sh --client alice@test.com  # Custom client
#   ./dev-new-ui.sh --reset                  # Reset client directory first

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$ROOT_DIR}"
BIOVAULT_DIR="${BIOVAULT_DIR:-$WORKSPACE_ROOT/biovault}"
SYFTBOX_URL="${SYFTBOX_URL:-https://dev.syftbox.net}"
SYFTBOX_AUTH_ENABLED="${SYFTBOX_AUTH_ENABLED:-0}"
SANDBOX_DIR="${SANDBOX_DIR:-$ROOT_DIR/sandbox}"
LOG_DIR="$ROOT_DIR/logs"
CLIENT_EMAIL=""
RESET_FLAG=0
VITE_PID=""

mkdir -p "$LOG_DIR"

DEFAULT_CLIENT="${CLIENT_EMAIL:-kj@kj.dev}"

# Build BioVault CLI and embedded syftbox
build_binaries() {
  echo "[new-ui] Building BioVault CLI (release)..."
  (cd "$BIOVAULT_DIR/cli" && cargo build --release)
  
  echo "[new-ui] Building syftbox-rs (embedded)..."
  (cd "$ROOT_DIR" && ./scripts/build-syftbox-rust.sh)
  local bin="$ROOT_DIR/src-tauri/resources/syftbox/syftbox"
  if [[ ! -x "$bin" ]]; then
    echo "[new-ui] ERROR: syftbox-rs binary missing at $bin" >&2
    exit 1
  fi
  echo "[new-ui] Binaries ready"
}

# Provision a client directory
provision_client() {
  local email="$1"
  local client_dir="$SANDBOX_DIR/$email"
  
  if (( RESET_FLAG )) && [[ -d "$client_dir" ]]; then
    echo "[new-ui] Resetting client $email (--reset flag)"
    
    # Kill any running processes
    pkill -f "jupyter.*$client_dir" 2>/dev/null || true
    pkill -f "BIOVAULT_HOME=$client_dir" 2>/dev/null || true
    
    # Remove client directory
    rm -rf "$client_dir"
    
    # Remove profile entry from profiles store
    local profiles_file="$HOME/.bvprofiles/profiles.json"
    if [[ -f "$profiles_file" ]]; then
      local abs_client_dir
      abs_client_dir="$(cd "$(dirname "$client_dir")" 2>/dev/null && pwd)/$(basename "$client_dir")" 2>/dev/null || abs_client_dir="$client_dir"
      echo "[new-ui] Cleaning up profile entry for: $abs_client_dir"
      # Use jq if available, otherwise just warn
      if command -v jq >/dev/null 2>&1; then
        local tmp_file="${profiles_file}.tmp"
        jq --arg path "$abs_client_dir" '.profiles = [.profiles[] | select(.biovault_home != $path)]' "$profiles_file" > "$tmp_file" 2>/dev/null && mv "$tmp_file" "$profiles_file" || true
      else
        echo "[new-ui] Warning: jq not found, profiles store not cleaned. Run: rm ~/.bvprofiles/profiles.json"
      fi
    fi
    
    # Clear settings.json cache if exists
    rm -rf "$client_dir/database" 2>/dev/null || true
  fi
  
  mkdir -p "$client_dir"
  echo "[new-ui] Client dir: $client_dir"
}

# Start Vite dev server (shared frontend)
start_vite() {
  echo "[new-ui] Starting Vite dev server..."
  (
    cd "$ROOT_DIR/src"
    npm run dev -- --port 1420 2>&1 | while read -r line; do
      echo "[VITE] $line"
    done
  ) &
  VITE_PID=$!
  
  # Wait for Vite to be ready
  echo "[new-ui] Waiting for Vite..."
  for i in {1..30}; do
    if curl -s http://localhost:1420 >/dev/null 2>&1; then
      echo "[new-ui] Vite ready on :1420"
      return 0
    fi
    sleep 1
  done
  echo "[new-ui] ERROR: Vite did not start" >&2
  exit 1
}

# Launch NEW UI Tauri instance
launch_tauri_instance() {
  local home="$1"
  local email="$2"
  
  echo "[new-ui] Launching Tauri with BIOVAULT_HOME=$home email=$email"
  
  (
    cd "$ROOT_DIR/src-tauri"
    
    export BIOVAULT_HOME="$home"
    export BV_SYFTBOX_BACKEND="embedded"
    export SYFTBOX_SERVER_URL="$SYFTBOX_URL"
    export SYFTBOX_EMAIL="$email"
    export SYFTBOX_AUTH_ENABLED="$SYFTBOX_AUTH_ENABLED"
    export SYFTBOX_CONFIG_PATH="$home/syftbox/config.json"
    export SYFTBOX_DATA_DIR="$home"
    export SYC_VAULT="$SYFTBOX_DATA_DIR/.syc"
    export BIOVAULT_DEV_MODE=1
    export BIOVAULT_DEV_SYFTBOX=1
    export BIOVAULT_DEBUG_BANNER=1
    export BIOVAULT_DISABLE_PROFILES=1
    
    bunx tauri dev --config '{"build": {"devUrl": "http://localhost:1420", "frontendDist": "../src/build"}}' 2>&1 | while read -r line; do
      echo "[TAURI] $line"
    done
  )
}

cleanup() {
  echo ""
  echo "[new-ui] Shutting down..."
  
  [[ -n "$VITE_PID" ]] && kill "$VITE_PID" 2>/dev/null || true
  
  # Kill any orphan processes
  pkill -f "tauri dev.*new-ui" 2>/dev/null || true
  pkill -f "vite.*1420" 2>/dev/null || true
  
  echo "[new-ui] Done"
}

trap cleanup EXIT INT TERM

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --client)
      CLIENT_EMAIL="$2"
      shift 2
      ;;
    --reset)
      RESET_FLAG=1
      shift
      ;;
    --path)
      SANDBOX_DIR="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# Set default client if not specified
if [[ -z "$CLIENT_EMAIL" ]]; then
  CLIENT_EMAIL="$DEFAULT_CLIENT"
fi

echo "=============================================="
echo " BioVault Desktop - New UI (Single Client)"
echo "=============================================="
echo " Client: $CLIENT_EMAIL"
echo " SyftBox: $SYFTBOX_URL"
echo " Sandbox: $SANDBOX_DIR"
echo "=============================================="

# Build binaries
build_binaries

# Provision client
provision_client "$CLIENT_EMAIL"

# Start Vite dev server
start_vite

# Launch Tauri instance
CLIENT_HOME="$SANDBOX_DIR/$CLIENT_EMAIL"
launch_tauri_instance "$CLIENT_HOME" "$CLIENT_EMAIL"
