#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_ROOT="${OUT_ROOT:-"$ROOT_DIR/src-tauri/resources/bundled"}"

mkdir -p "$OUT_ROOT"

for dir in java nextflow uv; do
  mkdir -p "$OUT_ROOT/$dir"
done

if [[ ! -f "$OUT_ROOT/README.txt" ]]; then
  cat >"$OUT_ROOT/README.txt" <<'EOF'
This directory is populated by scripts/fetch-bundled-deps.sh for production builds.
During development it may contain only placeholder folders.
EOF
fi
