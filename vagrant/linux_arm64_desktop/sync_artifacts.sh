#!/usr/bin/env bash
set -euo pipefail

# Copies the built Linux arm64 artifacts from the host into the desktop VM.

VM_NAME="${VM_NAME:-linux-arm64-desktop}"
VAGRANT_PROVIDER="${VAGRANT_PROVIDER:-utm}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

ARTIFACT_INPUT="${ARTIFACT_INPUT:-${REPO_ROOT}/artifacts/linux_arm64}"
ARTIFACT_DEST="${ARTIFACT_DEST:-/workspace/biovault/artifacts/linux_arm64}"
DESKTOP_TARGET="${DESKTOP_TARGET:-~/Desktop/BioVault}"

if [ ! -d "${ARTIFACT_INPUT}" ]; then
  echo "[sync] Source artifact directory not found: ${ARTIFACT_INPUT}" >&2
  echo "[sync] Run the build script first (./vagrant/linux_arm64/build.sh)." >&2
  exit 1
fi

pushd "${SCRIPT_DIR}" >/dev/null

echo "[sync] Ensuring ${VM_NAME} VM is running..."
VAGRANT_DEFAULT_PROVIDER="${VAGRANT_PROVIDER}" vagrant up "${VM_NAME}"

SSH_CONFIG="$(mktemp)"
trap 'rm -f "${SSH_CONFIG}"' EXIT
vagrant ssh-config "${VM_NAME}" > "${SSH_CONFIG}"

HOST_ALIAS="$(head -n 1 "${SSH_CONFIG}" | awk '{print $2}')"
DEST_ESCAPED="$(printf '%q' "${ARTIFACT_DEST}")"

echo "[sync] Preparing destination directory ${ARTIFACT_DEST}..."
ssh -F "${SSH_CONFIG}" "${HOST_ALIAS}" "mkdir -p ${DEST_ESCAPED}"

echo "[sync] Copying artifacts from ${ARTIFACT_INPUT} to ${ARTIFACT_DEST}..."
rsync -a --delete -e "ssh -F ${SSH_CONFIG}" \
  "${ARTIFACT_INPUT}/" "${HOST_ALIAS}:${ARTIFACT_DEST}/"

if [ -n "${DESKTOP_TARGET}" ]; then
  TARGET_ESCAPED="$(printf '%q' "${DESKTOP_TARGET}")"
  echo "[sync] Mirroring artifacts to desktop folder ${DESKTOP_TARGET}..."
  ssh -F "${SSH_CONFIG}" "${HOST_ALIAS}" "mkdir -p ${TARGET_ESCAPED}"
  rsync -a --delete -e "ssh -F ${SSH_CONFIG}" \
    "${ARTIFACT_INPUT}/" "${HOST_ALIAS}:${DESKTOP_TARGET%/}/"
fi

echo "[sync] Done. Artifacts now available inside the desktop VM at ${ARTIFACT_DEST}."

popd >/dev/null
