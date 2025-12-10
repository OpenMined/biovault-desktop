#!/usr/bin/env bash
set -euo pipefail

# Check a built BioVault app (or DMG) for quarantine flags and signature issues.
# Usage: ./check-gatekeeper.sh [path-to-.app-or-.dmg]

err() { echo "❌ $*" >&2; }
info() { echo "ℹ️  $*"; }

APP_INPUT="${1:-}"
if [[ -n "$APP_INPUT" ]]; then
  # Normalize to absolute path
  APP_INPUT="$(cd "$(dirname "$APP_INPUT")" && pwd)/$(basename "$APP_INPUT")"
fi
MOUNT_POINT=""
APP_PATH=""
DMG_INPUT=""

cleanup() {
  if [[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]]; then
    hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1 || true
    rmdir "$MOUNT_POINT" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

pick_app_from_build() {
  local app dmg
  app=$(ls -t src-tauri/target/*/release/bundle/macos/*.app 2>/dev/null | head -1 || true)
  dmg=$(ls -t src-tauri/target/*/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)

  if [[ -n "$app" ]]; then
    APP_PATH="$app"
    return
  fi

  if [[ -n "$dmg" ]]; then
    info "Mounting DMG: $dmg"
    MOUNT_POINT="$(mktemp -d /tmp/biovault-mnt-XXXX)"
    hdiutil attach "$dmg" -nobrowse -mountpoint "$MOUNT_POINT" >/dev/null
    app=$(find "$MOUNT_POINT" -maxdepth 2 -name "*.app" | head -1 || true)
    if [[ -z "$app" ]]; then
      err "No .app found inside mounted DMG ($dmg)"
      exit 1
    fi
    APP_PATH="$app"
    return
  fi

  err "No app or dmg found; pass a path or build first."
  exit 1
}

resolve_app_path() {
  if [[ -z "$APP_INPUT" ]]; then
    pick_app_from_build
    return
  fi

  if [[ -d "$APP_INPUT" && "$APP_INPUT" == *.app ]]; then
    APP_PATH="$APP_INPUT"
    return
  fi

  if [[ -f "$APP_INPUT" && "$APP_INPUT" == *.dmg ]]; then
    DMG_INPUT="$APP_INPUT"
    info "Mounting DMG: $APP_INPUT"
    MOUNT_POINT="$(mktemp -d /tmp/biovault-mnt-XXXX)"
    hdiutil attach "$APP_INPUT" -nobrowse -mountpoint "$MOUNT_POINT" >/dev/null
    local app
    app=$(find "$MOUNT_POINT" -maxdepth 2 -name "*.app" | head -1 || true)
    if [[ -z "$app" ]]; then
      err "No .app found inside mounted DMG ($APP_INPUT)"
      exit 1
    fi
    APP_PATH="$app"
    return
  fi

  err "Unrecognized input: $APP_INPUT (expect .app or .dmg)"
  exit 1
}

resolve_app_path
info "Checking app: $APP_PATH"

scan_attrs() {
  local target="$1"
  local q_hits="$2"
  local p_hits="$3"
  local statuses="${4:-}"
  if [[ -d "$target" ]]; then
    # Limit depth to avoid traversing outside bundle; include executables and libs.
    find "$target" \( -type f \( -perm +111 -o -name "*.dylib" -o -name "*.jnilib" -o -name "*.so" -o -path "*/Contents/MacOS/*" \) \) -print0 | \
      while IFS= read -r -d '' f; do
        local q=""; local p=""
        if xattr -p com.apple.quarantine "$f" >/dev/null 2>&1; then
          q="quarantine"
          echo "$f (quarantine)" >>"$q_hits"
        fi
        if xattr -p com.apple.provenance "$f" >/dev/null 2>&1; then
          p="provenance"
          echo "$f (provenance)" >>"$p_hits"
        fi
        if [[ -n "$statuses" ]]; then
          if [[ -n "$q" || -n "$p" ]]; then
            echo "[FLAG] $f ${q:+$q }${p}" >>"$statuses"
          else
            echo "[OK]   $f" >>"$statuses"
          fi
        fi
      done
  elif [[ -f "$target" ]]; then
    local q=""; local p=""
    if xattr -p com.apple.quarantine "$target" >/dev/null 2>&1; then
      q="quarantine"
      echo "$target (quarantine)" >>"$q_hits"
    fi
    if xattr -p com.apple.provenance "$target" >/dev/null 2>&1; then
      p="provenance"
      echo "$target (provenance)" >>"$p_hits"
    fi
    if [[ -n "$statuses" ]]; then
      if [[ -n "$q" || -n "$p" ]]; then
        echo "[FLAG] $target ${q:+$q }${p}" >>"$statuses"
      else
        echo "[OK]   $target" >>"$statuses"
      fi
    fi
  else
    err "Target not found for attr scan: $target"
  fi
}

if [[ -n "$DMG_INPUT" ]]; then
  info "Checking DMG for quarantine: $DMG_INPUT"
  DMG_Q=$(mktemp)
  DMG_P=$(mktemp)
  DMG_STATUS=$(mktemp)
  scan_attrs "$DMG_INPUT" "$DMG_Q" "$DMG_P" "$DMG_STATUS"
  if [[ -s "$DMG_Q" ]]; then
    err "DMG has quarantine attributes (continuing to inspect contents):"
    cat "$DMG_Q"
  fi
  if [[ -s "$DMG_P" ]]; then
    info "DMG has provenance attributes (not fatal):"
    cat "$DMG_P"
  fi
  info "DMG file status:"
  cat "$DMG_STATUS"
fi

RESOURCES_DIR="$APP_PATH/Contents/Resources/resources"
if [[ ! -d "$RESOURCES_DIR" ]]; then
  err "Resources directory not found: $RESOURCES_DIR"
  exit 1
fi

info "Scanning for quarantine/provenance flags in app..."
Q_HITS=$(mktemp)
P_HITS=$(mktemp)
STATUS=$(mktemp)
scan_attrs "$APP_PATH" "$Q_HITS" "$P_HITS" "$STATUS"
scan_attrs "$RESOURCES_DIR" "$Q_HITS" "$P_HITS" "$STATUS"
info "Per-file status under app/resources:"
cat "$STATUS"

# Per-file codesign/spctl checks for bundled executables and libs
info "Per-file signature assessment (executables/libs under resources):"
SIGN_STATUS=$(mktemp)
find "$RESOURCES_DIR" \( -type f \( -perm +111 -o -name "*.dylib" -o -name "*.jnilib" -o -name "*.so" -o -path "*/Contents/MacOS/*" \) \) -print0 | \
  while IFS= read -r -d '' f; do
    cs_ok="ok"; spctl_ok="ok"
    if ! codesign -dv "$f" >/dev/null 2>&1; then
      cs_ok="fail"
    fi
    if ! spctl --assess --type exec "$f" >/dev/null 2>&1; then
      spctl_ok="fail"
    fi
    echo "[$cs_ok/$spctl_ok] $f" >>"$SIGN_STATUS"
  done
cat "$SIGN_STATUS"

if [[ -s "$Q_HITS" ]]; then
  err "Found quarantine attributes:"
  cat "$Q_HITS"
  exit 1
fi

if [[ -s "$P_HITS" ]]; then
  info "Found provenance attributes (not fatal):"
  cat "$P_HITS"
fi

info "Verifying codesign (deep, strict)..."
if ! codesign --verify --deep --strict --verbose=2 "$APP_PATH"; then
  err "Codesign verification failed."
  exit 1
fi

info "Assessing with spctl..."
if ! spctl --assess --type exec --verbose "$APP_PATH"; then
  err "spctl assessment failed."
  exit 1
fi

info "✅ Quarantine clear and signatures verified."
