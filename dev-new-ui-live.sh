#!/usr/bin/env bash
set -euo pipefail

# Backward-compatible alias; source of truth is dev-new-ui.sh --live.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT_DIR/dev-new-ui.sh" --live "$@"
