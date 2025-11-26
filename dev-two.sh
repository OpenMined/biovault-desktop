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
SINGLE_MODE=0
SINGLE_CLIENT=""

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
    --single)
      SINGLE_MODE=1
      SINGLE_CLIENT="${2:-1}"
      if [[ "$2" =~ ^[12]$ ]]; then
        shift
      fi
      ;;
    -h|--help)
      echo "Usage: $0 [--reset] [--stop] [--server] [--clients] [--single [1|2]]"
      echo ""
      echo "Options:"
      echo "  --reset       Reset sandbox and docker before starting"
      echo "  --stop        Stop all services and exit"
      echo "  --server      Start only the syftbox server"
      echo "  --clients     Start only the sandbox clients (assumes server running)"
      echo "  --single [N]  Launch only one desktop instance (1 or 2, default: 1)"
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

  # Exchange crypto keys between clients
  exchange_keys

  # Verify sync is working before launching desktops
  verify_sync || log_warn "Continuing despite sync issues..."
}

# Build the bv CLI binary
ensure_bv_binary() {
  local target="$BIOVAULT_DIR/cli/target/release/bv"
  if [[ ! -x "$target" ]]; then
    log_info "Building BioVault CLI (cargo build --release)..."
    (cd "$BIOVAULT_DIR/cli" && cargo build --release >/dev/null 2>&1)
  fi
  echo "$target"
}

# Run a command in a client's environment
with_client_env() {
  local email="$1"
  shift
  (
    cd "$SANDBOX_DIR/$email"
    eval "$("$SBENV_BIN" activate --quiet 2>/dev/null || true)"
    "$@"
  )
}

# Wait for a file to exist
wait_for_file() {
  local file="$1"
  local timeout="${2:-60}"
  local count=0

  while [[ ! -f "$file" ]] && (( count < timeout )); do
    sleep 1
    ((count++))
  done

  [[ -f "$file" ]]
}

# Exchange crypto keys between clients
exchange_keys() {
  log_header "Exchanging Crypto Keys"

  local bv_binary
  bv_binary="$(ensure_bv_binary)"

  local client1_bundle="$SANDBOX_DIR/$CLIENT1_EMAIL/datasites/$CLIENT1_EMAIL/public/crypto/did.json"
  local client2_bundle="$SANDBOX_DIR/$CLIENT2_EMAIL/datasites/$CLIENT2_EMAIL/public/crypto/did.json"

  # Wait for bundles to be generated (happens during bv init in datasite.sh)
  log_info "Waiting for client1 public bundle..."
  if ! wait_for_file "$client1_bundle" 30; then
    log_error "Client1 bundle not found at: $client1_bundle"
    return 1
  fi
  log_success "Client1 bundle ready"

  log_info "Waiting for client2 public bundle..."
  if ! wait_for_file "$client2_bundle" 30; then
    log_error "Client2 bundle not found at: $client2_bundle"
    return 1
  fi
  log_success "Client2 bundle ready"

  # Wait for bundles to sync across clients via SyftBox
  local client1_sees_client2="$SANDBOX_DIR/$CLIENT1_EMAIL/datasites/$CLIENT2_EMAIL/public/crypto/did.json"
  local client2_sees_client1="$SANDBOX_DIR/$CLIENT2_EMAIL/datasites/$CLIENT1_EMAIL/public/crypto/did.json"

  log_info "Waiting for bundles to sync via SyftBox..."

  local sync_timeout=60
  local count=0
  while (( count < sync_timeout )); do
    if [[ -f "$client1_sees_client2" ]] && [[ -f "$client2_sees_client1" ]]; then
      break
    fi
    sleep 2
    ((count += 2))
    echo -ne "\r  Syncing... ${count}s"
  done
  echo ""

  if [[ ! -f "$client1_sees_client2" ]]; then
    log_warn "Client1 doesn't see Client2's bundle yet - will import directly"
    # Copy bundle manually for dev mode
    mkdir -p "$(dirname "$client1_sees_client2")"
    cp "$client2_bundle" "$client1_sees_client2"
  fi

  if [[ ! -f "$client2_sees_client1" ]]; then
    log_warn "Client2 doesn't see Client1's bundle yet - will import directly"
    # Copy bundle manually for dev mode
    mkdir -p "$(dirname "$client2_sees_client1")"
    cp "$client1_bundle" "$client2_sees_client1"
  fi

  log_success "Bundles synced"

  # Client1 imports Client2's bundle
  log_info "Client1 importing Client2's bundle..."
  with_client_env "$CLIENT1_EMAIL" "$bv_binary" syc import \
    "datasites/$CLIENT2_EMAIL/public/crypto/did.json" \
    --expected-identity "$CLIENT2_EMAIL" || {
    log_error "Failed to import Client2 bundle into Client1"
    return 1
  }
  log_success "Client1 imported Client2's bundle"

  # Client2 imports Client1's bundle
  log_info "Client2 importing Client1's bundle..."
  with_client_env "$CLIENT2_EMAIL" "$bv_binary" syc import \
    "datasites/$CLIENT1_EMAIL/public/crypto/did.json" \
    --expected-identity "$CLIENT1_EMAIL" || {
    log_error "Failed to import Client1 bundle into Client2"
    return 1
  }
  log_success "Client2 imported Client1's bundle"

  log_success "Key exchange complete - clients can now send encrypted messages"
}

# Verify sync is working between clients
verify_sync() {
  log_header "Verifying SyftBox Sync"

  local test_file="sync-test-$(date +%s).txt"
  local client1_public="$SANDBOX_DIR/$CLIENT1_EMAIL/datasites/$CLIENT1_EMAIL/public"
  local client2_sees_client1="$SANDBOX_DIR/$CLIENT2_EMAIL/datasites/$CLIENT1_EMAIL/public"

  # Write test file to client1's public folder
  log_info "Writing test file to client1's public folder..."
  echo "Sync test at $(date)" > "$client1_public/$test_file"

  # Wait for it to appear on client2's view
  log_info "Waiting for file to sync to client2..."
  local timeout=60
  local count=0
  while [[ ! -f "$client2_sees_client1/$test_file" ]] && (( count < timeout )); do
    sleep 2
    ((count += 2))
    echo -ne "\r  Waiting... ${count}s"
  done
  echo ""

  if [[ -f "$client2_sees_client1/$test_file" ]]; then
    log_success "Sync verified! File appeared on client2 in ${count}s"
    # Cleanup
    rm -f "$client1_public/$test_file"
    return 0
  else
    log_error "Sync FAILED - file did not appear on client2 after ${timeout}s"
    log_warn "Check that SyftBox daemons are running and connected"
    rm -f "$client1_public/$test_file"
    return 1
  fi
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

  # Clean biovault package once before launching
  cd "$SCRIPT_DIR/src-tauri"
  cargo clean -p biovault 2>/dev/null || true
  cd "$SCRIPT_DIR"

  # Single mode - just launch one instance
  if (( SINGLE_MODE )); then
    local client_email client_num
    if [[ "$SINGLE_CLIENT" == "2" ]]; then
      client_email="$CLIENT2_EMAIL"
      client_num=2
    else
      client_email="$CLIENT1_EMAIL"
      client_num=1
    fi

    log_info "Launching SINGLE desktop instance: $client_email (Ctrl+C to stop)"

    export BIOVAULT_HOME="$(get_biovault_home "$client_email")"
    export BIOVAULT_DEV_MODE=1
    export BIOVAULT_DEV_SYFTBOX=1
    export SYFTBOX_SERVER_URL="$SERVER_URL"
    export SYFTBOX_CONFIG_PATH="$SANDBOX_DIR/$client_email/.syftbox/config.json"

    echo ""
    echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  Desktop Instance $client_num: $client_email${NC}"
    echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}  BIOVAULT_HOME:     $BIOVAULT_HOME${NC}"
    echo -e "${YELLOW}  SYFTBOX_CONFIG:    $SYFTBOX_CONFIG_PATH${NC}"
    echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
    echo ""

    if command -v bun >/dev/null 2>&1; then
      bun run dev
    else
      npm run dev
    fi
    return
  fi

  # Two instance mode
  log_info "Launching TWO desktop windows (Ctrl+C to stop both)"

  # Launch instance 2 in background first
  (
    export BIOVAULT_HOME="$(get_biovault_home "$CLIENT2_EMAIL")"
    export BIOVAULT_DEV_MODE=1
    export BIOVAULT_DEV_SYFTBOX=1
    export SYFTBOX_SERVER_URL="$SERVER_URL"
    export SYFTBOX_CONFIG_PATH="$SANDBOX_DIR/$CLIENT2_EMAIL/.syftbox/config.json"

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
