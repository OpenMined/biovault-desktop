#!/bin/bash
set -euo pipefail

# GitHub Actions Windows runners often provide `python` but not `python3` on PATH.
# Normalize so the rest of the script can keep using `python3`.
if ! command -v python3 >/dev/null 2>&1; then
	if command -v python >/dev/null 2>&1; then
		python3() { python "$@"; }
	else
		echo "Missing required tool: python3 (or python)" >&2
		exit 1
	fi
fi

# Scenario runner for multi-app UI+backend tests (e.g., messaging between two clients)
# This mirrors dev-two.sh but drives Playwright specs.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$ROOT_DIR}"
BIOVAULT_DIR="${BIOVAULT_DIR:-$WORKSPACE_ROOT/biovault}"
BIOVAULT_BEAVER_DIR="${BIOVAULT_BEAVER_DIR:-$WORKSPACE_ROOT/biovault-beaver}"
SYFTBOX_SDK_DIR="${SYFTBOX_SDK_DIR:-$WORKSPACE_ROOT/syftbox-sdk}"

# Canonicalize paths to resolve symlinks (ensures profile paths are consistent)
canonicalize_path() {
	local p="$1"
	if [[ -d "$p" ]]; then
		(cd "$p" && pwd -P)
	else
		echo "$p"
	fi
}
BIOVAULT_DIR="$(canonicalize_path "$BIOVAULT_DIR")"
BIOVAULT_BEAVER_DIR="$(canonicalize_path "$BIOVAULT_BEAVER_DIR")"
SYFTBOX_SDK_DIR="$(canonicalize_path "$SYFTBOX_SDK_DIR")"
if [[ ! -d "$BIOVAULT_BEAVER_DIR" && -d "$BIOVAULT_DIR/biovault-beaver" ]]; then
	BIOVAULT_BEAVER_DIR="$BIOVAULT_DIR/biovault-beaver"
fi
if [[ ! -d "$SYFTBOX_SDK_DIR" && -d "$BIOVAULT_DIR/syftbox-sdk" ]]; then
	SYFTBOX_SDK_DIR="$BIOVAULT_DIR/syftbox-sdk"
fi
DEVSTACK_SCRIPT="$BIOVAULT_DIR/tests/scripts/devstack.sh"
UI_PORT_EXPLICIT=0
if [[ -n "${UI_PORT+x}" && -n "${UI_PORT}" ]]; then
	UI_PORT_EXPLICIT=1
fi
WS_PORT_BASE_EXPLICIT=0
if [[ -n "${DEV_WS_BRIDGE_PORT_BASE+x}" && -n "${DEV_WS_BRIDGE_PORT_BASE}" ]]; then
	WS_PORT_BASE_EXPLICIT=1
fi
UNIFIED_LOG_PORT_EXPLICIT=0
if [[ -n "${UNIFIED_LOG_PORT+x}" && -n "${UNIFIED_LOG_PORT}" ]]; then
	UNIFIED_LOG_PORT_EXPLICIT=1
fi
WS_PORT_BASE="${DEV_WS_BRIDGE_PORT_BASE:-}"
LOG_FILE="${UNIFIED_LOG_FILE:-$ROOT_DIR/logs/unified-scenario.log}"
LOG_PORT="${UNIFIED_LOG_PORT:-}"
UI_PORT="${UI_PORT:-}"
UI_PORT_MIN="${UI_PORT_MIN:-8082}"
UI_PORT_MAX="${UI_PORT_MAX:-${MAX_PORT:-8999}}"
MAX_PORT="$UI_PORT_MAX"
WS_PORT_MIN="${DEV_WS_BRIDGE_PORT_MIN:-3333}"
LOG_PORT_MIN="${UNIFIED_LOG_PORT_MIN:-9756}"
TRACE=${TRACE:-0}
DEVSTACK_RESET="${DEVSTACK_RESET:-1}"
TIMING="${TIMING:-1}"
DEVSTACK_STARTED=0


# Parse arguments
declare -a FORWARD_ARGS=()
declare -a NOTEBOOK_CONFIGS=()
SCENARIO=""
WARM_CACHE=0  # Set after arg parsing (scenario-dependent default)
WARM_CACHE_SET=0
INTERACTIVE_MODE=0  # Headed browsers for visibility
WAIT_MODE=0  # Keep everything running after test completes
CLEANUP_ACTIVE=0
# Treat explicit env NO_CLEANUP as user intent so scenario auto-preserve does not override it.
NO_CLEANUP_SET=0
if [[ -n "${NO_CLEANUP+x}" ]]; then
	NO_CLEANUP_SET=1
fi
NO_CLEANUP="${NO_CLEANUP:-0}" # Leave processes/sandbox running on exit for debugging
SYQURE_MULTIPARTY_SECURE_ONLY="${SYQURE_MULTIPARTY_SECURE_ONLY:-0}"
SYQURE_MULTIPARTY_CLI_PARITY="${SYQURE_MULTIPARTY_CLI_PARITY:-0}"
SYQURE_DUMP_TRAFFIC="${SYQURE_DUMP_TRAFFIC:-0}"

show_usage() {
	cat <<EOF
Usage: ./test-scenario.sh [OPTIONS] [-- PLAYWRIGHT_ARGS...]

Scenario Options (pick one):
  --all                Run all scenarios (default)
  --onboarding         Run onboarding test only
  --profiles           Run profiles UI flow (real backend, isolated sandbox)
  --profiles-mock      Run profiles UI flow (mock backend)
  --files-cli          Run CLI file-import smoke test (no UI/devstack)
  --messaging          Run onboarding + basic messaging
  --messaging-sessions Run onboarding + comprehensive messaging & sessions
  --messaging-core     Run CLI-based messaging scenario
  --flows-solo     Run flow UI test only (single client)
  --flows-gwas     Run GWAS flow UI test only (single client)
  --flows-collab   Run two-client flow collaboration test
  --flows-pause-resume  Test flow pause/resume with state persistence
  --syqure-flow    Run three-client interactive Syqure flow (no Playwright)
  --pipelines-multiparty  Run three-client multiparty messaging test
  --pipelines-multiparty-flow  Run three-client multiparty flow execution test
  --syqure-multiparty-flow  Run three-client Syqure collaborative flow (real flow.yaml)
  --syqure-multiparty-allele-freq  Run three-client Syqure collaborative allele-freq flow UI test
  --file-transfer      Run two-client file sharing via SyftBox (pause/resume sync)
  --jupyter            Run onboarding + Jupyter session test (single client)
  --jupyter-collab [config1.json config2.json ...]
                       Run two-client Jupyter collaboration tests
                       Accepts multiple notebook config files (runs all in sequence)

Other Options:
  --interactive, -i    Run with visible browser windows (alias for --headed)
  --syqure-secure-only Run only secure_aggregate in --syqure-multiparty-flow (seeded fixed inputs)
  --syqure-cli-parity  Make --syqure-multiparty-flow runtime match CLI distributed flow defaults
  --syqure-dump-traffic Enable verbose hotlink TCP proxy traffic dumps (very noisy)
  --headed             Run playwright with headed browser
  --wait               Keep servers running after test completes (for inspection)
  --no-cleanup         Do not stop static server/Tauri/logger/devstack on exit
  --no-warm-cache      Skip pre-building Jupyter venv cache (default: warm cache)
  --help, -h           Show this help message

Environment Variables (flows-solo):
  FORCE_REGEN_SYNTHETIC=1   Force regenerate synthetic data even if it exists
  CLEANUP_SYNTHETIC=1       Remove synthetic data after test (default: keep for reuse)

Environment Variables (flows-gwas):
  GWAS_DATA_DIR             GWAS dataset directory (default: /Users/madhavajay/dev/biovaults/datasets/jordan_gwas)

Environment Variables (ports):
  UI_PORT                  Force UI server port (otherwise random in UI_PORT_MIN..UI_PORT_MAX)
  UI_PORT_MIN/UI_PORT_MAX  UI random range (defaults: 8082..8999)
  DEV_WS_BRIDGE_PORT_BASE  Force WS bridge base (otherwise random in DEV_WS_BRIDGE_PORT_MIN..DEV_WS_BRIDGE_PORT_MAX)
  DEV_WS_BRIDGE_PORT_MIN/MAX  WS bridge random range (defaults: 3333..3499)
  UNIFIED_LOG_PORT         Force unified logger port (otherwise random in UNIFIED_LOG_PORT_MIN..UNIFIED_LOG_PORT_MAX)
  UNIFIED_LOG_PORT_MIN/MAX Unified logger random range (defaults: 9756..9856)
  BV_SYQURE_PORT_BASE      Force Syqure TCP proxy base
  BV_SYQURE_PORT_BASE_MIN/MAX  Syqure base random range for Syqure UI scenarios (defaults: 20000..auto-max)
  SYFTBOX_HOTLINK_TCP_DUMP=1      Log TCP proxy payload chunks (hex dump)
  SYFTBOX_HOTLINK_TCP_DUMP_FULL=1 Log full payload hex (can generate huge logs)
  SYFTBOX_HOTLINK_TCP_DUMP_PREVIEW  Preview bytes when full dump disabled (default: 64)

Examples:
  ./test-scenario.sh                    # Run all scenarios (default, headless)
  ./test-scenario.sh --messaging        # Run just messaging scenario
  ./test-scenario.sh --interactive      # Run all with visible browser
  ./test-scenario.sh --interactive --onboarding  # Run onboarding with visible browser
  ./test-scenario.sh --interactive --profiles    # Run profiles UI flow (real backend) with visible browser
  ./test-scenario.sh --interactive --profiles-mock    # Run profiles UI flow (mock) with visible browser
  ./test-scenario.sh --flows-solo   # Run flow test with synthetic data
  ./test-scenario.sh --flows-gwas   # Run GWAS flow test
  ./test-scenario.sh --syqure-flow --interactive  # Launch 3 clients for Syqure flow
  ./test-scenario.sh --pipelines-multiparty --interactive  # Launch 3 clients for multiparty messaging
  ./test-scenario.sh --syqure-multiparty-flow --interactive  # Run Syqure collaborative flow UI test
  ./test-scenario.sh --syqure-multiparty-flow --syqure-secure-only --interactive  # Run only secure_aggregate stage
  ./test-scenario.sh --syqure-multiparty-flow --syqure-cli-parity --interactive  # Align desktop run with CLI runtime defaults
  ./test-scenario.sh --syqure-multiparty-flow --syqure-dump-traffic --interactive  # Enable TCP proxy payload dumps
  ./test-scenario.sh --syqure-multiparty-allele-freq --interactive  # Run Syqure collaborative allele-freq flow UI test
  FORCE_REGEN_SYNTHETIC=1 ./test-scenario.sh --flows-solo  # Force regenerate data
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
		--profiles)
			SCENARIO="profiles"
			shift
			;;
		--profiles-mock)
			SCENARIO="profiles-mock"
			shift
			;;
		--files-cli)
			SCENARIO="files-cli"
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
		--flows-solo)
			SCENARIO="flows-solo"
			shift
			;;
		--flows-gwas)
			SCENARIO="flows-gwas"
			shift
			;;
		--flows-collab)
			SCENARIO="flows-collab"
			shift
			;;
		--flows-pause-resume)
			SCENARIO="flows-pause-resume"
			shift
			;;
		--syqure-flow)
			SCENARIO="syqure-flow"
			shift
			;;
		--pipelines-multiparty)
			SCENARIO="pipelines-multiparty"
			shift
			;;
		--pipelines-multiparty-flow)
			SCENARIO="pipelines-multiparty-flow"
			shift
			;;
		--syqure-multiparty-flow)
			SCENARIO="syqure-multiparty-flow"
			shift
			;;
		--syqure-multiparty-allele-freq)
			SCENARIO="syqure-multiparty-allele-freq"
			shift
			;;
		--file-transfer)
			SCENARIO="file-transfer"
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
		--headed)
			FORWARD_ARGS+=(--headed)
			export PLAYWRIGHT_HEADLESS=false
			shift
			;;
		--interactive|-i)
			# Interactive = headed browser (visible windows)
			FORWARD_ARGS+=(--headed)
			export PLAYWRIGHT_HEADLESS=false
			INTERACTIVE_MODE=1
			shift
			;;
		--syqure-secure-only)
			SYQURE_MULTIPARTY_SECURE_ONLY=1
			shift
			;;
		--syqure-cli-parity)
			SYQURE_MULTIPARTY_CLI_PARITY=1
			shift
			;;
		--syqure-dump-traffic)
			SYQURE_DUMP_TRAFFIC=1
			shift
			;;
		--wait)
			# Keep servers running after test completes
			WAIT_MODE=1
			shift
			;;
		--no-cleanup)
			NO_CLEANUP=1
			NO_CLEANUP_SET=1
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

# Default to embedded SyftBox backend unless explicitly overridden.
# CLI-parity mode for Syqure multiparty uses external backend by default.
if [[ -z "${BV_SYFTBOX_BACKEND:-}" ]]; then
        if [[ "$SCENARIO" == "syqure-multiparty-flow" && "$SYQURE_MULTIPARTY_CLI_PARITY" == "1" ]]; then
                export BV_SYFTBOX_BACKEND=external
        else
                export BV_SYFTBOX_BACKEND=embedded
        fi
fi
if [[ -z "${BV_DEVSTACK_CLIENT_MODE:-}" ]]; then
        export BV_DEVSTACK_CLIENT_MODE=embedded
fi

# Scenario-dependent default: only warm Jupyter cache for Jupyter scenarios unless explicitly overridden.
if [[ "$WARM_CACHE_SET" == "0" ]]; then
        case "$SCENARIO" in
                jupyter|jupyter-collab) WARM_CACHE=1 ;;
                *) WARM_CACHE=0 ;;
	esac
fi

# Syqure UI scenarios require hotlink-related env to be present before devstack starts,
# so embedded/rust client daemons pick up TCP proxy settings.
if [[ "$SCENARIO" == "syqure-flow" || "$SCENARIO" == "syqure-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-allele-freq" ]]; then
	# Hotlink/TCP proxy transport depends on SyftBox rust daemons.
	# Keep this as the default for Syqure UI scenarios unless user explicitly overrides.
	if [[ -z "${BV_DEVSTACK_CLIENT_MODE:-}" || "${BV_DEVSTACK_CLIENT_MODE}" == "embedded" ]]; then
		export BV_DEVSTACK_CLIENT_MODE=rust
	fi

	export BV_SYFTBOX_HOTLINK="${BV_SYFTBOX_HOTLINK:-1}"
	export BV_SYFTBOX_HOTLINK_SOCKET_ONLY="${BV_SYFTBOX_HOTLINK_SOCKET_ONLY:-1}"
	export BV_SYFTBOX_HOTLINK_TCP_PROXY="${BV_SYFTBOX_HOTLINK_TCP_PROXY:-1}"
	export BV_SYFTBOX_HOTLINK_QUIC="${BV_SYFTBOX_HOTLINK_QUIC:-1}"
	export BV_SYFTBOX_HOTLINK_QUIC_ONLY="${BV_SYFTBOX_HOTLINK_QUIC_ONLY:-0}"
	export BV_SYQURE_TCP_PROXY="${BV_SYQURE_TCP_PROXY:-1}"
	# Devstack daemons read SYFTBOX_* directly; mirror BV_* defaults for UI scenarios.
	export SYFTBOX_HOTLINK="${SYFTBOX_HOTLINK:-$BV_SYFTBOX_HOTLINK}"
	export SYFTBOX_HOTLINK_SOCKET_ONLY="${SYFTBOX_HOTLINK_SOCKET_ONLY:-$BV_SYFTBOX_HOTLINK_SOCKET_ONLY}"
	export SYFTBOX_HOTLINK_TCP_PROXY="${SYFTBOX_HOTLINK_TCP_PROXY:-$BV_SYFTBOX_HOTLINK_TCP_PROXY}"
	export SYFTBOX_HOTLINK_QUIC="${SYFTBOX_HOTLINK_QUIC:-$BV_SYFTBOX_HOTLINK_QUIC}"
	export SYFTBOX_HOTLINK_QUIC_ONLY="${SYFTBOX_HOTLINK_QUIC_ONLY:-$BV_SYFTBOX_HOTLINK_QUIC_ONLY}"
	if [[ -n "${SYQURE_SKIP_BUNDLE:-}" ]]; then
		export SYQURE_SKIP_BUNDLE
	fi
		if [[ -n "${SYFTBOX_HOTLINK_DEBUG:-}" ]]; then
			export SYFTBOX_HOTLINK_DEBUG
		fi
		if [[ "$SYQURE_DUMP_TRAFFIC" == "1" ]]; then
			export SYFTBOX_HOTLINK_TCP_DUMP="${SYFTBOX_HOTLINK_TCP_DUMP:-1}"
			export SYFTBOX_HOTLINK_DEBUG="${SYFTBOX_HOTLINK_DEBUG:-1}"
		fi
		if [[ -n "${SYFTBOX_HOTLINK_TCP_DUMP:-}" ]]; then
			export SYFTBOX_HOTLINK_TCP_DUMP
		fi
		if [[ -n "${SYFTBOX_HOTLINK_TCP_DUMP_FULL:-}" ]]; then
			export SYFTBOX_HOTLINK_TCP_DUMP_FULL
		fi
		if [[ -n "${SYFTBOX_HOTLINK_TCP_DUMP_PREVIEW:-}" ]]; then
			export SYFTBOX_HOTLINK_TCP_DUMP_PREVIEW
		fi
		if [[ -n "${SYQURE_DEBUG:-}" ]]; then
			export SYQURE_DEBUG
		fi
fi

# Preserve Syqure multiparty artifacts by default so failures/passes can be debugged from disk.
# Override with SYQURE_MULTIPARTY_AUTO_PRESERVE=0 or explicit --no-cleanup/NO_CLEANUP.
if [[ ( "$SCENARIO" == "syqure-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-allele-freq" ) && "$NO_CLEANUP_SET" != "1" ]]; then
	auto_preserve="${SYQURE_MULTIPARTY_AUTO_PRESERVE:-1}"
	if [[ "$auto_preserve" == "1" || "$auto_preserve" == "true" || "$auto_preserve" == "yes" ]]; then
		NO_CLEANUP=1
	fi
fi

# Default behavior: UI scenarios do onboarding (create keys in-app), so skip devstack biovault bootstrap.
# Embedded SyftBox clients require BioVault init, so always run bootstrap in embedded mode.
DEVSTACK_SKIP_KEYS="${DEVSTACK_SKIP_KEYS:-}"
DEVSTACK_CLIENT_MODE="$(printf '%s' "${BV_DEVSTACK_CLIENT_MODE:-embedded}" | tr '[:upper:]' '[:lower:]')"
if [[ -z "${DEVSTACK_SKIP_KEYS}" ]]; then
        if [[ "$DEVSTACK_CLIENT_MODE" == "embedded" || "$SCENARIO" == "messaging-core" ]]; then
                DEVSTACK_SKIP_KEYS=0
        else
                DEVSTACK_SKIP_KEYS=1
        fi
fi

mkdir -p "$(dirname "$LOG_FILE")"
: >"$LOG_FILE"

info() { printf "\033[1;36m[scenario]\033[0m %s\n" "$1"; }

pause_for_interactive_exit() {
	if [[ "${PLAYWRIGHT_INTERACTIVE_PAUSE:-0}" == "1" ]]; then
		return
	fi
	if [[ "${INTERACTIVE_MODE:-0}" == "1" && "${WAIT_MODE:-0}" != "1" && "${KEEP_ALIVE:-0}" != "1" ]]; then
		if [[ -t 0 ]]; then
			printf "\n\033[1;36m[scenario]\033[0m Interactive mode: press Enter to close servers and exit.\n"
			read -r || true
		else
			info "Interactive mode requested but no TTY available; proceeding to shutdown."
		fi
	fi
}

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

if [[ "${INTERACTIVE_MODE}" == "1" ]]; then
	export PLAYWRIGHT_INTERACTIVE_PAUSE="${PLAYWRIGHT_INTERACTIVE_PAUSE:-1}"
	export INTERACTIVE_MODE
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
	if command -v lsof >/dev/null 2>&1; then
		if lsof -iTCP:"$port" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
			return 1
		fi
		return 0
	fi
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

random_port_in_range() {
	local min="$1"
	local max="$2"
	if [[ "$min" -le 0 || "$max" -le 0 || "$max" -lt "$min" ]]; then
		return 1
	fi
	local span=$((max - min + 1))
	echo $((min + RANDOM % span))
}

pick_free_port_randomized() {
	local min="$1"
	local max="$2"
	local start
	start="$(random_port_in_range "$min" "$max" || true)"
	if [[ -z "$start" ]]; then
		return 1
	fi
	local picked
	picked="$(pick_free_port "$start" "$max" || true)"
	if [[ -n "$picked" ]]; then
		echo "$picked"
		return 0
	fi
	if [[ "$start" -gt "$min" ]]; then
		picked="$(pick_free_port "$min" "$((start - 1))" || true)"
		if [[ -n "$picked" ]]; then
			echo "$picked"
			return 0
		fi
	fi
	return 1
}

pick_ws_port_base() {
	local start="$1"
	local max="${2:-3499}"
	local count="${3:-2}"
	if [[ "$count" -le 0 ]]; then
		return 1
	fi
	local port="$start"
	while [[ "$port" -le "$max" ]]; do
		if [[ "$((port + count - 1))" -gt "$max" ]]; then
			break
		fi
		local ok=1
		local i=0
		while [[ "$i" -lt "$count" ]]; do
			if ! is_port_free "$((port + i))"; then
				ok=0
				break
			fi
			i=$((i + 1))
		done
		if [[ "$ok" == "1" ]]; then
			echo "$port"
			return 0
		fi
		port=$((port + 1))
	done
	return 1
}

pick_ws_port_base_randomized() {
	local min="$1"
	local max="$2"
	local count="${3:-2}"
	if [[ "$count" -le 0 || "$max" -lt "$min" ]]; then
		return 1
	fi
	local max_start=$((max - count + 1))
	if [[ "$max_start" -lt "$min" ]]; then
		return 1
	fi
	local start
	start="$(random_port_in_range "$min" "$max_start" || true)"
	if [[ -z "$start" ]]; then
		return 1
	fi
	local picked
	picked="$(pick_ws_port_base "$start" "$max" "$count" || true)"
	if [[ -n "$picked" ]]; then
		echo "$picked"
		return 0
	fi
	if [[ "$start" -gt "$min" ]]; then
		picked="$(pick_ws_port_base "$min" "$((start - 1 + count - 1))" "$count" || true)"
		if [[ -n "$picked" ]]; then
			echo "$picked"
			return 0
		fi
	fi
	return 1
}

syqure_max_base_port() {
	local party_count="${1:-2}"
	local parties="$party_count"
	if [[ "$parties" -lt 2 ]]; then
		parties=2
	fi
	local max_party_base_delta=$(((parties - 1) * 1000))
	local max_pair_offset=$((parties * (parties - 1) / 2))
	local reserve=$((max_party_base_delta + max_pair_offset + 10000 + parties))
	echo $((65535 - reserve))
}

syqure_mpc_comm_port_with_base() {
	local base="$1"
	local local_pid="$2"
	local remote_pid="$3"
	local parties="$4"
	local min_pid="$local_pid"
	local max_pid="$remote_pid"
	if [[ "$remote_pid" -lt "$local_pid" ]]; then
		min_pid="$remote_pid"
		max_pid="$local_pid"
	fi
	local offset_major=$((min_pid * parties - min_pid * (min_pid + 1) / 2))
	local offset_minor=$((max_pid - min_pid))
	echo $((base + offset_major + offset_minor))
}

syqure_port_base_is_available() {
	local global_base="$1"
	local party_count="${2:-2}"
	local parties="$party_count"
	if [[ "$parties" -lt 2 ]]; then
		parties=2
	fi
	local party_id
	local remote_id
	for ((party_id = 0; party_id < parties; party_id++)); do
		local party_base=$((global_base + party_id * 1000))
		local sharing_port=$((party_base + 10000))
		if ! is_port_free "$sharing_port"; then
			return 1
		fi
		for ((remote_id = 0; remote_id < parties; remote_id++)); do
			if [[ "$remote_id" -eq "$party_id" ]]; then
				continue
			fi
			local comm_port
			comm_port="$(syqure_mpc_comm_port_with_base "$party_base" "$party_id" "$remote_id" "$parties")"
			if ! is_port_free "$comm_port"; then
				return 1
			fi
		done
	done
	return 0
}

pick_syqure_port_base_randomized() {
	local party_count="${1:-2}"
	local min="${2:-20000}"
	local max="${3:-$(syqure_max_base_port "$party_count")}"
	if [[ "$max" -lt "$min" ]]; then
		return 1
	fi
	local start
	start="$(random_port_in_range "$min" "$max" || true)"
	if [[ -z "$start" ]]; then
		return 1
	fi
	local span=$((max - min + 1))
	local candidate="$start"
	local i=0
	while [[ "$i" -lt "$span" ]]; do
		if syqure_port_base_is_available "$candidate" "$party_count"; then
			echo "$candidate"
			return 0
		fi
		candidate=$((candidate + 1))
		if [[ "$candidate" -gt "$max" ]]; then
			candidate="$min"
		fi
		i=$((i + 1))
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

apply_podman_windows_defaults() {
	local os
	read -r os _ <<<"$(detect_platform)"
	if [[ "$os" != "windows" ]]; then
		return 0
	fi
	if [[ "${BIOVAULT_CONTAINER_RUNTIME:-}" == "podman" ]]; then
		if [[ -z "${BIOVAULT_HYPERV_MOUNT:-}" ]]; then
			export BIOVAULT_HYPERV_MOUNT=1
		fi
	fi
}

apply_podman_windows_defaults

to_host_path() {
        local p="$1"
        local os
        read -r os _ <<<"$(detect_platform)"
        if [[ "$os" == "windows" && -n "$p" ]] && command -v cygpath >/dev/null 2>&1; then
                cygpath -m "$p"
                return 0
        fi
        echo "$p"
}

find_bundled_uv() {
	local os arch
	read -r os arch <<<"$(detect_platform)"
	local dir="$ROOT_DIR/src-tauri/resources/bundled/uv/${os}-${arch}"
	if [[ "$os" == "windows" ]]; then
		local candidate
		for candidate in "$dir/uv.exe" "$dir/uv"; do
			if [[ -f "$candidate" ]]; then
				echo "$candidate"
				return 0
			fi
		done
	else
		local candidate="$dir/uv"
		if [[ -x "$candidate" ]]; then
			echo "$candidate"
			return 0
		fi
	fi
	return 1
}

ensure_playwright_browsers() {
	# If browsers are already cached, skip install. Otherwise install Chromium (with deps on Linux).
	local browsers_path="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
	if compgen -G "$browsers_path/chromium*" >/dev/null 2>&1; then
		return 0
	fi

	info "Playwright browsers not found; installing Chromium..."
	if command -v bun >/dev/null 2>&1; then
		if [[ "$(uname -s)" == "Linux" ]]; then
			bunx --bun playwright install --with-deps chromium >>"$LOG_FILE" 2>&1
		else
			bunx --bun playwright install chromium >>"$LOG_FILE" 2>&1
		fi
	elif command -v npx >/dev/null 2>&1; then
		if [[ "$(uname -s)" == "Linux" ]]; then
			npx playwright install --with-deps chromium >>"$LOG_FILE" 2>&1
		else
			npx playwright install chromium >>"$LOG_FILE" 2>&1
		fi
	else
		echo "Neither bun nor npx available to install Playwright browsers" >&2
		return 1
	fi
}

# Kill any dangling Jupyter processes from previous runs
kill_workspace_jupyter

# Find an available UI port
if [[ "$UI_PORT_EXPLICIT" == "1" ]]; then
	while ! is_port_free "$UI_PORT"; do
		if [[ "${UI_PORT}" -ge "${MAX_PORT}" ]]; then
			echo "No available port between ${UI_PORT} and ${MAX_PORT}" >&2
			exit 1
		fi
		UI_PORT=$((UI_PORT + 1))
		info "UI port in use, trying ${UI_PORT}"
	done
else
	UI_PORT="$(pick_free_port_randomized "$UI_PORT_MIN" "$MAX_PORT" || true)"
	if [[ -z "$UI_PORT" ]]; then
		echo "No available UI port between ${UI_PORT_MIN} and ${MAX_PORT}" >&2
		exit 1
	fi
	info "Selected UI port ${UI_PORT} (range ${UI_PORT_MIN}-${MAX_PORT})"
fi

export UI_PORT
export UI_BASE_URL="http://localhost:${UI_PORT}"
export DISABLE_UPDATER=1
export DEV_WS_BRIDGE=1

WS_PORT_COUNT=2
if [[ "$SCENARIO" == "syqure-flow" || "$SCENARIO" == "pipelines-multiparty" || "$SCENARIO" == "pipelines-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-allele-freq" ]]; then
	WS_PORT_COUNT=3
fi
WS_PORT_MAX="${DEV_WS_BRIDGE_PORT_MAX:-3499}"
if [[ "$WS_PORT_BASE_EXPLICIT" == "1" ]]; then
	WS_PORT_BASE="$(pick_ws_port_base "$WS_PORT_BASE" "$WS_PORT_MAX" "$WS_PORT_COUNT" || true)"
else
	WS_PORT_BASE="$(pick_ws_port_base_randomized "$WS_PORT_MIN" "$WS_PORT_MAX" "$WS_PORT_COUNT" || true)"
fi
if [[ -z "$WS_PORT_BASE" ]]; then
	if [[ "$WS_PORT_BASE_EXPLICIT" == "1" ]]; then
		echo "Could not find ${WS_PORT_COUNT} free consecutive WS ports starting at ${DEV_WS_BRIDGE_PORT_BASE}" >&2
	else
		echo "Could not find ${WS_PORT_COUNT} free consecutive WS ports in range ${WS_PORT_MIN}-${WS_PORT_MAX}" >&2
	fi
	exit 1
fi
export DEV_WS_BRIDGE_PORT_BASE="$WS_PORT_BASE"

# Pick a free Syqure TCP proxy base unless explicitly configured
if [[ "$SCENARIO" == "syqure-flow" || "$SCENARIO" == "syqure-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-allele-freq" ]]; then
	SYQURE_PARTY_COUNT=3
	if [[ "$SCENARIO" == "syqure-multiparty-flow" && "$SYQURE_MULTIPARTY_CLI_PARITY" == "1" && -z "${BV_SYQURE_PORT_BASE+x}" && -z "${SEQURE_COMMUNICATION_PORT+x}" ]]; then
		info "Syqure CLI-parity mode: letting run_dynamic allocate BV_SYQURE_PORT_BASE from run_id."
	elif [[ -z "${BV_SYQURE_PORT_BASE+x}" && -z "${SEQURE_COMMUNICATION_PORT+x}" ]]; then
		SYQURE_PORT_BASE_MIN="${BV_SYQURE_PORT_BASE_MIN:-20000}"
		SYQURE_PORT_BASE_MAX="${BV_SYQURE_PORT_BASE_MAX:-$(syqure_max_base_port "$SYQURE_PARTY_COUNT")}"
		BV_SYQURE_PORT_BASE="$(pick_syqure_port_base_randomized "$SYQURE_PARTY_COUNT" "$SYQURE_PORT_BASE_MIN" "$SYQURE_PORT_BASE_MAX" || true)"
		if [[ -z "$BV_SYQURE_PORT_BASE" ]]; then
			echo "Could not find free Syqure port base in range ${SYQURE_PORT_BASE_MIN}-${SYQURE_PORT_BASE_MAX}" >&2
			exit 1
		fi
		export BV_SYQURE_PORT_BASE
		info "Selected Syqure TCP proxy base ${BV_SYQURE_PORT_BASE} (range ${SYQURE_PORT_BASE_MIN}-${SYQURE_PORT_BASE_MAX})"
	fi
fi

CLIENT1_EMAIL="${CLIENT1_EMAIL:-client1@sandbox.local}"
CLIENT2_EMAIL="${CLIENT2_EMAIL:-client2@sandbox.local}"
AGG_EMAIL="${AGG_EMAIL:-aggregator@sandbox.local}"
SANDBOX_ROOT="${SANDBOX_DIR:-$BIOVAULT_DIR/sandbox}"
SERVER_PID=""
TAURI1_PID=""
TAURI2_PID=""
TAURI3_PID=""
AGG_HOME=""
AGG_CFG=""
SYQURE_WATCH_PID=""

# Pick a free unified logger port unless explicitly configured
LOG_PORT_MAX="${UNIFIED_LOG_PORT_MAX:-9856}"
if [[ "$UNIFIED_LOG_PORT_EXPLICIT" == "1" ]]; then
	if ! is_port_free "$LOG_PORT"; then
		echo "UNIFIED_LOG_PORT=$LOG_PORT is already in use; choose a different port" >&2
		exit 1
	fi
else
	LOG_PORT="$(pick_free_port_randomized "$LOG_PORT_MIN" "$LOG_PORT_MAX" || true)"
	if [[ -z "$LOG_PORT" ]]; then
		echo "No available unified logger port between ${LOG_PORT_MIN} and ${LOG_PORT_MAX}" >&2
		exit 1
	fi
fi

# Start unified logger
UNIFIED_LOG_HOST="${UNIFIED_LOG_HOST:-127.0.0.1}"
export UNIFIED_LOG_HOST
info "Starting unified logger on ${UNIFIED_LOG_HOST}:${LOG_PORT} (file: ${LOG_FILE})"
UNIFIED_LOG_WS_URL="ws://${UNIFIED_LOG_HOST}:${LOG_PORT}"
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

if ! wait_for_listener "$LOG_PORT" "$LOGGER_PID" "unified logger" "${UNIFIED_LOG_WAIT_S:-5}"; then
	logger_required="${UNIFIED_LOG_REQUIRED:-0}"
	logger_required_lc="$(printf '%s' "$logger_required" | tr '[:upper:]' '[:lower:]')"
	if [[ "$logger_required_lc" == "1" || "$logger_required_lc" == "true" || "$logger_required_lc" == "yes" || "$logger_required_lc" == "on" ]]; then
		echo "Unified logger failed to start on :${LOG_PORT}" >&2
		exit 1
	fi
	echo "Warning: Unified logger failed to start on :${LOG_PORT}; continuing without unified WS logs" >&2
	kill "$LOGGER_PID" >/dev/null 2>&1 || true
	LOGGER_PID=""
	UNIFIED_LOG_WS_URL=""
fi

is_enabled_flag() {
	local value
	value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
	[[ "$value" == "1" || "$value" == "true" || "$value" == "yes" || "$value" == "on" ]]
}

stop_syqure_watchdog() {
	if [[ -n "${SYQURE_WATCH_PID:-}" ]]; then
		kill "$SYQURE_WATCH_PID" 2>/dev/null || true
		wait "$SYQURE_WATCH_PID" 2>/dev/null || true
		SYQURE_WATCH_PID=""
	fi
}

start_syqure_watchdog() {
	local flow_name="$1"
	local enabled="${SYQURE_MULTIPARTY_WATCH:-1}"
	local interval="${SYQURE_MULTIPARTY_WATCH_INTERVAL:-2}"
	local watcher="$ROOT_DIR/scripts/watch_syqure_multiparty.py"
	if ! is_enabled_flag "$enabled"; then
		return 0
	fi
	if [[ ! -f "$watcher" ]]; then
		info "Syqure watcher script not found: $watcher"
		return 0
	fi
	stop_syqure_watchdog
	info "Starting Syqure watcher (flow=${flow_name}, interval=${interval}s)"
	python3 "$watcher" \
		--sandbox "$SANDBOX_ROOT" \
		--flow "$flow_name" \
		--interval "$interval" \
		--prefix "[syq-watch]" &
	SYQURE_WATCH_PID=$!
}

kill_stale_syftboxd_locks() {
	local sandbox_root="$1"
	local matched=0

	# Previous no-cleanup runs can leave embedded `bv syftboxd start --foreground`
	# processes alive, which hold workspace locks and prevent devstack clients
	# from starting their own daemons.
	local pids
	pids="$(
		ps -axo pid=,command= 2>/dev/null | awk '
			/(^|[[:space:]])(bv|biovault)([[:space:]]|$)/ &&
			/(^|[[:space:]])syftboxd([[:space:]]|$)/ &&
			/(^|[[:space:]])start([[:space:]]|$)/ &&
			/(^|[[:space:]])--foreground([[:space:]]|$)/ {
				print $1
			}
		' || true
	)"

	while IFS= read -r pid; do
		[[ -z "${pid:-}" ]] && continue
		local cmd_with_env
		cmd_with_env="$(ps eww -p "$pid" -o command= 2>/dev/null || true)"
		if [[ -z "$cmd_with_env" ]]; then
			continue
		fi
		if [[ "$cmd_with_env" == *"$sandbox_root"* ]]; then
			info "Killing stale syftboxd lock holder pid=$pid (sandbox=$sandbox_root)"
			kill "$pid" 2>/dev/null || true
			matched=1
		fi
	done <<< "$pids"

	if [[ "$matched" == "1" ]]; then
		sleep 1
	fi
}

cleanup() {
	if [[ "$CLEANUP_ACTIVE" == "1" ]]; then
		return
	fi
	CLEANUP_ACTIVE=1
	stop_syqure_watchdog
	pause_for_interactive_exit
	if [[ "$NO_CLEANUP" == "1" || "$NO_CLEANUP" == "true" ]]; then
		info "No-cleanup mode enabled; leaving static server/Tauri/logger/devstack running."
		return
	fi

	if [[ -n "${SERVER_PID:-}" ]]; then
		info "Stopping static server"
		kill "$SERVER_PID" 2>/dev/null || true
	fi
	if [[ -n "${TAURI1_PID:-}" || -n "${TAURI2_PID:-}" || -n "${TAURI3_PID:-}" ]]; then
		info "Stopping Tauri instances"
		[[ -n "${TAURI1_PID:-}" ]] && kill "$TAURI1_PID" 2>/dev/null || true
		[[ -n "${TAURI2_PID:-}" ]] && kill "$TAURI2_PID" 2>/dev/null || true
		[[ -n "${TAURI3_PID:-}" ]] && kill "$TAURI3_PID" 2>/dev/null || true
	fi
	# Profiles switching can restart the Tauri process (new PID). Ensure we kill any lingering
	# WS-bridge listeners for the selected ports (ports were chosen to be free for this run).
	if command -v lsof >/dev/null 2>&1; then
		for port in "${DEV_WS_BRIDGE_PORT_BASE:-}" \
			"$(( ${DEV_WS_BRIDGE_PORT_BASE:-0} + 1 ))" \
			"$(( ${DEV_WS_BRIDGE_PORT_BASE:-0} + 2 ))"; do
			if [[ -z "${port:-}" || "$port" -le 0 ]]; then
				continue
			fi
			local pids
			pids="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ' || true)"
			if [[ -n "${pids:-}" ]]; then
				info "Killing lingering WS listeners on :$port (pids: $pids)"
				kill $pids 2>/dev/null || true
			fi
		done
	fi
	if [[ -n "${LOGGER_PID:-}" ]]; then
		info "Stopping unified logger"
		kill "$LOGGER_PID" 2>/dev/null || true
	fi
	# Clean up any Jupyter processes spawned during this run
	kill_workspace_jupyter

	if [[ "${KEEP_ALIVE:-0}" != "1" && "${KEEP_ALIVE:-0}" != "true" && "${WAIT_MODE:-0}" != "1" && "${WAIT_MODE:-0}" != "true" ]]; then
		if [[ "$DEVSTACK_STARTED" == "1" && "$SCENARIO" != "profiles-mock" && "$SCENARIO" != "files-cli" ]]; then
			info "Stopping SyftBox devstack"
			local c1="${CLIENT1_EMAIL:-client1@sandbox.local}"
			local c2="${CLIENT2_EMAIL:-client2@sandbox.local}"
			local agg="${AGG_EMAIL:-aggregator@sandbox.local}"
			local sandbox_root="${SANDBOX_ROOT:-$BIOVAULT_DIR/sandbox}"
			if [[ "$SCENARIO" == "syqure-flow" || "$SCENARIO" == "pipelines-multiparty" || "$SCENARIO" == "pipelines-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-allele-freq" ]]; then
				DEVSTACK_CLIENTS="${c1},${c2},${agg}"
			else
				DEVSTACK_CLIENTS="${c1},${c2}"
			fi
			local stop_args=(--clients "$DEVSTACK_CLIENTS" --sandbox "$sandbox_root" --stop)
			if [[ "$DEVSTACK_RESET" == "1" || "$DEVSTACK_RESET" == "true" ]]; then
				stop_args+=(--reset)
			fi
			bash "$DEVSTACK_SCRIPT" "${stop_args[@]}" >/dev/null 2>&1 || true
		fi
	fi

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

if [[ "$SCENARIO" != "profiles-mock" && "$SCENARIO" != "files-cli" ]]; then
	# Clear stale syftboxd lock holders from prior no-cleanup runs before touching devstack.
	kill_stale_syftboxd_locks "$SANDBOX_ROOT"

	# Start devstack with two or three clients (reset by default to avoid stale state)
	if [[ "$SCENARIO" == "syqure-flow" || "$SCENARIO" == "pipelines-multiparty" || "$SCENARIO" == "pipelines-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-allele-freq" ]]; then
		info "Ensuring SyftBox devstack with three clients (reset=${DEVSTACK_RESET})"
		DEVSTACK_CLIENTS="${CLIENT1_EMAIL},${CLIENT2_EMAIL},${AGG_EMAIL}"
	else
		info "Ensuring SyftBox devstack with two clients (reset=${DEVSTACK_RESET})"
		DEVSTACK_CLIENTS="${CLIENT1_EMAIL},${CLIENT2_EMAIL}"
	fi
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
        if [[ "${DEVSTACK_SKIP_CLIENT_DAEMONS:-}" == "1" || "${DEVSTACK_SKIP_CLIENT_DAEMONS:-}" == "true" ]]; then
                DEVSTACK_ARGS+=(--skip-client-daemons)
        fi
	timer_push "Devstack start"
	bash "$DEVSTACK_SCRIPT" "${DEVSTACK_ARGS[@]}" >/dev/null
	timer_pop
	DEVSTACK_STARTED=1
fi

# Read devstack state for client configs (not needed for mock-only scenarios)
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
if [[ "$SCENARIO" != "profiles-mock" && "$SCENARIO" != "files-cli" ]]; then
	if [[ -z "$STATE_FILE" ]]; then
		echo "Devstack state not found in $SANDBOX_ROOT" >&2
		exit 1
	fi
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

if [[ "$SCENARIO" != "profiles-mock" && "$SCENARIO" != "files-cli" ]]; then
	CLIENT1_HOME="$(parse_field "$CLIENT1_EMAIL" home_path)"
	CLIENT2_HOME="$(parse_field "$CLIENT2_EMAIL" home_path)"
	CLIENT1_CFG="$(parse_field "$CLIENT1_EMAIL" config)"
	CLIENT2_CFG="$(parse_field "$CLIENT2_EMAIL" config)"
	if [[ "$SCENARIO" == "syqure-flow" || "$SCENARIO" == "pipelines-multiparty" || "$SCENARIO" == "pipelines-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-allele-freq" ]]; then
		AGG_HOME="$(parse_field "$AGG_EMAIL" home_path)"
		AGG_CFG="$(parse_field "$AGG_EMAIL" config)"
	fi
	SERVER_URL="$(python3 - "$STATE_FILE" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
print(f"http://127.0.0.1:{state['server']['port']}")
PY
	)"

	info "Client1 home: $CLIENT1_HOME"
	info "Client2 home: $CLIENT2_HOME"
	if [[ "$SCENARIO" == "syqure-flow" || "$SCENARIO" == "pipelines-multiparty" || "$SCENARIO" == "pipelines-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-allele-freq" ]]; then
		info "Aggregator home: $AGG_HOME"
	fi
	info "Server URL: $SERVER_URL"
fi

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
	local default_timeout=30
	case "$(uname -s)" in
		MINGW*|MSYS*|CYGWIN*|Windows_NT) default_timeout=90 ;;
	esac
	local timeout_s="${DEVSTACK_SYNC_TIMEOUT:-$default_timeout}"
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
	# Try to start a minimal Node.js static server, return 0 on success, 1 on failure
	local port="$1"
	local src_dir="$2"
	local timeout_s="${3:-10}"

	info "[DEBUG] Trying Node.js static server on port $port"
	node "$ROOT_DIR/tests/static-server.js" "$src_dir" "$port" "127.0.0.1" >>"$LOG_FILE" 2>&1 &
	SERVER_PID=$!

	sleep 1
	if ! kill -0 "$SERVER_PID" 2>/dev/null; then
		info "[DEBUG] Node static server process died immediately"
		return 1
	fi

	if wait_for_listener "$port" "$SERVER_PID" "node static server" "$timeout_s" 2>/dev/null; then
		info "[DEBUG] Node static server is listening"
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
			echo "No available port between ${UI_PORT_MIN} and ${MAX_PORT}" >&2
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

resolve_tauri_profile() {
	local profile="${TAURI_PROFILE:-release}"
	if [[ "$TAURI_BINARY" == *"/target/debug/"* ]]; then
		profile="debug"
	fi
	echo "$profile"
}

assert_tauri_binary_present() {
	TAURI_BINARY="${TAURI_BINARY:-$ROOT_DIR/src-tauri/target/release/bv-desktop}"
	local profile
	profile="$(resolve_tauri_profile)"
	info "[DEBUG] assert_tauri_binary_present: checking $TAURI_BINARY (profile=$profile)"
	if [[ ! -x "$TAURI_BINARY" ]]; then
		# Binary doesn't exist - auto-build if AUTO_REBUILD_TAURI is enabled (default)
		local auto_rebuild="${AUTO_REBUILD_TAURI:-1}"
		if [[ "$auto_rebuild" != "0" && "$auto_rebuild" != "false" && "$auto_rebuild" != "no" ]]; then
			if [[ "$profile" == "debug" ]]; then
				info "Tauri binary not found, building debug (cd src-tauri && cargo build)..."
				timer_push "Cargo build (tauri debug - initial)"
				(cd "$ROOT_DIR/src-tauri" && cargo build) >&2
			else
				info "Tauri binary not found, building release (cd src-tauri && cargo build --release)..."
				timer_push "Cargo build (tauri release - initial)"
				(cd "$ROOT_DIR/src-tauri" && cargo build --release) >&2
			fi
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
		echo "Tauri binary not found at $TAURI_BINARY - run 'npm run build' first" >&2
		exit 1
	fi
	info "[DEBUG] Tauri binary found and executable"
}

assert_tauri_binary_fresh() {
	# Guardrail: stale binaries silently break harness assumptions (e.g. env var parsing).
	info "[DEBUG] assert_tauri_binary_fresh: checking if binary is up to date"
	info "[DEBUG] TAURI_BINARY=$TAURI_BINARY"
	local profile
	profile="$(resolve_tauri_profile)"
	info "[DEBUG] Binary mtime: $(stat -f '%Sm' "$TAURI_BINARY" 2>/dev/null || stat -c '%y' "$TAURI_BINARY" 2>/dev/null || echo 'unknown')"

	local newer=""
	local candidates=(
		"$ROOT_DIR/src-tauri/src"
		"$ROOT_DIR/src-tauri/Cargo.toml"
		"$ROOT_DIR/src-tauri/Cargo.lock"
		"$BIOVAULT_DIR/cli/src"
		"$BIOVAULT_DIR/cli/build.rs"
		"$BIOVAULT_DIR/cli/Cargo.toml"
		"$BIOVAULT_DIR/cli/Cargo.lock"
		"$BIOVAULT_BEAVER_DIR/python/src/beaver/__init__.py"
		"$SYFTBOX_SDK_DIR/src"
		"$SYFTBOX_SDK_DIR/Cargo.toml"
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
			if [[ "$profile" == "debug" ]]; then
				echo "Rebuilding debug (cd src-tauri && cargo build)..." >&2
				timer_push "Cargo build (tauri debug)"
				(cd "$ROOT_DIR/src-tauri" && cargo build) >&2
			else
				echo "Rebuilding release (cd src-tauri && cargo build --release)..." >&2
				timer_push "Cargo build (tauri release)"
				(cd "$ROOT_DIR/src-tauri" && cargo build --release) >&2
			fi
			timer_pop
			return 0
		fi
		echo "[DEBUG] ERROR: Rebuild required but AUTO_REBUILD_TAURI=$auto_rebuild prevents it" >&2
		echo "Rebuild required: (cd src-tauri && cargo build --release) or 'npm run build'." >&2
		echo "Tip: set AUTO_REBUILD_TAURI=1 to auto-rebuild." >&2
		exit 1
	fi
	info "[DEBUG] Tauri binary is up to date (no newer source files found)"
}

syqure_platform_id() {
	local os_name arch_name os_label arch_label
	os_name="$(uname -s | tr '[:upper:]' '[:lower:]')"
	arch_name="$(uname -m | tr '[:upper:]' '[:lower:]')"
	os_label="$os_name"
	arch_label="$arch_name"
	case "$os_name" in
		darwin) os_label="macos" ;;
		linux) os_label="linux" ;;
	esac
	case "$arch_name" in
		arm64|aarch64) arch_label="arm64" ;;
		x86_64|amd64|i386|i686) arch_label="x86" ;;
	esac
	echo "${os_label}-${arch_label}"
}

syqure_repo_root_from_bin() {
	local bin_path="$1"
	if [[ -z "$bin_path" ]]; then
		return 0
	fi
	if [[ "$bin_path" == */target/release/syqure || "$bin_path" == */target/debug/syqure ]]; then
		(cd "$(dirname "$bin_path")/../.." && pwd -P)
		return 0
	fi
	echo ""
}

configure_syqure_runtime_env() {
	if [[ "$SCENARIO" != "syqure-flow" && "$SCENARIO" != "syqure-multiparty-flow" && "$SCENARIO" != "syqure-multiparty-allele-freq" ]]; then
		return 0
	fi
	if [[ -z "${SEQURE_NATIVE_BIN:-}" || ! -x "${SEQURE_NATIVE_BIN:-}" ]]; then
		return 0
	fi
	local syq_root platform codon_candidate
	syq_root="$(syqure_repo_root_from_bin "$SEQURE_NATIVE_BIN")"
	if [[ -z "$syq_root" || ! -d "$syq_root" ]]; then
		return 0
	fi

	# Prefer local prebuilt Codon/Sequre tree in this workspace.
	if [[ -z "${CODON_PATH:-}" ]]; then
		platform="$(syqure_platform_id)"
		codon_candidate="$syq_root/bin/${platform}/codon"
		if [[ -d "$codon_candidate/lib/codon" ]]; then
			export CODON_PATH="$codon_candidate"
		fi
	fi

	info "Syqure runtime env: SYQURE_SKIP_BUNDLE=${SYQURE_SKIP_BUNDLE:-unset} CODON_PATH=${CODON_PATH:-unset}"
}

assert_syqure_binary_fresh() {
	if [[ "$SCENARIO" != "syqure-flow" && "$SCENARIO" != "syqure-multiparty-flow" && "$SCENARIO" != "syqure-multiparty-allele-freq" ]]; then
		return 0
	fi
	if [[ -z "${SEQURE_NATIVE_BIN:-}" || ! -x "${SEQURE_NATIVE_BIN:-}" ]]; then
		return 0
	fi

	local syq_root profile newer auto_rebuild
	syq_root="$(syqure_repo_root_from_bin "$SEQURE_NATIVE_BIN")"
	if [[ -z "$syq_root" || ! -d "$syq_root" ]]; then
		return 0
	fi
	profile="release"
	if [[ "$SEQURE_NATIVE_BIN" == */target/debug/* ]]; then
		profile="debug"
	fi
	info "[DEBUG] assert_syqure_binary_fresh: checking $SEQURE_NATIVE_BIN ($profile)"

	local candidates=(
		"$syq_root/syqure/src"
		"$syq_root/syqure/build.rs"
		"$syq_root/syqure/Cargo.toml"
		"$syq_root/Cargo.toml"
		"$syq_root/Cargo.lock"
		"$syq_root/sequre/stdlib"
		"$syq_root/sequre/plugin.toml"
	)
	newer=""
	for p in "${candidates[@]}"; do
		if [[ -f "$p" ]]; then
			if [[ "$p" -nt "$SEQURE_NATIVE_BIN" ]]; then
				newer="$p"
				break
			fi
		elif [[ -d "$p" ]]; then
			newer="$(find "$p" -type f -newer "$SEQURE_NATIVE_BIN" -print -quit 2>/dev/null || true)"
			if [[ -n "$newer" ]]; then
				break
			fi
		fi
	done
	if [[ -z "$newer" ]]; then
		info "[DEBUG] Syqure binary is up to date"
		return 0
	fi

	auto_rebuild="${AUTO_REBUILD_SYQURE:-1}"
	info "[DEBUG] Syqure binary is older than sources (e.g. $newer); AUTO_REBUILD_SYQURE=$auto_rebuild"
	if [[ "$auto_rebuild" == "0" || "$auto_rebuild" == "false" || "$auto_rebuild" == "no" ]]; then
		echo "Syqure rebuild required: (cd $syq_root && cargo build -p syqure --release)" >&2
		exit 1
	fi

	# A plain `cargo build` can be a no-op for Sequre/Codon source changes because
	# Cargo does not track those files directly. Force a clean rebuild whenever we
	# already know the binary is stale to ensure the runtime bundle is refreshed.
	info "[DEBUG] Forcing clean syqure rebuild because source mtime is newer than binary"
	(cd "$syq_root" && cargo clean -p syqure) >&2 || true

	timer_push "Cargo build (syqure release)"
	if ! (cd "$syq_root" && cargo build -p syqure --release) >&2; then
		info "Syqure release build failed; rebuilding bundle then retrying"
		(cd "$syq_root" && ZSTD_NBTHREADS=1 ./syqure_bins.sh) >&2
		(cd "$syq_root" && cargo build -p syqure --release) >&2
	fi
	timer_pop
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
                if [[ "$DEVSTACK_CLIENT_MODE" == "embedded" ]]; then
                        export BV_SYFTBOX_BACKEND=embedded
                fi
		# Profiles tests manage SYC_VAULT based on the selected BIOVAULT_HOME (per-profile vault).
		# Other scenarios keep a fixed vault path per client for simplicity.
		if [[ "$SCENARIO" != "profiles" ]]; then
			export SYC_VAULT="$home/.syc"
		fi
		# Keep the profiles store isolated under the sandbox HOME by default.
		if [[ -z "${BIOVAULT_PROFILES_PATH:-}" && -z "${BIOVAULT_PROFILES_DIR:-}" ]]; then
			export BIOVAULT_PROFILES_DIR="$home/.bvprofiles"
		fi
		# Avoid Docker credential helper issues in non-interactive sessions by using
		# a per-sandbox Docker config without credsStore.
		export DOCKER_CONFIG="$home/.docker"
		mkdir -p "$DOCKER_CONFIG"
		cat >"$DOCKER_CONFIG/config.json" <<'EOF'
{"auths":{"ghcr.io":{"auth":"Og=="}}}
EOF
		export BIOVAULT_DOCKER_CONFIG="$DOCKER_CONFIG"
		export DEV_WS_BRIDGE=1
		export DEV_WS_BRIDGE_PORT="$ws_port"
		# Avoid WS/HTTP port collisions when multiple clients run in one host.
		export DEV_WS_BRIDGE_HTTP_PORT="$((ws_port + 1000))"
		export DISABLE_UPDATER=1
		# Set unique service name for telemetry (uses email as identifier)
		if [[ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]]; then
			export OTEL_SERVICE_NAME="$email"
		fi
		# Prefer bundled uv for Jupyter if available (avoids missing uv on PATH)
		if [[ -z "${BIOVAULT_BUNDLED_UV:-}" ]]; then
			bundled_uv="$(find_bundled_uv || true)"
			if [[ -n "$bundled_uv" ]]; then
				export BIOVAULT_BUNDLED_UV="$bundled_uv"
			fi
		fi
		# Skip Jupyter auto-opening browser in non-interactive mode (Playwright controls the browser)
		if [[ "${INTERACTIVE_MODE:-0}" != "1" ]]; then
			export JUPYTER_SKIP_BROWSER=1
		fi
		# Prefer bundled uv for Jupyter if available (avoids missing uv on PATH)
		if [[ -z "${BIOVAULT_BUNDLED_UV:-}" ]]; then
			bundled_uv="$(find_bundled_uv || true)"
			if [[ -n "$bundled_uv" ]]; then
				export BIOVAULT_BUNDLED_UV="$bundled_uv"
			fi
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
	if [[ "$SCENARIO" == "syqure-flow" || "$SCENARIO" == "syqure-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-allele-freq" ]]; then
		if [[ -z "${SEQURE_NATIVE_BIN:-}" ]]; then
			local syqure_candidates=(
				"$WORKSPACE_ROOT/syqure/target/release/syqure"
				"$WORKSPACE_ROOT/syqure/target/debug/syqure"
				"$BIOVAULT_DIR/../syqure/target/release/syqure"
				"$BIOVAULT_DIR/../syqure/target/debug/syqure"
			)
			local candidate
			for candidate in "${syqure_candidates[@]}"; do
				if [[ -x "$candidate" ]]; then
					export SEQURE_NATIVE_BIN="$candidate"
					info "Using SEQURE_NATIVE_BIN=$SEQURE_NATIVE_BIN"
					break
				fi
			done
		fi

		if [[ -z "${SEQURE_NATIVE_BIN:-}" && -z "${BV_SYQURE_USE_DOCKER:-}" ]]; then
			export BV_SYQURE_USE_DOCKER=1
			info "Syqure binary not found; defaulting BV_SYQURE_USE_DOCKER=1"
		fi

		configure_syqure_runtime_env
		assert_syqure_binary_fresh
	fi

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

	if [[ "$SCENARIO" == "syqure-flow" || "$SCENARIO" == "pipelines-multiparty" || "$SCENARIO" == "pipelines-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-allele-freq" ]]; then
		info "Launching Tauri for aggregator on WS port $((WS_PORT_BASE + 2))"
		TAURI3_PID=$(launch_instance "$AGG_EMAIL" "$AGG_HOME" "$AGG_CFG" "$((WS_PORT_BASE + 2))")
		info "Waiting for aggregator WS bridge..."
		wait_ws "$((WS_PORT_BASE + 2))" "$TAURI3_PID" "$AGG_EMAIL" || {
			echo "WS $((WS_PORT_BASE + 2)) not ready" >&2
			exit 1
		}
	fi

	export UNIFIED_LOG_WS="$UNIFIED_LOG_WS_URL"
	export USE_REAL_INVOKE=true

	info "Client1 UI: ${UI_BASE_URL}?ws=${WS_PORT_BASE}&real=1"
	info "Client2 UI: ${UI_BASE_URL}?ws=$((WS_PORT_BASE + 1))&real=1"
	if [[ "$SCENARIO" == "syqure-flow" || "$SCENARIO" == "pipelines-multiparty" || "$SCENARIO" == "pipelines-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-flow" || "$SCENARIO" == "syqure-multiparty-allele-freq" ]]; then
		info "Aggregator UI: ${UI_BASE_URL}?ws=$((WS_PORT_BASE + 2))&real=1"
	fi
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
	local uv_bin="${UV_BIN:-}"
	if [[ -z "$uv_bin" ]]; then
		uv_bin="$(command -v uv 2>/dev/null || echo "")"
	fi
	if [[ -z "$uv_bin" ]]; then
		local bundled_uv="${BIOVAULT_BUNDLED_UV:-}"
		if [[ -z "$bundled_uv" ]]; then
			bundled_uv="$(find_bundled_uv 2>/dev/null || echo "")"
		fi
		if [[ -x "$bundled_uv" ]]; then
			uv_bin="$bundled_uv"
		fi
	fi
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
	beaver_version="$(grep '^__version__' "$BIOVAULT_BEAVER_DIR/python/src/beaver/__init__.py" 2>/dev/null | sed 's/.*"\([^"]*\)".*/\1/' || echo "0.1.26")"

	# Install PyPI packages first
	timer_push "Jupyter cache: pip install (pypi)"
	info "Installing PyPI packages (jupyterlab, biovault-beaver==$beaver_version)..."
	"$uv_bin" pip install --python "$cache_dir/.venv" -U jupyterlab cleon "biovault-beaver[lib-support]==$beaver_version" >>"$LOG_FILE" 2>&1 || true
	timer_pop

	# Install local editable syftbox-sdk if available
        local syftbox_path="$SYFTBOX_SDK_DIR/python"
        local syftbox_path_host
        syftbox_path_host="$(to_host_path "$syftbox_path")"
        if [[ -d "$syftbox_path" ]]; then
                timer_push "Jupyter cache: pip install (syftbox-sdk)"
                info "Installing syftbox-sdk from local source (compiling Rust bindings)..."
                "$uv_bin" pip install --python "$cache_dir/.venv" -e "$syftbox_path_host" >>"$LOG_FILE" 2>&1 || {
                        info "Warning: Failed to install syftbox-sdk from local path"
                }
                timer_pop
        fi

        # Install local editable beaver if available
        local beaver_path="$BIOVAULT_BEAVER_DIR/python"
        local beaver_path_host
        beaver_path_host="$(to_host_path "$beaver_path")"
        if [[ -d "$beaver_path" ]]; then
                timer_push "Jupyter cache: pip install (beaver)"
                info "Installing beaver from local source..."
                "$uv_bin" pip install --python "$cache_dir/.venv" -e "${beaver_path_host}[lib-support]" >>"$LOG_FILE" 2>&1 || {
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

	cmd+=(npm run test:ui -- --grep "$grep_pat")
	append_array_items cmd PLAYWRIGHT_OPTS
	append_array_items cmd FORWARD_ARGS

	"${cmd[@]}" | tee -a "$LOG_FILE"
}

prepare_allele_freq_ui_inputs() {
	local gen_script="$ROOT_DIR/biovault/tests/scripts/gen_allele_freq_data.sh"
	local file_count="${ALLELE_FREQ_COUNT:-10}"
	local force_regen="${ALLELE_FREQ_FORCE_REGEN:-0}"
	local c1_out="$CLIENT1_HOME/private/app_data/biovault/allele-freq-data"
	local c2_out="$CLIENT2_HOME/private/app_data/biovault/allele-freq-data"

	if [[ ! -f "$gen_script" ]]; then
		error "Missing allele-freq generator script: $gen_script"
		exit 1
	fi

	timer_push "Prepare allele-freq inputs"
	info "Preparing allele-freq synthetic inputs for UI run (count=${file_count})"

	local -a force_args=()
	if [[ "$force_regen" == "1" || "$force_regen" == "true" || "$force_regen" == "yes" ]]; then
		force_args=(--force)
	fi

	bash "$gen_script" \
		--output-dir "$c1_out" \
		--count "$file_count" \
		--seed "${ALLELE_FREQ_CLIENT1_SEED:-42}" \
		--apol1-het "${ALLELE_FREQ_CLIENT1_APOL1_HET:-0.6}" \
		--apol1-hom-alt "${ALLELE_FREQ_CLIENT1_APOL1_HOM_ALT:-0.2}" \
		--no-call-frequency "${ALLELE_FREQ_NO_CALL_FREQUENCY:-0.2}" \
		--no-call-token "${ALLELE_FREQ_NO_CALL_TOKEN:--}" \
		"${force_args[@]}" >>"$LOG_FILE" 2>&1

	bash "$gen_script" \
		--output-dir "$c2_out" \
		--count "$file_count" \
		--seed "${ALLELE_FREQ_CLIENT2_SEED:-43}" \
		--thal-het "${ALLELE_FREQ_CLIENT2_THAL_HET:-0.5}" \
		--thal-hom-alt "${ALLELE_FREQ_CLIENT2_THAL_HOM_ALT:-0.3}" \
		--no-call-frequency "${ALLELE_FREQ_NO_CALL_FREQUENCY:-0.2}" \
		--no-call-token "${ALLELE_FREQ_NO_CALL_TOKEN:--}" \
		"${force_args[@]}" >>"$LOG_FILE" 2>&1

	info "Prepared allele-freq inputs:"
	info "  client1: ${c1_out}"
	info "  client2: ${c2_out}"
	timer_pop
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

# Ensure Playwright browsers are present (CI may skip install or have empty cache)
if [[ "$SCENARIO" != "files-cli" ]]; then
	ensure_playwright_browsers
fi

	case "$SCENARIO" in
			onboarding)
				start_static_server
				start_tauri_instances
				timer_push "Playwright: @onboarding-two"
				run_ui_grep "@onboarding-two"
				timer_pop
				;;
			profiles)
				start_static_server
				# Profiles test only needs one client, but uses the real backend.
				assert_tauri_binary_present
				assert_tauri_binary_fresh
				export BIOVAULT_ALLOW_NEW_INSTANCE_IN_DEV=1
				export BIOVAULT_SPAWN_PROBE_PATH="$CLIENT1_HOME/profiles/new-instance-probe.json"

				timer_push "Tauri instance start (single)"
				info "Launching Tauri for client1 on WS port $WS_PORT_BASE"
				TAURI1_PID=$(launch_instance "$CLIENT1_EMAIL" "$CLIENT1_HOME" "$CLIENT1_CFG" "$WS_PORT_BASE")
				info "Waiting for WS bridge..."
				wait_ws "$WS_PORT_BASE" || { echo "WS $WS_PORT_BASE not ready" >&2; exit 1; }
				timer_pop

				export UNIFIED_LOG_WS="$UNIFIED_LOG_WS_URL"
				export USE_REAL_INVOKE=true
				# Provide deterministic homes for the test under the sandbox.
				export PROFILES_HOME_A="$CLIENT1_HOME"
				export PROFILES_HOME_B="$CLIENT1_HOME/profiles/profileB"
				# Match the BIOVAULT_PROFILES_DIR set in launch_instance for consistency.
				export BIOVAULT_PROFILES_DIR="$CLIENT1_HOME/.bvprofiles"
				timer_push "Playwright: @profiles-real-linux"
				run_ui_grep "@profiles-real-linux" "PROFILES_HOME_A=$PROFILES_HOME_A" "PROFILES_HOME_B=$PROFILES_HOME_B" "BIOVAULT_PROFILES_DIR=$BIOVAULT_PROFILES_DIR"
				timer_pop
				;;
		profiles-mock)
			start_static_server
			timer_push "Playwright: @profiles-mock"
			run_ui_grep "@profiles-mock"
			timer_pop
			;;
		files-cli)
			info "=== Files CLI Smoke Test ==="
			# Keep this scenario self-contained (no devstack/UI). Use a temp BV home.
			BV_TEST_HOME="${BV_TEST_HOME:-$ROOT_DIR/logs/files-cli-home}"
			BV_BIN="${BV_BIN:-$BIOVAULT_DIR/cli/target/release/bv}"
			rm -rf "$BV_TEST_HOME"
			mkdir -p "$BV_TEST_HOME"
			if [[ ! -x "$BV_BIN" ]]; then
				info "Building BioVault CLI (release)"
				timer_push "Cargo build (biovault cli release)"
				(cd "$BIOVAULT_DIR/cli" && cargo build --release) >>"$LOG_FILE" 2>&1
				timer_pop
			fi
			# Seed small dummy files.
			DATA_DIR="$BV_TEST_HOME/data"
			mkdir -p "$DATA_DIR"
			printf "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\ts1\n1\t1\trs1\tA\tG\t.\tPASS\t.\tGT\t0/1\n" >"$DATA_DIR/P1.vcf"
			printf "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\ts1\n1\t2\trs2\tC\tT\t.\tPASS\t.\tGT\t0/1\n" | gzip -c >"$DATA_DIR/P2.vcf.gz"
			printf "cram" >"$DATA_DIR/P3.cram"
			printf "crai" >"$DATA_DIR/P3.cram.crai"
			printf "bam" >"$DATA_DIR/P4.bam"
			printf "bai" >"$DATA_DIR/P4.bam.bai"
			printf "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\ts1\n1\t3\trs3\tG\tA\t.\tPASS\t.\tGT\t0/1\n" >"$DATA_DIR/P5.vcf"
			printf "cram" >"$DATA_DIR/P5.cram"
			printf "crai" >"$DATA_DIR/P5.cram.crai"
			printf "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\ts1\n1\t4\trs4\tT\tC\t.\tPASS\t.\tGT\t0/1\n" >"$DATA_DIR/P6.vcf"
			printf "fasta" >"$DATA_DIR/ref.fa"
			printf "fai" >"$DATA_DIR/ref.fa.fai"
			# Create CSV for import pending.
			CSV="$BV_TEST_HOME/files.csv"
			cat >"$CSV" <<EOF
file_path,participant_id,data_type,source,grch_version,row_count,chromosome_count,inferred_sex
$DATA_DIR/P1.vcf,P1,Variants,,,,
$DATA_DIR/P2.vcf.gz,P2,Variants,,,,
$DATA_DIR/P3.cram,P3,Aligned,GRCh38,,,
$DATA_DIR/P4.bam,P4,Aligned,GRCh37,,,
$DATA_DIR/P5.cram,P5,AlignedWithRef,GRCh38,,,
$DATA_DIR/P5.cram.crai,P5,AlignedIndex,GRCh38,,,
$DATA_DIR/P6.vcf,P6,Variants,,,,
$DATA_DIR/ref.fa,P6,Reference,GRCh38,,,
$DATA_DIR/ref.fa.fai,P6,ReferenceIndex,GRCh38,,,
EOF
			# Import as pending and then process queue to finalize hashes.
			BIOVAULT_HOME="$BV_TEST_HOME/.biovault" "$BV_BIN" files import-pending "$CSV" --format json | tee -a "$LOG_FILE" >/dev/null
			BIOVAULT_HOME="$BV_TEST_HOME/.biovault" "$BV_BIN" files process-queue --limit 20 --format json | tee -a "$LOG_FILE" >/dev/null
			# Verify expected data types in catalog (smoke assertions).
			BIOVAULT_HOME="$BV_TEST_HOME/.biovault" "$BV_BIN" files list --format json >"$BV_TEST_HOME/files.json"
			python3 - "$BV_TEST_HOME/files.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
files = data.get("data", {}).get("files", [])
types = {}
for f in files:
    types.setdefault(f.get("data_type"), 0)
    types[f.get("data_type")] += 1
for required in ["Variants", "Aligned", "AlignedWithRef", "AlignedIndex", "Reference", "ReferenceIndex"]:
    if types.get(required, 0) <= 0:
        raise SystemExit(f"Missing expected data_type: {required}")
print("OK")
PY
			info "Files CLI smoke test complete"
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
	flows-gwas)
		start_static_server
		# GWAS flows test only needs a single client; keep it lightweight.
		TAURI_BINARY="${TAURI_BINARY:-$ROOT_DIR/src-tauri/target/release/bv-desktop}"
		if [[ ! -x "$TAURI_BINARY" ]]; then
			debug_bin="$ROOT_DIR/src-tauri/target/debug/bv-desktop"
			if [[ -x "$debug_bin" ]]; then
				info "Release Tauri binary not found; using debug binary at $debug_bin"
				TAURI_BINARY="$debug_bin"
				export TAURI_PROFILE=debug
			fi
		fi
		if [[ -x "$TAURI_BINARY" ]]; then
			assert_tauri_binary_fresh
			timer_push "Tauri instance start (single)"
			info "Launching Tauri for client1 on WS port $WS_PORT_BASE"
			TAURI1_PID=$(launch_instance "$CLIENT1_EMAIL" "$CLIENT1_HOME" "$CLIENT1_CFG" "$WS_PORT_BASE")
			info "Waiting for WS bridge..."
			wait_ws "$WS_PORT_BASE" || { echo "WS $WS_PORT_BASE not ready" >&2; exit 1; }
			timer_pop
			export USE_REAL_INVOKE=true
			info "Client1 UI: ${UI_BASE_URL}?ws=${WS_PORT_BASE}&real=1"
		else
			info "Tauri binary not found at $TAURI_BINARY; running flows tests in mock mode (no backend)"
			export USE_REAL_INVOKE=false
		fi
		export UNIFIED_LOG_WS="$UNIFIED_LOG_WS_URL"
		GWAS_DATA_DIR="${GWAS_DATA_DIR:-/Users/madhavajay/dev/biovaults/datasets/jordan_gwas}"
		export GWAS_DATA_DIR

		timer_push "Playwright: flows-gwas"
		UI_PORT="$UI_PORT" UI_BASE_URL="$UI_BASE_URL" GWAS_DATA_DIR="$GWAS_DATA_DIR" bun run test:ui tests/ui/flows-gwas.spec.ts ${PLAYWRIGHT_OPTS[@]+"${PLAYWRIGHT_OPTS[@]}"} ${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"} | tee -a "$LOG_FILE"
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

		# Verify static server is still alive before running Playwright
		info "[DEBUG] Verifying static server before Playwright..."
		if ! kill -0 "$SERVER_PID" 2>/dev/null; then
			info "[DEBUG] ERROR: Static server process $SERVER_PID has died!"
			info "[DEBUG] Checking what's on port $UI_PORT:"
			lsof -i ":$UI_PORT" 2>&1 || echo "lsof unavailable"
			info "[DEBUG] Last 50 lines of log:"
			tail -50 "$LOG_FILE" 2>/dev/null || echo "Cannot read log"
			exit 1
		fi
		if ! curl -s -o /dev/null -w "" --connect-timeout 2 "http://127.0.0.1:$UI_PORT/" 2>/dev/null; then
			info "[DEBUG] WARNING: Static server process alive but not responding to HTTP"
			info "[DEBUG] Checking lsof for port $UI_PORT:"
			lsof -i ":$UI_PORT" 2>&1 || echo "lsof unavailable"
		else
			info "[DEBUG] Static server responding OK on port $UI_PORT"
		fi

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
	flows-collab)
		start_static_server
		start_tauri_instances

		# Synthetic data configuration (same as flows-solo)
		SYNTHETIC_DATA_DIR="$ROOT_DIR/test-data/synthetic-genotypes"
		EXPECTED_FILE_COUNT=10
		FORCE_REGEN="${FORCE_REGEN_SYNTHETIC:-0}"
		CLEANUP_SYNTHETIC="${CLEANUP_SYNTHETIC:-0}"

		# Check if synthetic data exists
		EXISTING_COUNT=0
		if [[ -d "$SYNTHETIC_DATA_DIR" ]]; then
			EXISTING_COUNT=$(find "$SYNTHETIC_DATA_DIR" -name "*.txt" 2>/dev/null | wc -l | tr -d ' ')
		fi

		if [[ "$FORCE_REGEN" == "1" ]] || [[ "$EXISTING_COUNT" -lt "$EXPECTED_FILE_COUNT" ]]; then
			info "=== Generating synthetic genotype data for collaboration test ==="
			timer_push "Synthetic data generation"

			rm -rf "$SYNTHETIC_DATA_DIR"
			mkdir -p "$SYNTHETIC_DATA_DIR"

			if ! command -v bvs &>/dev/null; then
				info "Installing biosynth (bvs) CLI..."
				cargo install biosynth --locked 2>&1 | tee -a "$LOG_FILE" || {
					echo "Failed to install biosynth. Please run: cargo install biosynth" >&2
					exit 1
				}
			fi

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
				info "Generating $EXPECTED_FILE_COUNT synthetic files (without overlay)..."
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
		else
			info "Using existing synthetic data ($EXISTING_COUNT files)"
		fi

		# Run flows collaboration test
		info "=== Running Flows Collaboration Test ==="
		timer_push "Playwright: @flows-collab"
		run_ui_grep "@flows-collab" "SYNTHETIC_DATA_DIR=$SYNTHETIC_DATA_DIR" "INTERACTIVE_MODE=$INTERACTIVE_MODE"
		timer_pop

		# In wait mode, keep everything running
		if [[ "$WAIT_MODE" == "1" ]]; then
			info "Wait mode: Servers will stay running. Press Ctrl+C to exit."
			while true; do sleep 1; done
		fi
		;;
	syqure-flow)
		start_static_server
		start_tauri_instances

		info "=== Syqure Flow (interactive) ==="
		info "Open these URLs in your browser:"
		info "  Client1:     ${UI_BASE_URL}?ws=${WS_PORT_BASE}&real=1"
		info "  Client2:     ${UI_BASE_URL}?ws=$((WS_PORT_BASE + 1))&real=1"
		info "  Aggregator:  ${UI_BASE_URL}?ws=$((WS_PORT_BASE + 2))&real=1"
		info ""
		info "In the aggregator UI, open syqure-flow and use Collaborative Run."
		info "Datasites: ${AGG_EMAIL}, ${CLIENT1_EMAIL}, ${CLIENT2_EMAIL}"
		info "Then in client1/client2 Messages, Import Flow and Join Run."

		if [[ "$WAIT_MODE" == "1" || "$INTERACTIVE_MODE" == "1" ]]; then
			info "Interactive mode: Servers will stay running. Press Ctrl+C to exit."
			while true; do sleep 1; done
		fi
		;;
	pipelines-multiparty)
		start_static_server
		start_tauri_instances

		info "=== Multiparty Messaging Test ==="
		info "Three clients will exchange keys and hello messages."
		info ""
		info "Open these URLs in your browser:"
		info "  Client1:     ${UI_BASE_URL}?ws=${WS_PORT_BASE}&real=1"
		info "  Client2:     ${UI_BASE_URL}?ws=$((WS_PORT_BASE + 1))&real=1"
		info "  Client3:     ${UI_BASE_URL}?ws=$((WS_PORT_BASE + 2))&real=1"
		info ""
		info "Emails: ${CLIENT1_EMAIL}, ${CLIENT2_EMAIL}, ${AGG_EMAIL}"

		# Run the multiparty messaging test
		timer_push "Playwright: @pipelines-multiparty"
		# Match only the exact tag and exclude @pipelines-multiparty-flow.
		run_ui_grep "@pipelines-multiparty(?!-)" "INTERACTIVE_MODE=$INTERACTIVE_MODE"
		timer_pop

		# In wait mode, keep everything running
		if [[ "$WAIT_MODE" == "1" ]]; then
			info "Wait mode: Servers will stay running. Press Ctrl+C to exit."
			while true; do sleep 1; done
		fi
		;;
	pipelines-multiparty-flow)
		start_static_server
		start_tauri_instances

		info "=== Multiparty Flow Test ==="
		info "Three clients will execute a multiparty flow with manual steps."
		info ""
		info "Open these URLs in your browser:"
		info "  Client1:     ${UI_BASE_URL}?ws=${WS_PORT_BASE}&real=1"
		info "  Client2:     ${UI_BASE_URL}?ws=$((WS_PORT_BASE + 1))&real=1"
		info "  Aggregator:  ${UI_BASE_URL}?ws=$((WS_PORT_BASE + 2))&real=1"
		info ""
		info "Emails: ${CLIENT1_EMAIL}, ${CLIENT2_EMAIL}, ${AGG_EMAIL}"

		# Run the multiparty flow test
		timer_push "Playwright: @pipelines-multiparty-flow"
		run_ui_grep "@pipelines-multiparty-flow" "INTERACTIVE_MODE=$INTERACTIVE_MODE"
		timer_pop

		# In wait mode, keep everything running
		if [[ "$WAIT_MODE" == "1" ]]; then
			info "Wait mode: Servers will stay running. Press Ctrl+C to exit."
			while true; do sleep 1; done
		fi
		;;
	syqure-multiparty-flow)
		# Keep Syqure runtime env aligned with the distributed scenario defaults.
		# Allow callers to override explicitly via environment.
		export BV_SYFTBOX_HOTLINK="${BV_SYFTBOX_HOTLINK:-1}"
		export BV_SYFTBOX_HOTLINK_SOCKET_ONLY="${BV_SYFTBOX_HOTLINK_SOCKET_ONLY:-1}"
		export BV_SYFTBOX_HOTLINK_TCP_PROXY="${BV_SYFTBOX_HOTLINK_TCP_PROXY:-1}"
		export BV_SYFTBOX_HOTLINK_QUIC="${BV_SYFTBOX_HOTLINK_QUIC:-1}"
		export BV_SYFTBOX_HOTLINK_QUIC_ONLY="${BV_SYFTBOX_HOTLINK_QUIC_ONLY:-0}"
		export SYFTBOX_HOTLINK="${SYFTBOX_HOTLINK:-$BV_SYFTBOX_HOTLINK}"
		export SYFTBOX_HOTLINK_SOCKET_ONLY="${SYFTBOX_HOTLINK_SOCKET_ONLY:-$BV_SYFTBOX_HOTLINK_SOCKET_ONLY}"
		export SYFTBOX_HOTLINK_TCP_PROXY="${SYFTBOX_HOTLINK_TCP_PROXY:-$BV_SYFTBOX_HOTLINK_TCP_PROXY}"
		export SYFTBOX_HOTLINK_QUIC="${SYFTBOX_HOTLINK_QUIC:-$BV_SYFTBOX_HOTLINK_QUIC}"
		export SYFTBOX_HOTLINK_QUIC_ONLY="${SYFTBOX_HOTLINK_QUIC_ONLY:-$BV_SYFTBOX_HOTLINK_QUIC_ONLY}"
		if [[ -n "${SYQURE_SKIP_BUNDLE:-}" ]]; then
			export SYQURE_SKIP_BUNDLE
		fi
		if [[ -n "${SYFTBOX_HOTLINK_DEBUG:-}" ]]; then
			export SYFTBOX_HOTLINK_DEBUG
		fi
		if [[ -n "${SYQURE_DEBUG:-}" ]]; then
			export SYQURE_DEBUG
		fi
		info "Syqure UI env: HOTLINK=${BV_SYFTBOX_HOTLINK:-unset} SOCKET_ONLY=${BV_SYFTBOX_HOTLINK_SOCKET_ONLY:-unset} QUIC=${BV_SYFTBOX_HOTLINK_QUIC:-unset} QUIC_ONLY=${BV_SYFTBOX_HOTLINK_QUIC_ONLY:-unset} SKIP_BUNDLE=${SYQURE_SKIP_BUNDLE:-unset}"

		start_static_server
		start_tauri_instances

		# Mirror syqure-distributed mode/transport selection for secure-aggregate runtime.
		MODE="${BV_SYQURE_AGG_MODE:-smpc}"
		TRANSPORT="${BV_SYQURE_TRANSPORT:-hotlink}"
		MODULE_YAML="$ROOT_DIR/biovault/tests/scenarios/syqure-flow/modules/secure-aggregate/module.yaml"
		case "$MODE" in
			he) ENTRY="he_aggregate.codon" ;;
			smpc|"") ENTRY="smpc_aggregate.codon" ;;
			*)
				error "Unknown BV_SYQURE_AGG_MODE: $MODE (expected smpc|he)"
				exit 1
				;;
		esac
		python3 -c "import pathlib,re; path = pathlib.Path(r'${MODULE_YAML}'); text = path.read_text(); text = text.replace('entrypoint: smpc_aggregate.codon', f'entrypoint: ${ENTRY}'); text = text.replace('entrypoint: he_aggregate.codon', f'entrypoint: ${ENTRY}'); text = re.sub(r'transport: .*', f'transport: ${TRANSPORT}', text); path.write_text(text)"
		info "Syqure aggregation mode: ${MODE} (entrypoint: ${ENTRY}) transport: ${TRANSPORT}"

		info "=== Syqure Multiparty Flow Test ==="
		info "Three clients will execute biovault/tests/scenarios/syqure-flow/flow.yaml via collaborative run."
		if [[ "$SYQURE_MULTIPARTY_SECURE_ONLY" == "1" ]]; then
			info "Secure-only mode: running only secure_aggregate with seeded fixed inputs."
		fi
		if [[ "$SYQURE_MULTIPARTY_CLI_PARITY" == "1" ]]; then
			info "CLI-parity mode: backend=${BV_SYFTBOX_BACKEND:-unset} BV_SYQURE_TCP_PROXY=${BV_SYQURE_TCP_PROXY:-unset} BV_SYQURE_PORT_BASE=${BV_SYQURE_PORT_BASE:-auto}."
		fi
		info ""
		info "Open these URLs in your browser:"
		info "  Client1:     ${UI_BASE_URL}?ws=${WS_PORT_BASE}&real=1"
		info "  Client2:     ${UI_BASE_URL}?ws=$((WS_PORT_BASE + 1))&real=1"
		info "  Aggregator:  ${UI_BASE_URL}?ws=$((WS_PORT_BASE + 2))&real=1"
		info ""
		info "Emails: ${CLIENT1_EMAIL}, ${CLIENT2_EMAIL}, ${AGG_EMAIL}"

		timer_push "Playwright: @syqure-multiparty-flow"
		start_syqure_watchdog "syqure-flow"
		run_ui_grep "@syqure-multiparty-flow" "INTERACTIVE_MODE=$INTERACTIVE_MODE" "SYQURE_MULTIPARTY_SECURE_ONLY=$SYQURE_MULTIPARTY_SECURE_ONLY" "SYQURE_MULTIPARTY_CLI_PARITY=$SYQURE_MULTIPARTY_CLI_PARITY"
		stop_syqure_watchdog
		timer_pop

		if [[ "$WAIT_MODE" == "1" ]]; then
			info "Wait mode: Servers will stay running. Press Ctrl+C to exit."
			while true; do sleep 1; done
		fi
		;;
	syqure-multiparty-allele-freq)
		# Keep Syqure runtime env aligned with the distributed scenario defaults.
		# Allow callers to override explicitly via environment.
		export BV_SYFTBOX_HOTLINK="${BV_SYFTBOX_HOTLINK:-1}"
		export BV_SYFTBOX_HOTLINK_SOCKET_ONLY="${BV_SYFTBOX_HOTLINK_SOCKET_ONLY:-1}"
		export BV_SYFTBOX_HOTLINK_TCP_PROXY="${BV_SYFTBOX_HOTLINK_TCP_PROXY:-1}"
		export BV_SYFTBOX_HOTLINK_QUIC="${BV_SYFTBOX_HOTLINK_QUIC:-1}"
		export BV_SYFTBOX_HOTLINK_QUIC_ONLY="${BV_SYFTBOX_HOTLINK_QUIC_ONLY:-0}"
		export SYFTBOX_HOTLINK="${SYFTBOX_HOTLINK:-$BV_SYFTBOX_HOTLINK}"
		export SYFTBOX_HOTLINK_SOCKET_ONLY="${SYFTBOX_HOTLINK_SOCKET_ONLY:-$BV_SYFTBOX_HOTLINK_SOCKET_ONLY}"
		export SYFTBOX_HOTLINK_TCP_PROXY="${SYFTBOX_HOTLINK_TCP_PROXY:-$BV_SYFTBOX_HOTLINK_TCP_PROXY}"
		export SYFTBOX_HOTLINK_QUIC="${SYFTBOX_HOTLINK_QUIC:-$BV_SYFTBOX_HOTLINK_QUIC}"
		export SYFTBOX_HOTLINK_QUIC_ONLY="${SYFTBOX_HOTLINK_QUIC_ONLY:-$BV_SYFTBOX_HOTLINK_QUIC_ONLY}"
		if [[ -n "${SYQURE_SKIP_BUNDLE:-}" ]]; then
			export SYQURE_SKIP_BUNDLE
		fi
		if [[ -n "${SYFTBOX_HOTLINK_DEBUG:-}" ]]; then
			export SYFTBOX_HOTLINK_DEBUG
		fi
		if [[ -n "${SYQURE_DEBUG:-}" ]]; then
			export SYQURE_DEBUG
		fi
		info "Syqure UI env: HOTLINK=${BV_SYFTBOX_HOTLINK:-unset} SOCKET_ONLY=${BV_SYFTBOX_HOTLINK_SOCKET_ONLY:-unset} QUIC=${BV_SYFTBOX_HOTLINK_QUIC:-unset} QUIC_ONLY=${BV_SYFTBOX_HOTLINK_QUIC_ONLY:-unset} SKIP_BUNDLE=${SYQURE_SKIP_BUNDLE:-unset}"

		start_static_server
		start_tauri_instances
		prepare_allele_freq_ui_inputs

		MODE="${BV_SYQURE_AGG_MODE:-smpc}"
		TRANSPORT="${BV_SYQURE_TRANSPORT:-hotlink}"
		MODULE_YAML="$ROOT_DIR/biovault/tests/scenarios/allele-freq-syqure/modules/secure-aggregate/module.yaml"
		case "$MODE" in
			smpc|"") ENTRY="secure_aggregate.codon" ;;
			he)
				error "BV_SYQURE_AGG_MODE=he is not supported for allele-freq-syqure (only smpc)"
				exit 1
				;;
			*)
				error "Unknown BV_SYQURE_AGG_MODE: $MODE (expected smpc|he)"
				exit 1
				;;
		esac
		python3 -c "import pathlib,re; path = pathlib.Path(r'${MODULE_YAML}'); text = path.read_text(); text = re.sub(r'entrypoint: [A-Za-z0-9_]+\\.codon', f'entrypoint: ${ENTRY}', text); text = re.sub(r'transport: .*', f'transport: ${TRANSPORT}', text); path.write_text(text)"
		info "Syqure aggregation mode: ${MODE} (entrypoint: ${ENTRY}) transport: ${TRANSPORT}"

		info "=== Syqure Multiparty Allele-Freq Flow Test ==="
		info "Three clients will execute biovault/tests/scenarios/allele-freq-syqure/flow.yaml via collaborative run."
		info ""
		info "Open these URLs in your browser:"
		info "  Client1:     ${UI_BASE_URL}?ws=${WS_PORT_BASE}&real=1"
		info "  Client2:     ${UI_BASE_URL}?ws=$((WS_PORT_BASE + 1))&real=1"
		info "  Aggregator:  ${UI_BASE_URL}?ws=$((WS_PORT_BASE + 2))&real=1"
		info ""
		info "Emails: ${CLIENT1_EMAIL}, ${CLIENT2_EMAIL}, ${AGG_EMAIL}"

		timer_push "Playwright: @syqure-multiparty-allele-freq"
		start_syqure_watchdog "allele-freq-syqure"
		run_ui_grep "@syqure-multiparty-allele-freq" "INTERACTIVE_MODE=$INTERACTIVE_MODE"
		stop_syqure_watchdog
		timer_pop

		if [[ "$WAIT_MODE" == "1" ]]; then
			info "Wait mode: Servers will stay running. Press Ctrl+C to exit."
			while true; do sleep 1; done
		fi
		;;
	file-transfer)
		start_static_server
		start_tauri_instances

		# Create a large test file for transfer testing
		TRANSFER_TEST_DIR="$ROOT_DIR/test-data/file-transfer"
		LARGE_FILE_SIZE="${LARGE_FILE_SIZE_MB:-50}" # Default 50MB
		mkdir -p "$TRANSFER_TEST_DIR"

		LARGE_FILE_PATH="$TRANSFER_TEST_DIR/large-test-file.bin"
		if [[ ! -f "$LARGE_FILE_PATH" ]] || [[ "$(stat -f%z "$LARGE_FILE_PATH" 2>/dev/null || stat -c%s "$LARGE_FILE_PATH" 2>/dev/null)" -lt $((LARGE_FILE_SIZE * 1024 * 1024)) ]]; then
			info "Creating ${LARGE_FILE_SIZE}MB test file..."
			timer_push "Create test file"
			dd if=/dev/urandom of="$LARGE_FILE_PATH" bs=1M count="$LARGE_FILE_SIZE" 2>/dev/null
			timer_pop
		else
			info "Using existing test file: $LARGE_FILE_PATH"
		fi

		export TRANSFER_TEST_DIR
		export LARGE_FILE_PATH

		info "=== Running File Transfer Test ==="
		timer_push "Playwright: @file-transfer"
		run_ui_grep "@file-transfer" "TRANSFER_TEST_DIR=$TRANSFER_TEST_DIR" "LARGE_FILE_PATH=$LARGE_FILE_PATH" "INTERACTIVE_MODE=$INTERACTIVE_MODE"
		timer_pop

		# In wait mode, keep everything running
		if [[ "$WAIT_MODE" == "1" ]]; then
			info "Wait mode: Servers will stay running. Press Ctrl+C to exit."
			while true; do sleep 1; done
		fi
		;;
	flows-solo)
		start_static_server
		# Flows test only needs one client
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

		# Run flows solo test
		info "=== Flows Solo Test ==="
		timer_push "Playwright: @flows-solo"
		run_ui_grep "@flows-solo" "SYNTHETIC_DATA_DIR=$SYNTHETIC_DATA_DIR" "INTERACTIVE_MODE=$INTERACTIVE_MODE"
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
	flows-pause-resume)
		start_static_server
		# Pause/resume test - standalone with data setup
		assert_tauri_binary_present
		assert_tauri_binary_fresh

		# Synthetic data configuration (same as flows-solo)
		SYNTHETIC_DATA_DIR="$ROOT_DIR/test-data/synthetic-genotypes"
		EXPECTED_FILE_COUNT=10
		FORCE_REGEN="${FORCE_REGEN_SYNTHETIC:-0}"

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
		fi

		# Start Tauri instance
		timer_push "Tauri instance start (single)"
		info "Launching Tauri for client1 on WS port $WS_PORT_BASE"
		TAURI1_PID=$(launch_instance "$CLIENT1_EMAIL" "$CLIENT1_HOME" "$CLIENT1_CFG" "$WS_PORT_BASE")
		info "Waiting for WS bridge..."
		wait_ws "$WS_PORT_BASE" || { echo "WS $WS_PORT_BASE not ready" >&2; exit 1; }
		timer_pop

		export UNIFIED_LOG_WS="$UNIFIED_LOG_WS_URL"
		export USE_REAL_INVOKE=true
		export SYNTHETIC_DATA_DIR
		info "Client1 UI: ${UI_BASE_URL}?ws=${WS_PORT_BASE}&real=1"

		# Run pause/resume test
		info "=== Flows Pause/Resume Test ==="
		timer_push "Playwright: @flows-pause-resume"
		run_ui_grep "@flows-pause-resume" "SYNTHETIC_DATA_DIR=$SYNTHETIC_DATA_DIR" "INTERACTIVE_MODE=$INTERACTIVE_MODE"
		timer_pop

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
