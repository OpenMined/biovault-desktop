#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_SYNC_SCRIPT="${SCRIPT_DIR}/../linux_arm64_desktop/sync_artifacts.sh"

if [ ! -x "${DESKTOP_SYNC_SCRIPT}" ]; then
  echo "[copy] Expected desktop sync script at ${DESKTOP_SYNC_SCRIPT} (missing or not executable)." >&2
  echo "[copy] Ensure the desktop VM tooling is present." >&2
  exit 1
fi

exec "${DESKTOP_SYNC_SCRIPT}" "$@"
