# 00 - Binding Patterns Reference

This document explains the different forms of `BindingSpec` used in `with:`, `params:`, and other binding contexts.

## Quick Reference

| Form             | Use Case                       | Example                           |
| ---------------- | ------------------------------ | --------------------------------- |
| String shorthand | Simple input/output references | `inputs.datasites`                |
| `from:` record   | Step output references         | `from: steps.write.outputs.file`  |
| `value:` literal | Hardcoded values               | `value: "hello"`                  |
| `env:` variable  | Environment variables          | `env: MY_VAR`                     |
| `await:` block   | Cross-datasite dependencies    | `await: { timeout_seconds: 120 }` |
| Type wrappers    | Explicit typing                | `File(path/to/file.txt)`          |

## String Shorthand Forms

The simplest binding is a string reference:

```yaml
with:
  # Reference a flow input
  datasites: inputs.datasites

  # Reference a step output
  previous_result: steps.step1.outputs.result

  # Reference output manifest (for multi-datasite fan-in)
  all_results: steps.step1.outputs.result.manifest
```

### Type Wrapper Syntax

Use type wrappers when you need explicit typing:

```yaml
with:
  # File reference with template variables
  config: File(configs/{datasite.current}.json)

  # Directory reference
  data_dir: Directory(data/{run_id})

  # Explicit string value
  message: String(hello world)

  # Boolean value
  enabled: Bool(true)

  # URL types
  remote_file: SyftURL(syft://datasite/path/file.txt)
  api_endpoint: HTTPURL(https://api.example.com/data)
```

## Record Form with `from:`

Use the record form when you need additional options:

```yaml
with:
  input_file:
    from: steps.generate.outputs.file
```

### With Default Values

```yaml
with:
  config:
    from: inputs.optional_config
    default: 'default.json'
```

### With Environment Variable Fallback

```yaml
with:
  api_key:
    env: API_KEY
    default: 'dev-key'
```

## Await Pattern (Cross-Datasite Dependencies)

Use `await:` when a binding depends on data from another datasite that may not be immediately available:

```yaml
with:
  # Wait up to 2 minutes for the file to appear
  shared_file:
    from: steps.other_step.outputs.shared_file
    await:
      timeout_seconds: 120
      poll_ms: 500

  # With fallback behavior on timeout
  optional_data:
    from: steps.upstream.outputs.data
    await:
      timeout_seconds: 60
      poll_ms: 1000
      on_timeout: default # fail | skip | default
      default_value: '[]' # used when on_timeout is 'default'
```

### Timeout Behaviors

| `on_timeout`     | Behavior                                                      |
| ---------------- | ------------------------------------------------------------- |
| `fail` (default) | Step fails with timeout error                                 |
| `skip`           | Step is skipped, downstream dependencies handle missing input |
| `default`        | Use `default_value` as the binding value                      |

## Manifest References (Multi-Datasite Fan-In)

When collecting outputs from multiple datasites:

```yaml
steps:
  - id: collect
    uses: aggregator
    run:
      targets: aggregator
    with:
      # Get paths to all outputs from the previous step across all datasites
      all_files:
        from: steps.generate.outputs.file.manifest
        await:
          timeout_seconds: 300
          poll_ms: 2000
```

The `.manifest` suffix returns a JSON object mapping datasite names to file paths:

```json
{
	"client1@local": "/path/to/client1/file.txt",
	"client2@local": "/path/to/client2/file.txt"
}
```

## Share Block Bindings

In `share:` blocks, bindings work similarly but also support permissions:

```yaml
share:
  result_shared:
    source: result # Output name from module
    path: shared/flows/{run_id}/{datasite.current}/result.txt
    permissions:
      read:
        - '{datasites[*]}' # All datasites can read
      write:
        - '{datasite.current}' # Only current datasite can write
    await:
      timeout_seconds: 30 # Wait for sync confirmation
      on_timeout: fail
```

## Common Patterns

### Sequential Processing with Await

```yaml
steps:
  - id: process
    uses: processor
    run:
      targets: all_clients
      strategy: parallel
    share:
      result:
        source: output
        path: shared/{datasite.current}/output.txt

  - id: aggregate
    uses: aggregator
    run:
      targets: coordinator
    with:
      inputs:
        from: steps.process.outputs.result.manifest
        await:
          timeout_seconds: 600
          poll_ms: 5000
          on_timeout: fail
```

### Ring Topology with Previous Node Output

```yaml
steps:
  - id: ring_step
    uses: ring_processor
    run:
      targets: participants
      strategy: sequential
      topology: ring
    with:
      # Previous node's output (wraps around in ring)
      prev_result: File(shared/{datasite.prev}/partial.txt)
      seed: inputs.initial_seed
```

### Optional Input with Default

```yaml
inputs:
  config_override:
    type: File
    description: Optional configuration override

steps:
  - id: process
    uses: processor
    with:
      config:
        from: inputs.config_override
        default: 'defaults/config.json'
```
