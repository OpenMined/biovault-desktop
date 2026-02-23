#!/usr/bin/env bash
set -euo pipefail

# Live launcher wrapper.
# Defaults to single-client mode.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NUM_CLIENTS=1
AUTH_OVERRIDE=""
PROVISION_CLIENTS=1
RESET_FLAG=0
ARGS=()

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

prompt_for_profiles() {
  local count="$1"
  local store
  store="$(profiles_store_path)"

  if [[ ! -f "$store" ]]; then
    echo "[dev-live] Profiles store not found at $store; using defaults." >&2
    return 0
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
    echo "[dev-live] Failed to read profiles store; using defaults." >&2
    return 0
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
    echo "[dev-live] Only found ${#emails[@]} profile(s) with email; using defaults." >&2
    return 0
  fi

  if [[ ! -t 0 ]]; then
    echo "[dev-live] Non-interactive terminal; using defaults." >&2
    return 0
  fi

  local -a selected=()
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
      echo "[dev-live] No profiles selected; using defaults." >&2
      return 0
    fi

    while IFS=$'\t' read -r email _; do
      [[ -n "${email:-}" ]] && selected+=("$email")
    done <<< "$selection"

    if ((${#selected[@]} != count)); then
      echo "[dev-live] Please select exactly $count profile(s); got ${#selected[@]}." >&2
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
        local dup=0
        for existing in "${selected[@]-}"; do
          if [[ "$existing" == "$chosen" ]]; then
            dup=1
            break
          fi
        done
        if (( dup )); then
          echo "Profile already selected. Choose a different one."
          continue
        fi
        selected+=("$chosen")
        break
      done
    done
  fi

  for chosen in "${selected[@]}"; do
    ARGS+=(--client "$chosen")
  done
}

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
      cat <<'EOF'
Usage: ./dev-live.sh [-n NUM_CLIENTS] [--skip-auth|--auth] [--provision-clients|--first-run] [args...]

Options:
  -n, --num-clients N   Number of clients to launch (supported: 1 or 2)
  --skip-auth           Set SYFTBOX_AUTH_ENABLED=0 for this run
  --auth                Set SYFTBOX_AUTH_ENABLED=1 for this run
  --provision-clients   Pre-create/use client dirs (default)
  --first-run           Launch without preconfigured client home/env
  -h, --help            Show this help

Examples:
  ./dev-live.sh
  ./dev-live.sh -n 2
  ./dev-live.sh --skip-auth
  ./dev-live.sh --first-run
  ./dev-live.sh -n 2 --reset
EOF
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
      shift
      ;;
    --reset)
      RESET_FLAG=1
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

case "$NUM_CLIENTS" in
  1)
    if (( PROVISION_CLIENTS && ! RESET_FLAG )) && ! has_client_args; then
      prompt_for_profiles "$NUM_CLIENTS"
    fi
    if (( ! PROVISION_CLIENTS )); then
      ARGS=(--first-run "${ARGS[@]}")
    fi
    if [[ -n "$AUTH_OVERRIDE" ]]; then
      exec env SYFTBOX_AUTH_ENABLED="$AUTH_OVERRIDE" "$ROOT_DIR/dev-new-ui.sh" --live "${ARGS[@]}"
    fi
    exec "$ROOT_DIR/dev-new-ui.sh" --live "${ARGS[@]}"
    ;;
  2)
    if (( PROVISION_CLIENTS && ! RESET_FLAG )) && ! has_client_args; then
      prompt_for_profiles "$NUM_CLIENTS"
    fi
    if (( ! PROVISION_CLIENTS )); then
      ARGS=(--first-run "${ARGS[@]}")
    fi
    if [[ -n "$AUTH_OVERRIDE" ]]; then
      exec env SYFTBOX_AUTH_ENABLED="$AUTH_OVERRIDE" "$ROOT_DIR/dev-two-live.sh" "${ARGS[@]}"
    fi
    exec "$ROOT_DIR/dev-two-live.sh" "${ARGS[@]}"
    ;;
  *)
    echo "Error: unsupported --num-clients value '$NUM_CLIENTS' (supported: 1 or 2)" >&2
    exit 1
    ;;
esac
