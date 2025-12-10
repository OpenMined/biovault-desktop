
#!/usr/bin/env bash
set -euo pipefail

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

# Ensure bundled binaries (java/nextflow/uv) and SyftBox client are present before packaging.
chmod +x scripts/build-syftbox-prod.sh scripts/fetch-bundled-deps.sh
./scripts/build-syftbox-prod.sh
./scripts/fetch-bundled-deps.sh

# On macOS, strip quarantine and ad-hoc sign the bundled syftbox binary so Gatekeeper
# doesn't kill it during local testing.
if [[ "$(uname)" == "Darwin" ]]; then
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

  # Ad-hoc sign all bundled executables and dylibs before Tauri packages them
  echo "Signing bundled executables..."
  find src-tauri/resources/bundled src-tauri/resources/syftbox -type f \( -perm +111 -o -name "*.dylib" -o -name "*.jnilib" \) -print0 2>/dev/null | while IFS= read -r -d '' f; do
    codesign --force --sign - "$f" 2>/dev/null || true
  done || true

  # If a DMG already exists from a prior build, clear its quarantine/provenance
  # so local test runs of the artifact don't get blocked.
  find src-tauri/target -name "*.dmg" -type f -maxdepth 5 -print0 2>/dev/null | while IFS= read -r -d '' dmg; do
    xattr -c "$dmg" 2>/dev/null || true
  done || true
fi

bun run tauri build
