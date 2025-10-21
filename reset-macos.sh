#!/bin/bash

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./reset-macos.sh [--light|--full] [--force]

  --light   Remove BioVault prerequisites without deleting macOS Command Line Tools (default).
  --full    Remove Command Line Tools and all BioVault prerequisites (requires passwordless sudo).
  --force   Skip confirmation prompt.
  -h, --help  Show this help message.
USAGE
}

MODE="light"
FORCE=false
ORIGINAL_ARGS=("$@")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --light)
      MODE="light"
      ;;
    --full)
      MODE="full"
      ;;
    --force)
      FORCE=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

if [[ $(uname -s) != "Darwin" ]]; then
  echo "This reset script is intended for macOS only." >&2
  exit 1
fi

MODE_LABEL=$([[ "$MODE" == "full" ]] && echo "Full" || echo "Light")

if [[ "$MODE" == "full" && $EUID -ne 0 ]]; then
  if [[ ${BIOVAULT_RESET_ESCALATED:-0} == 1 ]]; then
    echo "Passwordless sudo is required to run reset-macos.sh in full mode. Please add a sudoers entry." >&2
    exit 1
  fi

  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo is not available on this system. Cannot perform full reset." >&2
    exit 1
  fi

  if sudo -n true 2>/dev/null; then
    exec sudo -n BIOVAULT_RESET_ESCALATED=1 "$0" "${ORIGINAL_ARGS[@]}"
  else
    echo "Passwordless sudo is required to run reset-macos.sh in full mode. Please add a sudoers entry." >&2
    exit 1
  fi
fi

ORIGINAL_USER=${SUDO_USER:-$USER}
ORIGINAL_HOME=$(eval echo "~$ORIGINAL_USER")

run_as_original_user() {
  local command="$1"
  if [[ $EUID -eq 0 ]]; then
    sudo -u "$ORIGINAL_USER" /bin/bash -lc "$command"
  else
    /bin/bash -lc "$command"
  fi
}

run_brew_command() {
  local cmd="$1"
  run_as_original_user "$cmd"
}

prompt_confirmation() {
  local message="$1"
  echo "$message" >&2
  read -r -p "Proceed? [y/N] " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
}

if ! $FORCE; then
  if [[ "$MODE" == "full" ]]; then
    prompt_confirmation "⚠️  Full reset will remove macOS Command Line Tools and all BioVault dependencies."
  else
    prompt_confirmation "⚠️  Light reset will remove BioVault dependencies but keep Command Line Tools."
  fi
fi

echo "BioVault macOS reset (${MODE_LABEL} mode)"
echo "===================================="

cleanup_command_line_tools() {
  echo "🧹 Removing macOS Command Line Tools..."
  if [[ -d /Library/Developer/CommandLineTools ]]; then
    rm -rf /Library/Developer/CommandLineTools || true
  else
    echo "  Command Line Tools not found, skipping."
  fi
}

cleanup_homebrew() {
  local remove_system_dirs="$1"

  if run_as_original_user 'command -v brew >/dev/null 2>&1'; then
    echo "🧹 Cleaning Homebrew formulae..."
    local formulas=(
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

    for formula in "${formulas[@]}"; do
      if run_as_original_user "brew list --formula ${formula} >/dev/null 2>&1"; then
        echo "  Uninstalling formula: $formula"
        run_brew_command "brew uninstall --ignore-dependencies --force ${formula}" || true
      fi
    done

    echo "🧹 Cleaning Homebrew casks..."
    local casks=(docker)
    for cask in "${casks[@]}"; do
      if run_as_original_user "brew list --cask ${cask} >/dev/null 2>&1"; then
        echo "  Uninstalling cask: $cask"
        run_brew_command "brew uninstall --cask --force ${cask}" || true
      fi
    done

    echo "🧹 Running brew cleanup..."
    run_brew_command "brew cleanup" || true

    if [[ "$remove_system_dirs" == "true" ]]; then
      echo "🧹 Removing Homebrew installation directories..."
      local prefixes=(/opt/homebrew /usr/local/Homebrew)
      for prefix in "${prefixes[@]}"; do
        if [[ -d "$prefix" ]]; then
          echo "  Deleting $prefix"
          rm -rf "$prefix" || true
        fi
      done

      local paths=(
        /usr/local/bin/brew
        /usr/local/share/doc/homebrew
        /usr/local/share/man/man1/brew.1
        /usr/local/share/zsh/site-functions/_brew
        /usr/local/etc/bash_completion.d/brew
      )
      for path in "${paths[@]}"; do
        if [[ -e "$path" ]]; then
          echo "  Removing $path"
          rm -rf "$path" || true
        fi
      done
    else
      echo "🧹 Skipping Homebrew installation directory removal (light mode)."
    fi

    echo "🧹 Clearing Homebrew caches..."
    rm -rf "$ORIGINAL_HOME/Library/Caches/Homebrew" || true
    rm -rf "$ORIGINAL_HOME/Library/Logs/Homebrew" || true
    rm -rf "$ORIGINAL_HOME/Library/Preferences/Homebrew" || true
    rm -rf "$ORIGINAL_HOME/.cache/Homebrew" || true
    rm -rf "$ORIGINAL_HOME/.config/homebrew" || true
  else
    echo "Homebrew is not installed, skipping brew clean-up."
  fi
}

cleanup_docker() {
  local remove_system_dirs="$1"

  echo "🗑  Removing Docker application bundles..."
  # Always remove Docker.app from /Applications (needs sudo in light mode)
  if [[ -d /Applications/Docker.app ]]; then
    if [[ $EUID -eq 0 ]]; then
      rm -rf /Applications/Docker.app || true
    else
      echo "  Removing /Applications/Docker.app (requires password)..."
      sudo rm -rf /Applications/Docker.app || true
    fi
  fi

  rm -rf "$ORIGINAL_HOME/Applications/Docker.app" || true
  rm -rf "$ORIGINAL_HOME/.docker" || true
  rm -rf "$ORIGINAL_HOME/Library/Application Support/Docker Desktop" || true
  rm -rf "$ORIGINAL_HOME/Library/Group Containers/group.com.docker" || true
  rm -rf "$ORIGINAL_HOME/Library/Containers/com.docker.docker" 2>/dev/null || true
}

cleanup_java() {
  local remove_system_dirs="$1"

  echo "🗑  Removing Java symlinks and caches..."
  if [[ "$remove_system_dirs" == "true" ]]; then
    rm -rf /Library/Java/JavaVirtualMachines/openjdk.jdk || true
  else
    echo "  Skipping /Library/Java/JavaVirtualMachines/openjdk.jdk (light mode)."
  fi
  local brew_cache="$ORIGINAL_HOME/Library/Caches/Homebrew/downloads"
  if [[ -d "$brew_cache" ]]; then
    rm -rf "$brew_cache"/*openjdk* 2>/dev/null || true
  fi
}

cleanup_nextflow() {
  echo "🗑  Removing Nextflow caches..."
  rm -rf "$ORIGINAL_HOME/.nextflow" || true
}

cleanup_syftbox() {
  local remove_system_dirs="$1"

  echo "🗑  Removing syftbox binaries and caches..."
  local syftbox_path
  syftbox_path=$(run_as_original_user 'command -v syftbox' 2>/dev/null || true)
  if [[ -n ${syftbox_path:-} ]]; then
    echo "  Deleting syftbox binary: $syftbox_path"
    rm -f "$syftbox_path" || true
  fi
  rm -f "$ORIGINAL_HOME/.sbenv/binaries/syftbox" || true
  rm -rf "$ORIGINAL_HOME/.sbenv/cache/syftbox" || true
  rm -rf "$ORIGINAL_HOME/Library/Application Support/syftbox" || true

  if [[ "$remove_system_dirs" == "true" ]]; then
    rm -f /usr/local/cli-plugins/docker-compose || true
    rm -f /usr/local/bin/hub-tool || true
    rm -f /usr/local/bin/kubectl.docker || true
    rm -f /usr/local/bin/docker-credential-desktop || true
    rm -f /usr/local/bin/docker-credential-ecr-login || true
    rm -f /usr/local/bin/docker-credential-osxkeychain || true
    rm -f /usr/local/bin/docker || true
  else
    echo "  Skipping system-wide Docker helper removal (light mode)."
  fi

  rm -f "$ORIGINAL_HOME/.local/bin/uv" || true
  rm -f "$ORIGINAL_HOME/.local/bin/syftbox" || true
}

if [[ "$MODE" == "full" ]]; then
  cleanup_command_line_tools
  cleanup_homebrew "true"
  cleanup_docker "true"
  cleanup_java "true"
  cleanup_nextflow
  cleanup_syftbox "true"
else
  cleanup_homebrew "false"
  cleanup_docker "false"
  cleanup_java "false"
  cleanup_nextflow
  cleanup_syftbox "false"
fi

echo "✅ macOS BioVault prerequisites have been reset (${MODE_LABEL} mode)."
echo "You can now rerun the BioVault desktop dependency installer."
