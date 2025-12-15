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

# Parse arguments
declare -a FORWARD_ARGS=()
SCENARIO=""

show_usage() {
	cat <<EOF
Usage: ./test-scenario.sh [OPTIONS] [-- PLAYWRIGHT_ARGS...]

Scenario Options (pick one):
  --all                Run all scenarios (default)
  --onboarding         Run onboarding test only
  --messaging          Run onboarding + basic messaging
  --messaging-sessions Run onboarding + comprehensive messaging & sessions
  --messaging-core     Run CLI-based messaging scenario

Other Options:
  --interactive, -i    Run with visible browser windows (alias for --headed)
  --headed             Run playwright with headed browser
  --help, -h           Show this help message

Examples:
  ./test-scenario.sh                    # Run all scenarios (default, headless)
  ./test-scenario.sh --messaging        # Run just messaging scenario
  ./test-scenario.sh --interactive      # Run all with visible browser
  ./test-scenario.sh --interactive --onboarding  # Run onboarding with visible browser
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
		--headed)
			FORWARD_ARGS+=(--headed)
			shift
			;;
		--interactive|-i)
			# Interactive = headed browser (visible windows)
			FORWARD_ARGS+=(--headed)
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

# Find an available UI port
while lsof -Pi ":${UI_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; do
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

is_port_free() {
	local port="$1"
	! lsof -Pi ":${port}" -sTCP:LISTEN -t >/dev/null 2>&1
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

# Start unified logger
info "Starting unified logger on port ${LOG_PORT} (file: ${LOG_FILE})"
UNIFIED_LOG_WS_URL="ws://localhost:${LOG_PORT}"
UNIFIED_LOG_STDOUT=${UNIFIED_LOG_STDOUT:-0}
node "$ROOT_DIR/tests/unified-logger.js" "$LOG_FILE" "$LOG_PORT" >/dev/null 2>&1 &
LOGGER_PID=$!

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
}
trap cleanup EXIT INT TERM

# Start devstack with two clients (reset by default to avoid stale state)
info "Ensuring SyftBox devstack with two clients (reset=${DEVSTACK_RESET})"
DEVSTACK_CLIENTS="${CLIENT1_EMAIL},${CLIENT2_EMAIL}"
# Stop any existing stack for this sandbox to avoid state conflicts
bash "$DEVSTACK_SCRIPT" --sandbox "$SANDBOX_ROOT" --stop >/dev/null 2>&1 || true
DEVSTACK_ARGS=(--clients "$DEVSTACK_CLIENTS" --sandbox "$SANDBOX_ROOT")
if [[ "$DEVSTACK_RESET" == "1" || "$DEVSTACK_RESET" == "true" ]]; then
	DEVSTACK_ARGS+=(--reset)
fi
if [[ "$DEVSTACK_SKIP_KEYS" == "1" || "$DEVSTACK_SKIP_KEYS" == "true" ]]; then
	DEVSTACK_ARGS+=(--skip-keys)
fi
bash "$DEVSTACK_SCRIPT" "${DEVSTACK_ARGS[@]}" >/dev/null

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

start_static_server() {
	# Start static server
	info "Starting static server on port ${UI_PORT}"
	pushd "$ROOT_DIR/src" >/dev/null
	python3 -m http.server "$UI_PORT" >>"$LOG_FILE" 2>&1 &
	SERVER_PID=$!
	popd >/dev/null
}

assert_tauri_binary_present() {
	TAURI_BINARY="${TAURI_BINARY:-$ROOT_DIR/src-tauri/target/release/bv-desktop}"
	if [[ ! -x "$TAURI_BINARY" ]]; then
		echo "Tauri binary not found at $TAURI_BINARY - run 'bun run build' first" >&2
		exit 1
	fi
}

assert_tauri_binary_fresh() {
	# Guardrail: stale binaries silently break harness assumptions (e.g. env var parsing).
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
				break
			fi
		elif [[ -d "$p" ]]; then
			newer="$(find "$p" -type f -newer "$TAURI_BINARY" -print -quit 2>/dev/null || true)"
			if [[ -n "$newer" ]]; then
				break
			fi
		fi
	done
	if [[ -n "$newer" ]]; then
		echo "Tauri binary is older than sources (e.g. $newer)." >&2
		# Default to rebuilding; set AUTO_REBUILD_TAURI=0/false/no to disable.
		local auto_rebuild="${AUTO_REBUILD_TAURI:-1}"
		if [[ "$auto_rebuild" != "0" && "$auto_rebuild" != "false" && "$auto_rebuild" != "no" ]]; then
			echo "Rebuilding (cd src-tauri && cargo build --release)..." >&2
			(cd "$ROOT_DIR/src-tauri" && cargo build --release) >&2
			return 0
		fi
		echo "Rebuild required: (cd src-tauri && cargo build --release) or 'bun run build'." >&2
		echo "Tip: set AUTO_REBUILD_TAURI=1 to auto-rebuild." >&2
		exit 1
	fi
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
		echo "[scenario] $email: starting bv-desktop (BIOVAULT_HOME=$BIOVAULT_HOME DEV_WS_BRIDGE_PORT=$DEV_WS_BRIDGE_PORT)" >&2
		exec "$TAURI_BINARY"
	) >>"$LOG_FILE" 2>&1 &
	echo $!
}

wait_ws() {
	local port="$1"
	for i in {1..60}; do
		if lsof -Pi :"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
			return 0
		fi
		sleep 0.5
	done
	return 1
}

start_tauri_instances() {
	assert_tauri_binary_present
	assert_tauri_binary_fresh

	# For CLI-based scenarios (messaging-core) where devstack creates keys, ensure sync before UI.
	# For UI scenarios (messaging, onboarding), keys are created during onboarding - skip preflight here.
	if [[ "$SCENARIO" == "messaging-core" ]]; then
		preflight_peer_sync
	fi

	info "Launching Tauri for client1 on WS port $WS_PORT_BASE"
	TAURI1_PID=$(launch_instance "$CLIENT1_EMAIL" "$CLIENT1_HOME" "$CLIENT1_CFG" "$WS_PORT_BASE")
	info "Launching Tauri for client2 on WS port $((WS_PORT_BASE + 1))"
	TAURI2_PID=$(launch_instance "$CLIENT2_EMAIL" "$CLIENT2_HOME" "$CLIENT2_CFG" "$((WS_PORT_BASE + 1))")

	info "Waiting for WS bridges..."
	wait_ws "$WS_PORT_BASE" || { echo "WS $WS_PORT_BASE not ready" >&2; exit 1; }
	wait_ws "$((WS_PORT_BASE + 1))" || { echo "WS $((WS_PORT_BASE + 1)) not ready" >&2; exit 1; }

	export UNIFIED_LOG_WS="$UNIFIED_LOG_WS_URL"
	export USE_REAL_INVOKE=true

	info "Client1 UI: ${UI_BASE_URL}?ws=${WS_PORT_BASE}&real=1"
	info "Client2 UI: ${UI_BASE_URL}?ws=$((WS_PORT_BASE + 1))&real=1"
}

info "Running Playwright scenario: $SCENARIO"
PLAYWRIGHT_OPTS=()
[[ "$TRACE" == "1" ]] && PLAYWRIGHT_OPTS+=(--trace on)

	case "$SCENARIO" in
		onboarding)
			start_static_server
			start_tauri_instances
			UI_PORT="$UI_PORT" UI_BASE_URL="$UI_BASE_URL" bun run test:ui --grep "@onboarding-two" ${PLAYWRIGHT_OPTS[@]+"${PLAYWRIGHT_OPTS[@]}"} ${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"} | tee -a "$LOG_FILE"
			;;
		messaging)
			start_static_server
			start_tauri_instances
			# Run onboarding first (creates keys), then wait for peer sync, then messaging
			UI_PORT="$UI_PORT" UI_BASE_URL="$UI_BASE_URL" bun run test:ui --grep "@onboarding-two" ${PLAYWRIGHT_OPTS[@]+"${PLAYWRIGHT_OPTS[@]}"} ${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"} | tee -a "$LOG_FILE"
			# After onboarding, keys exist - wait for them to sync via the network
			info "Waiting for peer keys to sync after onboarding..."
			preflight_peer_sync
			UI_PORT="$UI_PORT" UI_BASE_URL="$UI_BASE_URL" bun run test:ui --grep "@messages-two" ${PLAYWRIGHT_OPTS[@]+"${PLAYWRIGHT_OPTS[@]}"} ${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"} | tee -a "$LOG_FILE"
			;;
		messaging-sessions)
			start_static_server
			start_tauri_instances
			# Run onboarding first (creates keys), then wait for peer sync, then comprehensive test
			UI_PORT="$UI_PORT" UI_BASE_URL="$UI_BASE_URL" bun run test:ui --grep "@onboarding-two" ${PLAYWRIGHT_OPTS[@]+"${PLAYWRIGHT_OPTS[@]}"} ${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"} | tee -a "$LOG_FILE"
			# After onboarding, keys exist - wait for them to sync via the network
			info "Waiting for peer keys to sync after onboarding..."
			preflight_peer_sync
			# Run comprehensive messaging + sessions test
			UI_PORT="$UI_PORT" UI_BASE_URL="$UI_BASE_URL" bun run test:ui --grep "@messaging-sessions" ${PLAYWRIGHT_OPTS[@]+"${PLAYWRIGHT_OPTS[@]}"} ${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"} | tee -a "$LOG_FILE"
			;;
		all)
			start_static_server
			start_tauri_instances
			# Run onboarding first (creates keys)
			info "=== Phase 1: Onboarding ==="
			UI_PORT="$UI_PORT" UI_BASE_URL="$UI_BASE_URL" bun run test:ui --grep "@onboarding-two" ${PLAYWRIGHT_OPTS[@]+"${PLAYWRIGHT_OPTS[@]}"} ${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"} | tee -a "$LOG_FILE"
			# Wait for peer sync
			info "Waiting for peer keys to sync after onboarding..."
			preflight_peer_sync
			# Run basic messaging test
			info "=== Phase 2: Basic Messaging ==="
			UI_PORT="$UI_PORT" UI_BASE_URL="$UI_BASE_URL" bun run test:ui --grep "@messages-two" ${PLAYWRIGHT_OPTS[@]+"${PLAYWRIGHT_OPTS[@]}"} ${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"} | tee -a "$LOG_FILE"
			# Run comprehensive messaging + sessions test
			info "=== Phase 3: Messaging + Sessions ==="
			UI_PORT="$UI_PORT" UI_BASE_URL="$UI_BASE_URL" bun run test:ui --grep "@messaging-sessions" ${PLAYWRIGHT_OPTS[@]+"${PLAYWRIGHT_OPTS[@]}"} ${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"} | tee -a "$LOG_FILE"
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
		(cd "$BIOVAULT_DIR/cli" && cargo build --release) >>"$LOG_FILE" 2>&1

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
		python3 "$BIOVAULT_DIR/scripts/run_scenario.py" "$SCENARIO_NO_SETUP" 2>&1 | tee -a "$LOG_FILE"

		start_static_server
		start_tauri_instances

		info "Opening UI for inspection"
		UI_PORT="$UI_PORT" UI_BASE_URL="$UI_BASE_URL" bun run test:ui --grep "@messaging-core-ui" ${PLAYWRIGHT_OPTS[@]+"${PLAYWRIGHT_OPTS[@]}"} ${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"} | tee -a "$LOG_FILE"
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
