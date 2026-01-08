#!/bin/bash
# Start Jaeger all-in-one for local tracing
# OTLP endpoint: http://localhost:4318
# UI: http://localhost:16686

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
JAEGER_DIR="${JAEGER_DIR:-$HOME/.local/share/jaeger}"
BINARY_NAME="jaeger-all-in-one"
PID_FILE="$JAEGER_DIR/jaeger.pid"
LOG_FILE="$JAEGER_DIR/jaeger.log"

# Find binary
JAEGER_BIN=""
if [[ -x "$INSTALL_DIR/$BINARY_NAME" ]]; then
    JAEGER_BIN="$INSTALL_DIR/$BINARY_NAME"
elif command -v "$BINARY_NAME" &> /dev/null; then
    JAEGER_BIN=$(command -v "$BINARY_NAME")
else
    echo "❌ Jaeger not found. Run ./scripts/setup-jaeger.sh first"
    exit 1
fi

# Check if already running
if [[ -f "$PID_FILE" ]]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "⚠️  Jaeger already running (PID: $OLD_PID)"
        echo "   UI:   http://localhost:16686"
        echo "   OTLP: http://localhost:4318"
        echo ""
        echo "   Stop with: ./scripts/stop-jaeger.sh"
        exit 0
    fi
    rm -f "$PID_FILE"
fi

mkdir -p "$JAEGER_DIR"

# Check ports
check_port() {
    local port=$1
    if lsof -i ":$port" -sTCP:LISTEN &>/dev/null; then
        echo "❌ Port $port is already in use"
        return 1
    fi
    return 0
}

for port in 16686 4317 4318 14268; do
    if ! check_port $port; then
        exit 1
    fi
done

echo "🚀 Starting Jaeger..."

# Start Jaeger with OTLP enabled
nohup "$JAEGER_BIN" \
    --collector.otlp.enabled=true \
    --collector.otlp.http.host-port=:4318 \
    --collector.otlp.grpc.host-port=:4317 \
    > "$LOG_FILE" 2>&1 &

JAEGER_PID=$!
echo "$JAEGER_PID" > "$PID_FILE"

# Wait for startup
echo "⏳ Waiting for Jaeger to start..."
for i in {1..30}; do
    if curl -s http://localhost:16686/api/services > /dev/null 2>&1; then
        echo ""
        echo "✅ Jaeger is running (PID: $JAEGER_PID)"
        echo ""
        echo "   UI:        http://localhost:16686"
        echo "   OTLP HTTP: http://localhost:4318"
        echo "   OTLP gRPC: http://localhost:4317"
        echo ""
        echo "   To enable tracing in tests:"
        echo "   export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318"
        echo ""
        echo "   Stop with: ./scripts/stop-jaeger.sh"
        exit 0
    fi
    sleep 0.5
done

echo "❌ Jaeger failed to start. Check $LOG_FILE"
cat "$LOG_FILE" | tail -20
rm -f "$PID_FILE"
exit 1
