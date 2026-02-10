#!/usr/bin/env bash
set -euo pipefail

# Diagnose live SyftBox connectivity for a set of datasites:
# 1) Verify TURN/ICE headers were applied by each client (from desktop.log).
# 2) Send "hello" files between every ordered client pair and verify propagation.

BASE_PATH="${BASE_PATH:-/Users/madhavajay/dev/biovaults}"
EMAILS_CSV="${EMAILS_CSV:-madhava@openmined.org,me@madhavajay.com,test@madhavajay.com}"
TIMEOUT_S="${TIMEOUT_S:-45}"
POLL_S="${POLL_S:-1}"
RUN_ID="${RUN_ID:-live-hello-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
HELLO_SUBDIR="${HELLO_SUBDIR:-shared/diagnostics/hello}"
DRY_RUN=0
SENDER_FILTER="${SENDER_FILTER:-}"
RECEIVER_FILTER="${RECEIVER_FILTER:-}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/diagnose-live-hotlink.sh [options]

Options:
  --base-path PATH        Datasites base path (default: /Users/madhavajay/dev/biovaults)
  --emails CSV            Comma-separated emails
  --timeout-sec N         Wait timeout per hello (default: 45)
  --poll-sec N            Poll interval in seconds (default: 1)
  --run-id ID             Custom run id suffix for hello files
  --hello-subdir PATH     Subdir under shared/ for hello files
  --sender EMAIL          Only test hellos sent from this email
  --receiver EMAIL        Only test hellos sent to this email
  --dry-run               Print planned checks/writes, do not write or wait
  -h, --help              Show this help

Environment equivalents:
  BASE_PATH, EMAILS_CSV, TIMEOUT_S, POLL_S, RUN_ID, HELLO_SUBDIR

Examples:
  ./scripts/diagnose-live-hotlink.sh
  ./scripts/diagnose-live-hotlink.sh --base-path /Users/madhavajay/dev/biovaults \
    --emails madhava@openmined.org,me@madhavajay.com,test@madhavajay.com
EOF
}

info() {
  printf '[diag] %s\n' "$1"
}

warn() {
  printf '[diag][warn] %s\n' "$1"
}

err() {
  printf '[diag][error] %s\n' "$1" >&2
}

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-path)
      BASE_PATH="$2"
      shift 2
      ;;
    --emails)
      EMAILS_CSV="$2"
      shift 2
      ;;
    --timeout-sec)
      TIMEOUT_S="$2"
      shift 2
      ;;
    --poll-sec)
      POLL_S="$2"
      shift 2
      ;;
    --run-id)
      RUN_ID="$2"
      shift 2
      ;;
    --hello-subdir)
      HELLO_SUBDIR="$2"
      shift 2
      ;;
    --sender)
      SENDER_FILTER="$2"
      shift 2
      ;;
    --receiver)
      RECEIVER_FILTER="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if ! [[ "$TIMEOUT_S" =~ ^[0-9]+$ ]]; then
  err "--timeout-sec must be an integer"
  exit 1
fi
if ! [[ "$POLL_S" =~ ^[0-9]+$ ]]; then
  err "--poll-sec must be an integer"
  exit 1
fi
if [[ "$POLL_S" -lt 1 ]]; then
  err "--poll-sec must be >= 1"
  exit 1
fi

IFS=',' read -r -a RAW_EMAILS <<< "$EMAILS_CSV"
EMAILS=()
for e in "${RAW_EMAILS[@]}"; do
  t="$(trim "$e")"
  [[ -n "$t" ]] && EMAILS+=("$t")
done

if [[ ${#EMAILS[@]} -lt 2 ]]; then
  err "Need at least 2 emails; got: $EMAILS_CSV"
  exit 1
fi

if [[ ! -d "$BASE_PATH" ]]; then
  err "Base path does not exist: $BASE_PATH"
  exit 1
fi

info "Base path: $BASE_PATH"
info "Emails: ${EMAILS[*]}"
info "Run id: $RUN_ID"
info "Hello subdir: $HELLO_SUBDIR"
info "Timeout per hello: ${TIMEOUT_S}s (poll ${POLL_S}s)"
[[ -n "$SENDER_FILTER" ]] && info "Sender filter: $SENDER_FILTER"
[[ -n "$RECEIVER_FILTER" ]] && info "Receiver filter: $RECEIVER_FILTER"
if [[ "$DRY_RUN" == "1" ]]; then
  info "Dry-run mode enabled (no writes, no waits)."
fi

turn_total=0
turn_ok=0
hello_total=0
hello_ok=0

info "Checking TURN/ICE header application in desktop logs..."
for email in "${EMAILS[@]}"; do
  turn_total=$((turn_total + 1))
  log_path="$BASE_PATH/$email/logs/desktop.log"
  if [[ ! -f "$log_path" ]]; then
    err "[$email] missing log: $log_path"
    continue
  fi

  ice_line="$(rg -n "hotlink ICE servers from server:" "$log_path" -S | tail -n1 || true)"
  user_line="$(rg -n "hotlink TURN user from server:" "$log_path" -S | tail -n1 || true)"
  pass_line="$(rg -n "hotlink TURN pass from server: \\[set\\]" "$log_path" -S | tail -n1 || true)"

  if [[ -n "$ice_line" && -n "$user_line" && -n "$pass_line" ]]; then
    turn_ok=$((turn_ok + 1))
    ice_value="${ice_line#*hotlink ICE servers from server: }"
    user_value="${user_line#*hotlink TURN user from server: }"
    info "[$email] TURN headers present: ice=${ice_value} user=${user_value}"
  else
    err "[$email] TURN headers missing in desktop.log"
    [[ -z "$ice_line" ]] && warn "[$email] missing ICE server line"
    [[ -z "$user_line" ]] && warn "[$email] missing TURN user line"
    [[ -z "$pass_line" ]] && warn "[$email] missing TURN pass line"
  fi
done

info "Sending hello matrix (${#EMAILS[@]} clients -> ordered pairs)..."
for sender in "${EMAILS[@]}"; do
  if [[ -n "$SENDER_FILTER" && "$sender" != "$SENDER_FILTER" ]]; then
    continue
  fi
  for receiver in "${EMAILS[@]}"; do
    if [[ "$sender" == "$receiver" ]]; then
      continue
    fi
    if [[ -n "$RECEIVER_FILTER" && "$receiver" != "$RECEIVER_FILTER" ]]; then
      continue
    fi

    hello_total=$((hello_total + 1))
    rel_path="$HELLO_SUBDIR/$RUN_ID/${sender}_to_${receiver}.txt"
    sender_path="$BASE_PATH/$sender/datasites/$sender/$rel_path"
    receiver_path="$BASE_PATH/$receiver/datasites/$sender/$rel_path"

    if [[ "$DRY_RUN" == "1" ]]; then
      info "[dry] $sender -> $receiver write=$sender_path expect=$receiver_path"
      hello_ok=$((hello_ok + 1))
      continue
    fi

    mkdir -p "$(dirname "$sender_path")"
    cat > "$sender_path" <<EOF
hello_from=$sender
hello_to=$receiver
run_id=$RUN_ID
sent_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
    info "[$sender -> $receiver] wrote hello: $sender_path"

    start_epoch="$(date +%s)"
    deadline=$((start_epoch + TIMEOUT_S))
    delivered=0
    while true; do
      if [[ -f "$receiver_path" ]]; then
        delivered=1
        break
      fi
      now_epoch="$(date +%s)"
      if (( now_epoch >= deadline )); then
        break
      fi
      sleep "$POLL_S"
    done

    end_epoch="$(date +%s)"
    elapsed=$((end_epoch - start_epoch))
    if [[ "$delivered" == "1" ]]; then
      hello_ok=$((hello_ok + 1))
      info "[$sender -> $receiver] PASS delivered in ${elapsed}s: $receiver_path"
    else
      err "[$sender -> $receiver] FAIL not delivered in ${TIMEOUT_S}s: $receiver_path"
    fi
  done
done

echo
info "Summary:"
info "TURN header checks: ${turn_ok}/${turn_total} passed"
info "Hello deliveries:   ${hello_ok}/${hello_total} passed"

if [[ "$turn_ok" -ne "$turn_total" || "$hello_ok" -ne "$hello_total" ]]; then
  exit 1
fi

exit 0
