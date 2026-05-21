#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export BIOPOP_ROOT="${BIOPOP_ROOT:-/Users/madhavajay/dev/BioVault_popgen}"
export BIOPOP_DATA_DIR="${BIOPOP_DATA_DIR:-$BIOPOP_ROOT/01_mock_data_generation/output}"
export BIOPOP_FACETS_FILE="${BIOPOP_FACETS_FILE:-$BIOPOP_ROOT/01_mock_data_generation/facets/biovault-facets.csv}"
export BIOPOP_FLOW_URL_ROOT="${BIOPOP_FLOW_URL_ROOT:-https://github.com/madhavajay/BioVault_popgen/tree/main/flows}"

DEVSTACK_RESET="${DEVSTACK_RESET:-0}"
forward_args=()
while [[ $# -gt 0 ]]; do
	case "$1" in
		--reset)
			DEVSTACK_RESET=1
			shift
			;;
		--no-reset)
			DEVSTACK_RESET=0
			shift
			;;
		*)
			forward_args+=("$1")
			shift
			;;
	esac
done
export DEVSTACK_RESET

args=(--biopop)
if [[ "${BIOPOP_INTERACTIVE:-1}" == "1" ]]; then
	args+=(--interactive)
fi

exec "$SCRIPT_DIR/test-scenario.sh" "${args[@]}" "${forward_args[@]}"
