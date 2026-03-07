#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$ROOT_DIR}"
BIOVAULT_DIR="${BIOVAULT_DIR:-$WORKSPACE_ROOT/biovault}"
SYFTBOX_URL="${SYFTBOX_URL:-https://dev.syftbox.net}"
SYFTBOX_AUTH_ENABLED="${SYFTBOX_AUTH_ENABLED:-1}"
SANDBOX_DIR="${SANDBOX_DIR:-$ROOT_DIR/sandbox}"
SYFTBOX_BIN_RES="$ROOT_DIR/src-tauri/resources/syftbox/syftbox"
BV_CLI_BIN="$BIOVAULT_DIR/cli/target/release/bv"

NUM_CLIENTS=1
AUTH_OVERRIDE=""
PROVISION_CLIENTS=1
RESET_FLAG=0
FIRST_RUN=0
STOP_ONLY=0
ARGS=()

CLIENTS=()
CLIENT_HOME_EMAILS=()
CLIENT_HOME_PATHS=()
VITE_PID=""
APP_PIDS=()
SYFTBOXD_STARTED_EMAILS=()
SYFTBOXD_STARTED_HOMES=()
STATE_DIR="$ROOT_DIR/.dev-live"
STATE_FILE="$STATE_DIR/state.env"

DEFAULT_CLIENT1="${CLIENT1_EMAIL:-client1@sandbox.local}"
DEFAULT_CLIENT2="${CLIENT2_EMAIL:-client2@sandbox.local}"

has_client_args() {
  local i=0
  while [[ $i -lt ${#ARGS[@]} ]]; do
    case "${ARGS[$i]}" in
      --client|--clients)
        return 0
        ;;
    esac
    i=$((i + 1))
  done
  return 1
}

profiles_store_path() {
  if [[ -n "${BIOVAULT_PROFILES_PATH:-}" ]]; then
    echo "$BIOVAULT_PROFILES_PATH"
    return 0
  fi
  if [[ -n "${BIOVAULT_PROFILES_DIR:-}" ]]; then
    echo "$BIOVAULT_PROFILES_DIR/profiles.json"
    return 0
  fi
  echo "$HOME/.bvprofiles/profiles.json"
}

clear_profiles_store_on_reset() {
  local store
  store="$(profiles_store_path)"
  local store_dir
  store_dir="$(dirname "$store")"

  if [[ -f "$store" ]]; then
    echo "[dev-live] --reset: removing profiles store at $store"
    rm -f "$store"
  else
    echo "[dev-live] --reset: no profiles store found at $store"
  fi

  if [[ -d "$store_dir" ]]; then
    rmdir "$store_dir" 2>/dev/null || true
  fi
}

prompt_for_profiles() {
  local count="$1"
  local store
  store="$(profiles_store_path)"

  if [[ ! -f "$store" ]]; then
    echo "[dev-live] Profiles store not found at $store." >&2
    echo "[dev-live] No profiles available for selection." >&2
    return 2
  fi

  local profile_lines
  if ! profile_lines="$(python3 - "$store" <<'PY'
import json, sys
path = sys.argv[1]
try:
    data = json.load(open(path))
except Exception:
    print("")
    sys.exit(0)
profiles = data.get("profiles", [])
profiles.sort(key=lambda p: p.get("last_used_at") or "", reverse=True)
for p in profiles:
    email = (p.get("email") or "").strip()
    if not email:
        continue
    home = (p.get("biovault_home") or "").strip()
    last = (p.get("last_used_at") or "").strip()
    print(f"{email}|{home}|{last}")
PY
)"; then
    echo "[dev-live] Failed to read profiles store." >&2
    return 2
  fi

  local -a emails=()
  local -a homes=()
  local -a last_used=()
  while IFS='|' read -r email home used; do
    [[ -z "${email:-}" ]] && continue
    emails+=("$email")
    homes+=("$home")
    last_used+=("$used")
  done <<< "$profile_lines"

  if ((${#emails[@]} < count)); then
    echo "[dev-live] Only found ${#emails[@]} profile(s) with email; need $count." >&2
    return 2
  fi

  if [[ ! -t 0 ]]; then
    echo "[dev-live] Non-interactive terminal; cannot prompt for profile selection." >&2
    return 2
  fi

  local -a selected_emails=()
  local -a selected_homes=()
  if command -v fzf >/dev/null 2>&1; then
    local selection
    selection="$(
      {
        local idx
        for idx in "${!emails[@]}"; do
          printf "%s\t%s\n" "${emails[$idx]}" "${homes[$idx]}"
        done
      } | fzf \
        --multi \
        --bind 'space:toggle' \
        --header "Select $count profiles (arrow keys, space to toggle, enter to confirm)" \
        --prompt "profiles> " \
        --delimiter=$'\t' \
        --with-nth=1,2 \
        --nth=1,2 \
        --layout=reverse
    )"

    if [[ -z "${selection:-}" ]]; then
      echo "[dev-live] No profiles selected." >&2
      return 2
    fi

    while IFS=$'\t' read -r email home; do
      if [[ -n "${email:-}" ]]; then
        selected_emails+=("$email")
        selected_homes+=("${home:-}")
      fi
    done <<< "$selection"

    if ((${#selected_emails[@]} != count)); then
      echo "[dev-live] Please select exactly $count profile(s); got ${#selected_emails[@]}." >&2
      return 1
    fi
  else
    echo "Select $count profile(s) for this run:"
    local idx
    for idx in "${!emails[@]}"; do
      printf "  %2d) %s\n      %s\n" "$((idx + 1))" "${emails[$idx]}" "${homes[$idx]}"
    done

    local pick slot
    for slot in $(seq 1 "$count"); do
      while true; do
        read -r -p "Profile #$slot (1-${#emails[@]}): " pick
        if ! [[ "$pick" =~ ^[0-9]+$ ]] || (( pick < 1 || pick > ${#emails[@]} )); then
          echo "Invalid selection."
          continue
        fi
        local chosen="${emails[$((pick - 1))]}"
        local chosen_home="${homes[$((pick - 1))]}"
        local dup=0
        for existing in "${selected_emails[@]-}"; do
          if [[ "$existing" == "$chosen" ]]; then
            dup=1
            break
          fi
        done
        if (( dup )); then
          echo "Profile already selected. Choose a different one."
          continue
        fi
        selected_emails+=("$chosen")
        selected_homes+=("$chosen_home")
        break
      done
    done
  fi

  local idx
  for idx in "${!selected_emails[@]}"; do
    local chosen="${selected_emails[$idx]}"
    local chosen_home="${selected_homes[$idx]:-}"
    ARGS+=(--client "$chosen")
    if [[ -n "$chosen_home" ]]; then
      ARGS+=(--client-home "$chosen=$chosen_home")
    fi
  done
}

resolve_client_dir() {
  local email="$1"
  local idx
  for idx in "${!CLIENT_HOME_EMAILS[@]}"; do
    if [[ "${CLIENT_HOME_EMAILS[$idx]}" == "$email" ]]; then
      echo "${CLIENT_HOME_PATHS[$idx]}"
      return
    fi
  done
  echo "$SANDBOX_DIR/$email"
}

ensure_state_dir() {
  mkdir -p "$STATE_DIR"
}

write_state() {
  ensure_state_dir
  {
    echo "VITE_PID=${VITE_PID:-}"
    echo -n "APP_PIDS="
    printf '"%s"\n' "${APP_PIDS[*]:-}"
    echo -n "SYFTBOXD_STARTED_EMAILS="
    printf '"%s"\n' "${SYFTBOXD_STARTED_EMAILS[*]:-}"
    echo -n "SYFTBOXD_STARTED_HOMES="
    printf '"%s"\n' "${SYFTBOXD_STARTED_HOMES[*]:-}"
  } > "$STATE_FILE"
}

clear_state() {
  rm -f "$STATE_FILE"
}

cleanup_previous_run_from_state() {
  if [[ ! -f "$STATE_FILE" ]]; then
    return
  fi

  # shellcheck disable=SC1090
  source "$STATE_FILE" || true

  local old_vite="${VITE_PID:-}"
  local old_apps="${APP_PIDS:-}"
  local old_emails="${SYFTBOXD_STARTED_EMAILS:-}"
  local old_homes="${SYFTBOXD_STARTED_HOMES:-}"

  if [[ -n "$old_vite" ]] && kill -0 "$old_vite" 2>/dev/null; then
    echo "[dev-live] Cleaning stale Vite PID $old_vite"
    kill "$old_vite" 2>/dev/null || true
  fi

  local pid
  for pid in $old_apps; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "[dev-live] Cleaning stale app PID $pid"
      kill "$pid" 2>/dev/null || true
    fi
  done

  local -a emails_arr=()
  local -a homes_arr=()
  if [[ -n "$old_emails" ]]; then
    read -r -a emails_arr <<< "$old_emails"
  fi
  if [[ -n "$old_homes" ]]; then
    read -r -a homes_arr <<< "$old_homes"
  fi

  local i
  for i in "${!emails_arr[@]}"; do
    local email="${emails_arr[$i]}"
    local home="${homes_arr[$i]:-}"
    if [[ -n "$email" && -n "$home" ]]; then
      echo "[dev-live] Stopping stale syftboxd for $email"
      stop_embedded_client "$email" "$home"
    fi
  done

  clear_state
}

parse_runtime_args() {
  local i=0
  while [[ $i -lt ${#ARGS[@]} ]]; do
    case "${ARGS[$i]}" in
      --client)
        CLIENTS+=("${ARGS[$((i+1))]:?--client requires an email}")
        i=$((i + 2))
        ;;
      --clients)
        IFS=',' read -r -a parsed_clients <<<"${ARGS[$((i+1))]:?--clients requires a list}"
        CLIENTS+=("${parsed_clients[@]}")
        i=$((i + 2))
        ;;
      --client-home)
        mapping="${ARGS[$((i+1))]:?--client-home requires EMAIL=PATH}"
        if [[ "$mapping" == *=* ]]; then
          email="${mapping%%=*}"
          path="${mapping#*=}"
          if [[ -n "$email" && -n "$path" ]]; then
            if [[ "$path" != /* ]]; then
              echo "[dev-live] WARN: --client-home path should be absolute: '$path'" >&2
            fi
            CLIENT_HOME_EMAILS+=("$email")
            CLIENT_HOME_PATHS+=("$path")
          fi
        else
          echo "[dev-live] WARN: ignoring invalid --client-home value '$mapping'" >&2
        fi
        i=$((i + 2))
        ;;
      --path)
        SANDBOX_DIR="${ARGS[$((i+1))]:?--path requires a directory}"
        i=$((i + 2))
        ;;
      --stop)
        STOP_ONLY=1
        i=$((i + 1))
        ;;
      --first-run)
        FIRST_RUN=1
        i=$((i + 1))
        ;;
      --reset)
        i=$((i + 1))
        ;;
      *)
        i=$((i + 1))
        ;;
    esac
  done
}

validate_client_setup() {
  local email="$1"
  local home="$2"

  if [[ -z "$home" ]]; then
    echo "[dev-live] ERROR: empty client home for $email" >&2
    return 1
  fi
  if [[ ! -d "$home" ]]; then
    echo "[dev-live] ERROR: client home does not exist for $email: $home" >&2
    return 1
  fi
  if [[ ! -f "$home/config.yaml" ]]; then
    echo "[dev-live] ERROR: missing config.yaml for $email at $home/config.yaml" >&2
    return 1
  fi
  if [[ ! -f "$home/syftbox/config.json" ]]; then
    echo "[dev-live] ERROR: missing syftbox config for $email at $home/syftbox/config.json" >&2
    return 1
  fi
  return 0
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
  echo "[live] Building BioVault CLI (cargo build --release)..."
  (cd "$BIOVAULT_DIR/cli" && cargo build --release)
}

start_vite() {
  echo "[live] Starting Vite dev server..."
  (
    cd "$ROOT_DIR/ui"
    npm run dev -- --port 1420 2>&1 | while read -r line; do
      echo "[VITE] $line"
    done
  ) &
  VITE_PID=$!
  write_state

  echo "[live] Waiting for Vite..."
  for _ in {1..30}; do
    if curl -s http://localhost:1420 >/dev/null 2>&1; then
      echo "[live] Vite ready on :1420"
      return 0
    fi
    sleep 1
  done
  echo "[live] ERROR: Vite did not start" >&2
  exit 1
}

start_embedded_client() {
  local email="$1"
  local client_dir
  client_dir="$(resolve_client_dir "$email")"
  local config_yaml="$client_dir/config.yaml"
  local syftbox_config="$client_dir/syftbox/config.json"

  if [[ ! -f "$config_yaml" ]]; then
    echo "[live] Skipping syftboxd start for $email (missing config.yaml; complete onboarding first)"
    return
  fi

  echo "[live] Starting embedded syftboxd for $email"
  if BIOVAULT_HOME="$client_dir" \
    SYFTBOX_DATA_DIR="$client_dir" \
    SYFTBOX_CONFIG_PATH="$syftbox_config" \
    SBC_VAULT="$client_dir/.sbc" \
    SYFTBOX_EMAIL="$email" \
    SYFTBOX_SERVER_URL="$SYFTBOX_URL" \
    SYFTBOX_AUTH_ENABLED="$SYFTBOX_AUTH_ENABLED" \
    BV_SYFTBOX_BACKEND=embedded \
    "$BV_CLI_BIN" syftboxd start; then
    SYFTBOXD_STARTED_EMAILS+=("$email")
    SYFTBOXD_STARTED_HOMES+=("$client_dir")
    write_state
  else
    echo "[live] WARN: syftboxd failed to start for $email (check config/auth/env)" >&2
  fi
}

stop_embedded_client() {
  local email="$1"
  local client_dir="$2"
  local syftbox_config="$client_dir/syftbox/config.json"

  if [[ ! -f "$syftbox_config" ]]; then
    return
  fi

  BIOVAULT_HOME="$client_dir" \
    SYFTBOX_DATA_DIR="$client_dir" \
    SYFTBOX_CONFIG_PATH="$syftbox_config" \
    SBC_VAULT="$client_dir/.sbc" \
    SYFTBOX_EMAIL="$email" \
    SYFTBOX_SERVER_URL="$SYFTBOX_URL" \
    SYFTBOX_AUTH_ENABLED="$SYFTBOX_AUTH_ENABLED" \
    BV_SYFTBOX_BACKEND=embedded \
    "$BV_CLI_BIN" syftboxd stop >/dev/null 2>&1 || true
}

stop_requested_clients() {
  local -a targets=("${CLIENTS[@]:-}")
  if ((${#targets[@]} == 0)); then
    if (( NUM_CLIENTS == 1 )); then
      targets=("$DEFAULT_CLIENT1")
    else
      targets=("$DEFAULT_CLIENT1" "$DEFAULT_CLIENT2")
    fi
  fi

  local email
  for email in "${targets[@]}"; do
    local client_dir
    client_dir="$(resolve_client_dir "$email")"
    stop_embedded_client "$email" "$client_dir"
  done
}

launch_instance() {
  local home="$1"; shift
  local tag="$1"; shift
  local email="$1"; shift

  echo "[live] Launching BioVault ($tag) with BIOVAULT_HOME=$home email=$email" >&2

  (
    cd "$ROOT_DIR/src-tauri"
    env \
      -u SYFTBOX_BINARY -u SYFTBOX_VERSION \
      "BIOVAULT_HOME=$home" \
      "BIOVAULT_DEV_MODE=1" \
      "BIOVAULT_DEV_SYFTBOX=1" \
      "BV_SYFTBOX_BACKEND=embedded" \
      "SYFTBOX_SERVER_URL=$SYFTBOX_URL" \
      "SYFTBOX_EMAIL=$email" \
      "SYFTBOX_AUTH_ENABLED=$SYFTBOX_AUTH_ENABLED" \
      "SYFTBOX_CONFIG_PATH=$home/syftbox/config.json" \
      "SYFTBOX_DATA_DIR=$home" \
      "SBC_VAULT=$home/.sbc" \
      "BIOVAULT_DEBUG_BANNER=1" \
      bunx tauri dev --config '{"build": {"devUrl": "http://localhost:1420", "frontendDist": "../ui/build"}}'
  ) &

  APP_PIDS+=("$!")
  write_state
}

launch_fresh_instance() {
  local tag="$1"
  echo "[live] Launching BioVault ($tag) in first-run mode" >&2
  (
    cd "$ROOT_DIR/src-tauri"
    env \
      -u BIOVAULT_HOME \
      -u SYFTBOX_EMAIL \
      -u SYFTBOX_CONFIG_PATH \
      -u SYFTBOX_DATA_DIR \
      -u SBC_VAULT \
      -u SYC_VAULT \
      BV_SYFTBOX_BACKEND=embedded \
      SYFTBOX_SERVER_URL="$SYFTBOX_URL" \
      SYFTBOX_AUTH_ENABLED="$SYFTBOX_AUTH_ENABLED" \
      bunx tauri dev --config '{"build": {"devUrl": "http://localhost:1420", "frontendDist": "../ui/build"}}'
  ) &
  APP_PIDS+=("$!")
  write_state
}

cleanup() {
  [[ -n "$VITE_PID" ]] && kill "$VITE_PID" 2>/dev/null || true
  for pid in "${APP_PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  local i
  for i in "${!SYFTBOXD_STARTED_EMAILS[@]}"; do
    stop_embedded_client "${SYFTBOXD_STARTED_EMAILS[$i]}" "${SYFTBOXD_STARTED_HOMES[$i]}"
  done
  clear_state
}

trap cleanup EXIT INT TERM

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--num-clients)
      if [[ $# -lt 2 ]]; then
        echo "Error: $1 requires a value" >&2
        exit 1
      fi
      NUM_CLIENTS="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: ./dev-live.sh [-n NUM_CLIENTS] [--skip-auth|--auth] [--provision-clients|--first-run] [args...]

Options:
  -n, --num-clients N   Number of clients to launch (supported: 1 or 2)
  --skip-auth           Set SYFTBOX_AUTH_ENABLED=0 for this run
  --auth                Set SYFTBOX_AUTH_ENABLED=1 for this run
  --provision-clients   Pre-create/use client dirs (default)
  --first-run           Launch without preconfigured client home/env
  -h, --help            Show this help

Extra args:
  --client EMAIL
  --clients a,b
  --client-home EMAIL=/abs/path
  --path DIR
  --stop
USAGE
      exit 0
      ;;
    --skip-auth)
      AUTH_OVERRIDE=0
      shift
      ;;
    --auth)
      AUTH_OVERRIDE=1
      shift
      ;;
    --provision-clients)
      PROVISION_CLIENTS=1
      shift
      ;;
    --first-run)
      PROVISION_CLIENTS=0
      FIRST_RUN=1
      shift
      ;;
    --reset)
      RESET_FLAG=1
      ARGS+=("$1")
      shift
      ;;
    --stop)
      STOP_ONLY=1
      ARGS+=("$1")
      shift
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

if ! [[ "$NUM_CLIENTS" =~ ^[0-9]+$ ]]; then
  echo "Error: --num-clients must be a positive integer (got: $NUM_CLIENTS)" >&2
  exit 1
fi
if (( NUM_CLIENTS < 1 || NUM_CLIENTS > 2 )); then
  echo "Error: unsupported --num-clients value '$NUM_CLIENTS' (supported: 1 or 2)" >&2
  exit 1
fi

if [[ -n "$AUTH_OVERRIDE" ]]; then
  SYFTBOX_AUTH_ENABLED="$AUTH_OVERRIDE"
fi

if (( RESET_FLAG )); then
  clear_profiles_store_on_reset
fi

if (( PROVISION_CLIENTS && RESET_FLAG )) && ! has_client_args; then
  echo "[dev-live] --reset with no explicit clients; falling back to --first-run." >&2
  PROVISION_CLIENTS=0
  FIRST_RUN=1
fi

if (( STOP_ONLY )); then
  cleanup_previous_run_from_state
  parse_runtime_args
  stop_requested_clients
  cleanup
  exit 0
fi

cleanup_previous_run_from_state

if (( PROVISION_CLIENTS && ! RESET_FLAG )) && ! has_client_args; then
  if ! prompt_for_profiles "$NUM_CLIENTS"; then
    echo "[dev-live] No profiles selected/available; falling back to --first-run." >&2
    PROVISION_CLIENTS=0
    FIRST_RUN=1
  fi
fi

if (( ! PROVISION_CLIENTS )); then
  FIRST_RUN=1
fi

parse_runtime_args

if (( STOP_ONLY )); then
  stop_requested_clients
  cleanup
  exit 0
fi

if (( FIRST_RUN )); then
  CLIENTS=()
fi

if (( ! FIRST_RUN )) && ((${#CLIENTS[@]} == 0)); then
  if (( NUM_CLIENTS == 1 )); then
    CLIENTS=("$DEFAULT_CLIENT1")
  else
    CLIENTS=("$DEFAULT_CLIENT1" "$DEFAULT_CLIENT2")
  fi
fi

if (( ! FIRST_RUN )) && (( NUM_CLIENTS == 1 )) && ((${#CLIENTS[@]} > 1)); then
  CLIENTS=("${CLIENTS[0]}")
fi

if (( ! FIRST_RUN )) && (( NUM_CLIENTS == 2 )) && ((${#CLIENTS[@]} < 2)); then
  echo "Error: --num-clients 2 requires two clients" >&2
  exit 1
fi

if (( ! FIRST_RUN )); then
  for email in "${CLIENTS[@]}"; do
    client_home="$(resolve_client_dir "$email")"
    validate_client_setup "$email" "$client_home" || exit 1
  done
fi

build_syftbox_rust
ensure_cli
start_vite

if (( FIRST_RUN )); then
  if (( NUM_CLIENTS == 1 )); then
    launch_fresh_instance "client"
    echo "[live] client PID: ${APP_PIDS[0]}"
  else
    launch_fresh_instance "client1"
    launch_fresh_instance "client2"
    echo "[live] client1 PID: ${APP_PIDS[0]}"
    echo "[live] client2 PID: ${APP_PIDS[1]}"
  fi
  wait
  exit 0
fi

for email in "${CLIENTS[@]}"; do
  start_embedded_client "$email"
done

if (( NUM_CLIENTS == 1 )); then
  c0="${CLIENTS[0]}"
  d0="$(resolve_client_dir "$c0")"
  launch_instance "$d0" "client" "$c0"
  echo "[live] client PID: ${APP_PIDS[0]}"
else
  c0="${CLIENTS[0]}"
  c1="${CLIENTS[1]}"
  d0="$(resolve_client_dir "$c0")"
  d1="$(resolve_client_dir "$c1")"
  launch_instance "$d0" "client1" "$c0"
  launch_instance "$d1" "client2" "$c1"
  echo "[live] client1 PID: ${APP_PIDS[0]}"
  echo "[live] client2 PID: ${APP_PIDS[1]}"
fi

wait
