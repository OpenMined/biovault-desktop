#!/usr/bin/env bash
set -euo pipefail

# Builds the Linux arm64 Tauri bundle inside the VM and copies it back to the host.

VM_NAME="${VM_NAME:-linux-arm64}"
VAGRANT_PROVIDER="${VAGRANT_PROVIDER:-utm}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

ARTIFACT_SOURCE="${ARTIFACT_SOURCE:-/workspace/biovault/src-tauri/target/aarch64-unknown-linux-gnu/release/bundle}"
ARTIFACT_OUTPUT="${ARTIFACT_OUTPUT:-${REPO_ROOT}/artifacts/linux_arm64}"

mkdir -p "${ARTIFACT_OUTPUT}"

pushd "${SCRIPT_DIR}" >/dev/null

echo "[build] Ensuring ${VM_NAME} VM is running..."
VAGRANT_DEFAULT_PROVIDER="${VAGRANT_PROVIDER}" vagrant up "${VM_NAME}"

echo "[build] Syncing host changes into the VM..."
vagrant rsync "${VM_NAME}"

echo "[build] Running build inside the VM..."
vagrant ssh "${VM_NAME}" --command "bash -s" <<'EOF'
set -euo pipefail

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi

export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

cd /workspace/biovault

echo "[vm] Installing npm dependencies..."
npm install

echo "[vm] Building Tauri bundle for aarch64-unknown-linux-gnu..."
npm run tauri build -- --target aarch64-unknown-linux-gnu
EOF

SSH_CONFIG="$(mktemp)"
trap 'rm -f "${SSH_CONFIG}"' EXIT
vagrant ssh-config "${VM_NAME}" > "${SSH_CONFIG}"

HOST_ALIAS="$(head -n 1 "${SSH_CONFIG}" | awk '{print $2}')"

echo "[build] Fetching artifacts to ${ARTIFACT_OUTPUT}..."
rsync -a --delete -e "ssh -F ${SSH_CONFIG}" \
  "${HOST_ALIAS}:${ARTIFACT_SOURCE}/" "${ARTIFACT_OUTPUT}/"

echo "[build] Done. Artifacts are in ${ARTIFACT_OUTPUT}".

popd >/dev/null
