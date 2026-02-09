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

APP_BIN="/Applications/BioVault.app/Contents/MacOS/bv-desktop"
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
      pkill -f "bv-desktop" 2>/dev/null && echo "Stopped bv-desktop processes" || echo "No bv-desktop processes found"
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
  echo -e "${RED}BioVault.app not found at $APP_BIN${NC}"
  echo "Install BioVault.app to /Applications first."
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
echo -e "${YELLOW}Base path:${NC} $BASE_PATH"
echo ""

for i in "${!EMAIL_LIST[@]}"; do
  email="${EMAIL_LIST[$i]}"
  home_dir="$BASE_PATH/$email"
  mkdir -p "$home_dir"

  # Each instance gets 3 unique ports, spaced by 10 per instance
  offset=$((i * 10))
  syftbox_port=$((RAND_BASE + offset))
  ws_bridge_port=$((RAND_BASE + offset + 1))
  http_bridge_port=$((RAND_BASE + offset + 2))

  echo -e "${GREEN}[$((i+1))]${NC} $email"
  echo -e "    Home:        $home_dir"
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
    TMPDIR="${TMPDIR:-/tmp}" \
    DISPLAY="${DISPLAY:-}" \
    TERM="${TERM:-xterm-256color}" \
    LANG="${LANG:-en_US.UTF-8}" \
    BIOVAULT_HOME="$home_dir" \
    BIOVAULT_DISABLE_PROFILES=1 \
    BIOVAULT_WINDOW_TITLE="BioVault — $email" \
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
