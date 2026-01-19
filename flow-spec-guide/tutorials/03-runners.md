# 03 - Runners (shell, python, nextflow)

Goal: show how the same flow can call different runner types.

Example folder:

- `biovault/flow-spec-guide/tutorials/examples/03-runners`

Files:

- `flow.yaml`
- `shell.module.yaml` + `shell-write.sh`
- `python.module.yaml` + `upper.py`
- `nextflow.module.yaml` + `workflow.nf`

Notes:

- `template: dynamic-nextflow` uses the BioVault Nextflow wrapper.
- Runner choice is isolated to the module; the flow stays the same.

Next: dev mode using overlays.
