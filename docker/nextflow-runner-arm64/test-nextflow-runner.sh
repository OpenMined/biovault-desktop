#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IMAGE_NAME="${IMAGE_NAME:-ghcr.io/openmined/nextflow-runner:25.10.2-arm64}"
PLATFORM="${PLATFORM:-linux/arm64}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

TESTS_PASSED=0
TESTS_FAILED=0

log_test() {
  echo -e "${YELLOW}[TEST]${NC} $1"
}

log_pass() {
  echo -e "${GREEN}[PASS]${NC} $1"
  ((TESTS_PASSED++))
}

log_fail() {
  echo -e "${RED}[FAIL]${NC} $1"
  ((TESTS_FAILED++))
}

echo "========================================"
echo "Testing ARM64 Nextflow Runner"
echo "========================================"
echo "Image: ${IMAGE_NAME}"
echo "Platform: ${PLATFORM}"
echo "========================================"
echo ""

# Test 1: Image exists
log_test "Checking image exists..."
if docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
  log_pass "Image exists"
else
  log_fail "Image not found: ${IMAGE_NAME}"
  echo "Run build-nextflow-runner.sh first"
  exit 1
fi

# Test 2: Nextflow version
log_test "Checking Nextflow version..."
NF_VERSION=$(docker run --rm --platform "${PLATFORM}" "${IMAGE_NAME}" -version 2>&1 | grep -oP 'version \K[0-9.]+' | head -1 || echo "")
if [ -n "${NF_VERSION}" ]; then
  log_pass "Nextflow version: ${NF_VERSION}"
else
  log_fail "Could not get Nextflow version"
fi

# Test 3: Docker CLI version
log_test "Checking Docker CLI version..."
DOCKER_VERSION=$(docker run --rm --platform "${PLATFORM}" --entrypoint docker "${IMAGE_NAME}" --version 2>&1 | grep -oP 'Docker version \K[0-9.]+' || echo "")
if [ -n "${DOCKER_VERSION}" ]; then
  log_pass "Docker CLI version: ${DOCKER_VERSION}"
else
  log_fail "Could not get Docker CLI version"
fi

# Test 4: Podman CLI version
log_test "Checking Podman CLI version..."
PODMAN_VERSION=$(docker run --rm --platform "${PLATFORM}" --entrypoint podman "${IMAGE_NAME}" --version 2>&1 | grep -oP 'podman version \K[0-9.]+' || echo "")
if [ -n "${PODMAN_VERSION}" ]; then
  log_pass "Podman CLI version: ${PODMAN_VERSION}"
else
  log_fail "Could not get Podman CLI version"
fi

# Test 5: Java version
log_test "Checking Java version..."
JAVA_VERSION=$(docker run --rm --platform "${PLATFORM}" --entrypoint java "${IMAGE_NAME}" -version 2>&1 | grep -oP 'version "\K[0-9.]+' | head -1 || echo "")
if [ -n "${JAVA_VERSION}" ]; then
  log_pass "Java version: ${JAVA_VERSION}"
else
  log_fail "Could not get Java version"
fi

# Test 6: Architecture check
log_test "Checking image architecture..."
ARCH=$(docker image inspect "${IMAGE_NAME}" --format '{{.Architecture}}' 2>/dev/null || echo "unknown")
if [ "${ARCH}" = "arm64" ]; then
  log_pass "Architecture: ${ARCH}"
else
  log_fail "Expected arm64, got: ${ARCH}"
fi

# Test 7: Basic Nextflow execution (dry run)
log_test "Running basic Nextflow test..."
TEST_OUTPUT=$(docker run --rm --platform "${PLATFORM}" "${IMAGE_NAME}" info 2>&1 || echo "FAILED")
if echo "${TEST_OUTPUT}" | grep -q "Version"; then
  log_pass "Nextflow info command works"
else
  log_fail "Nextflow info command failed"
fi

# Test 8: Non-root user check
log_test "Checking non-root user..."
USER_ID=$(docker run --rm --platform "${PLATFORM}" --entrypoint id "${IMAGE_NAME}" -u 2>&1 || echo "0")
if [ "${USER_ID}" = "1000" ]; then
  log_pass "Running as non-root user (uid=1000)"
else
  log_fail "Expected uid=1000, got: ${USER_ID}"
fi

# Test 9: Tini init check
log_test "Checking tini init..."
INIT_CHECK=$(docker run --rm --platform "${PLATFORM}" --entrypoint ls "${IMAGE_NAME}" -la /sbin/tini 2>&1 || echo "")
if echo "${INIT_CHECK}" | grep -q "tini"; then
  log_pass "Tini init present"
else
  log_fail "Tini init not found"
fi

# Summary
echo ""
echo "========================================"
echo "Test Summary"
echo "========================================"
echo -e "${GREEN}Passed:${NC} ${TESTS_PASSED}"
echo -e "${RED}Failed:${NC} ${TESTS_FAILED}"
echo "========================================"

if [ "${TESTS_FAILED}" -gt 0 ]; then
  exit 1
fi

echo ""
echo "✅ All tests passed!"
