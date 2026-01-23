#!/bin/bash
# test-scenario-obs.sh - Run test scenarios with observability enabled
# Starts Jaeger, runs tests with tracing, leaves Jaeger running for inspection
#
# Usage:
#   ./test-scenario-obs.sh messaging
#   ./test-scenario-obs.sh flows-collab
#   ./test-scenario-obs.sh all
#
# View traces: http://localhost:16686

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m'

echo -e "${BLUE}🔭 BioVault Test Scenario with Observability${NC}"
echo ""

# Check if Jaeger is installed
JAEGER_BIN="${HOME}/.local/bin/jaeger-all-in-one"
JAEGER_BIN_EXE="${JAEGER_BIN}.exe"
if [[ "$(uname -s)" =~ (MINGW|MSYS|CYGWIN) ]]; then
    if [[ -x "$JAEGER_BIN_EXE" ]]; then
        JAEGER_BIN="$JAEGER_BIN_EXE"
    fi
fi
if [[ ! -x "$JAEGER_BIN" ]] \
    && ! command -v jaeger-all-in-one &> /dev/null \
    && ! command -v jaeger-all-in-one.exe &> /dev/null; then
    echo -e "${YELLOW}⚠️  Jaeger not installed. Installing...${NC}"
    "$SCRIPT_DIR/scripts/setup-jaeger.sh"
    echo ""
fi

# Start Jaeger if not running
if ! curl -s http://localhost:16686/api/services > /dev/null 2>&1; then
    echo -e "${BLUE}🚀 Starting Jaeger...${NC}"
    "$SCRIPT_DIR/scripts/start-jaeger.sh"
    echo ""
else
    echo -e "${GREEN}✅ Jaeger already running${NC}"
fi

# Set tracing environment
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
export OTEL_SERVICE_NAME="${OTEL_SERVICE_NAME:-biovault-test}"
export OTEL_TRACES_SAMPLER="always_on"
export BIOVAULT_ENABLE_TELEMETRY="1"

echo -e "${BLUE}📡 Tracing enabled:${NC}"
echo "   OTEL_EXPORTER_OTLP_ENDPOINT=$OTEL_EXPORTER_OTLP_ENDPOINT"
echo "   OTEL_SERVICE_NAME=$OTEL_SERVICE_NAME"
echo "   BIOVAULT_ENABLE_TELEMETRY=$BIOVAULT_ENABLE_TELEMETRY"
echo ""

# Run test scenario with all arguments passed through
echo -e "${BLUE}🧪 Running: ./test-scenario.sh $*${NC}"
echo ""

"$SCRIPT_DIR/test-scenario.sh" "$@"
TEST_EXIT_CODE=$?

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}🔭 Traces available at: http://localhost:16686${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "   Filter by service: biovault-desktop-1, biovault-desktop-2, syftbox-server"
echo "   Jaeger will keep running. Stop with: ./scripts/stop-jaeger.sh"
echo ""

exit $TEST_EXIT_CODE
