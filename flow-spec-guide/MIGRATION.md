# Migration Guide: PipelineSpec/ProjectSpec → Flow Spec

This document guides migration from the legacy `PipelineSpec` and `ProjectSpec` formats to the new unified `Flow` specification.

## Overview

The new Flow spec consolidates `pipeline.yaml` and `project.yaml` into a single, more expressive format with:
- Unified module system with versioning and integrity checking
- Enhanced multiparty execution controls (topologies, selectors)
- Built-in error handling, retry, and timeout policies
- Overlay system for environment-specific configuration

## Migration Strategy

We recommend a phased approach that maintains backward compatibility:

### Phase 1: Dual-Path Runtime (Current)
- Runtime detects spec version via `apiVersion` field
- Legacy files (`pipeline.yaml`, `project.yaml`) continue to work
- New flows use `kind: Flow` with `apiVersion: syftbox.openmined.org/v1alpha1`

### Phase 2: Conversion Tooling
- CLI command: `biovault migrate --input pipeline.yaml --output flow.yaml`
- Automated conversion with manual review for complex cases

### Phase 3: Deprecation
- Warning on legacy format usage
- Documentation points to new format only

### Phase 4: Removal
- Legacy code paths removed
- Only Flow spec supported

## Field Mapping Reference

### PipelineSpec → Flow

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
| `steps[].foreach` | `spec.steps[].run.strategy: parallel` | See strategy mapping |
| `steps[].order` | `spec.steps[].run.strategy: sequential` | |
| `steps[].with` | `spec.steps[].with` | Same, but with BindingSpec |
| `steps[].publish` | `spec.steps[].publish` | Same |
| `steps[].share` | `spec.steps[].share` | Enhanced with permissions |
| `steps[].store` | `spec.steps[].store` | Same |

### ProjectSpec → Module

| ProjectSpec | Module | Notes |
|-------------|--------|-------|
| `name` | `metadata.name` | |
| `author` | `metadata.authors[]` | Now a list |
| `version` | `metadata.version` | |
| `workflow` | `spec.runner.kind` | See runner mapping |
| `template` | `spec.runner.template` | |
| `inputs` | `spec.inputs` | |
| `outputs` | `spec.outputs` | |
| `parameters` | `spec.parameters` | |
| `env` | `spec.runner.env` | |
| `assets` | `spec.assets` | |

### Strategy Mapping

| Legacy | Flow |
|--------|------|
| `foreach: datasites` | `run.strategy: parallel`, `run.targets: all` |
| `order: sequential` | `run.strategy: sequential` |
| `runs_on: [list]` | `run.targets: [list]` or selector |
| `where_exec: single` | `run.targets: {datasites[0]}` |

### Runner Mapping

| ProjectSpec workflow | Module runner.kind |
|---------------------|-------------------|
| `nextflow` | `nextflow` |
| `shell` | `shell` |
| `python` | `python` |
| `container` | `container` |

## Example Conversions

### Simple Pipeline → Flow

**Before (pipeline.yaml):**
```yaml
name: hello-pipeline
description: Simple hello world
inputs:
  message:
    type: string
    default: "hello"
steps:
  - id: write
    uses: ./hello-project
    runs_on:
      - local@localhost
    with:
      text: inputs.message
    publish:
      output: outputs.result
```

**After (flow.yaml):**
```yaml
apiVersion: syftbox.openmined.org/v1alpha1
kind: Flow
metadata:
  name: hello-pipeline
  version: 0.1.0
  description: Simple hello world
spec:
  inputs:
    message:
      type: String
      default: "hello"

  datasites:
    all:
      - local@localhost
    groups:
      local:
        include:
          - "{datasites[0]}"

  modules:
    hello:
      source:
        kind: local
        path: ./hello-project
      allow_dirty: true

  steps:
    - id: write
      uses: hello
      run:
        targets: local
      with:
        text: inputs.message
      publish:
        output: outputs.result
```

### Multi-Datasite Pipeline → Flow

**Before (pipeline.yaml):**
```yaml
name: distributed-compute
steps:
  - id: compute
    uses: ./compute-project
    foreach: datasites
    with:
      data: inputs.data_path
    share:
      - source: result
        path: shared/{datasite}/result.txt
        read: [all]
        write: [current]

  - id: aggregate
    uses: ./aggregate-project
    runs_on:
      - aggregator@host
    with:
      results: step.compute.outputs.result
```

**After (flow.yaml):**
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

## Runtime Detection Logic

The runtime should detect spec format using this logic:

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

## Selector Syntax Changes

The new spec uses bracket notation for datasite selectors:

| Legacy | New |
|--------|-----|
| `{datasites}` | `{datasites[*]}` |
| `{datasites.0}` | `{datasites[0]}` |
| `{datasites.1}` | `{datasites[1]}` |
| N/A | `{datasites[0:3]}` (slice) |

## New Features in Flow Spec

### 1. Error Handling

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

### 2. Module Trust & Security

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

### 4. Topologies

```yaml
steps:
  - id: ring_reduce
    uses: ring_module
    run:
      targets: participants
      strategy: sequential
      topology: ring  # Enables {datasite.prev}, {datasite.next}
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

## Deprecation Timeline

| Version | Status |
|---------|--------|
| 0.x | Both formats supported, no warnings |
| 1.0 | Legacy format deprecated, warnings emitted |
| 2.0 | Legacy format removed |

## Questions?

See the tutorials in `tutorials/` for working examples of the new Flow spec.
