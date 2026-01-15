# Flow Spec Design & Migration Plan

This document consolidates the Flow spec design, analysis, and migration strategy for replacing the legacy PipelineSpec/ProjectSpec system.

---

## Mental Model

BioVault treats a **module** (formerly "project") as a self-contained unit of execution with a declared input/output contract, and a **flow** (formerly "pipeline") as a higher-level DAG that wires multiple modules together. Multiparty execution is handled at the flow runner level: a given datasite executes only the steps that target it, while shared outputs are published into SyftBox shared folders with `syft.pub.yaml` permissions.

### Core Entities

| Entity | Description |
|--------|-------------|
| **Datasite** | A SyftBox identity + local data root (e.g., `SYFTBOX_EMAIL` and `SYFTBOX_DATA_DIR`) |
| **Module** | A versioned workflow with inputs/outputs, typically `dynamic-nextflow`, `shell`, or `python` |
| **Flow** | A list of module steps with explicit bindings between step outputs and step inputs |
| **Submission** | A shared copy of a module (and its assets) in `shared/biovault/submissions/...` plus `syft.pub.yaml` and a message |
| **Message** | The inbox payload that tells a recipient where a submission lives and how to run it |

### Naming Conventions

| Old Name | New Name | Description |
|----------|----------|-------------|
| Pipeline | Flow | The outer orchestration unit |
| Project | Module | The reusable composable unit |
| Step | Step | An instantiated module inside a flow |

### Why `syft://` URLs

`syft://` URLs are important because they:
- Circumvent the need for DNS/IP of services that are not online while retaining identity
- Prevent path traversal attacks by normalizing everything to a `datasites/` root
- Make it easy to reason about where you are reading/writing in a networked context rather than local filesystem details

---

## Overview

The Flow spec (`flow-spec-guide/`) is a new unified specification to replace:
- `PipelineSpec` (defined in `cli/src/pipeline_spec.rs`)
- `ProjectSpec` (defined in `cli/src/project_spec.rs`)

### Core Components

| Component | Purpose | File |
|-----------|---------|------|
| Flow | Orchestration definition | `flow-spec-guide/spec/flow.schema.yaml` |
| Module | Reusable execution unit | `flow-spec-guide/spec/module.schema.yaml` |
| FlowOverlay | Environment-specific patches | `flow-spec-guide/spec/overlay.schema.yaml` |

---

## Current System (Legacy)

### Module Files (formerly Project)

A module is a folder containing:
- `module.yaml` (spec) — formerly `project.yaml`
- `workflow.nf` or `workflow.sh` (entrypoint)
- `assets/` (scripts/data bundled with the module)

### Input Type System

Defined in `cli/src/project_spec.rs`, shared between module inputs and flow inputs:

**Primitives:**
- `String`, `Bool`, `File`, `Directory`
- `ParticipantSheet`, `GenotypeRecord`, `BiovaultContext`

**Collections:**
- `List[T]`, `Map[String, T]`, `Record{field: Type}`
- `?` suffix for optional (e.g., `File?`)

### Runner Templates

**Dynamic Nextflow (`template: dynamic-nextflow`):**
1. `module.yaml` is loaded and validated
2. Template loaded from `~/.biovault/env/dynamic-nextflow/template.nf`
3. Inputs/parameters converted to JSON (`inputs.json`, `params.json`)
4. BioVault injects `assets_dir` and `results_dir` into params
5. Nextflow launched with template + workflow

**Shell (`template: shell`):**

Environment variables injected:
```
BV_PROJECT_DIR, BV_RESULTS_DIR, BV_ASSETS_DIR
BV_INPUT_<NAME>, BV_OUTPUT_<NAME>
BV_DATASITES, BV_CURRENT_DATASITE, BV_DATASITE_INDEX
BV_SYFTBOX_DATA_DIR, BV_DATASITES_ROOT, BV_BIN
```

Template variables in paths:
- `{current_datasite}`, `{datasites.index}`, `{datasite.index}`, `{datasites}`

### Multi-Datasite Execution

The pipeline runner (`cli/src/cli/commands/pipeline.rs`) executes one datasite at a time:
- Resolves current datasite from `BIOVAULT_DATASITE_OVERRIDE`, config email, `SYFTBOX_EMAIL`, or `BIOVAULT_DATASITE`
- If a step has `runs_on`/`foreach`, only the matching datasite executes it
- To force a single process to run all targets: `BIOVAULT_PIPELINE_RUN_ALL=1`

### Sharing Outputs

The pipeline `share` block defines file sharing at the pipeline level:

```yaml
share:
  allele_freq_shared:
    source: allele_freq
    path: shared/biovault/shares/{run_id}/{current_datasite}/allele_freq.tsv
    read: [client1@sandbox.local, client2@sandbox.local]
    write: [client1@sandbox.local, client2@sandbox.local]
    admin: [aggregator@sandbox.local]
```

Behavior:
- `path` can be a `syft://` URL or path under current datasite root
- Runner writes `syft.pub.yaml` in parent directory
- Shared output recorded as `syft://...` URL in step outputs
- Downstream steps resolve `syft://` to local path via `SYFTBOX_DATA_DIR`

### Submission & Inbox Flow

**Submitting (`bv submit`):**
1. Copies `project.yaml`, workflow, and assets into shared folder
2. Encrypts assets using SyftBox storage and recipient list
3. Writes `syft.pub.yaml` with read/write permissions
4. Sends project message with `project_location` (`syft://...` URL)

**Processing (`bv message process`):**
1. Resolves `syft://` URL to local path
2. Copies submitted project into local run directory
3. Executes the project
4. Copies results back and optionally shares them

---

## Spec Analysis

### Strengths

1. **Well-Structured Layering**
   - Clear separation: Flow → Module → Overlay
   - Kubernetes-style `apiVersion/kind/metadata/spec` structure
   - Manifest digests for integrity tracking

2. **Multiparty Primitives**
   - `{datasite.current}`, `{datasite.prev}`, `{datasite.next}` template variables
   - Ring topology + sequential strategy for secure aggregation
   - Granular share permissions (read/write/admin per datasite)

3. **Runner Abstraction**
   - Module defines runner kind (shell, python, nextflow, container)
   - Flow doesn't care about execution details

4. **Overlay System**
   - JSON Patch (RFC 6902) for environment-specific config
   - Clean stacking: base → auto → `--overlay` flags

### Issues Addressed

The following gaps were identified and fixed in the spec:

#### 1. Error Handling Semantics

**Problem:** `retry` and `timeout` fields had no detailed semantics.

**Solution:** Added full configuration:

```yaml
retry:
  max_attempts: 3
  backoff:
    strategy: exponential|linear|fixed
    initial_delay_ms: 1000
    max_delay_ms: 60000
    multiplier: 2.0
    jitter: true
  retryable_errors: ["timeout", "connection_refused"]

timeout:
  execution_seconds: 300
  on_timeout: fail|skip|default
  default_value: "[]"  # used when on_timeout is 'default'
```

`await` blocks now also support `on_timeout` and `default_value`:

```yaml
with:
  data:
    from: steps.upstream.outputs.result
    await:
      timeout_seconds: 120
      poll_ms: 1000
      on_timeout: default
      default_value: "{}"
```

#### 2. Security Model

**Problem:** Trust/policy section incomplete - no signing format, digest algorithm, or sandbox isolation.

**Solution:** Added explicit security configuration:

```yaml
# In ModuleRef
trust:
  require_signature: true
  signature_format: sigstore|gpg|minisign
  allowed_signers:
    - maintainer@example.com
  keyring_path: ~/.keys/trusted.gpg

sandbox:
  enabled: true
  network: none|host|restricted
  filesystem: readonly|workspace|full
  allowed_paths:
    - /usr/share/ca-certificates
  env_passthrough:
    - HOME
    - PATH
```

Digest format documented: `algorithm:hex` where algorithm is `sha256`, `sha384`, or `sha512`.

#### 3. Selector Syntax Ambiguity

**Problem:** `{datasites}` vs `{datasites.0}` distinction was subtle.

**Solution:** Bracket notation for clarity:

| Old Syntax | New Syntax | Meaning |
|------------|------------|---------|
| `{datasites}` | `{datasites[*]}` | All datasites |
| `{datasites.0}` | `{datasites[0]}` | First datasite |
| N/A | `{datasites[0:3]}` | Slice (indices 0, 1, 2) |

#### 4. BindingSpec Complexity

**Problem:** Multiple binding forms without clear documentation.

**Solution:** Created `flow-spec-guide/tutorials/00-binding-patterns.md` with complete reference:

```yaml
# String shorthand
with:
  input: inputs.foo

# Record with from
with:
  input:
    from: steps.x.outputs.y

# With await for cross-datasite
with:
  input:
    from: steps.x.outputs.y.manifest
    await:
      timeout_seconds: 120
      on_timeout: fail

# Type wrappers
with:
  file: File(path/to/{datasite.current}/data.txt)
  dir: Directory(work/{run_id})
  url: SyftURL(syft://datasite/shared/file.txt)

# Environment variable with default
with:
  api_key:
    env: API_KEY
    default: "dev-key"
```

## Migration Strategy

### Phased Approach

```
Phase 1: Dual-Path Runtime (Current)
├── Runtime detects spec version via apiVersion field
├── Legacy files (pipeline.yaml, project.yaml) continue to work
└── New flows use kind: Flow with apiVersion: syftbox.openmined.org/v1alpha1

Phase 2: Conversion Tooling
├── CLI command: biovault migrate --input pipeline.yaml --output flow.yaml
└── Automated conversion with manual review for complex cases

Phase 3: Deprecation
├── Warning on legacy format usage
└── Documentation points to new format only

Phase 4: Removal
├── Legacy code paths removed
└── Only Flow spec supported
```

### Runtime Detection Logic

```rust
fn detect_spec_format(path: &Path) -> SpecFormat {
    let content = fs::read_to_string(path)?;
    let yaml: serde_yaml::Value = serde_yaml::from_str(&content)?;

    // Check for Flow spec markers
    if let Some(api_version) = yaml.get("apiVersion") {
        if api_version.as_str() == Some("syftbox.openmined.org/v1alpha1") {
            if let Some(kind) = yaml.get("kind") {
                return match kind.as_str() {
                    Some("Flow") => SpecFormat::Flow,
                    Some("Module") => SpecFormat::Module,
                    Some("FlowOverlay") => SpecFormat::FlowOverlay,
                    _ => SpecFormat::Unknown,
                };
            }
        }
    }

    // Legacy detection by filename
    let filename = path.file_name()?.to_str()?;
    match filename {
        "pipeline.yaml" | "pipeline.yml" => SpecFormat::LegacyPipeline,
        "project.yaml" | "project.yml" => SpecFormat::LegacyProject,
        _ => SpecFormat::Unknown,
    }
}

enum SpecFormat {
    Flow,
    Module,
    FlowOverlay,
    LegacyPipeline,
    LegacyProject,
    Unknown,
}
```

### Field Mapping: PipelineSpec → Flow

| PipelineSpec | Flow | Notes |
|--------------|------|-------|
| `name` | `metadata.name` | |
| `description` | `metadata.description` | |
| `context` | `spec.inputs` | Converted to typed inputs |
| `inputs` | `spec.inputs` | |
| `steps[].id` | `spec.steps[].id` | Same |
| `steps[].uses` | `spec.steps[].uses` | Now references `spec.modules` |
| `steps[].where_exec` | `spec.steps[].run.targets` | |
| `steps[].runs_on` | `spec.steps[].run.targets` | |
| `steps[].foreach` | `spec.steps[].run.strategy: parallel` | |
| `steps[].order` | `spec.steps[].run.strategy: sequential` | |
| `steps[].with` | `spec.steps[].with` | Now uses BindingSpec |
| `steps[].publish` | `spec.steps[].publish` | Same |
| `steps[].share` | `spec.steps[].share` | Enhanced with permissions |
| `steps[].store` | `spec.steps[].store` | Same |

### Field Mapping: ProjectSpec → Module

| ProjectSpec | Module | Notes |
|-------------|--------|-------|
| `name` | `metadata.name` | |
| `author` | `metadata.authors[]` | Now a list |
| `version` | `metadata.version` | |
| `workflow` | `spec.runner.kind` | |
| `template` | `spec.runner.template` | |
| `inputs` | `spec.inputs` | |
| `outputs` | `spec.outputs` | |
| `parameters` | `spec.parameters` | |
| `env` | `spec.runner.env` | |
| `assets` | `spec.assets` | |

## Example Conversion

### Before (pipeline.yaml)

```yaml
name: distributed-compute
steps:
  - id: compute
    uses: ./compute-project
    foreach: datasites
    with:
      data: inputs.data_path
    share:
      result_shared:
        source: result
        path: shared/{current_datasite}/result.txt
        read: [all]
        write: [current]

  - id: aggregate
    uses: ./aggregate-project
    runs_on:
      - aggregator@host
    with:
      results: step.compute.outputs.result
```

### After (flow.yaml)

```yaml
apiVersion: syftbox.openmined.org/v1alpha1
kind: Flow
metadata:
  name: distributed-compute
  version: 0.1.0
spec:
  inputs:
    datasites:
      type: List[String]
      default:
        - client1@host
        - client2@host
        - aggregator@host
    data_path:
      type: String

  datasites:
    all: inputs.datasites
    groups:
      clients:
        include:
          - "{datasites[0]}"
          - "{datasites[1]}"
      aggregator:
        include:
          - "{datasites[2]}"

  modules:
    compute:
      source:
        kind: local
        path: ./compute-project
      allow_dirty: true
    aggregate:
      source:
        kind: local
        path: ./aggregate-project
      allow_dirty: true

  steps:
    - id: compute
      uses: compute
      run:
        targets: clients
        strategy: parallel
      with:
        data: inputs.data_path
      share:
        result_shared:
          source: result
          path: shared/flows/{run_id}/{datasite.current}/result.txt
          permissions:
            read:
              - "{datasites[*]}"
            write:
              - "{datasite.current}"

    - id: aggregate
      uses: aggregate
      run:
        targets: aggregator
      with:
        results:
          from: steps.compute.outputs.result_shared.manifest
          await:
            timeout_seconds: 300
            poll_ms: 5000
            on_timeout: fail
```

## New Features in Flow Spec

### 1. Retry with Backoff

```yaml
steps:
  - id: risky_step
    uses: risky_module
    retry:
      max_attempts: 3
      backoff:
        strategy: exponential
        initial_delay_ms: 1000
        max_delay_ms: 30000
        jitter: true
    timeout:
      execution_seconds: 300
      on_timeout: fail
```

### 2. Module Trust & Sandbox

```yaml
modules:
  external_module:
    source:
      kind: registry
      url: registry.example.com/module
      ref: v1.0.0
    digest: sha256:abc123...
    trust:
      require_signature: true
      signature_format: sigstore
      allowed_signers:
        - maintainer@example.com
    sandbox:
      enabled: true
      network: restricted
      filesystem: workspace
```

### 3. Overlays for Environment Config

```yaml
# flow.local.overlay.yaml
apiVersion: syftbox.openmined.org/v1alpha1
kind: FlowOverlay
metadata:
  name: local-dev
spec:
  target:
    path: ./flow.yaml
  patches:
    - op: replace
      path: /spec/modules/external/source/kind
      value: local
    - op: replace
      path: /spec/modules/external/source/path
      value: ./local-module
```

### 4. Ring Topology

```yaml
steps:
  - id: ring_reduce
    uses: ring_module
    run:
      targets: participants
      strategy: sequential
      topology: ring  # Enables {datasite.prev}, {datasite.next}
    with:
      prev_result: File(shared/{datasite.prev}/partial.txt)
```

## CLI Commands (Proposed)

```bash
# Validate a flow spec
biovault flow validate flow.yaml

# Migrate legacy spec to flow
biovault flow migrate --input pipeline.yaml --output flow.yaml

# Apply overlay and show merged result
biovault flow merge flow.yaml --overlay flow.local.overlay.yaml

# Generate digest for module
biovault module digest ./my-module

# Sign a module
biovault module sign ./my-module --key ~/.keys/signing.key
```

## Files Changed

### Schema Updates
- `flow-spec-guide/spec/flow.schema.yaml` - Error handling, security, selector syntax, module discovery
- `flow-spec-guide/spec/module.schema.yaml` - Sandbox, timeout, digest format

### Example Updates (bracket notation)
- `flow-spec-guide/tutorials/examples/01-hello-world/flow.yaml`
- `flow-spec-guide/tutorials/examples/02-modules-and-reuse/flow.yaml`
- `flow-spec-guide/tutorials/examples/03-runners/flow.yaml`
- `flow-spec-guide/tutorials/examples/04-dev-overlays/flow.yaml`
- `flow-spec-guide/tutorials/examples/05-multiparty-sharing/flow.yaml`
- `flow-spec-guide/tutorials/examples/06-topologies/flow.yaml`
- `flow-spec-guide/tutorials/examples/07-runtime-and-cleanup/flow.yaml`
- `flow-spec-guide/spec/examples/module-folder.flow.yaml`

### New Documentation
- `flow-spec-guide/tutorials/00-binding-patterns.md` - BindingSpec reference
- `flow-spec-guide/MIGRATION.md` - Full migration guide

## Deprecation Timeline

| Version | Status |
|---------|--------|
| 0.x | Both formats supported, no warnings |
| 1.0 | Legacy format deprecated, warnings emitted |
| 2.0 | Legacy format removed |

## Implementation Tasks

1. **Runtime Detection** - Add `detect_spec_format()` to route to correct executor
2. **Flow Executor** - New code path for Flow spec execution
3. **Module Resolver** - Implement `ModuleRef` resolution (local, git, registry)
4. **Sandbox Integration** - Implement isolation policy enforcement
5. **Overlay Merger** - JSON Patch application for overlays
6. **Migration CLI** - `biovault flow migrate` command
7. **Validation** - Schema validation for Flow/Module/Overlay
8. **Signature Verification** - Sigstore/GPG integration for module trust

---

## Design Principles

### From Original Requirements

1. **Versioned Registry + Lockfile**
   - Allow `uses: registry://module@1.2.3` and `uses: git+https://...@sha`
   - Store resolved lockfile to freeze input/output schemas, runner type, and asset digests
   - Resolve and cache modules before execution

2. **First-Class Multiparty Routing**
   - Model `share`, `collect`, and `broadcast` as built-in step types
   - Push multiparty logic into the flow engine, not shell scripts
   - Keep modules single-party and reusable

3. **Pluggable Runtimes**
   - Expose minimal runner interface: `run(inputs) -> outputs`
   - Support Nextflow, shell, Python, container with uniform semantics

### Module Discovery & Safety

Resolution rules:
- `source.path` may be file or directory; directories resolve `module.yaml`/`module.yml`
- `spec.module_paths` is explicit allowlist of local search roots
- Short names (e.g., `hello`) resolve to `./modules/hello` when listed in `module_paths`
- Resolution disabled unless `policy.allow_local: true`
- No global recursive search; only configured roots and explicit paths

---

## Historical Context: Ring Reduction Prototype

This early prototype shows the round-robin/ring pattern that influenced the Flow spec:

```yaml
author: "madhava@openmined.org"
project: "add"
language: "python"
description: "Add two numbers"
code:
  - functions.py

shared_inputs:
  data: &data FilePipe("{datasite}/data/data.txt")
  output: &output FilePipe("{datasite}/fedreduce/{project}/data/{step}/result.txt")

shared_outputs:
  result: &result FilePipe("{author}/fedreduce/{project}/data/result/result.txt")

workflow:
  datasites: &datasites []

steps:
  - first:
      inputs:
        - a: StaticPipe(0)  # Override input for first step
  - last:
      output:
        path: *result
        permissions:
          read:
            - *datasites
  - foreach: *datasites
    run: "{datasite}"
    function: "add"
    inputs:
      - a: FilePipe("{prev_datasite}/fedreduce/{project}/data/{prev_step}/result.txt")
      - b: *data
    output:
      path: *output
      permissions:
        read:
          - "{next_datasite}"

complete:
  exists: *result
```

This prototype influenced the Flow spec's:
- `{datasite.prev}`, `{datasite.next}` template variables
- `run.topology: ring` for sequential ring execution
- `complete` conditions (now `spec.completion`)
- Permission-based sharing with `{datasites[*]}` selectors

---

## Related Documents

- `../flow-spec-guide/spec/` - Schema definitions
- `../flow-spec-guide/tutorials/` - Progressive examples
- `../flow-spec-guide/MIGRATION.md` - Detailed migration guide
- `../biovault/pipelines.md` - Original design document (historical)
