#!/bin/bash

set -euo pipefail

# Copy the DMG (and its contained .app bundle) to ~/Downloads/Sequoia Share for VM access
DMG_PATH="src-tauri/target/release/bundle/dmg/BioVault_0.1.0_aarch64.dmg"
DEST_DIR="$HOME/Downloads/Sequoia Share"

if [ ! -f "$DMG_PATH" ]; then
    echo "❌ Error: DMG not found at $DMG_PATH"
    echo "Please run 'npm run tauri build' first"
    exit 1
fi

echo "📦 Creating destination directory..."
mkdir -p "$DEST_DIR"

DMG_BASENAME=$(basename "$DMG_PATH")

echo "📂 Copying DMG to $DEST_DIR/$DMG_BASENAME ..."
cp "$DMG_PATH" "$DEST_DIR/"

echo "💿 Mounting DMG to extract .app bundle..."
MOUNT_DIR=$(mktemp -d /tmp/biovault-dmg.XXXXXX)

hdiutil attach "$DMG_PATH" \
    -readonly \
    -nobrowse \
    -noverify \
    -mountpoint "$MOUNT_DIR" >/dev/null

APP_SOURCE=$(find "$MOUNT_DIR" -maxdepth 1 -type d -name "*.app" | head -n 1 || true)

if [ -z "$APP_SOURCE" ]; then
    echo "❌ Error: No .app bundle found inside the DMG at $MOUNT_DIR"
    hdiutil detach "$MOUNT_DIR" >/dev/null 2>&1 || true
    rmdir "$MOUNT_DIR"
    exit 1
fi

APP_NAME=$(basename "$APP_SOURCE")
APP_DEST="$DEST_DIR/$APP_NAME"

echo "📥 Copying $APP_NAME to $DEST_DIR ..."
rm -rf "$APP_DEST"
cp -R "$APP_SOURCE" "$APP_DEST"

echo "⏏️  Unmounting DMG..."
hdiutil detach "$MOUNT_DIR" >/dev/null
rmdir "$MOUNT_DIR"

echo "✅ Done! Artifacts available at:"
echo "   • $DEST_DIR/$DMG_BASENAME"
echo "   • $APP_DEST"
