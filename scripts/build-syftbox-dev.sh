#!/usr/bin/env bash
set -euo pipefail

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
OUT_DIR="$SYFTBOX_DIR/bin"
OUT_BIN="$OUT_DIR/syftbox-dev"
RESOURCE_DIR="$ROOT_DIR/src-tauri/resources/syftbox"
RESOURCE_BIN="$RESOURCE_DIR/syftbox"

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

echo "[syftbox] Building client -> $OUT_BIN"
echo "[syftbox] Version=$VERSION Revision=$REVISION BuildDate=$BUILD_DATE"

GO111MODULE=on go build -ldflags="${LD_FLAGS[*]}" -o "$OUT_BIN" ./cmd/client

chmod +x "$OUT_BIN"

# Mirror into Tauri resources so tauri dev/build finds it when bundling
mkdir -p "$RESOURCE_DIR"
cp "$OUT_BIN" "$RESOURCE_BIN"
chmod +x "$RESOURCE_BIN"

echo "[syftbox] Build complete: $OUT_BIN"
echo "[syftbox] Copied to resources: $RESOURCE_BIN"
