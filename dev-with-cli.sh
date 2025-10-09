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
echo -e "${BLUE}🚀 Starting Tauri dev server...${NC}"
echo ""

# Run Tauri dev
bun run dev
