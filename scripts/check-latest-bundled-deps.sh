#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${BUNDLED_CONFIG:-"$ROOT_DIR/scripts/bundled-deps.json"}"
DO_UPDATE=false

for arg in "$@"; do
  case "$arg" in
    --update) DO_UPDATE=true ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

read_config_value() {
  local key="$1" default="$2"
  if [[ -f "$CONFIG_FILE" ]]; then
    python3 - <<'PY' "$CONFIG_FILE" "$key" "$default"
import json,sys
path=sys.argv[2].split(".")
default=sys.argv[3]
try:
    data=json.load(open(sys.argv[1]))
    cur=data
    for k in path:
        if isinstance(cur,dict) and k in cur:
            cur=cur[k]
        else:
            print(default)
            sys.exit(0)
    if isinstance(cur,(str,int,float)):
        print(cur)
    else:
        print(default)
except Exception:
    print(default)
PY
  else
    echo "$default"
  fi
}

PINNED_UV="$(read_config_value uv.version v0.0.0)"
PINNED_NEXTFLOW="$(read_config_value nextflow.version v0.0.0)"
PINNED_JAVA_MAJOR="$(read_config_value java.major 0)"

detect() {
  local name="$1" url="$2" jq_filter="$3"
  echo "🔎 $name latest:"
  if ! command -v curl >/dev/null 2>&1; then
    echo "  curl not available" ; return
  fi
  local json
  if ! json="$(curl -fsSL "$url")"; then
    echo "  failed to fetch" ; return
  fi
  local value
  value="$(python3 - <<'PY' "$json" "$jq_filter"
import json,sys
data=json.loads(sys.argv[1])
path=sys.argv[2].split(".")
cur=data
for key in path:
    if isinstance(cur,list):
        cur=cur[0] if cur else {}
    cur=cur.get(key,{}) if isinstance(cur,dict) else {}
print(cur if isinstance(cur,str) else "")
PY
)" || true
  echo "  ${value:-unknown}"
  echo "$value"
}

compare_semver() {
  local pinned="$1" latest="$2"
  local p="${pinned#v}"; local l="${latest#v}"
  if [[ "$p" == "$l" ]]; then
    echo "✅ up-to-date ($p)"
  else
    echo "⬆️  update available (pinned $p -> latest $l)"
  fi
}

compare_major() {
  local pinned="$1" latest="$2"
  if [[ "$pinned" == "$latest" ]]; then
    echo "✅ up-to-date ($pinned)"
  else
    echo "⬆️  update available (pinned $pinned -> latest $latest)"
  fi
}

latest_uv="$(detect "uv" "https://api.github.com/repos/astral-sh/uv/releases/latest" "tag_name" | tail -n1)"
echo "  pinned: $PINNED_UV -> $(compare_semver "$PINNED_UV" "$latest_uv")"

latest_nf="$(detect "nextflow" "https://api.github.com/repos/nextflow-io/nextflow/releases/latest" "tag_name" | tail -n1)"
echo "  pinned: $PINNED_NEXTFLOW -> $(compare_semver "$PINNED_NEXTFLOW" "$latest_nf")"

latest_java="$(detect "temurin jre" "https://api.adoptium.net/v3/assets/latest/25/hotspot?architecture=x64&os=mac&image_type=jre&jvm_impl=hotspot&heap_size=normal&vendor=eclipse&archive_type=tar.gz" "version.semver" | tail -n1)"
latest_java_major="${latest_java%%.*}"
echo "  pinned major: $PINNED_JAVA_MAJOR -> $(compare_major "$PINNED_JAVA_MAJOR" "$latest_java_major")"

if $DO_UPDATE; then
  if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "{}" > "$CONFIG_FILE"
  fi
  python3 - <<'PY' "$CONFIG_FILE" "$latest_uv" "$latest_nf" "$latest_java_major"
import json,sys,os
config_path=sys.argv[1]
latest_uv=sys.argv[2]
latest_nf=sys.argv[3]
latest_java=sys.argv[4]

data={}
if os.path.exists(config_path):
    try:
        data=json.load(open(config_path))
    except Exception:
        data={}

data.setdefault("uv",{})["version"]=latest_uv
data.setdefault("nextflow",{})["version"]=latest_nf
data.setdefault("java",{})["major"]=int(latest_java) if latest_java.isdigit() else data.get("java",{}).get("major")

with open(config_path,"w") as f:
    json.dump(data,f,indent=2)
PY
  echo "💾 Updated pinned versions in $CONFIG_FILE"
fi
