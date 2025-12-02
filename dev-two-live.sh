#!/usr/bin/env bash
set -euo pipefail

# Launch two BioVault Desktop instances against hosted dev.syftbox.net.
# - Builds syftbox prod binary into resources.
# - For each email, provisions an sbenv client (init + daemon), runs bv init, and exchanges bundles.
# - Starts two bun dev instances with per-user SyftBox env and debug banner.
# - Cleans up sbenv daemons on exit.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYFTBOX_BIN_RES="$ROOT_DIR/src-tauri/resources/syftbox/syftbox"
SBENV_BIN="$ROOT_DIR/biovault/sbenv/cli/target/release/sbenv"
BV_CLI_BIN="$ROOT_DIR/biovault/cli/target/release/bv"
SYFTBOX_URL="https://dev.syftbox.net"
SYFTBOX_AUTH_ENABLED="0"
SANDBOX_DIR="/Users/madhavajay/dev/datasites/biovault"
CLIENT1_EMAIL=${1:-me@madhavajay.com}
CLIENT2_EMAIL=${2:-madhava@openmined.org}
LOG_DIR="$ROOT_DIR/logs"
SBENV_LAUNCH_PIDS=()
mkdir -p "$LOG_DIR"

build_syftbox() {
  echo "[live] Building syftbox for prod bundle..."
  (cd "$ROOT_DIR" && ./scripts/build-syftbox-prod.sh)
  if [[ ! -x "$SYFTBOX_BIN_RES" ]]; then
    echo "[live] ERROR: syftbox binary missing at $SYFTBOX_BIN_RES" >&2
    exit 1
  fi
  echo "[live] syftbox ready at $SYFTBOX_BIN_RES"
}

ensure_cli() {
  echo "[live] Building BioVault CLI (cargo build --release)..."
  (cd "$ROOT_DIR/biovault/cli" && cargo build --release)

  if [[ ! -x "$SBENV_BIN" ]]; then
    echo "[live] Building sbenv CLI (cargo build --release)..."
    (cd "$ROOT_DIR/biovault/sbenv/cli" && cargo build --release)
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
  local email="$1"
  local client_dir="$SANDBOX_DIR/$email"
  rm -rf "$client_dir"
  mkdir -p "$client_dir"
  echo "[live] sbenv init $email"
  (cd "$client_dir" && "$SBENV_BIN" init --dev --server-url "$SYFTBOX_URL" --email "$email" --binary "$SYFTBOX_BIN_RES")
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

stop_sbenv_client() {
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
  start_sbenv_client "$email"
  wait_for_sbenv_daemon "$email"
  local client_dir="$SANDBOX_DIR/$email"
  local config_path="$client_dir/.syftbox/config.json"
  local data_dir
  data_dir="$(read_data_dir "$config_path")"
  if [[ -z "$data_dir" ]]; then
    echo "[live] ERROR: data_dir missing in $config_path" >&2
    exit 1
  fi
  BIOVAULT_HOME="$client_dir" \
  SYFTBOX_CONFIG_PATH="$config_path" \
  SYFTBOX_DATA_DIR="$data_dir" \
  SYFTBOX_EMAIL="$email" \
  SYFTBOX_SERVER_URL="$SYFTBOX_URL" \
  SYFTBOX_AUTH_ENABLED="$SYFTBOX_AUTH_ENABLED" \
  "$BV_CLI_BIN" init "$email" --quiet || true
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
  (
    cd "$ROOT_DIR"
    local config_path="$home/.syftbox/config.json"
    local data_dir
    data_dir="$(read_data_dir "$config_path")"
    BIOVAULT_HOME="$home" \
    SYFTBOX_SERVER_URL="$SYFTBOX_URL" \
    SYFTBOX_BINARY="$SYFTBOX_BIN_RES" \
    SYFTBOX_VERSION="$(git describe --tags --always --dirty 2>/dev/null || echo dev)" \
    SYFTBOX_EMAIL="$email" \
    SYFTBOX_AUTH_ENABLED="$SYFTBOX_AUTH_ENABLED" \
    SYFTBOX_CONFIG_PATH="$config_path" \
    SYFTBOX_DATA_DIR="$data_dir" \
    BIOVAULT_DEBUG_BANNER=1 \
    bun run dev
  )
}

cleanup() {
  echo "[live] Cleaning up sbenv clients"
  for pid in "${SBENV_LAUNCH_PIDS[@]:-}"; do
    if [[ -n "$pid" ]] && ps -p "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  stop_sbenv_client "$CLIENT1_EMAIL"
  stop_sbenv_client "$CLIENT2_EMAIL"
  echo "[live] Done"
}

trap cleanup EXIT INT TERM

main() {
  build_syftbox
  ensure_cli

  provision_client "$CLIENT1_EMAIL"
  provision_client "$CLIENT2_EMAIL"

  local c1_dir="$SANDBOX_DIR/$CLIENT1_EMAIL"
  local c2_dir="$SANDBOX_DIR/$CLIENT2_EMAIL"
  local c1_cfg="$c1_dir/.syftbox/config.json"
  local c2_cfg="$c2_dir/.syftbox/config.json"
  local c1_data="$(read_data_dir "$c1_cfg")"
  local c2_data="$(read_data_dir "$c2_cfg")"
  local c1_bundle c2_bundle
  c1_bundle="$(ensure_bundle_under_datasites "$c1_data" "$CLIENT1_EMAIL")"
  [[ -z "$c1_bundle" ]] && c1_bundle="$(find_bundle "$c1_data" "$CLIENT1_EMAIL" || true)"
  c2_bundle="$(ensure_bundle_under_datasites "$c2_data" "$CLIENT2_EMAIL")"
  [[ -z "$c2_bundle" ]] && c2_bundle="$(find_bundle "$c2_data" "$CLIENT2_EMAIL" || true)"
  if [[ -n "$c1_bundle" ]]; then import_bundle "$c1_bundle" "$CLIENT1_EMAIL" "$c2_dir" "$CLIENT2_EMAIL"; fi
  if [[ -n "$c2_bundle" ]]; then import_bundle "$c2_bundle" "$CLIENT2_EMAIL" "$c1_dir" "$CLIENT1_EMAIL"; fi

  launch_instance "$c1_dir" "client1" "$CLIENT1_EMAIL" & pid1=$!
  launch_instance "$c2_dir" "client2" "$CLIENT2_EMAIL" & pid2=$!
  echo "[live] client1 PID: $pid1"
  echo "[live] client2 PID: $pid2"
  echo "[live] Use 'tail -f logs/sbenv-*.log' for daemon logs."
  wait
}

main "$@"
