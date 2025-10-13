#!/bin/bash

# Copy the DMG to ~/Downloads/Sequoia Share for VM access
DMG_PATH="src-tauri/target/release/bundle/dmg/BioVault_0.1.0_aarch64.dmg"
DEST_DIR="$HOME/Downloads/Sequoia Share"

if [ ! -f "$DMG_PATH" ]; then
    echo "❌ Error: DMG not found at $DMG_PATH"
    echo "Please run 'npm run tauri build' first"
    exit 1
fi

echo "📦 Creating destination directory..."
mkdir -p "$DEST_DIR"

echo "📂 Copying DMG to $DEST_DIR..."
cp "$DMG_PATH" "$DEST_DIR/"

echo "✅ Done! DMG copied to:"
echo "   $DEST_DIR/$(basename "$DMG_PATH")"
