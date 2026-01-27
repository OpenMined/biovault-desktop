# 05 - Multiparty sharing

Goal: share outputs between datasites and wait for them.

Example folder:

- `biovault/flow-spec-guide/tutorials/examples/05-multiparty-sharing`

Files:

- `flow.yaml`
- `write.module.yaml` + `write.sh`
- `tag.module.yaml` + `tag.sh`
- `collect.module.yaml` + `collect.sh`
- `rebroadcast.module.yaml` + `rebroadcast.sh`
- `wait.module.yaml` + `wait.sh`

Notes:

- `share` writes a syft.pub.yaml and publishes a syft:// URL for downstream steps.
- `await` can be used on bindings or shares to block until files appear.

Next: topologies and sequential rings.
