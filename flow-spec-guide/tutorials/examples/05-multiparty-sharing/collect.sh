#!/usr/bin/env bash
set -euo pipefail
manifest="${BV_INPUT_SHARED_PATHS:-shared_paths.txt}"
out="${BV_OUTPUT_COMBINED:-combined.txt}"

: > "$out"
while IFS=$'\t' read -r site path; do
  if [[ -n "$path" && -f "$path" ]]; then
    printf "%s\t" "$site" >> "$out"
    cat "$path" >> "$out"
    printf "\n" >> "$out"
  fi
done < "$manifest"
