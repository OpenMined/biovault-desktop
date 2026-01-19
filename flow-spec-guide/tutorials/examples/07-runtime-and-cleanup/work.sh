#!/usr/bin/env bash
set -euo pipefail
work_dir="${BV_WORK_DIR:-work}"
report="${BV_OUTPUT_REPORT:-report.txt}"

mkdir -p "$work_dir"
printf "work_dir=%s\n" "$work_dir" > "$work_dir/run.txt"
cp -f "$work_dir/run.txt" "$report"
