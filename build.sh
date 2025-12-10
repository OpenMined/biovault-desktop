
#!/usr/bin/env bash
set -euo pipefail

# Ensure bundled binaries (java/nextflow/uv) and SyftBox client are present before packaging.
chmod +x scripts/build-syftbox-prod.sh scripts/fetch-bundled-deps.sh
./scripts/build-syftbox-prod.sh
./scripts/fetch-bundled-deps.sh

bun run tauri build
