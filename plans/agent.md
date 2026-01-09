# BioVault Desktop Agent Control Plan

## Overview

This plan describes how to expose the BioVault Desktop app to an AI agent using
the existing WebSocket bridge, then document a stable API surface so agents can
drive onboarding, data workflows, and SyftBox control plane interactions end to
end.

The approach is to formalize what already works (the WS bridge and Tauri command
map), add explicit enablement + safety controls, and publish a versioned API
spec with examples.

## Goals

- Enable an AI agent to control the desktop app reliably using the WebSocket
  bridge.
- Document a stable, versioned command API (inputs, outputs, errors, side
  effects).
- Provide guidance for SyftBox control plane operations (auth, status, sync,
  settings).
- Keep the system safe: explicit opt-in, local-only by default, auditability.
- Allow enable/disable via config + env on launch, and a Settings UI toggle.
- Support an optional password/token configured via config or env.

## Non-Goals

- Expose the bridge publicly over the network without authentication.
- Replace Playwright; the WS bridge should complement UI automation, not remove
  it.
- Rework core product flows or permission models.

## Current State (Relevant)

- WebSocket bridge is implemented in `src-tauri/src/ws_bridge.rs`.
- Bridge is gated by `DEV_WS_BRIDGE` and optional `DEV_WS_BRIDGE_PORT`.
- Bridge supports request/response JSON: `{ id, cmd, args }` and returns
  `{ id, result | error }`.
- `src/tauri-shim.js` already proxies commands over WS in browser mode.

## Implementation Status

### Phase 1: Command Inventory (COMPLETE)

Enumerated all 90+ WS bridge commands with:

- Read-only vs mutating classification
- Async vs sync identification
- Side effects documentation
- Category grouping (app_status, onboarding, profiles, dependencies, syftbox,
  keys, network, messages, projects, pipelines, datasets, files, sessions,
  jupyter, logs, sql, data_reset)

### Phase 2: WS Bridge Controls (COMPLETE)

Implemented:

- **Settings fields**: `agent_bridge_enabled` and `agent_bridge_token` added to
  Settings struct in `src-tauri/src/types/mod.rs`
- **Token authentication**: Optional token auth via `AGENT_BRIDGE_TOKEN` env var
  or `agent_bridge_token` setting; when configured, all requests must include
  valid token
- **Audit logging**: All commands logged to
  `{BIOVAULT_HOME}/logs/agent_bridge_audit.jsonl` with timestamp, request_id,
  cmd, args_size, duration_ms, success, error, peer_addr
- **Discovery endpoint**: `agent_api_discover` returns API metadata
- **Audit commands**: `agent_api_get_audit_log` and `agent_api_clear_audit_log`

### Phase 3: API Specification (COMPLETE)

Created:

- `docs/agent-api.json` - Machine-readable JSON schema with full command
  definitions, argument schemas, return types, and metadata
- `docs/agent-api.md` - Human-readable documentation with examples, error
  handling, and workflow guides

### Phase 4: SyftBox Control Plane (COMPLETE)

Created `docs/syftbox-recipes.md` with:

- Health check recipes
- Start/stop/restart patterns
- Sync triggering and monitoring
- Diagnostic procedures
- Bootstrap workflows
- Common issues and solutions

### Phase 5: Example Client & Tests (COMPLETE)

Created:

- `examples/agent-client/biovault_agent.py` - Full Python client library with
  typed methods for all major commands
- `examples/agent-client/test_agent.py` - Test suite for validating the API

## Deliverables

| Deliverable       | Location                                  | Description               |
| ----------------- | ----------------------------------------- | ------------------------- |
| Agent Plan        | `plans/agent.md`                          | This document             |
| API JSON Schema   | `docs/agent-api.json`                     | Machine-readable API spec |
| API Documentation | `docs/agent-api.md`                       | Human-readable API docs   |
| SyftBox Recipes   | `docs/syftbox-recipes.md`                 | Control plane workflows   |
| Python Client     | `examples/agent-client/biovault_agent.py` | Client library            |
| Client Tests      | `examples/agent-client/test_agent.py`     | Test suite                |

## Security Model

1. **Localhost Only**: Bridge binds to `127.0.0.1:3333`, not accessible remotely
2. **Optional Token Auth**: When `AGENT_BRIDGE_TOKEN` is set, all requests
   require valid token in request body
3. **Audit Logging**: Every command logged with timing and result status
4. **Settings Control**: `agent_bridge_enabled` can disable the bridge entirely

## Environment Variables

| Variable                | Description                     | Default |
| ----------------------- | ------------------------------- | ------- |
| `DEV_WS_BRIDGE`         | Enable/disable bridge           | Enabled |
| `DEV_WS_BRIDGE_DISABLE` | Force disable                   | Not set |
| `DEV_WS_BRIDGE_PORT`    | WebSocket port                  | 3333    |
| `AGENT_BRIDGE_TOKEN`    | Auth token (overrides settings) | Not set |

## Request/Response Format

**Request:**

```json
{
	"id": 1,
	"cmd": "command_name",
	"args": { "param": "value" },
	"token": "optional-auth-token"
}
```

**Response (success):**

```json
{
	"id": 1,
	"result": { "data": "value" }
}
```

**Response (error):**

```json
{
	"id": 1,
	"error": "Error message"
}
```

## Open Questions (Resolved)

- **Safe vs unsafe commands**: All commands treated as experimental; security
  hardening deferred to later phase
- **Thin vs task-oriented API**: Thin API matching UI commands; agents compose
  higher-level flows
- **Event subscriptions**: Implemented in v1.2.0 - long-running commands emit
  streaming events with `progress`, `log`, and `status` types
- **Discovery format**: JSON schema for programmatic access

## Recent Updates

### Settings-Based Enable/Disable (Latest)

The WebSocket bridge now respects the `agent_bridge_enabled` setting from
config.yaml in addition to environment variables. The precedence is:

1. `DEV_WS_BRIDGE_DISABLE=1` - Force disables the bridge
2. `DEV_WS_BRIDGE=0` - Disables the bridge
3. `agent_bridge_enabled: false` in settings - Disables if env vars not set
4. Defaults to enabled

This allows users to toggle the agent bridge from the Settings UI (when
implemented) without requiring environment variable changes.

## Implementation Checklist

### Phase 1: Command Inventory - COMPLETE

- [x] Enumerate all WS bridge commands from `ws_bridge.rs`
- [x] Categorize commands (read-only, mutating, async, long-running, dangerous)
- [x] Document in `get_commands_list()` with metadata
- [x] Create discovery endpoints (`agent_api_discover`, `agent_api_list_commands`)

### Phase 2: WS Bridge Controls - COMPLETE

- [x] Localhost binding only (127.0.0.1)
- [x] Enable/disable via `DEV_WS_BRIDGE` env var
- [x] Enable/disable via `DEV_WS_BRIDGE_DISABLE` env var
- [x] Enable/disable via `agent_bridge_enabled` setting
- [x] Token authentication via `AGENT_BRIDGE_TOKEN` env var
- [x] Token authentication via `agent_bridge_token` setting
- [x] Audit logging to `{BIOVAULT_HOME}/logs/agent_bridge_audit.jsonl`
- [x] Audit retrieval via `agent_api_get_audit_log`
- [x] Audit clearing via `agent_api_clear_audit_log`

### Phase 3: API Specification - COMPLETE

- [x] JSON schema at `docs/agent-api.json`
- [x] Human-readable docs at `docs/agent-api.md`
- [x] Protocol documentation (request/response/event formats)
- [x] Category groupings with command lists
- [x] Per-command schemas (args, returns, side effects)
- [x] Runtime schema access via `agent_api_get_schema`
- [x] Event streaming documentation via `agent_api_events_info`

### Phase 4: SyftBox Control Plane - COMPLETE

- [x] Auth commands: `syftbox_request_otp`, `syftbox_submit_otp`
- [x] Status commands: `check_syftbox_auth`, `get_syftbox_state`
- [x] Control commands: `start_syftbox_client`, `stop_syftbox_client`
- [x] Sync commands: `trigger_syftbox_sync`, `syftbox_queue_status`
- [x] Config commands: `get_syftbox_config_info`, `get_syftbox_diagnostics`
- [x] Recipe documentation at `docs/syftbox-recipes.md`

### Phase 5: Validation + Examples - COMPLETE

- [x] Python client: `examples/agent-client/biovault_agent.py`
- [x] TypeScript client: `examples/agent-client/biovault-agent.ts`
- [x] Python test: `examples/agent-client/test_agent.py`
- [x] TypeScript test: `examples/agent-client/test-agent.ts`

## Identified Gaps

### Commands Missing from WS Bridge - RESOLVED (v1.4.0)

All previously missing commands have been added to `ws_bridge.rs` in v1.4.0:

**File Operations:** (ADDED)

- `delete_file`, `delete_files_bulk` - File deletion
- `analyze_file_types` - Batch file type analysis
- `is_directory` - Directory check
- `import_files`, `import_files_with_metadata` - File import
- `process_queue`, `clear_pending_queue` - Queue processing
- `pause_queue_processor`, `resume_queue_processor` - Queue control

**Participants:** (ADDED)

- `delete_participant`, `delete_participants_bulk` - Participant deletion

**Sessions:** (ADDED)

- `create_session_with_datasets` - Create session with initial datasets
- `update_session_peer` - Update session peer
- `open_session_folder` - Open session folder in file manager
- `get_session_messages`, `send_session_message` - Legacy session messages

**Pipelines:** (ADDED)

- `delete_pipeline` - Pipeline deletion
- `validate_pipeline` - Pipeline validation
- `save_run_config`, `list_run_configs`, `get_run_config`, `delete_run_config` - Run config management
- `load_pipeline_editor`, `save_pipeline_editor` - Pipeline editor
- `preview_pipeline_spec` - Pipeline preview
- `delete_pipeline_run` - Delete pipeline run

**Projects:** (ADDED)

- `import_project`, `import_project_from_folder` - Project import
- `delete_project`, `delete_project_folder` - Project deletion
- `preview_project_spec`, `get_project_spec_digest` - Project spec utilities
- `get_supported_input_types`, `get_supported_output_types`, `get_supported_parameter_types` - Type info
- `get_common_formats` - Format info

**Network:** (ADDED)

- `network_remove_contact`, `network_trust_changed_key` - Contact management
- `key_refresh_contacts`, `key_republish` - Key operations

**Other:** (ADDED)

- `dismiss_failed_message`, `delete_failed_message` - Failed message management
- `upsert_dataset_manifest` - Dataset manifest management
- `sql_export_query` - SQL export
- `start_analysis` - Analysis start

**Still Excluded (Intentionally):**

- `execute_analysis` - Requires tauri::Window, not suitable for WS bridge
- `save_custom_path` - Custom dependency path saving (low priority)
- Notification commands (`test_notification`, `test_notification_applescript`) - Testing only
- `log_frontend_message` - Frontend-specific

### Event Streaming Gaps

The `EventContext` and `WsEvent` types are defined in `ws_bridge.rs` but not actively used.
Long-running commands currently emit Tauri events (via `app.emit()`) rather than WS events.

**Commands that should emit WS events but don't:**

- `install_dependency`, `install_dependencies` - Currently emit Tauri events
- `launch_jupyter`, `reset_jupyter` - No progress events
- `launch_session_jupyter`, `reset_session_jupyter` - No progress events
- `run_pipeline` - No progress events
- `sync_messages`, `refresh_messages_batched` - No progress events

### Testing Gaps

- No automated contract tests for WS API schema validation
- No integration tests verifying command-response pairs
- Test files exist but are example scripts, not CI-ready tests

## Future Work

- Add Settings UI toggle for agent bridge
- Add command allowlisting for production deployments
- Rate limiting and connection limits
- WebSocket Secure (WSS) support for encrypted connections
- Wire up event emission in long-running command implementations
- ~~Add missing commands to WS bridge~~ (DONE in v1.4.0)
- Create automated API contract tests

## Update Log

### 2026-01-09: v1.4.0 Command Additions

Added 47 missing commands to `ws_bridge.rs`:

- **Files (10):** `is_directory`, `import_files`, `import_files_with_metadata`, `delete_file`, `delete_files_bulk`, `analyze_file_types`, `process_queue`, `pause_queue_processor`, `resume_queue_processor`, `clear_pending_queue`
- **Participants (2):** `delete_participant`, `delete_participants_bulk`
- **Messages (2):** `dismiss_failed_message`, `delete_failed_message`
- **Projects (10):** `import_project`, `import_project_from_folder`, `delete_project`, `delete_project_folder`, `preview_project_spec`, `get_project_spec_digest`, `get_supported_input_types`, `get_supported_output_types`, `get_supported_parameter_types`, `get_common_formats`
- **Runs (1):** `start_analysis`
- **Pipelines (10):** `load_pipeline_editor`, `save_pipeline_editor`, `delete_pipeline`, `validate_pipeline`, `delete_pipeline_run`, `preview_pipeline_spec`, `save_run_config`, `list_run_configs`, `get_run_config`, `delete_run_config`
- **Datasets (1):** `upsert_dataset_manifest`
- **Keys (2):** `key_republish`, `key_refresh_contacts`
- **Network (2):** `network_remove_contact`, `network_trust_changed_key`
- **Sessions (5):** `create_session_with_datasets`, `update_session_peer`, `get_session_messages`, `send_session_message`, `open_session_folder`
- **SQL (1):** `sql_export_query`

Updated documentation:

- `docs/agent-api.json` - JSON schema updated to v1.4.0
- `docs/agent-api.md` - Changelog entry added
- Command lists in ws_bridge.rs `get_commands_list()` updated
