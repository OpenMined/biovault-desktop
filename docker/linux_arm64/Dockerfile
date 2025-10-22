# syntax=docker/dockerfile:1.6

ARG UBUNTU_VERSION=24.04
ARG UBUNTU_CODENAME=noble
FROM ubuntu:${UBUNTU_VERSION}

ARG UBUNTU_VERSION
ARG UBUNTU_CODENAME

LABEL maintainer="BioVault" \
      description="Environment for cross-compiling BioVault Tauri AppImage for Linux arm64" \
      org.opencontainers.image.source="https://github.com/biovault/biovault-desktop"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources \
 && cat <<'EOF' >/etc/apt/sources.list.d/ubuntu-amd64.sources
Types: deb
URIs: http://archive.ubuntu.com/ubuntu
Suites: ${UBUNTU_CODENAME} ${UBUNTU_CODENAME}-updates ${UBUNTU_CODENAME}-security ${UBUNTU_CODENAME}-backports
Components: main restricted universe multiverse
Architectures: amd64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
 && cat <<'EOF' >/etc/apt/sources.list.d/arm64-ports.sources
Types: deb
URIs: http://ports.ubuntu.com/ubuntu-ports
Suites: ${UBUNTU_CODENAME} ${UBUNTU_CODENAME}-updates ${UBUNTU_CODENAME}-security
Components: main restricted universe multiverse
Architectures: arm64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF

RUN dpkg --add-architecture arm64 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      curl \
      wget \
      git \
      ca-certificates \
      pkg-config \
      patchelf \
      desktop-file-utils \
      libfuse2 \
      xdg-utils \
      file \
      unzip \
      binutils \
      binutils-aarch64-linux-gnu \
      gcc-aarch64-linux-gnu \
      g++-aarch64-linux-gnu \
      qemu-user-static \
      binfmt-support \
      software-properties-common \
 && apt-get install -y --no-install-recommends \
      libgtk-3-dev:arm64 \
      libwebkit2gtk-4.1-dev:arm64 \
      libayatana-appindicator3-dev:arm64 \
      librsvg2-dev:arm64 \
      libxdo-dev:arm64 \
      libpango1.0-dev:arm64 \
      libssl-dev:arm64 \
      libstdc++6:arm64 \
      libgcc-s1:arm64 \
      libfuse2:arm64 \
      && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
 && /root/.cargo/bin/rustup default stable \
 && /root/.cargo/bin/rustup target add aarch64-unknown-linux-gnu

ENV PATH="/root/.cargo/bin:/root/.local/bin:${PATH}"

WORKDIR /workspace/biovault

CMD ["bash", "-lc", "node -v && npm -v && rustc -V && cargo -V"]
