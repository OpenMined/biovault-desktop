#!/usr/bin/env bash
set -euo pipefail
in_path="${BV_INPUT_COMBINED:-combined.txt}"
out="${BV_OUTPUT_COMBINED_OUT:-combined_out.txt}"
cp -f "$in_path" "$out"
