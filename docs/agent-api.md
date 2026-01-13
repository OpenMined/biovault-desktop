# BioVault Desktop Agent API

This document describes the WebSocket API for AI agent control of BioVault Desktop.

## Overview

The BioVault Desktop exposes a WebSocket bridge that allows external agents to invoke Tauri commands programmatically. This enables AI agents to drive onboarding, data workflows, and SyftBox control plane interactions.

## Connection

**Protocol:** WebSocket (ws://)
**Address:** `127.0.0.1` (localhost only)
**Default Port:** `3333`
**URL:** `ws://127.0.0.1:3333`

### Environment Variables

| Variable                  | Description                                               | Default |
| ------------------------- | --------------------------------------------------------- | ------- |
| `DEV_WS_BRIDGE`           | Enable/disable the bridge ("0", "false", "no" to disable) | Enabled |
| `DEV_WS_BRIDGE_DISABLE`   | Force disable ("1", "true", "yes" to disable)             | Not set |
| `DEV_WS_BRIDGE_PORT`      | WebSocket server port                                     | `3333`  |
| `DEV_WS_BRIDGE_HTTP_PORT` | HTTP fallback port                                        | `3334`  |
| `AGENT_BRIDGE_TOKEN`      | Authentication token (overrides settings)                 | Not set |

### Authentication

Authentication is optional by default. When a token is configured (via `AGENT_BRIDGE_TOKEN` environment variable or `agent_bridge_token` in settings), all requests must include the token.

**To enable authentication:**

1. Set the environment variable:

   ```bash
   export AGENT_BRIDGE_TOKEN="your-secret-token"
   ```

2. Or configure in settings (via the UI or settings.json):
   ```json
   {
   	"agent_bridge_token": "your-secret-token"
   }
   ```

When authentication is enabled, include the token in each request:

```json
{
	"id": 1,
	"cmd": "get_app_version",
	"token": "your-secret-token"
}
```

### HTTP Fallback (Optional)

If WebSocket clients are not available, a lightweight HTTP fallback is available at
`http://127.0.0.1:3334` (override via `DEV_WS_BRIDGE_HTTP_PORT` or settings).

- `POST /rpc` accepts the same JSON payload as WebSocket requests.
- `GET /schema` returns the full JSON schema (LLM-friendly).
- `GET /commands` returns the command list with metadata.

HTTP requests support the token in either the JSON body (`token`) or
`Authorization: Bearer <token>` header. Streaming events are not supported over HTTP.
For long-running operations, poll with normal status/list commands (e.g., `get_pipeline_runs`).
Agents can use HTTP for bootstrap and switch to WebSocket for streaming events.

Example:

```bash
curl -s http://127.0.0.1:3334/schema
```

### Audit Logging

All commands are logged to `{BIOVAULT_HOME}/logs/agent_bridge_audit.jsonl` for auditability. Each entry includes:

- `timestamp`: ISO 8601 timestamp
- `request_id`: Request identifier
- `cmd`: Command name
- `args_size`: Size of arguments in bytes
- `duration_ms`: Execution time in milliseconds
- `success`: Whether the command succeeded
- `error`: Error message (if failed)
- `peer_addr`: Client address

Use `agent_api_get_audit_log` to retrieve recent entries programmatically.

## Protocol

### Request Format

```json
{
	"id": 1,
	"cmd": "command_name",
	"args": {
		"param1": "value1",
		"param2": "value2"
	},
	"token": "optional-auth-token"
}
```

| Field   | Type    | Required | Description                                                      |
| ------- | ------- | -------- | ---------------------------------------------------------------- |
| `id`    | integer | Yes      | Unique request identifier (auto-incrementing)                    |
| `cmd`   | string  | Yes      | Command name (case-sensitive)                                    |
| `args`  | object  | No       | Command arguments (defaults to `{}`)                             |
| `token` | string  | No\*     | Authentication token (\*required if `AGENT_BRIDGE_TOKEN` is set) |

### Response Format

**Success:**

```json
{
	"id": 1,
	"result": { "data": "value" }
}
```

**Error:**

```json
{
	"id": 1,
	"error": "Error message string"
}
```

| Field    | Type    | Description                                            |
| -------- | ------- | ------------------------------------------------------ |
| `id`     | integer | Request identifier (matches request.id)                |
| `result` | any     | Command result (present on success, omitted on error)  |
| `error`  | string  | Error message (present on failure, omitted on success) |

### Event Streaming (for Long-Running Operations)

Long-running commands emit streaming events during execution. Events are sent with the same `id` as the original request, allowing you to track progress.

**Event Format:**

```json
{
	"id": 1,
	"type": "progress",
	"data": {
		"progress": 0.5,
		"message": "Installing dependencies..."
	}
}
```

| Field  | Type    | Description                                |
| ------ | ------- | ------------------------------------------ |
| `id`   | integer | Request identifier (same as request.id)    |
| `type` | string  | Event type: `progress`, `log`, or `status` |
| `data` | object  | Event payload (structure depends on type)  |

**Event Types:**

| Type       | Description     | Data Fields                                |
| ---------- | --------------- | ------------------------------------------ |
| `progress` | Progress update | `progress` (0.0-1.0), `message`            |
| `log`      | Log message     | `level` (debug/info/warn/error), `message` |
| `status`   | Status change   | `status`, `details` (optional)             |

**Example: Handling Events in Python**

```python
from biovault_agent import BioVaultAgent, AgentEvent

def handle_event(event: AgentEvent):
    if event.event_type == "progress":
        print(f"Progress: {event.progress:.0%} - {event.message}")
    elif event.event_type == "log":
        print(f"[{event.level}] {event.message}")
    elif event.event_type == "status":
        print(f"Status: {event.status}")

async with BioVaultAgent() as agent:
    result = await agent.invoke_with_events(
        "install_dependency",
        {"name": "docker"},
        on_event=handle_event
    )
```

**Commands That Emit Events:**

- `install_dependencies`, `install_dependency`, `install_brew`, `install_command_line_tools`
- `sync_messages`, `sync_messages_with_failures`, `refresh_messages_batched`
- `import_pipeline_with_deps`, `run_pipeline`
- `launch_jupyter`, `reset_jupyter`
- `launch_session_jupyter`, `reset_session_jupyter`
- `syftbox_upload_action`

Use `agent_api_events_info` to get the complete list at runtime.

### Argument Naming

Arguments support both `camelCase` and `snake_case`. For example:

- `projectPath` or `project_path`
- `profileId` or `profile_id`
- `threadId` or `thread_id`

## Command Categories

### Agent API

Commands for API discovery and diagnostics.

| Command                     | Description                       | Read-Only | Async |
| --------------------------- | --------------------------------- | --------- | ----- |
| `agent_api_discover`        | Get API metadata and capabilities | Yes       | No    |
| `agent_api_get_audit_log`   | Get recent audit log entries      | Yes       | No    |
| `agent_api_clear_audit_log` | Clear the audit log               | No        | No    |
| `agent_api_get_schema`      | Get full JSON schema at runtime   | Yes       | No    |
| `agent_api_list_commands`   | Get lightweight command list      | Yes       | No    |
| `agent_api_events_info`     | Get event streaming system info   | Yes       | No    |

**Example: Discover API**

```json
{ "id": 1, "cmd": "agent_api_discover" }
```

Response:

```json
{
	"id": 1,
	"result": {
		"version": "1.4.2",
		"name": "BioVault Desktop Agent API",
		"auth": { "required": false, "method": "token" },
		"docs": "docs/agent-api.md",
		"schema": "docs/agent-api.json"
	}
}
```

**Example: Get audit log**

```json
{ "id": 2, "cmd": "agent_api_get_audit_log", "args": { "maxEntries": 10 } }
```

**Example: List available commands**

```json
{ "id": 3, "cmd": "agent_api_list_commands" }
```

Response:

```json
{
  "id": 3,
  "result": {
    "version": "1.2.0",
    "commands": [
      {"name": "agent_api_discover", "category": "agent_api", "readOnly": true},
      {"name": "get_app_version", "category": "app_status", "readOnly": true},
      ...
    ]
  }
}
```

**Example: Get full schema**

```json
{ "id": 4, "cmd": "agent_api_get_schema" }
```

Response contains the complete `agent-api.json` schema.

### App Status

Commands for checking application state and environment.

| Command                 | Description                          | Read-Only | Async |
| ----------------------- | ------------------------------------ | --------- | ----- |
| `get_app_version`       | Get application version string       | Yes       | No    |
| `is_dev_mode`           | Check if running in development mode | Yes       | No    |
| `get_dev_mode_info`     | Get comprehensive dev mode settings  | Yes       | No    |
| `get_env_var`           | Get an environment variable value    | Yes       | No    |
| `get_config_path`       | Get path to config.yaml              | Yes       | No    |
| `get_database_path`     | Get path to SQLite database          | Yes       | No    |
| `get_autostart_enabled` | Check if app autostarts on login     | Yes       | No    |

### Onboarding

Commands for initial setup and onboarding.

| Command               | Description                     | Read-Only | Async |
| --------------------- | ------------------------------- | --------- | ----- |
| `check_is_onboarded`  | Check if onboarding is complete | Yes       | No    |
| `complete_onboarding` | Complete onboarding with email  | No        | Yes   |

**Example: Check onboarding status**

```json
{ "id": 1, "cmd": "check_is_onboarded" }
```

Response:

```json
{ "id": 1, "result": true }
```

**Example: Complete onboarding**

```json
{ "id": 2, "cmd": "complete_onboarding", "args": { "email": "user@example.com" } }
```

### Profiles

Commands for managing multiple user profiles.

| Command                                  | Description                        | Read-Only | Async |
| ---------------------------------------- | ---------------------------------- | --------- | ----- |
| `profiles_get_boot_state`                | Get all profiles and current state | Yes       | No    |
| `profiles_get_default_home`              | Get default BioVault home path     | Yes       | No    |
| `profiles_switch`                        | Switch to a profile (new window)   | No        | No    |
| `profiles_switch_in_place`               | Switch profile in current window   | No        | No    |
| `profiles_create_and_switch_in_place`    | Create and switch to new profile   | No        | No    |
| `profiles_check_home_for_existing_email` | Check if home has existing profile | Yes       | No    |
| `profiles_delete_profile`                | Delete a profile                   | No        | No    |

**Example: Get boot state**

```json
{ "id": 1, "cmd": "profiles_get_boot_state" }
```

**Example: Switch profile in place**

```json
{ "id": 2, "cmd": "profiles_switch_in_place", "args": { "profileId": "abc123" } }
```

### Settings

Commands for managing application settings.

| Command                 | Description          | Read-Only | Async |
| ----------------------- | -------------------- | --------- | ----- |
| `get_settings`          | Get all settings     | Yes       | No    |
| `save_settings`         | Save settings        | No        | No    |
| `set_autostart_enabled` | Toggle app autostart | No        | No    |

### UI Control

Commands for driving the local UI (navigation and pipeline import helpers).

| Command                        | Description                                    | Read-Only | Async |
| ------------------------------ | ---------------------------------------------- | --------- | ----- |
| `ui_navigate`                  | Navigate to a tab/view                         | No        | No    |
| `ui_pipeline_import_options`   | Open pipeline import options modal             | No        | No    |
| `ui_pipeline_import_from_path` | Import a pipeline from a local path via the UI | No        | No    |

### Dependencies

Commands for checking and installing required software.

| Command                              | Description                  | Read-Only | Async | Long-Running |
| ------------------------------------ | ---------------------------- | --------- | ----- | ------------ |
| `check_dependencies`                 | Check all dependencies       | Yes       | Yes   | No           |
| `check_single_dependency`            | Check one dependency         | Yes       | Yes   | No           |
| `install_dependencies`               | Install missing dependencies | No        | Yes   | Yes          |
| `install_dependency`                 | Install single dependency    | No        | Yes   | Yes          |
| `install_brew`                       | Install Homebrew (macOS)     | No        | Yes   | Yes          |
| `check_brew_installed`               | Check if Homebrew installed  | Yes       | No    | No           |
| `check_command_line_tools_installed` | Check if CLT installed       | Yes       | No    | No           |
| `check_docker_running`               | Check if Docker is running   | Yes       | Yes   | No           |

**Example: Check dependencies**

```json
{ "id": 1, "cmd": "check_dependencies" }
```

### SyftBox Control Plane

Commands for controlling the SyftBox daemon and sync.

| Command                   | Description                     | Read-Only | Async |
| ------------------------- | ------------------------------- | --------- | ----- |
| `check_syftbox_auth`      | Check authentication status     | Yes       | No    |
| `get_syftbox_state`       | Get daemon state                | Yes       | No    |
| `start_syftbox_client`    | Start the daemon                | No        | No    |
| `stop_syftbox_client`     | Stop the daemon                 | No        | No    |
| `get_syftbox_config_info` | Get configuration info          | Yes       | No    |
| `trigger_syftbox_sync`    | Trigger immediate sync          | No        | Yes   |
| `syftbox_queue_status`    | Get upload queue status         | Yes       | Yes   |
| `syftbox_upload_action`   | Perform action on queued upload | No        | Yes   |
| `syftbox_request_otp`     | Request OTP for auth            | No        | Yes   |
| `syftbox_submit_otp`      | Submit OTP to complete auth     | No        | Yes   |
| `get_syftbox_diagnostics` | Get diagnostic info             | Yes       | No    |

**Example: Check SyftBox status**

```json
{ "id": 1, "cmd": "get_syftbox_state" }
```

Response:

```json
{
	"id": 1,
	"result": {
		"running": true,
		"healthy": true,
		"syncStatus": "idle"
	}
}
```

### Keys & Cryptography

Commands for managing cryptographic identities.

| Command             | Description             | Read-Only | Async |
| ------------------- | ----------------------- | --------- | ----- |
| `key_get_status`    | Get key status          | Yes       | No    |
| `key_generate`      | Generate new identity   | No        | Yes   |
| `key_restore`       | Restore from mnemonic   | No        | Yes   |
| `key_list_contacts` | List saved contacts     | Yes       | No    |
| `key_check_contact` | Check if contact exists | Yes       | No    |

**Example: Generate new key**

```json
{ "id": 1, "cmd": "key_generate", "args": { "email": "user@example.com" } }
```

### Messaging

Commands for the encrypted messaging system.

| Command                       | Description                | Read-Only | Async | Long-Running |
| ----------------------------- | -------------------------- | --------- | ----- | ------------ |
| `sync_messages`               | Sync all messages          | No        | No    | Yes          |
| `sync_messages_with_failures` | Sync with failure tracking | No        | No    | Yes          |
| `list_message_threads`        | List threads               | Yes       | No    | No           |
| `get_thread_messages`         | Get messages in thread     | Yes       | No    | No           |
| `send_message`                | Send a message             | No        | No    | No           |
| `mark_thread_as_read`         | Mark thread read           | No        | No    | No           |
| `delete_message`              | Delete a message           | No        | No    | No           |
| `delete_thread`               | Delete a thread            | No        | No    | No           |

**Example: Send a message**

```json
{
	"id": 1,
	"cmd": "send_message",
	"args": {
		"request": {
			"recipient": "other@example.com",
			"body": "Hello from the agent!"
		}
	}
}
```

### Files & Participants

Commands for managing imported files and participants.

| Command                 | Description                        | Read-Only | Async |
| ----------------------- | ---------------------------------- | --------- | ----- |
| `get_files`             | List all imported files            | Yes       | No    |
| `get_participants`      | List all participants              | Yes       | No    |
| `get_extensions`        | Get file extensions in a directory | Yes       | No    |
| `search_txt_files`      | Search for text files              | Yes       | No    |
| `suggest_patterns`      | Suggest ID extraction patterns     | Yes       | No    |
| `extract_ids_for_files` | Extract IDs using a pattern        | Yes       | No    |
| `detect_file_types`     | Detect file types                  | Yes       | Yes   |
| `import_files_pending`  | Import pending files               | No        | Yes   |
| `open_folder`           | Open folder in file explorer       | No        | No    |

**Example: Import files**

```json
{
	"id": 1,
	"cmd": "import_files_pending",
	"args": {
		"fileMetadata": [
			{ "path": "/path/to/file1.csv", "participantId": "P001" },
			{ "path": "/path/to/file2.csv", "participantId": "P002" }
		]
	}
}
```

### Network

Commands for network discovery and contact management.

| Command                  | Description                | Read-Only | Async |
| ------------------------ | -------------------------- | --------- | ----- |
| `network_import_contact` | Import a contact identity  | No        | No    |
| `network_scan_datasites` | Scan available datasites   | Yes       | No    |
| `network_scan_datasets`  | Scan datasets on datasites | Yes       | No    |

### Projects

Commands for project management.

| Command                          | Description                      | Read-Only | Async |
| -------------------------------- | -------------------------------- | --------- | ----- |
| `get_projects`                   | List all projects                | Yes       | No    |
| `create_project`                 | Create new project               | No        | No    |
| `load_project_editor`            | Load project for editing         | Yes       | No    |
| `save_project_editor`            | Save project changes             | No        | No    |
| `get_available_project_examples` | List example projects            | Yes       | No    |
| `get_default_project_path`       | Get default path for new project | Yes       | No    |

**Example: Create a project**

```json
{
	"id": 1,
	"cmd": "create_project",
	"args": {
		"name": "my-analysis",
		"createPythonScript": true,
		"scriptName": "analysis.py"
	}
}
```

### Pipelines

Commands for pipeline management and execution.

| Command                        | Description               | Read-Only | Async | Long-Running |
| ------------------------------ | ------------------------- | --------- | ----- | ------------ |
| `get_pipelines`                | List pipelines            | Yes       | Yes   | No           |
| `create_pipeline`              | Create pipeline           | No        | Yes   | No           |
| `import_pipeline`              | Import pipeline from spec | No        | Yes   | No           |
| `import_pipeline_from_message` | Import from message       | No        | Yes   | No           |
| `import_pipeline_from_request` | Import from request       | No        | Yes   | No           |
| `import_pipeline_with_deps`    | Import with dependencies  | No        | Yes   | Yes          |
| `run_pipeline`                 | Execute pipeline          | No        | Yes   | Yes          |
| `get_pipeline_runs`            | List runs                 | Yes       | Yes   | No           |
| `get_runs_base_dir`            | Get runs directory        | Yes       | Yes   | No           |
| `send_pipeline_request`        | Send execution request    | No        | No    | No           |
| `send_pipeline_results`        | Send results to peer      | No        | No    | No           |
| `import_pipeline_results`      | Import results            | No        | No    | No           |
| `list_results_tree`            | List results directory    | Yes       | No    | No           |

**Example: Run a pipeline**

```json
{
	"id": 1,
	"cmd": "run_pipeline",
	"args": {
		"pipelineId": 1,
		"inputOverrides": {
			"samples": "/path/to/samples.csv"
		}
	}
}
```

### Datasets

Commands for dataset management.

| Command                          | Description             | Read-Only | Async |
| -------------------------------- | ----------------------- | --------- | ----- |
| `get_datasets`                   | List datasets           | Yes       | No    |
| `list_datasets_with_assets`      | List with asset details | Yes       | No    |
| `save_dataset_with_files`        | Save dataset            | No        | Yes   |
| `is_dataset_published`           | Check if published      | Yes       | No    |
| `publish_dataset`                | Publish to network      | No        | Yes   |
| `unpublish_dataset`              | Remove from network     | No        | No    |
| `delete_dataset`                 | Delete dataset          | No        | No    |
| `get_datasets_folder_path`       | Get datasets folder     | Yes       | No    |
| `resolve_dataset_path`           | Resolve dataset path    | Yes       | No    |
| `resolve_syft_url_to_local_path` | Resolve SyftBox URL     | Yes       | No    |
| `resolve_syft_urls_batch`        | Batch resolve URLs      | Yes       | No    |

### Runs

Commands for managing analysis runs.

| Command             | Description              | Read-Only | Async |
| ------------------- | ------------------------ | --------- | ----- |
| `get_runs`          | List all runs            | Yes       | No    |
| `delete_run`        | Delete a run             | No        | No    |
| `get_run_logs`      | Get run logs             | Yes       | No    |
| `get_run_logs_tail` | Get last N lines of logs | Yes       | No    |
| `get_run_logs_full` | Get full logs            | Yes       | No    |

### Sessions

Commands for collaborative sessions.

| Command                        | Description              | Read-Only | Async |
| ------------------------------ | ------------------------ | --------- | ----- |
| `get_sessions`                 | List sessions            | Yes       | No    |
| `list_sessions`                | List sessions (alias)    | Yes       | No    |
| `get_session`                  | Get single session       | Yes       | No    |
| `get_session_invitations`      | Get pending invitations  | Yes       | No    |
| `create_session`               | Create session           | No        | No    |
| `delete_session`               | Delete session           | No        | No    |
| `accept_session_invitation`    | Accept invite            | No        | No    |
| `reject_session_invitation`    | Reject invite            | No        | No    |
| `send_session_chat_message`    | Send chat message        | No        | No    |
| `get_session_chat_messages`    | Get chat messages        | Yes       | No    |
| `list_session_datasets`        | List datasets in session | Yes       | No    |
| `get_session_beaver_summaries` | Get Beaver summaries     | Yes       | No    |
| `add_dataset_to_session`       | Add dataset to session   | No        | No    |
| `remove_dataset_from_session`  | Remove dataset           | No        | No    |

### Jupyter

Commands for Jupyter notebook management (project-level).

| Command              | Description            | Read-Only | Async | Long-Running |
| -------------------- | ---------------------- | --------- | ----- | ------------ |
| `get_jupyter_status` | Get status for project | Yes       | No    | No           |
| `launch_jupyter`     | Start Jupyter server   | No        | Yes   | Yes          |
| `stop_jupyter`       | Stop Jupyter server    | No        | Yes   | No           |
| `reset_jupyter`      | Reset environment      | No        | Yes   | Yes          |

### Session Jupyter

Commands for Jupyter notebook management (session-level).

| Command                      | Description               | Read-Only | Async | Long-Running |
| ---------------------------- | ------------------------- | --------- | ----- | ------------ |
| `get_session_jupyter_status` | Get status for session    | Yes       | No    | No           |
| `launch_session_jupyter`     | Start for session         | No        | Yes   | Yes          |
| `stop_session_jupyter`       | Stop for session          | No        | Yes   | No           |
| `reset_session_jupyter`      | Reset session environment | No        | Yes   | Yes          |

**Example: Launch Jupyter**

```json
{
	"id": 1,
	"cmd": "launch_jupyter",
	"args": {
		"projectPath": "/home/user/BioVault/projects/my-project"
	}
}
```

Response:

```json
{
	"id": 1,
	"result": {
		"status": "running",
		"url": "http://localhost:8888",
		"token": "abc123..."
	}
}
```

### Logs & Diagnostics

Commands for accessing logs and diagnostic information.

| Command                      | Description                | Read-Only | Async |
| ---------------------------- | -------------------------- | --------- | ----- |
| `get_command_logs`           | Get command execution logs | Yes       | No    |
| `clear_command_logs`         | Clear command logs         | No        | No    |
| `get_desktop_log_text`       | Get desktop log contents   | Yes       | No    |
| `clear_desktop_log`          | Clear desktop log          | No        | No    |
| `get_desktop_log_dir`        | Get log directory path     | Yes       | No    |
| `get_queue_info`             | Get processing queue info  | Yes       | No    |
| `get_queue_processor_status` | Get queue processor status | Yes       | No    |

**Example: Get recent logs**

```json
{
	"id": 1,
	"cmd": "get_desktop_log_text",
	"args": { "maxBytes": 10000 }
}
```

### SQL

Direct database access commands.

| Command                | Description          | Read-Only | Async |
| ---------------------- | -------------------- | --------- | ----- |
| `sql_list_tables`      | List database tables | Yes       | No    |
| `sql_get_table_schema` | Get table schema     | Yes       | No    |
| `sql_run_query`        | Execute SQL query    | No\*      | No    |

\*Note: `sql_run_query` is read-only for SELECT queries but can modify data with INSERT/UPDATE/DELETE.

**Example: List tables**

```json
{ "id": 1, "cmd": "sql_list_tables" }
```

**Example: Run query**

```json
{
	"id": 1,
	"cmd": "sql_run_query",
	"args": {
		"query": "SELECT * FROM projects LIMIT 10"
	}
}
```

### Data Reset (Destructive)

Commands that delete data. Use with caution.

| Command            | Description                        | Dangerous |
| ------------------ | ---------------------------------- | --------- |
| `reset_all_data`   | Reset app data (preserves SyftBox) | Yes       |
| `reset_everything` | Reset all data including SyftBox   | Yes       |

## Timeout Handling

Different commands have different timeout expectations:

| Category     | Default Timeout | Commands                                                                                     |
| ------------ | --------------- | -------------------------------------------------------------------------------------------- |
| Standard     | 30 seconds      | Most commands                                                                                |
| Long-running | 3 minutes       | `launch_jupyter`, `install_dependencies`, `sync_messages`, `import_pipeline_with_deps`, etc. |

When using the client, you may want to set appropriate timeouts based on the command type.

## Error Handling

Errors are returned as string messages in the `error` field:

```json
{
	"id": 1,
	"error": "Missing profileId"
}
```

Common error patterns:

- `"Missing <param>"` - Required parameter not provided
- `"Failed to parse <param>: ..."` - Parameter has wrong type
- `"Unhandled command: <cmd>"` - Command doesn't exist

## Agent Workflow Examples

### Example 1: Complete Onboarding Flow

```python
# 1. Check if already onboarded
await ws_send({"id": 1, "cmd": "check_is_onboarded"})
# Response: {"id": 1, "result": false}

# 2. Check dependencies
await ws_send({"id": 2, "cmd": "check_dependencies"})
# Response: {"id": 2, "result": [{"name": "docker", "installed": true}, ...]}

# 3. Complete onboarding
await ws_send({"id": 3, "cmd": "complete_onboarding", "args": {"email": "user@example.com"}})
# Response: {"id": 3, "result": null}

# 4. Generate cryptographic key
await ws_send({"id": 4, "cmd": "key_generate", "args": {"email": "user@example.com"}})
# Response: {"id": 4, "result": {"success": true, "mnemonic": "word1 word2 ..."}}

# 5. Start SyftBox
await ws_send({"id": 5, "cmd": "start_syftbox_client"})
# Response: {"id": 5, "result": {"running": true}}
```

### Example 2: Create and Run Pipeline

```python
# 1. Create a project
await ws_send({
    "id": 1,
    "cmd": "create_project",
    "args": {"name": "gwas-analysis"}
})

# 2. Create a pipeline
await ws_send({
    "id": 2,
    "cmd": "create_pipeline",
    "args": {
        "request": {
            "name": "gwas-pipeline",
            "directory": "/home/user/BioVault/pipelines/gwas-pipeline"
        }
    }
})

# 3. Get pipeline ID from result
pipeline_id = response["result"]["id"]

# 4. Run the pipeline
await ws_send({
    "id": 3,
    "cmd": "run_pipeline",
    "args": {
        "pipelineId": pipeline_id,
        "inputOverrides": {}
    }
})
```

### Example 3: Monitor SyftBox Health

```python
# Check auth status
await ws_send({"id": 1, "cmd": "check_syftbox_auth"})

# Get daemon state
await ws_send({"id": 2, "cmd": "get_syftbox_state"})

# Check queue status
await ws_send({"id": 3, "cmd": "syftbox_queue_status"})

# Trigger sync if needed
await ws_send({"id": 4, "cmd": "trigger_syftbox_sync"})

# Get diagnostics
await ws_send({"id": 5, "cmd": "get_syftbox_diagnostics"})
```

## Security Considerations

1. **Localhost Only**: The bridge binds to `127.0.0.1`, not `0.0.0.0`. It's only accessible from the local machine.

2. **Token Authentication**: Optional token-based authentication can be configured via `AGENT_BRIDGE_TOKEN` environment variable or settings.

3. **Audit Logging**: All commands are logged to `{BIOVAULT_HOME}/logs/agent_bridge_audit.jsonl` for auditability.

4. **Destructive Commands**: Commands like `reset_everything` and `sql_run_query` can modify or delete data. Exercise caution.

## API Discovery

To get the machine-readable API specification at runtime, read the `docs/agent-api.json` file which contains the full JSON schema for all commands.

## Version

This document describes API version **1.4.2**.

## Changelog

### 1.4.2

- Added HTTP fallback endpoints (`/rpc`, `/schema`, `/commands`)
- Added agent bridge HTTP port configuration

### 1.4.1

- Added UI control commands: `ui_navigate`, `ui_pipeline_import_options`, `ui_pipeline_import_from_path`

### 1.4.0

- Added 47 additional missing commands to the WS bridge implementation:
  - Files: `is_directory`, `import_files`, `import_files_with_metadata`, `delete_file`, `delete_files_bulk`, `analyze_file_types`, `process_queue`, `pause_queue_processor`, `resume_queue_processor`, `clear_pending_queue`
  - Participants: `delete_participant`, `delete_participants_bulk`
  - Messages: `dismiss_failed_message`, `delete_failed_message`
  - Projects: `import_project`, `import_project_from_folder`, `delete_project`, `delete_project_folder`, `preview_project_spec`, `get_project_spec_digest`, `get_supported_input_types`, `get_supported_output_types`, `get_supported_parameter_types`, `get_common_formats`
  - Runs: `start_analysis`
  - Pipelines: `load_pipeline_editor`, `save_pipeline_editor`, `delete_pipeline`, `validate_pipeline`, `delete_pipeline_run`, `preview_pipeline_spec`, `save_run_config`, `list_run_configs`, `get_run_config`, `delete_run_config`
  - Datasets: `upsert_dataset_manifest`
  - Keys: `key_republish`, `key_refresh_contacts`
  - Network: `network_remove_contact`, `network_trust_changed_key`
  - Sessions: `create_session_with_datasets`, `update_session_peer`, `get_session_messages`, `send_session_message`, `open_session_folder`
  - SQL: `sql_export_query`
- Full command coverage now ~200 commands

### 1.3.0

- Added 47 missing commands to the API specification
- Added Files & Participants section
- Added Network section
- Added Session Jupyter section (separated from Jupyter)
- Expanded Pipelines, Datasets, and Sessions sections with additional commands
- Full command coverage now matches ws_bridge.rs (155 commands)
