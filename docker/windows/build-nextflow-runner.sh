#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IMAGE_NAME="${IMAGE_NAME:-biovault/nextflow-runner:25.10.2}"
NEXTFLOW_BASE_IMAGE="${NEXTFLOW_BASE_IMAGE:-nextflow/nextflow:25.10.2}"
DOCKER_CLI_VERSION="${DOCKER_CLI_VERSION:-28.0.1}"

PULL_BASE_IMAGE="${PULL_BASE_IMAGE:-0}"

usage() {
  cat >&2 <<EOF
Usage: $0 [--pull] [--tag <image>] [--base <image>] [--docker-cli-version <version>]

Windows (no Bash/WSL) alternative:
  powershell -ExecutionPolicy Bypass -File docker/windows/build-nextflow-runner.ps1 -Pull

Environment overrides:
  IMAGE_NAME             (default: ${IMAGE_NAME})
  NEXTFLOW_BASE_IMAGE    (default: ${NEXTFLOW_BASE_IMAGE})
  DOCKER_CLI_VERSION     (default: ${DOCKER_CLI_VERSION})
  PULL_BASE_IMAGE        (default: ${PULL_BASE_IMAGE})
EOF
}

while (($#)); do
  case "$1" in
    --pull)
      PULL_BASE_IMAGE=1
      shift
      ;;
    --tag)
      IMAGE_NAME="${2:-}"
      shift 2
      ;;
    --base)
      NEXTFLOW_BASE_IMAGE="${2:-}"
      shift 2
      ;;
    --docker-cli-version)
      DOCKER_CLI_VERSION="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [ -z "${IMAGE_NAME}" ] || [ -z "${NEXTFLOW_BASE_IMAGE}" ] || [ -z "${DOCKER_CLI_VERSION}" ]; then
  echo "Missing required values (tag/base/docker-cli-version)" >&2
  usage
  exit 1
fi

DOCKER_BIN="docker"
if ! command -v "${DOCKER_BIN}" >/dev/null 2>&1; then
  if command -v docker.exe >/dev/null 2>&1; then
    DOCKER_BIN="docker.exe"
  else
    echo "docker not found on PATH" >&2
    exit 1
  fi
fi

echo "[docker] Building ${IMAGE_NAME} (base ${NEXTFLOW_BASE_IMAGE}, docker-cli ${DOCKER_CLI_VERSION})..."

if [ "${PULL_BASE_IMAGE}" = "1" ]; then
  "${DOCKER_BIN}" pull "${NEXTFLOW_BASE_IMAGE}"
fi

"${DOCKER_BIN}" build \
  -f "${SCRIPT_DIR}/Dockerfile.nextflow-runner" \
  --build-arg "NEXTFLOW_BASE_IMAGE=${NEXTFLOW_BASE_IMAGE}" \
  --build-arg "DOCKER_CLI_VERSION=${DOCKER_CLI_VERSION}" \
  -t "${IMAGE_NAME}" \
  "${SCRIPT_DIR}"

echo "[docker] Image ready: ${IMAGE_NAME}"
