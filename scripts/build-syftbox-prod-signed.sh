#!/usr/bin/env bash
set -euo pipefail

# Build syftbox and sign with Developer ID for notarization

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

resolve_syftbox_dir() {
  local candidates=(
    "$ROOT_DIR/syftbox"
    "$ROOT_DIR/syftbox-sdk/syftbox"
    "$ROOT_DIR/biovault/syftbox-sdk/syftbox"
    "$ROOT_DIR/../syftbox"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -d "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  echo "syftbox repo not found. Run ./scripts/setup-workspace.sh first." >&2
  exit 1
}

SYFTBOX_DIR="$(resolve_syftbox_dir)"
OUT_DIR="$ROOT_DIR/src-tauri/resources/syftbox"
OUT_BIN="$OUT_DIR/syftbox"

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

echo "[syftbox] Using signing identity: $APPLE_SIGNING_IDENTITY"

cd "$SYFTBOX_DIR"

# Gather version metadata from git
VERSION="$(git describe --tags --always --dirty 2>/dev/null || echo dev)"
REVISION="$(git rev-parse --short HEAD 2>/dev/null || echo HEAD)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$OUT_DIR"

LD_FLAGS=(
  "-s" "-w"
  "-X" "github.com/openmined/syftbox/internal/version.Version=$VERSION"
  "-X" "github.com/openmined/syftbox/internal/version.Revision=$REVISION"
  "-X" "github.com/openmined/syftbox/internal/version.BuildDate=$BUILD_DATE"
)

echo "[syftbox] Building production client -> $OUT_BIN"
echo "[syftbox] Version=$VERSION Revision=$REVISION BuildDate=$BUILD_DATE"

GO111MODULE=on go build -ldflags="${LD_FLAGS[*]}" -o "$OUT_BIN" ./cmd/client

chmod +x "$OUT_BIN"

echo "[syftbox] Build complete: $OUT_BIN"

# Strip extended attributes
echo "[syftbox] Stripping extended attributes..."
xattr -c "$OUT_BIN" 2>/dev/null || true

# Sign with Developer ID and entitlements
ENTITLEMENTS="$ROOT_DIR/scripts/syftbox.entitlements"
echo "[syftbox] Signing with Developer ID and entitlements..."
codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$APPLE_SIGNING_IDENTITY" "$OUT_BIN"

# Verify signature
echo "[syftbox] Verifying signature..."
codesign -dvv "$OUT_BIN" 2>&1 | grep -E "^(Authority|TeamIdentifier|Signature|Timestamp)"

echo ""
echo "✅ syftbox built and signed successfully"
