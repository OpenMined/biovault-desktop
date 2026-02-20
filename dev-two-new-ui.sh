#!/bin/bash
set -euo pipefail

# =============================================================================
# dev-two-new-ui.sh - Launch TWO clients with NEW UI against SyftBox devstack
# =============================================================================
#
# This is a variant of dev-two.sh that launches the new Svelte-based UI
# (src) instead of the legacy one.
#
# Usage:
#   ./dev-two-new-ui.sh --reset               # fresh stack + two desktops
#   ./dev-two-new-ui.sh --stop                # stop everything
#
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$SCRIPT_DIR}"
BIOVAULT_DIR="${BIOVAULT_DIR:-$WORKSPACE_ROOT/biovault}"
SYFTBOX_DIR="${SYFTBOX_DIR:-$WORKSPACE_ROOT/syftbox}"
DEVSTACK_SCRIPT="$BIOVAULT_DIR/tests/scripts/devstack.sh"
SANDBOX_ROOT="${SANDBOX_DIR:-$BIOVAULT_DIR/sandbox}"
WS_PORT_BASE="${DEV_WS_BRIDGE_PORT_BASE:-3333}"

# Default clients
DEFAULT_CLIENT1="client1@sandbox.local"
DEFAULT_CLIENT2="client2@sandbox.local"

# State
VITE_PID=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✓ $1${NC}"; }
log_warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}✗ $1${NC}"; }
log_header() { echo -e "\n${CYAN}═══════════════════════════════════════════════════════════${NC}"; echo -e "${CYAN}  $1${NC}"; echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}\n"; }

# 1. Reuse devstack logic by sourcing it or calling as sub-shell
# For simplicity, we'll implement the core launch logic here to handle Vite.

if [[ ! -f "$DEVSTACK_SCRIPT" ]]; then
  log_error "Missing devstack script at $DEVSTACK_SCRIPT"
  exit 1
fi

# Flags
RESET_FLAG=0
STOP_FLAG=0
CLIENTS=()  # Start empty to allow --client overrides

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset) RESET_FLAG=1 ;;
    --stop) STOP_FLAG=1 ;;
    --client) CLIENTS+=("$2"); shift ;;
    *) log_error "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

if [[ ${#CLIENTS[@]} -eq 0 ]]; then
  CLIENTS=("$DEFAULT_CLIENT1" "$DEFAULT_CLIENT2")
fi

stop_all() {
  log_header "Stopping everything"
  pkill -f "tauri dev.*new-ui" 2>/dev/null || true
  pkill -f "vite.*1420" 2>/dev/null || true
  
  # Stop devstack
  bash "$DEVSTACK_SCRIPT" --sandbox "$SANDBOX_ROOT" --stop || true
  if (( RESET_FLAG )); then
    bash "$DEVSTACK_SCRIPT" --sandbox "$SANDBOX_ROOT" --stop --reset || true
  fi
  log_success "Stopped"
}

if (( STOP_FLAG )); then
  stop_all
  exit 0
fi

# Build BioVault CLI and embedded syftbox
log_info "Building BioVault CLI (release)..."
(cd "$BIOVAULT_DIR/cli" && cargo build --release)
BV_CLI_BIN="$BIOVAULT_DIR/cli/target/release/bv"

log_info "Building syftbox-rs (embedded)..."
./scripts/build-syftbox-rust.sh

# Start Stack
log_header "Starting SyftBox devstack"
client_csv="$(IFS=,; echo "${CLIENTS[*]}")"
devstack_args=(--sandbox "$SANDBOX_ROOT" --clients "$client_csv")
(( RESET_FLAG )) && devstack_args+=(--reset)

# Ensure embedded mode for desktop instances
export BV_DEVSTACK_CLIENT_MODE=embedded
export BV_SYFTBOX_BACKEND=embedded
export SYFTBOX_AUTH_ENABLED=0  # Disable OAuth for devstack
export BIOVAULT_DEBUG_BANNER=1
export BIOVAULT_DISABLE_PROFILES=1

bash "$DEVSTACK_SCRIPT" "${devstack_args[@]}"

# Load state to get ports/paths
STATE_FILE="$SANDBOX_ROOT/state.json"
[[ ! -f "$STATE_FILE" ]] && STATE_FILE="$SANDBOX_ROOT/relay/state.json"

if [[ ! -f "$STATE_FILE" ]]; then
  log_error "Failed to find devstack state file"
  exit 1
fi

SERVER_PORT="$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['server']['port'])")"
SERVER_URL="http://127.0.0.1:$SERVER_PORT"

# Start Vite
log_header "Starting Vite dev server (New UI)"
(
  cd "$SCRIPT_DIR/src"
  npm run dev -- --port 1420 2>&1 | sed "s/^/[VITE] /"
) &
VITE_PID=$!

log_info "Waiting for Vite on :1420..."
for i in {1..30}; do
  if curl -s http://localhost:1420 >/dev/null 2>&1; then
    log_success "Vite ready"
    break
  fi
  sleep 1
done

provision_identities() {
  log_header "Provisioning BioVault identities"
  for email in "${CLIENTS[@]}"; do
    local home config
    home="$(python3 -c "import json; state=json.load(open('$STATE_FILE')); print([c['home_path'] for c in state['clients'] if c['email']=='$email'][0])")"
    config="$(python3 -c "import json; state=json.load(open('$STATE_FILE')); print([c['config'] for c in state['clients'] if c['email']=='$email'][0])")"
    local data_dir="$home"

    if [[ ! -f "$home/config.yaml" ]] || (( RESET_FLAG )); then
      log_info "Initializing BioVault for $email in $home"
      rm -f "$home/config.yaml" 2>/dev/null || true
      BIOVAULT_HOME="$home" \
        SYFTBOX_CONFIG_PATH="$config" \
        SYFTBOX_DATA_DIR="$data_dir" \
        SYFTBOX_EMAIL="$email" \
        "$BV_CLI_BIN" init "$email" --quiet
    else
      log_info "BioVault already initialized for $email"
    fi
  done
}

provision_identities

launch_instance() {
  local email="$1"
  local idx="$2"
  local mode="$3"
  local ws_port=$((WS_PORT_BASE + idx - 1))
  
  # Get client info from state
  local home config
  home="$(python3 -c "import json; state=json.load(open('$STATE_FILE')); print([c['home_path'] for c in state['clients'] if c['email']=='$email'][0])")"
  config="$(python3 -c "import json; state=json.load(open('$STATE_FILE')); print([c['config'] for c in state['clients'] if c['email']=='$email'][0])")"

  log_info "Launching $email (Client $idx) on WS port $ws_port"
  
  (
    export BIOVAULT_HOME="$home"
    export BIOVAULT_DEV_MODE=1
    export BIOVAULT_DEV_SYFTBOX=1
    export BIOVAULT_DISABLE_PROFILES=1
    export BV_SYFTBOX_BACKEND=embedded
    export SYFTBOX_SERVER_URL="$SERVER_URL"
    export SYFTBOX_EMAIL="$email"
    export SYFTBOX_CONFIG_PATH="$config"
    export SYFTBOX_DATA_DIR="$home"
    export SYC_VAULT="$home/.syc"
    export DEV_WS_BRIDGE=1
    export DEV_WS_BRIDGE_PORT="$ws_port"
    export DISABLE_UPDATER=1
    
    cd "$SCRIPT_DIR/src-tauri"
    # bunx is used in dev-new-ui.sh, so we'll use it here too if available, otherwise npm
    if command -v bun >/dev/null 2>&1; then
      bunx tauri dev --config '{"build": {"devUrl": "http://localhost:1420", "frontendDist": "../src/build"}}' 2>&1 | sed "s/^/[client$idx] /"
    else
      npm run tauri -- dev --config '{"build": {"devUrl": "http://localhost:1420", "frontendDist": "../src/build"}}' 2>&1 | sed "s/^/[client$idx] /"
    fi
  ) &
  
  if [[ "$mode" == "fg" ]]; then
    wait $!
  fi
}

# Cleanup on exit
trap "kill $VITE_PID 2>/dev/null || true; pkill -f 'tauri dev.*new-ui' 2>/dev/null || true; exit" INT TERM EXIT

# Launch clients
launch_instance "${CLIENTS[1]}" 2 "bg"
sleep 5
launch_instance "${CLIENTS[0]}" 1 "fg"
