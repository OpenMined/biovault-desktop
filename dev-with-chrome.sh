#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BV_PATH="$SCRIPT_DIR/biovault/bv"

# Use custom config if provided, otherwise use default
if [ -n "$BIOVAULT_CONFIG" ]; then
    export BIOVAULT_HOME="$BIOVAULT_CONFIG/.biovault"
    echo -e "${YELLOW}📁 Using config directory: ${BIOVAULT_CONFIG}${NC}"
else
    export BIOVAULT_HOME="$HOME/.biovault"
fi

mkdir -p "$BIOVAULT_HOME"

# Override bv binary path
export BIOVAULT_PATH="$BV_PATH"

echo -e "${GREEN}✓ Configuration:${NC}"
echo -e "${YELLOW}   Database: ${BIOVAULT_HOME}/biovault.db${NC}"
echo -e "${YELLOW}   CLI binary: ${BIOVAULT_PATH}${NC}"
echo ""

# Find available port (default 8080, fallback to 8081-8089)
PORT=8080
for p in $(seq 8080 8089); do
    if ! lsof -Pi :$p -sTCP:LISTEN -t >/dev/null 2>&1; then
        PORT=$p
        break
    fi
done

echo -e "${BLUE}🚀 Starting HTTP server on port ${PORT}...${NC}"
echo -e "${YELLOW}   Serving from: ${SCRIPT_DIR}/src${NC}"
echo ""

# Start simple HTTP server in background
cd "$SCRIPT_DIR/src"
python3 -m http.server $PORT > /dev/null 2>&1 &
SERVER_PID=$!

# Trap to cleanup server on exit
trap "echo -e '\n${YELLOW}🛑 Stopping server...${NC}'; kill $SERVER_PID 2>/dev/null; exit" EXIT INT TERM

# Wait a moment for server to start
sleep 1

# Open Chrome (or Chromium)
URL="http://localhost:$PORT"
echo -e "${GREEN}🌐 Opening Chrome at ${URL}${NC}"
echo -e "${YELLOW}📝 Note: Running in browser mode (mock Tauri APIs)${NC}"
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

echo -e "${GREEN}✓ Server running. Press Ctrl+C to stop.${NC}"
echo ""

# Wait for server process
wait $SERVER_PID
