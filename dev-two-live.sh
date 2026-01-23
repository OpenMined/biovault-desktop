#!/usr/bin/env bash
set -euo pipefail

# Launch two BioVault Desktop instances against hosted dev.syftbox.net.
# - Embedded (syftbox-rs) is default.
# - Use --process/--go to run the external syftbox daemon via sbenv.
# - Starts two npm dev instances with per-user SyftBox env and debug banner.
# - Cleans up sbenv daemons on exit when process mode is used.

# Usage:
#   ./dev-two-live.sh [--client EMAIL ... | --clients a,b] [--single [EMAIL]] [--stop] [--reset] [--path DIR] [--embedded|--process|--go] [--prod]
# Defaults: client1=client1@sandbox.local, client2=client2@sandbox.local
# Use --prod to enable production-like mode (enables authentication buttons)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$ROOT_DIR}"
BIOVAULT_DIR="${BIOVAULT_DIR:-$WORKSPACE_ROOT/biovault}"
SBENV_DIR="${SBENV_DIR:-$WORKSPACE_ROOT/sbenv}"
if [[ ! -d "$SBENV_DIR" && -d "$BIOVAULT_DIR/sbenv" ]]; then
  SBENV_DIR="$BIOVAULT_DIR/sbenv"
fi
WORKSPACE_ROOT="$WORKSPACE_ROOT" "$ROOT_DIR/scripts/ensure-workspace-deps.sh" \
  "biovault/cli/Cargo.toml" \
  "syftbox-sdk/Cargo.toml" \
  "syftbox/rust/Cargo.toml"
SYFTBOX_BIN_RES="$ROOT_DIR/src-tauri/resources/syftbox/syftbox"
SBENV_BIN="$SBENV_DIR/cli/target/release/sbenv"
BV_CLI_BIN="$BIOVAULT_DIR/cli/target/release/bv"
SYFTBOX_URL="${SYFTBOX_URL:-https://dev.syftbox.net}"
SYFTBOX_AUTH_ENABLED="${SYFTBOX_AUTH_ENABLED:-1}"
SANDBOX_DIR="${SANDBOX_DIR:-$ROOT_DIR/sandbox}"
LOG_DIR="$ROOT_DIR/logs"
SBENV_LAUNCH_PIDS=()
CLIENTS=()
BACKEND="${BV_SYFTBOX_BACKEND:-embedded}"
SINGLE_MODE=0
SINGLE_TARGET=""
STOP_ONLY=0
RESET_FLAG=0
PROD_MODE=0
mkdir -p "$LOG_DIR"

DEFAULT_CLIENT1="${CLIENT1_EMAIL:-client1@sandbox.local}"
DEFAULT_CLIENT2="${CLIENT2_EMAIL:-client2@sandbox.local}"

if [[ -z "${BV_SYFTBOX_BACKEND:-}" ]]; then
  BV_SYFTBOX_BACKEND="embedded"
fi

build_syftbox() {
  echo "[live] Building syftbox for prod bundle..."
  (cd "$ROOT_DIR" && ./scripts/build-syftbox-prod.sh)
  if [[ ! -x "$SYFTBOX_BIN_RES" ]]; then
    echo "[live] ERROR: syftbox binary missing at $SYFTBOX_BIN_RES" >&2
    exit 1
  fi
  echo "[live] syftbox ready at $SYFTBOX_BIN_RES"
}

build_syftbox_rust() {
  echo "[live] Building syftbox-rs (embedded)..."
  (cd "$ROOT_DIR" && ./scripts/build-syftbox-rust.sh)
  if [[ ! -x "$SYFTBOX_BIN_RES" ]]; then
    echo "[live] ERROR: syftbox-rs binary missing at $SYFTBOX_BIN_RES" >&2
    exit 1
  fi
  echo "[live] syftbox-rs ready at $SYFTBOX_BIN_RES"
}

ensure_cli() {
  local mode="${1:-}"
  echo "[live] Building BioVault CLI (cargo build --release)..."
  (cd "$BIOVAULT_DIR/cli" && cargo build --release)

  if [[ "$mode" == "process" ]] && [[ ! -x "$SBENV_BIN" ]]; then
    echo "[live] Building sbenv CLI (cargo build --release)..."
    (cd "$SBENV_DIR/cli" && cargo build --release)
  fi
}

read_data_dir() {
  local config_path="$1"
  python3 - <<'PY' "$config_path"
import json, sys
cfg = json.load(open(sys.argv[1]))
print(cfg.get("data_dir", ""))
PY
}

start_sbenv_client() {
  if [[ "$BACKEND" != "process" ]]; then
    return
  fi
  local email="$1"
  local client_dir="$SANDBOX_DIR/$email"
  local config_file="$client_dir/.syftbox/config.json"

  # Only wipe and reinit if --reset was passed or no config exists
  if (( RESET_FLAG )) || [[ ! -f "$config_file" ]]; then
    if (( RESET_FLAG )); then
      echo "[live] Resetting client $email (--reset flag)"
      # Stop any running Jupyter processes for this client first
      if [[ -d "$client_dir/sessions" ]]; then
        echo "[live] Stopping Jupyter processes for $email..."
        pkill -f "jupyter.*$client_dir" 2>/dev/null || true
      fi
      rm -rf "$client_dir"
    fi
    mkdir -p "$client_dir"
    echo "[live] sbenv init $email"
    # Don't use --dev flag since live servers require auth (--dev hardcodes SYFTBOX_AUTH_ENABLED=0)
    (cd "$client_dir" && "$SBENV_BIN" init --server-url "$SYFTBOX_URL" --email "$email" --binary "$SYFTBOX_BIN_RES")
  else
    echo "[live] Using existing client config for $email"
  fi

  echo "[live] sbenv start $email"
  (
    set +u
    cd "$client_dir"
    eval "$("$SBENV_BIN" activate --quiet)"
    ln -sf "$SYFTBOX_BIN_RES" ./syftbox
    export SYFTBOX_BINARY="${SYFTBOX_BIN_RES}"
    PATH="$PWD:$PATH"
    SYFTBOX_AUTH_ENABLED="$SYFTBOX_AUTH_ENABLED" "$SBENV_BIN" start --skip-login-check >>"$LOG_DIR/sbenv-$email.log" 2>&1
  ) &
  SBENV_LAUNCH_PIDS+=("$!")
}

start_embedded_client() {
  if [[ "$BACKEND" == "process" ]]; then
    return
  fi
  local email="$1"
  local client_dir="$SANDBOX_DIR/$email"
  local config_yaml="$client_dir/config.yaml"

  if [[ ! -f "$config_yaml" ]]; then
    echo "[live] Skipping syftboxd start for $email (missing config.yaml; complete onboarding first)"
    return
  fi

  echo "[live] Starting embedded syftboxd for $email"
  BIOVAULT_HOME="$client_dir" \
    SYFTBOX_EMAIL="$email" \
    SYFTBOX_SERVER_URL="$SYFTBOX_URL" \
    SYFTBOX_AUTH_ENABLED="$SYFTBOX_AUTH_ENABLED" \
    BV_SYFTBOX_BACKEND=embedded \
    "$BV_CLI_BIN" syftboxd start >/dev/null 2>&1 || {
      echo "[live] WARN: syftboxd failed to start for $email (check config/auth)" >&2
    }
}

stop_sbenv_client() {
  if [[ "$BACKEND" != "process" ]]; then
    return
  fi
  local email="$1"
  local client_dir="$SANDBOX_DIR/$email"
  local pid_file="$client_dir/.syftbox/syftbox.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(tr -d ' \n\r' < "$pid_file")"
    if [[ -n "$pid" ]] && ps -p "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  fi
}

provision_client() {
  local email="$1"
  if [[ "$BACKEND" == "process" ]]; then
    start_sbenv_client "$email"
    wait_for_sbenv_daemon "$email"
  else
    local client_dir="$SANDBOX_DIR/$email"
    if (( RESET_FLAG )) && [[ -d "$client_dir" ]]; then
      echo "[live] Resetting client $email (--reset flag)"
      rm -rf "$client_dir"
    fi
    mkdir -p "$client_dir"
    start_embedded_client "$email"
  fi
  # Do not pre-provision keys/bundles; onboarding in-app will handle identity.
}

find_bundle() {
  local data_dir="$1"
  local email="$2"
  local p1="$data_dir/datasites/$email/public/crypto/did.json"
  local p2="$data_dir/$email/public/crypto/did.json"
  if [[ -f "$p1" ]]; then echo "$p1"; return; fi
  if [[ -f "$p2" ]]; then echo "$p2"; return; fi
}

import_bundle() {
  local src_bundle="$1"
  local src_email="$2"
  local dst_home="$3"
  local dst_email="$4"
  local dst_config="$dst_home/.syftbox/config.json"
  local dst_data
  dst_data="$(read_data_dir "$dst_config")"
  [[ -f "$src_bundle" ]] || { echo "[live] Missing bundle $src_bundle" >&2; return; }
  BIOVAULT_HOME="$dst_home" \
  SYFTBOX_CONFIG_PATH="$dst_config" \
  SYFTBOX_DATA_DIR="$dst_data" \
  SYFTBOX_EMAIL="$dst_email" \
  SYFTBOX_SERVER_URL="$SYFTBOX_URL" \
  SYFTBOX_AUTH_ENABLED="$SYFTBOX_AUTH_ENABLED" \
  "$BV_CLI_BIN" syc import "$src_bundle" --expected-identity "$src_email" || true
}

ensure_bundle_under_datasites() {
  local data_dir="$1"
  local email="$2"
  local legacy="$data_dir/$email/public/crypto/did.json"
  local expected="$data_dir/datasites/$email/public/crypto/did.json"
  if [[ -f "$expected" ]]; then
    echo "$expected"
    return
  fi
  if [[ -f "$legacy" ]]; then
    mkdir -p "$(dirname "$expected")"
    mv "$legacy" "$expected"
    echo "$expected"
    return
  fi
  echo ""
}

wait_for_sbenv_daemon() {
  local email="$1"
  local client_dir="$SANDBOX_DIR/$email"
  local pid_file="$client_dir/.syftbox/syftbox.pid"
  local log_file="$LOG_DIR/sbenv-$email.log"
  for attempt in $(seq 1 30); do
    if [[ -f "$pid_file" ]]; then
      local pid
      pid="$(tr -d ' \n\r' < "$pid_file")"
      if [[ -n "$pid" ]] && ps -p "$pid" >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 1
  done
  echo "[live] WARN: SyftBox daemon for $email not running after start. Log tail:" >&2
  [[ -f "$log_file" ]] && tail -n 40 "$log_file" >&2
  return 1
}

launch_instance() {
  local home="$1"; shift
  local tag="$1"; shift
  local email="$1"; shift
  echo "[live] Launching BioVault ($tag) with BIOVAULT_HOME=$home email=$email" >&2
  local backend="${BACKEND}"
  (
    cd "$ROOT_DIR"
    local config_path="$home/.syftbox/config.json"
    local data_dir=""
    local default_config="$home/syftbox/config.json"
    local default_data="$home"
    local env_config=""
    local env_data=""
    local env_binary=""
    if [[ "$backend" == "process" ]]; then
      data_dir="$(read_data_dir "$config_path")"
      env_config="$config_path"
      env_data="$data_dir"
      env_binary="$SYFTBOX_BIN_RES"
    else
      env_config="$default_config"
      env_data="$default_data"
    fi
    local -a cmd=(env)
    if [[ "$backend" != "process" ]]; then
      cmd+=(-u SYFTBOX_BINARY -u SYFTBOX_VERSION)
    fi
    cmd+=(
      "BIOVAULT_HOME=$home"
      "BIOVAULT_DEV_MODE=1"
      "BIOVAULT_DISABLE_PROFILES=1"
      "BV_SYFTBOX_BACKEND=$backend"
      "SYFTBOX_SERVER_URL=$SYFTBOX_URL"
      "SYFTBOX_EMAIL=$email"
      "SYFTBOX_AUTH_ENABLED=$SYFTBOX_AUTH_ENABLED"
      "SYFTBOX_CONFIG_PATH=$env_config"
      "SYFTBOX_DATA_DIR=$env_data"
      "SYC_VAULT=$env_data/.syc"
      "BIOVAULT_DEBUG_BANNER=1"
    )
    # Only set BIOVAULT_DEV_SYFTBOX in non-prod mode (enables auth bypass)
    if (( ! PROD_MODE )); then
      cmd+=("BIOVAULT_DEV_SYFTBOX=1")
    fi
    if [[ "$backend" == "process" ]]; then
      cmd+=(
        "SYFTBOX_BINARY=$env_binary"
        "SYFTBOX_VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo dev)"
      )
    fi
    cmd+=(npm run dev)
    "${cmd[@]}"
  )
}

cleanup() {
  if [[ "$BACKEND" == "process" ]]; then
    echo "[live] Cleaning up sbenv clients"
  fi
  for pid in "${SBENV_LAUNCH_PIDS[@]:-}"; do
    if [[ -n "$pid" ]] && ps -p "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  local targets=("${CLIENTS[@]:-}")
  if ((${#targets[@]} == 0)); then
    targets=("$DEFAULT_CLIENT1" "$DEFAULT_CLIENT2")
  fi
  for email in "${targets[@]}"; do
    stop_sbenv_client "$email"
    # Also stop any Jupyter processes for this client
    local client_dir="$SANDBOX_DIR/$email"
    pkill -f "jupyter.*$client_dir" 2>/dev/null || true
  done
  echo "[live] Done"
}

trap cleanup EXIT INT TERM

main() {
  # Parse args (align with dev-two.sh style)
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --embedded)
        BACKEND="embedded"
        ;;
      --process|--go)
        BACKEND="process"
        ;;
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
      --prod)
        PROD_MODE=1
        ;;
      --path)
        SANDBOX_DIR="${2:?--path requires a directory}"
        shift
        ;;
      -h|--help)
        echo "Usage: $0 [--client EMAIL ... | --clients a,b] [--single [EMAIL]] [--stop] [--reset] [--path DIR] [--embedded|--process|--go] [--prod]"
        echo "  --prod  Enable production mode (allows authentication, disables dev syftbox bypass)"
        exit 0
        ;;
      *)
        break
        ;;
    esac
    shift
  done

  if (( STOP_ONLY )); then
    cleanup
    exit 0
  fi

  # Note: --reset now only resets individual client directories, not the whole SANDBOX_DIR
  # This is safer when SANDBOX_DIR points to a shared folder like ~/dev/biovaults
  if (( RESET_FLAG )); then
    echo "[live] Will reset individual client directories (not entire sandbox)"
  fi

  if ((${#CLIENTS[@]} == 0)); then
    CLIENTS=("$DEFAULT_CLIENT1" "$DEFAULT_CLIENT2")
  fi

  if (( SINGLE_MODE )); then
    if [[ -n "$SINGLE_TARGET" ]]; then
      CLIENTS=("$SINGLE_TARGET")
    else
      CLIENTS=("${CLIENTS[0]}")
    fi
  fi

  if [[ "$BACKEND" == "process" ]]; then
    build_syftbox
    ensure_cli "process"
  else
    build_syftbox_rust
    ensure_cli "embedded"
  fi

  # Provision all requested clients
  declare -a PROVISIONED=()
  for email in "${CLIENTS[@]}"; do
    provision_client "$email"
    PROVISIONED+=("$email")
  done

  if ((${#PROVISIONED[@]} > 1)); then
    local a="${PROVISIONED[0]}"
    local b="${PROVISIONED[1]}"
    local a_dir="$SANDBOX_DIR/$a"
    local b_dir="$SANDBOX_DIR/$b"
    launch_instance "$a_dir" "client1" "$a" & pid1=$!
    launch_instance "$b_dir" "client2" "$b" & pid2=$!
    echo "[live] client1 PID: $pid1"
    echo "[live] client2 PID: $pid2"
  else
    local only="${PROVISIONED[0]}"
    local only_dir="$SANDBOX_DIR/$only"
    launch_instance "$only_dir" "client" "$only" & pid1=$!
    echo "[live] client PID: $pid1"
  fi

  if [[ "$BACKEND" == "process" ]]; then
    echo "[live] Use 'tail -f logs/sbenv-*.log' for daemon logs."
  fi
  wait
}

main "$@"
