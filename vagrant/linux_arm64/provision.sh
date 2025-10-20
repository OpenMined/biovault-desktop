#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

sudo apt-get update
sudo apt-get install -y \
  build-essential \
  curl \
  wget \
  file \
  pkg-config \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  ca-certificates \
  gnupg \
  xdg-utils

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q "^v20"; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is expected via nodejs package" >&2
  exit 1
fi

# Ensure npm global installs land in the user's home so we avoid sudo requirements
npm config set prefix "${HOME}/.local" >/dev/null
mkdir -p "${HOME}/.local/bin"

if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi

# shellcheck disable=SC1090
source "$HOME/.cargo/env"

rustup target add aarch64-unknown-linux-gnu

NPM_CONFIG_PREFIX="${HOME}/.local" npm install --location=global @tauri-apps/cli@latest

cat <<'EOT'
Ready to build:
  export PATH="$HOME/.cargo/bin:$PATH"
  export PATH="$HOME/.local/bin:$PATH"
  cd /workspace/biovault
  npm install
  npm run tauri build -- --target aarch64-unknown-linux-gnu
EOT
