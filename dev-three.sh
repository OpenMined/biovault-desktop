#!/bin/bash
set -euo pipefail

# =============================================================================
# dev-three.sh - Launch THREE BioVault Desktop instances for multiparty testing
# =============================================================================
#
# This script sets up 3 clients for testing multiparty flows:
#   - client1@sandbox.local (contributor1)
#   - client2@sandbox.local (contributor2)
#   - aggregator@sandbox.local (aggregator)
#
# Quick start:
#   ./dev-three.sh --reset              # fresh stack + three desktops
#   ./dev-three.sh --reset --single     # fresh stack + single desktop (first client)
#   ./dev-three.sh --stop               # stop devstack and desktop pids
#
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$SCRIPT_DIR}"
BIOVAULT_DIR="${BIOVAULT_DIR:-$WORKSPACE_ROOT/biovault}"
SYFTBOX_DIR="${SYFTBOX_DIR:-$WORKSPACE_ROOT/syftbox}"
if [[ ! -d "$SYFTBOX_DIR" && -d "$BIOVAULT_DIR/syftbox" ]]; then
  SYFTBOX_DIR="$BIOVAULT_DIR/syftbox"
fi
WORKSPACE_ROOT="$WORKSPACE_ROOT" "$SCRIPT_DIR/scripts/ensure-workspace-deps.sh" \
  "biovault/cli/Cargo.toml" \
  "syftbox-sdk/Cargo.toml" \
  "syftbox/rust/Cargo.toml"
if [[ ! -f "$BIOVAULT_DIR/tests/scripts/devstack.sh" ]]; then
  echo "Missing devstack script at $BIOVAULT_DIR/tests/scripts/devstack.sh" >&2
  echo "Fix: run ./repo --init && ./repo sync from $WORKSPACE_ROOT" >&2
  exit 1
fi
if [[ ! -d "$SYFTBOX_DIR" ]]; then
  echo "Missing syftbox repo at $SYFTBOX_DIR" >&2
  echo "Fix: run ./repo --init && ./repo sync from $WORKSPACE_ROOT" >&2
  exit 1
fi
DEVSTACK_SCRIPT="$BIOVAULT_DIR/tests/scripts/devstack.sh"
SANDBOX_ROOT="${SANDBOX_DIR:-$BIOVAULT_DIR/sandbox}"
WS_PORT_BASE="${DEV_WS_BRIDGE_PORT_BASE:-3333}"

# Three clients for multiparty
DEFAULT_CLIENT1="${CLIENT1_EMAIL:-client1@sandbox.local}"
DEFAULT_CLIENT2="${CLIENT2_EMAIL:-client2@sandbox.local}"
DEFAULT_AGGREGATOR="${AGG_EMAIL:-aggregator@sandbox.local}"

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

usage() {
  cat <<EOF
Usage: $0 [options]

Multiparty Flow Development Environment (3 clients)

Options:
  --reset             Reset sandbox and devstack before starting
  --bootstrap         Auto-onboard + trust keys + create multiparty invitation
  --bootstrap-project FILE
                      Flow YAML file to import/share during bootstrap
  --bootstrap-project-name NAME
                      Override flow name used in invitation metadata
  --auto-run          Auto-accept invitation and run all flow steps
  --stop-before STEP  Stop auto-run before this step id (e.g. secure_aggregate)
  --skip-sync-check   Skip the sbdev sync probe
  --stop              Stop devstack and desktop processes
  --single [EMAIL]    Launch only one desktop (default: first client)
  --path DIR          Sandbox root (default: biovault/sandbox)
  -h, --help          Show this help

Clients:
  - client1@sandbox.local   (contributor1)
  - client2@sandbox.local   (contributor2)
  - aggregator@sandbox.local (aggregator)
EOF
}

# Parsed flags
RESET_FLAG=0
STOP_FLAG=0
SINGLE_MODE=0
SINGLE_TARGET=""
SKIP_SYNC_CHECK=0
BOOTSTRAP_FLAG=0
BOOTSTRAP_PROJECT_FILE=""
BOOTSTRAP_PROJECT_NAME=""
AUTO_RUN_FLAG=0
STOP_BEFORE_STEP=""

CLIENTS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset) RESET_FLAG=1 ;;
    --stop) STOP_FLAG=1 ;;
    --single)
      SINGLE_MODE=1
      if [[ -n "${2:-}" && "$2" != "--"* ]]; then
        SINGLE_TARGET="$2"
        shift
      fi
      ;;
    --path)
      if [[ -z "${2:-}" ]]; then
        log_error "--path requires a directory"
        exit 1
      fi
      SANDBOX_ROOT="$2"
      shift
      ;;
    --skip-sync-check)
      SKIP_SYNC_CHECK=1
      ;;
    --bootstrap)
      BOOTSTRAP_FLAG=1
      ;;
    --bootstrap-project)
      if [[ -z "${2:-}" ]]; then
        log_error "--bootstrap-project requires a flow YAML path"
        exit 1
      fi
      BOOTSTRAP_PROJECT_FILE="$2"
      shift
      ;;
    --bootstrap-project-name)
      if [[ -z "${2:-}" ]]; then
        log_error "--bootstrap-project-name requires a value"
        exit 1
      fi
      BOOTSTRAP_PROJECT_NAME="$2"
      shift
      ;;
    --auto-run)
      AUTO_RUN_FLAG=1
      ;;
    --stop-before)
      if [[ -z "${2:-}" ]]; then
        log_error "--stop-before requires a step id"
        exit 1
      fi
      STOP_BEFORE_STEP="$2"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      log_error "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
  shift
done

# Always use 3 clients for multiparty
CLIENTS=("$DEFAULT_CLIENT1" "$DEFAULT_CLIENT2" "$DEFAULT_AGGREGATOR")

# State holders
STACK_STATE_FILE=""
SERVER_PORT=""
SERVER_URL=""
CLIENT_LINES=()
BV_CLI_BIN=""

check_requirements() {
  log_info "Checking requirements..."

  command -v python3 >/dev/null 2>&1 || { log_error "python3 is required"; exit 1; }
  command -v go >/dev/null 2>&1 || { log_error "Go is required to run the sbdev devstack"; exit 1; }
  [[ -f "$DEVSTACK_SCRIPT" ]] || { log_error "Devstack helper not found at $DEVSTACK_SCRIPT"; exit 1; }
  if ! command -v npm >/dev/null 2>&1; then
    log_error "npm is required to run the desktop"
    exit 1
  fi

  log_success "Requirements look good"
}

ensure_bv_cli() {
  local target="$BIOVAULT_DIR/cli/target/release/bv"
  if [[ ! -x "$target" ]]; then
    log_info "Building BioVault CLI (cargo build --release)..."
    (cd "$BIOVAULT_DIR/cli" && cargo build --release >/dev/null 2>&1)
  fi
  BV_CLI_BIN="$target"
}

sbdev_tool() {
  (cd "$SYFTBOX_DIR" && GOCACHE="$SYFTBOX_DIR/.gocache" go run ./cmd/devstack "$@")
}

find_state_file() {
  local candidates=(
    "$SANDBOX_ROOT/relay/state.json"
    "$SANDBOX_ROOT/state.json"
  )
  for path in "${candidates[@]}"; do
    if [[ -f "$path" ]]; then
      echo "$path"
      return 0
    fi
  done
  return 1
}

load_state() {
  STACK_STATE_FILE="$(find_state_file || true)"
  if [[ -z "$STACK_STATE_FILE" ]]; then
    log_error "Devstack state not found in $SANDBOX_ROOT (run with --reset to create)"
    exit 1
  fi

  SERVER_PORT="$(python3 - "$STACK_STATE_FILE" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
print(data["server"]["port"])
PY
)"
  SERVER_URL="http://127.0.0.1:${SERVER_PORT}"

  CLIENT_LINES=()
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    CLIENT_LINES+=("$line")
  done < <(python3 - "$STACK_STATE_FILE" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
for c in data.get("clients", []):
    print("|".join([
        c.get("email", ""),
        c.get("home_path", ""),
        c.get("config", ""),
        c.get("server_url", ""),
        str(c.get("port", "")),
    ]))
PY
)

  if [[ ${#CLIENT_LINES[@]} -eq 0 ]]; then
    log_error "No clients found in devstack state"
    exit 1
  fi
}

client_field() {
  local email="$1"
  local field="$2"
  local line home cfg srv port
  for line in "${CLIENT_LINES[@]}"; do
    IFS='|' read -r em home cfg srv port <<<"$line"
    if [[ "$em" == "$email" ]]; then
      case "$field" in
        home) echo "$home" ;;
        config) echo "$cfg" ;;
        server) echo "$srv" ;;
        port) echo "$port" ;;
        *) return 1 ;;
      esac
      return 0
    fi
  done
  return 1
}

stop_desktops() {
  log_header "Stopping desktop processes"

  pkill -f "jupyter.*$SANDBOX_ROOT" 2>/dev/null || true

  shopt -s nullglob
  for pid_file in "$SANDBOX_ROOT"/*/desktop.pid; do
    local pid
    pid="$(tr -d ' \n\r' < "$pid_file")"
    if [[ -n "$pid" ]] && ps -p "$pid" >/dev/null 2>&1; then
      log_info "Stopping desktop pid $pid ($pid_file)"
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  done
  shopt -u nullglob

  pkill -f "tauri dev" 2>/dev/null || true
  pkill -f "cargo-tauri" 2>/dev/null || true
}

stop_stack() {
  stop_desktops
  log_info "Stopping SyftBox devstack..."
  local args=(--sandbox "$SANDBOX_ROOT" --stop)
  (( RESET_FLAG )) && args+=(--reset)
  if ! bash "$DEVSTACK_SCRIPT" "${args[@]}"; then
    log_warn "devstack stop reported an issue (continuing)"
  fi
  log_info "Pruning global sbdev state..."
  sbdev_tool prune >/dev/null 2>&1 || log_warn "Global prune failed (continuing)"
  log_success "Stopped"
}

start_stack() {
  local existing_state
  existing_state="$(find_state_file || true)"

  if [[ -n "$existing_state" && $RESET_FLAG -eq 0 ]]; then
    if ((${#CLIENTS[@]})); then
      local missing
      missing="$(
        python3 - "$existing_state" "${CLIENTS[@]}" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
want = sys.argv[2:]
have = {c.get("email") for c in state.get("clients", [])}
missing = [c for c in want if c not in have]
print(",".join(missing))
PY
      )"
      if [[ -n "$missing" ]]; then
        log_warn "Existing devstack missing requested clients: $missing. Rebuilding with --reset."
        RESET_FLAG=1
      else
        log_info "Existing devstack state found at $existing_state (use --reset to rebuild)"
        return
      fi
    else
      log_info "Existing devstack state found at $existing_state (use --reset to rebuild)"
      return
    fi
  fi

  log_header "Starting SyftBox devstack (3 clients)"

  log_info "Pruning any dead sbdev stacks (global)"
  sbdev_tool prune >/dev/null 2>&1 || log_warn "Global prune failed (continuing)"

  local client_csv
  client_csv="$(IFS=,; echo "${CLIENTS[*]}")"

  local args=(--sandbox "$SANDBOX_ROOT" --clients "$client_csv")
  (( RESET_FLAG )) && args+=(--reset)
  (( SKIP_SYNC_CHECK )) && args+=(--skip-sync-check)
  if [[ "${BV_DEVSTACK_SKIP_KEYS:-0}" == "1" ]]; then
    args+=(--skip-keys)
  fi

  local -a env_prefix=(BIOVAULT_DISABLE_PROFILES=1)
  if [[ -z "${BV_DEVSTACK_CLIENT_MODE:-}" ]]; then
    # Multiparty/syqure flows need rust SyftBox daemons for hotlink/TCP proxy
    # transport. dev-three.sh always enables hotlink, so default to rust.
    # (matches CI matrix: client_mode=rust and test-scenario.sh line 354-355)
    env_prefix+=(BV_DEVSTACK_CLIENT_MODE=rust)
  fi
  env "${env_prefix[@]}" bash "$DEVSTACK_SCRIPT" "${args[@]}"

  log_info "Active sbdev stacks:"
  sbdev_tool list || log_warn "Could not list sbdev stacks"
}

prepare_desktop_config() {
  local email="$1"
  local home config
  home="$(client_field "$email" home)" || { log_error "No client home for $email"; exit 1; }
  config="$(client_field "$email" config)" || { log_error "No config path for $email"; exit 1; }

  mkdir -p "$home"
  log_info "Home directory ready for $email at $home"
}

parse_data_dir() {
  local config_path="$1"
  python3 - "$config_path" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
print(cfg.get("data_dir",""))
PY
}

launch_desktop_instance() {
  local email="$1"
  local instance_num="$2"
  local background="$3"
  local ws_port=$((WS_PORT_BASE + instance_num - 1))

  local home config server data_dir
  home="$(client_field "$email" home)" || { log_error "No client home for $email"; exit 1; }
  config="$(client_field "$email" config)" || { log_error "No config path for $email"; exit 1; }
  server="$(client_field "$email" server)"
  [[ -z "$server" ]] && server="$SERVER_URL"
  data_dir="$(parse_data_dir "$config")"
  [[ -z "$data_dir" ]] && data_dir="$home"

  prepare_desktop_config "$email"

  export BIOVAULT_HOME="$home"
  export BIOVAULT_DEV_MODE=1
  export BIOVAULT_DEV_SYFTBOX=1
  export BIOVAULT_DISABLE_PROFILES=1
  export BV_SYFTBOX_BACKEND="${BV_SYFTBOX_BACKEND:-embedded}"
  if [[ "$BV_SYFTBOX_BACKEND" != "process" ]]; then
    unset SYFTBOX_BINARY SYFTBOX_VERSION
  fi
  export SYFTBOX_SERVER_URL="$server"
  export SYFTBOX_CONFIG_PATH="$config"
  export SYFTBOX_DATA_DIR="$data_dir"
  export SYC_VAULT="$SYFTBOX_DATA_DIR/.syc"
  export DEV_WS_BRIDGE=1
  export DEV_WS_BRIDGE_PORT="$ws_port"

  # Hotlink/TCP proxy vars already exported in main() before devstack starts.
  # Syqure binary/codon discovery (per-instance, depends on WORKSPACE_ROOT)
  if [[ -z "${SEQURE_NATIVE_BIN:-}" ]]; then
    local syqure_dev="$WORKSPACE_ROOT/syqure/target/release/syqure"
    if [[ -x "$syqure_dev" ]]; then
      export SEQURE_NATIVE_BIN="$syqure_dev"
    fi
  fi
  if [[ -z "${CODON_PATH:-}" ]]; then
    local arch; arch="$(uname -m)"
    local os_tag="macos"
    [[ "$(uname -s)" == "Linux" ]] && os_tag="linux"
    local codon_candidate="$WORKSPACE_ROOT/syqure/bin/${os_tag}-${arch}/codon"
    if [[ -d "$codon_candidate" ]]; then
      export CODON_PATH="$codon_candidate"
    fi
  fi

  local pkg_cmd="npm"
  local role_label=""
  case "$email" in
    *client1*) role_label="contributor1" ;;
    *client2*) role_label="contributor2" ;;
    *aggregator*) role_label="aggregator" ;;
  esac

  echo ""
  echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  Desktop Instance ${instance_num}: ${email} (${role_label})${NC}"
  echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}  BIOVAULT_HOME:     $BIOVAULT_HOME${NC}"
  echo -e "${YELLOW}  SYFTBOX_DATA_DIR:  $SYFTBOX_DATA_DIR${NC}"
  echo -e "${YELLOW}  SYFTBOX_CONFIG:    $SYFTBOX_CONFIG_PATH${NC}"
  echo -e "${YELLOW}  SYC_VAULT:         $SYC_VAULT${NC}"
  echo -e "${YELLOW}  SyftBox backend:   $BV_SYFTBOX_BACKEND${NC}"
  echo -e "${YELLOW}  Server:            $SYFTBOX_SERVER_URL${NC}"
  echo -e "${YELLOW}  WS Bridge Port:    $DEV_WS_BRIDGE_PORT${NC}"
  echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"

  if [[ "$background" == "bg" ]]; then
    (cd "$SCRIPT_DIR" && $pkg_cmd run dev 2>&1 | sed "s/^/[${role_label}] /") &
    local pid=$!
    echo "$pid" > "$home/desktop.pid"
    log_info "Desktop ${instance_num} (${role_label}) started in background (pid $pid)"
  else
    (cd "$SCRIPT_DIR" && $pkg_cmd run dev 2>&1 | sed "s/^/[${role_label}] /")
  fi
}

print_stack_summary() {
  log_header "Devstack Summary (Multiparty)"
  echo -e "${YELLOW}Sandbox:${NC} $SANDBOX_ROOT"
  echo -e "${YELLOW}Server:${NC}  $SERVER_URL"
  local roles=("contributor1" "contributor2" "aggregator")
  for idx in "${!CLIENTS[@]}"; do
    local email="${CLIENTS[$idx]}"
    local role="${roles[$idx]}"
    local home config port
    home="$(client_field "$email" home)" || { log_error "No client home for $email"; exit 1; }
    config="$(client_field "$email" config)" || { log_error "No config path for $email"; exit 1; }
    port="$(client_field "$email" port)" || { log_error "No daemon port for $email"; exit 1; }
    echo -e "  Client $((idx+1)) (${role}): $email"
    echo -e "    Home:    $home"
    echo -e "    Config:  $config"
    echo -e "    Daemon:  http://127.0.0.1:${port}"
  done
}

seed_rpc_keepfiles() {
  log_header "Seeding RPC keep files (.syftkeep)"
  for email in "${CLIENTS[@]}"; do
    local home config data_dir
    home="$(client_field "$email" home)" || { log_error "No client home for $email"; exit 1; }
    config="$(client_field "$email" config)" || { log_error "No config path for $email"; exit 1; }
    data_dir="$(parse_data_dir "$config")"
    [[ -z "$data_dir" ]] && { log_error "Could not read data_dir from $config"; exit 1; }

    for target in "${CLIENTS[@]}"; do
      local rpc_dir="$data_dir/datasites/$target/app_data/biovault/rpc"
      mkdir -p "$rpc_dir/message" 2>/dev/null || true
      touch "$rpc_dir/.syftkeep" 2>/dev/null || true
      touch "$rpc_dir/message/.syftkeep" 2>/dev/null || true

      local shadow_rpc="$data_dir/unencrypted/$target/app_data/biovault/rpc"
      mkdir -p "$shadow_rpc/message" 2>/dev/null || true
      touch "$shadow_rpc/.syftkeep" 2>/dev/null || true
      touch "$shadow_rpc/message/.syftkeep" 2>/dev/null || true
    done
  done
  log_info "RPC keep files seeded (best-effort)"
}

provision_identities() {
  log_header "Skipping Syft Crypto provisioning (use onboarding flow)"
}

run_initial_sync() {
  log_header "Skipping initial BioVault syncs (onboarding will handle setup)"
}

preseed_onboarding_for_bootstrap() {
  log_header "Pre-seeding onboarding state for bootstrap (skip onboarding UI)"

  for email in "${CLIENTS[@]}"; do
    local home config server data_dir
    home="$(client_field "$email" home)" || { log_error "No client home for $email"; exit 1; }
    config="$(client_field "$email" config)" || { log_error "No config path for $email"; exit 1; }
    server="$(client_field "$email" server)"
    [[ -z "$server" ]] && server="$SERVER_URL"
    data_dir="$(parse_data_dir "$config")"
    [[ -z "$data_dir" ]] && data_dir="$home"

    mkdir -p "$home"
    log_info "Pre-onboarding $email via bv init --quiet"
    env \
      BIOVAULT_HOME="$home" \
      BIOVAULT_DISABLE_PROFILES=1 \
      SYFTBOX_SERVER_URL="$server" \
      SYFTBOX_CONFIG_PATH="$config" \
      SYFTBOX_DATA_DIR="$data_dir" \
      SYC_VAULT="$data_dir/.syc" \
      "$BV_CLI_BIN" init --quiet "$email" >/dev/null
  done

  log_success "Pre-seeded onboarding for ${#CLIENTS[@]} clients"
}

wait_for_peer_did() {
  local data_dir="$1"
  local peer="$2"
  local timeout_s="${3:-20}"
  local did_path="$data_dir/datasites/$peer/public/crypto/did.json"
  local deadline=$((SECONDS + timeout_s))
  while (( SECONDS < deadline )); do
    if [[ -f "$did_path" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

import_peer_contacts() {
  log_header "Importing peer key bundles for all clients"
  local imported=0
  local missing=0

  for email in "${CLIENTS[@]}"; do
    local config data_dir bundles_dir
    config="$(client_field "$email" config)" || { log_error "No config path for $email"; exit 1; }
    data_dir="$(parse_data_dir "$config")"
    [[ -z "$data_dir" ]] && { log_error "Could not read data_dir from $config"; exit 1; }
    bundles_dir="$data_dir/.biovault/vault/bundles"
    mkdir -p "$bundles_dir"

    for peer in "${CLIENTS[@]}"; do
      [[ "$peer" == "$email" ]] && continue
      local did_path="$data_dir/datasites/$peer/public/crypto/did.json"
      local bundle_path="$bundles_dir/$peer.json"
      if ! wait_for_peer_did "$data_dir" "$peer" 30; then
        log_warn "$email missing peer DID (not synced yet): $did_path"
        ((missing += 1))
        continue
      fi
      cp "$did_path" "$bundle_path"
      ((imported += 1))
    done
  done

  if (( missing > 0 )); then
    log_warn "Imported $imported bundles, $missing peer bundles missing (can refresh in app later)"
  else
    log_success "Imported $imported peer bundles"
  fi
}

run_bootstrap() {
  local ws1 ws2 ws3
  ws1=$WS_PORT_BASE
  ws2=$((WS_PORT_BASE + 1))
  ws3=$((WS_PORT_BASE + 2))
  local flow_name="${MULTIPARTY_FLOW_NAME:-multiparty}"
  local project_file="${BOOTSTRAP_PROJECT_FILE:-${MULTIPARTY_BOOTSTRAP_PROJECT:-}}"
  local project_name="${BOOTSTRAP_PROJECT_NAME:-${MULTIPARTY_BOOTSTRAP_PROJECT_NAME:-}}"

  log_header "Bootstrapping multiparty setup"
  if [[ ! -f "$SCRIPT_DIR/scripts/bootstrap-three.mjs" ]]; then
    log_error "Missing bootstrap helper: $SCRIPT_DIR/scripts/bootstrap-three.mjs"
    exit 1
  fi

  local -a bootstrap_args=(
    --ws1 "$ws1" --email1 "${CLIENTS[0]}"
    --ws2 "$ws2" --email2 "${CLIENTS[1]}"
    --ws3 "$ws3" --email3 "${CLIENTS[2]}"
    --flow "$flow_name"
  )
  if [[ -n "$project_file" ]]; then
    bootstrap_args+=(--flow-file "$project_file")
  fi
  if [[ -n "$project_name" ]]; then
    bootstrap_args+=(--flow-name "$project_name")
  fi
  if (( AUTO_RUN_FLAG )); then
    bootstrap_args+=(--auto-run)
  fi
  if [[ -n "$STOP_BEFORE_STEP" ]]; then
    bootstrap_args+=(--stop-before "$STOP_BEFORE_STEP")
  fi

  node "$SCRIPT_DIR/scripts/bootstrap-three.mjs" "${bootstrap_args[@]}"
  local mode_msg="Bootstrap complete (onboarding, trust, flow import, group invitation)"
  if [[ -n "$project_file" ]]; then
    mode_msg="Bootstrap complete (onboarding, trust, imported project flow + group invitation)"
  fi
  log_success "$mode_msg"
}

launch_three_instances() {
  if [[ ${#CLIENTS[@]} -lt 3 ]]; then
    log_error "Three clients are required for multiparty mode"
    exit 1
  fi
  log_header "Launching THREE desktop windows for multiparty flow testing"
  echo -e "${YELLOW}  Roles:${NC}"
  echo -e "    client1@sandbox.local    → contributor1"
  echo -e "    client2@sandbox.local    → contributor2"
  echo -e "    aggregator@sandbox.local → aggregator"
  echo ""

  if (( BOOTSTRAP_FLAG )); then
    preseed_onboarding_for_bootstrap
    launch_desktop_instance "${CLIENTS[2]}" 3 "bg"  # aggregator
    sleep 2
    launch_desktop_instance "${CLIENTS[1]}" 2 "bg"  # client2
    sleep 2
    launch_desktop_instance "${CLIENTS[0]}" 1 "bg"  # client1
    sleep 2
    run_bootstrap
    cat <<EOF

Bootstrap is ready. Desktop instances running:
  Client1:    ${CLIENTS[0]} (ws:${WS_PORT_BASE})
  Client2:    ${CLIENTS[1]} (ws:$((WS_PORT_BASE + 1)))
  Aggregator: ${CLIENTS[2]} (ws:$((WS_PORT_BASE + 2)))

Press Ctrl+C to stop all instances.
EOF
    # Wait for background desktop processes so Ctrl+C triggers cleanup
    wait
    return
  fi

  # Remove any previous config.yaml to trigger onboarding for manual flows.
  for email in "${CLIENTS[@]}"; do
    rm -f "$(client_field "$email" home)"/config.yaml
  done

  # Launch aggregator and client2 in background, client1 in foreground
  launch_desktop_instance "${CLIENTS[2]}" 3 "bg"  # aggregator
  sleep 2
  launch_desktop_instance "${CLIENTS[1]}" 2 "bg"  # client2
  sleep 2

  launch_desktop_instance "${CLIENTS[0]}" 1 "fg"  # client1 (foreground)
}

launch_single_instance() {
  local email="$1"
  if [[ -z "$email" ]]; then
    email="${CLIENTS[0]}"
  fi
  log_header "Launching SINGLE desktop window for $email"
  rm -f "$(client_field "$email" home)"/config.yaml
  launch_desktop_instance "$email" 1 "fg"
}

kill_stale_processes() {
  local stale_pids
  stale_pids="$(pgrep -f "$WORKSPACE_ROOT.*(bv-desktop|bv syftboxd|syqure|syftbox-rs)" 2>/dev/null || true)"
  if [[ -n "$stale_pids" ]]; then
    log_warn "Killing stale workspace processes from previous runs: $stale_pids"
    echo "$stale_pids" | xargs kill 2>/dev/null || true
    sleep 1
    stale_pids="$(pgrep -f "$WORKSPACE_ROOT.*(bv-desktop|bv syftboxd|syqure|syftbox-rs)" 2>/dev/null || true)"
    if [[ -n "$stale_pids" ]]; then
      echo "$stale_pids" | xargs kill -9 2>/dev/null || true
    fi
  fi
}

cleanup_on_exit() {
  log_info "Shutting down all desktop processes..."
  # Kill all background jobs spawned by this script
  jobs -p 2>/dev/null | xargs -r kill 2>/dev/null || true
  stop_desktops
  kill_stale_processes
  log_success "Cleanup complete"
}

main() {
  check_requirements
  kill_stale_processes

  if (( STOP_FLAG )); then
    stop_stack
    exit 0
  fi

  # Ensure all child processes are cleaned up on Ctrl+C / exit
  trap cleanup_on_exit INT TERM EXIT

  # Hotlink/TCP proxy env must be exported BEFORE devstack starts so the
  # rust SyftBox daemons inherit them and enable hotlink transport.
  # (test-scenario.sh does this at lines 349-393, before start_devstack)
  export BV_SYFTBOX_HOTLINK="${BV_SYFTBOX_HOTLINK:-1}"
  export BV_SYFTBOX_HOTLINK_SOCKET_ONLY="${BV_SYFTBOX_HOTLINK_SOCKET_ONLY:-1}"
  export BV_SYFTBOX_HOTLINK_TCP_PROXY="${BV_SYFTBOX_HOTLINK_TCP_PROXY:-1}"
  export BV_SYFTBOX_HOTLINK_QUIC="${BV_SYFTBOX_HOTLINK_QUIC:-1}"
  export BV_SYFTBOX_HOTLINK_QUIC_ONLY="${BV_SYFTBOX_HOTLINK_QUIC_ONLY:-0}"
  export BV_SYQURE_TCP_PROXY="${BV_SYQURE_TCP_PROXY:-1}"
  export SYFTBOX_HOTLINK="${SYFTBOX_HOTLINK:-$BV_SYFTBOX_HOTLINK}"
  export SYFTBOX_HOTLINK_SOCKET_ONLY="${SYFTBOX_HOTLINK_SOCKET_ONLY:-$BV_SYFTBOX_HOTLINK_SOCKET_ONLY}"
  export SYFTBOX_HOTLINK_TCP_PROXY="${SYFTBOX_HOTLINK_TCP_PROXY:-$BV_SYFTBOX_HOTLINK_TCP_PROXY}"
  export SYFTBOX_HOTLINK_QUIC="${SYFTBOX_HOTLINK_QUIC:-$BV_SYFTBOX_HOTLINK_QUIC}"
  export SYFTBOX_HOTLINK_QUIC_ONLY="${SYFTBOX_HOTLINK_QUIC_ONLY:-$BV_SYFTBOX_HOTLINK_QUIC_ONLY}"

  # Force Tauri Rust backend recompile so dev always uses fresh code.
  # cargo tauri dev watches src-tauri/src but may miss workspace deps.
  log_info "Rebuilding Tauri backend (cargo build)..."
  (cd "$SCRIPT_DIR/src-tauri" && cargo build 2>&1 | tail -1)
  log_success "Tauri backend ready"

  start_stack
  load_state
  ensure_bv_cli
  seed_rpc_keepfiles
  provision_identities
  run_initial_sync
  import_peer_contacts
  print_stack_summary

  if (( BOOTSTRAP_FLAG )) && (( SINGLE_MODE )); then
    log_error "--bootstrap is only supported with three-client mode (no --single)"
    exit 1
  fi

  if (( SINGLE_MODE )); then
    launch_single_instance "$SINGLE_TARGET"
  else
    launch_three_instances
  fi
}

main
