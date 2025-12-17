#!/bin/bash
set -euo pipefail

# Scenario runner for multi-app UI+backend tests (e.g., messaging between two clients)
# This mirrors dev-two.sh but drives Playwright specs.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIOVAULT_DIR="$ROOT_DIR/biovault"
DEVSTACK_SCRIPT="$BIOVAULT_DIR/tests/scripts/devstack.sh"
WS_PORT_BASE="${DEV_WS_BRIDGE_PORT_BASE:-3333}"
LOG_FILE="${UNIFIED_LOG_FILE:-$ROOT_DIR/logs/unified-scenario.log}"
LOG_PORT="${UNIFIED_LOG_PORT:-9756}"
UI_PORT="${UI_PORT:-8082}"
MAX_PORT=8092
TRACE=${TRACE:-0}
DEVSTACK_RESET="${DEVSTACK_RESET:-1}"
TIMING="${TIMING:-1}"

# Parse arguments
declare -a FORWARD_ARGS=()
declare -a NOTEBOOK_CONFIGS=()
SCENARIO=""
WARM_CACHE=0  # Set after arg parsing (scenario-dependent default)
WARM_CACHE_SET=0
INTERACTIVE_MODE=0  # Headed browsers for visibility
WAIT_MODE=0  # Keep everything running after test completes

show_usage() {
	cat <<EOF
Usage: ./test-scenario.sh [OPTIONS] [-- PLAYWRIGHT_ARGS...]

Scenario Options (pick one):
  --all                Run all scenarios (default)
  --onboarding         Run onboarding test only
  --messaging          Run onboarding + basic messaging
  --messaging-sessions Run onboarding + comprehensive messaging & sessions
  --messaging-core     Run CLI-based messaging scenario
  --jupyter            Run onboarding + Jupyter session test (single client)
  --jupyter-collab [config1.json config2.json ...]
                       Run two-client Jupyter collaboration tests
                       Accepts multiple notebook config files (runs all in sequence)
  --pipelines-solo     Run pipeline test with synthetic data (single client)

Other Options:
  --interactive, -i    Run with visible browser windows (alias for --headed)
  --headed             Run playwright with headed browser
  --wait               Keep servers running after test completes (for inspection)
  --no-warm-cache      Skip pre-building Jupyter venv cache (default: warm cache)
  --help, -h           Show this help message

Environment Variables (pipelines-solo):
  FORCE_REGEN_SYNTHETIC=1   Force regenerate synthetic data even if it exists
  CLEANUP_SYNTHETIC=1       Remove synthetic data after test (default: keep for reuse)

Examples:
  ./test-scenario.sh                    # Run all scenarios (default, headless)
  ./test-scenario.sh --messaging        # Run just messaging scenario
  ./test-scenario.sh --interactive      # Run all with visible browser
  ./test-scenario.sh --interactive --onboarding  # Run onboarding with visible browser
  ./test-scenario.sh --pipelines-solo   # Run pipeline test with synthetic data
  FORCE_REGEN_SYNTHETIC=1 ./test-scenario.sh --pipelines-solo  # Force regenerate data
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--all)
			SCENARIO="all"
			shift
			;;
		--onboarding)
			SCENARIO="onboarding"
			shift
			;;
		--messaging)
			SCENARIO="messaging"
			shift
			;;
		--messaging-sessions)
			SCENARIO="messaging-sessions"
			shift
			;;
		--messaging-core)
			SCENARIO="messaging-core"
			shift
			;;
		--jupyter)
			SCENARIO="jupyter"
			shift
			;;
		--jupyter-collab)
			SCENARIO="jupyter-collab"
			shift
			# Collect all JSON config files that follow
			NOTEBOOK_CONFIGS=()
			while [[ -n "${1:-}" && "$1" == *.json ]]; do
				NOTEBOOK_CONFIGS+=("$1")
				shift
			done
			;;
		--pipelines-solo)
			SCENARIO="pipelines-solo"
			shift
			;;
		--headed)
			FORWARD_ARGS+=(--headed)
			shift
			;;
		--interactive|-i)
			# Interactive = headed browser (visible windows)
			FORWARD_ARGS+=(--headed)
			INTERACTIVE_MODE=1
			shift
			;;
		--wait)
			# Keep servers running after test completes
			WAIT_MODE=1
			shift
			;;
		--warm-cache)
			WARM_CACHE=1
			WARM_CACHE_SET=1
			shift
			;;
		--no-warm-cache)
			WARM_CACHE=0
			WARM_CACHE_SET=1
			shift
			;;
		--help|-h)
			show_usage
			exit 0
			;;
		--)
			shift
			FORWARD_ARGS+=("$@")
			break
			;;
		-*)
			echo "Unknown option: $1" >&2
			show_usage
			exit 1
			;;
		*)
			# Positional args go to playwright
			FORWARD_ARGS+=("$1")
			shift
			;;
	esac
done

# Default to "all" if no scenario specified
if [[ -z "$SCENARIO" ]]; then
	# Support legacy SCENARIO env var
	SCENARIO="${SCENARIO:-all}"
fi

# Scenario-dependent default: only warm Jupyter cache for Jupyter scenarios unless explicitly overridden.
if [[ "$WARM_CACHE_SET" == "0" ]]; then
	case "$SCENARIO" in
		jupyter|jupyter-collab) WARM_CACHE=1 ;;
		*) WARM_CACHE=0 ;;
	esac
fi

# Default behavior: UI scenarios do onboarding (create keys in-app), so skip devstack biovault bootstrap.
# For CLI/core scenarios, we want the biovault sandbox initialized by devstack (keys/config under .biovault).
DEVSTACK_SKIP_KEYS="${DEVSTACK_SKIP_KEYS:-}"
if [[ -z "${DEVSTACK_SKIP_KEYS}" ]]; then
	if [[ "$SCENARIO" == "messaging-core" ]]; then
		DEVSTACK_SKIP_KEYS=0
	else
		DEVSTACK_SKIP_KEYS=1
	fi
fi

mkdir -p "$(dirname "$LOG_FILE")"
: >"$LOG_FILE"

info() { printf "\033[1;36m[scenario]\033[0m %s\n" "$1"; }

timing_enabled() {
	[[ "$TIMING" == "1" || "$TIMING" == "true" || "$TIMING" == "yes" ]]
}

now_ms() {
	python3 -c 'import time; print(int(time.time() * 1000))'
}

format_ms() {
	local ms="$1"
	if [[ "$ms" -lt 1000 ]]; then
		printf "%dms" "$ms"
	else
		python3 - "$ms" <<'PY'
import sys
ms = int(sys.argv[1])
print(f"{ms/1000:.2f}s")
PY
	fi
}

declare -a TIMER_LABEL_STACK=()
declare -a TIMER_START_STACK=()
declare -a TIMER_SUMMARY=()

SCRIPT_START_MS=""
if timing_enabled; then
	SCRIPT_START_MS="$(python3 -c 'import time; print(int(time.time() * 1000))')"
fi

timer_push() {
	local label="$1"
	[[ -z "$label" ]] && return 0
	if ! timing_enabled; then
		return 0
	fi
	TIMER_LABEL_STACK+=("$label")
	TIMER_START_STACK+=("$(now_ms)")
	info "⏱️  START: $label"
}

timer_pop() {
	if ! timing_enabled; then
		return 0
	fi
	local n="${#TIMER_LABEL_STACK[@]}"
	if [[ "$n" -le 0 ]]; then
		return 0
	fi
	local label="${TIMER_LABEL_STACK[$((n - 1))]}"
	local start_ms="${TIMER_START_STACK[$((n - 1))]}"
	unset 'TIMER_LABEL_STACK[$((n - 1))]'
	unset 'TIMER_START_STACK[$((n - 1))]'
	local end_ms
	end_ms="$(now_ms)"
	local dur_ms=$((end_ms - start_ms))
	TIMER_SUMMARY+=("${label}"$'\t'"${dur_ms}")
	info "⏱️  END:   $label ($(format_ms "$dur_ms"))"
}

# Kill dangling Jupyter processes from this workspace
kill_workspace_jupyter() {
	local count=0
	# Find jupyter/ipykernel processes with this workspace in their path
	while IFS= read -r pid; do
		if [[ -n "$pid" ]]; then
			kill "$pid" 2>/dev/null && ((count++)) || true
		fi
	done < <(pgrep -f "jupyter.*$ROOT_DIR|ipykernel.*$ROOT_DIR" 2>/dev/null || true)
	if [[ "$count" -gt 0 ]]; then
		info "Killed $count dangling Jupyter process(es) from this workspace"
	fi
}

is_port_free() {
	local port="$1"
	python3 - "$port" >/dev/null 2>&1 <<'PY'
import socket, sys
port = int(sys.argv[1])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    s.bind(("127.0.0.1", port))
except OSError:
    sys.exit(1)
finally:
    try:
        s.close()
    except Exception:
        pass
sys.exit(0)
PY
}

pick_free_port() {
	local start="$1"
	local max="${2:-65535}"
	local port="$start"
	while [[ "$port" -le "$max" ]]; do
		if is_port_free "$port"; then
			echo "$port"
			return 0
		fi
		port=$((port + 1))
	done
	return 1
}

pick_ws_port_base() {
	local start="$1"
	local max="${2:-3499}"
	local port="$start"
	while [[ "$port" -lt "$max" ]]; do
		if is_port_free "$port" && is_port_free "$((port + 1))"; then
			echo "$port"
			return 0
		fi
		port=$((port + 1))
	done
	return 1
}

detect_platform() {
	local os arch
	case "$(uname -s)" in
		Darwin) os="macos" ;;
		Linux) os="linux" ;;
		MINGW*|MSYS*|CYGWIN*|Windows_NT) os="windows" ;;
		*) os="unknown" ;;
	esac

	arch="$(uname -m)"
	case "$arch" in
		x86_64|amd64) arch="x86_64" ;;
		arm64|aarch64) arch="aarch64" ;;
		*) arch="unknown" ;;
	esac

	echo "$os" "$arch"
}

find_bundled_uv() {
	local os arch
	read -r os arch <<<"$(detect_platform)"
	local candidate="$ROOT_DIR/src-tauri/resources/bundled/uv/${os}-${arch}/uv"
	if [[ -x "$candidate" ]]; then
		echo "$candidate"
		return 0
	fi
	return 1
}

# Kill any dangling Jupyter processes from previous runs
kill_workspace_jupyter

# Find an available UI port
while ! is_port_free "$UI_PORT"; do
	if [[ "${UI_PORT}" -ge "${MAX_PORT}" ]]; then
		echo "No available port between ${UI_PORT:-8082} and ${MAX_PORT}" >&2
		exit 1
	fi
	UI_PORT=$((UI_PORT + 1))
	info "UI port in use, trying ${UI_PORT}"
done

export UI_PORT
export UI_BASE_URL="http://localhost:${UI_PORT}"
export DISABLE_UPDATER=1
export DEV_WS_BRIDGE=1

WS_PORT_BASE="$(pick_ws_port_base "$WS_PORT_BASE" "${DEV_WS_BRIDGE_PORT_MAX:-3499}" || true)"
if [[ -z "$WS_PORT_BASE" ]]; then
	echo "Could not find two free consecutive WS ports starting at ${DEV_WS_BRIDGE_PORT_BASE:-3333}" >&2
	exit 1
fi
export DEV_WS_BRIDGE_PORT_BASE="$WS_PORT_BASE"

CLIENT1_EMAIL="${CLIENT1_EMAIL:-client1@sandbox.local}"
CLIENT2_EMAIL="${CLIENT2_EMAIL:-client2@sandbox.local}"
SANDBOX_ROOT="${SANDBOX_DIR:-$BIOVAULT_DIR/sandbox}"
SERVER_PID=""
TAURI1_PID=""
TAURI2_PID=""

# Pick a free unified logger port unless explicitly configured
if [[ -n "${UNIFIED_LOG_PORT+x}" ]]; then
	if ! is_port_free "$LOG_PORT"; then
		echo "UNIFIED_LOG_PORT=$LOG_PORT is already in use; choose a different port" >&2
		exit 1
	fi
else
	LOG_PORT_MAX="${UNIFIED_LOG_PORT_MAX:-9856}"
	LOG_PORT="$(pick_free_port "$LOG_PORT" "$LOG_PORT_MAX" || true)"
	if [[ -z "$LOG_PORT" ]]; then
		echo "No available unified logger port between ${UNIFIED_LOG_PORT:-9756} and ${LOG_PORT_MAX}" >&2
		exit 1
	fi
fi

# Start unified logger
info "Starting unified logger on port ${LOG_PORT} (file: ${LOG_FILE})"
UNIFIED_LOG_WS_URL="ws://localhost:${LOG_PORT}"
UNIFIED_LOG_STDOUT=${UNIFIED_LOG_STDOUT:-0}
node "$ROOT_DIR/tests/unified-logger.js" "$LOG_FILE" "$LOG_PORT" >/dev/null 2>&1 &
LOGGER_PID=$!

wait_for_listener() {
	local port="$1"
	local pid="${2:-}"
	local label="${3:-port}"
	local timeout_s="${4:-15}"
	local waited_ms=0
	local max_ms=$((timeout_s * 1000))
	while [[ "$waited_ms" -lt "$max_ms" ]]; do
		if python3 - "$port" >/dev/null 2>&1 <<'PY'
import socket, sys
port = int(sys.argv[1])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(0.2)
try:
    s.connect(("127.0.0.1", port))
except Exception:
    sys.exit(1)
finally:
    try:
        s.close()
    except Exception:
        pass
sys.exit(0)
PY
		then
			return 0
		fi
		if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
			echo "${label} process exited before listening on :${port} (pid=${pid})" >&2
			return 1
		fi
		sleep 0.2
		waited_ms=$((waited_ms + 200))
	done
	return 1
}

wait_for_listener "$LOG_PORT" "$LOGGER_PID" "unified logger" "${UNIFIED_LOG_WAIT_S:-5}" || {
	echo "Unified logger failed to start on :${LOG_PORT}" >&2
	exit 1
}

cleanup() {
	if [[ -n "${SERVER_PID:-}" ]]; then
		info "Stopping static server"
		kill "$SERVER_PID" 2>/dev/null || true
	fi
	if [[ -n "${TAURI1_PID:-}" || -n "${TAURI2_PID:-}" ]]; then
		info "Stopping Tauri instances"
		[[ -n "${TAURI1_PID:-}" ]] && kill "$TAURI1_PID" 2>/dev/null || true
		[[ -n "${TAURI2_PID:-}" ]] && kill "$TAURI2_PID" 2>/dev/null || true
	fi
	if [[ -n "${LOGGER_PID:-}" ]]; then
		info "Stopping unified logger"
		kill "$LOGGER_PID" 2>/dev/null || true
	fi
	# Clean up any Jupyter processes spawned during this run
	kill_workspace_jupyter

	# Close out any in-progress timers so failures still report partial durations.
	if timing_enabled; then
		while [[ "${#TIMER_LABEL_STACK[@]}" -gt 0 ]]; do
			timer_pop
		done
	fi

	# Print timing summary (even on failure) to help spot slow steps.
	if timing_enabled && { [[ "${#TIMER_SUMMARY[@]}" -gt 0 ]] || [[ -n "${SCRIPT_START_MS}" ]]; }; then
		info "=== Timing Summary ==="
		if [[ "${#TIMER_SUMMARY[@]}" -gt 0 ]]; then
			local row label ms
			for row in "${TIMER_SUMMARY[@]}"; do
				label="${row%%$'\t'*}"
				ms="${row##*$'\t'}"
				printf "[timing] %-42s %s\n" "$label" "$(format_ms "$ms")"
			done
		fi
		if [[ -n "${SCRIPT_START_MS}" ]]; then
			local total_ms
			total_ms="$(( $(now_ms) - SCRIPT_START_MS ))"
			printf "[timing] %-42s %s\n" "Total" "$(format_ms "$total_ms")"
		fi
	fi
}
trap cleanup EXIT INT TERM

# Start devstack with two clients (reset by default to avoid stale state)
info "Ensuring SyftBox devstack with two clients (reset=${DEVSTACK_RESET})"
DEVSTACK_CLIENTS="${CLIENT1_EMAIL},${CLIENT2_EMAIL}"
# Stop any existing stack for this sandbox to avoid state conflicts
# Pass --reset to stop if we're resetting, so sandbox gets wiped (including Jupyter venvs)
STOP_ARGS=(--sandbox "$SANDBOX_ROOT" --stop)
if [[ "$DEVSTACK_RESET" == "1" || "$DEVSTACK_RESET" == "true" ]]; then
	STOP_ARGS+=(--reset)
fi
timer_push "Devstack stop"
bash "$DEVSTACK_SCRIPT" "${STOP_ARGS[@]}" >/dev/null 2>&1 || true
timer_pop
DEVSTACK_ARGS=(--clients "$DEVSTACK_CLIENTS" --sandbox "$SANDBOX_ROOT")
if [[ "$DEVSTACK_RESET" == "1" || "$DEVSTACK_RESET" == "true" ]]; then
	DEVSTACK_ARGS+=(--reset)
fi
if [[ "$DEVSTACK_SKIP_KEYS" == "1" || "$DEVSTACK_SKIP_KEYS" == "true" ]]; then
	DEVSTACK_ARGS+=(--skip-keys)
fi
timer_push "Devstack start"
bash "$DEVSTACK_SCRIPT" "${DEVSTACK_ARGS[@]}" >/dev/null
timer_pop

# Read devstack state for client configs
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

STATE_FILE="$(find_state_file || true)"
if [[ -z "$STATE_FILE" ]]; then
	echo "Devstack state not found in $SANDBOX_ROOT" >&2
	exit 1
fi

parse_field() {
	python3 - "$STATE_FILE" "$1" "$2" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
email = sys.argv[2]
field = sys.argv[3]
for c in state.get("clients", []):
    if c.get("email") == email:
        print(c.get(field,""))
        sys.exit(0)
sys.exit(1)
PY
}

CLIENT1_HOME="$(parse_field "$CLIENT1_EMAIL" home_path)"
CLIENT2_HOME="$(parse_field "$CLIENT2_EMAIL" home_path)"
CLIENT1_CFG="$(parse_field "$CLIENT1_EMAIL" config)"
CLIENT2_CFG="$(parse_field "$CLIENT2_EMAIL" config)"
SERVER_URL="$(python3 - "$STATE_FILE" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
print(f"http://127.0.0.1:{state['server']['port']}")
PY
)"

info "Client1 home: $CLIENT1_HOME"
info "Client2 home: $CLIENT2_HOME"
info "Server URL: $SERVER_URL"

wait_for_file() {
	local path="$1"
	local timeout_s="${2:-30}"
	local waited=0
	while [[ "$waited" -lt "$timeout_s" ]]; do
		if [[ -s "$path" ]]; then
			return 0
		fi
		sleep 1
		waited=$((waited + 1))
	done
	return 1
}

preflight_peer_sync() {
	local timeout_s="${DEVSTACK_SYNC_TIMEOUT:-30}"
	# Mirror inbox-ping-pong.yaml: require public key bundles to be visible from both clients.
	local c1_sees_c2="$CLIENT1_HOME/datasites/$CLIENT2_EMAIL/public/crypto/did.json"
	local c2_sees_c1="$CLIENT2_HOME/datasites/$CLIENT1_EMAIL/public/crypto/did.json"
	info "Waiting for peer key sync (timeout=${timeout_s}s)"
	wait_for_file "$c1_sees_c2" "$timeout_s" || {
		echo "Timed out waiting for peer bundle: $c1_sees_c2" >&2
		exit 1
	}
	wait_for_file "$c2_sees_c1" "$timeout_s" || {
		echo "Timed out waiting for peer bundle: $c2_sees_c1" >&2
		exit 1
	}
}

start_static_server_python() {
	# Try to start Python http.server, return 0 on success, 1 on failure
	local port="$1"
	local src_dir="$2"
	local timeout_s="${3:-10}"

	info "[DEBUG] Trying Python http.server on port $port"
	pushd "$src_dir" >/dev/null
	python3 -m http.server --bind 127.0.0.1 "$port" >>"$LOG_FILE" 2>&1 &
	SERVER_PID=$!
	popd >/dev/null

	sleep 0.5
	if ! kill -0 "$SERVER_PID" 2>/dev/null; then
		info "[DEBUG] Python server process died immediately"
		return 1
	fi

	if wait_for_listener "$port" "$SERVER_PID" "python http.server" "$timeout_s" 2>/dev/null; then
		info "[DEBUG] Python http.server is listening"
		return 0
	fi

	# Kill the non-listening process
	kill "$SERVER_PID" 2>/dev/null || true
	SERVER_PID=""
	return 1
}

start_static_server_node() {
	# Try to start Node.js http-server, return 0 on success, 1 on failure
	local port="$1"
	local src_dir="$2"
	local timeout_s="${3:-10}"

	info "[DEBUG] Trying Node.js npx serve on port $port"
	npx --yes serve -l "$port" -s "$src_dir" >>"$LOG_FILE" 2>&1 &
	SERVER_PID=$!

	sleep 1
	if ! kill -0 "$SERVER_PID" 2>/dev/null; then
		info "[DEBUG] Node serve process died immediately"
		return 1
	fi

	if wait_for_listener "$port" "$SERVER_PID" "node serve" "$timeout_s" 2>/dev/null; then
		info "[DEBUG] Node serve is listening"
		return 0
	fi

	# Kill the non-listening process
	kill "$SERVER_PID" 2>/dev/null || true
	SERVER_PID=""
	return 1
}

start_static_server() {
	# Start static server with fallback options
	timer_push "Static server start"
	info "[DEBUG] start_static_server: initial UI_PORT=$UI_PORT"

	# Re-check port availability (may have changed since early check due to devstack startup)
	local port_check_count=0
	while ! is_port_free "$UI_PORT"; do
		if [[ "${UI_PORT}" -ge "${MAX_PORT}" ]]; then
			echo "No available port between 8082 and ${MAX_PORT}" >&2
			exit 1
		fi
		info "UI port ${UI_PORT} now in use, trying $((UI_PORT + 1))"
		UI_PORT=$((UI_PORT + 1))
		port_check_count=$((port_check_count + 1))
	done
	if [[ "$port_check_count" -gt 0 ]]; then
		info "[DEBUG] Had to try $port_check_count additional ports, settled on $UI_PORT"
	fi
	export UI_PORT
	export UI_BASE_URL="http://localhost:${UI_PORT}"

	info "Starting static server on port ${UI_PORT}"
	local src_dir="$ROOT_DIR/src"
	local timeout_s="${STATIC_SERVER_WAIT_S:-10}"

	# Try Python first (faster, no dependencies)
	if start_static_server_python "$UI_PORT" "$src_dir" "$timeout_s"; then
		timer_pop
		info "[DEBUG] Static server (Python) is ready on port $UI_PORT"
		return 0
	fi

	info "[DEBUG] Python http.server failed, trying Node.js fallback..."

	# Try Node.js serve as fallback
	if start_static_server_node "$UI_PORT" "$src_dir" "$timeout_s"; then
		timer_pop
		info "[DEBUG] Static server (Node) is ready on port $UI_PORT"
		return 0
	fi

	# Both failed
	echo "[DEBUG] All static server methods failed on port ${UI_PORT}" >&2
	echo "[DEBUG] Checking port ${UI_PORT} usage:" >&2
	lsof -i ":${UI_PORT}" 2>&1 || echo "(lsof unavailable)" >&2
	if [[ -f "$LOG_FILE" ]]; then
		echo "---- recent unified log (${LOG_FILE}) ----" >&2
		tail -n 120 "$LOG_FILE" >&2 || true
		echo "---- end recent unified log ----" >&2
	fi
	timer_pop
	exit 1
}

assert_tauri_binary_present() {
	TAURI_BINARY="${TAURI_BINARY:-$ROOT_DIR/src-tauri/target/release/bv-desktop}"
	info "[DEBUG] assert_tauri_binary_present: checking $TAURI_BINARY"
	if [[ ! -x "$TAURI_BINARY" ]]; then
		# Binary doesn't exist - auto-build if AUTO_REBUILD_TAURI is enabled (default)
		local auto_rebuild="${AUTO_REBUILD_TAURI:-1}"
		if [[ "$auto_rebuild" != "0" && "$auto_rebuild" != "false" && "$auto_rebuild" != "no" ]]; then
			info "Tauri binary not found, building (cd src-tauri && cargo build --release)..."
			timer_push "Cargo build (tauri release - initial)"
			(cd "$ROOT_DIR/src-tauri" && cargo build --release) >&2
			timer_pop
			# Verify build succeeded
			if [[ ! -x "$TAURI_BINARY" ]]; then
				echo "Build failed: binary still not found at $TAURI_BINARY" >&2
				exit 1
			fi
			info "[DEBUG] Tauri binary built successfully"
			return 0
		fi
		echo "[DEBUG] ERROR: Tauri binary not found or not executable at $TAURI_BINARY" >&2
		echo "[DEBUG] Listing release directory:" >&2
		ls -la "$ROOT_DIR/src-tauri/target/release/" 2>&1 | head -30 || echo "Cannot list directory" >&2
		echo "[DEBUG] Checking if target directory exists:" >&2
		ls -la "$ROOT_DIR/src-tauri/target/" 2>&1 | head -10 || echo "Cannot list target directory" >&2
		echo "Tauri binary not found at $TAURI_BINARY - run 'bun run build' first" >&2
		exit 1
	fi
	info "[DEBUG] Tauri binary found and executable"
}

assert_tauri_binary_fresh() {
	# Guardrail: stale binaries silently break harness assumptions (e.g. env var parsing).
	info "[DEBUG] assert_tauri_binary_fresh: checking if binary is up to date"
	info "[DEBUG] TAURI_BINARY=$TAURI_BINARY"
	info "[DEBUG] Binary mtime: $(stat -f '%Sm' "$TAURI_BINARY" 2>/dev/null || stat -c '%y' "$TAURI_BINARY" 2>/dev/null || echo 'unknown')"

	local newer=""
	local candidates=(
		"$ROOT_DIR/src-tauri/src"
		"$ROOT_DIR/src-tauri/Cargo.toml"
		"$ROOT_DIR/src-tauri/Cargo.lock"
		"$ROOT_DIR/biovault/cli/src"
		"$ROOT_DIR/biovault/cli/Cargo.toml"
		"$ROOT_DIR/biovault/cli/Cargo.lock"
		"$ROOT_DIR/biovault/syftbox-sdk/src"
		"$ROOT_DIR/biovault/syftbox-sdk/Cargo.toml"
	)

	for p in "${candidates[@]}"; do
		if [[ -f "$p" ]]; then
			if [[ "$p" -nt "$TAURI_BINARY" ]]; then
				newer="$p"
				info "[DEBUG] Found newer file: $p"
				break
			fi
		elif [[ -d "$p" ]]; then
			newer="$(find "$p" -type f -newer "$TAURI_BINARY" -print -quit 2>/dev/null || true)"
			if [[ -n "$newer" ]]; then
				info "[DEBUG] Found newer file in directory $p: $newer"
				break
			fi
		fi
	done
	if [[ -n "$newer" ]]; then
		echo "[DEBUG] Tauri binary is older than sources (e.g. $newer)." >&2
		# Default to rebuilding; set AUTO_REBUILD_TAURI=0/false/no to disable.
		local auto_rebuild="${AUTO_REBUILD_TAURI:-1}"
		info "[DEBUG] AUTO_REBUILD_TAURI=$auto_rebuild"
		if [[ "$auto_rebuild" != "0" && "$auto_rebuild" != "false" && "$auto_rebuild" != "no" ]]; then
			echo "Rebuilding (cd src-tauri && cargo build --release)..." >&2
			timer_push "Cargo build (tauri release)"
			(cd "$ROOT_DIR/src-tauri" && cargo build --release) >&2
			timer_pop
			return 0
		fi
		echo "[DEBUG] ERROR: Rebuild required but AUTO_REBUILD_TAURI=$auto_rebuild prevents it" >&2
		echo "Rebuild required: (cd src-tauri && cargo build --release) or 'bun run build'." >&2
		echo "Tip: set AUTO_REBUILD_TAURI=1 to auto-rebuild." >&2
		exit 1
	fi
	info "[DEBUG] Tauri binary is up to date (no newer source files found)"
}

launch_instance() {
	local email="$1"
	local home="$2"
	local cfg="$3"
	local ws_port="$4"
	(
		# Mirror biovault/scripts/run_scenario.py: set HOME and run from the datasite root so
		# relative paths like "datasites/" and "unencrypted/" land under the sandbox client dir.
		export HOME="$home"
		cd "$home" || exit 1

		# messaging-core scenario is designed around biovault sandbox layout under ".biovault"
		# (as used by `biovault/tests/scenarios/messaging-core.yaml`).
		if [[ "$SCENARIO" == "messaging-core" ]]; then
			mkdir -p "$home/.biovault" 2>/dev/null || true
			export BIOVAULT_HOME="$home/.biovault"
		else
			export BIOVAULT_HOME="$home"
		fi
		export BIOVAULT_DEV_MODE=1
		export BIOVAULT_DEV_SYFTBOX=1
		# In devstack mode we don't require OAuth-style SyftBox auth; unlock messages UI.
		export SYFTBOX_AUTH_ENABLED=0
		export SYFTBOX_SERVER_URL="$SERVER_URL"
		export SYFTBOX_EMAIL="$email"
		export SYFTBOX_CONFIG_PATH="$cfg"
		export SYFTBOX_DATA_DIR="$home"
		export SYC_VAULT="$home/.syc"
		export DEV_WS_BRIDGE=1
		export DEV_WS_BRIDGE_PORT="$ws_port"
		export DISABLE_UPDATER=1
		# Skip Jupyter auto-opening browser in non-interactive mode (Playwright controls the browser)
		if [[ "${INTERACTIVE_MODE:-0}" != "1" ]]; then
			export JUPYTER_SKIP_BROWSER=1
		fi
		echo "[scenario] $email: starting bv-desktop (BIOVAULT_HOME=$BIOVAULT_HOME DEV_WS_BRIDGE_PORT=$DEV_WS_BRIDGE_PORT)" >&2
		exec "$TAURI_BINARY"
	) >>"$LOG_FILE" 2>&1 &
	echo $!
}

wait_ws() {
	local port="$1"
	local pid="${2:-}"
	local label="${3:-ws bridge}"
	local timeout_s="${WS_BRIDGE_WAIT_S:-60}"
	local start_ms=""
	if timing_enabled; then
		start_ms="$(now_ms)"
	fi

	if wait_for_listener "$port" "$pid" "$label" "$timeout_s"; then
		if timing_enabled; then
			local end_ms
			end_ms="$(now_ms)"
			info "⏱️  READY: ${label} on :${port} ($(format_ms "$((end_ms - start_ms))"))"
		fi
		return 0
	fi

	echo "Timed out waiting for ${label} to listen on :${port} (timeout=${timeout_s}s)" >&2
	if [[ -f "$LOG_FILE" ]]; then
		echo "---- recent unified log (${LOG_FILE}) ----" >&2
		tail -n 120 "$LOG_FILE" >&2 || true
		echo "---- end recent unified log ----" >&2
	fi
	return 1
}

start_tauri_instances() {
	assert_tauri_binary_present
	assert_tauri_binary_fresh

	# For CLI-based scenarios (messaging-core) where devstack creates keys, ensure sync before UI.
	# For UI scenarios (messaging, onboarding), keys are created during onboarding - skip preflight here.
	if [[ "$SCENARIO" == "messaging-core" ]]; then
		timer_push "Peer key sync (preflight)"
		preflight_peer_sync
		timer_pop
	fi

	timer_push "Tauri instances start"
	info "Launching Tauri for client1 on WS port $WS_PORT_BASE"
	TAURI1_PID=$(launch_instance "$CLIENT1_EMAIL" "$CLIENT1_HOME" "$CLIENT1_CFG" "$WS_PORT_BASE")
	info "Waiting for client1 WS bridge..."
	wait_ws "$WS_PORT_BASE" "$TAURI1_PID" "$CLIENT1_EMAIL" || { echo "WS $WS_PORT_BASE not ready" >&2; exit 1; }

	info "Launching Tauri for client2 on WS port $((WS_PORT_BASE + 1))"
	TAURI2_PID=$(launch_instance "$CLIENT2_EMAIL" "$CLIENT2_HOME" "$CLIENT2_CFG" "$((WS_PORT_BASE + 1))")
	info "Waiting for client2 WS bridge..."
	wait_ws "$((WS_PORT_BASE + 1))" "$TAURI2_PID" "$CLIENT2_EMAIL" || {
		echo "WS $((WS_PORT_BASE + 1)) not ready" >&2
		exit 1
	}

	export UNIFIED_LOG_WS="$UNIFIED_LOG_WS_URL"
	export USE_REAL_INVOKE=true

	info "Client1 UI: ${UI_BASE_URL}?ws=${WS_PORT_BASE}&real=1"
	info "Client2 UI: ${UI_BASE_URL}?ws=$((WS_PORT_BASE + 1))&real=1"
	timer_pop
}

warm_jupyter_cache() {
	# Pre-build the Jupyter venv to warm syftbox-sdk compilation cache.
	# This installs all Python dependencies including syftbox-sdk (which has Rust bindings).
	local cache_dir="$CLIENT1_HOME/sessions/_cache_warmup"
	timer_push "Jupyter cache warmup"
	info "Warming Jupyter venv cache (this may take a few minutes on first run)..."

	mkdir -p "$cache_dir"

	# Use uv to create venv and install packages
	local uv_bin
	uv_bin="$(command -v uv 2>/dev/null || echo "")"
	if [[ -z "$uv_bin" ]]; then
		uv_bin="$(find_bundled_uv 2>/dev/null || echo "")"
	fi
	if [[ -z "$uv_bin" ]]; then
		info "uv not found (PATH or bundled), skipping cache warmup"
		timer_pop
		return 0
	fi

	# Create venv if it doesn't exist
	if [[ ! -d "$cache_dir/.venv" ]]; then
		timer_push "Jupyter cache: create venv"
		info "Creating cache warmup venv..."
		"$uv_bin" venv --python 3.12 "$cache_dir/.venv" >>"$LOG_FILE" 2>&1 || {
			info "Failed to create venv, skipping cache warmup"
			timer_pop
			timer_pop
			return 0
		}
		timer_pop
	fi

	# Get beaver version from __init__.py (same as build.rs does)
	local beaver_version
	beaver_version="$(grep '^__version__' "$ROOT_DIR/biovault/biovault-beaver/python/src/beaver/__init__.py" 2>/dev/null | sed 's/.*"\([^"]*\)".*/\1/' || echo "0.1.26")"

	# Install PyPI packages first
	timer_push "Jupyter cache: pip install (pypi)"
	info "Installing PyPI packages (jupyterlab, biovault-beaver==$beaver_version)..."
	"$uv_bin" pip install --python "$cache_dir/.venv" -U jupyterlab cleon "biovault-beaver[lib-support]==$beaver_version" >>"$LOG_FILE" 2>&1 || true
	timer_pop

	# Install local editable syftbox-sdk if available
	local syftbox_path="$ROOT_DIR/biovault/syftbox-sdk/python"
	if [[ -d "$syftbox_path" ]]; then
		timer_push "Jupyter cache: pip install (syftbox-sdk)"
		info "Installing syftbox-sdk from local source (compiling Rust bindings)..."
		"$uv_bin" pip install --python "$cache_dir/.venv" -e "$syftbox_path" >>"$LOG_FILE" 2>&1 || {
			info "Warning: Failed to install syftbox-sdk from local path"
		}
		timer_pop
	fi

	# Install local editable beaver if available
	local beaver_path="$ROOT_DIR/biovault/biovault-beaver/python"
	if [[ -d "$beaver_path" ]]; then
		timer_push "Jupyter cache: pip install (beaver)"
		info "Installing beaver from local source..."
		"$uv_bin" pip install --python "$cache_dir/.venv" -e "$beaver_path[lib-support]" >>"$LOG_FILE" 2>&1 || {
			info "Warning: Failed to install beaver from local path"
		}
		timer_pop
	fi

	info "Cache warmup complete!"
	timer_pop
}

info "Running Playwright scenario: $SCENARIO"
PLAYWRIGHT_OPTS=()
[[ "$TRACE" == "1" ]] && PLAYWRIGHT_OPTS+=(--trace on)

append_array_items() {
	# Usage: append_array_items <dst_array_name> <src_array_name>
	# Appends elements from src into dst without expanding empty arrays (bash 3.2 + set -u safe).
	local dst_name="$1"
	local src_name="$2"
	eval "local n=\${#${src_name}[@]}"
	local i=0
	while [[ "$i" -lt "$n" ]]; do
		eval "${dst_name}+=(\"\${${src_name}[$i]}\")"
		i=$((i + 1))
	done
}

run_ui_grep() {
	# Usage: run_ui_grep "<grep>" [EXTRA_ENV_KV...]
	# EXTRA_ENV_KV are strings like "INCLUDE_JUPYTER_TESTS=1" that will be passed via `env`.
	local grep_pat="$1"
	shift

	local -a cmd=(env "UI_PORT=$UI_PORT" "UI_BASE_URL=$UI_BASE_URL")
	while [[ $# -gt 0 ]]; do
		cmd+=("$1")
		shift
	done

	cmd+=(bun run test:ui --grep "$grep_pat")
	append_array_items cmd PLAYWRIGHT_OPTS
	append_array_items cmd FORWARD_ARGS

	"${cmd[@]}" | tee -a "$LOG_FILE"
}

sanitize_playwright_args() {
	# If a user accidentally passes an empty --grep-invert pattern, Playwright will exclude everything
	# (empty regex matches all) and report "No tests found". Drop that footgun.
	local -a cleaned=()
	local i=0
	while [[ "$i" -lt "${#FORWARD_ARGS[@]}" ]]; do
		local arg="${FORWARD_ARGS[$i]}"
		if [[ "$arg" == "--grep-invert" ]]; then
			local next="${FORWARD_ARGS[$((i + 1))]:-}"
			# Treat a missing value (end of args) or an immediately-following flag as empty.
			if [[ -z "${next:-}" || "$next" == --* ]]; then
				info "Warning: dropping empty --grep-invert argument"
				i=$((i + 2))
				continue
			fi
		fi
		cleaned+=("$arg")
		i=$((i + 1))
	done

	# Bash 3.2 + `set -u` treats `${arr[@]}` expansion of empty arrays as an error.
	# Rebuild FORWARD_ARGS element-by-element to avoid that footgun.
	FORWARD_ARGS=()
	local j=0
	local n="${#cleaned[@]}"
	while [[ "$j" -lt "$n" ]]; do
		FORWARD_ARGS+=("${cleaned[$j]}")
		j=$((j + 1))
	done
}
sanitize_playwright_args

# Warm cache if requested (useful for first-time Jupyter tests)
if [[ "$WARM_CACHE" == "1" ]]; then
	warm_jupyter_cache
fi

	case "$SCENARIO" in
			onboarding)
				start_static_server
				start_tauri_instances
				timer_push "Playwright: @onboarding-two"
				run_ui_grep "@onboarding-two"
				timer_pop
				;;
			messaging)
				start_static_server
				start_tauri_instances
				# Run onboarding first (creates keys), then wait for peer sync, then messaging
				timer_push "Playwright: @onboarding-two"
				run_ui_grep "@onboarding-two"
				timer_pop
				# After onboarding, keys exist - wait for them to sync via the network
				timer_push "Peer key sync"
				info "Waiting for peer keys to sync after onboarding..."
				preflight_peer_sync
				timer_pop
				timer_push "Playwright: @messages-two"
				run_ui_grep "@messages-two"
				timer_pop
				;;
			messaging-sessions)
				start_static_server
				start_tauri_instances
				# Run onboarding first (creates keys), then wait for peer sync, then comprehensive test
				timer_push "Playwright: @onboarding-two"
				run_ui_grep "@onboarding-two"
				timer_pop
				# After onboarding, keys exist - wait for them to sync via the network
				timer_push "Peer key sync"
				info "Waiting for peer keys to sync after onboarding..."
				preflight_peer_sync
				timer_pop
				# Run comprehensive messaging + sessions test
				timer_push "Playwright: @messaging-sessions"
				run_ui_grep "@messaging-sessions"
				timer_pop
				;;
			all)
				start_static_server
				start_tauri_instances
				# Run onboarding first (creates keys)
				info "=== Phase 1: Onboarding ==="
				timer_push "Playwright: @onboarding-two"
				run_ui_grep "@onboarding-two"
				timer_pop
				# Wait for peer sync
				timer_push "Peer key sync"
				info "Waiting for peer keys to sync after onboarding..."
			preflight_peer_sync
			timer_pop
				# Run basic messaging test
				info "=== Phase 2: Basic Messaging ==="
				timer_push "Playwright: @messages-two"
				run_ui_grep "@messages-two"
				timer_pop
				# Run comprehensive messaging + sessions test
				info "=== Phase 3: Messaging + Sessions ==="
				timer_push "Playwright: @messaging-sessions"
				run_ui_grep "@messaging-sessions"
				timer_pop
				;;
	messaging-core)
		# Reuse the biovault YAML scenario logic (CLI-level) without restarting devstack.
		SCENARIO_SRC="$BIOVAULT_DIR/tests/scenarios/messaging-core.yaml"
		SCENARIO_NO_SETUP="$ROOT_DIR/logs/messaging-core.no-setup.yaml"
		if [[ ! -f "$SCENARIO_SRC" ]]; then
			echo "Missing scenario file: $SCENARIO_SRC" >&2
			exit 1
		fi
		awk '
			BEGIN { in_setup=0 }
			/^setup:/ { in_setup=1; next }
			/^steps:/ { in_setup=0; print; next }
			{ if (!in_setup) print }
		' "$SCENARIO_SRC" >"$SCENARIO_NO_SETUP"

		info "Building BioVault CLI (release) for messaging-core"
		timer_push "Cargo build (biovault cli release)"
		(cd "$BIOVAULT_DIR/cli" && cargo build --release) >>"$LOG_FILE" 2>&1
		timer_pop

		# Give devstack sync a bit more breathing room than the upstream default 30s.
		MESSAGING_CORE_WAIT_TIMEOUT="${MESSAGING_CORE_WAIT_TIMEOUT:-120}"
		python3 - "$SCENARIO_NO_SETUP" "$MESSAGING_CORE_WAIT_TIMEOUT" <<'PY'
import re, sys
path = sys.argv[1]
timeout = int(sys.argv[2])
text = open(path, "r", encoding="utf-8").read().splitlines(True)
out = []
for line in text:
    m = re.match(r"^([ ]*timeout:)[ ]*30[ ]*$", line)
    if m:
        out.append(f"{m.group(1)} {timeout}\n")
    else:
        out.append(line)
open(path, "w", encoding="utf-8").write("".join(out))
PY

		info "Running core messaging scenario via $SCENARIO_NO_SETUP (timeout=${MESSAGING_CORE_WAIT_TIMEOUT}s)"
		timer_push "Core scenario (run_scenario.py)"
		python3 "$BIOVAULT_DIR/scripts/run_scenario.py" "$SCENARIO_NO_SETUP" 2>&1 | tee -a "$LOG_FILE"
		timer_pop

		start_static_server
		start_tauri_instances

			info "Opening UI for inspection"
			timer_push "Playwright: @messaging-core-ui"
			run_ui_grep "@messaging-core-ui"
			timer_pop
			;;
	jupyter)
		info "[DEBUG] Starting jupyter scenario"
		info "[DEBUG] UI_PORT=$UI_PORT UI_BASE_URL=$UI_BASE_URL"
		info "[DEBUG] WS_PORT_BASE=$WS_PORT_BASE"
		info "[DEBUG] CLIENT1_HOME=$CLIENT1_HOME"

		start_static_server
		info "[DEBUG] Static server started successfully on port $UI_PORT"

		# Jupyter test only needs one client
		info "[DEBUG] Checking Tauri binary..."
		TAURI_BINARY="${TAURI_BINARY:-$ROOT_DIR/src-tauri/target/release/bv-desktop}"
		info "[DEBUG] TAURI_BINARY=$TAURI_BINARY"
		if [[ -f "$TAURI_BINARY" ]]; then
			info "[DEBUG] Tauri binary exists, size: $(ls -lh "$TAURI_BINARY" | awk '{print $5}')"
			info "[DEBUG] Tauri binary permissions: $(ls -l "$TAURI_BINARY" | awk '{print $1}')"
		else
			info "[DEBUG] ERROR: Tauri binary does not exist at $TAURI_BINARY"
			ls -la "$ROOT_DIR/src-tauri/target/release/" 2>&1 | head -20 || echo "Cannot list release dir"
		fi

		assert_tauri_binary_present
		info "[DEBUG] assert_tauri_binary_present passed"

		assert_tauri_binary_fresh
		info "[DEBUG] assert_tauri_binary_fresh passed"

		timer_push "Tauri instance start (single)"
		info "Launching Tauri for client1 on WS port $WS_PORT_BASE"
		info "[DEBUG] CLIENT1_EMAIL=$CLIENT1_EMAIL"
		info "[DEBUG] CLIENT1_CFG=$CLIENT1_CFG"

		TAURI1_PID=$(launch_instance "$CLIENT1_EMAIL" "$CLIENT1_HOME" "$CLIENT1_CFG" "$WS_PORT_BASE")
		info "[DEBUG] Tauri launched with PID=$TAURI1_PID"

		# Check if process is still running after launch
		sleep 1
		if kill -0 "$TAURI1_PID" 2>/dev/null; then
			info "[DEBUG] Tauri process $TAURI1_PID is running"
		else
			info "[DEBUG] ERROR: Tauri process $TAURI1_PID died immediately after launch!"
			info "[DEBUG] Dumping last 50 lines of unified log:"
			tail -50 "$LOG_FILE" 2>/dev/null || echo "Cannot read log file"
		fi

		info "Waiting for WS bridge on port $WS_PORT_BASE..."
		wait_ws "$WS_PORT_BASE" "$TAURI1_PID" "$CLIENT1_EMAIL" || {
			echo "[DEBUG] WS bridge failed to come up on port $WS_PORT_BASE" >&2
			echo "[DEBUG] Checking if Tauri process is still alive..." >&2
			if kill -0 "$TAURI1_PID" 2>/dev/null; then
				echo "[DEBUG] Tauri process $TAURI1_PID is still running" >&2
			else
				echo "[DEBUG] Tauri process $TAURI1_PID has exited" >&2
			fi
			echo "[DEBUG] Checking what's listening on nearby ports:" >&2
			lsof -i :$((WS_PORT_BASE - 1)):$((WS_PORT_BASE + 2)) 2>&1 || echo "lsof unavailable" >&2
			echo "[DEBUG] Last 100 lines of unified log:" >&2
			tail -100 "$LOG_FILE" 2>/dev/null || echo "Cannot read log file" >&2
			exit 1
		}
		timer_pop
		info "[DEBUG] WS bridge ready on port $WS_PORT_BASE"

		export UNIFIED_LOG_WS="$UNIFIED_LOG_WS_URL"
		export USE_REAL_INVOKE=true
		info "Client1 UI: ${UI_BASE_URL}?ws=${WS_PORT_BASE}&real=1"

		# Run Jupyter session test (includes onboarding in the test itself)
		info "=== Jupyter Session Test ==="
		info "[DEBUG] About to run Playwright with grep @jupyter-session"
		timer_push "Playwright: @jupyter-session"
		run_ui_grep "@jupyter-session" "INCLUDE_JUPYTER_TESTS=1"
		PLAYWRIGHT_EXIT=$?
		timer_pop
		info "[DEBUG] Playwright exited with code $PLAYWRIGHT_EXIT"
		if [[ "$PLAYWRIGHT_EXIT" -ne 0 ]]; then
			info "[DEBUG] Playwright test failed, dumping last 200 lines of log:"
			tail -200 "$LOG_FILE" 2>/dev/null || echo "Cannot read log file"
		fi
		exit $PLAYWRIGHT_EXIT
		;;
	jupyter-collab)
		start_static_server
		start_tauri_instances

		# Onboarding is now handled inline by the jupyter-collab test
		# This allows running with the same browser instance (no restart)

		# Run Jupyter collaboration tests
		# If multiple configs provided, run each in sequence (Tauri stays running)
		if [[ ${#NOTEBOOK_CONFIGS[@]} -gt 0 ]]; then
			config_num=1
			total_configs=${#NOTEBOOK_CONFIGS[@]}
				for config in "${NOTEBOOK_CONFIGS[@]}"; do
					info "=== Jupyter Test $config_num/$total_configs: $config ==="
					timer_push "Playwright: @jupyter-collab ($config)"
					run_ui_grep "@jupyter-collab" "INCLUDE_JUPYTER_TESTS=1" "NOTEBOOK_CONFIG=$config" "INTERACTIVE_MODE=$INTERACTIVE_MODE"
					timer_pop
					((config_num++))
				done
		else
				# No configs provided, run with defaults
				info "=== Phase 2: Jupyter Collaboration Test (default notebooks) ==="
				timer_push "Playwright: @jupyter-collab"
				run_ui_grep "@jupyter-collab" "INCLUDE_JUPYTER_TESTS=1" "INTERACTIVE_MODE=$INTERACTIVE_MODE"
				timer_pop
			fi

		# In wait mode, keep everything running
		if [[ "$WAIT_MODE" == "1" ]]; then
			info "Wait mode: Servers will stay running. Press Ctrl+C to exit."
			while true; do sleep 1; done
		fi
		;;
	pipelines-solo)
		start_static_server
		# Pipelines test only needs one client
		assert_tauri_binary_present
		assert_tauri_binary_fresh

		# Synthetic data configuration
		SYNTHETIC_DATA_DIR="$ROOT_DIR/test-data/synthetic-genotypes"
		EXPECTED_FILE_COUNT=10
		FORCE_REGEN="${FORCE_REGEN_SYNTHETIC:-0}"
		CLEANUP_SYNTHETIC="${CLEANUP_SYNTHETIC:-0}"

		# Check if synthetic data already exists and is valid
		EXISTING_COUNT=0
		if [[ -d "$SYNTHETIC_DATA_DIR" ]]; then
			EXISTING_COUNT=$(find "$SYNTHETIC_DATA_DIR" -name "*.txt" 2>/dev/null | wc -l | tr -d ' ')
		fi

		if [[ "$FORCE_REGEN" == "1" ]] || [[ "$EXISTING_COUNT" -lt "$EXPECTED_FILE_COUNT" ]]; then
			# Generate synthetic data using biosynth (bvs)
			info "=== Generating synthetic genotype data ==="
			timer_push "Synthetic data generation"

			# Clean up any partial/old data
			rm -rf "$SYNTHETIC_DATA_DIR"
			mkdir -p "$SYNTHETIC_DATA_DIR"

			# Check if bvs (biosynth) is available
			if ! command -v bvs &>/dev/null; then
				info "Installing biosynth (bvs) CLI..."
				cargo install biosynth --locked 2>&1 | tee -a "$LOG_FILE" || {
					echo "Failed to install biosynth. Please run: cargo install biosynth" >&2
					exit 1
				}
			fi

			# Generate synthetic genotype files with HERC2 variant overlay
			OVERLAY_FILE="$ROOT_DIR/data/overlay_variants.json"
			if [[ -f "$OVERLAY_FILE" ]]; then
				info "Generating $EXPECTED_FILE_COUNT synthetic files with HERC2 variants..."
				bvs synthetic \
					--output "$SYNTHETIC_DATA_DIR/{id}/{id}_X_X_GSAv3-DTC_GRCh38-{month}-{day}-{year}.txt" \
					--count "$EXPECTED_FILE_COUNT" \
					--threads 4 \
					--alt-frequency 0.50 \
					--seed 100 \
					--variants-file "$OVERLAY_FILE" \
					2>&1 | tee -a "$LOG_FILE" || {
					echo "Failed to generate synthetic data" >&2
					exit 1
				}
			else
				info "Generating $EXPECTED_FILE_COUNT synthetic files (no overlay file found)..."
				bvs synthetic \
					--output "$SYNTHETIC_DATA_DIR/{id}/{id}_X_X_GSAv3-DTC_GRCh38-{month}-{day}-{year}.txt" \
					--count "$EXPECTED_FILE_COUNT" \
					--threads 4 \
					--seed 100 \
					2>&1 | tee -a "$LOG_FILE" || {
					echo "Failed to generate synthetic data" >&2
					exit 1
				}
			fi
			timer_pop

			# Verify generated count
			SYNTH_FILE_COUNT=$(find "$SYNTHETIC_DATA_DIR" -name "*.txt" | wc -l | tr -d ' ')
			info "Generated $SYNTH_FILE_COUNT synthetic genotype files"
		else
			info "=== Reusing existing synthetic data ($EXISTING_COUNT files) ==="
			SYNTH_FILE_COUNT=$EXISTING_COUNT
		fi

		# Start Tauri instance with intentionally bad JAVA_HOME to test bundled Java override
		timer_push "Tauri instance start (single)"
		info "Launching Tauri for client1 on WS port $WS_PORT_BASE"
		# Set bad JAVA_HOME and JAVA_CMD to verify bundled Java is used
		export JAVA_HOME="/tmp/bad-java-home"
		export JAVA_CMD="/tmp/bad-java-cmd"
		TAURI1_PID=$(launch_instance "$CLIENT1_EMAIL" "$CLIENT1_HOME" "$CLIENT1_CFG" "$WS_PORT_BASE")
		info "Waiting for WS bridge..."
		wait_ws "$WS_PORT_BASE" || { echo "WS $WS_PORT_BASE not ready" >&2; exit 1; }
		timer_pop

		export UNIFIED_LOG_WS="$UNIFIED_LOG_WS_URL"
		export USE_REAL_INVOKE=true
		export SYNTHETIC_DATA_DIR
		info "Client1 UI: ${UI_BASE_URL}?ws=${WS_PORT_BASE}&real=1"
		info "Synthetic data dir: $SYNTHETIC_DATA_DIR"

		# Run pipelines solo test
		info "=== Pipelines Solo Test ==="
		timer_push "Playwright: @pipelines-solo"
		run_ui_grep "@pipelines-solo" "SYNTHETIC_DATA_DIR=$SYNTHETIC_DATA_DIR" "INTERACTIVE_MODE=$INTERACTIVE_MODE"
		timer_pop

		# Cleanup synthetic data (optional, disabled by default for caching)
		if [[ "$CLEANUP_SYNTHETIC" == "1" ]] && [[ -d "$SYNTHETIC_DATA_DIR" ]]; then
			info "Cleaning up synthetic data..."
			rm -rf "$SYNTHETIC_DATA_DIR"
		else
			info "Keeping synthetic data for reuse (set CLEANUP_SYNTHETIC=1 to remove)"
		fi

		# In wait mode, keep everything running
		if [[ "$WAIT_MODE" == "1" ]]; then
			info "Wait mode: Servers will stay running. Press Ctrl+C to exit."
			while true; do sleep 1; done
		fi
		;;
	*)
		echo "Unknown SCENARIO: $SCENARIO" >&2
		exit 1
	;;
esac

if [[ "${KEEP_ALIVE:-0}" == "1" || "${KEEP_ALIVE:-0}" == "true" ]]; then
	info "KEEP_ALIVE enabled; leaving servers running (Ctrl+C to stop)"
	while true; do
		sleep 1
	done
fi
