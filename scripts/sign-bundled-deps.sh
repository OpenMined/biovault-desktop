#!/usr/bin/env bash
set -euo pipefail

# Sign all bundled dependencies with Developer ID for notarization
# Run after fetch-bundled-deps.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLED_DIR="$ROOT_DIR/src-tauri/resources/bundled"
SYFTBOX_DIR="$ROOT_DIR/src-tauri/resources/syftbox"
SYQURE_DIR="$ROOT_DIR/src-tauri/resources/syqure"

# Load .env if present
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

# Validate signing identity
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "❌ APPLE_SIGNING_IDENTITY not set. Add it to .env"
  echo "   Example: APPLE_SIGNING_IDENTITY=Developer ID Application: Your Name (TEAMID)"
  exit 1
fi

echo "Using signing identity: $APPLE_SIGNING_IDENTITY"
echo ""

# Strip extended attributes from all bundled resources
echo "Stripping extended attributes..."
for dir in "$SYFTBOX_DIR" "$SYQURE_DIR" "$BUNDLED_DIR/uv" "$BUNDLED_DIR/java" "$BUNDLED_DIR/nextflow"; do
  if [[ -d "$dir" ]]; then
    xattr -r -c "$dir" 2>/dev/null || true
    echo "  Cleared xattrs: $dir"
  fi
done
echo ""

SYFTBOX_ENTITLEMENTS="$ROOT_DIR/scripts/syftbox.entitlements"
JAVA_ENTITLEMENTS="$ROOT_DIR/scripts/java.entitlements"

sign_binary() {
  local bin="$1"
  local name="$(basename "$bin")"
  echo "  Signing: $name"
  codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$bin"
}

sign_with_syftbox_entitlements() {
  local bin="$1"
  local name="$(basename "$bin")"
  echo "  Signing (with syftbox entitlements): $name"
  codesign --force --options runtime --timestamp --entitlements "$SYFTBOX_ENTITLEMENTS" --sign "$APPLE_SIGNING_IDENTITY" "$bin"
}

sign_with_java_entitlements() {
  local bin="$1"
  local name="$(basename "$bin")"
  echo "  Signing (with java entitlements): $name"
  codesign --force --options runtime --timestamp --entitlements "$JAVA_ENTITLEMENTS" --sign "$APPLE_SIGNING_IDENTITY" "$bin"
}

# Sign syftbox (needs entitlements for Go CGO runtime)
echo "Signing syftbox..."
if [[ -f "$SYFTBOX_DIR/syftbox" ]]; then
  sign_with_syftbox_entitlements "$SYFTBOX_DIR/syftbox"
fi
echo ""

# Sign syqure (fat binary)
echo "Signing syqure..."
if [[ -f "$SYQURE_DIR/syqure" ]]; then
  sign_binary "$SYQURE_DIR/syqure"
fi
echo ""

# Sign uv
echo "Signing uv binaries..."
if [[ -d "$BUNDLED_DIR/uv" ]]; then
  find "$BUNDLED_DIR/uv" -type f -perm +111 | while read -r bin; do
    sign_binary "$bin"
  done
fi
echo ""

# Sign java binaries (need entitlements for JVM JIT)
echo "Signing java binaries..."
if [[ -d "$BUNDLED_DIR/java" ]]; then
  find "$BUNDLED_DIR/java" -type f -perm +111 | while read -r bin; do
    sign_with_java_entitlements "$bin" || true
  done
fi
echo ""

# Sign java dylibs (also need entitlements)
echo "Signing java dylibs..."
if [[ -d "$BUNDLED_DIR/java" ]]; then
  find "$BUNDLED_DIR/java" -name "*.dylib" -type f | while read -r lib; do
    sign_with_java_entitlements "$lib" || true
  done
fi
echo ""

# Sign nextflow (will fail if it's a script - that's expected)
echo "Signing nextflow..."
if [[ -d "$BUNDLED_DIR/nextflow" ]]; then
  find "$BUNDLED_DIR/nextflow" -type f -perm +111 | while read -r bin; do
    sign_binary "$bin" 2>/dev/null || echo "  Skipped (likely a script): $(basename "$bin")"
  done
fi
echo ""

# Verify a few key binaries
echo "Verifying signatures..."
for bin in "$SYFTBOX_DIR/syftbox" "$BUNDLED_DIR/uv/"*"/uv" "$BUNDLED_DIR/java/"*"/bin/java"; do
  if [[ -f "$bin" ]]; then
    echo ""
    echo "  $bin:"
    codesign -dvv "$bin" 2>&1 | grep -E "^(Authority|TeamIdentifier|Timestamp)" | sed 's/^/    /'
  fi
done

echo ""
echo "✅ All bundled dependencies signed"
