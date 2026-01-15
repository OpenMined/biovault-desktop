#!/usr/bin/env bash
set -euo pipefail
in_path="${BV_INPUT_HELLO_FILE:-hello.txt}"
out="${BV_OUTPUT_TAGGED:-tagged.txt}"
site="${BV_CURRENT_DATASITE:-unknown}"
{
  printf "%s\t" "$site"
  cat "$in_path"
} > "$out"
