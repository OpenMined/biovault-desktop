// WebSocket bridge for browser development and AI agent control
// This allows Chrome browsers and AI agents to call Tauri commands via WebSocket
//
// ## Security Model
// - Binds to localhost only (127.0.0.1)
// - Optional token authentication via settings or environment
// - All commands are logged for audit purposes
//
// ## Environment Variables
// - DEV_WS_BRIDGE: Enable/disable the bridge ("0", "false", "no" to disable)
// - DEV_WS_BRIDGE_DISABLE: Force disable ("1", "true", "yes" to disable)
// - DEV_WS_BRIDGE_PORT: WebSocket server port (default: 3333)
// - DEV_WS_BRIDGE_HTTP_PORT: HTTP fallback port (default: 3334)
// - AGENT_BRIDGE_TOKEN: Authentication token (overrides settings)

use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use tracing::{info_span, Instrument};

#[derive(Deserialize)]
struct WsRequest {
    id: u32,
    cmd: String,
    #[serde(default)]
    args: Value,
    /// Optional authentication token
    #[serde(default)]
    token: Option<String>,
}

#[derive(Deserialize)]
struct HttpRpcRequest {
    id: u32,
    cmd: String,
    #[serde(default)]
    args: Value,
    #[serde(default)]
    token: Option<String>,
}

#[derive(Serialize)]
struct WsResponse {
    id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct BridgeTask {
    shutdown: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
    port: u16,
}

#[derive(Default)]
struct BridgeManager {
    ws: Option<BridgeTask>,
    http: Option<BridgeTask>,
}

impl BridgeManager {
    fn stop_all(&mut self) {
        if let Some(task) = self.ws.take() {
            let _ = task.shutdown.send(true);
            task.handle.abort();
            crate::desktop_log!("🛑 Stopped WebSocket bridge on port {}", task.port);
        }
        if let Some(task) = self.http.take() {
            let _ = task.shutdown.send(true);
            task.handle.abort();
            crate::desktop_log!("🛑 Stopped HTTP bridge on port {}", task.port);
        }
    }
}

static BRIDGE_MANAGER: Lazy<Mutex<BridgeManager>> =
    Lazy::new(|| Mutex::new(BridgeManager::default()));

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

/// Audit log entry for agent bridge commands
#[derive(Serialize)]
struct AuditLogEntry {
    timestamp: String,
    request_id: u32,
    cmd: String,
    args_size: usize,
    duration_ms: u64,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    peer_addr: String,
}

/// Get the configured authentication token (env var takes precedence over settings)
fn get_auth_token() -> Option<String> {
    // Check environment variable first
    if let Ok(token) = std::env::var("AGENT_BRIDGE_TOKEN") {
        if !token.is_empty() {
            return Some(token);
        }
    }

    // Fall back to settings
    if let Ok(settings) = crate::get_settings() {
        return settings
            .agent_bridge_token
            .filter(|token| !token.is_empty());
    }

    None
}

/// Validate an authentication token against the configured token
fn auth_error_message(provided: Option<&str>) -> Option<String> {
    match get_auth_token() {
        Some(expected) => match provided {
            Some(p) if p == expected => None,
            Some(_) => Some("Authentication failed: invalid token".to_string()),
            None => Some("Authentication failed: missing token".to_string()),
        },
        None => None,
    }
}

/// Check whether the agent bridge is enabled in settings
fn is_bridge_enabled() -> bool {
    crate::get_settings()
        .map(|settings| settings.agent_bridge_enabled)
        .unwrap_or(true)
}

/// Check whether a command is blocked by agent policy
fn is_command_blocked(cmd: &str) -> bool {
    crate::get_settings()
        .map(|settings| {
            settings
                .agent_bridge_blocklist
                .iter()
                .any(|blocked| blocked == cmd)
        })
        .unwrap_or(false)
}

/// Command metadata for the list_commands endpoint
#[derive(Serialize)]
struct CommandInfo {
    name: &'static str,
    category: &'static str,
    #[serde(rename = "readOnly")]
    read_only: bool,
    #[serde(rename = "async", skip_serializing_if = "std::ops::Not::not")]
    is_async: bool,
    #[serde(rename = "longRunning", skip_serializing_if = "std::ops::Not::not")]
    long_running: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    dangerous: bool,
    /// Whether this command emits streaming events (for long-running operations)
    #[serde(rename = "emitsEvents", skip_serializing_if = "std::ops::Not::not")]
    emits_events: bool,
}

/// Helper to create command info
const fn cmd(name: &'static str, category: &'static str, read_only: bool) -> CommandInfo {
    CommandInfo {
        name,
        category,
        read_only,
        is_async: false,
        long_running: false,
        dangerous: false,
        emits_events: false,
    }
}

const fn cmd_async(name: &'static str, category: &'static str, read_only: bool) -> CommandInfo {
    CommandInfo {
        name,
        category,
        read_only,
        is_async: true,
        long_running: false,
        dangerous: false,
        emits_events: false,
    }
}

const fn cmd_long(name: &'static str, category: &'static str, read_only: bool) -> CommandInfo {
    CommandInfo {
        name,
        category,
        read_only,
        is_async: true,
        long_running: true,
        dangerous: false,
        emits_events: true,
    }
}

const fn cmd_danger(name: &'static str, category: &'static str) -> CommandInfo {
    CommandInfo {
        name,
        category,
        read_only: false,
        is_async: false,
        long_running: false,
        dangerous: true,
        emits_events: false,
    }
}

/// Get a structured list of all available commands
fn get_commands_list() -> serde_json::Value {
    let commands: Vec<CommandInfo> = vec![
        // Agent API
        cmd("agent_api_discover", "agent_api", true),
        cmd("agent_api_get_audit_log", "agent_api", true),
        cmd("agent_api_clear_audit_log", "agent_api", false),
        cmd("agent_api_get_schema", "agent_api", true),
        cmd("agent_api_list_commands", "agent_api", true),
        cmd("get_agent_api_commands", "agent_api", true),
        cmd("agent_api_events_info", "agent_api", true),
        // App Status
        cmd("get_app_version", "app_status", true),
        cmd("is_dev_mode", "app_status", true),
        cmd("get_dev_mode_info", "app_status", true),
        cmd("get_env_var", "app_status", true),
        cmd("get_config_path", "app_status", true),
        cmd("get_database_path", "app_status", true),
        cmd("get_settings", "settings", true),
        cmd("save_settings", "settings", false),
        cmd("set_autostart_enabled", "settings", false),
        cmd("get_autostart_enabled", "app_status", true),
        // UI Control
        cmd("ui_navigate", "ui", false),
        cmd("ui_flow_import_options", "ui", false),
        cmd("ui_flow_import_from_path", "ui", false),
        // Onboarding
        cmd("check_is_onboarded", "onboarding", true),
        cmd_async("complete_onboarding", "onboarding", false),
        // Profiles
        cmd("profiles_get_boot_state", "profiles", true),
        cmd("profiles_get_default_home", "profiles", true),
        cmd("profiles_open_new_instance", "profiles", false),
        cmd("profiles_switch", "profiles", false),
        cmd("profiles_switch_in_place", "profiles", false),
        cmd("profiles_open_picker", "profiles", false),
        cmd("profiles_quit_picker", "profiles", false),
        cmd("profiles_check_home_for_existing_email", "profiles", true),
        cmd("profiles_create_with_home_and_switch", "profiles", false),
        cmd("profiles_create_and_switch_in_place", "profiles", false),
        cmd("profiles_move_home", "profiles", false),
        cmd("profiles_delete_profile", "profiles", false),
        cmd("profiles_create_and_switch", "profiles", false),
        // Dependencies
        cmd_async("check_dependencies", "dependencies", true),
        cmd_async("check_single_dependency", "dependencies", true),
        cmd_long("install_dependencies", "dependencies", false),
        cmd("update_saved_dependency_states", "dependencies", false),
        cmd("get_saved_dependency_states", "dependencies", true),
        cmd_async("check_docker_running", "dependencies", true),
        cmd_long("install_dependency", "dependencies", false),
        cmd_long("install_brew", "dependencies", false),
        cmd_long("install_command_line_tools", "dependencies", false),
        cmd("check_brew_installed", "dependencies", true),
        cmd("check_command_line_tools_installed", "dependencies", true),
        // SyftBox
        cmd("check_syftbox_auth", "syftbox", true),
        cmd("get_syftbox_state", "syftbox", true),
        cmd("start_syftbox_client", "syftbox", false),
        cmd("stop_syftbox_client", "syftbox", false),
        cmd("get_syftbox_config_info", "syftbox", true),
        cmd("get_default_syftbox_server_url", "syftbox", true),
        cmd("is_dev_syftbox_enabled", "syftbox", true),
        cmd_async("check_dev_syftbox_server", "syftbox", true),
        cmd_async("trigger_syftbox_sync", "syftbox", false),
        cmd_async("syftbox_queue_status", "syftbox", true),
        cmd("get_syftbox_diagnostics", "syftbox", true),
        cmd("test_turn_connection", "syftbox", true),
        cmd("test_peer_link", "syftbox", false),
        cmd_async("syftbox_subscriptions_discovery", "syftbox", true),
        cmd_long("syftbox_upload_action", "syftbox", false),
        cmd_async("syftbox_request_otp", "syftbox", false),
        cmd_async("syftbox_submit_otp", "syftbox", false),
        // Sync Tree
        cmd_async("sync_tree_list_dir", "sync_tree", true),
        cmd_async("sync_tree_get_details", "sync_tree", true),
        cmd_async("sync_tree_get_ignore_patterns", "sync_tree", true),
        cmd_async("sync_tree_add_ignore", "sync_tree", false),
        cmd_async("sync_tree_remove_ignore", "sync_tree", false),
        cmd_async("sync_tree_init_default_policy", "sync_tree", false),
        cmd_async("sync_tree_get_shared_with_me", "sync_tree", true),
        cmd_async("sync_tree_subscribe", "sync_tree", false),
        cmd_async("sync_tree_unsubscribe", "sync_tree", false),
        cmd_async("sync_tree_set_subscription", "sync_tree", false),
        // Keys
        cmd("key_get_status", "keys", true),
        cmd("key_list_contacts", "keys", true),
        cmd_async("key_generate", "keys", false),
        cmd_async("key_restore", "keys", false),
        cmd("key_check_contact", "keys", true),
        cmd("key_check_vault_debug", "keys", true),
        cmd("key_republish", "keys", false),
        cmd_async("key_refresh_contacts", "keys", false),
        // Network
        cmd("network_import_contact", "network", false),
        cmd("network_remove_contact", "network", false),
        cmd("network_trust_changed_key", "network", false),
        cmd("network_scan_datasites", "network", true),
        cmd("network_scan_datasets", "network", true),
        // Messages
        cmd_long("sync_messages", "messages", false),
        cmd_long("sync_messages_with_failures", "messages", false),
        cmd_long("refresh_messages_batched", "messages", false),
        cmd("list_message_threads", "messages", true),
        cmd("list_spaces", "messages", true),
        cmd("get_thread_messages", "messages", true),
        cmd("get_contact_timeline", "messages", true),
        cmd("send_message", "messages", false),
        cmd("mark_thread_as_read", "messages", false),
        cmd("delete_message", "messages", false),
        cmd("delete_thread", "messages", false),
        cmd("count_failed_messages", "messages", true),
        cmd("list_failed_messages", "messages", true),
        cmd("dismiss_failed_message", "messages", false),
        cmd("delete_failed_message", "messages", false),
        // Modules
        cmd("get_modules", "modules", true),
        cmd("get_available_module_examples", "modules", true),
        cmd("get_default_module_path", "modules", true),
        cmd("create_module", "modules", false),
        cmd("import_module", "modules", false),
        cmd("import_module_from_folder", "modules", false),
        cmd("delete_module", "modules", false),
        cmd("delete_module_folder", "modules", false),
        cmd("load_module_editor", "modules", true),
        cmd("save_module_editor", "modules", false),
        cmd("preview_module_spec", "modules", true),
        cmd("get_module_spec_digest", "modules", true),
        cmd("get_supported_input_types", "modules", true),
        cmd("get_supported_output_types", "modules", true),
        cmd("get_supported_parameter_types", "modules", true),
        cmd("get_common_formats", "modules", true),
        cmd("get_local_flow_templates", "modules", true),
        // Flows
        cmd_async("get_flows", "flows", true),
        cmd_async("create_flow", "flows", false),
        cmd_async("import_flow", "flows", false),
        cmd_async("import_flow_from_message", "flows", false),
        cmd_async("import_flow_from_request", "flows", false),
        cmd_async("import_flow_from_json", "flows", false),
        cmd_long("import_flow_with_deps", "flows", false),
        cmd_long("run_flow", "flows", false),
        cmd_async("get_flow_runs", "flows", true),
        cmd_async("get_runs_base_dir", "flows", true),
        cmd_async("load_flow_editor", "flows", true),
        cmd_async("save_flow_editor", "flows", false),
        cmd_async("save_flow_yaml", "flows", false),
        cmd_async("delete_flow", "flows", false),
        cmd_async("validate_flow", "flows", true),
        cmd_async("delete_flow_run", "flows", false),
        cmd_async("preview_flow_spec", "flows", true),
        cmd_async("save_run_config", "flows", false),
        cmd_async("list_run_configs", "flows", true),
        cmd_async("get_run_config", "flows", true),
        cmd_async("delete_run_config", "flows", false),
        cmd("send_flow_request", "flows", false),
        cmd("send_flow_request_results", "flows", false),
        cmd("send_flow_results", "flows", false),
        cmd("import_flow_results", "flows", false),
        cmd("list_results_tree", "flows", true),
        // Datasets
        cmd("get_datasets", "datasets", true),
        cmd("list_datasets_with_assets", "datasets", true),
        cmd_async("save_dataset_with_files", "datasets", false),
        cmd("upsert_dataset_manifest", "datasets", false),
        cmd("is_dataset_published", "datasets", true),
        cmd("delete_dataset", "datasets", false),
        cmd_async("publish_dataset", "datasets", false),
        cmd("unpublish_dataset", "datasets", false),
        cmd("get_datasets_folder_path", "datasets", true),
        cmd("resolve_dataset_path", "datasets", true),
        cmd("resolve_syft_url_to_local_path", "datasets", true),
        cmd("resolve_syft_urls_batch", "datasets", true),
        cmd("subscribe_dataset", "datasets", false),
        cmd("unsubscribe_dataset", "datasets", false),
        // Files
        cmd("get_files", "files", true),
        cmd("list_files", "files", true),
        cmd("get_participants", "participants", true),
        cmd("get_extensions", "files", true),
        cmd("search_txt_files", "files", true),
        cmd_async("fetch_reference_data", "files", false),
        cmd_async("fetch_reference_data_with_progress", "files", false),
        cmd("suggest_patterns", "files", true),
        cmd("extract_ids_for_files", "files", true),
        cmd_async("detect_file_types", "files", true),
        cmd_async("analyze_file_types", "files", true),
        cmd_async("fetch_sample_data", "files", false),
        cmd_async("fetch_sample_data_with_progress", "files", false),
        cmd_async("import_files_pending", "files", false),
        cmd_async("import_files", "files", false),
        cmd_async("import_files_with_metadata", "files", false),
        cmd("is_directory", "files", true),
        cmd("delete_file", "files", false),
        cmd("delete_files_bulk", "files", false),
        cmd_async("process_queue", "files", false),
        cmd("pause_queue_processor", "files", false),
        cmd("resume_queue_processor", "files", false),
        cmd("clear_pending_queue", "files", false),
        cmd("open_folder", "files", false),
        // Participants
        cmd("delete_participant", "participants", false),
        cmd("delete_participants_bulk", "participants", false),
        // Runs
        cmd("get_runs", "runs", true),
        cmd("delete_run", "runs", false),
        cmd("get_run_logs", "runs", true),
        cmd("get_run_logs_tail", "runs", true),
        cmd("get_run_logs_full", "runs", true),
        cmd("get_flow_run_logs", "flows", true),
        cmd("get_flow_run_logs_tail", "flows", true),
        cmd("get_flow_run_logs_full", "flows", true),
        cmd("get_container_count", "flows", true),
        cmd("get_flow_state", "flows", true),
        cmd("save_flow_state_cmd", "flows", true),
        cmd("reconcile_flow_runs", "flows", true),
        cmd("pause_flow_run", "flows", true),
        cmd("resume_flow_run", "flows", true),
        cmd("cleanup_flow_run_state", "flows", true),
        cmd("get_flow_run_work_dir", "flows", true),
        cmd("path_exists", "flows", true),
        cmd("start_analysis", "runs", false),
        cmd_async("execute_analysis", "runs", false),
        // Sessions
        cmd("get_sessions", "sessions", true),
        cmd("list_sessions", "sessions", true),
        cmd("get_session_invitations", "sessions", true),
        cmd("create_session", "sessions", false),
        cmd("create_session_with_datasets", "sessions", false),
        cmd("update_session_peer", "sessions", false),
        cmd("accept_session_invitation", "sessions", false),
        cmd("reject_session_invitation", "sessions", false),
        cmd("send_session_chat_message", "sessions", false),
        cmd("get_session_chat_messages", "sessions", true),
        cmd("get_session_messages", "sessions", true),
        cmd("send_session_message", "sessions", false),
        cmd("list_session_datasets", "sessions", true),
        cmd("get_session_beaver_summaries", "sessions", true),
        cmd("get_session", "sessions", true),
        cmd("delete_session", "sessions", false),
        cmd("add_dataset_to_session", "sessions", false),
        cmd("remove_dataset_from_session", "sessions", false),
        cmd("open_session_folder", "sessions", false),
        cmd("add_files_to_session", "sessions", false),
        // Session Jupyter
        cmd("get_session_jupyter_status", "session_jupyter", true),
        cmd_long("launch_session_jupyter", "session_jupyter", false),
        cmd_async("stop_session_jupyter", "session_jupyter", false),
        cmd_long("reset_session_jupyter", "session_jupyter", false),
        // Jupyter
        cmd("get_jupyter_status", "jupyter", true),
        cmd_long("launch_jupyter", "jupyter", false),
        cmd_async("stop_jupyter", "jupyter", false),
        cmd_long("reset_jupyter", "jupyter", false),
        // Logs
        cmd("get_command_logs", "logs", true),
        cmd("get_desktop_log_dir", "logs", true),
        cmd("get_desktop_log_text", "logs", true),
        cmd("clear_desktop_log", "logs", false),
        cmd("clear_command_logs", "logs", false),
        cmd("get_queue_info", "logs", true),
        cmd("get_queue_processor_status", "logs", true),
        // SQL
        cmd("sql_list_tables", "sql", true),
        cmd("sql_get_table_schema", "sql", true),
        cmd("sql_run_query", "sql", false),
        cmd("sql_export_query", "sql", false),
        // Data Reset
        cmd_danger("reset_all_data", "data_reset"),
        cmd_danger("reset_everything", "data_reset"),
    ];

    serde_json::json!({
        "version": "1.4.2",
        "commands": commands
    })
}

fn load_schema_json(app: &AppHandle) -> Result<Value, String> {
    let schema_content = if let Ok(resource_path) = app.path().resource_dir() {
        let schema_path = resource_path.join("docs").join("agent-api.json");
        std::fs::read_to_string(&schema_path).ok()
    } else {
        None
    };

    let schema_content =
        schema_content.or_else(|| std::fs::read_to_string("docs/agent-api.json").ok());

    match schema_content {
        Some(content) => serde_json::from_str::<Value>(&content)
            .map_err(|e| format!("Failed to parse schema: {}", e)),
        None => {
            let fallback = include_str!("../../docs/agent-api.json");
            serde_json::from_str::<Value>(fallback)
                .map_err(|e| format!("Failed to parse embedded schema: {}", e))
        }
    }
}

/// Get the path to the audit log file
fn get_audit_log_path() -> Option<PathBuf> {
    if let Ok(home) = biovault::config::get_biovault_home() {
        let logs_dir = home.join("logs");
        std::fs::create_dir_all(&logs_dir).ok()?;
        Some(logs_dir.join("agent_bridge_audit.jsonl"))
    } else {
        None
    }
}

/// Write an audit log entry
fn write_audit_log(entry: &AuditLogEntry) {
    if let Some(path) = get_audit_log_path() {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
            if let Ok(json) = serde_json::to_string(entry) {
                let _ = writeln!(file, "{}", json);
            }
        }
    }
}

async fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    const MAX_HEADER_BYTES: usize = 64 * 1024;
    const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
    let mut buffer = Vec::new();
    let mut temp = [0u8; 1024];
    let header_end = loop {
        let n = stream
            .read(&mut temp)
            .await
            .map_err(|e| format!("Failed to read request: {}", e))?;
        if n == 0 {
            return Err("Connection closed".to_string());
        }
        buffer.extend_from_slice(&temp[..n]);
        if buffer.len() > MAX_HEADER_BYTES {
            return Err("Request header too large".to_string());
        }
        if let Some(pos) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
    };

    let header_bytes = &buffer[..header_end];
    let mut body = buffer[header_end + 4..].to_vec();
    let header_text = String::from_utf8_lossy(header_bytes);
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().ok_or_else(|| "Empty request".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "Missing method".to_string())?
        .to_string();
    let path = request_parts
        .next()
        .ok_or_else(|| "Missing path".to_string())?
        .to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let content_length = headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_BODY_BYTES {
        return Err("Request body too large".to_string());
    }

    while body.len() < content_length {
        let n = stream
            .read(&mut temp)
            .await
            .map_err(|e| format!("Failed to read request body: {}", e))?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&temp[..n]);
        if body.len() > MAX_BODY_BYTES {
            return Err("Request body too large".to_string());
        }
    }

    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

async fn write_http_response(
    stream: &mut TcpStream,
    status: u16,
    status_text: &str,
    body: &[u8],
    content_type: &str,
) {
    let header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\n\r\n",
        status,
        status_text,
        content_type,
        body.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(body).await;
}

fn extract_bearer_token(headers: &HashMap<String, String>) -> Option<String> {
    headers.get("authorization").and_then(|value| {
        let trimmed = value.trim();
        trimmed
            .strip_prefix("Bearer ")
            .or_else(|| trimmed.strip_prefix("bearer "))
            .map(|token| token.trim().to_string())
    })
}

async fn handle_connection(stream: TcpStream, app: Arc<AppHandle>) {
    let addr = stream
        .peer_addr()
        .expect("connected streams should have a peer address");
    let addr_str = addr.to_string();
    crate::desktop_log!("🔌 WebSocket connection from: {}", addr);

    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            crate::desktop_log!("❌ WebSocket handshake error: {}", e);
            return;
        }
    };

    let (mut write, mut read) = ws_stream.split();

    // Writer task so long-running commands don't block reads.
    let (tx, mut rx) = mpsc::channel::<String>(256);
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if let Err(e) = write.send(Message::Text(text)).await {
                crate::desktop_log!("❌ WebSocket write error: {}", e);
                break;
            }
        }
    });

    while let Some(msg) = read.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                crate::desktop_log!("❌ WebSocket read error: {}", e);
                break;
            }
        };

        if !msg.is_text() {
            continue;
        }

        let text = msg.to_text().unwrap();
        let request: WsRequest = match serde_json::from_str(text) {
            Ok(r) => r,
            Err(e) => {
                crate::desktop_log!("❌ Failed to parse request: {}", e);
                continue;
            }
        };

        // Validate authentication token
        if let Some(error_message) = auth_error_message(request.token.as_deref()) {
            crate::desktop_log!("🔒 Auth failed for request {} from {}", request.id, addr);
            let ws_response = WsResponse {
                id: request.id,
                result: None,
                error: Some(error_message),
            };
            if let Ok(response_text) = serde_json::to_string(&ws_response) {
                let _ = tx.send(response_text).await;
            }
            continue;
        }

        crate::desktop_log!("📨 WS Request: {} (id: {})", request.cmd, request.id);

        // Execute each request concurrently so a slow command doesn't stall the bridge.
        let app = Arc::clone(&app);
        let tx = tx.clone();
        let cmd_name = request.cmd.clone();
        let args_size = request.args.to_string().len();
        let peer_addr = addr_str.clone();
        tokio::spawn(async move {
            let start = std::time::Instant::now();
            let span = info_span!("command", cmd = %cmd_name, request_id = request.id);
            let response = execute_command(&app, &request.cmd, request.args)
                .instrument(span)
                .await;
            let duration_ms = start.elapsed().as_millis() as u64;

            let (ws_response, success, error_msg) = match response {
                Ok(result) => (
                    WsResponse {
                        id: request.id,
                        result: Some(result),
                        error: None,
                    },
                    true,
                    None,
                ),
                Err(error) => (
                    WsResponse {
                        id: request.id,
                        result: None,
                        error: Some(error.clone()),
                    },
                    false,
                    Some(error),
                ),
            };

            // Write audit log entry
            let audit_entry = AuditLogEntry {
                timestamp: Utc::now().to_rfc3339(),
                request_id: request.id,
                cmd: cmd_name,
                args_size,
                duration_ms,
                success,
                error: error_msg,
                peer_addr,
            };
            write_audit_log(&audit_entry);

            if let Ok(response_text) = serde_json::to_string(&ws_response) {
                let _ = tx.send(response_text).await;
            }
        });
    }

    // Stop writer and drain.
    drop(tx);
    let _ = writer.await;

    crate::desktop_log!("🔌 WebSocket connection closed: {}", addr);
}

async fn handle_http_connection(mut stream: TcpStream, app: Arc<AppHandle>) {
    let peer_addr = stream
        .peer_addr()
        .map(|addr| addr.to_string())
        .unwrap_or_else(|_| "<unknown>".to_string());

    let request = match read_http_request(&mut stream).await {
        Ok(req) => req,
        Err(error) => {
            let body = serde_json::json!({ "error": error }).to_string();
            write_http_response(
                &mut stream,
                400,
                "Bad Request",
                body.as_bytes(),
                "application/json",
            )
            .await;
            return;
        }
    };

    let path = request.path.split('?').next().unwrap_or(&request.path);

    if request.method.eq_ignore_ascii_case("OPTIONS") {
        write_http_response(&mut stream, 204, "No Content", b"", "text/plain").await;
        return;
    }
    if !is_bridge_enabled() {
        let body = serde_json::json!({ "error": "Agent bridge disabled by settings" }).to_string();
        write_http_response(
            &mut stream,
            403,
            "Forbidden",
            body.as_bytes(),
            "application/json",
        )
        .await;
        return;
    }

    match (request.method.as_str(), path) {
        ("GET", "/schema") => {
            let header_token = extract_bearer_token(&request.headers);
            if let Some(error_message) = auth_error_message(header_token.as_deref()) {
                let body = serde_json::json!({ "error": error_message }).to_string();
                write_http_response(
                    &mut stream,
                    401,
                    "Unauthorized",
                    body.as_bytes(),
                    "application/json",
                )
                .await;
                return;
            }
            match load_schema_json(&app) {
                Ok(schema) => {
                    let body = serde_json::to_vec(&schema).unwrap_or_default();
                    write_http_response(&mut stream, 200, "OK", &body, "application/json").await;
                }
                Err(error) => {
                    let body = serde_json::json!({ "error": error }).to_string();
                    write_http_response(
                        &mut stream,
                        404,
                        "Not Found",
                        body.as_bytes(),
                        "application/json",
                    )
                    .await;
                }
            }
        }
        ("GET", "/commands") => {
            let header_token = extract_bearer_token(&request.headers);
            if let Some(error_message) = auth_error_message(header_token.as_deref()) {
                let body = serde_json::json!({ "error": error_message }).to_string();
                write_http_response(
                    &mut stream,
                    401,
                    "Unauthorized",
                    body.as_bytes(),
                    "application/json",
                )
                .await;
                return;
            }
            let body = serde_json::to_vec(&get_commands_list()).unwrap_or_default();
            write_http_response(&mut stream, 200, "OK", &body, "application/json").await;
        }
        ("POST", "/rpc") => {
            let mut rpc: HttpRpcRequest = match serde_json::from_slice(&request.body) {
                Ok(value) => value,
                Err(error) => {
                    let body = serde_json::json!({
                        "error": format!("Failed to parse request: {}", error)
                    })
                    .to_string();
                    write_http_response(
                        &mut stream,
                        400,
                        "Bad Request",
                        body.as_bytes(),
                        "application/json",
                    )
                    .await;
                    return;
                }
            };

            if rpc.token.is_none() {
                rpc.token = extract_bearer_token(&request.headers);
            }

            if let Some(error_message) = auth_error_message(rpc.token.as_deref()) {
                let response = WsResponse {
                    id: rpc.id,
                    result: None,
                    error: Some(error_message),
                };
                let body = serde_json::to_vec(&response).unwrap_or_default();
                write_http_response(&mut stream, 401, "Unauthorized", &body, "application/json")
                    .await;
                return;
            }

            crate::desktop_log!("📨 HTTP Request: {} (id: {})", rpc.cmd, rpc.id);

            let args_size = rpc.args.to_string().len();
            let start = std::time::Instant::now();
            let response = execute_command(&app, &rpc.cmd, rpc.args).await;
            let duration_ms = start.elapsed().as_millis() as u64;

            let (http_response, success, error_msg) = match response {
                Ok(result) => (
                    WsResponse {
                        id: rpc.id,
                        result: Some(result),
                        error: None,
                    },
                    true,
                    None,
                ),
                Err(error) => (
                    WsResponse {
                        id: rpc.id,
                        result: None,
                        error: Some(error.clone()),
                    },
                    false,
                    Some(error),
                ),
            };

            let audit_entry = AuditLogEntry {
                timestamp: Utc::now().to_rfc3339(),
                request_id: rpc.id,
                cmd: rpc.cmd,
                args_size,
                duration_ms,
                success,
                error: error_msg,
                peer_addr,
            };
            write_audit_log(&audit_entry);

            let body = serde_json::to_vec(&http_response).unwrap_or_default();
            write_http_response(&mut stream, 200, "OK", &body, "application/json").await;
        }
        _ => {
            let body = serde_json::json!({ "error": "Not found" }).to_string();
            write_http_response(
                &mut stream,
                404,
                "Not Found",
                body.as_bytes(),
                "application/json",
            )
            .await;
        }
    }
}

async fn execute_command(app: &AppHandle, cmd: &str, args: Value) -> Result<Value, String> {
    if !is_bridge_enabled() {
        return Err("Agent bridge disabled by settings".to_string());
    }
    if is_command_blocked(cmd) {
        return Err(format!("Command '{}' blocked by agent policy", cmd));
    }
    // Get the app state
    let state = app.state::<crate::AppState>();

    // Match command names and call the appropriate function
    match cmd {
        // --------------------------------------------------------------------
        // Agent API Discovery and Diagnostics
        // --------------------------------------------------------------------
        "agent_api_discover" => {
            // Return API metadata for agent self-discovery
            let http_port = std::env::var("DEV_WS_BRIDGE_HTTP_PORT")
                .ok()
                .and_then(|v| v.parse::<u16>().ok())
                .or_else(|| crate::get_settings().ok().map(|s| s.agent_bridge_http_port))
                .unwrap_or(3334);
            Ok(serde_json::json!({
                "version": "1.4.2",
                "name": "BioVault Desktop Agent API",
                "description": "WebSocket API for AI agent control of BioVault Desktop",
                "protocol": {
                    "transport": "WebSocket",
                    "address": "127.0.0.1",
                    "defaultPort": 3333,
                    "http": {
                        "address": "127.0.0.1",
                        "port": http_port,
                        "endpoints": {
                            "rpc": "POST /rpc",
                            "schema": "GET /schema",
                            "commands": "GET /commands"
                        }
                    }
                },
                "auth": {
                    "required": get_auth_token().is_some(),
                    "method": "token"
                },
                "docs": "docs/agent-api.md",
                "schema": "docs/agent-api.json"
            }))
        }
        "agent_api_get_audit_log" => {
            // Return recent audit log entries
            let max_entries: usize = args
                .get("maxEntries")
                .or_else(|| args.get("max_entries"))
                .and_then(|v| v.as_u64())
                .map(|v| v as usize)
                .unwrap_or(100);

            let mut entries = Vec::new();
            if let Some(path) = get_audit_log_path() {
                if path.exists() {
                    if let Ok(content) = std::fs::read_to_string(&path) {
                        let lines: Vec<&str> = content.lines().collect();
                        let start = if lines.len() > max_entries {
                            lines.len() - max_entries
                        } else {
                            0
                        };
                        for line in &lines[start..] {
                            if let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) {
                                entries.push(entry);
                            }
                        }
                    }
                }
            }
            Ok(serde_json::to_value(entries).unwrap())
        }
        "agent_api_clear_audit_log" => {
            // Clear the audit log
            if let Some(path) = get_audit_log_path() {
                if path.exists() {
                    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
                }
            }
            Ok(serde_json::Value::Null)
        }
        "agent_api_get_schema" => {
            // Return the full JSON schema for the API
            load_schema_json(app)
        }
        "get_agent_api_commands" => {
            let commands = crate::commands::agent_api::get_agent_api_commands(app.clone())?;
            Ok(serde_json::to_value(commands).unwrap())
        }
        "agent_api_list_commands" => {
            // Return a lightweight list of available commands with basic metadata
            // This is faster than get_schema for agents that just need command names
            Ok(get_commands_list())
        }
        "agent_api_events_info" => {
            // Return information about the event streaming system
            Ok(serde_json::json!({
                "description": "Long-running commands emit streaming events alongside the final response",
                "protocol": {
                    "eventFormat": {
                        "id": "Request ID this event belongs to",
                        "type": "Event type: progress, log, status",
                        "data": "Event payload (structure depends on type)"
                    },
                    "eventTypes": {
                        "progress": {
                            "description": "Progress update for long-running operation",
                            "data": {
                                "progress": "Float 0.0-1.0",
                                "message": "Human-readable progress message"
                            }
                        },
                        "log": {
                            "description": "Log message during operation",
                            "data": {
                                "level": "info, warn, error, debug",
                                "message": "Log message text"
                            }
                        },
                        "status": {
                            "description": "Status change during operation",
                            "data": {
                                "status": "Status name (e.g., 'downloading', 'installing')",
                                "details": "Optional additional details object"
                            }
                        }
                    },
                    "notes": [
                        "Events are sent with the same 'id' as the original request",
                        "Events may arrive before the final response",
                        "The final response still uses 'result' or 'error' fields",
                        "Commands with emitsEvents=true in metadata support events"
                    ]
                },
                "longRunningCommands": [
                    "install_dependencies",
                    "install_dependency",
                    "install_brew",
                    "install_command_line_tools",
                    "syftbox_upload_action",
                    "sync_messages",
                    "sync_messages_with_failures",
                    "refresh_messages_batched",
                    "import_flow_with_deps",
                    "run_flow",
                    "launch_session_jupyter",
                    "reset_session_jupyter",
                    "launch_jupyter",
                    "reset_jupyter"
                ]
            }))
        }
        // --------------------------------------------------------------------
        // UI Control
        // --------------------------------------------------------------------
        "ui_navigate" => {
            use tauri::Emitter;

            let tab: String = serde_json::from_value(
                args.get("tab")
                    .or_else(|| args.get("view"))
                    .cloned()
                    .ok_or_else(|| "Missing tab".to_string())?,
            )
            .map_err(|e| format!("Failed to parse tab: {}", e))?;

            app.emit(
                "agent-ui",
                serde_json::json!({
                    "action": "navigate",
                    "tab": tab
                }),
            )
            .map_err(|e| e.to_string())?;

            Ok(serde_json::Value::Null)
        }
        "ui_flow_import_options" => {
            use tauri::Emitter;

            app.emit(
                "agent-ui",
                serde_json::json!({
                    "action": "flow_import_options"
                }),
            )
            .map_err(|e| e.to_string())?;

            Ok(serde_json::Value::Null)
        }
        "ui_flow_import_from_path" => {
            use tauri::Emitter;

            let path: String = serde_json::from_value(
                args.get("path")
                    .or_else(|| args.get("flowPath"))
                    .or_else(|| args.get("flow_path"))
                    .cloned()
                    .ok_or_else(|| "Missing path".to_string())?,
            )
            .map_err(|e| format!("Failed to parse path: {}", e))?;
            let overwrite = args
                .get("overwrite")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            app.emit(
                "agent-ui",
                serde_json::json!({
                    "action": "flow_import_from_path",
                    "path": path,
                    "overwrite": overwrite
                }),
            )
            .map_err(|e| e.to_string())?;

            Ok(serde_json::Value::Null)
        }
        // --------------------------------------------------------------------
        // Settings / environment helpers (needed for browser-mode feature flags)
        // --------------------------------------------------------------------
        "get_dev_mode_info" => Ok(crate::get_dev_mode_info()),
        "is_dev_mode" => Ok(serde_json::to_value(crate::is_dev_mode()).unwrap()),
        "check_syftbox_auth" => {
            let result = crate::check_syftbox_auth().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_participants" => {
            let result = crate::get_participants(state).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_files" | "list_files" => {
            let result = crate::get_files(state).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_modules" => {
            let result = crate::get_modules(state).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_runs" => {
            let result = crate::get_runs(state).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "delete_run" => {
            let run_id: i64 = serde_json::from_value(
                args.get("runId")
                    .or_else(|| args.get("run_id"))
                    .cloned()
                    .ok_or_else(|| "Missing runId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse runId: {}", e))?;
            crate::commands::runs::delete_run(state, run_id).map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "get_run_logs" => {
            let run_id: i64 = serde_json::from_value(
                args.get("runId")
                    .or_else(|| args.get("run_id"))
                    .cloned()
                    .ok_or_else(|| "Missing runId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse runId: {}", e))?;
            let result =
                crate::commands::runs::get_run_logs(state, run_id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_run_logs_tail" => {
            let run_id: i64 = serde_json::from_value(
                args.get("runId")
                    .or_else(|| args.get("run_id"))
                    .cloned()
                    .ok_or_else(|| "Missing runId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse runId: {}", e))?;
            let lines: Option<usize> = args
                .get("lines")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result =
                crate::commands::runs::get_run_logs_tail(state, run_id, lines.unwrap_or(100))
                    .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_run_logs_full" => {
            let run_id: i64 = serde_json::from_value(
                args.get("runId")
                    .or_else(|| args.get("run_id"))
                    .cloned()
                    .ok_or_else(|| "Missing runId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse runId: {}", e))?;
            let result = crate::commands::runs::get_run_logs_full(state, run_id)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "reconcile_flow_runs" => {
            crate::commands::flows::reconcile_flow_runs(state)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "pause_flow_run" => {
            let run_id: i64 = serde_json::from_value(
                args.get("runId")
                    .or_else(|| args.get("run_id"))
                    .cloned()
                    .ok_or_else(|| "Missing runId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse runId: {}", e))?;
            crate::commands::flows::pause_flow_run(state, run_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "resume_flow_run" => {
            let window = app.get_webview_window("main");
            let run_id: i64 = serde_json::from_value(
                args.get("runId")
                    .or_else(|| args.get("run_id"))
                    .cloned()
                    .ok_or_else(|| "Missing runId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse runId: {}", e))?;
            let nextflow_max_forks: Option<u32> = args
                .get("nextflowMaxForks")
                .or_else(|| args.get("nextflow_max_forks"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let force_remove_lock: Option<bool> = args
                .get("forceRemoveLock")
                .or_else(|| args.get("force_remove_lock"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::commands::flows::resume_flow_run(
                state,
                window.ok_or_else(|| "Missing window handle for resume_flow_run".to_string())?,
                run_id,
                nextflow_max_forks,
                force_remove_lock,
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "cleanup_flow_run_state" => {
            let run_id: i64 = serde_json::from_value(
                args.get("runId")
                    .or_else(|| args.get("run_id"))
                    .cloned()
                    .ok_or_else(|| "Missing runId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse runId: {}", e))?;
            let result = crate::commands::flows::cleanup_flow_run_state(state, run_id)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_flow_run_work_dir" => {
            let run_id: i64 = serde_json::from_value(
                args.get("runId")
                    .or_else(|| args.get("run_id"))
                    .cloned()
                    .ok_or_else(|| "Missing runId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse runId: {}", e))?;
            let result = crate::commands::flows::get_flow_run_work_dir(state, run_id)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "path_exists" => {
            let path: String = serde_json::from_value(
                args.get("path")
                    .cloned()
                    .ok_or_else(|| "Missing path".to_string())?,
            )
            .map_err(|e| format!("Failed to parse path: {}", e))?;
            let result = crate::commands::flows::path_exists(path).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_flow_run_logs" => {
            let run_id: i64 = serde_json::from_value(
                args.get("runId")
                    .or_else(|| args.get("run_id"))
                    .cloned()
                    .ok_or_else(|| "Missing runId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse runId: {}", e))?;
            let result = crate::commands::flows::get_flow_run_logs(state, run_id)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_flow_run_logs_tail" => {
            let run_id: i64 = serde_json::from_value(
                args.get("runId")
                    .or_else(|| args.get("run_id"))
                    .cloned()
                    .ok_or_else(|| "Missing runId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse runId: {}", e))?;
            let lines: Option<usize> = args
                .get("lines")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result =
                crate::commands::flows::get_flow_run_logs_tail(state, run_id, lines.unwrap_or(100))
                    .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_flow_run_logs_full" => {
            let run_id: i64 = serde_json::from_value(
                args.get("runId")
                    .or_else(|| args.get("run_id"))
                    .cloned()
                    .ok_or_else(|| "Missing runId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse runId: {}", e))?;
            let result = crate::commands::flows::get_flow_run_logs_full(state, run_id)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_container_count" => {
            let result = crate::commands::flows::get_container_count();
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_flow_state" => {
            let run_id: i64 = serde_json::from_value(
                args.get("runId")
                    .or_else(|| args.get("run_id"))
                    .cloned()
                    .ok_or_else(|| "Missing runId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse runId: {}", e))?;
            let result =
                crate::commands::flows::get_flow_state(state, run_id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "save_flow_state_cmd" => {
            let run_id: i64 = serde_json::from_value(
                args.get("runId")
                    .or_else(|| args.get("run_id"))
                    .cloned()
                    .ok_or_else(|| "Missing runId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse runId: {}", e))?;
            let completed: u32 = serde_json::from_value(
                args.get("completed")
                    .cloned()
                    .ok_or_else(|| "Missing completed".to_string())?,
            )
            .map_err(|e| format!("Failed to parse completed: {}", e))?;
            let total: u32 = serde_json::from_value(
                args.get("total")
                    .cloned()
                    .ok_or_else(|| "Missing total".to_string())?,
            )
            .map_err(|e| format!("Failed to parse total: {}", e))?;
            let concurrency: Option<u32> = args
                .get("concurrency")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let container_count: u32 = serde_json::from_value(
                args.get("containerCount")
                    .or_else(|| args.get("container_count"))
                    .cloned()
                    .unwrap_or(serde_json::json!(0)),
            )
            .unwrap_or(0);
            let nextflow_command: Option<String> = args
                .get("nextflowCommand")
                .or_else(|| args.get("nextflow_command"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            crate::commands::flows::save_flow_state_cmd(
                state,
                run_id,
                completed,
                total,
                concurrency,
                container_count,
                nextflow_command,
            )
            .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "get_command_logs" => {
            let result = crate::get_command_logs().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_settings" => {
            let result = crate::get_settings().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "save_settings" => {
            let current = crate::get_settings().map_err(|e| e.to_string())?;
            let mut settings_value = args.get("settings").cloned().unwrap_or(args.clone());
            let settings_obj = settings_value
                .as_object_mut()
                .ok_or_else(|| "Settings must be an object".to_string())?;

            let protected_keys = [
                ("agent_bridge_enabled", "agentBridgeEnabled"),
                ("agent_bridge_port", "agentBridgePort"),
                ("agent_bridge_http_port", "agentBridgeHttpPort"),
                ("agent_bridge_token", "agentBridgeToken"),
                ("agent_bridge_blocklist", "agentBridgeBlocklist"),
            ];

            for (snake, camel) in protected_keys {
                if settings_obj.contains_key(snake) || settings_obj.contains_key(camel) {
                    return Err("Agent bridge settings cannot be changed via WebSocket".to_string());
                }
            }

            settings_obj.insert(
                "agent_bridge_enabled".to_string(),
                serde_json::to_value(current.agent_bridge_enabled).unwrap_or_default(),
            );
            settings_obj.insert(
                "agent_bridge_port".to_string(),
                serde_json::to_value(current.agent_bridge_port).unwrap_or_default(),
            );
            settings_obj.insert(
                "agent_bridge_http_port".to_string(),
                serde_json::to_value(current.agent_bridge_http_port).unwrap_or_default(),
            );
            settings_obj.insert(
                "agent_bridge_token".to_string(),
                serde_json::to_value(current.agent_bridge_token.clone()).unwrap_or_default(),
            );
            settings_obj.insert(
                "agent_bridge_blocklist".to_string(),
                serde_json::to_value(current.agent_bridge_blocklist.clone()).unwrap_or_default(),
            );

            let settings: crate::types::Settings = serde_json::from_value(settings_value)
                .map_err(|e| format!("Failed to parse settings: {}", e))?;
            crate::commands::settings::save_settings(settings).map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "set_autostart_enabled" => {
            let enabled: bool = serde_json::from_value(
                args.get("enabled")
                    .cloned()
                    .ok_or_else(|| "Missing enabled".to_string())?,
            )
            .map_err(|e| format!("Failed to parse enabled: {}", e))?;
            crate::commands::settings::set_autostart_enabled((*app).clone(), enabled)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "reset_all_data" => {
            crate::reset_all_data(state).map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "reset_everything" => {
            crate::reset_everything(state).map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        // --------------------------------------------------------------------
        // Profiles
        // --------------------------------------------------------------------
        "profiles_get_boot_state" => {
            let result =
                crate::commands::profiles::profiles_get_boot_state().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "profiles_get_default_home" => {
            let result = crate::commands::profiles::profiles_get_default_home()
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "profiles_open_new_instance" => {
            let profile_id: String = serde_json::from_value(
                args.get("profileId")
                    .or_else(|| args.get("profile_id"))
                    .cloned()
                    .ok_or_else(|| "Missing profileId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse profileId: {}", e))?;
            crate::commands::profiles::profiles_open_new_instance(profile_id)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "profiles_switch" => {
            let profile_id: String = serde_json::from_value(
                args.get("profileId")
                    .or_else(|| args.get("profile_id"))
                    .cloned()
                    .ok_or_else(|| "Missing profileId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse profileId: {}", e))?;
            crate::commands::profiles::profiles_switch(app.clone(), profile_id)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "profiles_switch_in_place" => {
            let profile_id: String = serde_json::from_value(
                args.get("profileId")
                    .or_else(|| args.get("profile_id"))
                    .cloned()
                    .ok_or_else(|| "Missing profileId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse profileId: {}", e))?;
            crate::commands::profiles::profiles_switch_in_place(app.clone(), state, profile_id)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "profiles_open_picker" => {
            crate::commands::profiles::profiles_open_picker(app.clone())
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "profiles_quit_picker" => {
            crate::commands::profiles::profiles_quit_picker(app.clone())
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "profiles_check_home_for_existing_email" => {
            let home_path: String = serde_json::from_value(
                args.get("homePath")
                    .or_else(|| args.get("home_path"))
                    .cloned()
                    .ok_or_else(|| "Missing homePath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse homePath: {}", e))?;
            let result =
                crate::commands::profiles::profiles_check_home_for_existing_email(home_path)
                    .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "profiles_create_with_home_and_switch" => {
            let home_path: String = serde_json::from_value(
                args.get("homePath")
                    .or_else(|| args.get("home_path"))
                    .cloned()
                    .ok_or_else(|| "Missing homePath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse homePath: {}", e))?;
            crate::commands::profiles::profiles_create_with_home_and_switch(app.clone(), home_path)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "profiles_create_and_switch_in_place" => {
            let home_path: String = serde_json::from_value(
                args.get("homePath")
                    .or_else(|| args.get("home_path"))
                    .cloned()
                    .ok_or_else(|| "Missing homePath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse homePath: {}", e))?;
            let result = crate::commands::profiles::profiles_create_and_switch_in_place(
                app.clone(),
                state,
                home_path,
            )
            .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "profiles_move_home" => {
            let profile_id: String = serde_json::from_value(
                args.get("profileId")
                    .or_else(|| args.get("profile_id"))
                    .cloned()
                    .ok_or_else(|| "Missing profileId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse profileId: {}", e))?;
            let new_home_path: String = serde_json::from_value(
                args.get("newHomePath")
                    .or_else(|| args.get("new_home_path"))
                    .cloned()
                    .ok_or_else(|| "Missing newHomePath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse newHomePath: {}", e))?;
            crate::commands::profiles::profiles_move_home(profile_id, new_home_path)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "profiles_delete_profile" => {
            let profile_id: String = serde_json::from_value(
                args.get("profileId")
                    .or_else(|| args.get("profile_id"))
                    .cloned()
                    .ok_or_else(|| "Missing profileId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse profileId: {}", e))?;
            let delete_home: bool = serde_json::from_value(
                args.get("deleteHome")
                    .or_else(|| args.get("delete_home"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Bool(false)),
            )
            .map_err(|e| format!("Failed to parse deleteHome: {}", e))?;
            crate::commands::profiles::profiles_delete_profile(profile_id, delete_home)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "profiles_create_and_switch" => {
            crate::commands::profiles::profiles_create_and_switch(app.clone())
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "check_dependencies" => {
            let result = crate::check_dependencies()
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "install_dependencies" => {
            let names: Vec<String> =
                serde_json::from_value(args.get("names").cloned().unwrap_or_default())
                    .map_err(|e| format!("Failed to parse names: {}", e))?;
            crate::install_dependencies(names)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(true).unwrap())
        }
        "update_saved_dependency_states" => {
            // Run in blocking thread pool since this calls subprocess checks (java, docker, etc.)
            tokio::task::spawn_blocking(crate::update_saved_dependency_states)
                .await
                .map_err(|e| format!("Task join error: {}", e))?
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "install_dependency" => {
            use tauri::Emitter;
            let name: String = serde_json::from_value(
                args.get("name")
                    .cloned()
                    .ok_or_else(|| "Missing name".to_string())?,
            )
            .map_err(|e| format!("Failed to parse name: {}", e))?;

            // Emit start event via app handle
            let _ = app.emit(
                "dependency-install-start",
                serde_json::json!({ "dependency": name.clone() }),
            );

            // Install the dependency
            let install_result =
                biovault::cli::commands::setup::install_single_dependency(&name).await;

            match install_result {
                Ok(maybe_path) => {
                    if let Some(path) = &maybe_path {
                        let _ =
                            biovault::config::Config::save_binary_path(&name, Some(path.clone()));
                    }
                    let _ = app.emit(
                        "dependency-install-complete",
                        serde_json::json!({
                            "dependency": name,
                            "success": true,
                            "path": maybe_path
                        }),
                    );
                    Ok(serde_json::to_value(format!("Installed: {}", name)).unwrap())
                }
                Err(e) => {
                    let _ = app.emit(
                        "dependency-install-complete",
                        serde_json::json!({
                            "dependency": name,
                            "success": false,
                            "error": e.to_string()
                        }),
                    );
                    Err(e.to_string())
                }
            }
        }
        "install_brew" => {
            let result = crate::commands::dependencies::install_brew()
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "install_command_line_tools" => {
            // This command exists on macOS only; on other platforms it's a no-op or error
            #[cfg(target_os = "macos")]
            {
                // The command spawns an installer dialog which the user must complete
                // We can't await it directly, so we just trigger it
                let _ = std::process::Command::new("xcode-select")
                    .arg("--install")
                    .spawn()
                    .map_err(|e| format!("Failed to launch installer: {}", e))?;
                Ok(serde_json::to_value("Installer launched").unwrap())
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err("Command Line Tools install is only available on macOS".to_string())
            }
        }
        "check_brew_installed" => {
            let result =
                crate::commands::dependencies::check_brew_installed().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "check_command_line_tools_installed" => {
            let result = crate::commands::dependencies::check_command_line_tools_installed()
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "check_is_onboarded" => {
            let result = crate::check_is_onboarded().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "complete_onboarding" => {
            let email: String = serde_json::from_value(
                args.get("email")
                    .cloned()
                    .ok_or_else(|| "Missing email".to_string())?,
            )
            .map_err(|e| format!("Failed to parse email: {}", e))?;
            crate::complete_onboarding(email)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "get_config_path" => {
            let result = crate::get_config_path().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_queue_processor_status" => {
            let result = crate::get_queue_processor_status(state).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_saved_dependency_states" => {
            let result = crate::get_saved_dependency_states().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_syftbox_state" => {
            let result = crate::get_syftbox_state().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "start_syftbox_client" => {
            let result = crate::start_syftbox_client().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "stop_syftbox_client" => {
            let result = crate::stop_syftbox_client().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_syftbox_config_info" => {
            let result = crate::get_syftbox_config_info().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_default_syftbox_server_url" => {
            let result = crate::get_default_syftbox_server_url();
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_env_var" => {
            let key: String = serde_json::from_value(
                args.get("key")
                    .cloned()
                    .ok_or_else(|| "Missing key".to_string())?,
            )
            .map_err(|e| format!("Failed to parse key: {}", e))?;
            let result = crate::get_env_var(key);
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_available_module_examples" => {
            let result = crate::get_available_module_examples().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_default_module_path" => {
            let name: Option<String> = args
                .get("name")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::get_default_module_path(name).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "create_module" => {
            let name: String = serde_json::from_value(
                args.get("name")
                    .cloned()
                    .ok_or_else(|| "Missing name".to_string())?,
            )
            .map_err(|e| format!("Failed to parse name: {}", e))?;
            let example: Option<String> = args
                .get("example")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let directory: Option<String> = args
                .get("directory")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let create_python_script: Option<bool> = args
                .get("createPythonScript")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let script_name: Option<String> = args
                .get("scriptName")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::create_module(
                state,
                name,
                example,
                directory,
                create_python_script,
                script_name,
            )
            .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "load_module_editor" => {
            let module_id: Option<i64> = args
                .get("moduleId")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let module_path: Option<String> = args
                .get("modulePath")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::load_module_editor(state, module_id, module_path)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "save_module_editor" => {
            let module_id: Option<i64> = args
                .get("moduleId")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let module_path: String = serde_json::from_value(
                args.get("modulePath")
                    .cloned()
                    .ok_or_else(|| "Missing modulePath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse modulePath: {}", e))?;
            let payload: serde_json::Value = args
                .get("payload")
                .cloned()
                .ok_or_else(|| "Missing payload".to_string())?;
            let result = crate::save_module_editor(state, module_id, module_path, payload)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_jupyter_status" => {
            let module_path: String = serde_json::from_value(
                args.get("modulePath")
                    .cloned()
                    .ok_or_else(|| "Missing modulePath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse modulePath: {}", e))?;
            let result = crate::get_jupyter_status(module_path).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "launch_jupyter" => {
            let module_path: String = serde_json::from_value(
                args.get("modulePath")
                    .cloned()
                    .ok_or_else(|| "Missing modulePath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse modulePath: {}", e))?;
            let python_version: Option<String> = args
                .get("pythonVersion")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::launch_jupyter(module_path, python_version)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "stop_jupyter" => {
            let module_path: String = serde_json::from_value(
                args.get("modulePath")
                    .cloned()
                    .ok_or_else(|| "Missing modulePath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse modulePath: {}", e))?;
            let result = crate::stop_jupyter(module_path)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "reset_jupyter" => {
            let module_path: String = serde_json::from_value(
                args.get("modulePath")
                    .cloned()
                    .ok_or_else(|| "Missing modulePath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse modulePath: {}", e))?;
            let python_version: Option<String> = args
                .get("pythonVersion")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::reset_jupyter(module_path, python_version)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "key_get_status" => {
            let email: Option<String> = args
                .get("email")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::key_get_status(email).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "key_list_contacts" => {
            let current_email: Option<String> = args
                .get("currentEmail")
                .cloned()
                .or_else(|| args.get("current_email").cloned())
                .and_then(|v| serde_json::from_value(v).ok());
            let result = crate::key_list_contacts(current_email).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "key_generate" => {
            let email: Option<String> = args
                .get("email")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let force: Option<bool> = args
                .get("force")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let state = app.state::<crate::AppState>();
            let result = crate::key_generate(email, force, state)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "key_restore" => {
            let email: String = serde_json::from_value(
                args.get("email")
                    .cloned()
                    .ok_or_else(|| "Missing email".to_string())?,
            )
            .map_err(|e| format!("Failed to parse email: {}", e))?;
            let mnemonic: String = serde_json::from_value(
                args.get("mnemonic")
                    .cloned()
                    .ok_or_else(|| "Missing mnemonic".to_string())?,
            )
            .map_err(|e| format!("Failed to parse mnemonic: {}", e))?;
            let state = app.state::<crate::AppState>();
            let result = crate::key_restore(email, mnemonic, state)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }

        // --------------------------------------------------------------------
        // Networking / messaging (required for @messages-two in browser mode)
        // --------------------------------------------------------------------
        "network_import_contact" => {
            let identity: String = serde_json::from_value(
                args.get("identity")
                    .cloned()
                    .ok_or_else(|| "Missing identity".to_string())?,
            )
            .map_err(|e| format!("Failed to parse identity: {}", e))?;
            let result = crate::network_import_contact(identity).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "sync_messages_with_failures" => {
            let result = crate::sync_messages_with_failures().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "refresh_messages_batched" => {
            let scope: Option<String> = args
                .get("scope")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let limit: Option<usize> = args
                .get("limit")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result =
                crate::refresh_messages_batched(scope, limit).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "list_message_threads" => {
            let scope: Option<String> = args
                .get("scope")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let limit: Option<usize> = args
                .get("limit")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::list_message_threads(scope, limit).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "list_spaces" => {
            let limit: Option<usize> = args
                .get("limit")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::list_spaces(limit).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_thread_messages" => {
            let thread_id: String = serde_json::from_value(
                args.get("threadId")
                    .cloned()
                    .or_else(|| args.get("thread_id").cloned())
                    .ok_or_else(|| "Missing threadId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse threadId: {}", e))?;
            let result = crate::get_thread_messages(thread_id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_contact_timeline" => {
            let contact: String = serde_json::from_value(
                args.get("contact")
                    .cloned()
                    .ok_or_else(|| "Missing contact".to_string())?,
            )
            .map_err(|e| format!("Failed to parse contact: {}", e))?;
            let limit: Option<usize> = args
                .get("limit")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::get_contact_timeline(contact, limit).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "send_message" => {
            let request: crate::types::MessageSendRequest = serde_json::from_value(
                args.get("request")
                    .cloned()
                    .ok_or_else(|| "Missing request".to_string())?,
            )
            .map_err(|e| format!("Failed to parse request: {}", e))?;
            let result = crate::send_message(request).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "key_check_contact" => {
            let email: String = serde_json::from_value(
                args.get("email")
                    .cloned()
                    .ok_or_else(|| "Missing email".to_string())?,
            )
            .map_err(|e| format!("Failed to parse email: {}", e))?;
            let result = crate::key_check_contact(email).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "count_failed_messages" => {
            let result = crate::count_failed_messages().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "list_failed_messages" => {
            let include_dismissed: Option<bool> = args
                .get("includeDismissed")
                .or_else(|| args.get("include_dismissed"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result =
                crate::list_failed_messages(include_dismissed).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "syftbox_queue_status" => {
            let result = crate::syftbox_queue_status()
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "syftbox_subscriptions_discovery" => {
            let result = crate::syftbox_subscriptions_discovery()
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "trigger_syftbox_sync" => {
            crate::trigger_syftbox_sync()
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "syftbox_upload_action" => {
            let id: String = serde_json::from_value(
                args.get("id")
                    .cloned()
                    .ok_or_else(|| "Missing id".to_string())?,
            )
            .map_err(|e| format!("Failed to parse id: {}", e))?;
            let action: String = serde_json::from_value(
                args.get("action")
                    .cloned()
                    .ok_or_else(|| "Missing action".to_string())?,
            )
            .map_err(|e| format!("Failed to parse action: {}", e))?;
            crate::commands::syftbox::syftbox_upload_action(id, action)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "syftbox_request_otp" => {
            let email: String = serde_json::from_value(
                args.get("email")
                    .cloned()
                    .ok_or_else(|| "Missing email".to_string())?,
            )
            .map_err(|e| format!("Failed to parse email: {}", e))?;
            let server_url: Option<String> = args
                .get("serverUrl")
                .or_else(|| args.get("server_url"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            crate::commands::syftbox::syftbox_request_otp(email, server_url)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "syftbox_submit_otp" => {
            let email: String = serde_json::from_value(
                args.get("email")
                    .cloned()
                    .ok_or_else(|| "Missing email".to_string())?,
            )
            .map_err(|e| format!("Failed to parse email: {}", e))?;
            let otp: String = serde_json::from_value(
                args.get("otp")
                    .cloned()
                    .ok_or_else(|| "Missing otp".to_string())?,
            )
            .map_err(|e| format!("Failed to parse otp: {}", e))?;
            let server_url: Option<String> = args
                .get("serverUrl")
                .or_else(|| args.get("server_url"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            crate::commands::syftbox::syftbox_submit_otp(email, otp, server_url)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        // Sync Tree commands
        "sync_tree_list_dir" => {
            let path: Option<String> = args
                .get("path")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::commands::sync_tree::sync_tree_list_dir(path)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "sync_tree_get_details" => {
            let path: String = serde_json::from_value(
                args.get("path")
                    .cloned()
                    .ok_or_else(|| "Missing path".to_string())?,
            )
            .map_err(|e| format!("Failed to parse path: {}", e))?;
            let result = crate::commands::sync_tree::sync_tree_get_details(path)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "sync_tree_get_ignore_patterns" => {
            let result = crate::commands::sync_tree::sync_tree_get_ignore_patterns()
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "sync_tree_add_ignore" => {
            let pattern: String = serde_json::from_value(
                args.get("pattern")
                    .cloned()
                    .ok_or_else(|| "Missing pattern".to_string())?,
            )
            .map_err(|e| format!("Failed to parse pattern: {}", e))?;
            crate::commands::sync_tree::sync_tree_add_ignore(pattern)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "sync_tree_remove_ignore" => {
            let pattern: String = serde_json::from_value(
                args.get("pattern")
                    .cloned()
                    .ok_or_else(|| "Missing pattern".to_string())?,
            )
            .map_err(|e| format!("Failed to parse pattern: {}", e))?;
            crate::commands::sync_tree::sync_tree_remove_ignore(pattern)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "sync_tree_init_default_policy" => {
            let result = crate::commands::sync_tree::sync_tree_init_default_policy()
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "sync_tree_get_shared_with_me" => {
            let result = crate::commands::sync_tree::sync_tree_get_shared_with_me()
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "sync_tree_subscribe" => {
            let path: String = serde_json::from_value(
                args.get("path")
                    .cloned()
                    .ok_or_else(|| "Missing path".to_string())?,
            )
            .map_err(|e| format!("Failed to parse path: {}", e))?;
            crate::commands::sync_tree::sync_tree_subscribe(path)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "sync_tree_unsubscribe" => {
            let path: String = serde_json::from_value(
                args.get("path")
                    .cloned()
                    .ok_or_else(|| "Missing path".to_string())?,
            )
            .map_err(|e| format!("Failed to parse path: {}", e))?;
            crate::commands::sync_tree::sync_tree_unsubscribe(path)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "sync_tree_set_subscription" => {
            let path: String = serde_json::from_value(
                args.get("path")
                    .cloned()
                    .ok_or_else(|| "Missing path".to_string())?,
            )
            .map_err(|e| format!("Failed to parse path: {}", e))?;
            let allow: bool = serde_json::from_value(
                args.get("allow")
                    .cloned()
                    .ok_or_else(|| "Missing allow".to_string())?,
            )
            .map_err(|e| format!("Failed to parse allow: {}", e))?;
            let is_dir: bool = args
                .get("isDir")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or(false);
            crate::commands::sync_tree::sync_tree_set_subscription(path, allow, is_dir)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "mark_thread_as_read" => {
            let thread_id: String = serde_json::from_value(
                args.get("threadId")
                    .cloned()
                    .or_else(|| args.get("thread_id").cloned())
                    .ok_or_else(|| "Missing threadId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse threadId: {}", e))?;
            let result = crate::mark_thread_as_read(thread_id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "delete_message" => {
            let message_id: String = serde_json::from_value(
                args.get("messageId")
                    .cloned()
                    .or_else(|| args.get("message_id").cloned())
                    .ok_or_else(|| "Missing messageId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse messageId: {}", e))?;
            crate::delete_message(message_id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(()).unwrap())
        }
        "delete_thread" => {
            let thread_id: String = serde_json::from_value(
                args.get("threadId")
                    .cloned()
                    .or_else(|| args.get("thread_id").cloned())
                    .ok_or_else(|| "Missing threadId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse threadId: {}", e))?;
            let result = crate::delete_thread(thread_id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "send_flow_request" => {
            let flow_name: String = serde_json::from_value(
                args.get("flowName")
                    .cloned()
                    .or_else(|| args.get("flow_name").cloned())
                    .ok_or_else(|| "Missing flowName".to_string())?,
            )
            .map_err(|e| format!("Failed to parse flowName: {}", e))?;
            let flow_version: String = serde_json::from_value(
                args.get("flowVersion")
                    .cloned()
                    .or_else(|| args.get("flow_version").cloned())
                    .ok_or_else(|| "Missing flowVersion".to_string())?,
            )
            .map_err(|e| format!("Failed to parse flowVersion: {}", e))?;
            let dataset_name: String = serde_json::from_value(
                args.get("datasetName")
                    .cloned()
                    .or_else(|| args.get("dataset_name").cloned())
                    .ok_or_else(|| "Missing datasetName".to_string())?,
            )
            .map_err(|e| format!("Failed to parse datasetName: {}", e))?;
            let recipient: String = serde_json::from_value(
                args.get("recipient")
                    .cloned()
                    .ok_or_else(|| "Missing recipient".to_string())?,
            )
            .map_err(|e| format!("Failed to parse recipient: {}", e))?;
            let message: String = serde_json::from_value(
                args.get("message")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!("")),
            )
            .unwrap_or_default();
            let run_id: Option<String> = args
                .get("runId")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .or_else(|| {
                    args.get("run_id")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                });
            let datasites: Option<Vec<String>> = args
                .get("datasites")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::send_flow_request(
                flow_name,
                flow_version,
                dataset_name,
                recipient,
                message,
                run_id,
                datasites,
            )
            .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "send_flow_request_results" => {
            let request_id: String = serde_json::from_value(
                args.get("requestId")
                    .cloned()
                    .or_else(|| args.get("request_id").cloned())
                    .ok_or_else(|| "Missing requestId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse requestId: {}", e))?;
            let run_id: i64 = serde_json::from_value(
                args.get("runId")
                    .cloned()
                    .or_else(|| args.get("run_id").cloned())
                    .ok_or_else(|| "Missing runId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse runId: {}", e))?;
            let message: Option<String> = args
                .get("message")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let output_paths: Option<Vec<String>> = args
                .get("outputPaths")
                .cloned()
                .or_else(|| args.get("output_paths").cloned())
                .and_then(|v| serde_json::from_value(v).ok());
            let result =
                crate::send_flow_request_results(request_id, run_id, message, output_paths)
                    .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "import_flow_results" => {
            let results_location: String = serde_json::from_value(
                args.get("resultsLocation")
                    .cloned()
                    .or_else(|| args.get("results_location").cloned())
                    .ok_or_else(|| "Missing resultsLocation".to_string())?,
            )
            .map_err(|e| format!("Failed to parse resultsLocation: {}", e))?;
            let submission_id: Option<String> = args
                .get("submissionId")
                .cloned()
                .or_else(|| args.get("submission_id").cloned())
                .and_then(|v| serde_json::from_value(v).ok());
            let run_id: Option<i64> = args
                .get("runId")
                .cloned()
                .or_else(|| args.get("run_id").cloned())
                .and_then(|v| serde_json::from_value(v).ok());
            let flow_name: Option<String> = args
                .get("flowName")
                .cloned()
                .or_else(|| args.get("flow_name").cloned())
                .and_then(|v| serde_json::from_value(v).ok());
            let result =
                crate::import_flow_results(results_location, submission_id, run_id, flow_name)
                    .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "list_results_tree" => {
            let root: String = serde_json::from_value(
                args.get("root")
                    .cloned()
                    .ok_or_else(|| "Missing root".to_string())?,
            )
            .map_err(|e| format!("Failed to parse root: {}", e))?;
            let result = crate::list_results_tree(root).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "send_flow_results" => {
            let recipient: String = serde_json::from_value(
                args.get("recipient")
                    .cloned()
                    .ok_or_else(|| "Missing recipient".to_string())?,
            )
            .map_err(|e| format!("Failed to parse recipient: {}", e))?;
            let flow_name: String = serde_json::from_value(
                args.get("flowName")
                    .cloned()
                    .or_else(|| args.get("flow_name").cloned())
                    .ok_or_else(|| "Missing flowName".to_string())?,
            )
            .map_err(|e| format!("Failed to parse flowName: {}", e))?;
            let run_id: i64 = serde_json::from_value(
                args.get("runId")
                    .cloned()
                    .or_else(|| args.get("run_id").cloned())
                    .ok_or_else(|| "Missing runId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse runId: {}", e))?;
            let outputs: Vec<crate::commands::messages::OutputFile> = serde_json::from_value(
                args.get("outputs")
                    .cloned()
                    .ok_or_else(|| "Missing outputs".to_string())?,
            )
            .map_err(|e| format!("Failed to parse outputs: {}", e))?;
            let message: String = serde_json::from_value(
                args.get("message")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!("")),
            )
            .unwrap_or_default();
            let result = crate::send_flow_results(recipient, flow_name, run_id, outputs, message)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }

        // --------------------------------------------------------------------
        // Sessions (required for session invite/accept/reject flows)
        // --------------------------------------------------------------------
        "get_sessions" => {
            let result = crate::get_sessions().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "list_sessions" => {
            let result = crate::list_sessions().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_session_invitations" => {
            let result = crate::get_session_invitations().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "create_session" => {
            let request: crate::types::CreateSessionRequest = serde_json::from_value(
                args.get("request")
                    .cloned()
                    .ok_or_else(|| "Missing request".to_string())?,
            )
            .map_err(|e| format!("Failed to parse request: {}", e))?;
            let result = crate::create_session(request).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "accept_session_invitation" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .or_else(|| args.get("session_id").cloned())
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let result = crate::accept_session_invitation(session_id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "reject_session_invitation" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .or_else(|| args.get("session_id").cloned())
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let reason: Option<String> = args
                .get("reason")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            crate::reject_session_invitation(session_id, reason).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(()).unwrap())
        }
        "send_session_chat_message" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .or_else(|| args.get("session_id").cloned())
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let body: String = serde_json::from_value(
                args.get("body")
                    .cloned()
                    .ok_or_else(|| "Missing body".to_string())?,
            )
            .map_err(|e| format!("Failed to parse body: {}", e))?;
            let result =
                crate::send_session_chat_message(session_id, body).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_session_chat_messages" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .or_else(|| args.get("session_id").cloned())
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let result = crate::get_session_chat_messages(session_id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        // --------------------------------------------------------------------
        // Session Jupyter (required for Jupyter session management)
        // --------------------------------------------------------------------
        "get_session_jupyter_status" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .or_else(|| args.get("session_id").cloned())
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let result =
                crate::get_session_jupyter_status(session_id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "launch_session_jupyter" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .or_else(|| args.get("session_id").cloned())
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let python_version: Option<String> = args
                .get("pythonVersion")
                .or_else(|| args.get("python_version"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let copy_examples: Option<bool> = args
                .get("copyExamples")
                .or_else(|| args.get("copy_examples"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::launch_session_jupyter(
                (*app).clone(),
                session_id,
                python_version,
                copy_examples,
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "stop_session_jupyter" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .or_else(|| args.get("session_id").cloned())
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let result = crate::stop_session_jupyter(session_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "reset_session_jupyter" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .or_else(|| args.get("session_id").cloned())
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let python_version: Option<String> = args
                .get("pythonVersion")
                .or_else(|| args.get("python_version"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::reset_session_jupyter(session_id, python_version)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "list_session_datasets" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .or_else(|| args.get("session_id").cloned())
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let result = crate::list_session_datasets(session_id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_session_beaver_summaries" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .or_else(|| args.get("session_id").cloned())
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let result =
                crate::get_session_beaver_summaries(session_id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_session" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .or_else(|| args.get("session_id").cloned())
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let result =
                crate::commands::sessions::get_session(session_id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "delete_session" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .or_else(|| args.get("session_id").cloned())
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            crate::commands::sessions::delete_session(session_id).map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "add_dataset_to_session" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .or_else(|| args.get("session_id").cloned())
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let dataset_name: String = serde_json::from_value(
                args.get("datasetName")
                    .cloned()
                    .or_else(|| args.get("dataset_name").cloned())
                    .ok_or_else(|| "Missing datasetName".to_string())?,
            )
            .map_err(|e| format!("Failed to parse datasetName: {}", e))?;
            let role: Option<String> = args
                .get("role")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result =
                crate::commands::sessions::add_dataset_to_session(session_id, dataset_name, role)
                    .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "remove_dataset_from_session" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .or_else(|| args.get("session_id").cloned())
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let dataset_name: String = serde_json::from_value(
                args.get("datasetName")
                    .cloned()
                    .or_else(|| args.get("dataset_name").cloned())
                    .ok_or_else(|| "Missing datasetName".to_string())?,
            )
            .map_err(|e| format!("Failed to parse datasetName: {}", e))?;
            crate::commands::sessions::remove_dataset_from_session(session_id, dataset_name)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "sync_messages" => {
            let result = crate::sync_messages().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        // --------------------------------------------------------------------
        // Misc commands (for full UI compatibility)
        // --------------------------------------------------------------------
        "get_app_version" => {
            let result = crate::get_app_version();
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_desktop_log_dir" => {
            let result = crate::get_desktop_log_dir().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "key_check_vault_debug" => {
            let result = crate::key_check_vault_debug().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "network_scan_datasites" => {
            let result = crate::network_scan_datasites().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_queue_info" => {
            let file_id: Option<i64> = args
                .get("fileId")
                .or_else(|| args.get("file_id"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let state = app.state::<crate::AppState>();
            let result = crate::get_queue_info(state, file_id).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_flows" => {
            let state = app.state::<crate::AppState>();
            let result = crate::get_flows(state).await.map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_autostart_enabled" => {
            let result = crate::get_autostart_enabled((*app).clone()).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_syftbox_diagnostics" => {
            let result = crate::get_syftbox_diagnostics().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "test_turn_connection" => {
            let server_url: Option<String> = args
                .get("serverUrl")
                .cloned()
                .or_else(|| args.get("server_url").cloned())
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| format!("Failed to parse serverUrl: {}", e))?;
            let result = crate::commands::syftbox::test_turn_connection(server_url)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "test_peer_link" => {
            let options = if let Some(value) = args
                .get("options")
                .cloned()
                .or_else(|| args.get("peerLinkOptions").cloned())
            {
                serde_json::from_value(value)
                    .map_err(|e| format!("Failed to parse options: {}", e))?
            } else {
                crate::commands::syftbox::PeerLinkTestOptions {
                    peer_email: args
                        .get("peerEmail")
                        .or_else(|| args.get("peer_email"))
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    rounds: args
                        .get("rounds")
                        .or_else(|| args.get("roundsCount"))
                        .and_then(|v| v.as_u64())
                        .and_then(|v| u32::try_from(v).ok()),
                    payload_kb: args
                        .get("payloadKb")
                        .or_else(|| args.get("payload_kb"))
                        .and_then(|v| v.as_u64())
                        .and_then(|v| u32::try_from(v).ok()),
                    timeout_s: args
                        .get("timeoutS")
                        .or_else(|| args.get("timeout_s"))
                        .and_then(|v| v.as_u64()),
                    poll_ms: args
                        .get("pollMs")
                        .or_else(|| args.get("poll_ms"))
                        .and_then(|v| v.as_u64()),
                }
            };
            let result =
                crate::commands::syftbox::test_peer_link(options).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_database_path" => {
            let result = crate::commands::settings::get_database_path()?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "sql_list_tables" => {
            let result = crate::commands::sql::sql_list_tables(state.clone())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_desktop_log_text" => {
            let max_bytes = args.get("maxBytes").and_then(|v| v.as_u64());
            let result = crate::commands::logs::get_desktop_log_text(max_bytes)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "clear_desktop_log" => {
            crate::commands::logs::clear_desktop_log()?;
            Ok(serde_json::Value::Null)
        }
        "clear_command_logs" => {
            crate::commands::logs::clear_command_logs()?;
            Ok(serde_json::Value::Null)
        }
        "network_scan_datasets" => {
            let result = crate::commands::datasets::network_scan_datasets()?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "is_dev_syftbox_enabled" => {
            let result = crate::commands::settings::is_dev_syftbox_enabled();
            Ok(serde_json::to_value(result).unwrap())
        }
        "check_dev_syftbox_server" => {
            let result = crate::commands::settings::check_dev_syftbox_server()
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "check_single_dependency" => {
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'name' argument")?
                .to_string();
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let result = crate::commands::dependencies::check_single_dependency(name, path)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        // --------------------------------------------------------------------
        // Import / scan commands
        // --------------------------------------------------------------------
        "get_extensions" => {
            let path: String = serde_json::from_value(
                args.get("path")
                    .cloned()
                    .ok_or_else(|| "Missing path".to_string())?,
            )
            .map_err(|e| format!("Failed to parse path: {}", e))?;
            let result =
                crate::commands::files::scan::get_extensions(path).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "search_txt_files" => {
            let path: String = serde_json::from_value(
                args.get("path")
                    .cloned()
                    .ok_or_else(|| "Missing path".to_string())?,
            )
            .map_err(|e| format!("Failed to parse path: {}", e))?;
            let extensions: Vec<String> = serde_json::from_value(
                args.get("extensions")
                    .cloned()
                    .unwrap_or(serde_json::Value::Array(vec![])),
            )
            .map_err(|e| format!("Failed to parse extensions: {}", e))?;
            let result = crate::commands::files::scan::search_txt_files(path, extensions)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "suggest_patterns" => {
            let files: Vec<String> = serde_json::from_value(
                args.get("files")
                    .cloned()
                    .unwrap_or(serde_json::Value::Array(vec![])),
            )
            .map_err(|e| format!("Failed to parse files: {}", e))?;
            let result =
                crate::commands::files::scan::suggest_patterns(files).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "extract_ids_for_files" => {
            let files: Vec<String> = serde_json::from_value(
                args.get("files")
                    .cloned()
                    .unwrap_or(serde_json::Value::Array(vec![])),
            )
            .map_err(|e| format!("Failed to parse files: {}", e))?;
            let pattern: String = serde_json::from_value(
                args.get("pattern")
                    .cloned()
                    .ok_or_else(|| "Missing pattern".to_string())?,
            )
            .map_err(|e| format!("Failed to parse pattern: {}", e))?;
            let result = crate::commands::files::scan::extract_ids_for_files(files, pattern)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "detect_file_types" => {
            let files: Vec<String> = serde_json::from_value(
                args.get("files")
                    .cloned()
                    .unwrap_or(serde_json::Value::Array(vec![])),
            )
            .map_err(|e| format!("Failed to parse files: {}", e))?;
            let result = crate::commands::files::analyze::detect_file_types(state.clone(), files)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "fetch_sample_data" => {
            let samples: Vec<String> = serde_json::from_value(
                args.get("samples")
                    .cloned()
                    .unwrap_or(serde_json::Value::Array(vec![])),
            )
            .map_err(|e| format!("Failed to parse samples: {}", e))?;
            let result = crate::commands::files::sample_data::fetch_sample_data(samples)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "fetch_sample_data_with_progress" => {
            let samples: Vec<String> = serde_json::from_value(
                args.get("samples")
                    .cloned()
                    .unwrap_or(serde_json::Value::Array(vec![])),
            )
            .map_err(|e| format!("Failed to parse samples: {}", e))?;
            let window = app.get_webview_window("main");
            let result = if let Some(window) = window {
                crate::commands::files::sample_data::fetch_sample_data_with_progress(
                    window, samples,
                )
                .await
                .map_err(|e| e.to_string())?
            } else {
                crate::commands::files::sample_data::fetch_sample_data(samples)
                    .await
                    .map_err(|e| e.to_string())?
            };
            Ok(serde_json::to_value(result).unwrap())
        }
        "fetch_reference_data" => {
            let result = crate::commands::files::reference_data::fetch_reference_data()
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "fetch_reference_data_with_progress" => {
            let window = app.get_webview_window("main");
            let result = if let Some(window) = window {
                crate::commands::files::reference_data::fetch_reference_data_with_progress(window)
                    .await
                    .map_err(|e| e.to_string())?
            } else {
                crate::commands::files::reference_data::fetch_reference_data()
                    .await
                    .map_err(|e| e.to_string())?
            };
            Ok(serde_json::to_value(result).unwrap())
        }
        "import_files_pending" => {
            let file_metadata: std::collections::HashMap<
                String,
                crate::commands::files::FileMetadata,
            > = serde_json::from_value(
                args.get("fileMetadata")
                    .cloned()
                    .ok_or_else(|| "Missing fileMetadata".to_string())?,
            )
            .map_err(|e| format!("Failed to parse fileMetadata: {}", e))?;
            let result = crate::commands::files::import::import_files_pending(state, file_metadata)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        // --------------------------------------------------------------------
        // Flow commands
        // --------------------------------------------------------------------
        "get_runs_base_dir" => {
            let result = crate::commands::flows::get_runs_base_dir()
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "check_docker_running" => {
            let result = crate::commands::dependencies::check_docker_running()
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_flow_runs" => {
            let result = crate::commands::flows::get_flow_runs(state.clone())
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "import_flow_with_deps" => {
            let url: String = serde_json::from_value(
                args.get("url")
                    .cloned()
                    .ok_or_else(|| "Missing url".to_string())?,
            )
            .map_err(|e| format!("Failed to parse url: {}", e))?;
            let name_override: Option<String> = args
                .get("nameOverride")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let overwrite: bool = args
                .get("overwrite")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let result =
                crate::commands::modules::import_flow_with_deps(url, name_override, overwrite)
                    .await
                    .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "create_flow" | "import_flow" => {
            let request: crate::commands::flows::FlowCreateRequest = serde_json::from_value(
                args.get("request")
                    .cloned()
                    .unwrap_or_else(|| {
                        // Build request from individual args if not provided as object
                        serde_json::json!({
                            "name": args.get("name").cloned().unwrap_or(serde_json::json!("")),
                            "directory": args.get("directory").cloned(),
                            "flowFile": args.get("flowFile").or_else(|| args.get("flow_file")).cloned(),
                            "overwrite": args.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(false)
                        })
                    }),
            )
            .map_err(|e| format!("Failed to parse request: {}", e))?;
            let result = crate::commands::flows::create_flow(state.clone(), request)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "import_flow_from_message" => {
            let name: String = serde_json::from_value(
                args.get("name")
                    .cloned()
                    .ok_or_else(|| "Missing name".to_string())?,
            )
            .map_err(|e| format!("Failed to parse name: {}", e))?;
            let version: String = serde_json::from_value(
                args.get("version")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!("1.0.0")),
            )
            .unwrap_or_else(|_| "1.0.0".to_string());
            let spec: serde_json::Value = args
                .get("spec")
                .cloned()
                .ok_or_else(|| "Missing spec".to_string())?;
            let result = crate::commands::flows::import_flow_from_message(
                state.clone(),
                name,
                version,
                spec,
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "import_flow_from_request" => {
            let name: Option<String> = args
                .get("name")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let flow_location: String = serde_json::from_value(
                args.get("flowLocation")
                    .cloned()
                    .or_else(|| args.get("flow_location").cloned())
                    .ok_or_else(|| "Missing flowLocation".to_string())?,
            )
            .map_err(|e| format!("Failed to parse flowLocation: {}", e))?;
            let overwrite: bool = args
                .get("overwrite")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let result = crate::commands::flows::import_flow_from_request(
                state.clone(),
                name,
                flow_location,
                overwrite,
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "import_flow_from_json" => {
            let request: crate::commands::flows::ImportFlowFromJsonRequest =
                serde_json::from_value(
                    args.get("request")
                        .cloned()
                        .ok_or_else(|| "Missing request".to_string())?,
                )
                .map_err(|e| format!("Failed to parse request: {}", e))?;
            let result = crate::commands::flows::import_flow_from_json(state.clone(), request)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "run_flow" => {
            // Try to get the main window for event emission (optional in WS bridge mode)
            let window = app.get_webview_window("main");

            let flow_id: i64 = serde_json::from_value(
                args.get("flowId")
                    .cloned()
                    .ok_or_else(|| "Missing flowId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse flowId: {}", e))?;

            let input_overrides: std::collections::HashMap<String, String> =
                serde_json::from_value(
                    args.get("inputOverrides")
                        .cloned()
                        .unwrap_or(serde_json::json!({})),
                )
                .map_err(|e| format!("Failed to parse inputOverrides: {}", e))?;

            let results_dir: Option<String> = args
                .get("resultsDir")
                .and_then(|v| serde_json::from_value(v.clone()).ok());

            let selection: Option<crate::commands::flows::FlowRunSelection> = args
                .get("selection")
                .and_then(|v| serde_json::from_value(v.clone()).ok());

            let nextflow_max_forks: Option<u32> = args
                .get("nextflowMaxForks")
                .or_else(|| args.get("nextflow_max_forks"))
                .or_else(|| args.get("nxfMaxForks"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());

            let run_id: Option<String> = args
                .get("runId")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .or_else(|| {
                    args.get("run_id")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                });

            let result = crate::commands::flows::run_flow_impl(
                state.clone(),
                window,
                flow_id,
                input_overrides,
                results_dir,
                selection,
                run_id,
                nextflow_max_forks,
                false,
                None,
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        // --------------------------------------------------------------------
        // Folder/file operations
        // --------------------------------------------------------------------
        "open_folder" => {
            let path: String = serde_json::from_value(
                args.get("path")
                    .cloned()
                    .ok_or_else(|| "Missing path".to_string())?,
            )
            .map_err(|e| format!("Failed to parse path: {}", e))?;
            crate::commands::settings::open_folder(path)?;
            Ok(serde_json::Value::Null)
        }
        // --------------------------------------------------------------------
        // SQL commands
        // --------------------------------------------------------------------
        "sql_get_table_schema" => {
            let table: String = serde_json::from_value(
                args.get("table")
                    .cloned()
                    .ok_or_else(|| "Missing table".to_string())?,
            )
            .map_err(|e| format!("Failed to parse table: {}", e))?;
            let result = crate::commands::sql::sql_get_table_schema(state.clone(), table)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "sql_run_query" => {
            let query: String = serde_json::from_value(
                args.get("query")
                    .cloned()
                    .ok_or_else(|| "Missing query".to_string())?,
            )
            .map_err(|e| format!("Failed to parse query: {}", e))?;
            let options: Option<crate::commands::sql::SqlQueryOptions> = args
                .get("options")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            let result = crate::commands::sql::sql_run_query(state.clone(), query, options)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        // --------------------------------------------------------------------
        // Dataset commands
        // --------------------------------------------------------------------
        "get_datasets" | "list_datasets_with_assets" => {
            let result = crate::commands::datasets::list_datasets_with_assets(state.clone())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "save_dataset_with_files" => {
            let manifest: biovault::cli::commands::datasets::DatasetManifest =
                serde_json::from_value(
                    args.get("manifest")
                        .cloned()
                        .ok_or_else(|| "Missing manifest".to_string())?,
                )
                .map_err(|e| format!("Failed to parse manifest: {}", e))?;
            let original_name: Option<String> = args
                .get("originalName")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            let result = crate::commands::datasets::save_dataset_with_files(
                state.clone(),
                manifest,
                original_name,
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "is_dataset_published" => {
            let name: String = serde_json::from_value(
                args.get("name")
                    .cloned()
                    .ok_or_else(|| "Missing name".to_string())?,
            )
            .map_err(|e| format!("Failed to parse name: {}", e))?;
            let result = crate::commands::datasets::is_dataset_published(name)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "delete_dataset" => {
            let name: String = serde_json::from_value(
                args.get("name")
                    .cloned()
                    .ok_or_else(|| "Missing name".to_string())?,
            )
            .map_err(|e| format!("Failed to parse name: {}", e))?;
            let result = crate::commands::datasets::delete_dataset(state.clone(), name)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "publish_dataset" => {
            let manifest_path: Option<String> = args
                .get("manifestPath")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            let name: Option<String> = args
                .get("name")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            let copy_mock: bool = args
                .get("copyMock")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or(false);
            crate::commands::datasets::publish_dataset(
                state.clone(),
                manifest_path,
                name,
                copy_mock,
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "unpublish_dataset" => {
            let name: String = serde_json::from_value(
                args.get("name")
                    .cloned()
                    .ok_or_else(|| "Missing name".to_string())?,
            )
            .map_err(|e| format!("Failed to parse name: {}", e))?;
            crate::commands::datasets::unpublish_dataset(name)?;
            Ok(serde_json::Value::Null)
        }
        "get_datasets_folder_path" => {
            let result = crate::commands::datasets::get_datasets_folder_path()?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "resolve_dataset_path" => {
            let dir_path: String = serde_json::from_value(
                args.get("dirPath")
                    .cloned()
                    .ok_or_else(|| "Missing dirPath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse dirPath: {}", e))?;
            let result = crate::commands::datasets::resolve_local_dataset_path(dir_path)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "resolve_syft_url_to_local_path" => {
            let syft_url: String = serde_json::from_value(
                args.get("syftUrl")
                    .cloned()
                    .ok_or_else(|| "Missing syftUrl".to_string())?,
            )
            .map_err(|e| format!("Failed to parse syftUrl: {}", e))?;
            let result = crate::commands::datasets::resolve_syft_url_to_local_path(syft_url)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "resolve_syft_urls_batch" => {
            let urls: Vec<String> = serde_json::from_value(
                args.get("urls")
                    .cloned()
                    .ok_or_else(|| "Missing urls".to_string())?,
            )
            .map_err(|e| format!("Failed to parse urls: {}", e))?;
            let result = crate::commands::datasets::resolve_syft_urls_batch(urls)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "subscribe_dataset" => {
            let owner: String = serde_json::from_value(
                args.get("owner")
                    .cloned()
                    .ok_or_else(|| "Missing owner".to_string())?,
            )
            .map_err(|e| format!("Failed to parse owner: {}", e))?;
            let name: String = serde_json::from_value(
                args.get("name")
                    .cloned()
                    .ok_or_else(|| "Missing name".to_string())?,
            )
            .map_err(|e| format!("Failed to parse name: {}", e))?;
            let result = crate::commands::datasets::subscribe_dataset(owner, name)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "unsubscribe_dataset" => {
            let owner: String = serde_json::from_value(
                args.get("owner")
                    .cloned()
                    .ok_or_else(|| "Missing owner".to_string())?,
            )
            .map_err(|e| format!("Failed to parse owner: {}", e))?;
            let name: String = serde_json::from_value(
                args.get("name")
                    .cloned()
                    .ok_or_else(|| "Missing name".to_string())?,
            )
            .map_err(|e| format!("Failed to parse name: {}", e))?;
            let result = crate::commands::datasets::unsubscribe_dataset(owner, name)?;
            Ok(serde_json::to_value(result).unwrap())
        }

        // =====================================================================
        // Additional File Commands
        // =====================================================================
        "is_directory" => {
            let path: String = serde_json::from_value(
                args.get("path")
                    .cloned()
                    .ok_or_else(|| "Missing path".to_string())?,
            )
            .map_err(|e| format!("Failed to parse path: {}", e))?;
            let result = crate::commands::files::is_directory(path)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "delete_file" => {
            let file_id: i64 = serde_json::from_value(
                args.get("fileId")
                    .or_else(|| args.get("file_id"))
                    .cloned()
                    .ok_or_else(|| "Missing fileId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse fileId: {}", e))?;
            crate::commands::files::delete_file(state.clone(), file_id)?;
            Ok(serde_json::Value::Null)
        }
        "delete_files_bulk" => {
            let file_ids: Vec<i64> = serde_json::from_value(
                args.get("fileIds")
                    .or_else(|| args.get("file_ids"))
                    .cloned()
                    .ok_or_else(|| "Missing fileIds".to_string())?,
            )
            .map_err(|e| format!("Failed to parse fileIds: {}", e))?;
            let result = crate::commands::files::delete_files_bulk(state.clone(), file_ids)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "analyze_file_types" => {
            let files: Vec<String> = serde_json::from_value(
                args.get("files")
                    .cloned()
                    .ok_or_else(|| "Missing files".to_string())?,
            )
            .map_err(|e| format!("Failed to parse files: {}", e))?;
            let result = crate::commands::files::analyze_file_types(state.clone(), files).await?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "import_files" => {
            let files: Vec<String> = serde_json::from_value(
                args.get("files")
                    .cloned()
                    .ok_or_else(|| "Missing files".to_string())?,
            )
            .map_err(|e| format!("Failed to parse files: {}", e))?;
            let pattern: String = serde_json::from_value(
                args.get("pattern")
                    .cloned()
                    .ok_or_else(|| "Missing pattern".to_string())?,
            )
            .map_err(|e| format!("Failed to parse pattern: {}", e))?;
            let file_id_map: std::collections::HashMap<String, String> = args
                .get("fileIdMap")
                .or_else(|| args.get("file_id_map"))
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_default();
            let result =
                crate::commands::files::import_files(state.clone(), files, pattern, file_id_map)
                    .await?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "import_files_with_metadata" => {
            let file_metadata: std::collections::HashMap<
                String,
                crate::commands::files::FileMetadata,
            > = serde_json::from_value(
                args.get("fileMetadata")
                    .or_else(|| args.get("file_metadata"))
                    .cloned()
                    .ok_or_else(|| "Missing fileMetadata".to_string())?,
            )
            .map_err(|e| format!("Failed to parse fileMetadata: {}", e))?;
            let result =
                crate::commands::files::import_files_with_metadata(state.clone(), file_metadata)
                    .await?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "process_queue" => {
            let limit: usize = args
                .get("limit")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or(100);
            let result = crate::commands::files::process_queue(state.clone(), limit).await?;
            Ok(result)
        }
        "pause_queue_processor" => {
            let result = crate::commands::files::pause_queue_processor(state.clone())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "resume_queue_processor" => {
            let result = crate::commands::files::resume_queue_processor(state.clone())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "clear_pending_queue" => {
            let result = crate::commands::files::clear_pending_queue(state.clone())?;
            Ok(serde_json::to_value(result).unwrap())
        }

        // =====================================================================
        // Additional Participant Commands
        // =====================================================================
        "delete_participant" => {
            let participant_id: i64 = serde_json::from_value(
                args.get("participantId")
                    .or_else(|| args.get("participant_id"))
                    .cloned()
                    .ok_or_else(|| "Missing participantId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse participantId: {}", e))?;
            crate::commands::participants::delete_participant(state.clone(), participant_id)?;
            Ok(serde_json::Value::Null)
        }
        "delete_participants_bulk" => {
            let participant_ids: Vec<i64> = serde_json::from_value(
                args.get("participantIds")
                    .or_else(|| args.get("participant_ids"))
                    .cloned()
                    .ok_or_else(|| "Missing participantIds".to_string())?,
            )
            .map_err(|e| format!("Failed to parse participantIds: {}", e))?;
            let result = crate::commands::participants::delete_participants_bulk(
                state.clone(),
                participant_ids,
            )?;
            Ok(serde_json::to_value(result).unwrap())
        }

        // =====================================================================
        // Additional Message Commands
        // =====================================================================
        "dismiss_failed_message" => {
            let id: String = serde_json::from_value(
                args.get("id")
                    .cloned()
                    .ok_or_else(|| "Missing id".to_string())?,
            )
            .map_err(|e| format!("Failed to parse id: {}", e))?;
            let result = crate::commands::messages::dismiss_failed_message(id)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "delete_failed_message" => {
            let id: String = serde_json::from_value(
                args.get("id")
                    .cloned()
                    .ok_or_else(|| "Missing id".to_string())?,
            )
            .map_err(|e| format!("Failed to parse id: {}", e))?;
            let result = crate::commands::messages::delete_failed_message(id)?;
            Ok(serde_json::to_value(result).unwrap())
        }

        // =====================================================================
        // Additional Module Commands
        // =====================================================================
        "import_module" => {
            let url: String = serde_json::from_value(
                args.get("url")
                    .cloned()
                    .ok_or_else(|| "Missing url".to_string())?,
            )
            .map_err(|e| format!("Failed to parse url: {}", e))?;
            let overwrite: bool = args
                .get("overwrite")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or(false);
            let result = crate::commands::modules::import_module(state.clone(), url, overwrite)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "import_module_from_folder" => {
            let folder_path: String = serde_json::from_value(
                args.get("folderPath")
                    .or_else(|| args.get("folder_path"))
                    .cloned()
                    .ok_or_else(|| "Missing folderPath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse folderPath: {}", e))?;
            let result =
                crate::commands::modules::import_module_from_folder(state.clone(), folder_path)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "delete_module" => {
            let module_id: i64 = serde_json::from_value(
                args.get("moduleId")
                    .or_else(|| args.get("module_id"))
                    .cloned()
                    .ok_or_else(|| "Missing moduleId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse moduleId: {}", e))?;
            crate::commands::modules::delete_module(state.clone(), module_id)?;
            Ok(serde_json::Value::Null)
        }
        "delete_module_folder" => {
            let module_path: String = serde_json::from_value(
                args.get("modulePath")
                    .or_else(|| args.get("module_path"))
                    .cloned()
                    .ok_or_else(|| "Missing modulePath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse modulePath: {}", e))?;
            crate::commands::modules::delete_module_folder(module_path)?;
            Ok(serde_json::Value::Null)
        }
        "preview_module_spec" => {
            let payload: serde_json::Value = args
                .get("payload")
                .cloned()
                .ok_or_else(|| "Missing payload".to_string())?;
            let result = crate::commands::modules::preview_module_spec(payload)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_module_spec_digest" => {
            let module_path: String = serde_json::from_value(
                args.get("modulePath")
                    .or_else(|| args.get("module_path"))
                    .cloned()
                    .ok_or_else(|| "Missing modulePath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse modulePath: {}", e))?;
            let result = crate::commands::modules::get_module_spec_digest(module_path)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_supported_input_types" => {
            let result = crate::commands::modules::get_supported_input_types();
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_supported_output_types" => {
            let result = crate::commands::modules::get_supported_output_types();
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_supported_parameter_types" => {
            let result = crate::commands::modules::get_supported_parameter_types();
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_common_formats" => {
            let result = crate::commands::modules::get_common_formats();
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_local_flow_templates" => {
            let result = crate::commands::modules::get_local_flow_templates();
            Ok(serde_json::to_value(result).unwrap())
        }

        // =====================================================================
        // Additional Run Commands
        // =====================================================================
        "start_analysis" => {
            let participant_ids: Vec<i64> = serde_json::from_value(
                args.get("participantIds")
                    .or_else(|| args.get("participant_ids"))
                    .cloned()
                    .ok_or_else(|| "Missing participantIds".to_string())?,
            )
            .map_err(|e| format!("Failed to parse participantIds: {}", e))?;
            let module_id: i64 = serde_json::from_value(
                args.get("moduleId")
                    .or_else(|| args.get("module_id"))
                    .cloned()
                    .ok_or_else(|| "Missing moduleId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse moduleId: {}", e))?;
            let result =
                crate::commands::runs::start_analysis(state.clone(), participant_ids, module_id)?;
            Ok(serde_json::to_value(result).unwrap())
        }

        // =====================================================================
        // Additional Flow Commands
        // =====================================================================
        "load_flow_editor" => {
            let flow_id: Option<i64> = args
                .get("flowId")
                .or_else(|| args.get("flow_id"))
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            let flow_path: Option<String> = args
                .get("flowPath")
                .or_else(|| args.get("flow_path"))
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            let result =
                crate::commands::flows::load_flow_editor(state.clone(), flow_id, flow_path).await?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "save_flow_editor" => {
            let flow_id: Option<i64> = args
                .get("flowId")
                .or_else(|| args.get("flow_id"))
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            let flow_path: String = serde_json::from_value(
                args.get("flowPath")
                    .or_else(|| args.get("flow_path"))
                    .cloned()
                    .ok_or_else(|| "Missing flowPath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse flowPath: {}", e))?;
            let spec: crate::commands::flows::FlowSpec = serde_json::from_value(
                args.get("spec")
                    .cloned()
                    .ok_or_else(|| "Missing spec".to_string())?,
            )
            .map_err(|e| format!("Failed to parse spec: {}", e))?;
            let result =
                crate::commands::flows::save_flow_editor(state.clone(), flow_id, flow_path, spec)
                    .await?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "save_flow_yaml" => {
            let flow_id: Option<i64> = args
                .get("flowId")
                .or_else(|| args.get("flow_id"))
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            let flow_path: String = serde_json::from_value(
                args.get("flowPath")
                    .or_else(|| args.get("flow_path"))
                    .cloned()
                    .ok_or_else(|| "Missing flowPath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse flowPath: {}", e))?;
            let raw_yaml: String = serde_json::from_value(
                args.get("rawYaml")
                    .or_else(|| args.get("raw_yaml"))
                    .cloned()
                    .ok_or_else(|| "Missing rawYaml".to_string())?,
            )
            .map_err(|e| format!("Failed to parse rawYaml: {}", e))?;
            let result =
                crate::commands::flows::save_flow_yaml(state.clone(), flow_id, flow_path, raw_yaml)
                    .await?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "delete_flow" => {
            let flow_id: i64 = serde_json::from_value(
                args.get("flowId")
                    .or_else(|| args.get("flow_id"))
                    .cloned()
                    .ok_or_else(|| "Missing flowId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse flowId: {}", e))?;
            crate::commands::flows::delete_flow(state.clone(), flow_id).await?;
            Ok(serde_json::Value::Null)
        }
        "validate_flow" => {
            let flow_path: String = serde_json::from_value(
                args.get("flowPath")
                    .or_else(|| args.get("flow_path"))
                    .cloned()
                    .ok_or_else(|| "Missing flowPath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse flowPath: {}", e))?;
            let result = crate::commands::flows::validate_flow(flow_path).await?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "delete_flow_run" => {
            let run_id: i64 = serde_json::from_value(
                args.get("runId")
                    .or_else(|| args.get("run_id"))
                    .cloned()
                    .ok_or_else(|| "Missing runId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse runId: {}", e))?;
            crate::commands::flows::delete_flow_run(state.clone(), run_id).await?;
            Ok(serde_json::Value::Null)
        }
        "preview_flow_spec" => {
            let spec: crate::commands::flows::FlowSpec = serde_json::from_value(
                args.get("spec")
                    .cloned()
                    .ok_or_else(|| "Missing spec".to_string())?,
            )
            .map_err(|e| format!("Failed to parse spec: {}", e))?;
            let result = crate::commands::flows::preview_flow_spec(spec).await?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "save_run_config" => {
            let flow_id: i64 = serde_json::from_value(
                args.get("flowId")
                    .or_else(|| args.get("flow_id"))
                    .cloned()
                    .ok_or_else(|| "Missing flowId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse flowId: {}", e))?;
            let name: String = serde_json::from_value(
                args.get("name")
                    .cloned()
                    .ok_or_else(|| "Missing name".to_string())?,
            )
            .map_err(|e| format!("Failed to parse name: {}", e))?;
            let config_data: serde_json::Value = args
                .get("configData")
                .or_else(|| args.get("config_data"))
                .cloned()
                .ok_or_else(|| "Missing configData".to_string())?;
            let result =
                crate::commands::flows::save_run_config(state.clone(), flow_id, name, config_data)
                    .await?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "list_run_configs" => {
            let flow_id: i64 = serde_json::from_value(
                args.get("flowId")
                    .or_else(|| args.get("flow_id"))
                    .cloned()
                    .ok_or_else(|| "Missing flowId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse flowId: {}", e))?;
            let result = crate::commands::flows::list_run_configs(state.clone(), flow_id).await?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_run_config" => {
            let config_id: i64 = serde_json::from_value(
                args.get("configId")
                    .or_else(|| args.get("config_id"))
                    .cloned()
                    .ok_or_else(|| "Missing configId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse configId: {}", e))?;
            let result = crate::commands::flows::get_run_config(state.clone(), config_id).await?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "delete_run_config" => {
            let config_id: i64 = serde_json::from_value(
                args.get("configId")
                    .or_else(|| args.get("config_id"))
                    .cloned()
                    .ok_or_else(|| "Missing configId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse configId: {}", e))?;
            crate::commands::flows::delete_run_config(state.clone(), config_id).await?;
            Ok(serde_json::Value::Null)
        }

        // =====================================================================
        // Additional Session Commands
        // =====================================================================
        "create_session_with_datasets" => {
            let request: crate::types::CreateSessionRequest = serde_json::from_value(
                args.get("request")
                    .cloned()
                    .ok_or_else(|| "Missing request".to_string())?,
            )
            .map_err(|e| format!("Failed to parse request: {}", e))?;
            let datasets: Vec<String> = serde_json::from_value(
                args.get("datasets")
                    .cloned()
                    .ok_or_else(|| "Missing datasets".to_string())?,
            )
            .map_err(|e| format!("Failed to parse datasets: {}", e))?;
            let result =
                crate::commands::sessions::create_session_with_datasets(request, datasets)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "update_session_peer" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .or_else(|| args.get("session_id"))
                    .cloned()
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let peer: Option<String> = args
                .get("peer")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            let result = crate::commands::sessions::update_session_peer(session_id, peer)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_session_messages" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .or_else(|| args.get("session_id"))
                    .cloned()
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let result = crate::commands::sessions::get_session_messages(session_id)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "send_session_message" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .or_else(|| args.get("session_id"))
                    .cloned()
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let body: String = serde_json::from_value(
                args.get("body")
                    .cloned()
                    .ok_or_else(|| "Missing body".to_string())?,
            )
            .map_err(|e| format!("Failed to parse body: {}", e))?;
            let result = crate::commands::sessions::send_session_message(session_id, body)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "open_session_folder" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .or_else(|| args.get("session_id"))
                    .cloned()
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            crate::commands::sessions::open_session_folder(session_id)?;
            Ok(serde_json::Value::Null)
        }
        "add_files_to_session" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .or_else(|| args.get("session_id"))
                    .cloned()
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let file_paths: Vec<String> = serde_json::from_value(
                args.get("filePaths")
                    .or_else(|| args.get("file_paths"))
                    .cloned()
                    .ok_or_else(|| "Missing filePaths".to_string())?,
            )
            .map_err(|e| format!("Failed to parse filePaths: {}", e))?;
            let result = crate::commands::sessions::add_files_to_session(session_id, file_paths)?;
            Ok(serde_json::to_value(result).unwrap())
        }

        // =====================================================================
        // Additional Key Commands
        // =====================================================================
        "key_republish" => {
            let email: Option<String> = args
                .get("email")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            let result = crate::commands::key::key_republish(email)?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "key_refresh_contacts" => {
            let result = crate::commands::key::key_refresh_contacts(state.clone()).await?;
            Ok(serde_json::to_value(result).unwrap())
        }

        // =====================================================================
        // Additional Network Commands
        // =====================================================================
        "network_remove_contact" => {
            let identity: String = serde_json::from_value(
                args.get("identity")
                    .cloned()
                    .ok_or_else(|| "Missing identity".to_string())?,
            )
            .map_err(|e| format!("Failed to parse identity: {}", e))?;
            crate::commands::key::network_remove_contact(identity)?;
            Ok(serde_json::Value::Null)
        }
        "network_trust_changed_key" => {
            let identity: String = serde_json::from_value(
                args.get("identity")
                    .cloned()
                    .ok_or_else(|| "Missing identity".to_string())?,
            )
            .map_err(|e| format!("Failed to parse identity: {}", e))?;
            let result = crate::commands::key::network_trust_changed_key(identity)?;
            Ok(serde_json::to_value(result).unwrap())
        }

        // =====================================================================
        // Additional Dataset Commands
        // =====================================================================
        "upsert_dataset_manifest" => {
            let manifest: biovault::cli::commands::datasets::DatasetManifest =
                serde_json::from_value(
                    args.get("manifest")
                        .cloned()
                        .ok_or_else(|| "Missing manifest".to_string())?,
                )
                .map_err(|e| format!("Failed to parse manifest: {}", e))?;
            let result =
                crate::commands::datasets::upsert_dataset_manifest(state.clone(), manifest)?;
            Ok(serde_json::to_value(result).unwrap())
        }

        // =====================================================================
        // Additional SQL Commands
        // =====================================================================
        "sql_export_query" => {
            let query: String = serde_json::from_value(
                args.get("query")
                    .cloned()
                    .ok_or_else(|| "Missing query".to_string())?,
            )
            .map_err(|e| format!("Failed to parse query: {}", e))?;
            let destination: String = serde_json::from_value(
                args.get("destination")
                    .cloned()
                    .ok_or_else(|| "Missing destination".to_string())?,
            )
            .map_err(|e| format!("Failed to parse destination: {}", e))?;
            let options: Option<crate::commands::sql::SqlExportOptions> = args
                .get("options")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            let result =
                crate::commands::sql::sql_export_query(state.clone(), query, destination, options)?;
            Ok(serde_json::to_value(result).unwrap())
        }

        // Multiparty flow commands
        "send_flow_invitation" => {
            let thread_id: String = serde_json::from_value(
                args.get("threadId")
                    .cloned()
                    .ok_or_else(|| "Missing threadId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse threadId: {}", e))?;
            let flow_name: String = serde_json::from_value(
                args.get("flowName")
                    .cloned()
                    .ok_or_else(|| "Missing flowName".to_string())?,
            )
            .map_err(|e| format!("Failed to parse flowName: {}", e))?;
            let flow_spec: serde_json::Value = args
                .get("flowSpec")
                .cloned()
                .ok_or_else(|| "Missing flowSpec".to_string())?;
            let participant_roles: Vec<biovault::messages::models::FlowParticipant> =
                serde_json::from_value(
                    args.get("participantRoles")
                        .cloned()
                        .ok_or_else(|| "Missing participantRoles".to_string())?,
                )
                .map_err(|e| format!("Failed to parse participantRoles: {}", e))?;
            let result = crate::commands::multiparty::send_flow_invitation(
                state.clone(),
                thread_id,
                flow_name,
                flow_spec,
                participant_roles,
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "accept_flow_invitation" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let flow_name: String = serde_json::from_value(
                args.get("flowName")
                    .cloned()
                    .ok_or_else(|| "Missing flowName".to_string())?,
            )
            .map_err(|e| format!("Failed to parse flowName: {}", e))?;
            let flow_spec: serde_json::Value = args
                .get("flowSpec")
                .cloned()
                .ok_or_else(|| "Missing flowSpec".to_string())?;
            let participants: Vec<biovault::messages::models::FlowParticipant> =
                serde_json::from_value(
                    args.get("participants")
                        .cloned()
                        .ok_or_else(|| "Missing participants".to_string())?,
                )
                .map_err(|e| format!("Failed to parse participants: {}", e))?;
            let auto_run_all: bool = args
                .get("autoRunAll")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or(false);
            let thread_id: Option<String> = args
                .get("threadId")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let input_overrides: Option<std::collections::HashMap<String, String>> = args
                .get("inputOverrides")
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()
                .map_err(|e| format!("Failed to parse inputOverrides: {}", e))?;
            let result = crate::commands::multiparty::accept_flow_invitation(
                state.clone(),
                session_id,
                flow_name,
                flow_spec,
                participants,
                auto_run_all,
                thread_id,
                input_overrides,
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_multiparty_flow_state" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let result =
                crate::commands::multiparty::get_multiparty_flow_state(state.clone(), session_id)
                    .await
                    .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_all_participant_progress" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let result = crate::commands::multiparty::get_all_participant_progress(session_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_participant_logs" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let result = crate::commands::multiparty::get_participant_logs(session_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_multiparty_step_diagnostics" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let step_id: String = serde_json::from_value(
                args.get("stepId")
                    .cloned()
                    .ok_or_else(|| "Missing stepId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse stepId: {}", e))?;
            let result =
                crate::commands::multiparty::get_multiparty_step_diagnostics(session_id, step_id)
                    .await
                    .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_multiparty_step_logs" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let step_id: String = serde_json::from_value(
                args.get("stepId")
                    .cloned()
                    .ok_or_else(|| "Missing stepId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse stepId: {}", e))?;
            let lines: Option<usize> = args
                .get("lines")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            let result = crate::commands::multiparty::get_multiparty_step_logs(
                state.clone(),
                session_id,
                step_id,
                lines,
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "set_step_auto_run" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let step_id: String = serde_json::from_value(
                args.get("stepId")
                    .cloned()
                    .ok_or_else(|| "Missing stepId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse stepId: {}", e))?;
            let auto_run: bool = serde_json::from_value(
                args.get("autoRun")
                    .cloned()
                    .ok_or_else(|| "Missing autoRun".to_string())?,
            )
            .map_err(|e| format!("Failed to parse autoRun: {}", e))?;
            crate::commands::multiparty::set_step_auto_run(session_id, step_id, auto_run)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "run_flow_step" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let step_id: String = serde_json::from_value(
                args.get("stepId")
                    .cloned()
                    .ok_or_else(|| "Missing stepId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse stepId: {}", e))?;
            let force: Option<bool> = args
                .get("force")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            let result = crate::commands::multiparty::run_flow_step(
                state.clone(),
                session_id,
                step_id,
                force,
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "force_complete_flow_step" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let step_id: String = serde_json::from_value(
                args.get("stepId")
                    .cloned()
                    .ok_or_else(|| "Missing stepId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse stepId: {}", e))?;
            let result = crate::commands::multiparty::force_complete_flow_step(
                state.clone(),
                session_id,
                step_id,
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "share_step_outputs" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let step_id: String = serde_json::from_value(
                args.get("stepId")
                    .cloned()
                    .ok_or_else(|| "Missing stepId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse stepId: {}", e))?;
            crate::commands::multiparty::share_step_outputs(state.clone(), session_id, step_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "share_step_outputs_to_chat" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let step_id: String = serde_json::from_value(
                args.get("stepId")
                    .cloned()
                    .ok_or_else(|| "Missing stepId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse stepId: {}", e))?;
            let result = crate::commands::multiparty::share_step_outputs_to_chat(
                state.clone(),
                session_id,
                step_id,
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_step_output_files" => {
            let session_id: String = serde_json::from_value(
                args.get("sessionId")
                    .cloned()
                    .ok_or_else(|| "Missing sessionId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse sessionId: {}", e))?;
            let step_id: String = serde_json::from_value(
                args.get("stepId")
                    .cloned()
                    .ok_or_else(|| "Missing stepId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse stepId: {}", e))?;
            let result = crate::commands::multiparty::get_step_output_files(session_id, step_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }

        _ => {
            crate::desktop_log!("⚠️  Unhandled command: {}", cmd);
            Err(format!("Unhandled command: {}", cmd))
        }
    }
}

async fn bind_listener(addr: SocketAddr) -> Result<TcpListener, Box<dyn std::error::Error>> {
    // During profile switching, the app may restart quickly and attempt to re-bind the same port
    // while the previous process is still winding down. Retry a few times to reduce flakiness.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let listener = loop {
        match TcpListener::bind(&addr).await {
            Ok(listener) => break listener,
            Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(Box::new(err));
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            Err(err) => return Err(Box::new(err)),
        }
    };

    Ok(listener)
}

pub async fn start_ws_server_with_shutdown(
    app: AppHandle,
    port: u16,
    mut shutdown: watch::Receiver<bool>,
) -> Result<tokio::task::JoinHandle<()>, Box<dyn std::error::Error>> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let listener = bind_listener(addr).await?;

    crate::desktop_log!("🚀 WebSocket server listening on ws://{}", addr);
    crate::desktop_log!("📝 Browser mode: Commands will be proxied via WebSocket");

    let app = Arc::new(app);
    let handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown.changed() => {
                    break;
                }
                incoming = listener.accept() => {
                    match incoming {
                        Ok((stream, _)) => {
                            let app_clone = Arc::clone(&app);
                            tokio::spawn(handle_connection(stream, app_clone));
                        }
                        Err(err) => {
                            crate::desktop_log!("⚠️ WS bridge accept failed: {}", err);
                            break;
                        }
                    }
                }
            }
        }
    });

    Ok(handle)
}

pub async fn start_http_server_with_shutdown(
    app: AppHandle,
    port: u16,
    mut shutdown: watch::Receiver<bool>,
) -> Result<tokio::task::JoinHandle<()>, Box<dyn std::error::Error>> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let listener = bind_listener(addr).await?;

    crate::desktop_log!("🌐 HTTP bridge listening on http://{}", addr);

    let app = Arc::new(app);
    let handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown.changed() => {
                    break;
                }
                incoming = listener.accept() => {
                    match incoming {
                        Ok((stream, _)) => {
                            let app_clone = Arc::clone(&app);
                            tokio::spawn(handle_http_connection(stream, app_clone));
                        }
                        Err(err) => {
                            crate::desktop_log!("⚠️ HTTP bridge accept failed: {}", err);
                            break;
                        }
                    }
                }
            }
        }
    });

    Ok(handle)
}

pub async fn restart_agent_bridge(
    app: AppHandle,
    ws_port: u16,
    http_port: u16,
    enabled: bool,
) -> Result<(), String> {
    {
        let mut manager = BRIDGE_MANAGER
            .lock()
            .map_err(|_| "Failed to lock bridge manager".to_string())?;
        manager.stop_all();
    }

    if !enabled {
        crate::desktop_log!("WS bridge disabled by environment or settings");
        return Ok(());
    }

    let (ws_shutdown_tx, ws_shutdown_rx) = watch::channel(false);
    let ws_handle = start_ws_server_with_shutdown(app.clone(), ws_port, ws_shutdown_rx)
        .await
        .map_err(|e| format!("Failed to start WebSocket bridge: {}", e))?;

    let mut http_task: Option<BridgeTask> = None;
    if http_port > 0 {
        let (http_shutdown_tx, http_shutdown_rx) = watch::channel(false);
        match start_http_server_with_shutdown(app, http_port, http_shutdown_rx).await {
            Ok(handle) => {
                http_task = Some(BridgeTask {
                    shutdown: http_shutdown_tx,
                    handle,
                    port: http_port,
                });
            }
            Err(err) => {
                let _ = ws_shutdown_tx.send(true);
                ws_handle.abort();
                return Err(format!("Failed to start HTTP bridge: {}", err));
            }
        }
    }

    let mut manager = BRIDGE_MANAGER
        .lock()
        .map_err(|_| "Failed to lock bridge manager".to_string())?;
    manager.ws = Some(BridgeTask {
        shutdown: ws_shutdown_tx,
        handle: ws_handle,
        port: ws_port,
    });
    manager.http = http_task;

    Ok(())
}
