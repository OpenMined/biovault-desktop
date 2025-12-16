#!/bin/bash
set -euo pipefail

# Wrapper to run the browser+Rust chaos fuzz in one go
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Defaults (override as needed)
export CHAOS_MODE="${CHAOS_MODE:-1}"
export USE_REAL_INVOKE="${USE_REAL_INVOKE:-true}"
export CHAOS_ACTIONS="${CHAOS_ACTIONS:-200}"
export CHAOS_SEED="${CHAOS_SEED:-$(date +%s)}"
export UNIFIED_LOG_FILE="${UNIFIED_LOG_FILE:-$ROOT_DIR/logs/unified-ui-chaos.log}"
export UNIFIED_LOG_PORT="${UNIFIED_LOG_PORT:-9754}"
export UNIFIED_LOG_STDOUT="${UNIFIED_LOG_STDOUT:-1}"
export DISABLE_UPDATER=1

CHAOS_GREP="${CHAOS_GREP:-@chaos}"

printf "\033[1;35m[chaos]\033[0m seed=%s actions=%s log=%s port=%s grep=%s\n" \
	"${CHAOS_SEED}" "${CHAOS_ACTIONS}" "${UNIFIED_LOG_FILE}" "${UNIFIED_LOG_PORT}" "${CHAOS_GREP}"

# Run the existing app+UI harness, forcing the chaos tag (override via CHAOS_GREP)
exec "$ROOT_DIR/test-ui-app.sh" "$@" --grep "${CHAOS_GREP}"
