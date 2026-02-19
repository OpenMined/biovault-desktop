#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Run trusted-allele-agg against live server.
Clients share raw allele_freq TSV with aggregator who computes in plaintext.

Defaults:
  CLIENT1 (me@madhavajay.com):   /Users/madhavajay/Downloads/allele_freq_bermuda.tsv
  CLIENT2 (test@madhavajay.com): /Users/madhavajay/Downloads/allele_freq_stlucia.tsv
  AGGREGATOR (madhava@openmined.org): no input

Usage:
  ./scripts/run-live-trusted-allele-agg.sh
  TRUSTED_ALLELE_AGG_CLIENT1_TSV=~/Downloads/allele_freq_bermuda_100000.tsv \
  TRUSTED_ALLELE_AGG_CLIENT2_TSV=~/Downloads/allele_freq_stlucia_100000.tsv \
    ./scripts/run-live-trusted-allele-agg.sh

Options:
  --datasites PATH   Existing datasites base (default: /Users/madhavajay/dev/biovaults-live-test)
  --server-url URL   Live server URL (default: https://dev.syftbox.net)
  --retry N          Repeat up to N attempts (default: 1)
  --help             Show this help
EOF
}

DATASITES_BASE="${DATASITES_BASE:-/Users/madhavajay/dev/biovaults-live-test}"
SERVER_URL="${SERVER_URL:-https://dev.syftbox.net}"
RETRY_COUNT=1

CLIENT1_EMAIL="${CLIENT1_EMAIL:-me@madhavajay.com}"
CLIENT2_EMAIL="${CLIENT2_EMAIL:-test@madhavajay.com}"
AGG_EMAIL="${AGG_EMAIL:-madhava@openmined.org}"

SKIP_FLOW_IMPORT="${TRUSTED_ALLELE_AGG_SKIP_FLOW_IMPORT:-0}"

CLIENT1_TSV="${TRUSTED_ALLELE_AGG_CLIENT1_TSV:-/Users/madhavajay/Downloads/allele_freq_bermuda.tsv}"
CLIENT2_TSV="${TRUSTED_ALLELE_AGG_CLIENT2_TSV:-/Users/madhavajay/Downloads/allele_freq_stlucia.tsv}"

EXTRA_ARGS=(--interactive --no-cleanup)
export NO_CLEANUP=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --datasites)
      [[ -z "${2:-}" ]] && { echo "--datasites requires a path" >&2; exit 1; }
      DATASITES_BASE="$2"; shift 2 ;;
    --server-url)
      [[ -z "${2:-}" ]] && { echo "--server-url requires a value" >&2; exit 1; }
      SERVER_URL="$2"; shift 2 ;;
    --retry)
      [[ -z "${2:-}" ]] && { echo "--retry requires a value" >&2; exit 1; }
      RETRY_COUNT="$2"; shift 2 ;;
    --interactive|--no-cleanup)
      shift ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ ! -d "$DATASITES_BASE" ]]; then
  echo "Missing datasites base: $DATASITES_BASE" >&2; exit 1
fi
if [[ ! -f "$CLIENT1_TSV" ]]; then
  echo "Missing client1 TSV: $CLIENT1_TSV" >&2; exit 1
fi
if [[ ! -f "$CLIENT2_TSV" ]]; then
  echo "Missing client2 TSV: $CLIENT2_TSV" >&2; exit 1
fi

echo "Live trusted-allele-agg config:"
echo "  datasites: $DATASITES_BASE"
echo "  server:    $SERVER_URL"
echo "  client1:   $CLIENT1_EMAIL -> $CLIENT1_TSV"
echo "  client2:   $CLIENT2_EMAIL -> $CLIENT2_TSV"
echo "  agg:       $AGG_EMAIL -> <blank>"
echo "  flow import: $([ "$SKIP_FLOW_IMPORT" = "1" ] && echo "skip" || echo "import")"
echo "  retries:   $RETRY_COUNT"

attempt=1
while [[ "$attempt" -le "$RETRY_COUNT" ]]; do
  echo
  echo "=== Attempt $attempt/$RETRY_COUNT ==="
  set +e
  PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/Library/Caches/ms-playwright}" \
  CLIENT1_EMAIL="$CLIENT1_EMAIL" \
  CLIENT2_EMAIL="$CLIENT2_EMAIL" \
  AGG_EMAIL="$AGG_EMAIL" \
  DEVSTACK_SYNC_TIMEOUT="${DEVSTACK_SYNC_TIMEOUT:-180}" \
  TRUSTED_ALLELE_AGG_SKIP_FLOW_IMPORT="$SKIP_FLOW_IMPORT" \
  TRUSTED_ALLELE_AGG_CLIENT1_TSV="$CLIENT1_TSV" \
  TRUSTED_ALLELE_AGG_CLIENT2_TSV="$CLIENT2_TSV" \
  ./test-scenario.sh --trusted-allele-agg \
    --reuse-existing-datasites "$DATASITES_BASE" \
    --live-server-url "$SERVER_URL" \
    "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    echo "Attempt $attempt: SUCCESS"; exit 0
  fi
  echo "Attempt $attempt: FAILED (exit=$rc)"
  attempt=$((attempt + 1))
done

echo "All attempts failed."
exit 1
