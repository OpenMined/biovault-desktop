#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$SCRIPT_DIR}"

WORKSPACE_ROOT="$WORKSPACE_ROOT" "$SCRIPT_DIR/scripts/ensure-workspace-deps.sh" \
	"biovault/cli/Cargo.toml" \
	"syftbox-sdk/Cargo.toml" \
	"syftbox/rust/Cargo.toml"

echo -e "${BLUE}🔨 Force rebuilding biovault dependency...${NC}"
cd "$SCRIPT_DIR/src-tauri"
cargo clean -p biovault
cd "$SCRIPT_DIR"
echo -e "${GREEN}✓ Cleaned biovault package cache${NC}"

BIOVAULT_DIR="${BIOVAULT_DIR:-$WORKSPACE_ROOT/biovault}"
BV_PATH="$BIOVAULT_DIR/bv"

# Force Rust (embedded) SyftBox backend for dev unless explicitly overridden.
export BV_SYFTBOX_BACKEND="${BV_SYFTBOX_BACKEND:-embedded}"

# Dev mode flags (enable dev UI + syftbox panel helpers)
export BIOVAULT_DEV_MODE="${BIOVAULT_DEV_MODE:-1}"
export BIOVAULT_DEV_SYFTBOX="${BIOVAULT_DEV_SYFTBOX:-1}"

if [[ "$BV_SYFTBOX_BACKEND" != "process" ]]; then
	unset SYFTBOX_BINARY SYFTBOX_VERSION
fi

# Only set BIOVAULT_HOME if explicitly provided via BIOVAULT_CONFIG
# Otherwise let the profile picker handle home selection
if [ -n "$BIOVAULT_CONFIG" ]; then
    export BIOVAULT_HOME="$BIOVAULT_CONFIG"
    mkdir -p "$BIOVAULT_HOME"
    echo -e "${YELLOW}📁 Using config directory: ${BIOVAULT_CONFIG}${NC}"
else
    echo -e "${YELLOW}📁 No BIOVAULT_HOME set - profile picker will handle selection${NC}"
fi

# Override bv binary path
export BIOVAULT_PATH="$BV_PATH"

echo -e "${GREEN}✓ Configuration:${NC}"
if [ -n "$BIOVAULT_HOME" ]; then
    echo -e "${YELLOW}   Database: ${BIOVAULT_HOME}/biovault.db${NC}"
fi
echo -e "${YELLOW}   CLI binary: ${BIOVAULT_PATH}${NC}"
echo -e "${YELLOW}   SyftBox backend: ${BV_SYFTBOX_BACKEND}${NC}"
if [ -n "${SYFTBOX_SERVER_URL:-}" ]; then
    echo -e "${YELLOW}   SyftBox server: ${SYFTBOX_SERVER_URL}${NC}"
fi
echo ""
echo -e "${BLUE}🚀 Starting Tauri dev server...${NC}"
echo ""

# Run Tauri dev
npm run dev
