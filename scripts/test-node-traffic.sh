#!/bin/bash
set -euo pipefail

# Traffic test for SyftBox node-to-node transport without Syqure.
# It writes .request files under app_data/biovault/rpc and waits for them to
# appear in peer datasite mirrors.

usage() {
  cat <<'EOF'
Usage:
  scripts/test-node-traffic.sh --emails a@x,b@y,c@z --root /path/to/biovaults [options]

Required:
  --emails CSV          Comma-separated emails (2+)
  --root PATH           Root used by biovault-app.sh (contains one dir per email)

Options:
  --messages N          Messages per sender->receiver pair (default: 5)
  --payload-kb N        Payload size in KB per message (default: 32)
  --timeout-s N         Max wait for each delivery in seconds (default: 60)
  --poll-ms N           Poll interval in milliseconds (default: 100)
  --mode MODE           matrix|ring (default: matrix)
  --keep                Keep generated probe files (default: delete run folder first)
  -h, --help            Show this help

Examples:
  scripts/test-node-traffic.sh \
    --emails madhava@openmined.org,me@madhavajay.com,test@madhavajay.com \
    --root /Users/madhavajay/dev/biovaults \
    --messages 10 --payload-kb 64

Notes:
  - This does not run Syqure.
  - It exercises SyftBox transport by syncing:
      app_data/biovault/rpc/traffic-probe/<run_id>/*.request
EOF
}

EMAILS_CSV=""
ROOT=""
MESSAGES=5
PAYLOAD_KB=32
TIMEOUT_S=60
POLL_MS=100
MODE="matrix"
KEEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --emails)
      EMAILS_CSV="${2:-}"
      shift 2
      ;;
    --root)
      ROOT="${2:-}"
      shift 2
      ;;
    --messages)
      MESSAGES="${2:-}"
      shift 2
      ;;
    --payload-kb)
      PAYLOAD_KB="${2:-}"
      shift 2
      ;;
    --timeout-s)
      TIMEOUT_S="${2:-}"
      shift 2
      ;;
    --poll-ms)
      POLL_MS="${2:-}"
      shift 2
      ;;
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --keep)
      KEEP=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$EMAILS_CSV" || -z "$ROOT" ]]; then
  usage
  exit 1
fi

if ! [[ "$MESSAGES" =~ ^[0-9]+$ ]] || [[ "$MESSAGES" -le 0 ]]; then
  echo "--messages must be a positive integer" >&2
  exit 1
fi
if ! [[ "$PAYLOAD_KB" =~ ^[0-9]+$ ]] || [[ "$PAYLOAD_KB" -le 0 ]]; then
  echo "--payload-kb must be a positive integer" >&2
  exit 1
fi
if ! [[ "$TIMEOUT_S" =~ ^[0-9]+$ ]] || [[ "$TIMEOUT_S" -le 0 ]]; then
  echo "--timeout-s must be a positive integer" >&2
  exit 1
fi
if ! [[ "$POLL_MS" =~ ^[0-9]+$ ]] || [[ "$POLL_MS" -le 0 ]]; then
  echo "--poll-ms must be a positive integer" >&2
  exit 1
fi
if [[ "$MODE" != "matrix" && "$MODE" != "ring" ]]; then
  echo "--mode must be one of: matrix, ring" >&2
  exit 1
fi

IFS=',' read -r -a EMAILS <<<"$EMAILS_CSV"
if [[ "${#EMAILS[@]}" -lt 2 ]]; then
  echo "Need at least 2 emails" >&2
  exit 1
fi

for email in "${EMAILS[@]}"; do
  base="$ROOT/$email/datasites/$email"
  if [[ ! -d "$base" ]]; then
    echo "Missing datasite root: $base" >&2
    echo "Start instances first with biovault-app.sh/biovault-app-dev.sh." >&2
    exit 1
  fi
done

if command -v perl >/dev/null 2>&1; then
  now_ms() {
    perl -MTime::HiRes=time -e 'printf("%.0f\n", time()*1000)'
  }
else
  now_ms() {
    # Fallback to whole seconds if perl is unavailable.
    echo $(( $(date +%s) * 1000 ))
  }
fi

run_id="traffic-$(date +%Y%m%d-%H%M%S)-$$"
relative_dir="app_data/biovault/rpc/traffic-probe/$run_id"
payload_bytes=$((PAYLOAD_KB * 1024))
poll_sleep_s="$(awk "BEGIN { printf \"%.3f\", $POLL_MS/1000 }")"

tmp_lat="$(mktemp)"
tmp_fail="$(mktemp)"
trap 'rm -f "$tmp_lat" "$tmp_fail"' EXIT

echo "=== Node Traffic Test (No Syqure) ==="
echo "run_id:      $run_id"
echo "root:        $ROOT"
echo "emails:      $EMAILS_CSV"
echo "mode:        $MODE"
echo "messages:    $MESSAGES"
echo "payload_kb:  $PAYLOAD_KB"
echo "timeout_s:   $TIMEOUT_S"
echo "poll_ms:     $POLL_MS"
echo

delete_sender_run_dir() {
  local sender="$1"
  local sender_dir="$ROOT/$sender/datasites/$sender/$relative_dir"
  if [[ -d "$sender_dir" ]]; then
    rm -rf "$sender_dir"
  fi
}

send_one() {
  local sender="$1"
  local receiver="$2"
  local idx="$3"

  local sender_root="$ROOT/$sender/datasites/$sender"
  local sender_dir="$sender_root/$relative_dir"
  local file_name="${sender}_to_${receiver}_m${idx}.request"
  local sender_file="$sender_dir/$file_name"
  local receiver_file="$ROOT/$receiver/datasites/$sender/$relative_dir/$file_name"

  mkdir -p "$sender_dir"
  rm -f "$sender_file"

  local start_ms
  start_ms="$(now_ms)"

  {
    echo "run_id=$run_id"
    echo "sender=$sender"
    echo "receiver=$receiver"
    echo "message_index=$idx"
    echo "payload_bytes=$payload_bytes"
    echo "start_ms=$start_ms"
    # Keep the rest deterministic payload so file size is stable.
    if [[ "$payload_bytes" -gt 0 ]]; then
      dd if=/dev/zero bs=1 count="$payload_bytes" 2>/dev/null | tr '\0' 'x'
    fi
  } > "$sender_file"

  local deadline_ms=$((start_ms + TIMEOUT_S * 1000))
  local end_ms=0
  while true; do
    if [[ -f "$receiver_file" ]]; then
      end_ms="$(now_ms)"
      break
    fi
    if [[ "$(now_ms)" -ge "$deadline_ms" ]]; then
      echo "FAIL timeout sender=$sender receiver=$receiver msg=$idx file=$receiver_file" | tee -a "$tmp_fail"
      return 1
    fi
    sleep "$poll_sleep_s"
  done

  local latency_ms=$((end_ms - start_ms))
  local recv_size
  recv_size="$(wc -c < "$receiver_file" | tr -d ' ')"
  echo "$latency_ms" >> "$tmp_lat"
  echo "OK   sender=$sender receiver=$receiver msg=$idx latency_ms=$latency_ms bytes=$recv_size"
  return 0
}

if [[ "$KEEP" -eq 0 ]]; then
  for sender in "${EMAILS[@]}"; do
    delete_sender_run_dir "$sender"
  done
fi

total=0
failed=0

if [[ "$MODE" == "matrix" ]]; then
  for sender in "${EMAILS[@]}"; do
    for receiver in "${EMAILS[@]}"; do
      if [[ "$sender" == "$receiver" ]]; then
        continue
      fi
      for ((i=1; i<=MESSAGES; i++)); do
        total=$((total + 1))
        if ! send_one "$sender" "$receiver" "$i"; then
          failed=$((failed + 1))
        fi
      done
    done
  done
else
  # ring: email[i] -> email[(i+1)%N]
  n="${#EMAILS[@]}"
  for ((s=0; s<n; s++)); do
    sender="${EMAILS[$s]}"
    receiver="${EMAILS[$(((s + 1) % n))]}"
    for ((i=1; i<=MESSAGES; i++)); do
      total=$((total + 1))
      if ! send_one "$sender" "$receiver" "$i"; then
        failed=$((failed + 1))
      fi
    done
  done
fi

echo
echo "=== Summary ==="
echo "total_messages: $total"
echo "failed:         $failed"
echo "succeeded:      $((total - failed))"

if [[ -s "$tmp_lat" ]]; then
  awk '
    BEGIN { min=-1; max=0; sum=0; count=0; }
    {
      v=$1+0;
      if (min < 0 || v < min) min=v;
      if (v > max) max=v;
      sum += v;
      count++;
      a[count]=v;
    }
    END {
      if (count == 0) exit 0;
      n=count;
      # insertion sort (small n in these tests)
      for (i=2; i<=n; i++) {
        key=a[i];
        j=i-1;
        while (j>=1 && a[j]>key) { a[j+1]=a[j]; j--; }
        a[j+1]=key;
      }
      p50=a[int((n+1)*0.50)];
      p95=a[int((n+1)*0.95)];
      if (p50 == 0 && n > 0) p50=a[1];
      if (p95 == 0 && n > 0) p95=a[n];
      avg=sum/count;
      printf("latency_ms_min: %d\n", min);
      printf("latency_ms_p50: %d\n", p50);
      printf("latency_ms_p95: %d\n", p95);
      printf("latency_ms_max: %d\n", max);
      printf("latency_ms_avg: %.1f\n", avg);
    }
  ' "$tmp_lat"
fi

if [[ -s "$tmp_fail" ]]; then
  echo
  echo "Failures:"
  cat "$tmp_fail"
fi

if [[ "$failed" -gt 0 ]]; then
  exit 2
fi
