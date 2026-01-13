#!/bin/bash
# Setup Jaeger all-in-one binary for local tracing
# No Docker required, instant startup

set -euo pipefail

JAEGER_VERSION="${JAEGER_VERSION:-1.54.0}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
JAEGER_DIR="${JAEGER_DIR:-$HOME/.local/share/jaeger}"

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
    x86_64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

case "$OS" in
    darwin) PLATFORM="darwin" ;;
    linux) PLATFORM="linux" ;;
    msys*|mingw*|cygwin*) PLATFORM="windows" ;;
    *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

DOWNLOAD_URL="https://github.com/jaegertracing/jaeger/releases/download/v${JAEGER_VERSION}/jaeger-${JAEGER_VERSION}-${PLATFORM}-${ARCH}.tar.gz"
BINARY_NAME="jaeger-all-in-one"
if [[ "$PLATFORM" == "windows" ]]; then
    BINARY_NAME="jaeger-all-in-one.exe"
fi

echo "📦 Setting up Jaeger ${JAEGER_VERSION} for ${PLATFORM}-${ARCH}"

# Create directories
mkdir -p "$INSTALL_DIR"
mkdir -p "$JAEGER_DIR"

# Check if already installed
if [[ -x "$INSTALL_DIR/$BINARY_NAME" ]]; then
    INSTALLED_VERSION=$("$INSTALL_DIR/$BINARY_NAME" version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "unknown")
    if [[ "$INSTALLED_VERSION" == "$JAEGER_VERSION" ]]; then
        echo "✅ Jaeger ${JAEGER_VERSION} already installed at $INSTALL_DIR/$BINARY_NAME"
        exit 0
    fi
    echo "🔄 Upgrading from ${INSTALLED_VERSION} to ${JAEGER_VERSION}"
fi

# Download
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

echo "⬇️  Downloading from $DOWNLOAD_URL"
curl -sL "$DOWNLOAD_URL" -o "$TEMP_DIR/jaeger.tar.gz"

# Extract
echo "📂 Extracting..."
tar -xzf "$TEMP_DIR/jaeger.tar.gz" -C "$TEMP_DIR"

# Find and copy binary
EXTRACTED_BINARY=$(find "$TEMP_DIR" -name "$BINARY_NAME" -type f | head -1)
if [[ -z "$EXTRACTED_BINARY" ]]; then
    echo "❌ Could not find $BINARY_NAME in archive"
    exit 1
fi

cp "$EXTRACTED_BINARY" "$INSTALL_DIR/$BINARY_NAME"
chmod +x "$INSTALL_DIR/$BINARY_NAME"

echo "✅ Installed Jaeger to $INSTALL_DIR/$BINARY_NAME"

# Verify
if "$INSTALL_DIR/$BINARY_NAME" version 2>/dev/null | head -1; then
    echo ""
    echo "🎉 Setup complete!"
    echo ""
    echo "Usage:"
    echo "  Start Jaeger:    ./scripts/start-jaeger.sh"
    echo "  View traces:     http://localhost:16686"
    echo "  OTLP endpoint:   http://localhost:4318"
else
    echo "⚠️  Binary installed but version check failed"
fi

# Check PATH
if ! command -v "$BINARY_NAME" &> /dev/null; then
    echo ""
    echo "💡 Add to PATH for global access:"
    echo "   export PATH=\"$INSTALL_DIR:\$PATH\""
fi
