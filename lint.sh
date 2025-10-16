#!/bin/bash

set -o pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR" || exit 1

if ! command -v npx >/dev/null 2>&1; then
	echo "❌ npx is required but was not found on your PATH. Install Node.js (which includes npx) and retry."
	exit 1
fi

EXIT_CODE=0

run_step() {
	local description="$1"
	shift

	echo "🔍 $description..."
	if "$@"; then
		echo "✅ $description passed"
	else
		local status=$?
		echo "❌ $description failed (exit code $status)"
		EXIT_CODE=1
	fi
	echo ""
}

# Ensure Prettier formatting stays consistent across contributors
PRETTIER_MODE="--write"
if [ "${CI:-}" = "true" ]; then
	PRETTIER_MODE="--check"
fi

run_step "Prettier formatting" \
	npx --yes prettier@3.2.5 "$PRETTIER_MODE" '**/*.{js,jsx,ts,tsx,json,css,html,md}' --ignore-path .prettierignore

# Catch common JavaScript issues
run_step "ESLint static analysis" \
	npx --yes eslint@8.57.0 . --ext .js,.jsx,.ts,.tsx

# Identify unused or missing dependencies
run_step "Dependency hygiene (depcheck)" \
	npx --yes depcheck . --config .depcheckrc.json --ignore-dirs=biovault,node_modules,src-tauri

if [ $EXIT_CODE -ne 0 ]; then
	echo "❌ Linting failed. Please address the issues above."
else
	echo "✅ All linting checks passed!"
fi

exit $EXIT_CODE
