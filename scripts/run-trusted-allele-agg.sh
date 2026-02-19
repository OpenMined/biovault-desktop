#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Run trusted-allele-agg locally (sandbox devstack).
Clients share raw TSV with aggregator who computes in plaintext.

Usage:
  ./scripts/run-trusted-allele-agg.sh
  ./scripts/run-trusted-allele-agg.sh --interactive --no-cleanup

Override TSV inputs:
  TRUSTED_ALLELE_AGG_CLIENT1_TSV=~/Downloads/bermuda.tsv \
  TRUSTED_ALLELE_AGG_CLIENT2_TSV=~/Downloads/stlucia.tsv \
    ./scripts/run-trusted-allele-agg.sh

Options:
  --interactive   Pause before exit for manual inspection (default: on)
  --no-cleanup    Preserve sandbox files after run (default: on)
  --help          Show this help
EOF
}

EXTRA_ARGS=(--interactive --no-cleanup)
export NO_CLEANUP=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interactive|--no-cleanup)
      shift ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      EXTRA_ARGS+=("$1"); shift ;;
  esac
done

exec ./test-scenario.sh --trusted-allele-agg "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
