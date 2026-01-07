#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

# Only run in repo-managed workspace
if [[ ! -d ".repo" ]]; then
    echo "Not a repo-managed workspace - using git submodules instead"
    git submodule update --init --recursive 2>/dev/null || true
    exit 0
fi

echo "Setting up symlinks for repo-managed workspace..."

# Helper function to create symlink, replacing existing dir/link
link_if_needed() {
    local target="$1" link="$2"
    local link_dir resolved_target

    link_dir="$(dirname "$link")"
    resolved_target="$link_dir/$target"

    # Skip if target doesn't exist (check from symlink's perspective)
    if [[ ! -e "$resolved_target" && ! -L "$resolved_target" ]]; then
        echo "  SKIP: $link (target $resolved_target not found)"
        return 0
    fi

    # Remove existing symlink or empty directory
    if [[ -L "$link" ]]; then
        rm "$link"
    elif [[ -d "$link" ]]; then
        # Only remove if empty (placeholder from git)
        if [[ -z "$(ls -A "$link" 2>/dev/null)" ]]; then
            rm -rf "$link"
        else
            echo "  SKIP: $link (non-empty directory)"
            return 0
        fi
    fi

    # Create parent directory if needed
    mkdir -p "$link_dir"

    ln -s "$target" "$link"
    echo "  ✓ $link -> $target"
}

echo ""
echo "=== biovault submodules ==="
link_if_needed ../syftbox-sdk biovault/syftbox-sdk
link_if_needed ../biovault-beaver biovault/biovault-beaver
link_if_needed ../bioscript biovault/bioscript
link_if_needed ../sbenv biovault/sbenv
link_if_needed ../syftbox biovault/syftbox

echo ""
echo "=== syftbox-sdk submodules ==="
link_if_needed ../syft-crypto-core syftbox-sdk/syft-crypto-core
link_if_needed ../syftbox syftbox-sdk/syftbox

echo ""
echo "=== biovault-beaver submodules ==="
link_if_needed ../syftbox-sdk biovault-beaver/syftbox-sdk
link_if_needed ../syftbox biovault-beaver/syftbox

echo ""
echo "=== syft-crypto-core submodules ==="
# libsignal is vendored inside syft-crypto-core, should already exist
if [[ ! -d "syft-crypto-core/vendor/libsignal-protocol-syft" ]]; then
    echo "  NOTE: libsignal-protocol-syft not found in vendor/"
    echo "        Run: cd syft-crypto-core && git submodule update --init"
fi

echo ""
echo "=== Verifying Cargo paths ==="

# Check critical Cargo.toml dependencies resolve
check_cargo_path() {
    local cargo_file="$1" dep_path="$2" dep_name="$3"
    local full_path
    full_path="$(dirname "$cargo_file")/$dep_path"

    if [[ -d "$full_path" || -L "$full_path" ]]; then
        echo "  ✓ $dep_name: $full_path"
    else
        echo "  ✗ $dep_name: $full_path NOT FOUND"
        return 1
    fi
}

errors=0
check_cargo_path "src-tauri/Cargo.toml" "../biovault/cli" "biovault" || ((errors++))
check_cargo_path "src-tauri/Cargo.toml" "../syftbox-sdk" "syftbox-sdk" || ((errors++))
# Note: biovault/cli uses ../../syftbox-sdk (direct path to avoid symlink collision)
check_cargo_path "biovault/cli/Cargo.toml" "../../syftbox-sdk" "syftbox-sdk (from biovault)" || ((errors++))
check_cargo_path "syftbox-sdk/Cargo.toml" "./syft-crypto-core/protocol" "syft-crypto-protocol" || ((errors++))

echo ""
if [[ $errors -eq 0 ]]; then
    echo "✅ Workspace symlinks configured successfully"
else
    echo "⚠️  Some paths could not be resolved ($errors errors)"
    exit 1
fi
