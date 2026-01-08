#!/usr/bin/env bash
# lint.sh - Auto-fix all languages + run quick tests (parallel, quiet on success)
# Usage: ./lint.sh [--check] [--test]
#   --check  Read-only mode for CI (no auto-fix)
#   --test   Also run tests (slower)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

CHECK_MODE=0
RUN_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_MODE=1 ;;
    --test) RUN_TESTS=1 ;;
  esac
done

TMPDIR_LINT=$(mktemp -d)
trap "rm -rf $TMPDIR_LINT" EXIT

FAILED=0
PIDS=()
TASKS=()

run_task() {
  local name="$1"
  local outfile="$TMPDIR_LINT/$name.out"
  shift
  TASKS+=("$name")
  echo -e "${CYAN}→ $name${NC}"
  (
    if "$@" > "$outfile" 2>&1; then
      echo "0" > "$outfile.status"
    else
      echo "1" > "$outfile.status"
    fi
  ) &
  PIDS+=($!)
}

wait_all() {
  local i=0
  for pid in "${PIDS[@]}"; do
    wait "$pid" || true
    local name="${TASKS[$i]}"
    local outfile="$TMPDIR_LINT/$name.out"
    if [[ -f "$outfile.status" && "$(cat "$outfile.status")" != "0" ]]; then
      echo -e "${RED}✗ $name${NC}"
      cat "$outfile"
      echo ""
      FAILED=1
    fi
    i=$((i + 1))
  done
}

# Rust (src-tauri)
if [[ -f src-tauri/Cargo.toml ]]; then
  # Check if we can run clippy (requires Tauri deps on Linux)
  RUN_CLIPPY=1
  if [[ "$(uname -s)" == "Linux" ]]; then
    if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
      echo -e "${CYAN}⊘ rust-clippy skipped (webkit2gtk-4.1 not found)${NC}"
      RUN_CLIPPY=0
    fi
  fi

  if [[ "$CHECK_MODE" -eq 1 ]]; then
    run_task "rust-fmt" cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
    if [[ "$RUN_CLIPPY" -eq 1 ]]; then
      run_task "rust-clippy" cargo clippy --all-targets --all-features --no-deps --manifest-path src-tauri/Cargo.toml -- -D warnings
    fi
  else
    run_task "rust-fmt" cargo fmt --all --manifest-path src-tauri/Cargo.toml
    if [[ "$RUN_CLIPPY" -eq 1 ]]; then
      run_task "rust-clippy" cargo clippy --fix --allow-dirty --allow-staged --all-targets --all-features --no-deps --manifest-path src-tauri/Cargo.toml -- -D warnings
    fi
  fi
  if [[ "$RUN_TESTS" -eq 1 && "$RUN_CLIPPY" -eq 1 ]]; then
    run_task "rust-test" cargo test --manifest-path src-tauri/Cargo.toml
  fi
fi

# JS/TS
if [[ -f package.json ]]; then
  if [[ "$CHECK_MODE" -eq 1 ]]; then
    run_task "prettier" npx --yes prettier@3.2.5 --check '**/*.{js,jsx,ts,tsx,json,css,html,md}' '!**/.cache/**' --ignore-path .prettierignore
    run_task "eslint" npx --yes eslint@8.57.0 . --ext .js,.jsx,.ts,.tsx --ignore-pattern '.cache/**'
  else
    run_task "prettier" npx --yes prettier@3.2.5 --write '**/*.{js,jsx,ts,tsx,json,css,html,md}' '!**/.cache/**' --ignore-path .prettierignore
    run_task "eslint" npx --yes eslint@8.57.0 . --ext .js,.jsx,.ts,.tsx --ignore-pattern '.cache/**' --fix
  fi
fi

wait_all

if [[ "$FAILED" -eq 0 ]]; then
  echo -e "${GREEN}✓ All checks passed${NC}"
else
  exit 1
fi
