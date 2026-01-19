#!/usr/bin/env bash
set -euo pipefail

value_file="${BV_INPUT_VALUE_FILE:-values.txt}"
prev_sum_path="${BV_INPUT_PREV_SUM_PATH:-}"
seed="${BV_INPUT_SEED:-0}"
out="${BV_OUTPUT_PARTIAL:-partial.txt}"

if [[ -n "$prev_sum_path" && -f "$prev_sum_path" ]]; then
  prev_sum=$(cat "$prev_sum_path")
else
  prev_sum="$seed"
fi

value=$(cat "$value_file")

printf "%s\n" "$((prev_sum + value))" > "$out"
