# Windows E2E + Observability Plan

## Goal

Run all end-to-end scenarios on Windows with observability enabled, capture results in Jaeger, and stabilize any platform-specific failures.

## Current Status

- Jaeger installs and runs on Windows; test-scenario-obs.sh sets tracing env vars.
- win.ps1 can run tests attached to desktop with --desktop/--desktop-wait.
- Jupyter collaboration and pipelines collaboration scenarios run successfully with observability.

## Plan

1. Tooling readiness

- Run `.\repo.ps1 tools` to verify docker, nextflow, uv, node, rust, go.
- Ensure Docker Desktop is running (Linux containers).
- Start Jaeger via `.\scripts\start-jaeger.sh` and confirm `http://localhost:16686`.
- Clear stale processes/ports (bv-desktop, unified logger, playwright) before long runs.

2. Observability baseline

- Run a quick scenario with `.\win.ps1 .\test-scenario-obs.sh <scenario>`.
- Verify Jaeger services include `client1@sandbox.local` and `client2@sandbox.local`.
- Note missing spans or weak instrumentation for follow-up work.

3. Execute all scenarios with observability

- Use desktop-attached runs for interactive cases:
  - `.\win.ps1 --desktop --desktop-wait .\test-scenario-obs.sh --pipelines-collab --interactive`
  - `.\win.ps1 --desktop --desktop-wait .\test-scenario-obs.sh --profiles`
- Run remaining scenarios without desktop if stable:
  - onboarding, profiles-mock, messaging, messaging-sessions, messaging-core
  - pipelines-solo, pipelines-gwas, jupyter, jupyter-collab
- Optionally run `all` after individual passes to validate integration.

4. Stabilize Windows-specific failures

- Docker/Nextflow path handling and template path casing (fix landed in biovault CLI).
- Unified logger port 9756 conflicts (ensure clean before each run).
- Docker config warning from per-sandbox config.json (make JSON valid or skip config).
- WS bridge and UI windows (use desktop-attached runs for interactive tests).
- If WS bridge does not bind, verify in an interactive session with DEV_WS_BRIDGE=1 and check `desktop.log` + port 3333.

5. Observability quality

- Add spans around pipeline run lifecycle, Nextflow/Docker calls, and scenario steps.
- Ensure span names include scenario + step for easier filtering in Jaeger.

6. Tracking and reporting

- Record pass/fail per scenario in PROGRESS.md.
- Attach logs/screenshots for failures and record the fix applied.
- Leave Jaeger running during diagnosis; stop with `.\scripts\stop-jaeger.sh`.
