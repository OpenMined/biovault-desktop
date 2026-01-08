# Progress Log

## Current Progress
- Jaeger Windows support added in obs scripts (exe detection, PowerShell start, separate stderr log).
- Jaeger running on Windows; services visible: `client1@sandbox.local`, `client2@sandbox.local`.
- Jupyter collaboration scenario passed with observability.
- Pipelines collaboration scenario passed with observability.
- Fixed Windows Nextflow template path handling in `biovault/cli/src/cli/commands/run_dynamic.rs` by avoiding canonicalization for Docker paths.

## Issues Observed
- Unified logger port 9756 can be left open by stale node process.
- Docker config warning: per-sandbox `.docker/config.json` invalid auth format.
- Private pipeline run logs show missing synthetic genotype files for some participants (mount/path issues).
- Jaeger spans are generic (command/check_*), not pipeline-specific.

## Next To-Do
- Commit and push the Nextflow Windows path fix in biovault CLI.
- Run remaining scenarios with observability:
  - onboarding
  - profiles
  - profiles-mock
  - messaging
  - messaging-sessions
  - messaging-core
  - pipelines-solo
  - pipelines-gwas
  - jupyter
- Ensure desktop-attached runs for interactive scenarios (`win.ps1 --desktop --desktop-wait`).
- Add cleanup/guard for unified logger port 9756 before each run.
- Make Docker config JSON valid or avoid writing it when not needed.
- Improve tracing spans for pipeline/Nextflow lifecycle.
