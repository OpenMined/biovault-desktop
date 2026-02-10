# Fast Stable WebRTC Plan (Syqure Hotlink)

## Goal

- Match or beat prior local direct-connection baseline while keeping WebRTC as the default fast path.
- Keep websocket fallback for normal daily use, but make benchmark mode strict and fail-fast.

## Current Observations

- Rust/WebRTC transport is now matching or slightly beating the earlier QUIC baseline on the same workload (`750 x 1,677,722 bytes`), at least in the transport-only 3-party burst scenario.
- Existing scenario/env wiring could silently miss strict p2p intent unless `P2P_ONLY` and legacy `QUIC_ONLY` are normalized.
- Rust hotlink previously allowed silent packet drops in p2p-only mode when WebRTC was not ready.
- Full distributed Syqure scenario now completes successfully with strict p2p mode, but secure aggregate still takes ~120s (target remains ~50-60s).

## Changes Implemented

### 1) Fail fast in Rust p2p-only path

File: `syftbox/rust/src/hotlink_manager.rs`

- Reduced `HOTLINK_ACCEPT_TIMEOUT` from `5s` to `1500ms` to reduce per-session stall time.
- Replaced silent packet drop in p2p-only mode with explicit error return including `session/path/seq`.

### 2) Strict benchmark mode (`SYFTBOX_HOTLINK_BENCH_STRICT=1`)

File: `syftbox/rust/src/hotlink_manager.rs`

- Added strict mode gate:
  - accept timeout now errors immediately (instead of continue/send-anyway).
  - any WebRTC-not-ready path that would have gone to WS fallback now errors immediately.
  - any WebRTC send error that would have fallen back now errors immediately.
- Added telemetry fields:
  - `bench_strict` (bool)
  - `strict_violations` (counter)
- Added stricter mode label in telemetry:
  - `mode = hotlink_p2p_strict` when strict enabled.

### 3) Normalize p2p-only env propagation in UI harness

File: `test-scenario.sh` (repo root)

- Added normalization and explicit export for:
  - `BV_SYFTBOX_HOTLINK_P2P_ONLY`
  - `SYFTBOX_HOTLINK_P2P_ONLY`
  - bidirectional defaulting between `P2P_ONLY` and `QUIC_ONLY`
- Updated Syqure env logging to include `P2P_ONLY`.

### 4) Normalize p2p-only env propagation in CLI harness

File: `biovault/test-scenario.sh`

- In hotlink mode non-explicit branch:
  - `BV_SYFTBOX_HOTLINK_QUIC_ONLY` now defaults from `BV_SYFTBOX_HOTLINK_P2P_ONLY`.

### 5) Add fast failure/assertions in distributed scenario

File: `biovault/tests/scenarios/syqure-distributed.yaml`

- Setup command now passes:
  - `SYFTBOX_HOTLINK_P2P_ONLY` plus normalized `QUIC_ONLY`.
- Reduced parallel timeout from `900` to `420`.
- Added telemetry assertion step (only when p2p-only enabled):
  - fails if `tx_ws_packets > 0` or `ws_fallbacks > 0`
  - fails if no active p2p dataplane (`tx_p2p_packets == 0` or `webrtc_connected == 0`)

## Why this should help

- Removes ambiguous "passed but actually fell back" behavior in benchmarks.
- Converts latent hangs/silent stalls into explicit errors close to the cause.
- Ensures scenario intent (`P2P_ONLY`) is actually seen by runtime daemons.
- Keeps non-benchmark default behavior (fallback-capable) intact for normal environments.

## Recommended Benchmark Commands

Use strict mode for apples-to-apples p2p-only verification:

```bash
SYFTBOX_HOTLINK_BENCH_STRICT=1 \
BV_SYFTBOX_HOTLINK=1 \
BV_SYFTBOX_HOTLINK_TCP_PROXY=1 \
BV_SYFTBOX_HOTLINK_QUIC=1 \
BV_SYFTBOX_HOTLINK_P2P_ONLY=1 \
BV_SYFTBOX_HOTLINK_QUIC_ONLY=1 \
HOTLINK_BURST_COUNT=750 \
HOTLINK_BURST_PAYLOAD_SIZE=1677722 \
./biovault/test-scenario.sh --hotlink-p2p-only biovault/tests/scenarios/hotlink-tcp-burst-3party.yaml 2>&1 | tee /tmp/bench-rust-webrtc-fast.log
```

Full end-to-end distributed run:

```bash
SYFTBOX_HOTLINK_BENCH_STRICT=1 \
BV_SYFTBOX_HOTLINK=1 \
BV_SYFTBOX_HOTLINK_TCP_PROXY=1 \
BV_SYFTBOX_HOTLINK_QUIC=1 \
BV_SYFTBOX_HOTLINK_P2P_ONLY=1 \
BV_SYFTBOX_HOTLINK_QUIC_ONLY=1 \
./biovault/test-scenario.sh --hotlink-p2p-only biovault/tests/scenarios/syqure-distributed.yaml 2>&1 | tee /tmp/bench-syqure-distributed-fast.log
```

Extract result lines:

```bash
rg -n "burst-c1->c2\\s+PASS|Scenario completed successfully|Syqure step duration" /tmp/bench-rust-webrtc-fast.log /tmp/bench-syqure-distributed-fast.log
```

## Validation Status

- Shell syntax checks passed for modified scripts.
- Rust crate compile check passed:
  - `cargo check -p syftbox-rs` in `syftbox/rust`
- New tuning code/tests (2026-02-09) passed:
  - `cargo test -p syftbox-rs hotlink_manager::tests -- --nocapture`
  - Added env-tunable TCP chunk size and WebRTC send-backpressure gates in `syftbox/rust/src/hotlink_manager.rs`.
  - Added unit tests for env parsing/clamping of:
    - `SYFTBOX_HOTLINK_TCP_PROXY_CHUNK_SIZE`
    - `SYFTBOX_HOTLINK_WEBRTC_BUFFERED_HIGH`
    - `SYFTBOX_HOTLINK_WEBRTC_BACKPRESSURE_WAIT_MS`

## Latest Run Notes (2026-02-10)

- Failure case reproduced on distributed Syqure scenario with oversized chunk:
  - `SYFTBOX_HOTLINK_TCP_PROXY_CHUNK_SIZE=262144` caused repeated `outbound packet larger than maximum message size`.
  - In strict mode this correctly surfaced as hard failure (no silent fallback/drop).
- New quick transport-only benchmark added:
  - `biovault/tests/scenarios/hotlink-tcp-burst-3party.yaml`
  - 3-party mesh with strict assertions and three heavy directional bursts:
    - `0->1`: `750 x 1,677,722` in `40.5407s` (`29.60 MiB/s`)
    - `0->2`: `750 x 1,677,722` in `39.4854s` (`30.39 MiB/s`)
    - `1->2`: `750 x 1,677,722` in `40.7914s` (`29.42 MiB/s`)
  - Strict telemetry assertions passed on all peers:
    - `ws_fallbacks=0`, `tx_ws_packets=0`, `strict_violations=0`
    - WebRTC connected mesh observed (`webrtc_connected=2` on each peer)
- Interpretation:
  - WebRTC transport itself is now performing near/above the earlier QUIC baseline envelope for this payload profile.
  - Remaining distributed Syqure runtime slowness is likely above transport (workflow/coordination path), not raw hotlink dataplane throughput.
- Full distributed Syqure run (`biovault/tests/scenarios/syqure-distributed.yaml`) now succeeds under strict p2p mode:
  - `Scenario completed successfully`
  - all parties complete secure aggregate with correct output validation
  - no websocket fallback (`ws_fallbacks=0`, `tx_ws_packets=0`)
  - observed Syqure step durations:
    - client1: `120.053s`
    - client2: `120.071s`
    - aggregator: `120.088s`
  - data-path behavior during aggregate:
    - client1/client2 both show large bidirectional traffic (high `tx` and `rx`)
    - aggregator shows low traffic volume, consistent with protocol role

## Messaging Noise Fix (2026-02-10)

- Root cause of noisy logs like:
  - `Failed to read response file ... Failed to parse response JSON ...`
- Cause:
  - RPC ACK scanning attempted to parse every `*.response` under scanned datasites.
  - After the SYC envelope / multi-recipient rollout, many of these files are encrypted for a different identity and are expected to be unreadable by this instance.
- Fix implemented:
  - `syftbox-sdk/src/syftbox/endpoint.rs`:
    - added `check_responses_for_ids(&HashSet<String>)` to pre-filter by request-id filename before parse/decrypt.
  - `biovault/cli/src/messages/sync.rs`:
    - `check_acks()` now builds pending RPC request-id set from local DB and calls `check_responses_for_ids(...)`.
    - This avoids parsing unrelated encrypted envelopes and removes expected-but-noisy decrypt/parse failures.
- Validation:
  - Added SDK unit test:
    - `check_responses_for_ids_ignores_unrelated_response_files`
  - Targeted test runs passed:
    - `cargo test check_responses_for_ids_ignores_unrelated_response_files -- --nocapture` (in `syftbox-sdk`)
    - `cargo test check_acks -- --nocapture` (in `biovault/cli`)

## Self-Send Replay Guard (2026-02-10)

- Issue:
  - Self-addressed messages (`from == to`) create self-addressed encrypted `.response` envelopes and can be retried repeatedly by higher-level message flows.
- Fix:
  - `biovault/cli/src/messages/sync.rs` now blocks self-send in `send_message()`:
    - logs a concise error line
    - marks the message `sync_status=Failed`
    - returns an error without creating/sending RPC request files
- Validation:
  - Added unit test:
    - `self_send_is_blocked_and_marked_failed`
  - Test run passed:
    - `cargo test self_send_is_blocked_and_marked_failed -- --nocapture` (in `biovault/cli`)

## Multiparty Mapping Fix (2026-02-10)

- Symptom:
  - `secure_aggregate` could fail with `Syqure exited due to signal: 9` in 3-party runs.
  - Logs showed incorrect role mapping, e.g. both `client2@sandbox.local` and `aggregator@sandbox.local` resolving to the same email.
- Root cause:
  - In `build_group_map_from_participants`, fallback mapping reused already-claimed participants.
  - This could drop one real client from effective target mapping and break MPC participant wiring.
- Fix:
  - `src-tauri/src/commands/multiparty.rs`:
    - normalized role-base matching to handle singular/plural forms (e.g. `client` vs `clients`).
    - fallback now **never** reuses a claimed participant.
    - added regression test `default_mapping_never_reuses_participant_for_multiple_default_slots`.
- Validation:
  - `cargo test default_mapping_never_reuses_participant_for_multiple_default_slots --manifest-path src-tauri/Cargo.toml -- --nocapture` passed.
  - `cargo test parse_flow_steps_reports_duplicate_placeholder_mapping --manifest-path src-tauri/Cargo.toml -- --nocapture` passed.
- Error-message improvement:
  - Added preflight mapping validation in `parse_flow_steps` to fail early with explicit diagnostics when placeholder targets collapse to duplicate participants.
  - New error includes:
    - failing step id
    - placeholder targets list
    - unique-resolved count
    - participant/role list and full `default_to_actual` mapping

## Claude H1-H4 Status

- H1 (chunk too small): implemented and validated.
  - Default chunk raised to `60 KiB` and made env-tunable via `SYFTBOX_HOTLINK_TCP_PROXY_CHUNK_SIZE`.
  - Added adaptive split-on-oversize retry in TCP proxy send path.
- H2 (no backpressure): implemented.
  - Added buffered-amount gating with env-tunable high watermark and wait timeout.
- H3 (lock contention): not yet addressed in code.
  - Kept as next optimization pass after transport correctness/perf stabilization.
- H4 (ordered reliable SCTP HOL): not yet changed.
  - Data-channel mode/tuning still pending dedicated experiment.

## Next Engineering Steps

1. Add stage-level timing in the Syqure flow runner (share generation, exchange, aggregate) to localize the ~120s cost.
2. Extend the quick 3-party burst scenario with simultaneous bidirectional bursts to stress contention (H3 signal).
3. Add handshake timing fields to telemetry:

- `offer_to_dc_open_ms`
- `open_to_first_payload_ms`
- `first_payload_to_steady_state_ms`

4. Re-run full `syqure-distributed.yaml` with timing instrumentation and compare against the transport-only burst profile.
5. Run controlled H4 experiments:

- compare current ordered reliable channel vs alternative data-channel config in a dedicated scenario.
