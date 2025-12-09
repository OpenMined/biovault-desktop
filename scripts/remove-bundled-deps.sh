#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLED_DIR="$ROOT_DIR/src-tauri/resources/bundled"

echo "🧹 Removing bundled dependencies for local dev builds..."

rm -rf "$BUNDLED_DIR/java" "$BUNDLED_DIR/nextflow" "$BUNDLED_DIR/uv"

mkdir -p "$BUNDLED_DIR/java"
mkdir -p "$BUNDLED_DIR/nextflow"
mkdir -p "$BUNDLED_DIR/uv"

echo "Placeholder - bundled deps not included in local dev build" > "$BUNDLED_DIR/README.txt"
touch "$BUNDLED_DIR/java/.placeholder"
touch "$BUNDLED_DIR/nextflow/.placeholder"
touch "$BUNDLED_DIR/uv/.placeholder"

echo "✅ Bundled dependencies removed. Using placeholder structure for local builds."
