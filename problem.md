# Problem: Syqure in Docker + New WebRTC Hotlink Stalls

## Summary
`BV_SYQURE_USE_DOCKER=1 BIOVAULT_CONTAINER_RUNTIME=docker ./test-scenario.sh --docker --syqure-transport hotlink tests/scenarios/syqure-distributed.yaml`
regularly stalls in `secure_aggregate` when syqure runs in containers.

Observed behavior:
- syqure containers remain `Up` for many minutes
- container CPU eventually drops to `0.00%`
- run hangs until timeout/kill (`exit code 137`)
- syqure stack traces show receive-side wait (`receive_jar` / `MPCComms.receive_jar_size`)

## Latest Findings (2026-02-08)
- Reproduced fresh stall on run `29509775-c103b98bec7f` after ~15m in `secure_aggregate`.
- Telemetry at stall:
  - `aggregator`: `tx=0`, `rx=1572924`, `webrtc_connected=0`, `ws_fallbacks=0`
  - `client1`: `tx=3145848`, `rx=1572924`, `webrtc_connected=0`, `ws_fallbacks=3`
  - `client2`: `tx=1572924`, `rx=1572916`, `webrtc_connected=0`, `ws_fallbacks=1`
- `docker stats` during stall showed one party still computing while others were effectively idle, matching deadlock/partial delivery.
- The server does not explicitly route hotlink open back to sender (`to == from` is filtered in `internal/server/server.go`), so pure "server self-route" is not the direct mechanism.

## Latest Findings (2026-02-09)
- Switched to a faster transport-only debug loop using:
  - `cd syqure && ./run_syqure_tcp_examples.sh --docker --smpc`
- Found that container-name based `SEQURE_CP_IPS` in this script was unstable and produced repeated:
  - `Could not connect: Network is unreachable`
- Patched `syqure/run_syqure_tcp_examples.sh` to use an explicit Docker subnet plus fixed IPv4s for p0/p1/p2:
  - network subnet: `172.29.0.0/24`
  - cp IPs: `172.29.0.2,172.29.0.3,172.29.0.4`
- After patch, Docker fast test passed:
  - `==> Done: MPC TCP (two_party_sum_tcp.codon, skip MHE) in 40s`

Impact:
- Docker container-to-container TCP can now be validated quickly (<1 min) before running the slower full BioVault scenario.
- This does not yet prove full hotlink+syqure-distributed success; it removes one Docker networking blocker from the debug loop.

## Additional Findings (2026-02-09, later)

### Fast-loop status
- `syqure/run_syqure_tcp_examples.sh --docker --smpc` remains green after subnet/IP fix.
- This gives a reproducible transport sanity check in ~40s.

### Full distributed Docker status (still failing)
Runs tested after additional patches:
- `29509931-c5aa34320fd4`
- `29509937-88056541e2ea`
- `29509941-d05ed255e176`

All entered `secure_aggregate`, launched 3 syqure containers, then plateaued.

Common telemetry at/near plateau:
- `aggregator`: `tx=0`, `rx≈1,572,924`, `webrtc_connected=0`
- `client1`: `tx≈3,145,848`, `rx` grows very large (`~15MB+`)
- `client2`: `tx≈17,302,164`, `rx≈1,572,924`

Interpretation:
- WebRTC datachannel still not connecting in this environment (`webrtc_connected=0`), so traffic is WS fallback.
- Data amplification/asymmetry remains in WS path; MPC deadlocks after partial exchange.

### New finding: second Docker mount failure mode (fixed)
- A newer run failed earlier than hotlink due to Docker bind source creation errors when mounting per-datasite roots with `@` in the path:
  - `.../sandbox/client1@sandbox.local`
  - `.../sandbox/client2@sandbox.local`
  - `.../sandbox/aggregator@sandbox.local`
- Repro probe:
  - `docker run -v /.../sandbox/client1@sandbox.local:/datasite-home ...` fails
  - `docker run -v /.../sandbox:/mnt ...` succeeds
- Patch applied in `biovault/cli/src/cli/commands/run_dynamic.rs`:
  - if docker datasites source resolves under `.../sandbox/<email-with-@>/datasites`, fallback to mounting sandbox root (`.../sandbox`) as `/datasite-root`
  - remap `SEQURE_DATASITES_ROOT` in-container to `/datasite-root/{BV_CURRENT_DATASITE}/datasites`
  - keep existing parent `/datasite-home` fallback for `/datasites` cases
- Result:
  - full scenario run `29509970-8e9bf03c1ac4` now passes prior mount-creation failure and reaches `secure_aggregate` for all 3 parties.
  - post-fix telemetry during secure step still shows WS-only path (`webrtc_connected=0`) and asymmetric growth:
    - `aggregator tx=0 rx=1572924`
    - `client1 tx=18875088 rx=17302164`
    - `client2 tx=17302164 rx=9558076`
  - so mount is no longer the blocking failure, but transport-level asymmetry may still remain.

### New finding: stale-container cross-run interference
- During run `29509970-8e9bf03c1ac4`, older `syqure-*` containers from run `29509961-7490556cde56` were still running.
- All runs share the same comm port ranges (`9000/10000/11000` families), so stale containers can keep sockets/connections alive and contaminate channel behavior.
- Removed all stale `syqure-*` containers before the next clean rerun.
- Action item: always hard-clean `syqure-*` containers before each repro run to keep evidence valid.

### Current run status (interrupted)
- A clean full rerun was started after container cleanup:
  - `BV_SYQURE_USE_DOCKER=1 BIOVAULT_CONTAINER_RUNTIME=docker SYFTBOX_HOTLINK_DEBUG=1 ./test-scenario.sh --docker --syqure-transport hotlink tests/scenarios/syqure-distributed.yaml`
- The run was user-interrupted before completion, so there is no new final pass/fail result from that clean state yet.

### Patches added in this round

#### F) Targeted Hotlink Open (`to` user)
Files:
- `syftbox/internal/syftmsg/msg_hotlink.go`
- `syftbox/internal/server/hotlink_store.go`
- `syftbox/internal/server/server.go`
- `syftbox/rust/src/wsproto.rs`
- `syftbox/rust/src/hotlink_manager.rs`

Change:
- Added optional `to` field to `HotlinkOpen`.
- Server stores `ToUser`, enforces target in open broadcast/accept.
- Rust sender attempts to set preferred `to` peer from observed inbound sessions.

Result:
- Builds/tests pass (`cargo check -p syftbox-rs`, `go test ./internal/server ./internal/syftmsg`).
- Full scenario still stalls with same signature.

#### G) TCP stream single-accept guard
File:
- `syftbox/internal/server/server.go`

Change:
- For `.../stream.tcp.request` sessions, reject accepts from a different second user (`reason=already accepted`).

Result:
- Did not resolve stall. Behavior changed transiently in one sample, but converged back to the same plateau pattern.

## Refined Current Hypothesis
- The remaining issue is in WS-fallback hotlink data path under TCP proxy:
  - either duplicated/looped frame delivery across concurrent sessions on the same canonical path,
  - or reorder corruption caused by mixed session streams despite per-session buffering changes.
- Canonical owner-local channels (`1_to_2`, `0_to_1`) are still the dominant failure surface in logs/telemetry.

## New Evidence From Server Relay Instrumentation
- Added `handleHotlinkData` diagnostics (`session`, `path`, `seq`, `bytes`, recipient count/user list).
- Result on failing run `29509948-890b99a93c26`:
  - every sampled relay event had `recipients=1`.
  - no evidence that the server is fanning one frame to multiple users for a session.

Implication:
- The large `client1.rx` growth is not explained by direct server multi-recipient fanout in `handleHotlinkData`.

## Updated Narrowed Failure Pattern
- In failing Docker runs, observed relay traffic is concentrated on:
  - `client1 <-> client2` (`1_to_2`)
  - `client1 -> aggregator` (`0_to_1` path owner channel)
- Missing/underrepresented channel:
  - `client2 -> aggregator` (`2_to_0` / canonical `0_to_2`) does not show corresponding hotlink open/data events in the same window.

This aligns with:
- `aggregator tx=0`, `aggregator rx≈1.57MB`
- `client1 rx` grows very large
- eventual deadlock in `secure_aggregate`.

## Attempted Control Run
- Tried native (non-Docker) control:
  - `SYFTBOX_HOTLINK_DEBUG=1 ./test-scenario.sh tests/scenarios/syqure-distributed.yaml`
- Run failed to start devstack in this environment due permission errors (`operation not permitted` on stack cleanup and bind), so no direct native-vs-docker comparison yet from this branch context.

## Current Best Next Step
1. Instrument client hotlink send path specifically for `0_to_2`/`2_to_0`:
   - log when `send_hotlink` is entered for that path, selected session id/new-vs-existing, and first/last seq.
2. Verify whether client2 ever attempts hotlink send on canonical `0_to_2`.
3. If not attempted, trace upstream from TCP proxy reader for `2_to_0` socket to confirm whether bytes are produced/consumed.
4. If attempted but not relayed, trace server open/accept lifecycle for those session ids.

## Next Immediate Work
1. Add focused server instrumentation in `handleHotlinkData`:
   - session id, from user, accepted recipients count/users, bytes, path.
2. Confirm whether payload fanout exceeds one intended receiver per session in failing runs.
3. If fanout/overlap confirmed, enforce strict one-peer data relay for TCP proxy sessions and rerun full scenario.

## New Root-Cause Hypothesis
Primary issue appears to be **TCP writer lifecycle poisoning** in hotlink proxy:
- `run_tcp_proxy` accepts multiple TCP connections on same channel key.
- While an active writer exists, newer accepted writers are ignored for active map usage.
- If the active writer later closes, key is removed and no replacement is promoted.
- Subsequent incoming hotlink data for that path sees no writer (`tcp write skipped/no writer`) and delivery stalls.

This aligns with the earlier "writer map poisoning" pattern and explains asymmetrical progress/plateau.

## Repro Commands
Full repro:
- `cd biovault`
- `BV_SYQURE_USE_DOCKER=1 BIOVAULT_CONTAINER_RUNTIME=docker SYFTBOX_HOTLINK_DEBUG=1 ./test-scenario.sh --docker --syqure-transport hotlink tests/scenarios/syqure-distributed.yaml`

Fast transport-only repro:
- `cd biovault`
- `./test-scenario.sh --webrtc-flow`
  - This maps to `tests/scenarios/hotlink-tcp-smoke.yaml`

## Key Evidence

### 1) Initial Docker mount issue (fixed)
Earlier failure was:
- `docker: ... creating mount source path .../sandbox/<email>/datasites: no such file or directory`

Fix implemented in `biovault/cli/src/cli/commands/run_dynamic.rs`:
- fallback from mounting `<...>/datasites` directly to mounting parent datasite root
- set `SEQURE_DATASITES_ROOT=/datasite-home/datasites`

This resolved startup/mount errors, but not the transport stall.

### 2) Transport stall signature
During failing runs:
- hotlink telemetry plateaus around:
  - client1: tx ~3.0MB / rx ~1.5MB
  - client2: tx ~1.5MB / rx 0B
  - aggregator: tx 0B / rx ~1.5MB
- no continued progress
- syqure processes idle

### 3) Session anomalies in telemetry
Telemetry repeatedly shows suspicious self sessions on canonical channels, e.g.:
- outbound `peer: client1@sandbox.local` on channel `1_to_2`
- inbound `peer: aggregator@sandbox.local` on channel `0_to_1`

This indicates session routing can still resolve to local owner/self path in some flows.

### 4) Rejections when forcing remote-owner routing
A tested patch changed outbound path to remote-owner key.
Result:
- some self-route symptoms improved
- but opens were rejected with:
  - `HotlinkReject ... reason: permission denied`
  - followed by repeated `reason: unknown session`

Conclusion: ACL/path ownership currently expects canonical/local-owner in these channels; naive remote-owner routing breaks permissions.

## Current Understanding (Most Likely Root Cause)
There is a **routing + session-selection mismatch** in hotlink TCP proxy mode:

1. Canonical path ownership may point to local user for some channels.
2. Sender can create/reuse a session that is effectively self-routed (or not peer-disambiguated enough).
3. Data ends up in a partially connected channel graph where one direction is active and the opposite direction never establishes cleanly.
4. MPC waits forever on missing frames.

A second coupled issue:
- Switching to remote-owner path without coordinated ACL changes causes `permission denied` rejects.

So the bug is not simply “use remote owner path” or “use canonical path”; it is:
- session selection must be **peer-aware and self-excluding**, and
- routing key and ACL ownership must stay consistent.

## Patches Attempted So Far

### A) Docker datasite mount fallback (kept)
File:
- `biovault/cli/src/cli/commands/run_dynamic.rs`

Status:
- good, required for Docker path reliability

### B) Remote-owner outbound routing in hotlink (reverted)
File:
- `syftbox/rust/src/hotlink_manager.rs`

Status:
- caused ACL `permission denied` rejects on some channels
- not viable by itself

### C) Self-route guard wait/reuse inbound (partial, not sufficient)
File:
- `syftbox/rust/src/hotlink_manager.rs`

Status:
- did not fully eliminate self-peered session outcomes in telemetry
- likely needs stronger peer identity checks in matching logic

### D) Writer standby/promotion fix (in progress)
File:
- `syftbox/rust/src/hotlink_manager.rs`

Change:
- Added `tcp_writers_standby` map.
- On accept:
  - if key has no active writer: map as active writer
  - if key already has active writer: store new writer as standby
- On close:
  - if closing writer was current active writer for a key: remove it and promote standby for that key

Status:
- code patched and compiles (`cargo check -p syftbox-rs` under `syftbox/rust`)
- verified in live logs that writer key mapping now reports per-key active status with standby behavior
- **not sufficient alone**: full docker syqure scenario still stalls

## Verification Progress After Patch D
- Run: `29509799-05d14e57483d`
- Command:
  - `BV_SYQURE_USE_DOCKER=1 BIOVAULT_CONTAINER_RUNTIME=docker SYFTBOX_HOTLINK_DEBUG=1 ./test-scenario.sh --docker --syqure-transport hotlink tests/scenarios/syqure-distributed.yaml`
- Outcome:
  - entered `secure_aggregate` and launched all 3 containers
  - remained running >17 minutes with no completion (stuck)
- Telemetry at plateau:
  - `aggregator`: `tx=0 rx=1572924 txpk=0 rxpk=110 wb=0`
  - `client1`: `tx=3145848 rx=1572924 txpk=221 rxpk=112 wb=3`
  - `client2`: `tx=1572924 rx=1572916 txpk=112 rxpk=110 wb=1`
- Log signals during this run:
  - `client1` still shows self-session churn on channel `1_to_2`:
    - `hotlink reusing inbound session ... path=.../1_to_2/stream.tcp.request`
    - `hotlink tcp self-route guard: discarding existing self session ...`
    - followed by new `send open` attempts on the same canonical channel

## Current Assessment
- Writer lifecycle poisoning was real and worth fixing, but is not the only blocker.
- Remaining blocker appears to be canonical-path session selection/routing churn on local-owned channels (especially `client1` on `1_to_2`) causing transport graph instability and eventual MPC stall.

## Run Cleanup (Latest)
- Manually terminated stalled run `29509799-05d14e57483d` after ~17 minutes (well above expected 2-4 minute docker runtime).
- Removed stuck containers:
  - `syqure-29509799-05d14e57483d-pid0`
  - `syqure-29509799-05d14e57483d-pid1`
  - `syqure-29509799-05d14e57483d-pid2`
- Verified no remaining scenario/syqure processes for that run ID.

## Additional CI Failure Mode (Separate Track)
- In UI scenario `syqure-multiparty-allele-freq`, failure happened before secure aggregation:
  - `client1 align_counts=Failed`
  - `secure_aggregate=-`
  - hotlink counters remained `tx=0B rx=0B`
- This indicates a pre-transport flow/module issue for that test path (likely `align_counts` inputs/dependencies), distinct from the docker hotlink stall in `secure_aggregate`.

## Latest Transport Finding After `from` Propagation
- Server now forwards `HotlinkOpen` with sender identity (`frm`) and Rust logs confirm:
  - example: `open received ... from=client2@sandbox.local` on `client1` channel `1_to_2`
- The original self-route discard loop on `1_to_2` no longer appears as before.
- However, run `29509851-4d5275f979db` still timed out; telemetry plateau showed:
  - `client2 rx=0` while other counters were non-zero.

Root cause refinement:
- In WS fallback mode (`webrtc_connected=0`), server hotlink data forwarding is sender-locked (`session.FromUser`).
- Reusing an inbound session created by peer as local outbound causes server to drop local data (sender mismatch).
- So inbound-session adoption is only valid for strict p2p channels, not WS fallback.

## Patch E (Applied, verifying)
File:
- `syftbox/rust/src/hotlink_manager.rs`

Changes:
- Added `adopted_from_inbound` to `HotlinkOutbound`.
- In `send_hotlink`:
  - inbound adoption is now only considered in `p2p_only` mode.
  - in WS mode, previously adopted outbound sessions are evicted and replaced with local-origin outbound sessions.
  - owner-local self-route filters now distinguish adopted inbound vs true local-outbound sessions.

Status:
- code patched; compile + scenario verification in progress.

## Recommended Fix Direction

### 1) Harden session selection in `send_hotlink`
When selecting existing/inbound session for TCP proxy path:
- require same channel path key
- require resolved peer != local email
- require session alive
- if only self session matches, ignore it and continue searching/waiting

### 2) Add explicit peer identity checks
Current telemetry derives peer from path prefix; this is insufficient when canonical path owner == local.
Need session metadata that records actual remote identity from signaling/open and use it for matching.

### 3) Keep canonical path routing unless ACL model changes
Given current ACL behavior, canonical path appears required.
So fix should be: canonical routing + robust self-session exclusion.

### 4) Add deterministic regression assertions
In fast smoke (`--webrtc-flow`) and/or syqure distributed runs:
- fail if any outbound/inbound session reports peer == local for TCP proxy channel
- fail on any `HotlinkReject(permission denied|unknown session)` during run
- fail on stalled tx/rx counters for N intervals

## Validation Commands

Fast path first:
- `cd biovault`
- `./test-scenario.sh --webrtc-flow`

Then full syqure docker:
- `cd biovault`
- `BV_SYQURE_USE_DOCKER=1 BIOVAULT_CONTAINER_RUNTIME=docker SYFTBOX_HOTLINK_DEBUG=1 ./test-scenario.sh --docker --syqure-transport hotlink tests/scenarios/syqure-distributed.yaml`

Live checks:
- `docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' | rg '^syqure-'`
- inspect telemetry:
  - `sandbox/<datasite>/datasites/<datasite>/.syftbox/hotlink_telemetry.json`
- inspect rejects:
  - `rg -n 'HotlinkReject|reject received|permission denied|unknown session' sandbox/*/.syftbox/logs/syftbox.log`

## Open Questions
1. Should ACLs be expanded to allow both owner variants for `_mpc/*/stream.tcp.request` paths? (would make remote-owner routing safer)
2. Is there any server-side routing behavior that implicitly ties open authorization to path owner only?
3. Do we want canonical ownership long-term, or directional ownership keyed by sender/receiver identity?

## Practical Next Step
Implement strict self-session exclusion + peer-aware matching in `syftbox/rust/src/hotlink_manager.rs`, then validate with:
1. `./test-scenario.sh --webrtc-flow`
2. full docker syqure distributed command above
