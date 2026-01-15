#!/usr/bin/env bash
set -euo pipefail
printf "hello from %s\n" "${BV_CURRENT_DATASITE:-local}" > "${BV_OUTPUT_MESSAGE}"
