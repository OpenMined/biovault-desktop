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

# Fetch bundled deps
chmod +x scripts/fetch-bundled-deps.sh
./scripts/fetch-bundled-deps.sh

# Build syqure (fat binary) using existing syqure build script (non-Windows)
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    echo "Skipping syqure build on Windows (Docker runtime only)."
    ;;
  *)
    chmod +x syqure/syqure_bins.sh
    ./syqure/syqure_bins.sh
    mkdir -p src-tauri/resources/syqure
    if [[ -f syqure/target/debug/syqure ]]; then
      cp syqure/target/debug/syqure src-tauri/resources/syqure/syqure
      chmod +x src-tauri/resources/syqure/syqure
    else
      echo "❌ syqure binary not found at syqure/target/debug/syqure" >&2
      exit 1
    fi
    ;;
esac

# Materialize notebooks into a real templates directory for bundling
chmod +x scripts/materialize-templates.sh
./scripts/materialize-templates.sh

# On macOS, strip quarantine and ad-hoc sign for local testing
if [[ "$(uname)" == "Darwin" ]]; then
  echo "Stripping extended attributes..."
  for root in \
    src-tauri/resources/syqure \
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
  find src-tauri/resources/bundled src-tauri/resources/syqure -type f \( -perm +111 -o -name "*.dylib" -o -name "*.jnilib" \) -print0 2>/dev/null | while IFS= read -r -d '' f; do
    codesign --force --sign - "$f" 2>/dev/null || true
  done || true

  # Clear quarantine on any existing DMGs
  find src-tauri/target -name "*.dmg" -type f -maxdepth 5 -print0 2>/dev/null | while IFS= read -r -d '' dmg; do
    xattr -c "$dmg" 2>/dev/null || true
  done || true
fi

# Build without notarization (local dev)
echo "Running tauri build (dev mode, no notarization)..."
env \
  -u APPLE_ID \
  -u APPLE_PASSWORD \
  -u APPLE_TEAM_ID \
  -u APPLE_SIGNING_IDENTITY \
  -u TAURI_SIGNING_PRIVATE_KEY \
  -u TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
  APPLE_SIGNING_IDENTITY="-" \
  npm exec -- tauri build \
  --config '{"bundle":{"createUpdaterArtifacts":false}}'

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
