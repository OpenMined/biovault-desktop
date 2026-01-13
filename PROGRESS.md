# Progress Log

## Current Progress

- Resuming after VM reboot: plan to extend networking E2E coverage, run observability-enabled networking scenario, then inspect unified logs + Jaeger spans for errors to fix.
- Plan: stop any running BioVault/syftbox/test-scenario processes, then rerun networking scenario with embedded-mode default and inspect logs for errors.
- Updated devstack/test-scenario defaults to embedded SyftBox clients (override with `--client-mode` or `BV_DEVSTACK_CLIENT_MODE`).
- Removed networking-specific `DEVSTACK_SKIP_CLIENT_DAEMONS` override so client daemons are not disabled when running networking scenarios.
- Fixed `test-scenario.sh` to guard `DEVSTACK_SKIP_CLIENT_DAEMONS` with a default to avoid unbound variable errors under `set -u`.
- Networking run failed: embedded devstack start hit "BioVault not initialized" (bv init skipped for UI scenarios); updated `test-scenario.sh` to run devstack bootstrap when embedded.
- Networking run failed: `syftboxd` exited because it tried to spawn `syftbox` binary; enabled `embedded` feature for `syftbox-sdk` in `biovault/cli/Cargo.toml`.
- Networking run failed at peer key sync; traced to Windows backslash paths in syftbox-rs client uploads. Normalized datasite keys to forward slashes in `syftbox/rust/src/client.rs` and `syftbox/rust/src/sync.rs`, then rebuilt `biovault/cli` with `PROTOC`.
- Networking run now reaches tests but fails on `stop_syftbox_client` ("SyftBox did not stop in time"). Plan: run embedded SyftBox inside Tauri and skip devstack syftboxd for networking to avoid conflicting daemons.
- Plan: add a two-client offline recovery networking test (stop client2 syftbox, write sync file from client1, restart client2, verify resync).
- Plan: run `.\win.ps1 --desktop --desktop-wait .\test-scenario-obs.sh --networking --interactive` and capture unified log + Jaeger error spans.
- Jaeger Windows support added in obs scripts (exe detection, PowerShell start, separate stderr log).
- Jaeger running on Windows; services visible: `client1@sandbox.local`, `client2@sandbox.local`.
- Jupyter collaboration scenario passed with observability.
- Jupyter session scenario passed with observability after using `:visible` selectors + longer timeouts on Windows.
- Pipelines collaboration scenario passed with observability.
- Onboarding scenario passed with observability (`win.ps1 test-scenario-obs.sh --onboarding`); required Tauri release rebuild and used UI port 8083.
- Profiles (real backend) scenario passed with observability after normalizing Windows paths (`\\?\` prefix + case-insensitive matches) in the test.
- Profiles (mock backend) scenarios passed with observability.
- Messaging scenario blocked by peer key sync timeout (did.json not visible within 30s); extended Windows default sync timeout to 90s in `test-scenario.sh`.
- Messaging-core scenario passed after Windows shims (jq/sqlite3) + bash path normalization + stdout encoding guards in `biovault/scripts/run_scenario.py`.
- Jupyter cache warmup uses host paths for local editable installs to avoid MSYS path conversion issues with uv/pip.
- Unified logger binds to `127.0.0.1` via `UNIFIED_LOG_HOST` to avoid IPv6 port conflicts on Windows.
- Fixed Windows Nextflow template path handling in `biovault/cli/src/cli/commands/run_dynamic.rs` by avoiding canonicalization for Docker paths.
- Fixed `win.ps1` argument forwarding to Git Bash (single args were being split into characters).

## Scenario Test Results (2026-01-09)

| Scenario           | Status  | Notes                                                                    |
| ------------------ | ------- | ------------------------------------------------------------------------ |
| profiles           | ✅ PASS | 1 test, 25.8s                                                            |
| profiles-mock      | ✅ PASS | 2 tests, 13.7s                                                           |
| messaging          | ✅ PASS | onboarding + messages, 73.6s total                                       |
| messaging-sessions | ✅ PASS | Required DEVSTACK_SYNC_TIMEOUT=120, 55.2s                                |
| messaging-core     | ✅ PASS | CLI scenario + UI @messaging-core-ui completed with shims                |
| pipelines-solo     | ✅ PASS | 10 synthetic files, dataset creation and publish, 47.9s                  |
| pipelines-gwas     | ⏭️ SKIP | Now skips gracefully when GWAS dataset files are missing                 |
| jupyter            | ✅ PASS | JupyterLab panel + code cells visible after selector/timeouts fix (1.6m) |
| jupyter-collab     | ✅ PASS | Previously verified                                                      |
| pipelines-collab   | ✅ PASS | Previously verified                                                      |

### Summary: 9 passed, 0 failed, 1 skipped

## Issues Observed

- Unified logger port 9756 can be left open by stale node process.
- Docker config warning: per-sandbox `.docker/config.json` invalid auth format.
- Private pipeline run logs show missing synthetic genotype files for some participants (mount/path issues).
- Jaeger spans are generic (command/check\_\*), not pipeline-specific.
- Historical: WS bridge did not bind when launched from non-interactive sessions; desktop-attached runs fixed this.
- `win.ps1` previously split single args into characters (e.g., `--onboarding`), causing test-scenario-obs to fail; fixed.
- Profiles flow needed Windows path normalization for `\\?\` prefixes and slash/case differences in UI.
- Messaging failed in peer key sync preflight on Windows (timeout waiting for `datasites/.../public/crypto/did.json`); logs showed client daemon workspace lock earlier in a run.
- **messaging-core**: Windows needed Git Bash invocation, msys path normalization, and jq/sqlite3 shims; scenario now passes.
- **jupyter**: Resolved by waiting on `:visible` notebook panels/cells with longer Windows timeouts.
- **messaging-sessions**: Default 30s peer sync timeout is insufficient on Windows; using DEVSTACK_SYNC_TIMEOUT=120 resolves the issue.

## Next To-Do

- Commit and push the Nextflow Windows path fix in biovault CLI.
- Ensure desktop-attached runs for interactive scenarios (`win.ps1 --desktop --desktop-wait`).
- Add cleanup/guard for unified logger port 9756 before each run.
- Make Docker config JSON valid or avoid writing it when not needed.
- Improve tracing spans for pipeline/Nextflow lifecycle.
- If WS bridge fails to bind again, validate by launching the debug binary in an interactive session with DEV_WS_BRIDGE=1 and check for `desktop.log` + WS port.
