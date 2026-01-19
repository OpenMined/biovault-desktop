#!/usr/bin/env bash
set -euo pipefail
out="${BV_OUTPUT_HELLO:-hello.txt}"
printf "hello from %s\n" "${BV_CURRENT_DATASITE:-unknown}" > "$out"
