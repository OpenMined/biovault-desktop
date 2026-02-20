#!/usr/bin/env bash
set -euo pipefail

# Generic test script for nextflow-runner images (amd64 and arm64)
# Usage: IMAGE_NAME=ghcr.io/... PLATFORM=linux/amd64 ./test-nextflow-runner.sh

IMAGE_NAME="${IMAGE_NAME:?IMAGE_NAME env var required}"
PLATFORM="${PLATFORM:-linux/amd64}"
EXPECTED_ARCH="${EXPECTED_ARCH:-amd64}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

TESTS_PASSED=0
TESTS_FAILED=0

log_test() {
  echo -e "${YELLOW}[TEST]${NC} $1"
}

log_pass() {
  echo -e "${GREEN}[PASS]${NC} $1"
  TESTS_PASSED=$((TESTS_PASSED + 1))
}

log_fail() {
  echo -e "${RED}[FAIL]${NC} $1"
  TESTS_FAILED=$((TESTS_FAILED + 1))
}

echo "========================================"
echo "Testing Nextflow Runner"
echo "========================================"
echo "Image: ${IMAGE_NAME}"
echo "Platform: ${PLATFORM}"
echo "Expected arch: ${EXPECTED_ARCH}"
echo "========================================"
echo ""

# Test 1: Image exists
log_test "Checking image exists..."
if docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
  log_pass "Image exists"
else
  log_fail "Image not found: ${IMAGE_NAME}"
  exit 1
fi

# Test 2: Architecture check
log_test "Checking image architecture..."
ARCH=$(docker image inspect "${IMAGE_NAME}" --format '{{.Architecture}}' 2>/dev/null || echo "unknown")
if [ "${ARCH}" = "${EXPECTED_ARCH}" ]; then
  log_pass "Architecture: ${ARCH}"
else
  log_fail "Expected ${EXPECTED_ARCH}, got: ${ARCH}"
fi

# Test 3: Nextflow version
log_test "Checking Nextflow version..."
NF_VERSION=$(docker run --rm --platform "${PLATFORM}" --entrypoint nextflow "${IMAGE_NAME}" -version 2>&1 | grep -oP 'version \K[0-9.]+' | head -1 || echo "")
if [ -n "${NF_VERSION}" ]; then
  log_pass "Nextflow version: ${NF_VERSION}"
else
  log_fail "Could not get Nextflow version"
fi

# Test 4: Docker CLI version
log_test "Checking Docker CLI version..."
DOCKER_VERSION=$(docker run --rm --platform "${PLATFORM}" --entrypoint docker "${IMAGE_NAME}" --version 2>&1 | grep -oP 'Docker version \K[0-9.]+' || echo "")
if [ -n "${DOCKER_VERSION}" ]; then
  log_pass "Docker CLI version: ${DOCKER_VERSION}"
else
  log_fail "Could not get Docker CLI version"
fi

# Test 5: Podman CLI version
log_test "Checking Podman CLI version..."
PODMAN_VERSION=$(docker run --rm --platform "${PLATFORM}" --entrypoint podman "${IMAGE_NAME}" --version 2>&1 | grep -oP 'podman version \K[0-9.]+' || echo "")
if [ -n "${PODMAN_VERSION}" ]; then
  log_pass "Podman CLI version: ${PODMAN_VERSION}"
else
  log_fail "Could not get Podman CLI version"
fi

# Test 6: Java version
log_test "Checking Java version..."
JAVA_VERSION=$(docker run --rm --platform "${PLATFORM}" --entrypoint java "${IMAGE_NAME}" -version 2>&1 | grep -oP 'version "\K[0-9.]+' | head -1 || echo "")
if [ -n "${JAVA_VERSION}" ]; then
  log_pass "Java version: ${JAVA_VERSION}"
else
  log_fail "Could not get Java version"
fi

# Test 7: Nextflow info command
log_test "Running Nextflow info command..."
TEST_OUTPUT=$(docker run --rm --platform "${PLATFORM}" --entrypoint nextflow "${IMAGE_NAME}" info 2>&1 || echo "FAILED")
if echo "${TEST_OUTPUT}" | grep -q "Version"; then
  log_pass "Nextflow info command works"
else
  log_fail "Nextflow info command failed"
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
echo "All tests passed!"
