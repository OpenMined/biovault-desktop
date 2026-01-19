#!/usr/bin/env bash
set -euo pipefail
text="${BV_INPUT_TEXT:-${1:-hello}}"
out="${BV_OUTPUT_OUT:-hello.txt}"
printf "%s\n" "$text" > "$out"
