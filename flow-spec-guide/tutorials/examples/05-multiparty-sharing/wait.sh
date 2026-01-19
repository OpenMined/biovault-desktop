#!/usr/bin/env bash
set -euo pipefail
path="${BV_INPUT_COMBINED_PATH:-combined.txt}"
out="${BV_OUTPUT_COMBINED_COPY:-combined_copy.txt}"
wait_seconds="${BV_INPUT_WAIT_SECONDS:-120}"

end=$((SECONDS + wait_seconds))
while [[ ! -f "$path" ]]; do
  if (( SECONDS >= end )); then
    echo "Timed out waiting for $path" >&2
    exit 1
  fi
  sleep 1
done

cp -f "$path" "$out"
