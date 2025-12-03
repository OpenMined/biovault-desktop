#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYFTBOX_DIR="$ROOT_DIR/biovault/syftbox"
OUT_DIR="$ROOT_DIR/src-tauri/resources/syftbox"
OUT_BIN="$OUT_DIR/syftbox"

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

# Ensure executable bit so macOS signing/notarization can pick it up correctly
chmod +x "$OUT_BIN"

echo "[syftbox] Copied to resources: $OUT_BIN"

echo "[syftbox] Build complete: $OUT_BIN"
