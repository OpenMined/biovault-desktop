#!/bin/bash

# Install the app from DMG to Applications folder
DMG_DIR="src-tauri/target/release/bundle/dmg"
DMG_PATH=$(ls -t "${DMG_DIR}"/BioVault_*.dmg 2>/dev/null | head -n 1)
if [[ -z "${DMG_PATH}" ]]; then
  echo "❌ Error: No BioVault DMG found in ${DMG_DIR}"
  echo "Please run 'npm run build' first"
  exit 1
fi
echo "ℹ️ Using DMG: ${DMG_PATH}"
APP_NAME="BioVault.app"
MOUNT_POINT="/Volumes/BioVault"

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

echo "✅ Done! BioVault installed to /Applications/"
echo "🚀 Launch with: open -a 'BioVault'"
