#!/usr/bin/env bash
set -euo pipefail
text="${BV_INPUT_TEXT:-hello}"
out="${BV_OUTPUT_MESSAGE:-message.txt}"
printf "%s\n" "$text" > "$out"
