#!/usr/bin/env bash
set -euo pipefail

# Launch one or two BioVault Desktop instances using the NEW UI (bv-desktop-new).
# Based on dev-two-live.sh but using the SvelteKit UI with tauri.conf.new-ui.json.
#
# Usage:
#   ./dev-two-new-ui.sh [--client EMAIL ... | --clients a,b] [--single [EMAIL]] [--stop] [--reset] [--path DIR]
#
# Examples:
#   ./dev-two-new-ui.sh                              # Two clients: client1@sandbox.local, client2@sandbox.local
#   ./dev-two-new-ui.sh --single                     # Single client: client1@sandbox.local
#   ./dev-two-new-ui.sh --clients alice,bob          # Two clients: alice, bob
#   ./dev-two-new-ui.sh --reset                      # Reset client directories before starting
#   ./dev-two-new-ui.sh --path ~/my-vaults           # Use custom sandbox directory

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$ROOT_DIR}"
BIOVAULT_DIR="${BIOVAULT_DIR:-$WORKSPACE_ROOT/biovault}"
SYFTBOX_URL="${SYFTBOX_URL:-https://dev.syftbox.net}"
SYFTBOX_AUTH_ENABLED="${SYFTBOX_AUTH_ENABLED:-1}"
SANDBOX_DIR="${SANDBOX_DIR:-$ROOT_DIR/sandbox}"
LOG_DIR="$ROOT_DIR/logs"
CLIENTS=()
SINGLE_MODE=0
SINGLE_TARGET=""
STOP_ONLY=0
RESET_FLAG=0
VITE_PID=""

mkdir -p "$LOG_DIR"

DEFAULT_CLIENT1="${CLIENT1_EMAIL:-client1@sandbox.local}"
DEFAULT_CLIENT2="${CLIENT2_EMAIL:-client2@sandbox.local}"

# Build syftbox-rs (embedded backend)
build_syftbox_rust() {
  echo "[new-ui] Building syftbox-rs (embedded)..."
  (cd "$ROOT_DIR" && ./scripts/build-syftbox-rust.sh)
  local bin="$ROOT_DIR/src-tauri/resources/syftbox/syftbox"
  if [[ ! -x "$bin" ]]; then
    echo "[new-ui] ERROR: syftbox-rs binary missing at $bin" >&2
    exit 1
  fi
  echo "[new-ui] syftbox-rs ready"
}

# Provision a client directory
provision_client() {
  local email="$1"
  local client_dir="$SANDBOX_DIR/$email"
  
  if (( RESET_FLAG )) && [[ -d "$client_dir" ]]; then
    echo "[new-ui] Resetting client $email (--reset flag)"
    # Stop any Jupyter processes for this client
    pkill -f "jupyter.*$client_dir" 2>/dev/null || true
    rm -rf "$client_dir"
  fi
  
  mkdir -p "$client_dir"
  echo "[new-ui] Client directory ready: $client_dir"
}

# Launch a Tauri instance (Vite is shared)
launch_tauri_instance() {
  local home="$1"
  local tag="$2"
  local email="$3"
  
  echo "[new-ui] Launching Tauri ($tag) with BIOVAULT_HOME=$home email=$email"
  
  (
    cd "$ROOT_DIR/src-tauri"
    
    # Export environment for this client
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
    
    bunx tauri dev --config tauri.conf.new-ui.json 2>&1 | while read -r line; do
      echo "[$tag] $line"
    done
  )
}

cleanup() {
  echo "[new-ui] Cleaning up..."
  
  # Kill Vite process
  if [[ -n "$VITE_PID" ]] && ps -p "$VITE_PID" >/dev/null 2>&1; then
    kill "$VITE_PID" 2>/dev/null || true
  fi
  
  # Kill any remaining bun/vite processes for bv-desktop-new
  pkill -f "bun.*bv-desktop-new" 2>/dev/null || true
  pkill -f "vite.*1420" 2>/dev/null || true
  
  # Kill Tauri dev processes
  pkill -f "tauri dev.*new-ui" 2>/dev/null || true
  pkill -f "cargo-tauri" 2>/dev/null || true
  
  # Stop Jupyter processes for clients
  local targets=("${CLIENTS[@]:-}")
  if ((${#targets[@]} == 0)); then
    targets=("$DEFAULT_CLIENT1" "$DEFAULT_CLIENT2")
  fi
  for email in "${targets[@]}"; do
    local client_dir="$SANDBOX_DIR/$email"
    pkill -f "jupyter.*$client_dir" 2>/dev/null || true
  done
  
  echo "[new-ui] Done"
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
      --single)
        SINGLE_MODE=1
        if [[ -n "${2:-}" && "$2" != --* ]]; then
          SINGLE_TARGET="$2"
          shift
        fi
        ;;
      --stop)
        STOP_ONLY=1
        ;;
      --reset)
        RESET_FLAG=1
        ;;
      --path)
        SANDBOX_DIR="${2:?--path requires a directory}"
        shift
        ;;
      -h|--help)
        echo "Usage: $0 [--client EMAIL ... | --clients a,b] [--single [EMAIL]] [--stop] [--reset] [--path DIR]"
        echo ""
        echo "Options:"
        echo "  --client EMAIL    Add a client by email (can be used multiple times)"
        echo "  --clients a,b     Add multiple clients (comma-separated)"
        echo "  --single [EMAIL]  Run only one client (defaults to first client)"
        echo "  --stop            Stop running instances and exit"
        echo "  --reset           Reset client directories before starting"
        echo "  --path DIR        Use custom sandbox directory (default: ./sandbox)"
        echo ""
        echo "Examples:"
        echo "  $0                              # Two default clients"
        echo "  $0 --single                     # Single default client"
        echo "  $0 --clients alice,bob --reset  # Two custom clients, reset first"
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
    echo "[new-ui] Will reset individual client directories"
  fi

  # Default clients if none specified
  if ((${#CLIENTS[@]} == 0)); then
    CLIENTS=("$DEFAULT_CLIENT1" "$DEFAULT_CLIENT2")
  fi

  # Single mode
  if (( SINGLE_MODE )); then
    if [[ -n "$SINGLE_TARGET" ]]; then
      CLIENTS=("$SINGLE_TARGET")
    else
      CLIENTS=("${CLIENTS[0]}")
    fi
  fi

  # Build syftbox-rs
  build_syftbox_rust

  # Provision all clients first
  declare -a PROVISIONED=()
  for email in "${CLIENTS[@]}"; do
    provision_client "$email"
    PROVISIONED+=("$email")
  done

  # Start shared Vite dev server
  echo "[new-ui] Starting shared Vite dev server on port 1420..."
  (cd "$ROOT_DIR/bv-desktop-new" && bun run dev) &
  VITE_PID=$!
  
  # Wait for Vite to be ready
  echo "[new-ui] Waiting for Vite to start..."
  sleep 4

  # Launch Tauri instances
  if ((${#PROVISIONED[@]} > 1)); then
    local a="${PROVISIONED[0]}"
    local b="${PROVISIONED[1]}"
    local a_dir="$SANDBOX_DIR/$a"
    local b_dir="$SANDBOX_DIR/$b"
    
    echo "[new-ui] Launching two clients..."
    launch_tauri_instance "$a_dir" "client1" "$a" &
    local pid1=$!
    
    # Small delay to avoid port conflicts during Tauri build
    sleep 2
    
    launch_tauri_instance "$b_dir" "client2" "$b" &
    local pid2=$!
    
    echo "[new-ui] client1 PID: $pid1"
    echo "[new-ui] client2 PID: $pid2"
  else
    local only="${PROVISIONED[0]}"
    local only_dir="$SANDBOX_DIR/$only"
    
    launch_tauri_instance "$only_dir" "client" "$only" &
    local pid1=$!
    
    echo "[new-ui] client PID: $pid1"
  fi

  echo "[new-ui] Press Ctrl+C to stop all instances"
  wait
}

main "$@"
