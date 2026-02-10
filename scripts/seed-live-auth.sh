#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Seed auth-critical BioVault/SyftBox files into target datasites.

Usage:
  ./scripts/seed-live-auth.sh \
    --source /path/to/authfiles \
    --target /path/to/datasites \
    --emails "me@example.com,test@example.com,agg@example.com" \
    [--presynced-datasites /path/to/presynced]

Options:
  --source PATH     Source auth template base (contains one dir per email)
  --target PATH     Target datasites base (one dir per email)
  --server-url URL  SyftBox server URL to write into seeded configs
                    (default: https://dev.syftbox.net)
  --emails CSV      Comma-separated emails to seed
  --presynced-datasites PATH
                    Optional datasites snapshot root to warm sync
  --help            Show this help

Notes:
  - Seeds only:
      config.yaml
      syftbox/config.json
      .data/syft.sub.yaml (if present)
      .syc/keys/<email>.key (required)
      .syc/config/datasite.json (if present; paths rewritten)
      .syc/bundles/<participant>.json (if present)
  - Rewrites data_dir/server_url/email for target location.
  - If --presynced-datasites is set, copies datasites snapshot into
    target <email>/datasites (best effort).
EOF
}

SOURCE_BASE=""
TARGET_BASE=""
SERVER_URL=""
EMAILS_CSV=""
PRESYNC_DATASITES_BASE=""

DEFAULT_SERVER_URL="https://dev.syftbox.net"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE_BASE="${2:-}"
      shift 2
      ;;
    --target)
      TARGET_BASE="${2:-}"
      shift 2
      ;;
    --server-url)
      SERVER_URL="${2:-}"
      shift 2
      ;;
    --emails)
      EMAILS_CSV="${2:-}"
      shift 2
      ;;
    --presynced-datasites)
      PRESYNC_DATASITES_BASE="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$SOURCE_BASE" || -z "$TARGET_BASE" || -z "$EMAILS_CSV" ]]; then
  usage
  exit 1
fi

if [[ -z "$SERVER_URL" ]]; then
  SERVER_URL="$DEFAULT_SERVER_URL"
fi

if [[ ! -d "$SOURCE_BASE" ]]; then
  echo "Source base does not exist: $SOURCE_BASE" >&2
  exit 1
fi

if [[ -n "$PRESYNC_DATASITES_BASE" && ! -d "$PRESYNC_DATASITES_BASE" ]]; then
  echo "Presynced datasites base does not exist: $PRESYNC_DATASITES_BASE" >&2
  exit 1
fi

mkdir -p "$TARGET_BASE"

IFS=',' read -r -a EMAILS <<<"$EMAILS_CSV"
if [[ "${#EMAILS[@]}" -eq 0 ]]; then
  echo "No emails parsed from --emails" >&2
  exit 1
fi

for raw_email in "${EMAILS[@]}"; do
  email="$(printf '%s' "$raw_email" | xargs)"
  if [[ -z "$email" ]]; then
    continue
  fi

  src_dir="$SOURCE_BASE/$email"
  dst_dir="$TARGET_BASE/$email"
  src_cfg_yaml="$src_dir/config.yaml"
  src_syft_cfg="$src_dir/syftbox/config.json"
  src_sub_yaml="$src_dir/.data/syft.sub.yaml"
  dst_cfg_yaml="$dst_dir/config.yaml"
  dst_syft_cfg="$dst_dir/syftbox/config.json"
  dst_sub_yaml="$dst_dir/.data/syft.sub.yaml"
  src_syc_key="$src_dir/.syc/keys/$email.key"
  src_syc_datasite="$src_dir/.syc/config/datasite.json"
  dst_syc_key="$dst_dir/.syc/keys/$email.key"
  dst_syc_datasite="$dst_dir/.syc/config/datasite.json"
  presync_datasite_a="$PRESYNC_DATASITES_BASE/$email/datasites"
  presync_datasite_b="$PRESYNC_DATASITES_BASE/datasites/$email"

  if [[ ! -f "$src_cfg_yaml" ]]; then
    echo "Missing source file: $src_cfg_yaml" >&2
    exit 1
  fi
  if [[ ! -f "$src_syft_cfg" ]]; then
    echo "Missing source file: $src_syft_cfg" >&2
    exit 1
  fi

  mkdir -p "$dst_dir/syftbox" "$dst_dir/.data" "$dst_dir/.syc/keys" "$dst_dir/.syc/config" "$dst_dir/.syc/bundles"

  cp "$src_cfg_yaml" "$dst_cfg_yaml"
  cp "$src_syft_cfg" "$dst_syft_cfg"
  if [[ -f "$src_sub_yaml" ]]; then
    cp "$src_sub_yaml" "$dst_sub_yaml"
  fi
  if [[ ! -f "$src_syc_key" ]]; then
    echo "Missing required source key: $src_syc_key" >&2
    exit 1
  fi
  cp "$src_syc_key" "$dst_syc_key"
  if [[ -f "$src_syc_datasite" ]]; then
    cp "$src_syc_datasite" "$dst_syc_datasite"
  fi

  # Copy participant bundles (best-effort)
  for peer_raw in "${EMAILS[@]}"; do
    peer_email="$(printf '%s' "$peer_raw" | xargs)"
    [[ -z "$peer_email" ]] && continue
    src_bundle="$src_dir/.syc/bundles/$peer_email.json"
    dst_bundle="$dst_dir/.syc/bundles/$peer_email.json"
    if [[ -f "$src_bundle" ]]; then
      cp "$src_bundle" "$dst_bundle"
    fi
  done

  # Optional pre-synced datasites warm copy.
  if [[ -n "$PRESYNC_DATASITES_BASE" ]]; then
    src_datasites=""
    if [[ -d "$presync_datasite_a" ]]; then
      src_datasites="$presync_datasite_a"
    elif [[ -d "$presync_datasite_b" ]]; then
      src_datasites="$presync_datasite_b"
    fi

    if [[ -n "$src_datasites" ]]; then
      mkdir -p "$dst_dir/datasites"
      if command -v rsync >/dev/null 2>&1; then
        rsync -a "$src_datasites"/ "$dst_dir/datasites"/
      else
        cp -R "$src_datasites"/. "$dst_dir/datasites"/
      fi
      echo "warmed_datasites $email <- $src_datasites"
    else
      echo "warn: no presynced datasites found for $email under $PRESYNC_DATASITES_BASE" >&2
    fi
  fi

  # config.yaml rewrite
  cfg_tmp="$(mktemp)"
  awk -v e="$email" -v s="$SERVER_URL" -v d="$dst_dir" '
    /^email:/ { print "email: " e; next }
    /^[[:space:]]+server_url:/ { print "  server_url: " s; next }
    /^[[:space:]]+data_dir:/ { print "  data_dir: " d; next }
    { print }
  ' "$dst_cfg_yaml" >"$cfg_tmp"
  mv "$cfg_tmp" "$dst_cfg_yaml"

  # syftbox/config.json rewrite
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const email = process.argv[2];
    const server = process.argv[3];
    const dataDir = process.argv[4];
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!cfg.client_token || !cfg.refresh_token) {
      console.error(`Missing client_token/refresh_token in ${p}`);
      process.exit(2);
    }
    cfg.email = email;
    cfg.server_url = server;
    cfg.data_dir = dataDir;
    fs.writeFileSync(p, JSON.stringify(cfg));
  ' "$dst_syft_cfg" "$email" "$SERVER_URL" "$dst_dir"

  # .syc/config/datasite.json rewrite
  if [[ -f "$dst_syc_datasite" ]]; then
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const base = process.argv[2];
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      cfg.encrypted_root = `${base}/datasites`;
      cfg.shadow_root = `${base}/unencrypted`;
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
    ' "$dst_syc_datasite" "$dst_dir"
  fi

  src_sha="$(shasum -a 256 "$src_syc_key" | awk '{print $1}')"
  dst_sha="$(shasum -a 256 "$dst_syc_key" | awk '{print $1}')"
  if [[ "$src_sha" != "$dst_sha" ]]; then
    echo "Key copy verification failed for $email (sha mismatch)" >&2
    exit 1
  fi

  # Ensure config.yaml still contains auth credentials after rewrite.
  if ! rg -n "^[[:space:]]+access_token:|^[[:space:]]+refresh_token:" "$dst_cfg_yaml" >/dev/null; then
    echo "Missing access/refresh token in seeded config.yaml: $dst_cfg_yaml" >&2
    exit 1
  fi

  echo "seeded $email -> $dst_dir key_sha256=${dst_sha:0:12}"
done

echo "done: seeded auth files for ${#EMAILS[@]} participant(s)"
