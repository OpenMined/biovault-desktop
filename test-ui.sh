#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${UI_PORT:-8082}"
MAX_PORT=8092
LOG_FILE="${UNIFIED_LOG_FILE:-$ROOT_DIR/logs/unified-ui.log}"
LOG_PORT="${UNIFIED_LOG_PORT:-9753}"
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

info() { printf "\033[1;34m[ui-test]\033[0m %s\n" "$1"; }

if [[ "${INTERACTIVE}" -eq 1 ]]; then
    info "Interactive mode enabled (headed browser)"
    export PLAYWRIGHT_HEADLESS=false
    export PLAYWRIGHT_SLOWMO="${PLAYWRIGHT_SLOWMO:-100}"
fi

# Allow opting out of repeated browser downloads
if [[ "${SKIP_PLAYWRIGHT_INSTALL:-0}" != "1" ]]; then
	info "Ensuring Playwright Chromium browser is installed"
	bunx --bun playwright install --with-deps chromium >/dev/null
fi

# Kill any leftover static servers from previous runs on our target ports
for p in $(seq 8082 $MAX_PORT); do
    pid=$(lsof -Pi ":${p}" -sTCP:LISTEN -t 2>/dev/null || true)
    if [[ -n "$pid" ]]; then
        cmd=$(ps -p "$pid" -o comm= 2>/dev/null || true)
        if [[ "$cmd" == *python* ]] || [[ "$cmd" == *node* ]] || [[ "$cmd" == *serve* ]]; then
            info "Killing leftover server on port ${p} (PID $pid, $cmd)"
            kill "$pid" 2>/dev/null || true
            sleep 0.3
        fi
    fi
done

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

info "Starting static server on port ${PORT}"
pushd "$ROOT_DIR/src" >/dev/null
python3 -m http.server --bind 127.0.0.1 "$PORT" >>"$LOG_FILE" 2>&1 &
SERVER_PID=$!
popd >/dev/null

# Verify the server process is still alive after brief startup
sleep 0.5
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Static server failed to start (process exited)" >&2
    exit 1
fi

cleanup() {
    info "Stopping static server"
    kill "$SERVER_PID" 2>/dev/null || true
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

info "Running Playwright tests"
export UNIFIED_LOG_WS="$UNIFIED_LOG_WS_URL"
# Exclude integration tests that require devstack or special setup (use test-scenario.sh for those)
EXCLUDE_PATTERN="@messages-two|@messaging-core-ui|@messaging-sessions|@onboarding-two|@chaos|@pipelines-solo|@jupyter-session|@jupyter-collab"
if ((${#FORWARD_ARGS[@]} == 0)); then
    UI_PORT="$PORT" UI_BASE_URL="http://localhost:${PORT}" bun run test:ui --grep-invert "$EXCLUDE_PATTERN" | tee -a "$LOG_FILE"
else
    UI_PORT="$PORT" UI_BASE_URL="http://localhost:${PORT}" bun run test:ui --grep-invert "$EXCLUDE_PATTERN" "${FORWARD_ARGS[@]}" | tee -a "$LOG_FILE"
fi
