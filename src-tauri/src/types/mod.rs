use biovault::data::{ModuleFileNode, ModuleMetadata};
use biovault::defaults::SYFTBOX_DEFAULT_SERVER_URL;
use biovault::messages::MessageRpcWatcherHandle;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use biovault::data::BioVaultDb;

pub const DEFAULT_SYFTBOX_SERVER_URL: &str = SYFTBOX_DEFAULT_SERVER_URL;

// Application State
pub struct AppState {
    #[allow(dead_code)] // Deprecated - all tables now in biovault_db
    pub db: Mutex<Connection>,
    pub biovault_db: Arc<Mutex<BioVaultDb>>,
    pub queue_processor_paused: Arc<AtomicBool>,
    pub message_watcher: Mutex<Option<MessageRpcWatcherHandle>>,
}

// Settings
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    pub docker_path: String,
    pub java_path: String,
    pub syftbox_path: String,
    pub biovault_path: String,
    pub email: String,
    pub ai_api_url: String,
    pub ai_api_token: String,
    pub ai_model: String,
    pub syftbox_server_url: String,
    /// Enable the WebSocket agent bridge (default: true in dev mode)
    #[serde(default = "default_agent_bridge_enabled")]
    pub agent_bridge_enabled: bool,
    /// WebSocket agent bridge port (default: 3333)
    #[serde(default = "default_agent_bridge_port")]
    pub agent_bridge_port: u16,
    /// HTTP fallback port for the agent bridge (default: 3334)
    #[serde(default = "default_agent_bridge_http_port")]
    pub agent_bridge_http_port: u16,
    /// Optional authentication token for the agent bridge
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_bridge_token: Option<String>,
    /// Blocked agent bridge commands
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agent_bridge_blocklist: Vec<String>,
}

fn default_agent_bridge_enabled() -> bool {
    true
}

fn default_agent_bridge_port() -> u16 {
    3333
}

fn default_agent_bridge_http_port() -> u16 {
    3334
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            docker_path: String::from("/usr/local/bin/docker"),
            java_path: String::from("/usr/bin/java"),
            syftbox_path: String::from("/usr/local/bin/syftbox"),
            biovault_path: String::from("bv"),
            email: String::new(),
            ai_api_url: "https://openrouter.ai/api/v1/chat/completions".to_string(),
            ai_api_token: String::new(),
            ai_model: "openrouter/auto".to_string(),
            syftbox_server_url: DEFAULT_SYFTBOX_SERVER_URL.to_string(),
            agent_bridge_enabled: default_agent_bridge_enabled(),
            agent_bridge_port: default_agent_bridge_port(),
            agent_bridge_http_port: default_agent_bridge_http_port(),
            agent_bridge_token: None,
            agent_bridge_blocklist: Vec::new(),
        }
    }
}

// File Import Types
#[derive(Serialize, Deserialize)]
pub struct SampleExtraction {
    pub path: String,
    pub participant_id: String,
}

#[derive(Serialize, Deserialize)]
pub struct PatternSuggestion {
    pub pattern: String,
    pub regex_pattern: String,
    pub description: String,
    pub example: String,
    pub sample_extractions: Vec<SampleExtraction>,
}

#[derive(Serialize, Deserialize)]
pub struct ExtensionCount {
    pub extension: String,
    pub count: usize,
}

#[derive(Serialize)]
pub struct ImportResult {
    pub success: bool,
    pub message: String,
    pub conflicts: Vec<FileConflict>,
    pub imported_files: Vec<FileRecord>,
}

#[derive(Serialize)]
pub struct FileConflict {
    pub path: String,
    pub existing_hash: String,
    pub new_hash: String,
}

// Participant Types
#[derive(Serialize, Deserialize, Clone)]
pub struct Participant {
    pub id: i64,
    pub participant_id: String,
    pub created_at: String,
    pub file_count: i64,
}

// File Types
#[derive(Serialize, Deserialize)]
pub struct FileRecord {
    pub id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub participant_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub participant_name: Option<String>,
    pub file_path: String,
    pub file_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grch_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chromosome_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inferred_sex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processing_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// Module Types
#[derive(Serialize, Deserialize)]
pub struct Module {
    pub id: i64,
    pub name: String,
    pub version: String,
    pub author: String,
    pub workflow: String,
    pub template: String,
    pub module_path: String,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct ModuleListEntry {
    pub id: Option<i64>,
    pub name: String,
    pub version: Option<String>,
    pub author: Option<String>,
    pub workflow: Option<String>,
    pub template: Option<String>,
    pub module_path: String,
    pub created_at: Option<String>,
    pub source: String,
    pub orphaned: bool,
}

#[derive(Serialize)]
pub struct ModuleEditorLoadResponse {
    pub module_id: Option<i64>,
    pub module_path: String,
    pub metadata: ModuleMetadata,
    pub file_tree: Vec<ModuleFileNode>,
    pub has_module_yaml: bool,
}

// Run Types
#[derive(Serialize)]
pub struct Run {
    pub id: i64,
    pub module_id: i64,
    pub module_name: String,
    pub work_dir: String,
    pub participant_count: i64,
    pub status: String,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct RunStartResult {
    pub run_id: i64,
    pub work_dir: String,
}

// Message Types
#[derive(Serialize)]
pub struct MessageSyncResult {
    pub new_message_ids: Vec<String>,
    pub new_messages: usize,
}

#[derive(Deserialize)]
pub struct MessageSendRequest {
    pub to: Option<String>,
    /// Multiple recipients for group messages (if set, takes precedence over `to`)
    #[serde(default)]
    pub recipients: Option<Vec<String>>,
    pub body: String,
    pub subject: Option<String>,
    pub reply_to: Option<String>,
    #[serde(default)]
    pub message_type: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Serialize)]
pub struct MessageThreadSummary {
    pub thread_id: String,
    pub subject: String,
    pub participants: Vec<String>,
    pub unread_count: usize,
    pub last_message_at: Option<String>,
    pub last_message_preview: String,
    pub has_module: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageFilterScope {
    Inbox,
    Sent,
    All,
}

/// Batched result for refresh_messages_batched: sync + list in one call
#[derive(Serialize)]
pub struct BatchedMessageRefreshResult {
    /// Sync results
    pub new_message_ids: Vec<String>,
    pub new_messages: usize,
    pub new_failed: usize,
    pub total_failed: usize,
    /// Thread list
    pub threads: Vec<MessageThreadSummary>,
}

// Jupyter Types
#[derive(Serialize)]
pub struct JupyterStatus {
    pub running: bool,
    pub port: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

#[derive(Serialize)]
pub struct JupyterResetResult {
    pub status: JupyterStatus,
    pub message: String,
}

pub const DEFAULT_JUPYTER_PYTHON: &str = "3.12";

// SyftBox Types
#[derive(Serialize, Deserialize, Clone)]
pub struct SyftBoxState {
    pub running: bool,
    pub mode: String,
    pub backend: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_url: Option<String>,
    #[serde(default)]
    pub tx_bytes: u64,
    #[serde(default)]
    pub rx_bytes: u64,
}

#[derive(Serialize)]
pub struct SyftBoxConfigInfo {
    pub is_authenticated: bool,
    pub config_path: String,
    pub has_access_token: bool,
    pub has_refresh_token: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_dir_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
}

// Sync Tree Types
#[derive(Serialize, Clone)]
pub struct SyncTreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub sync_state: String,
    pub conflict_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    pub is_ignored: bool,
    pub is_essential: bool,
    pub is_subscribed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_count: Option<u32>,
    pub has_mixed_state: bool,
    pub has_mixed_ignore: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
}

#[derive(Serialize)]
pub struct SyncTreeDetails {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_count: Option<u32>,
    pub sync_state: String,
    pub conflict_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub error_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_synced: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_etag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uploaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    pub is_ignored: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ignore_pattern: Option<String>,
    pub is_essential: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub essential_pattern: Option<String>,
    pub is_priority: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub syft_pub_info: Option<SyftPubInfo>,
}

#[derive(Serialize, Clone)]
pub struct SyftPubInfo {
    pub permissions: Vec<SyftPubPermission>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct SyftPubPermission {
    pub user: String,
    pub access: String,
    pub is_wildcard: bool,
}

#[derive(Serialize)]
pub struct SyncIgnorePatterns {
    pub default_patterns: Vec<String>,
    pub custom_patterns: Vec<String>,
    pub syftignore_path: String,
}

#[derive(Serialize, Clone)]
pub struct SharedWithMeItem {
    pub owner: String,
    pub path: String,
    pub description: Option<String>,
    pub access: String,
    pub is_subscribed: bool,
}

// Log Types
#[derive(Serialize, Deserialize, Clone)]
pub struct LogEntry {
    pub timestamp: String,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// Session Types
#[derive(Serialize, Deserialize, Clone)]
pub struct Session {
    pub id: i64,
    pub session_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub session_path: String,
    pub owner: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer: Option<String>,
    pub role: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jupyter_port: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jupyter_pid: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jupyter_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jupyter_token: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
pub struct CreateSessionRequest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub peer: Option<String>,
}

#[derive(Serialize)]
pub struct SessionJupyterStatus {
    pub session_id: String,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SessionMessage {
    pub id: i64,
    pub session_id: i64,
    pub sender: String,
    pub body: String,
    pub created_at: String,
}
