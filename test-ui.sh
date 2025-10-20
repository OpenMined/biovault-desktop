#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${UI_PORT:-8082}"
MAX_PORT=8092

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

info "Starting static server on port ${PORT}"
pushd "$ROOT_DIR/src" >/dev/null
python3 -m http.server "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
popd >/dev/null

cleanup() {
	info "Stopping static server"
	kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in {1..40}; do
	if curl -sf "http://localhost:${PORT}" >/dev/null 2>&1; then
		break
	fi
	sleep 0.25
done

info "Running Playwright tests"
if ((${#FORWARD_ARGS[@]} == 0)); then
    UI_PORT="$PORT" UI_BASE_URL="http://localhost:${PORT}" bun run test:ui
else
    UI_PORT="$PORT" UI_BASE_URL="http://localhost:${PORT}" bun run test:ui "${FORWARD_ARGS[@]}"
fi
