#!/usr/bin/env bash
set -euo pipefail

# Launch THREE BioVault Desktop instances:
#   - 1 client with OLD UI (npm run dev)
#   - 2 clients with NEW UI (bv-desktop-new)
#
# Usage:
#   ./dev-three-old-new-ui.sh [--clients a,b,c] [--reset] [--path DIR] [--stop] [--use-defaults]
#
# Examples:
#   ./dev-three-old-new-ui.sh                              # Three default clients
#   ./dev-three-old-new-ui.sh --clients alice,bob,carol    # Three custom clients
#   ./dev-three-old-new-ui.sh --reset                      # Reset client directories first
#   ./dev-three-old-new-ui.sh --use-defaults               # Reset + use kj@kj.dev, test@kj.dev, biovault@kj.dev

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$ROOT_DIR}"
BIOVAULT_DIR="${BIOVAULT_DIR:-$WORKSPACE_ROOT/biovault}"
SYFTBOX_URL="${SYFTBOX_URL:-https://dev.syftbox.net}"
SYFTBOX_AUTH_ENABLED="${SYFTBOX_AUTH_ENABLED:-1}"
SANDBOX_DIR="${SANDBOX_DIR:-$ROOT_DIR/sandbox}"
LOG_DIR="$ROOT_DIR/logs"
CLIENTS=()
STOP_ONLY=0
RESET_FLAG=0
USE_DEFAULTS=0
VITE_PID=""
NPM_PID=""

# Default clients for --use-defaults
KJ_DEFAULTS=("kj@kj.dev" "test@kj.dev" "biovault@kj.dev")

mkdir -p "$LOG_DIR"

DEFAULT_CLIENT1="${CLIENT1_EMAIL:-client1@sandbox.local}"
DEFAULT_CLIENT2="${CLIENT2_EMAIL:-client2@sandbox.local}"
DEFAULT_CLIENT3="${CLIENT3_EMAIL:-client3@sandbox.local}"

# Build syftbox-rs (embedded backend)
build_syftbox_rust() {
  echo "[3-ui] Building syftbox-rs (embedded)..."
  (cd "$ROOT_DIR" && ./scripts/build-syftbox-rust.sh)
  local bin="$ROOT_DIR/src-tauri/resources/syftbox/syftbox"
  if [[ ! -x "$bin" ]]; then
    echo "[3-ui] ERROR: syftbox-rs binary missing at $bin" >&2
    exit 1
  fi
  echo "[3-ui] syftbox-rs ready"
}

# Provision a client directory
provision_client() {
  local email="$1"
  local client_dir="$SANDBOX_DIR/$email"
  
  if (( RESET_FLAG )) && [[ -d "$client_dir" ]]; then
    echo "[3-ui] Resetting client $email (--reset flag)"
    
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
      echo "[3-ui] Cleaning up profile entry for: $abs_client_dir"
      # Use jq if available, otherwise just warn
      if command -v jq >/dev/null 2>&1; then
        local tmp_file="${profiles_file}.tmp"
        jq --arg path "$abs_client_dir" '.profiles = [.profiles[] | select(.biovault_home != $path)]' "$profiles_file" > "$tmp_file" 2>/dev/null && mv "$tmp_file" "$profiles_file" || true
      else
        echo "[3-ui] Warning: jq not found, profiles store not cleaned. Run: rm ~/.bvprofiles/profiles.json"
      fi
    fi
  fi
  
  mkdir -p "$client_dir"
  echo "[3-ui] Client directory ready: $client_dir"
}

# Launch OLD UI instance (npm run dev)
launch_old_ui_instance() {
  local home="$1"
  local tag="$2"
  local email="$3"
  
  echo "[3-ui] Launching OLD UI ($tag) with BIOVAULT_HOME=$home email=$email"
  
  (
    cd "$ROOT_DIR"
    
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
    
    npm run dev 2>&1 | while read -r line; do
      echo "[$tag-OLD] $line"
    done
  )
}

# Launch NEW UI Tauri instance (Vite is shared on port 1420)
launch_new_ui_instance() {
  local home="$1"
  local tag="$2"
  local email="$3"
  
  echo "[3-ui] Launching NEW UI ($tag) with BIOVAULT_HOME=$home email=$email"
  
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
    
    bunx tauri dev --config tauri.conf.new-ui.json 2>&1 | while read -r line; do
      echo "[$tag-NEW] $line"
    done
  )
}

cleanup() {
  echo "[3-ui] Cleaning up..."
  
  # Kill Vite process (new UI)
  if [[ -n "$VITE_PID" ]] && ps -p "$VITE_PID" >/dev/null 2>&1; then
    kill "$VITE_PID" 2>/dev/null || true
  fi
  
  # Kill npm dev process (old UI)
  if [[ -n "$NPM_PID" ]] && ps -p "$NPM_PID" >/dev/null 2>&1; then
    kill "$NPM_PID" 2>/dev/null || true
  fi
  
  # Kill any remaining processes
  pkill -f "bun.*bv-desktop-new" 2>/dev/null || true
  pkill -f "vite.*1420" 2>/dev/null || true
  pkill -f "tauri dev.*new-ui" 2>/dev/null || true
  pkill -f "cargo-tauri" 2>/dev/null || true
  pkill -f "npm run dev" 2>/dev/null || true
  
  # Stop Jupyter processes for clients
  local targets=("${CLIENTS[@]:-}")
  if ((${#targets[@]} == 0)); then
    targets=("$DEFAULT_CLIENT1" "$DEFAULT_CLIENT2" "$DEFAULT_CLIENT3")
  fi
  for email in "${targets[@]}"; do
    local client_dir="$SANDBOX_DIR/$email"
    pkill -f "jupyter.*$client_dir" 2>/dev/null || true
  done
  
  echo "[3-ui] Done"
}

trap cleanup EXIT INT TERM

main() {
  # Parse args
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --client)
        CLIENTS+=("${2:?--client requires an email}")
        shift
        ;;
      --clients)
        IFS=',' read -r -a parsed_clients <<<"${2:?--clients requires a list}"
        CLIENTS+=("${parsed_clients[@]}")
        shift
        ;;
      --stop)
        STOP_ONLY=1
        ;;
      --reset)
        RESET_FLAG=1
        ;;
      --use-defaults)
        USE_DEFAULTS=1
        RESET_FLAG=1
        CLIENTS=("${KJ_DEFAULTS[@]}")
        ;;
      --path)
        SANDBOX_DIR="${2:?--path requires a directory}"
        shift
        ;;
      -h|--help)
        echo "Usage: $0 [--clients a,b,c] [--reset] [--path DIR] [--stop] [--use-defaults]"
        echo ""
        echo "Launches 3 clients: 1 OLD UI + 2 NEW UI"
        echo ""
        echo "Options:"
        echo "  --client EMAIL    Add a client by email (can be used multiple times)"
        echo "  --clients a,b,c   Add multiple clients (comma-separated, need 3)"
        echo "  --stop            Stop running instances and exit"
        echo "  --reset           Reset client directories before starting"
        echo "  --use-defaults    Reset + use kj@kj.dev, test@kj.dev, biovault@kj.dev"
        echo "  --path DIR        Use custom sandbox directory (default: ./sandbox)"
        echo ""
        echo "Examples:"
        echo "  $0                              # Three default clients"
        echo "  $0 --clients alice,bob,carol    # Three custom clients"
        echo "  $0 --reset                      # Reset all client directories first"
        echo "  $0 --use-defaults               # Quick start with kj's defaults"
        exit 0
        ;;
      *)
        echo "Unknown option: $1" >&2
        exit 1
        ;;
    esac
    shift
  done

  if (( STOP_ONLY )); then
    cleanup
    exit 0
  fi

  if (( RESET_FLAG )); then
    echo "[3-ui] Will reset individual client directories"
  fi

  # Default 3 clients if none specified
  if ((${#CLIENTS[@]} == 0)); then
    CLIENTS=("$DEFAULT_CLIENT1" "$DEFAULT_CLIENT2" "$DEFAULT_CLIENT3")
  fi

  # Ensure we have at least 3 clients
  if ((${#CLIENTS[@]} < 3)); then
    echo "[3-ui] WARNING: Less than 3 clients specified, adding defaults"
    while ((${#CLIENTS[@]} < 3)); do
      case ${#CLIENTS[@]} in
        0) CLIENTS+=("$DEFAULT_CLIENT1") ;;
        1) CLIENTS+=("$DEFAULT_CLIENT2") ;;
        2) CLIENTS+=("$DEFAULT_CLIENT3") ;;
      esac
    done
  fi

  # Build syftbox-rs
  build_syftbox_rust

  # Provision all clients
  for email in "${CLIENTS[@]}"; do
    provision_client "$email"
  done

  local client1="${CLIENTS[0]}"
  local client2="${CLIENTS[1]}"
  local client3="${CLIENTS[2]}"
  local dir1="$SANDBOX_DIR/$client1"
  local dir2="$SANDBOX_DIR/$client2"
  local dir3="$SANDBOX_DIR/$client3"

  echo ""
  echo "[3-ui] ======================================"
  echo "[3-ui] Client 1 (OLD UI): $client1"
  echo "[3-ui] Client 2 (NEW UI): $client2"
  echo "[3-ui] Client 3 (NEW UI): $client3"
  echo "[3-ui] ======================================"
  echo ""

  # Start shared Vite dev server for NEW UI (port 1420)
  echo "[3-ui] Starting Vite dev server for NEW UI on port 1420..."
  (cd "$ROOT_DIR/bv-desktop-new" && bun run dev) &
  VITE_PID=$!
  
  # Wait for Vite to be ready
  sleep 4

  # Launch OLD UI instance (client 1)
  echo "[3-ui] Launching client 1 with OLD UI..."
  launch_old_ui_instance "$dir1" "client1" "$client1" &
  local pid1=$!

  # Small delay
  sleep 3

  # Launch NEW UI instance (client 2)
  echo "[3-ui] Launching client 2 with NEW UI..."
  launch_new_ui_instance "$dir2" "client2" "$client2" &
  local pid2=$!

  # Small delay to avoid build conflicts
  sleep 3

  # Launch NEW UI instance (client 3)
  echo "[3-ui] Launching client 3 with NEW UI..."
  launch_new_ui_instance "$dir3" "client3" "$client3" &
  local pid3=$!

  echo ""
  echo "[3-ui] ======================================"
  echo "[3-ui] client1 (OLD UI) PID: $pid1"
  echo "[3-ui] client2 (NEW UI) PID: $pid2"
  echo "[3-ui] client3 (NEW UI) PID: $pid3"
  echo "[3-ui] ======================================"
  echo ""
  echo "[3-ui] Press Ctrl+C to stop all instances"
  
  wait
}

main "$@"
