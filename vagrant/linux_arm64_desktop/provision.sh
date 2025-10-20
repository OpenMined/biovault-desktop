#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update

apt-get install -y \
  ubuntu-desktop-minimal \
  gdm3 \
  gnome-terminal \
  dbus-x11

apt-get install -y \
  libgtk-3-0 \
  libwebkit2gtk-4.1-0 \
  libayatana-appindicator3-1 \
  librsvg2-2 \
  libxdo3 \
  libssl3 \
  libfuse2 \
  xdg-utils \
  unzip \
  curl \
  wget \
  ca-certificates

# Ensure the graphical target and display manager are enabled so GNOME starts automatically
systemctl set-default graphical.target
systemctl enable --now gdm3

cat <<'EOT'
Desktop VM ready.
  - Launch UTM and open the "linux-arm64-desktop" console for graphics.
  - Inside the VM, the repository is at /workspace/biovault
  - Copy your built artifacts into /workspace/biovault/artifacts/linux_arm64 or run them directly.
  - For AppImage bundles, ensure they are executable: chmod +x <AppImage>
EOT
