#!/bin/bash
set -euo pipefail

# Launch multiple BioVault.app instances with separate home dirs for multiparty testing.
#
# Usage:
#   ./biovault-app.sh --emails user1@openmined.org,user2@openmined.org,user3@openmined.org ./test-run
#   ./biovault-app.sh --emails a@x.com,b@x.com,c@x.com ~/BioVaultTest
#   ./biovault-app.sh --stop  # kill all instances
#
# Each email gets its own BIOVAULT_HOME under the given path.
# Each instance gets unique ports for SyftBox, WS bridge, and HTTP bridge.
# The window title includes the email so you can tell them apart.

APP_BIN="${APP_BIN:-/Applications/BioVault.app/Contents/MacOS/bv-desktop}"
APP_PIDS=()
SED_PIDS=()

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

usage() {
  cat <<EOF
Usage: $0 --emails email1,email2,... <path>
       $0 --stop

Options:
  --emails CSV    Comma-separated list of emails (one BioVault instance per email)
  --stop          Kill all running bv-desktop instances launched by this script
  -h, --help      Show this help

Environment:
  APP_BIN         Path to bv-desktop binary (default: /Applications/BioVault.app/Contents/MacOS/bv-desktop)

Example:
  $0 --emails alice@openmined.org,bob@openmined.org,carol@openmined.org ./multiparty-test
EOF
}

cleanup() {
  echo -e "\n${YELLOW}Shutting down all BioVault instances...${NC}"
  # Kill the actual bv-desktop processes first
  for pid in "${APP_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  sleep 2
  # Force kill any that didn't exit gracefully
  for pid in "${APP_PIDS[@]}"; do
    kill -9 "$pid" 2>/dev/null || true
  done
  # Clean up sed processes
  for pid in "${SED_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo -e "${GREEN}All instances stopped.${NC}"
  exit 0
}

if [[ $# -eq 0 ]]; then
  usage
  exit 1
fi

EMAILS=""
BASE_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --emails)
      [[ -z "${2:-}" ]] && { echo "Error: --emails requires a CSV value"; exit 1; }
      EMAILS="$2"
      shift 2
      ;;
    --stop)
      mapfile -t pids < <(pgrep -f -- "$APP_BIN" || true)
      if [[ ${#pids[@]} -eq 0 ]]; then
        echo "No matching processes found for APP_BIN=$APP_BIN"
      else
        kill "${pids[@]}" 2>/dev/null || true
        sleep 1
        mapfile -t remaining < <(pgrep -f -- "$APP_BIN" || true)
        if [[ ${#remaining[@]} -gt 0 ]]; then
          kill -9 "${remaining[@]}" 2>/dev/null || true
        fi
        echo "Stopped ${#pids[@]} process(es) for APP_BIN=$APP_BIN"
      fi
      exit 0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
    *)
      BASE_PATH="$1"
      shift
      ;;
  esac
done

if [[ -z "$EMAILS" ]]; then
  echo "Error: --emails is required"
  usage
  exit 1
fi

if [[ -z "$BASE_PATH" ]]; then
  echo "Error: path argument is required"
  usage
  exit 1
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo -e "${RED}bv-desktop not found at $APP_BIN${NC}"
  echo "Set APP_BIN to a valid executable path."
  exit 1
fi

IFS=',' read -ra EMAIL_LIST <<< "$EMAILS"

if [[ ${#EMAIL_LIST[@]} -lt 1 ]]; then
  echo "Error: at least one email is required"
  exit 1
fi

BASE_PATH="$(cd "$(dirname "$BASE_PATH")" 2>/dev/null && pwd)/$(basename "$BASE_PATH")"
mkdir -p "$BASE_PATH"

# Pick a random base port in the ephemeral range to avoid collisions with other services.
# Each instance uses 3 consecutive ports: syftbox, ws-bridge, http-bridge.
RAND_BASE=$((49152 + RANDOM % 10000))
# Align to 10-port boundary per instance for readability
RAND_BASE=$((RAND_BASE / 10 * 10))

trap cleanup INT TERM EXIT

echo -e "${CYAN}══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  BioVault Multiparty Launcher (${#EMAIL_LIST[@]} instances)${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}Binary:${NC} $APP_BIN"
echo -e "${YELLOW}Base path:${NC} $BASE_PATH"
echo ""

for i in "${!EMAIL_LIST[@]}"; do
  email="${EMAIL_LIST[$i]}"
  home_dir="$BASE_PATH/$email"
  env_home="$home_dir/.env-home"
  xdg_config_home="$env_home/.config"
  xdg_cache_home="$env_home/.cache"
  xdg_data_home="$env_home/.local/share"
  xdg_state_home="$env_home/.local/state"
  tmp_dir="$env_home/tmp"
  mkdir -p "$home_dir"
  mkdir -p "$xdg_config_home" "$xdg_cache_home" "$xdg_data_home" "$xdg_state_home" "$tmp_dir"

  # Each instance gets 3 unique ports, spaced by 10 per instance
  offset=$((i * 10))
  syftbox_port=$((RAND_BASE + offset))
  ws_bridge_port=$((RAND_BASE + offset + 1))
  http_bridge_port=$((RAND_BASE + offset + 2))

  echo -e "${GREEN}[$((i+1))]${NC} $email"
  echo -e "    Home:        $home_dir"
  echo -e "    Env HOME:    $env_home"
  echo -e "    SyftBox:     http://127.0.0.1:$syftbox_port"
  echo -e "    WS bridge:   $ws_bridge_port"
  echo -e "    HTTP bridge: $http_bridge_port"

  # Launch bv-desktop directly (no pipeline) so we capture the real PID.
  # Use process substitution for log prefixing instead of piping through sed.
  env -i \
    HOME="$HOME" \
    USER="$USER" \
    PATH="$PATH" \
    SHELL="$SHELL" \
    TMPDIR="$tmp_dir" \
    XDG_CONFIG_HOME="$xdg_config_home" \
    XDG_CACHE_HOME="$xdg_cache_home" \
    XDG_DATA_HOME="$xdg_data_home" \
    XDG_STATE_HOME="$xdg_state_home" \
    DISPLAY="${DISPLAY:-}" \
    TERM="${TERM:-xterm-256color}" \
    LANG="${LANG:-en_US.UTF-8}" \
    BIOVAULT_HOME="$home_dir" \
    BIOVAULT_PROFILES_DIR="$home_dir/.bvprofiles" \
    BIOVAULT_DISABLE_PROFILES=1 \
    BIOVAULT_WINDOW_TITLE="BioVault — $email" \
    SYFTBOX_EMAIL="$email" \
    SYFTBOX_DATA_DIR="$home_dir" \
    SYFTBOX_CLIENT_URL="http://127.0.0.1:$syftbox_port" \
    DEV_WS_BRIDGE_PORT="$ws_bridge_port" \
    DEV_WS_BRIDGE_HTTP_PORT="$http_bridge_port" \
    "$APP_BIN" > >(sed "s/^/[$email] /") 2>&1 &
  APP_PIDS+=($!)

  # Also track the sed PID for cleanup
  SED_PIDS+=($(jobs -p | tail -1))

  sleep 2
done

echo ""
echo -e "${CYAN}All ${#EMAIL_LIST[@]} instances launched. Press Ctrl+C to stop all.${NC}"
echo ""

# Wait for all app processes; cleanup trap fires on Ctrl+C
wait "${APP_PIDS[@]}" 2>/dev/null || true
