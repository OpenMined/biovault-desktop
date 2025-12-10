#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_ROOT="${OUT_ROOT:-"$ROOT_DIR/src-tauri/resources/bundled"}"
CONFIG_FILE="${BUNDLED_CONFIG:-"$ROOT_DIR/scripts/bundled-deps.json"}"

# Parse command line arguments
CLEAN_FIRST=false
for arg in "$@"; do
  case "$arg" in
    --clean)
      CLEAN_FIRST=true
      shift
      ;;
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

JAVA_MAJOR_DEFAULT="$(read_config_value java.major 25)"
NEXTFLOW_VERSION_DEFAULT="$(read_config_value nextflow.version v25.10.2)"
UV_VERSION_DEFAULT="$(read_config_value uv.version v0.9.14)"

detect_platform() {
  # Allow explicit overrides for cross-compilation (e.g., CI building x86_64 on arm64 runners)
  if [[ -n "${BUNDLED_OS:-}" && -n "${BUNDLED_ARCH:-}" ]]; then
    echo "${BUNDLED_OS}" "${BUNDLED_ARCH}"
    return
  fi

  local os arch
  case "$(uname -s)" in
    Darwin) os="macos" ;;
    Linux) os="linux" ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) os="windows" ;;
    *) echo "❌ Unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac

  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) arch="x86_64" ;;
    arm64|aarch64) arch="aarch64" ;;
    *) echo "❌ Unsupported architecture: $arch" >&2; exit 1 ;;
  esac

  echo "$os" "$arch"
}

download() {
  local url="$1" dest="$2"
  echo "⬇️  Fetching $url"
  curl -fL --retry 3 --retry-delay 2 -o "$dest" "$url"
}

download_with_retry() {
  local url="$1" dest="$2" attempts="${3:-3}" sleep_s="${4:-2}"
  local i
  for ((i=1;i<=attempts;i++)); do
    if curl -fL -o "$dest" "$url"; then
      return 0
    fi
    echo "  ⚠️  Attempt $i/$attempts failed for $url; retrying in ${sleep_s}s..."
    sleep "$sleep_s"
  done
  return 1
}

extract_java() {
  local os="$1" arch="$2"
  local major="${JAVA_MAJOR:-$JAVA_MAJOR_DEFAULT}"

  local api_os api_arch
  case "$os" in
    macos) api_os="mac" ;;
    linux) api_os="linux" ;;
    *) echo "⚠️  Skipping Java for $os" ; return ;;
  esac
  case "$arch" in
    x86_64) api_arch="x64" ;;
    aarch64) api_arch="aarch64" ;;
  esac

  local api_url="https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${api_arch}&os=${api_os}&image_type=jre&jvm_impl=hotspot&heap_size=normal&vendor=eclipse&archive_type=tar.gz"

  local tmpdir dest_dir
  tmpdir="$(mktemp -d)"
  dest_dir="$OUT_ROOT/java/${os}-${arch}"

  rm -rf "$dest_dir"
  mkdir -p "$dest_dir"

  echo "🔎 Querying Adoptium for Temurin JRE ${major} (${api_os}/${api_arch})"
  local meta_json="$tmpdir/meta.json"
  if ! download_with_retry "$api_url" "$meta_json" 3 3; then
    if [[ -n "${JAVA_TARBALL_URL:-}" ]]; then
      echo "⚠️  Adoptium API unavailable; using JAVA_TARBALL_URL fallback."
      local tarball="$tmpdir/java.tar.gz"
      download_with_retry "$JAVA_TARBALL_URL" "$tarball" 3 3
      tar -xzf "$tarball" -C "$tmpdir"
    else
      echo "❌ Failed to query Adoptium API (tried 3 times). Set JAVA_TARBALL_URL to override." >&2
      exit 1
    fi
  fi

  local tar_url version
  if [[ -f "$meta_json" ]]; then
    tar_url="$(python3 - <<'PY' "$meta_json"
import json,sys
data=json.load(open(sys.argv[1]))
asset=(data[0] if data else {})
print(asset.get("binary",{}).get("package",{}).get("link",""))
PY
)"
    version="$(python3 - <<'PY' "$meta_json"
import json,sys
data=json.load(open(sys.argv[1]))
asset=(data[0] if data else {})
print(asset.get("version",{}).get("semver","unknown"))
PY
)"
  fi

  if [[ -z "${tar_url:-}" ]]; then
    if [[ -n "${JAVA_TARBALL_URL:-}" ]]; then
      tar_url="$JAVA_TARBALL_URL"
      version="${JAVA_VERSION_LABEL:-unknown}"
      echo "⚠️  Using JAVA_TARBALL_URL fallback."
    else
      echo "❌ Failed to determine Temurin download URL from Adoptium API" >&2
      exit 1
    fi
  fi

  local tarball="$tmpdir/java.tar.gz"
  download_with_retry "$tar_url" "$tarball" 3 3
  tar -xzf "$tarball" -C "$tmpdir"

  local java_bin
  java_bin="$(find "$tmpdir" -type f -path "*/bin/java" | head -n 1 || true)"
  if [[ -z "$java_bin" ]]; then
    echo "❌ Failed to locate java binary in extracted archive" >&2
    exit 1
  fi

  local java_home
  java_home="$(cd "$(dirname "$java_bin")/.." && pwd -P)"

  shopt -s dotglob
  cp -R "$java_home"/* "$dest_dir/"
  shopt -u dotglob

  if [[ -d "$dest_dir/bin" ]]; then
    find "$dest_dir/bin" -maxdepth 1 -type f -exec chmod +x {} +
  else
    echo "⚠️  Java bin directory missing at $dest_dir/bin" >&2
  fi

  # Remove legal directory - contains only license files that cause extended
  # attribute issues with Tauri's build and aren't needed at runtime
  if [[ -d "$dest_dir/legal" ]]; then
    rm -rf "$dest_dir/legal"
    echo "✅ Removed legal directory (license files not needed at runtime)"
  fi

  # Ensure libjvm.so is directly under lib/ so linuxdeploy can find it (AppImage bundling)
  if [[ "$os" == "linux" ]]; then
    local libjvm_server="$dest_dir/lib/server/libjvm.so"
    local libjvm_flat="$dest_dir/lib/libjvm.so"
    if [[ -f "$libjvm_server" && ! -f "$libjvm_flat" ]]; then
      cp "$libjvm_server" "$libjvm_flat"
      echo "✅ Copied libjvm.so to $libjvm_flat for AppImage bundling"
    fi
  fi

  echo "✅ Java ${version} prepared at $dest_dir/bin/java"
  rm -rf "$tmpdir"
}

resolve_nextflow_tag() {
  local version_tag="$1"
  if [[ "$version_tag" != "latest" ]]; then
    echo "$version_tag"
    return
  fi

  local tag
  tag="$(curl -fsSL https://api.github.com/repos/nextflow-io/nextflow/releases/latest | python3 - <<'PY'
import json,sys
data=json.load(sys.stdin)
print(data.get("tag_name","").lstrip("v"))
PY
)" || true
  if [[ -z "$tag" ]]; then
    echo "latest"
  else
    echo "$tag"
  fi
}

fetch_nextflow() {
  local os="$1" arch="$2"
  if [[ "$os" == "windows" ]]; then
    echo "⚠️  Skipping Nextflow for Windows"
    return
  fi

  local version="${NEXTFLOW_VERSION:-$NEXTFLOW_VERSION_DEFAULT}"
  local version_tag
  version_tag="$(resolve_nextflow_tag "${version#v}")"
  local url="${NEXTFLOW_URL:-}"

  # Use explicit override if provided, otherwise default to the GitHub dist asset.
  local -a candidates=()
  if [[ -n "$url" ]]; then
    candidates+=("$url")
  else
    candidates+=("https://github.com/nextflow-io/nextflow/releases/download/v${version_tag}/nextflow-${version_tag}-dist")
  fi

  local dest_dir="$OUT_ROOT/nextflow/${os}-${arch}"
  mkdir -p "$dest_dir"

  local bin_path="$dest_dir/nextflow"
  local downloaded=false
  local tmp_work
  tmp_work="$(mktemp -d)"
  for candidate in "${candidates[@]}"; do
    echo "⬇️  Fetching Nextflow from $candidate"
    local tmp_file="$tmp_work/download"
    rm -f "$tmp_file"
    if ! download_with_retry "$candidate" "$tmp_file" 3 3; then
      continue
    fi

    if [[ "$candidate" == *"-dist" ]]; then
      # Dist is a self-contained launcher script; just keep it
      mv "$tmp_file" "$bin_path"
      chmod +x "$bin_path"
      downloaded=true
      echo "✅ Nextflow dist script saved to $bin_path"
      break
    else
      mv "$tmp_file" "$bin_path"
      chmod +x "$bin_path"
      downloaded=true
      echo "✅ Nextflow script saved to $bin_path"
      break
    fi
  done

  if [[ "$downloaded" != true ]]; then
    echo "⚠️  Direct download failed; trying bootstrap script (get.nextflow.io)..."
    local tmp_bootstrap
    tmp_bootstrap="$(mktemp -d)"
    local bootstrap="$tmp_bootstrap/nextflow-bootstrap.sh"
    if download_with_retry "https://get.nextflow.io" "$bootstrap" 3 3; then
      chmod +x "$bootstrap"
      local nxf_home="$tmp_bootstrap/home"
      mkdir -p "$nxf_home"
      if NXF_HOME="$nxf_home" NXF_ORG="nextflow-io" NXF_VER="v${version_tag}" "$bootstrap" -download; then
        local found
        found="$(find "$nxf_home" -type f -name "nextflow-*all*" | head -n 1 || true)"
        if [[ -n "$found" ]]; then
          cp "$found" "$bin_path"
          chmod +x "$bin_path"
          downloaded=true
          echo "✅ Nextflow downloaded via bootstrap to $bin_path"
        else
          echo "❌ Bootstrap did not produce a jar" >&2
        fi
      else
        echo "❌ Bootstrap download failed" >&2
      fi
    else
      echo "❌ Failed to download bootstrap script" >&2
    fi
    rm -rf "$tmp_bootstrap"
  fi

  rm -rf "$tmp_work"

  if [[ "$downloaded" != true ]]; then
    echo "❌ Failed to download Nextflow (tried ${#candidates[@]} sources and bootstrap). Set NEXTFLOW_URL to override." >&2
    exit 1
  fi

  echo "✅ Nextflow ${version} prepared at $bin_path"
}

fetch_uv() {
  local os="$1" arch="$2"
  if [[ "$os" == "windows" ]]; then
    echo "⚠️  Skipping uv for Windows"
    return
  fi

  local platform
  case "$os-$arch" in
    macos-aarch64) platform="aarch64-apple-darwin" ;;
    macos-x86_64) platform="x86_64-apple-darwin" ;;
    linux-aarch64) platform="aarch64-unknown-linux-gnu" ;;
    linux-x86_64) platform="x86_64-unknown-linux-gnu" ;;
    *) echo "⚠️  Skipping uv for $os-$arch"; return ;;
  esac

  local version="${UV_VERSION:-$UV_VERSION_DEFAULT}"
  local version_tag="${version#v}"
  local asset="uv-${platform}.tar.gz"
  local url="${UV_DOWNLOAD_URL:-https://github.com/astral-sh/uv/releases/download/${version_tag}/${asset}}"

  local tmpdir dest_dir
  tmpdir="$(mktemp -d)"
  dest_dir="$OUT_ROOT/uv/${os}-${arch}"
  rm -rf "$dest_dir"
  mkdir -p "$dest_dir"

  local archive="$tmpdir/uv.tar"
  download "$url" "$archive"

  if ! tar -xzf "$archive" -C "$tmpdir" 2>/dev/null; then
    tar -xJf "$archive" -C "$tmpdir"
  fi

  local uv_bin
  uv_bin="$(find "$tmpdir" -type f -name uv | head -n 1 || true)"
  if [[ -z "$uv_bin" ]]; then
    echo "❌ Failed to locate uv binary in archive" >&2
    exit 1
  fi

  cp "$uv_bin" "$dest_dir/uv"
  chmod +x "$dest_dir/uv"
  echo "✅ uv prepared at $dest_dir/uv"
  rm -rf "$tmpdir"
}

main() {
  local os arch
  read -r os arch <<<"$(detect_platform)"
  local platform="$os-$arch"

  if [[ "$os" == "windows" ]]; then
    echo "ℹ️  Windows build detected, bundled dependency fetch is skipped."
    exit 0
  fi

  # Clean existing bundled dependencies if requested
  if [[ "$CLEAN_FIRST" == true ]]; then
    echo "🧹 Cleaning existing bundled dependencies..."
    rm -rf "$OUT_ROOT/java" "$OUT_ROOT/nextflow" "$OUT_ROOT/uv"
    echo "✅ Cleaned bundled directories"
  fi

  echo "🏗  Preparing bundled dependencies for $platform"
  mkdir -p "$OUT_ROOT"
  echo "Placeholder for bundled dependencies" > "$OUT_ROOT/README.txt"

  extract_java "$os" "$arch"
  fetch_nextflow "$os" "$arch"
  fetch_uv "$os" "$arch"

  echo "🔧 Fixing file permissions and removing quarantine attributes..."

  # Fix permissions to ensure files are readable/writable
  chmod -R u+rw "$OUT_ROOT" 2>/dev/null || true

  # Remove ALL macOS extended attributes (only on macOS)
  if [[ "$os" == "macos" ]]; then
    xattr -rc "$OUT_ROOT" 2>/dev/null || true
    echo "✅ Removed macOS extended attributes"
  fi

  echo "🎉 Bundled artifacts ready under $OUT_ROOT"
}

main "$@"
