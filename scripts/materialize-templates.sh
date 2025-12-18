#!/usr/bin/env bash
set -euo pipefail

# Materialize demo/tutorial notebooks into `src-tauri/resources/templates` for bundling.
#
# Why: In this repo, `src-tauri/resources/templates` is a symlink (for local dev convenience).
# Tauri's bundler will include the symlink itself on macOS/Linux, but the target path won't exist
# inside the packaged app, leading to missing notebooks at runtime. Windows build scripts already
# replace the symlink with a real directory before bundling.
#
# This script makes that behavior consistent across platforms.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NOTEBOOKS_SRC="${NOTEBOOKS_SRC:-$ROOT_DIR/biovault/biovault-beaver/notebooks}"
TEMPLATES_DEST="${TEMPLATES_DEST:-$ROOT_DIR/src-tauri/resources/templates}"

if [[ ! -d "$NOTEBOOKS_SRC" ]]; then
  echo "Warning: notebooks source not found at $NOTEBOOKS_SRC; skipping materialization" >&2
  exit 0
fi

# Ensure destination is a real directory (not a symlink).
if [[ -L "$TEMPLATES_DEST" || -f "$TEMPLATES_DEST" ]]; then
  echo "Materializing templates: replacing $TEMPLATES_DEST with a real directory"
  rm -f "$TEMPLATES_DEST"
fi
mkdir -p "$TEMPLATES_DEST"

# Refresh notebooks in place (keep any non-notebook templates if present).
rm -f "$TEMPLATES_DEST"/*.ipynb "$TEMPLATES_DEST/notebooks.yaml" 2>/dev/null || true

cp "$NOTEBOOKS_SRC/notebooks.yaml" "$TEMPLATES_DEST/"
for nb in "$NOTEBOOKS_SRC"/*.ipynb; do
  [[ -f "$nb" ]] && cp "$nb" "$TEMPLATES_DEST/"
done

echo "✅ Materialized notebooks into $TEMPLATES_DEST"
