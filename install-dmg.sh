#!/bin/bash

# Install the app from DMG to Applications folder
DMG_PATH="src-tauri/target/release/bundle/dmg/BioVault Desktop_0.1.0_aarch64.dmg"
APP_NAME="BioVault Desktop.app"
MOUNT_POINT="/Volumes/BioVault Desktop"

if [ ! -f "$DMG_PATH" ]; then
    echo "❌ Error: DMG not found at $DMG_PATH"
    echo "Please run 'npm run build' first"
    exit 1
fi

echo "📦 Mounting DMG..."
hdiutil attach "$DMG_PATH" -quiet

if [ ! -d "$MOUNT_POINT/$APP_NAME" ]; then
    echo "❌ Error: App not found in mounted DMG"
    hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null
    exit 1
fi

echo "📂 Copying to /Applications..."
if [ -d "/Applications/$APP_NAME" ]; then
    echo "   Removing existing app..."
    rm -rf "/Applications/$APP_NAME"
fi

cp -R "$MOUNT_POINT/$APP_NAME" /Applications/

echo "💿 Unmounting DMG..."
hdiutil detach "$MOUNT_POINT" -quiet

echo "✅ Done! BioVault Desktop installed to /Applications/"
echo "🚀 Launch with: open -a 'BioVault Desktop'"
