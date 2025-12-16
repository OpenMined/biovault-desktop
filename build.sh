#!/usr/bin/env bash
set -euo pipefail

# Local dev build with ad-hoc signing (no notarization)
# For production builds use: ./build-signed.sh

# Parse flags
CLEAN=false
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=true ;;
  esac
done

# Clean build artifacts if requested
if [[ "$CLEAN" == "true" ]]; then
  echo "Cleaning build artifacts..."
  rm -rf src-tauri/target/*/release/bundle
  cargo clean --manifest-path src-tauri/Cargo.toml 2>/dev/null || true
fi

# Build syftbox and fetch bundled deps
chmod +x scripts/build-syftbox-prod.sh scripts/fetch-bundled-deps.sh
./scripts/build-syftbox-prod.sh
./scripts/fetch-bundled-deps.sh

# Materialize notebooks into a real templates directory for bundling
chmod +x scripts/materialize-templates.sh
./scripts/materialize-templates.sh

# On macOS, strip quarantine and ad-hoc sign for local testing
if [[ "$(uname)" == "Darwin" ]]; then
  echo "Stripping extended attributes..."
  for root in \
    src-tauri/resources/syftbox \
    src-tauri/resources/bundled/uv \
    src-tauri/resources/bundled/java \
    src-tauri/resources/bundled/nextflow; do
    if [[ -d "$root" ]]; then
      xattr -r -c "$root" 2>/dev/null || true
    elif [[ -f "$root" ]]; then
      xattr -c "$root" 2>/dev/null || true
    fi
  done

  # Ad-hoc sign all bundled executables and dylibs
  echo "Ad-hoc signing bundled executables..."
  find src-tauri/resources/bundled src-tauri/resources/syftbox -type f \( -perm +111 -o -name "*.dylib" -o -name "*.jnilib" \) -print0 2>/dev/null | while IFS= read -r -d '' f; do
    codesign --force --sign - "$f" 2>/dev/null || true
  done || true

  # Clear quarantine on any existing DMGs
  find src-tauri/target -name "*.dmg" -type f -maxdepth 5 -print0 2>/dev/null | while IFS= read -r -d '' dmg; do
    xattr -c "$dmg" 2>/dev/null || true
  done || true
fi

# Build without notarization (local dev)
echo "Running tauri build (dev mode, no notarization)..."
APPLE_ID="" APPLE_PASSWORD="" APPLE_TEAM_ID="" bun run tauri build

# Clear quarantine on output artifacts
if [[ "$(uname)" == "Darwin" ]]; then
  echo "Clearing quarantine on artifacts..."
  find src-tauri/target -type f \( -name "*.dmg" -o -name "*.zip" -o -name "*.tar.gz" \) -maxdepth 5 -print0 2>/dev/null | while IFS= read -r -d '' artifact; do
    xattr -c "$artifact" 2>/dev/null || true
  done || true
fi

echo ""
echo "✅ Dev build complete (ad-hoc signed, not notarized)"
echo "   For production builds use: ./build-signed.sh"
