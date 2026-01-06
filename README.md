# BioVault Desktop

## Repo structure

This repo is a kind of mono-repo for BioVault but uses Google's repo tool so the sub repos are still independent.

### Workspace deps (repo tool)
- Source of truth: `manifest.xml` pins each dependency repo to a commit.
- Initialize/sync workspace: `repo init -u <manifest-url> -m manifest.xml` then `repo sync`
- Status across repos: `repo status`
- Branch all repos together: `repo forall -c 'git checkout -B <branch>'`
- Local helper: `./repo` (tree view), `./repo --init`, `./repo sync`, `./repo pin`, `./repo ssh`

### Layout + fallbacks
- Preferred layout is sibling repos at the repo root:
  `biovault/`, `biovault-beaver/`, `bioscript/`, `syftbox/`, `syftbox-sdk/`,
  `syft-crypto-core/`, `sbenv/`
- Scripts and Rust code accept overrides via env vars (examples):
  `WORKSPACE_ROOT`, `BIOVAULT_DIR`, `BIOVAULT_BEAVER_DIR`, `SYFTBOX_DIR`,
  `SYFTBOX_SDK_DIR`, `SBENV_DIR`
- Legacy fallback: if a dependency only exists under `biovault/...`, most scripts
  will detect and use it.

### Nested repo (libsignal)
- The libsignal repo is checked out under
  `syft-crypto-core/vendor/libsignal-protocol-syft`
- It is pinned in `manifest.xml` to avoid submodule workflows.

### Notes for CI
- Do not use `submodules: recursive` in actions/checkout.
- Use `./repo --init --https` (forces HTTPS for CI) and `./repo sync` for retries.
