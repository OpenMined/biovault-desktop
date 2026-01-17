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

## Dependency Order & Release Process

### Dependency Graph

```
syft-crypto-core (foundational crypto)
    ↓
syftbox-sdk (depends on syft-crypto-protocol)
    ↓
biovault CLI (depends on syftbox-sdk)
    ↓
biovault-desktop/src-tauri (depends on biovault CLI + syftbox-sdk)

biovault-beaver (independent Python, but uses syftbox conventions)
```

### Release Order

When making changes that span multiple repos, release in this order:

1. **syft-crypto-core** - Foundational crypto library

   - Contains `syft-crypto-protocol` crate
   - Must be released first if crypto changes

2. **syftbox-sdk** - Rust SDK for SyftBox

   - Depends on `syft-crypto-protocol`
   - Update version, release to crates.io

3. **biovault** (CLI) - BioVault CLI library

   - Depends on `syftbox-sdk`
   - Update Cargo.toml version references

4. **biovault-desktop** - Desktop application (this repo)

   - Depends on both `biovault` CLI and `syftbox-sdk`
   - Update Cargo.toml version references
   - Tag release triggers CI build

5. **biovault-beaver** - Python notebooks/workers
   - Independent but should be compatible
   - Release after desktop if notebooks change

### Branching Workflow

```bash
# Check which repos have changes
./repo branch

# Create branch in all dirty repos
./repo branch feature/my-feature

# Commit in each repo
cd syftbox-sdk && git add -A && git commit -m "feat: add X"
cd ../biovault && git add -A && git commit -m "feat: use X"
cd .. && git add -A && git commit -m "feat: integrate X"

# Push all branches
./repo forall -c 'git push -u origin feature/my-feature'

# Create PRs, merge in dependency order, then release
```

### Version Updates

When releasing, update versions in this order:

1. `syft-crypto-core/protocol/Cargo.toml` - bump version
2. `syftbox-sdk/Cargo.toml` - bump version, update `syft-crypto-protocol` dep
3. `biovault/cli/Cargo.toml` - bump version, update `syftbox-sdk` dep
4. `src-tauri/Cargo.toml` - bump version (auto-triggers release)
5. `biovault-beaver/pyproject.toml` - bump version if needed

## Development Workflow

### Linting & Testing

Each repo has a `lint.sh` script that runs all checks in parallel:

```bash
# Lint all dirty repos (parallel, quiet on success)
./repo lint

# Run fast unit tests in dirty repos (quiet on success)
./repo test
./repo test --force

# Or lint a single repo
./lint.sh                  # Auto-fix mode (default)
./lint.sh --check          # Read-only mode for CI
./lint.sh --test           # Also run tests
./lint.sh --check --test   # CI mode with tests
```

### What Each lint.sh Does

| Repo             | Languages    | Checks                                            |
| ---------------- | ------------ | ------------------------------------------------- |
| biovault-desktop | Rust + JS/TS | `cargo fmt` + `clippy` + `prettier` + `eslint`    |
| biovault         | Rust         | `cargo fmt` + `clippy`                            |
| syftbox-sdk      | Rust         | `cargo fmt` + `clippy`                            |
| syft-crypto-core | Rust         | `cargo fmt` + `clippy`                            |
| biovault-beaver  | Python       | `ruff format` + `ruff check` + `mypy` + `vulture` |

With `--test`: adds `cargo test` (Rust) or `pytest` (Python)

### Before Committing

```bash
# Check which repos have changes and lint them
./repo lint

# If lint passes, create branches and commit
./repo branch feature/my-change
# ... commit in each repo ...
```

## Quick Start for New Contributors

This repository is part of a multi-repository workspace managed using
Google’s `repo` tool. Each sub-repository remains independent but is
pinned to specific commits via `manifest.xml`.

### Prerequisites
- Git
- Python 3.9+
- Rust (stable toolchain)
- Google `repo` tool

### Initial Setup
Initialize the workspace using the provided `manifest.xml`:

```bash
repo init -u <manifest-url> -m manifest.xml
repo sync
