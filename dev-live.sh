#!/usr/bin/env bash
set -euo pipefail

# Short alias for live-mode new-UI launch.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT_DIR/dev-new-ui.sh" --live "$@"
