#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${BLUE}🔨 Force rebuilding biovault submodule...${NC}"
cd "$SCRIPT_DIR/src-tauri"
cargo clean -p biovault
cd "$SCRIPT_DIR"
echo -e "${GREEN}✓ Cleaned biovault package cache${NC}"

BV_PATH="$SCRIPT_DIR/biovault/bv"

# Use custom config if provided, otherwise use default Desktop/BioVault
if [ -n "$BIOVAULT_CONFIG" ]; then
    export BIOVAULT_HOME="$BIOVAULT_CONFIG"
    echo -e "${YELLOW}📁 Using config directory: ${BIOVAULT_CONFIG}${NC}"
else
    # Default to Desktop/BioVault for desktop app consistency
    export BIOVAULT_HOME="$HOME/Desktop/BioVault"
fi

mkdir -p "$BIOVAULT_HOME"

# Override bv binary path
export BIOVAULT_PATH="$BV_PATH"

echo -e "${GREEN}✓ Configuration:${NC}"
echo -e "${YELLOW}   Database: ${BIOVAULT_HOME}/biovault.db${NC}"
echo -e "${YELLOW}   CLI binary: ${BIOVAULT_PATH}${NC}"
echo ""

# Enable WebSocket bridge for browser mode
export DEV_WS_BRIDGE=1

echo -e "${BLUE}🚀 Starting Tauri dev server with WebSocket bridge...${NC}"
echo -e "${YELLOW}   Backend will run in background${NC}"
echo ""

# Start Tauri dev in background (this starts Rust backend + WebSocket on port 3333)
npm run dev > /tmp/tauri-dev.log 2>&1 &
TAURI_PID=$!

# Trap to cleanup on exit
trap "echo -e '\n${YELLOW}🛑 Stopping servers...${NC}'; kill $TAURI_PID 2>/dev/null; kill $SERVER_PID 2>/dev/null; exit" EXIT INT TERM

# Wait for WebSocket server to be ready
echo -e "${YELLOW}⏳ Waiting for WebSocket server (port 3333)...${NC}"
for i in {1..30}; do
    if lsof -Pi :3333 -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo -e "${GREEN}✓ WebSocket server ready${NC}"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${YELLOW}⚠️  WebSocket server not detected (timeout)${NC}"
        echo -e "${YELLOW}   Check logs: tail -f /tmp/tauri-dev.log${NC}"
        echo -e "${YELLOW}   Continuing anyway...${NC}"
    fi
    sleep 0.5
done

# Find available port for HTTP server (default 8080, fallback to 8081-8089)
PORT=8080
for p in $(seq 8080 8089); do
    if ! lsof -Pi :$p -sTCP:LISTEN -t >/dev/null 2>&1; then
        PORT=$p
        break
    fi
done

echo ""
echo -e "${BLUE}🌐 Starting HTTP server on port ${PORT}...${NC}"
echo -e "${YELLOW}   Serving from: ${SCRIPT_DIR}/src${NC}"
echo ""

# Start simple HTTP server in background
cd "$SCRIPT_DIR/src"
python3 -m http.server $PORT > /dev/null 2>&1 &
SERVER_PID=$!

# Wait a moment for server to start
sleep 1

# Open Chrome (or default browser)
URL="http://localhost:$PORT"
echo -e "${GREEN}✅ Setup complete!${NC}"
echo -e "${GREEN}🌐 Opening Chrome at ${URL}${NC}"
echo -e "${YELLOW}📝 Browser → HTTP server (port ${PORT}) → WebSocket → Rust backend (port 3333)${NC}"
echo ""

if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"
elif command -v google-chrome &> /dev/null; then
    google-chrome "$URL" &
elif command -v chromium &> /dev/null; then
    chromium "$URL" &
else
    echo -e "${YELLOW}⚠️  Chrome not found. Please open manually: ${URL}${NC}"
fi

echo -e "${GREEN}✓ Servers running. Press Ctrl+C to stop.${NC}"
echo -e "${YELLOW}💡 Tip: Tauri logs → tail -f /tmp/tauri-dev.log${NC}"
echo ""

# Wait for Tauri process (main process)
wait $TAURI_PID
