#!/bin/bash
# Start Jaeger all-in-one for local tracing
# OTLP endpoint: http://localhost:4318
# UI: http://localhost:16686

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
JAEGER_DIR="${JAEGER_DIR:-$HOME/.local/share/jaeger}"
EXE_SUFFIX=""
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$OS" in
    msys*|mingw*|cygwin*) EXE_SUFFIX=".exe" ;;
esac
BINARY_NAME="jaeger-all-in-one${EXE_SUFFIX}"
PID_FILE="$JAEGER_DIR/jaeger.pid"
LOG_FILE="$JAEGER_DIR/jaeger.log"
ERR_FILE="$JAEGER_DIR/jaeger.err.log"

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
    if command -v lsof &>/dev/null; then
        if lsof -i ":$port" -sTCP:LISTEN &>/dev/null; then
            echo "❌ Port $port is already in use"
            return 1
        fi
        return 0
    fi
    if command -v netstat &>/dev/null; then
        if netstat -an 2>/dev/null | grep -E "[:.]${port}[[:space:]]" | grep -qi "listening"; then
            echo "❌ Port $port is already in use"
            return 1
        fi
        return 0
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
if [[ "$EXE_SUFFIX" == ".exe" ]] && command -v powershell.exe &>/dev/null; then
    JAEGER_BIN_WIN="$JAEGER_BIN"
    LOG_FILE_WIN="$LOG_FILE"
    ERR_FILE_WIN="$ERR_FILE"
    if command -v cygpath &>/dev/null; then
        JAEGER_BIN_WIN=$(cygpath -w "$JAEGER_BIN")
        LOG_FILE_WIN=$(cygpath -w "$LOG_FILE")
        ERR_FILE_WIN=$(cygpath -w "$ERR_FILE")
    fi
    powershell.exe -NoProfile -Command "Start-Process -FilePath '$JAEGER_BIN_WIN' -ArgumentList '--collector.otlp.enabled=true','--collector.otlp.http.host-port=:4318','--collector.otlp.grpc.host-port=:4317' -RedirectStandardOutput '$LOG_FILE_WIN' -RedirectStandardError '$ERR_FILE_WIN' -PassThru | Select-Object -ExpandProperty Id" > "$PID_FILE"
    JAEGER_PID=$(tr -d '\r' < "$PID_FILE")
else
    nohup "$JAEGER_BIN" \
        --collector.otlp.enabled=true \
        --collector.otlp.http.host-port=:4318 \
        --collector.otlp.grpc.host-port=:4317 \
        > "$LOG_FILE" 2>&1 &
    JAEGER_PID=$!
    echo "$JAEGER_PID" > "$PID_FILE"
fi

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
