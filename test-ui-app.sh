#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${UI_PORT:-8082}"
MAX_PORT=8092
LOG_FILE="${UNIFIED_LOG_FILE:-$ROOT_DIR/logs/unified-ui-app.log}"
LOG_PORT="${UNIFIED_LOG_PORT:-9753}"
TAURI_LOG="/tmp/tauri-dev-test.log"
mkdir -p "$(dirname "$LOG_FILE")"
: >"$LOG_FILE"

declare -a FORWARD_ARGS=()
INTERACTIVE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        -i|--interactive)
            INTERACTIVE=1
            ;;
        *)
            FORWARD_ARGS+=("$1")
            ;;
    esac
    shift
done

info() { printf "\033[1;34m[ui-app-test]\033[0m %s\n" "$1"; }

if [[ "${INTERACTIVE}" -eq 1 ]]; then
    info "Interactive mode enabled (headed browser)"
    export PLAYWRIGHT_HEADLESS=false
    export PLAYWRIGHT_SLOWMO="${PLAYWRIGHT_SLOWMO:-100}"
    export INTERACTIVE_MODE=1
fi

# Allow opting out of repeated browser downloads
if [[ "${SKIP_PLAYWRIGHT_INSTALL:-0}" != "1" ]]; then
	info "Ensuring Playwright Chromium browser is installed"
	npx playwright install --with-deps chromium >/dev/null
fi

# Find an available port if the requested one is taken
while lsof -Pi ":${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; do
    if [[ "${PORT}" -ge "${MAX_PORT}" ]]; then
        echo "No available port between ${UI_PORT:-8082} and ${MAX_PORT}" >&2
        exit 1
    fi
    PORT=$((PORT + 1))
    info "Port in use, trying ${PORT}"
done

export UI_PORT="${PORT}"

info "Starting unified logger on port ${LOG_PORT} (file: ${LOG_FILE})"
UNIFIED_LOG_WS_URL="ws://localhost:${LOG_PORT}"
UNIFIED_LOG_STDOUT=${UNIFIED_LOG_STDOUT:-0}
node "$ROOT_DIR/tests/unified-logger.js" "$LOG_FILE" "$LOG_PORT" >/dev/null 2>&1 &
LOGGER_PID=$!

# Force rebuild biovault dependency
info "Force rebuilding biovault dependency"
cd "$ROOT_DIR/src-tauri"
cargo clean -p biovault >/dev/null 2>&1
cd "$ROOT_DIR"

# Set up BioVault configuration
BIOVAULT_DIR="${BIOVAULT_DIR:-$ROOT_DIR/biovault}"
BV_PATH="$BIOVAULT_DIR/bv"
if [ -n "${BIOVAULT_CONFIG:-}" ]; then
    export BIOVAULT_HOME="$BIOVAULT_CONFIG"
else
    # Default to Desktop/BioVault for desktop app consistency
    export BIOVAULT_HOME="$HOME/Desktop/BioVault"
fi
mkdir -p "$BIOVAULT_HOME"
export BIOVAULT_PATH="$BV_PATH"

# Enable WebSocket bridge for browser mode
export DEV_WS_BRIDGE=1
export DEV_WS_BRIDGE_PORT="${DEV_WS_BRIDGE_PORT:-3333}"

info "Starting Tauri dev server with WebSocket bridge"
info "Tauri logs: $TAURI_LOG"
npm run dev > "$TAURI_LOG" 2>&1 &
TAURI_PID=$!

# Wait for WebSocket server to be ready
info "Waiting for WebSocket server (port 3333)"
WS_READY=0
MAX_WS_WAIT=300
for ((i = 1; i <= MAX_WS_WAIT; i++)); do
    if ! kill -0 "$TAURI_PID" >/dev/null 2>&1; then
        echo "❌ Tauri dev server exited before WebSocket was ready" >&2
        echo "Check logs: tail -f $TAURI_LOG" >&2
        exit 1
    fi

    if lsof -Pi :3333 -sTCP:LISTEN -t >/dev/null 2>&1; then
        info "WebSocket server ready"
        WS_READY=1
        break
    fi

    if ((i % 30 == 0)); then
        info "Still waiting for WebSocket server... (${i}s elapsed)"
    fi

    sleep 1
done

if [[ "$WS_READY" -ne 1 ]]; then
    echo "❌ WebSocket server not ready after ${MAX_WS_WAIT}s" >&2
    echo "Check logs: tail -f $TAURI_LOG" >&2
    exit 1
fi

info "Starting static server on port ${PORT}"
pushd "$ROOT_DIR/src" >/dev/null
python3 -m http.server "$PORT" >>"$LOG_FILE" 2>&1 &
SERVER_PID=$!
popd >/dev/null

cleanup() {
    info "Stopping static server"
    kill "$SERVER_PID" 2>/dev/null || true
    info "Stopping Tauri dev server"
    kill "$TAURI_PID" 2>/dev/null || true
    if [[ -n "${LOGGER_PID:-}" ]]; then
        info "Stopping unified logger"
        kill "$LOGGER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

for _ in {1..40}; do
	if curl -sf "http://localhost:${PORT}" >/dev/null 2>&1; then
		break
	fi
	sleep 0.25
done

info "Running Playwright tests with real Tauri backend"
export UNIFIED_LOG_WS="$UNIFIED_LOG_WS_URL"
export USE_REAL_INVOKE=true

if ((${#FORWARD_ARGS[@]} == 0)); then
    UI_PORT="$PORT" UI_BASE_URL="http://localhost:${PORT}" npm run test:ui | tee -a "$LOG_FILE"
else
    UI_PORT="$PORT" UI_BASE_URL="http://localhost:${PORT}" npm run test:ui -- "${FORWARD_ARGS[@]}" | tee -a "$LOG_FILE"
fi
