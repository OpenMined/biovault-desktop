# 02 - Modules and reuse

Goal: split a module into a separate file, reference it with a digest, and add an interface summary so the flow stays readable.

Example files:

- `biovault/flow-spec-guide/tutorials/examples/02-modules-and-reuse/flow.yaml`
- `biovault/flow-spec-guide/tutorials/examples/02-modules-and-reuse/modules/hello/module.yaml`
- `biovault/flow-spec-guide/tutorials/examples/02-modules-and-reuse/modules/hello/hello.sh`

Notes:

- `interface` lets you see inputs/outputs without opening the module file.
- `digest` is used for integrity; `allow_dirty: true` is helpful in dev mode.
- Folder-based modules keep `module.yaml` and scripts together.

Next: add different runner kinds (shell vs python vs nextflow).
