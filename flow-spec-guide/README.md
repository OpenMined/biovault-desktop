# Flow Spec Guide

This folder contains the draft Flow/Module/Overlay specs plus walkthrough tutorials that
build up complexity from a single-machine hello world to multi-party topologies.

Structure:

- spec/ Draft schemas and example YAMLs.
- tutorials/ Step-by-step walkthroughs (hello world -> modules -> runners -> overlays -> multiparty).
- MIGRATION.md Guide for migrating from PipelineSpec/ProjectSpec to Flow spec.

Note: These specs are design documents for future implementation. They are not yet enforced
by the runtime code.

Module layout:

- A module can be a single file or a folder. If a folder is used, the resolver
  auto-discovers `module.yaml` or `module.yml` at the root.
- Flows can declare `spec.module_paths` to search for local modules by name
  (useful for `./modules/<name>` layouts).
- Local discovery should be gated by module policy (e.g., `allow_local: true`)
  and should only search the explicit `module_paths` allowlist.
