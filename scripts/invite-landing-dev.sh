#!/bin/bash
# Local development server for testing the invite landing page
#
# This script:
# 1. Adds app.biovault.net to /etc/hosts pointing to localhost
# 2. Starts a simple Python HTTP server to serve the landing page
#
# Usage:
#   ./scripts/invite-landing-dev.sh start   # Start the dev server
#   ./scripts/invite-landing-dev.sh stop    # Stop and cleanup
#
# The landing page will be accessible at:
#   http://app.biovault.net:8080/invite?from=user@example.com

set -e

HOSTS_ENTRY="127.0.0.1 app.biovault.net"
LANDING_DIR="$(dirname "$0")/../landing"
PORT=8080
PID_FILE="/tmp/biovault-landing-server.pid"

start_server() {
    echo "Setting up local invite landing page development..."

    # Check if hosts entry exists
    if ! grep -q "app.biovault.net" /etc/hosts; then
        echo "Adding app.biovault.net to /etc/hosts (requires sudo)..."
        echo "$HOSTS_ENTRY" | sudo tee -a /etc/hosts > /dev/null
        echo "Added: $HOSTS_ENTRY"
    else
        echo "app.biovault.net already in /etc/hosts"
    fi

    # Create landing directory if it doesn't exist
    mkdir -p "$LANDING_DIR"

    # Create a simple landing page if it doesn't exist
    if [ ! -f "$LANDING_DIR/invite/index.html" ]; then
        mkdir -p "$LANDING_DIR/invite"
        cat > "$LANDING_DIR/invite/index.html" << 'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Join BioVault</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .card {
            background: white;
            border-radius: 16px;
            padding: 40px;
            max-width: 480px;
            width: 100%;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
        }
        .logo {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #10b981, #059669);
            border-radius: 20px;
            margin: 0 auto 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 40px;
        }
        h1 {
            color: #1e293b;
            font-size: 28px;
            margin-bottom: 12px;
        }
        .invite-from {
            color: #10b981;
            font-weight: 600;
            font-size: 18px;
            margin-bottom: 16px;
        }
        p {
            color: #64748b;
            line-height: 1.6;
            margin-bottom: 32px;
        }
        .download-btn {
            display: inline-block;
            background: linear-gradient(135deg, #10b981, #059669);
            color: white;
            padding: 16px 32px;
            border-radius: 12px;
            text-decoration: none;
            font-weight: 600;
            font-size: 16px;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        .download-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(16, 185, 129, 0.4);
        }
        .platforms {
            margin-top: 24px;
            display: flex;
            gap: 12px;
            justify-content: center;
            flex-wrap: wrap;
        }
        .platform-btn {
            padding: 10px 20px;
            background: #f1f5f9;
            border-radius: 8px;
            color: #475569;
            text-decoration: none;
            font-size: 14px;
            transition: background 0.2s;
        }
        .platform-btn:hover {
            background: #e2e8f0;
        }
        .footer {
            margin-top: 32px;
            color: #94a3b8;
            font-size: 13px;
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="logo">🔐</div>
        <h1>You're Invited to BioVault</h1>
        <div class="invite-from" id="inviteFrom"></div>
        <p>BioVault is a secure platform for private data analysis and collaboration. Download the app to get started.</p>

        <a href="https://github.com/OpenMined/biovault-desktop/releases/latest" class="download-btn">
            Download BioVault
        </a>

        <div class="platforms">
            <a href="https://github.com/OpenMined/biovault-desktop/releases/latest/download/BioVault_aarch64.dmg" class="platform-btn">macOS (Apple Silicon)</a>
            <a href="https://github.com/OpenMined/biovault-desktop/releases/latest/download/BioVault_x64.dmg" class="platform-btn">macOS (Intel)</a>
        </div>

        <div class="footer">
            Powered by OpenMined
        </div>
    </div>

    <script>
        const params = new URLSearchParams(window.location.search);
        const from = params.get('from');
        const inviteFromEl = document.getElementById('inviteFrom');

        if (from) {
            inviteFromEl.textContent = `${from} wants to collaborate with you`;
        } else {
            inviteFromEl.style.display = 'none';
        }
    </script>
</body>
</html>
EOF
        echo "Created landing page at $LANDING_DIR/invite/index.html"
    fi

    # Stop existing server if running
    if [ -f "$PID_FILE" ]; then
        kill $(cat "$PID_FILE") 2>/dev/null || true
        rm "$PID_FILE"
    fi

    # Start Python HTTP server
    echo "Starting HTTP server on port $PORT..."
    cd "$LANDING_DIR"
    python3 -m http.server $PORT &
    echo $! > "$PID_FILE"

    echo ""
    echo "=========================================="
    echo "Invite landing page is running!"
    echo ""
    echo "Test URL:"
    echo "  http://app.biovault.net:$PORT/invite?from=test@example.com"
    echo ""
    echo "To stop: ./scripts/invite-landing-dev.sh stop"
    echo "=========================================="
}

stop_server() {
    echo "Stopping invite landing page development server..."

    # Stop the server
    if [ -f "$PID_FILE" ]; then
        kill $(cat "$PID_FILE") 2>/dev/null || true
        rm "$PID_FILE"
        echo "Server stopped"
    else
        echo "No server running"
    fi

    # Optionally remove hosts entry
    read -p "Remove app.biovault.net from /etc/hosts? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        sudo sed -i '' '/app.biovault.net/d' /etc/hosts
        echo "Removed hosts entry"
    fi
}

case "${1:-start}" in
    start)
        start_server
        ;;
    stop)
        stop_server
        ;;
    *)
        echo "Usage: $0 {start|stop}"
        exit 1
        ;;
esac
