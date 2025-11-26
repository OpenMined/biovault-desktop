#!/bin/bash
set -e

# =============================================================================
# dev-two.sh - Launch two BioVault Desktop instances with sandbox syftbox
# =============================================================================
#
# This script sets up a complete dev environment with:
# 1. SyftBox server (docker) running on localhost:8080
# 2. Two sandbox clients with syftbox daemons running
# 3. Two BioVault Desktop instances in dev/hotreload mode
#
# Usage:
#   ./dev-two.sh              # Start everything
#   ./dev-two.sh --reset      # Reset sandbox and restart
#   ./dev-two.sh --stop       # Stop all services
#   ./dev-two.sh --server     # Start only the server
#   ./dev-two.sh --clients    # Start only the clients (assumes server running)
#
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIOVAULT_DIR="$SCRIPT_DIR/biovault"
SANDBOX_DIR="${SANDBOX_DIR:-$BIOVAULT_DIR/sandbox}"
SERVER_SCRIPT="$BIOVAULT_DIR/tests/scripts/server.sh"
DATASITE_SCRIPT="$BIOVAULT_DIR/tests/scripts/datasite.sh"
SBENV_BIN="$BIOVAULT_DIR/sbenv/sbenv"

# Client configuration
CLIENT1_EMAIL="${CLIENT1_EMAIL:-client1@sandbox.local}"
CLIENT2_EMAIL="${CLIENT2_EMAIL:-client2@sandbox.local}"
SERVER_URL="${SYFTBOX_SERVER_URL:-http://localhost:8080}"

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

# Parse arguments
RESET_FLAG=0
STOP_FLAG=0
SERVER_ONLY=0
CLIENTS_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset)
      RESET_FLAG=1
      ;;
    --stop)
      STOP_FLAG=1
      ;;
    --server)
      SERVER_ONLY=1
      ;;
    --clients)
      CLIENTS_ONLY=1
      ;;
    -h|--help)
      echo "Usage: $0 [--reset] [--stop] [--server] [--clients]"
      echo ""
      echo "Options:"
      echo "  --reset    Reset sandbox and docker before starting"
      echo "  --stop     Stop all services and exit"
      echo "  --server   Start only the syftbox server"
      echo "  --clients  Start only the sandbox clients (assumes server running)"
      echo ""
      echo "Environment:"
      echo "  SANDBOX_DIR           Override sandbox location (default: biovault/sandbox)"
      echo "  CLIENT1_EMAIL         Email for client 1 (default: client1@sandbox.local)"
      echo "  CLIENT2_EMAIL         Email for client 2 (default: client2@sandbox.local)"
      echo "  SYFTBOX_SERVER_URL    Server URL (default: http://localhost:8080)"
      exit 0
      ;;
    *)
      log_error "Unknown option: $1"
      exit 1
      ;;
  esac
  shift
done

# Check required files exist
check_requirements() {
  log_info "Checking requirements..."

  [[ -f "$SERVER_SCRIPT" ]] || { log_error "Missing server script: $SERVER_SCRIPT"; exit 1; }
  [[ -f "$DATASITE_SCRIPT" ]] || { log_error "Missing datasite script: $DATASITE_SCRIPT"; exit 1; }
  [[ -x "$SBENV_BIN" ]] || { log_error "Missing sbenv binary: $SBENV_BIN"; exit 1; }

  command -v docker >/dev/null 2>&1 || { log_error "docker is required"; exit 1; }
  command -v bun >/dev/null 2>&1 || command -v npm >/dev/null 2>&1 || { log_error "bun or npm is required"; exit 1; }

  log_success "All requirements met"
}

# Stop all services
stop_all() {
  log_header "Stopping all services"

  # Stop desktop processes
  log_info "Stopping any running Tauri dev processes..."
  pkill -f "tauri dev" 2>/dev/null || true
  pkill -f "cargo-tauri" 2>/dev/null || true

  # Stop sandbox clients
  if [[ -d "$SANDBOX_DIR" ]]; then
    log_info "Stopping sandbox clients..."
    while IFS= read -r client_dir; do
      [[ -z "$client_dir" ]] && continue
      local pid_file="$client_dir/.syftbox/syftbox.pid"
      if [[ -f "$pid_file" ]]; then
        local pid
        pid="$(tr -d ' \n\r' < "$pid_file")"
        if [[ -n "$pid" ]] && ps -p "$pid" >/dev/null 2>&1; then
          log_info "  Stopping client at $client_dir (pid: $pid)"
          kill "$pid" 2>/dev/null || true
        fi
      fi
    done < <(find "$SANDBOX_DIR" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null)
  fi

  # Stop docker containers
  log_info "Stopping docker containers..."
  "$SERVER_SCRIPT" --reset 2>/dev/null || true

  log_success "All services stopped"
}

# Start the syftbox server
start_server() {
  log_header "Starting SyftBox Server"

  if (( RESET_FLAG )); then
    log_info "Resetting docker containers..."
    "$SERVER_SCRIPT" --reset
  fi

  log_info "Starting server at $SERVER_URL..."
  "$SERVER_SCRIPT"

  log_success "Server is ready at $SERVER_URL"
}

# Build syftbox binary (needed before datasite.sh to avoid stdout capture issue)
# Only outputs the binary path to stdout - all other output goes to stderr
build_syftbox_binary() {
  local syftbox_dir="$BIOVAULT_DIR/syftbox"
  local goos goarch target

  goos="$(go env GOOS)"
  goarch="$(go env GOARCH)"
  target="$syftbox_dir/.out/syftbox_client_${goos}_${goarch}"

  if [[ -x "$target" ]]; then
    echo "$target"
    return
  fi

  echo -e "${BLUE}ℹ️  Building SyftBox client binary for ${goos}/${goarch}...${NC}" >&2
  mkdir -p "$syftbox_dir/.out"

  local version commit build_date ldflags cgo
  version="$(cd "$syftbox_dir" && git describe --tags --always 2>/dev/null || echo "dev")"
  commit="$(cd "$syftbox_dir" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")"
  build_date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ldflags="-s -w"
  ldflags+=" -X github.com/openmined/syftbox/internal/version.Version=$version"
  ldflags+=" -X github.com/openmined/syftbox/internal/version.Revision=$commit"
  ldflags+=" -X github.com/openmined/syftbox/internal/version.BuildDate=$build_date"

  cgo=0
  [[ "$goos" == "darwin" ]] && cgo=1

  (cd "$syftbox_dir" && GOOS="$goos" GOARCH="$goarch" CGO_ENABLED="$cgo" \
    go build -trimpath --tags "go_json nomsgpack" -ldflags "$ldflags" \
    -o "$target" ./cmd/client) >&2

  echo -e "${GREEN}✓ Built syftbox binary: $target${NC}" >&2
  echo "$target"
}

# Start sandbox clients
start_clients() {
  log_header "Setting Up Sandbox Clients"

  # Check server is reachable
  log_info "Verifying server at $SERVER_URL..."
  if ! curl -fsS --max-time 5 "$SERVER_URL" >/dev/null 2>&1; then
    log_error "Server is not reachable at $SERVER_URL"
    log_info "Start the server first with: $0 --server"
    exit 1
  fi
  log_success "Server is reachable"

  # Pre-build syftbox binary to avoid stdout capture issues in datasite.sh
  log_info "Ensuring syftbox binary is built..."
  SYFTBOX_BINARY_PATH="$(build_syftbox_binary)"
  export SYFTBOX_BINARY_PATH
  log_success "Syftbox binary: $SYFTBOX_BINARY_PATH"

  if (( RESET_FLAG )); then
    log_info "Resetting sandbox..."
    "$DATASITE_SCRIPT" --reset
  fi

  log_info "Creating sandbox clients: $CLIENT1_EMAIL, $CLIENT2_EMAIL"
  "$DATASITE_SCRIPT" --names "$CLIENT1_EMAIL,$CLIENT2_EMAIL"

  log_success "Sandbox clients are ready"
  echo ""
  echo -e "${YELLOW}Sandbox locations:${NC}"
  echo -e "  Client 1: $SANDBOX_DIR/$CLIENT1_EMAIL"
  echo -e "  Client 2: $SANDBOX_DIR/$CLIENT2_EMAIL"
}

# Get the biovault home for a client
get_biovault_home() {
  local email="$1"
  echo "$SANDBOX_DIR/$email"
}

# Prepare desktop config for a client
prepare_desktop_config() {
  local email="$1"
  local client_dir="$SANDBOX_DIR/$email"
  local biovault_home="$client_dir"
  local config_file="$biovault_home/config.yaml"

  log_info "Preparing desktop config for $email..."

  # Check if config exists (created by bv init in datasite.sh)
  if [[ ! -f "$config_file" ]]; then
    log_warn "Config not found at $config_file, creating..."
    mkdir -p "$biovault_home"
    cat > "$config_file" <<EOF
email: "$email"
syftbox_config_path: "$client_dir/.syftbox/config.json"
EOF
  else
    # Update syftbox_config_path if not set
    if ! grep -q "syftbox_config_path" "$config_file" 2>/dev/null; then
      echo "syftbox_config_path: \"$client_dir/.syftbox/config.json\"" >> "$config_file"
    fi
  fi

  log_success "Config ready at $config_file"
}

# Launch a desktop instance
launch_desktop() {
  local email="$1"
  local instance_num="$2"
  local client_dir="$SANDBOX_DIR/$email"
  local biovault_home="$client_dir"
  local log_file="$client_dir/desktop.log"

  log_info "Launching desktop instance $instance_num for $email..."

  # Prepare config
  prepare_desktop_config "$email"

  # Set environment variables for dev mode
  export BIOVAULT_HOME="$biovault_home"
  export BIOVAULT_DEV_MODE=1
  export BIOVAULT_DEV_SYFTBOX=1
  export SYFTBOX_SERVER_URL="$SERVER_URL"
  export SYFTBOX_CONFIG_PATH="$client_dir/.syftbox/config.json"

  # Build biovault package fresh
  log_info "  Building biovault package..."
  cd "$SCRIPT_DIR/src-tauri"
  cargo clean -p biovault 2>/dev/null || true
  cd "$SCRIPT_DIR"

  # Determine package manager
  local pkg_cmd="npm"
  if command -v bun >/dev/null 2>&1; then
    pkg_cmd="bun"
  fi

  log_info "  Starting Tauri dev with $pkg_cmd..."
  echo ""
  echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  Desktop Instance $instance_num: $email${NC}"
  echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}  BIOVAULT_HOME:     $biovault_home${NC}"
  echo -e "${YELLOW}  SYFTBOX_CONFIG:    $client_dir/.syftbox/config.json${NC}"
  echo -e "${YELLOW}  DEV_MODE:          enabled${NC}"
  echo -e "${YELLOW}  Server:            $SERVER_URL${NC}"
  echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
  echo ""

  # Launch in foreground for the first instance, background for second
  if [[ "$instance_num" == "1" ]]; then
    $pkg_cmd run dev
  else
    $pkg_cmd run dev &
    echo $! > "$client_dir/desktop.pid"
  fi
}

# Main execution
main() {
  check_requirements

  # Handle stop flag
  if (( STOP_FLAG )); then
    stop_all
    exit 0
  fi

  # Server only mode
  if (( SERVER_ONLY )); then
    start_server
    exit 0
  fi

  # Clients only mode
  if (( CLIENTS_ONLY )); then
    start_clients
    exit 0
  fi

  # Full setup
  log_header "BioVault Two-Instance Dev Environment"

  echo -e "${YELLOW}This will:${NC}"
  echo "  1. Start the SyftBox server (docker)"
  echo "  2. Create two sandbox clients with syftbox daemons"
  echo "  3. Launch two BioVault Desktop instances"
  echo ""

  # Reset if requested
  if (( RESET_FLAG )); then
    stop_all
  fi

  # Start server
  start_server

  # Start clients
  start_clients

  # Launch desktops
  log_header "Launching Desktop Instances"

  log_info "Launching TWO desktop windows (Ctrl+C to stop both)"

  # Launch instance 2 in background first
  (
    export BIOVAULT_HOME="$(get_biovault_home "$CLIENT2_EMAIL")"
    export BIOVAULT_DEV_MODE=1
    export BIOVAULT_DEV_SYFTBOX=1
    export SYFTBOX_SERVER_URL="$SERVER_URL"
    export SYFTBOX_CONFIG_PATH="$SANDBOX_DIR/$CLIENT2_EMAIL/.syftbox/config.json"

    cd "$SCRIPT_DIR/src-tauri"
    cargo clean -p biovault 2>/dev/null || true
    cd "$SCRIPT_DIR"

    echo ""
    echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  Desktop Instance 2: $CLIENT2_EMAIL${NC}"
    echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}  BIOVAULT_HOME:     $BIOVAULT_HOME${NC}"
    echo -e "${YELLOW}  SYFTBOX_CONFIG:    $SYFTBOX_CONFIG_PATH${NC}"
    echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"

    if command -v bun >/dev/null 2>&1; then
      bun run dev 2>&1 | sed 's/^/[client2] /'
    else
      npm run dev 2>&1 | sed 's/^/[client2] /'
    fi
  ) &
  CLIENT2_PID=$!

  # Store PID for cleanup
  echo "$CLIENT2_PID" > "$SANDBOX_DIR/$CLIENT2_EMAIL/desktop.pid"

  # Wait a bit for first build to complete so we don't have conflicts
  log_info "Waiting for instance 2 to start building..."
  sleep 5

  # Launch instance 1 in foreground
  export BIOVAULT_HOME="$(get_biovault_home "$CLIENT1_EMAIL")"
  export BIOVAULT_DEV_MODE=1
  export BIOVAULT_DEV_SYFTBOX=1
  export SYFTBOX_SERVER_URL="$SERVER_URL"
  export SYFTBOX_CONFIG_PATH="$SANDBOX_DIR/$CLIENT1_EMAIL/.syftbox/config.json"

  cd "$SCRIPT_DIR/src-tauri"
  cargo clean -p biovault 2>/dev/null || true
  cd "$SCRIPT_DIR"

  echo ""
  echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  Desktop Instance 1: $CLIENT1_EMAIL${NC}"
  echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}  BIOVAULT_HOME:     $BIOVAULT_HOME${NC}"
  echo -e "${YELLOW}  SYFTBOX_CONFIG:    $SYFTBOX_CONFIG_PATH${NC}"
  echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"

  # Trap to cleanup on exit
  trap 'log_info "Stopping client 2..."; kill $CLIENT2_PID 2>/dev/null || true' EXIT

  if command -v bun >/dev/null 2>&1; then
    bun run dev 2>&1 | sed 's/^/[client1] /'
  else
    npm run dev 2>&1 | sed 's/^/[client1] /'
  fi
}

main
