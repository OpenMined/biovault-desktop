# 07 - Runtime paths, work dirs, and cleanup

Goal: define where results and work data live, and how cleanup should work.

Example folder:
- `biovault/flow-spec-guide/tutorials/examples/07-runtime-and-cleanup`

Files:
- `flow.yaml`
- `module.yaml` + `work.sh`

Notes:
- `work_dir` is analogous to Nextflow work; keep it for resumability.
- `results_dir` is a stable output location for sharing/inspection.
- `cleanup.policy` lets you keep work in dev, and purge it in CI.
