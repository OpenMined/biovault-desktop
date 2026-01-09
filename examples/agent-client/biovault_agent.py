#!/usr/bin/env python3
"""
BioVault Desktop Agent Client

A Python client library for interacting with the BioVault Desktop
via the WebSocket Agent API.

Example usage:
    from biovault_agent import BioVaultAgent

    async with BioVaultAgent() as agent:
        # Check if onboarded
        is_onboarded = await agent.check_is_onboarded()
        print(f"Onboarded: {is_onboarded}")

        # Get app version
        version = await agent.get_app_version()
        print(f"Version: {version}")

        # List projects
        projects = await agent.get_projects()
        for p in projects:
            print(f"  - {p['name']}")
"""

import asyncio
import json
import os
from dataclasses import dataclass
from typing import Any, Callable, Optional
from contextlib import asynccontextmanager

try:
    import websockets
except ImportError:
    print("Please install websockets: pip install websockets")
    raise


@dataclass
class AgentConfig:
    """Configuration for the BioVault agent client."""
    host: str = "127.0.0.1"
    port: int = 3333
    token: Optional[str] = None
    timeout: float = 30.0
    long_timeout: float = 180.0  # 3 minutes for long-running operations

    @classmethod
    def from_env(cls) -> "AgentConfig":
        """Create config from environment variables."""
        return cls(
            host=os.environ.get("BIOVAULT_AGENT_HOST", "127.0.0.1"),
            port=int(os.environ.get("DEV_WS_BRIDGE_PORT", "3333")),
            token=os.environ.get("AGENT_BRIDGE_TOKEN"),
            timeout=float(os.environ.get("BIOVAULT_AGENT_TIMEOUT", "30")),
        )


class BioVaultAgentError(Exception):
    """Error from the BioVault agent API."""
    pass


@dataclass
class AgentEvent:
    """Event emitted during long-running operations."""
    request_id: int
    event_type: str  # "progress", "log", "status"
    data: dict

    @classmethod
    def from_dict(cls, data: dict) -> "AgentEvent":
        return cls(
            request_id=data.get("id", 0),
            event_type=data.get("type", "unknown"),
            data=data.get("data", {}),
        )

    @property
    def progress(self) -> Optional[float]:
        """Get progress value (0.0-1.0) if this is a progress event."""
        if self.event_type == "progress":
            return self.data.get("progress")
        return None

    @property
    def message(self) -> Optional[str]:
        """Get message from progress or log events."""
        return self.data.get("message")

    @property
    def level(self) -> Optional[str]:
        """Get log level if this is a log event."""
        if self.event_type == "log":
            return self.data.get("level")
        return None

    @property
    def status(self) -> Optional[str]:
        """Get status if this is a status event."""
        if self.event_type == "status":
            return self.data.get("status")
        return None


# Type alias for event callback
EventCallback = Callable[[AgentEvent], None]


class BioVaultAgent:
    """
    Async client for the BioVault Desktop Agent API.

    This client connects to the BioVault Desktop WebSocket bridge
    and provides typed methods for all available commands.
    """

    # Commands that need longer timeout
    LONG_RUNNING_COMMANDS = {
        "launch_jupyter",
        "stop_jupyter",
        "reset_jupyter",
        "launch_session_jupyter",
        "stop_session_jupyter",
        "reset_session_jupyter",
        "sync_messages",
        "sync_messages_with_failures",
        "refresh_messages_batched",
        "install_dependencies",
        "install_dependency",
        "install_brew",
        "install_command_line_tools",
        "import_pipeline_with_deps",
        "run_pipeline",
        "syftbox_upload_action",
    }

    def __init__(self, config: Optional[AgentConfig] = None):
        self.config = config or AgentConfig.from_env()
        self._ws = None
        self._request_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._event_handlers: dict[int, EventCallback] = {}
        self._receiver_task = None

    @property
    def url(self) -> str:
        return f"ws://{self.config.host}:{self.config.port}"

    async def connect(self):
        """Connect to the WebSocket bridge."""
        self._ws = await websockets.connect(self.url)
        self._receiver_task = asyncio.create_task(self._receive_loop())

    async def disconnect(self):
        """Disconnect from the WebSocket bridge."""
        if self._receiver_task:
            self._receiver_task.cancel()
            try:
                await self._receiver_task
            except asyncio.CancelledError:
                pass
        if self._ws:
            await self._ws.close()
            self._ws = None

    async def __aenter__(self):
        await self.connect()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.disconnect()

    async def _receive_loop(self):
        """Background task to receive responses and events."""
        try:
            async for message in self._ws:
                data = json.loads(message)
                request_id = data.get("id")

                # Check if this is an event (has "type" field) or a response (has "result" or "error")
                if "type" in data:
                    # This is a streaming event
                    if request_id in self._event_handlers:
                        event = AgentEvent.from_dict(data)
                        try:
                            self._event_handlers[request_id](event)
                        except Exception as e:
                            # Don't let handler errors crash the receive loop
                            print(f"Event handler error: {e}")
                elif request_id in self._pending:
                    # This is a final response
                    self._pending[request_id].set_result(data)
        except websockets.ConnectionClosed:
            # Connection closed, cancel all pending requests
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(BioVaultAgentError("Connection closed"))

    async def invoke(self, cmd: str, args: Optional[dict] = None, timeout: Optional[float] = None) -> Any:
        """
        Invoke a command on the BioVault agent.

        Args:
            cmd: Command name
            args: Command arguments
            timeout: Override timeout for this request

        Returns:
            Command result

        Raises:
            BioVaultAgentError: If the command fails
        """
        if not self._ws:
            raise BioVaultAgentError("Not connected")

        self._request_id += 1
        request_id = self._request_id

        request = {
            "id": request_id,
            "cmd": cmd,
            "args": args or {},
        }

        if self.config.token:
            request["token"] = self.config.token

        # Determine timeout
        if timeout is None:
            if cmd in self.LONG_RUNNING_COMMANDS:
                timeout = self.config.long_timeout
            else:
                timeout = self.config.timeout

        # Create future for response
        future = asyncio.get_event_loop().create_future()
        self._pending[request_id] = future

        try:
            await self._ws.send(json.dumps(request))
            response = await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            raise BioVaultAgentError(f"Timeout waiting for response to {cmd}")
        finally:
            self._pending.pop(request_id, None)

        if "error" in response and response["error"]:
            raise BioVaultAgentError(response["error"])

        return response.get("result")

    async def invoke_with_events(
        self,
        cmd: str,
        args: Optional[dict] = None,
        on_event: Optional[EventCallback] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """
        Invoke a long-running command and receive streaming events.

        Args:
            cmd: Command name
            args: Command arguments
            on_event: Callback function called for each event
            timeout: Override timeout for this request

        Returns:
            Command result (final response)

        Raises:
            BioVaultAgentError: If the command fails

        Example:
            def handle_event(event: AgentEvent):
                if event.event_type == "progress":
                    print(f"Progress: {event.progress:.0%} - {event.message}")
                elif event.event_type == "log":
                    print(f"[{event.level}] {event.message}")

            result = await agent.invoke_with_events(
                "install_dependency",
                {"name": "docker"},
                on_event=handle_event
            )
        """
        if not self._ws:
            raise BioVaultAgentError("Not connected")

        self._request_id += 1
        request_id = self._request_id

        request = {
            "id": request_id,
            "cmd": cmd,
            "args": args or {},
        }

        if self.config.token:
            request["token"] = self.config.token

        # Determine timeout
        if timeout is None:
            if cmd in self.LONG_RUNNING_COMMANDS:
                timeout = self.config.long_timeout
            else:
                timeout = self.config.timeout

        # Create future for response
        future = asyncio.get_event_loop().create_future()
        self._pending[request_id] = future

        # Register event handler if provided
        if on_event:
            self._event_handlers[request_id] = on_event

        try:
            await self._ws.send(json.dumps(request))
            response = await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            raise BioVaultAgentError(f"Timeout waiting for response to {cmd}")
        finally:
            self._pending.pop(request_id, None)
            self._event_handlers.pop(request_id, None)

        if "error" in response and response["error"]:
            raise BioVaultAgentError(response["error"])

        return response.get("result")

    # -------------------------------------------------------------------------
    # Agent API Discovery
    # -------------------------------------------------------------------------

    async def discover(self) -> dict:
        """Get API metadata and capabilities."""
        return await self.invoke("agent_api_discover")

    async def get_events_info(self) -> dict:
        """Get information about the event streaming system."""
        return await self.invoke("agent_api_events_info")

    async def get_audit_log(self, max_entries: int = 100) -> list:
        """Get recent audit log entries."""
        return await self.invoke("agent_api_get_audit_log", {"maxEntries": max_entries})

    async def clear_audit_log(self):
        """Clear the audit log."""
        return await self.invoke("agent_api_clear_audit_log")

    # -------------------------------------------------------------------------
    # App Status
    # -------------------------------------------------------------------------

    async def get_app_version(self) -> str:
        """Get the application version."""
        return await self.invoke("get_app_version")

    async def is_dev_mode(self) -> bool:
        """Check if app is in development mode."""
        return await self.invoke("is_dev_mode")

    async def get_dev_mode_info(self) -> dict:
        """Get development mode information."""
        return await self.invoke("get_dev_mode_info")

    async def get_env_var(self, key: str) -> Optional[str]:
        """Get an environment variable value."""
        return await self.invoke("get_env_var", {"key": key})

    async def get_config_path(self) -> str:
        """Get path to config.yaml."""
        return await self.invoke("get_config_path")

    async def get_database_path(self) -> str:
        """Get path to the SQLite database."""
        return await self.invoke("get_database_path")

    # -------------------------------------------------------------------------
    # Onboarding
    # -------------------------------------------------------------------------

    async def check_is_onboarded(self) -> bool:
        """Check if onboarding is complete."""
        return await self.invoke("check_is_onboarded")

    async def complete_onboarding(self, email: str):
        """Complete onboarding with an email."""
        return await self.invoke("complete_onboarding", {"email": email})

    # -------------------------------------------------------------------------
    # Profiles
    # -------------------------------------------------------------------------

    async def profiles_get_boot_state(self) -> dict:
        """Get current profiles boot state."""
        return await self.invoke("profiles_get_boot_state")

    async def profiles_get_default_home(self) -> str:
        """Get default BioVault home path."""
        return await self.invoke("profiles_get_default_home")

    async def profiles_switch_in_place(self, profile_id: str):
        """Switch to a different profile in place."""
        return await self.invoke("profiles_switch_in_place", {"profileId": profile_id})

    # -------------------------------------------------------------------------
    # Dependencies
    # -------------------------------------------------------------------------

    async def check_dependencies(self) -> list:
        """Check all required dependencies."""
        return await self.invoke("check_dependencies")

    async def check_single_dependency(self, name: str, path: Optional[str] = None) -> dict:
        """Check a single dependency."""
        args = {"name": name}
        if path:
            args["path"] = path
        return await self.invoke("check_single_dependency", args)

    async def check_docker_running(self) -> bool:
        """Check if Docker daemon is running."""
        return await self.invoke("check_docker_running")

    async def install_dependencies(self, names: list[str]) -> bool:
        """Install missing dependencies by name."""
        return await self.invoke("install_dependencies", {"names": names})

    async def install_dependency(self, name: str) -> str:
        """Install a single dependency by name."""
        return await self.invoke("install_dependency", {"name": name})

    async def install_brew(self) -> str:
        """Install Homebrew (macOS only)."""
        return await self.invoke("install_brew")

    async def check_brew_installed(self) -> bool:
        """Check if Homebrew is installed."""
        return await self.invoke("check_brew_installed")

    async def check_command_line_tools_installed(self) -> bool:
        """Check if Xcode Command Line Tools are installed."""
        return await self.invoke("check_command_line_tools_installed")

    # -------------------------------------------------------------------------
    # SyftBox Control Plane
    # -------------------------------------------------------------------------

    async def check_syftbox_auth(self) -> dict:
        """Check SyftBox authentication status."""
        return await self.invoke("check_syftbox_auth")

    async def get_syftbox_state(self) -> dict:
        """Get current SyftBox daemon state."""
        return await self.invoke("get_syftbox_state")

    async def start_syftbox_client(self) -> dict:
        """Start the SyftBox daemon."""
        return await self.invoke("start_syftbox_client")

    async def stop_syftbox_client(self) -> dict:
        """Stop the SyftBox daemon."""
        return await self.invoke("stop_syftbox_client")

    async def get_syftbox_config_info(self) -> dict:
        """Get SyftBox configuration information."""
        return await self.invoke("get_syftbox_config_info")

    async def trigger_syftbox_sync(self):
        """Trigger an immediate SyftBox sync."""
        return await self.invoke("trigger_syftbox_sync")

    async def syftbox_upload_action(self, id: str, action: str):
        """Perform an action on a queued upload (retry, skip, cancel)."""
        return await self.invoke("syftbox_upload_action", {"id": id, "action": action})

    async def syftbox_request_otp(self, email: str, server_url: Optional[str] = None):
        """Request an OTP code for SyftBox authentication."""
        args = {"email": email}
        if server_url:
            args["serverUrl"] = server_url
        return await self.invoke("syftbox_request_otp", args)

    async def syftbox_submit_otp(self, email: str, otp: str, server_url: Optional[str] = None):
        """Submit OTP code to complete SyftBox authentication."""
        args = {"email": email, "otp": otp}
        if server_url:
            args["serverUrl"] = server_url
        return await self.invoke("syftbox_submit_otp", args)

    async def get_syftbox_diagnostics(self) -> dict:
        """Get SyftBox diagnostic information."""
        return await self.invoke("get_syftbox_diagnostics")

    # -------------------------------------------------------------------------
    # Keys & Crypto
    # -------------------------------------------------------------------------

    async def key_get_status(self, email: Optional[str] = None) -> dict:
        """Get cryptographic key status."""
        args = {}
        if email:
            args["email"] = email
        return await self.invoke("key_get_status", args)

    async def key_generate(self, email: Optional[str] = None, force: bool = False) -> dict:
        """Generate a new cryptographic identity."""
        args = {"force": force}
        if email:
            args["email"] = email
        return await self.invoke("key_generate", args)

    async def key_restore(self, email: str, mnemonic: str) -> dict:
        """Restore identity from mnemonic."""
        return await self.invoke("key_restore", {"email": email, "mnemonic": mnemonic})

    async def key_list_contacts(self, current_email: Optional[str] = None) -> list:
        """List saved contacts."""
        args = {}
        if current_email:
            args["currentEmail"] = current_email
        return await self.invoke("key_list_contacts", args)

    # -------------------------------------------------------------------------
    # Messages
    # -------------------------------------------------------------------------

    async def sync_messages(self) -> dict:
        """Sync all messages."""
        return await self.invoke("sync_messages")

    async def list_message_threads(self, scope: Optional[str] = None, limit: Optional[int] = None) -> list:
        """List message threads."""
        args = {}
        if scope:
            args["scope"] = scope
        if limit:
            args["limit"] = limit
        return await self.invoke("list_message_threads", args)

    async def get_thread_messages(self, thread_id: str) -> list:
        """Get messages in a thread."""
        return await self.invoke("get_thread_messages", {"threadId": thread_id})

    async def send_message(self, to: str, body: str, subject: Optional[str] = None) -> dict:
        """Send a new message."""
        request = {"to": to, "body": body}
        if subject:
            request["subject"] = subject
        return await self.invoke("send_message", {"request": request})

    # -------------------------------------------------------------------------
    # Projects
    # -------------------------------------------------------------------------

    async def get_projects(self) -> list:
        """List all projects."""
        return await self.invoke("get_projects")

    async def create_project(
        self,
        name: str,
        example: Optional[str] = None,
        directory: Optional[str] = None,
        create_python_script: bool = False,
        script_name: Optional[str] = None,
    ) -> dict:
        """Create a new project."""
        args = {"name": name}
        if example:
            args["example"] = example
        if directory:
            args["directory"] = directory
        if create_python_script:
            args["createPythonScript"] = True
        if script_name:
            args["scriptName"] = script_name
        return await self.invoke("create_project", args)

    # -------------------------------------------------------------------------
    # Pipelines
    # -------------------------------------------------------------------------

    async def get_pipelines(self) -> list:
        """List all pipelines."""
        return await self.invoke("get_pipelines")

    async def run_pipeline(
        self,
        pipeline_id: int,
        input_overrides: Optional[dict] = None,
        results_dir: Optional[str] = None,
    ) -> dict:
        """Execute a pipeline."""
        args = {"pipelineId": pipeline_id}
        if input_overrides:
            args["inputOverrides"] = input_overrides
        if results_dir:
            args["resultsDir"] = results_dir
        return await self.invoke("run_pipeline", args)

    async def get_pipeline_runs(self) -> list:
        """List pipeline runs."""
        return await self.invoke("get_pipeline_runs")

    # -------------------------------------------------------------------------
    # Datasets
    # -------------------------------------------------------------------------

    async def get_datasets(self) -> list:
        """List datasets with their assets."""
        return await self.invoke("get_datasets")

    async def publish_dataset(self, name: str, copy_mock: bool = False):
        """Publish a dataset to the network."""
        return await self.invoke("publish_dataset", {"name": name, "copyMock": copy_mock})

    async def unpublish_dataset(self, name: str):
        """Remove a dataset from public access."""
        return await self.invoke("unpublish_dataset", {"name": name})

    async def delete_dataset(self, name: str) -> dict:
        """Delete a dataset."""
        return await self.invoke("delete_dataset", {"name": name})

    # -------------------------------------------------------------------------
    # Runs
    # -------------------------------------------------------------------------

    async def get_runs(self) -> list:
        """List all analysis runs."""
        return await self.invoke("get_runs")

    async def delete_run(self, run_id: int):
        """Delete an analysis run."""
        return await self.invoke("delete_run", {"runId": run_id})

    async def get_run_logs(self, run_id: int) -> str:
        """Get logs for a run."""
        return await self.invoke("get_run_logs", {"runId": run_id})

    async def get_run_logs_tail(self, run_id: int, lines: int = 100) -> str:
        """Get the last N lines of run logs."""
        return await self.invoke("get_run_logs_tail", {"runId": run_id, "lines": lines})

    async def get_run_logs_full(self, run_id: int) -> str:
        """Get full run logs without truncation."""
        return await self.invoke("get_run_logs_full", {"runId": run_id})

    # -------------------------------------------------------------------------
    # Sessions
    # -------------------------------------------------------------------------

    async def get_sessions(self) -> list:
        """List all sessions."""
        return await self.invoke("get_sessions")

    async def create_session(self, name: str, peer: Optional[str] = None, description: Optional[str] = None) -> dict:
        """Create a new collaborative session."""
        request = {"name": name}
        if peer:
            request["peer"] = peer
        if description:
            request["description"] = description
        return await self.invoke("create_session", {"request": request})

    async def accept_session_invitation(self, session_id: str) -> dict:
        """Accept a session invitation."""
        return await self.invoke("accept_session_invitation", {"sessionId": session_id})

    async def reject_session_invitation(self, session_id: str, reason: Optional[str] = None):
        """Reject a session invitation."""
        args = {"sessionId": session_id}
        if reason:
            args["reason"] = reason
        return await self.invoke("reject_session_invitation", args)

    async def get_session(self, session_id: str) -> dict:
        """Get details of a specific session."""
        return await self.invoke("get_session", {"sessionId": session_id})

    async def delete_session(self, session_id: str):
        """Delete a session."""
        return await self.invoke("delete_session", {"sessionId": session_id})

    async def add_dataset_to_session(self, session_id: str, dataset_name: str, role: Optional[str] = None) -> dict:
        """Add a dataset to a session."""
        args = {"sessionId": session_id, "datasetName": dataset_name}
        if role:
            args["role"] = role
        return await self.invoke("add_dataset_to_session", args)

    async def remove_dataset_from_session(self, session_id: str, dataset_name: str):
        """Remove a dataset from a session."""
        return await self.invoke("remove_dataset_from_session", {
            "sessionId": session_id,
            "datasetName": dataset_name
        })

    # -------------------------------------------------------------------------
    # Jupyter
    # -------------------------------------------------------------------------

    async def get_jupyter_status(self, project_path: str) -> dict:
        """Get Jupyter status for a project."""
        return await self.invoke("get_jupyter_status", {"projectPath": project_path})

    async def launch_jupyter(self, project_path: str, python_version: Optional[str] = None) -> dict:
        """Launch Jupyter for a project."""
        args = {"projectPath": project_path}
        if python_version:
            args["pythonVersion"] = python_version
        return await self.invoke("launch_jupyter", args)

    async def stop_jupyter(self, project_path: str) -> dict:
        """Stop Jupyter for a project."""
        return await self.invoke("stop_jupyter", {"projectPath": project_path})

    async def reset_jupyter(self, project_path: str, python_version: Optional[str] = None) -> dict:
        """Reset Jupyter environment for a project."""
        args = {"projectPath": project_path}
        if python_version:
            args["pythonVersion"] = python_version
        return await self.invoke("reset_jupyter", args)

    # -------------------------------------------------------------------------
    # Session Jupyter
    # -------------------------------------------------------------------------

    async def get_session_jupyter_status(self, session_id: str) -> dict:
        """Get Jupyter status for a session."""
        return await self.invoke("get_session_jupyter_status", {"sessionId": session_id})

    async def launch_session_jupyter(
        self,
        session_id: str,
        python_version: Optional[str] = None,
        copy_examples: bool = False,
        on_event: Optional[EventCallback] = None,
    ) -> dict:
        """
        Launch Jupyter for a session.

        Args:
            session_id: Session ID
            python_version: Optional Python version
            copy_examples: Whether to copy example notebooks
            on_event: Optional callback for progress events
        """
        args = {"sessionId": session_id}
        if python_version:
            args["pythonVersion"] = python_version
        if copy_examples:
            args["copyExamples"] = True

        if on_event:
            return await self.invoke_with_events("launch_session_jupyter", args, on_event=on_event)
        return await self.invoke("launch_session_jupyter", args)

    async def stop_session_jupyter(self, session_id: str) -> dict:
        """Stop Jupyter for a session."""
        return await self.invoke("stop_session_jupyter", {"sessionId": session_id})

    async def reset_session_jupyter(
        self,
        session_id: str,
        python_version: Optional[str] = None,
        on_event: Optional[EventCallback] = None,
    ) -> dict:
        """Reset Jupyter environment for a session."""
        args = {"sessionId": session_id}
        if python_version:
            args["pythonVersion"] = python_version

        if on_event:
            return await self.invoke_with_events("reset_session_jupyter", args, on_event=on_event)
        return await self.invoke("reset_session_jupyter", args)

    # -------------------------------------------------------------------------
    # Logs & Diagnostics
    # -------------------------------------------------------------------------

    async def get_command_logs(self) -> list:
        """Get command execution logs."""
        return await self.invoke("get_command_logs")

    async def get_desktop_log_text(self, max_bytes: Optional[int] = None) -> str:
        """Get desktop log contents."""
        args = {}
        if max_bytes:
            args["maxBytes"] = max_bytes
        return await self.invoke("get_desktop_log_text", args)

    async def get_desktop_log_dir(self) -> str:
        """Get desktop log directory path."""
        return await self.invoke("get_desktop_log_dir")

    async def clear_desktop_log(self):
        """Clear the desktop log file."""
        return await self.invoke("clear_desktop_log")

    async def clear_command_logs(self):
        """Clear command execution logs."""
        return await self.invoke("clear_command_logs")

    # -------------------------------------------------------------------------
    # Settings
    # -------------------------------------------------------------------------

    async def get_settings(self) -> dict:
        """Get all application settings."""
        return await self.invoke("get_settings")

    async def save_settings(self, settings: dict):
        """Save application settings."""
        return await self.invoke("save_settings", {"settings": settings})

    async def set_autostart_enabled(self, enabled: bool):
        """Enable or disable app autostart on login."""
        return await self.invoke("set_autostart_enabled", {"enabled": enabled})

    async def get_autostart_enabled(self) -> bool:
        """Check if app autostarts on login."""
        return await self.invoke("get_autostart_enabled")

    # -------------------------------------------------------------------------
    # SQL
    # -------------------------------------------------------------------------

    async def sql_list_tables(self) -> list:
        """List database tables."""
        return await self.invoke("sql_list_tables")

    async def sql_get_table_schema(self, table: str) -> list:
        """Get schema for a table."""
        return await self.invoke("sql_get_table_schema", {"table": table})

    async def sql_run_query(self, query: str, limit: Optional[int] = None) -> dict:
        """Execute a SQL query."""
        args = {"query": query}
        if limit:
            args["options"] = {"limit": limit}
        return await self.invoke("sql_run_query", args)

    # -------------------------------------------------------------------------
    # Data Reset (Destructive)
    # -------------------------------------------------------------------------

    async def reset_all_data(self):
        """Reset all application data (preserves SyftBox)."""
        return await self.invoke("reset_all_data")

    async def reset_everything(self):
        """Reset all data including SyftBox."""
        return await self.invoke("reset_everything")

    # -------------------------------------------------------------------------
    # Files & Participants
    # -------------------------------------------------------------------------

    async def get_files(self) -> list:
        """Get all imported files."""
        return await self.invoke("get_files")

    async def get_participants(self) -> list:
        """Get all participants."""
        return await self.invoke("get_participants")

    async def get_extensions(self, path: str) -> list:
        """Get file extensions from a directory."""
        return await self.invoke("get_extensions", {"path": path})

    async def detect_file_types(self, files: list) -> list:
        """Detect file types for a list of files."""
        return await self.invoke("detect_file_types", {"files": files})

    async def import_files_pending(self, file_metadata: list) -> dict:
        """Import pending files with metadata."""
        return await self.invoke("import_files_pending", {"fileMetadata": file_metadata})

    async def open_folder(self, path: str):
        """Open a folder in the system file explorer."""
        return await self.invoke("open_folder", {"path": path})

    # -------------------------------------------------------------------------
    # Network
    # -------------------------------------------------------------------------

    async def network_import_contact(self, identity: str):
        """Import a contact identity."""
        return await self.invoke("network_import_contact", {"identity": identity})

    async def network_scan_datasites(self) -> list:
        """Scan available datasites."""
        return await self.invoke("network_scan_datasites")

    async def network_scan_datasets(self) -> list:
        """Scan datasets on datasites."""
        return await self.invoke("network_scan_datasets")

    # -------------------------------------------------------------------------
    # Additional Pipeline Methods
    # -------------------------------------------------------------------------

    async def import_pipeline_with_deps(
        self,
        url: str,
        name_override: Optional[str] = None,
        overwrite: bool = False,
        on_event: Optional[EventCallback] = None,
    ) -> dict:
        """Import a pipeline with dependencies."""
        args = {"url": url, "overwrite": overwrite}
        if name_override:
            args["nameOverride"] = name_override

        if on_event:
            return await self.invoke_with_events("import_pipeline_with_deps", args, on_event=on_event)
        return await self.invoke("import_pipeline_with_deps", args)

    async def get_runs_base_dir(self) -> str:
        """Get the base directory for pipeline runs."""
        return await self.invoke("get_runs_base_dir")

    async def send_pipeline_request(
        self,
        pipeline_name: str,
        pipeline_version: str,
        dataset_name: str,
        recipient: str,
        message: Optional[str] = None,
    ) -> dict:
        """Send a pipeline execution request to a peer."""
        args = {
            "pipelineName": pipeline_name,
            "pipelineVersion": pipeline_version,
            "datasetName": dataset_name,
            "recipient": recipient,
        }
        if message:
            args["message"] = message
        return await self.invoke("send_pipeline_request", args)

    # -------------------------------------------------------------------------
    # Additional Dataset Methods
    # -------------------------------------------------------------------------

    async def list_datasets_with_assets(self) -> list:
        """List datasets with their asset details."""
        return await self.invoke("list_datasets_with_assets")

    async def is_dataset_published(self, name: str) -> bool:
        """Check if a dataset is published."""
        return await self.invoke("is_dataset_published", {"name": name})

    async def get_datasets_folder_path(self) -> str:
        """Get the datasets folder path."""
        return await self.invoke("get_datasets_folder_path")

    async def resolve_syft_url_to_local_path(self, syft_url: str) -> Optional[str]:
        """Resolve a SyftBox URL to a local file path."""
        return await self.invoke("resolve_syft_url_to_local_path", {"syftUrl": syft_url})

    async def resolve_syft_urls_batch(self, urls: list) -> dict:
        """Resolve multiple SyftBox URLs to local paths."""
        return await self.invoke("resolve_syft_urls_batch", {"urls": urls})

    # -------------------------------------------------------------------------
    # Additional Session Methods
    # -------------------------------------------------------------------------

    async def get_session_invitations(self) -> list:
        """Get pending session invitations."""
        return await self.invoke("get_session_invitations")

    async def send_session_chat_message(self, session_id: str, body: str) -> dict:
        """Send a chat message in a session."""
        return await self.invoke("send_session_chat_message", {"sessionId": session_id, "body": body})

    async def get_session_chat_messages(self, session_id: str) -> list:
        """Get chat messages for a session."""
        return await self.invoke("get_session_chat_messages", {"sessionId": session_id})

    async def list_session_datasets(self, session_id: str) -> list:
        """List datasets in a session."""
        return await self.invoke("list_session_datasets", {"sessionId": session_id})

    # -------------------------------------------------------------------------
    # Additional SyftBox Methods
    # -------------------------------------------------------------------------

    async def syftbox_queue_status(self) -> dict:
        """Get SyftBox upload queue status."""
        return await self.invoke("syftbox_queue_status")

    async def get_default_syftbox_server_url(self) -> str:
        """Get the default SyftBox server URL."""
        return await self.invoke("get_default_syftbox_server_url")

    async def is_dev_syftbox_enabled(self) -> bool:
        """Check if dev SyftBox mode is enabled."""
        return await self.invoke("is_dev_syftbox_enabled")

    # -------------------------------------------------------------------------
    # Additional Key Methods
    # -------------------------------------------------------------------------

    async def key_check_contact(self, email: str) -> dict:
        """Check if a contact exists."""
        return await self.invoke("key_check_contact", {"email": email})

    # -------------------------------------------------------------------------
    # Additional Message Methods
    # -------------------------------------------------------------------------

    async def sync_messages_with_failures(self) -> dict:
        """Sync messages with failure tracking."""
        return await self.invoke("sync_messages_with_failures")

    async def count_failed_messages(self) -> int:
        """Count failed message operations."""
        return await self.invoke("count_failed_messages")

    async def list_failed_messages(self, include_dismissed: bool = False) -> list:
        """List failed message operations."""
        return await self.invoke("list_failed_messages", {"includeDismissed": include_dismissed})

    async def mark_thread_as_read(self, thread_id: str):
        """Mark a thread as read."""
        return await self.invoke("mark_thread_as_read", {"threadId": thread_id})

    async def delete_message(self, message_id: str):
        """Delete a message."""
        return await self.invoke("delete_message", {"messageId": message_id})

    async def delete_thread(self, thread_id: str):
        """Delete a thread."""
        return await self.invoke("delete_thread", {"threadId": thread_id})


# -------------------------------------------------------------------------
# Example/Demo Code
# -------------------------------------------------------------------------

async def demo():
    """Demo script showing basic usage."""
    print("BioVault Agent Demo")
    print("=" * 50)

    async with BioVaultAgent() as agent:
        # Discover API
        print("\n1. Discovering API...")
        api_info = await agent.discover()
        print(f"   API Version: {api_info['version']}")
        print(f"   Auth Required: {api_info['auth']['required']}")

        # Get app version
        print("\n2. Getting app version...")
        version = await agent.get_app_version()
        print(f"   Version: {version}")

        # Check onboarding status
        print("\n3. Checking onboarding status...")
        is_onboarded = await agent.check_is_onboarded()
        print(f"   Onboarded: {is_onboarded}")

        # Check SyftBox status
        print("\n4. Checking SyftBox status...")
        syftbox_state = await agent.get_syftbox_state()
        print(f"   Running: {syftbox_state.get('running')}")
        print(f"   Mode: {syftbox_state.get('mode')}")

        # List projects
        print("\n5. Listing projects...")
        projects = await agent.get_projects()
        if projects:
            for p in projects[:5]:  # Show first 5
                print(f"   - {p.get('name', 'Unknown')}")
        else:
            print("   No projects found")

        # Get audit log
        print("\n6. Getting recent audit log...")
        audit_log = await agent.get_audit_log(max_entries=5)
        print(f"   Recent entries: {len(audit_log)}")

    print("\n" + "=" * 50)
    print("Demo complete!")


if __name__ == "__main__":
    asyncio.run(demo())
