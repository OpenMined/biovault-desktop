# 06 - Topologies (parallel, sequential, ring)

Goal: show how ordering affects prev/next and ring semantics.

Example folder:
- `biovault/flow-spec-guide/tutorials/examples/06-topologies`

Files:
- `flow.yaml` (ring reduction step)
- `ring-add.module.yaml` + `ring-add.sh`
- `values/` sample inputs

Template variables you can use in paths:
- `{datasite.current}` - current datasite name
- `{datasite.prev}` - previous datasite (wraps in ring topology)
- `{datasite.next}` - next datasite (wraps in ring topology)
- `{datasite.index}` - zero-based index of current datasite

Selector syntax uses bracket notation:
- `{datasites[*]}` - all datasites
- `{datasites[0]}` - first datasite by index
- `{datasites[0:2]}` - slice (indices 0 and 1)

Notes:
- `run.strategy` controls parallel vs sequential.
- `run.topology: ring` enables prev/next wrapping semantics.
