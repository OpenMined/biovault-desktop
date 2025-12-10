#!/usr/bin/env bash
set -euo pipefail

# Build with proper Developer ID signing (mirrors CI behavior)
# Requires .env with: APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
TRAP_P12=""
cleanup() {
  if [[ -n "$TRAP_P12" && -f "$TRAP_P12" ]]; then
    rm -f "$TRAP_P12" || true
  fi
}
trap cleanup EXIT

# Load .env if present
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

# Import base64-encoded P12 if provided
if [[ -n "${SIGNING_CERTIFICATE_P12_DATA:-}" ]]; then
  if [[ -z "${SIGNING_CERTIFICATE_PASSWORD:-}" ]]; then
    echo "❌ SIGNING_CERTIFICATE_PASSWORD not set for provided SIGNING_CERTIFICATE_P12_DATA"
    exit 1
  fi
  echo "Importing Developer ID certificate from SIGNING_CERTIFICATE_P12_DATA..."
  TRAP_P12="$(mktemp)"
  echo "$SIGNING_CERTIFICATE_P12_DATA" | base64 -d >"$TRAP_P12"
  security import "$TRAP_P12" -k ~/Library/Keychains/login.keychain-db \
    -P "$SIGNING_CERTIFICATE_PASSWORD" \
    -T /usr/bin/codesign -T /usr/bin/security >/dev/null
  # Optionally set partition list if KEYCHAIN_PASSWORD provided
  if [[ -n "${KEYCHAIN_PASSWORD:-}" ]]; then
    security set-key-partition-list -S apple-tool:,apple: -k "$KEYCHAIN_PASSWORD" ~/Library/Keychains/login.keychain-db >/dev/null 2>&1 || true
  fi
fi

# Resolve signing identity if not explicitly set
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  APPLE_SIGNING_IDENTITY="$(security find-identity -p codesigning -v | awk -F\" '/Developer ID Application/ {print $2; exit}')"
fi

# Validate required env vars
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "❌ APPLE_SIGNING_IDENTITY not set. Add it to .env or export it."
  echo "   Run: security find-identity -v -p codesigning"
  exit 1
fi

echo "Using signing identity: $APPLE_SIGNING_IDENTITY"

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

# Build syftbox with Developer ID signing
chmod +x scripts/build-syftbox-prod-signed.sh scripts/fetch-bundled-deps.sh scripts/sign-bundled-deps.sh
./scripts/build-syftbox-prod-signed.sh

# Fetch bundled deps then sign them
./scripts/fetch-bundled-deps.sh
./scripts/sign-bundled-deps.sh

# Build with Tauri
echo "Running tauri build..."
bun run tauri build

# Clear quarantine on output artifacts
echo "Clearing quarantine on artifacts..."
find src-tauri/target -type f \( -name "*.dmg" -o -name "*.zip" -o -name "*.tar.gz" \) -maxdepth 5 -print0 2>/dev/null | while IFS= read -r -d '' artifact; do
  xattr -c "$artifact" 2>/dev/null || true
done || true

echo ""
echo "✅ Build complete. Test with:"
echo "   ./check-gatekeeper.sh ./src-tauri/target/release/bundle/dmg/*.dmg"
