#!/bin/bash
# Clear Jaeger traces by restarting (in-memory storage)
# Faster than stop + start

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🗑️  Clearing Jaeger traces..."

# Stop if running
"$SCRIPT_DIR/stop-jaeger.sh" 2>/dev/null || true

# Brief pause
sleep 0.5

# Start fresh
"$SCRIPT_DIR/start-jaeger.sh"

echo ""
echo "✅ Jaeger restarted with empty trace store"
