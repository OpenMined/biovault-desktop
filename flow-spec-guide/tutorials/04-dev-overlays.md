# 04 - Dev mode with overlays

Goal: patch a flow locally without changing the base file.

Example folder:
- `biovault/flow-spec-guide/tutorials/examples/04-dev-overlays`

Files:
- `flow.yaml` (registry-backed module)
- `flow.local.overlay.yaml` (swaps to local module)
- `local.module.yaml` + `echo.sh`

Apply order:
1) `flow.yaml`
2) `flow.local.overlay.yaml` (auto)
3) `--overlay` flags (last wins)

Next: multiparty data sharing.
