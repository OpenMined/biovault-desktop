# 01 - Hello World (single machine)

Goal: run a single-step flow on one machine with an inline shell module.

Example files:

- `biovault/flow-spec-guide/tutorials/examples/01-hello-world/flow.yaml`
- `biovault/flow-spec-guide/tutorials/examples/01-hello-world/hello.sh`

What it demonstrates:

- Inline module defined in the flow file.
- Datasites injected via `inputs.datasites`.
- Shell runner that writes a `hello.txt` output.

Next: split the module into its own file and reuse it across flows.
