#!/bin/bash
set -euo pipefail

# Setup script for biovault-desktop workspace
# Clones all dependencies as siblings in the SAME directory
#
# This script supports two modes:
# 1. Standalone: When biovault-desktop is cloned alone, clones all deps as siblings
# 2. Repo-managed: When in a repo-managed workspace, exits early (deps already synced)
#
# After running, the directory structure will be:
#   parent/
#   ├── biovault-desktop/  (this repo)
#   ├── biovault/
#   ├── syftbox-sdk/
#   ├── syft-crypto-core/
#   ├── syftbox/
#   ├── biovault-beaver/
#   ├── sbenv/
#   └── bioscript/

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
PARENT_DIR="$(dirname "$REPO_ROOT")"

echo "Setting up biovault-desktop workspace..."
echo "  REPO_ROOT: $REPO_ROOT"
echo "  PARENT_DIR: $PARENT_DIR"

# Configure git to use HTTPS instead of SSH for GitHub (needed for CI)
git config --global url."https://github.com/".insteadOf "git@github.com:"

# Check if we're in a repo-managed workspace (parent has .repo)
if [[ -d "$PARENT_DIR/.repo" ]]; then
    echo "Detected repo-managed parent workspace - dependencies already synced"
    exit 0
fi

# Clone helper function
clone_if_missing() {
    local name="$1"
    local url="$2"
    local branch="${3:-}"

    if [[ -d "$PARENT_DIR/$name" ]]; then
        echo "$name already exists at $PARENT_DIR/$name"
    else
        echo "Cloning $name to $PARENT_DIR/$name..."
        if [[ -n "$branch" ]]; then
            git clone -b "$branch" "$url" "$PARENT_DIR/$name"
        else
            git clone "$url" "$PARENT_DIR/$name"
        fi
    fi
}

# Clone all dependencies
clone_if_missing "biovault" "https://github.com/OpenMined/biovault.git"
clone_if_missing "syftbox-sdk" "https://github.com/OpenMined/syftbox-sdk.git"
clone_if_missing "syft-crypto-core" "https://github.com/OpenMined/syft-crypto-core.git"
clone_if_missing "syftbox" "https://github.com/OpenMined/syftbox.git" "madhava/biovault"
clone_if_missing "biovault-beaver" "https://github.com/OpenMined/biovault-beaver.git"
clone_if_missing "sbenv" "https://github.com/OpenMined/sbenv.git"
clone_if_missing "bioscript" "https://github.com/OpenMined/bioscript.git"

# Setup nested dependencies for syftbox-sdk
if [[ -f "$PARENT_DIR/syftbox-sdk/scripts/setup-workspace.sh" ]]; then
    echo "Setting up syftbox-sdk dependencies..."
    chmod +x "$PARENT_DIR/syftbox-sdk/scripts/setup-workspace.sh"
    (cd "$PARENT_DIR/syftbox-sdk" && ./scripts/setup-workspace.sh)
fi

# Setup nested dependencies for biovault
if [[ -f "$PARENT_DIR/biovault/scripts/setup-workspace.sh" ]]; then
    echo "Setting up biovault dependencies..."
    chmod +x "$PARENT_DIR/biovault/scripts/setup-workspace.sh"
    (cd "$PARENT_DIR/biovault" && ./scripts/setup-workspace.sh)
fi

# Create symlinks from repo root to parent deps (for compatibility with old paths)
create_symlink() {
    local name="$1"
    if [[ ! -e "$REPO_ROOT/$name" ]]; then
        ln -s "../$name" "$REPO_ROOT/$name"
        echo "Created symlink: $name -> ../$name"
    fi
}

create_symlink "biovault"
create_symlink "syftbox-sdk"
create_symlink "syft-crypto-core"
create_symlink "syftbox"
create_symlink "biovault-beaver"
create_symlink "sbenv"
create_symlink "bioscript"

echo ""
echo "Workspace setup complete!"
echo "Dependencies are at:"
echo "  $PARENT_DIR/biovault"
echo "  $PARENT_DIR/syftbox-sdk"
echo "  $PARENT_DIR/syft-crypto-core"
echo "  $PARENT_DIR/syftbox"
echo "  $PARENT_DIR/biovault-beaver"
echo "  $PARENT_DIR/sbenv"
echo "  $PARENT_DIR/bioscript"
