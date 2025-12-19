#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYFTBOX_DIR="$ROOT_DIR/biovault/syftbox-sdk/syftbox"
RUST_DIR="$SYFTBOX_DIR/rust"
OUT_DIR="$ROOT_DIR/src-tauri/resources/syftbox"
OUT_BIN="$OUT_DIR/syftbox"

TARGET="${SYFTBOX_RUST_TARGET:-}"

mkdir -p "$OUT_DIR"

if [[ -n "$TARGET" ]]; then
  cargo build --release --manifest-path "$RUST_DIR/Cargo.toml" --target "$TARGET"
  BIN_PATH="$RUST_DIR/target/$TARGET/release/syftbox-rs"
else
  cargo build --release --manifest-path "$RUST_DIR/Cargo.toml"
  BIN_PATH="$RUST_DIR/target/release/syftbox-rs"
fi

if [[ ! -f "$BIN_PATH" ]]; then
  echo "Rust syftbox binary not found at $BIN_PATH" >&2
  exit 1
fi

cp "$BIN_PATH" "$OUT_BIN"
chmod +x "$OUT_BIN"

echo "[syftbox-rs] Copied to resources: $OUT_BIN"
