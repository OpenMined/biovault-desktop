#!/bin/bash
# Stop Jaeger all-in-one

set -euo pipefail

JAEGER_DIR="${JAEGER_DIR:-$HOME/.local/share/jaeger}"
PID_FILE="$JAEGER_DIR/jaeger.pid"

if [[ ! -f "$PID_FILE" ]]; then
    echo "⚠️  Jaeger not running (no PID file)"

    # Check for orphaned process
    if command -v pgrep &>/dev/null; then
    ORPHAN_PID=$(pgrep -f "jaeger-all-in-one" 2>/dev/null || true)
    if [[ -n "$ORPHAN_PID" ]]; then
        echo "🔍 Found orphaned Jaeger process (PID: $ORPHAN_PID)"
        echo "   Kill with: kill $ORPHAN_PID"
    fi
    fi
    exit 0
fi

JAEGER_PID=$(cat "$PID_FILE")

if kill -0 "$JAEGER_PID" 2>/dev/null; then
    echo "🛑 Stopping Jaeger (PID: $JAEGER_PID)..."
    kill "$JAEGER_PID"

    # Wait for graceful shutdown
    for i in {1..10}; do
        if ! kill -0 "$JAEGER_PID" 2>/dev/null; then
            echo "✅ Jaeger stopped"
            rm -f "$PID_FILE"
            exit 0
        fi
        sleep 0.5
    done

    # Force kill
    echo "⚠️  Force killing..."
    kill -9 "$JAEGER_PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "✅ Jaeger stopped (force)"
else
    echo "⚠️  Jaeger process not found (stale PID file)"
    rm -f "$PID_FILE"
fi
