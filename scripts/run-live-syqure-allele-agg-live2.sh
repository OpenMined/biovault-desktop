#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Run syqure-allele-agg against live server — same flow as the local sandbox test
but pointed at live datasites and server.

Flows are imported into each backend's DB (same as local test) to avoid
accept_flow_invitation parse issues. Override with SYQURE_ALLELE_AGG_SKIP_FLOW_IMPORT=1
if you're sure the DBs already have the flow.

Defaults:
  CLIENT1 (me@madhavajay.com):   /Users/madhavajay/Downloads/allele_freq_bermuda.tsv
  CLIENT2 (test@madhavajay.com): /Users/madhavajay/Downloads/allele_freq_stlucia.tsv
  AGGREGATOR (madhava@openmined.org): blank input (no allele_freq_tsv override)

Usage:
  ./scripts/run-live-syqure-allele-agg-live2.sh
  ./scripts/run-live-syqure-allele-agg-live2.sh --retry 3
  SYQURE_ALLELE_AGG_CLIENT1_TSV=~/Downloads/allele_freq_bermuda_100000.tsv \
  SYQURE_ALLELE_AGG_CLIENT2_TSV=~/Downloads/allele_freq_stlucia_100000.tsv \
    ./scripts/run-live-syqure-allele-agg-live2.sh

Options:
  --datasites PATH   Existing datasites base to reuse
                     (default: /Users/madhavajay/dev/biovaults-live-test)
  --server-url URL   Live server URL (default: https://dev.syftbox.net)
  --retry N          Repeat up to N attempts until success (default: 1)
  --interactive      Pause before exit for manual inspection (default: on)
  --no-cleanup       Preserve sandbox files after run (default: on)
  --headed           Show browser windows (default: on)
  --help             Show this help
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATASITES_BASE="${DATASITES_BASE:-/Users/madhavajay/dev/biovaults-live-test}"
SERVER_URL="${SERVER_URL:-https://dev.syftbox.net}"
RETRY_COUNT=1

CLIENT1_EMAIL="${CLIENT1_EMAIL:-me@madhavajay.com}"
CLIENT2_EMAIL="${CLIENT2_EMAIL:-test@madhavajay.com}"
AGG_EMAIL="${AGG_EMAIL:-madhava@openmined.org}"

# Default: import the flow (same as local test). Set to 1 to skip if DBs already have it.
SKIP_FLOW_IMPORT="${SYQURE_ALLELE_AGG_SKIP_FLOW_IMPORT:-0}"

CLIENT1_TSV="${SYQURE_ALLELE_AGG_CLIENT1_TSV:-/Users/madhavajay/Downloads/allele_freq_bermuda.tsv}"
CLIENT2_TSV="${SYQURE_ALLELE_AGG_CLIENT2_TSV:-/Users/madhavajay/Downloads/allele_freq_stlucia.tsv}"

# Default flags: interactive + no-cleanup + headed (same experience as local test)
EXTRA_ARGS=(--interactive --no-cleanup)
export NO_CLEANUP=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --datasites)
      [[ -z "${2:-}" ]] && { echo "--datasites requires a path" >&2; exit 1; }
      DATASITES_BASE="$2"
      shift 2
      ;;
    --server-url)
      [[ -z "${2:-}" ]] && { echo "--server-url requires a value" >&2; exit 1; }
      SERVER_URL="$2"
      shift 2
      ;;
    --retry)
      [[ -z "${2:-}" ]] && { echo "--retry requires a value" >&2; exit 1; }
      RETRY_COUNT="$2"
      shift 2
      ;;
    --interactive)
      shift
      ;;
    --no-cleanup)
      shift
      ;;
    --headed)
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! -d "$DATASITES_BASE" ]]; then
  echo "Missing datasites base: $DATASITES_BASE" >&2
  exit 1
fi
if [[ ! -f "$CLIENT1_TSV" ]]; then
  echo "Missing client1 TSV: $CLIENT1_TSV" >&2
  exit 1
fi
if [[ ! -f "$CLIENT2_TSV" ]]; then
  echo "Missing client2 TSV: $CLIENT2_TSV" >&2
  exit 1
fi

echo "Live2 allele-agg config:"
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
  BV_SYQURE_PRELAUNCH_WAIT_S="${BV_SYQURE_PRELAUNCH_WAIT_S:-120}" \
  SYQURE_ALLELE_AGG_SKIP_FLOW_IMPORT="$SKIP_FLOW_IMPORT" \
  SYQURE_ALLELE_AGG_CLIENT1_TSV="$CLIENT1_TSV" \
  SYQURE_ALLELE_AGG_CLIENT2_TSV="$CLIENT2_TSV" \
  ./test-scenario.sh --syqure-allele-agg \
    --reuse-existing-datasites "$DATASITES_BASE" \
    --live-server-url "$SERVER_URL" \
    "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    echo "Attempt $attempt: SUCCESS"
    exit 0
  fi
  echo "Attempt $attempt: FAILED (exit=$rc)"
  attempt=$((attempt + 1))
done

echo "All attempts failed."
exit 1
