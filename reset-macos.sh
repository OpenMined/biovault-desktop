#!/bin/bash

set -euo pipefail

if [[ $(uname -s) != "Darwin" ]]; then
  echo "This reset script is intended for macOS only." >&2
  exit 1
fi

if [[ ${1:-} != "--force" ]]; then
  echo "⚠️  This will remove Command Line Tools and BioVault dependencies." >&2
  read -r -p "Proceed? [y/N] " reply
  case "$reply" in
    [yY][eE][sS]|[yY]) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

echo "🧹 Removing macOS Command Line Tools..."
if [[ -d /Library/Developer/CommandLineTools ]]; then
  sudo rm -rf /Library/Developer/CommandLineTools
else
  echo "  Command Line Tools not found, skipping."
fi

if command -v brew >/dev/null 2>&1; then
  echo "🧹 Cleaning Homebrew formulae..."
  FORMULAE=(
    docker
    docker-desktop
    openjdk
    openjdk@25
    openjdk@21
    openjdk@17
    openjdk@11
    openjdk@8
    nextflow
    uv
  )
  for formula in "${FORMULAE[@]}"; do
    if brew list --formula "$formula" >/dev/null 2>&1; then
      echo "  Uninstalling formula: $formula"
      brew uninstall --ignore-dependencies --force "$formula" || true
    fi
  done

  echo "🧹 Cleaning Homebrew casks..."
  CASKS=(docker)
  for cask in "${CASKS[@]}"; do
    if brew list --cask "$cask" >/dev/null 2>&1; then
      echo "  Uninstalling cask: $cask"
      brew uninstall --cask --force "$cask" || true
    fi
  done

  echo "🧹 Running brew cleanup..."
  brew cleanup || true

  echo "🧹 Removing Homebrew installation directories..."
  HOMEBREW_PREFIXES=(/opt/homebrew /usr/local/Homebrew)
  for prefix in "${HOMEBREW_PREFIXES[@]}"; do
    if [[ -d "$prefix" ]]; then
      echo "  Deleting $prefix"
      sudo rm -rf "$prefix"
    fi
  done

  HOMEBREW_PATHS=(
    /usr/local/bin/brew
    /usr/local/share/doc/homebrew
    /usr/local/share/man/man1/brew.1
    /usr/local/share/zsh/site-functions/_brew
    /usr/local/etc/bash_completion.d/brew
  )
  for path in "${HOMEBREW_PATHS[@]}"; do
    if [[ -e "$path" ]]; then
      echo "  Removing $path"
      sudo rm -rf "$path"
    fi
  done

  echo "🧹 Clearing Homebrew caches..."
  rm -rf "$HOME/Library/Caches/Homebrew"
  rm -rf "$HOME/Library/Logs/Homebrew"
  rm -rf "$HOME/Library/Preferences/Homebrew"
  rm -rf "$HOME/.cache/Homebrew"
  rm -rf "$HOME/.config/homebrew"
else
  echo "Homebrew is not installed, skipping brew clean-up."
fi

echo "🗑  Removing Docker application bundles..."
sudo rm -rf /Applications/Docker.app
rm -rf "$HOME/Applications/Docker.app"
rm -rf "$HOME/.docker"
rm -rf "$HOME/Library/Application Support/Docker Desktop"
rm -rf "$HOME/Library/Group Containers/group.com.docker"
rm -rf "$HOME/Library/Containers/com.docker.docker"

echo "🗑  Removing Java symlinks and caches..."
sudo rm -rf /Library/Java/JavaVirtualMachines/openjdk.jdk
rm -rf "$HOME/Library/Caches/Homebrew/downloads"/*openjdk*

echo "🗑  Removing Nextflow caches..."
rm -rf "$HOME/.nextflow"

echo "🗑  Removing syftbox binaries and caches..."
if command -v syftbox >/dev/null 2>&1; then
  SYFTBOX_BIN=$(command -v syftbox)
  echo "  Deleting syftbox binary: $SYFTBOX_BIN"
  rm -f "$SYFTBOX_BIN"
fi
rm -f "$HOME/.sbenv/binaries/syftbox"
rm -rf "$HOME/.sbenv/cache/syftbox"
rm -rf "$HOME/Library/Application Support/syftbox"
rm /usr/local/cli-plugins/docker-compose || true
rm /usr/local/bin/hub-tool || true
rm /usr/local/bin/kubectl.docker || true
rm /usr/local/bin/docker-credential-desktop || true
rm /usr/local/bin/docker-credential-ecr-login || true
rm /usr/local/bin/docker-credential-osxkeychain || true
rm /usr/local/bin/docker || true
rm /Users/test/.local/bin/uv || true
rm /Users/test/.local/bin/syftbox || true
echo "✅ macOS BioVault prerequisites have been reset."
echo "You can now rerun the BioVault desktop dependency installer."
