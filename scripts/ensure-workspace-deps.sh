#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$ROOT_DIR}"

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <path> [path...]" >&2
  exit 2
fi

missing=()
for rel in "$@"; do
  if [[ "$rel" == /* ]]; then
    target="$rel"
    label="$rel"
  else
    target="$WORKSPACE_ROOT/$rel"
    label="$rel"
  fi
  if [[ ! -e "$target" ]]; then
    missing+=("$label|$target")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "[dev] Missing workspace dependencies:" >&2
  for item in "${missing[@]}"; do
    IFS='|' read -r rel abs <<<"$item"
    echo "  - $rel ($abs)" >&2
  done
  echo "" >&2
  if [[ -f "$WORKSPACE_ROOT/manifest.xml" && -x "$WORKSPACE_ROOT/repo" ]]; then
    echo "Fix (repo tool):" >&2
    echo "  cd \"$WORKSPACE_ROOT\"" >&2
    echo "  ./repo --init" >&2
    echo "  ./repo sync" >&2
  else
    echo "Fix: ensure required repos exist under WORKSPACE_ROOT and match paths in src-tauri/Cargo.toml" >&2
  fi
  echo "" >&2
  echo "Tip: set WORKSPACE_ROOT=/path/to/workspace if you're using a different root." >&2
  exit 1
fi
