use biovault::data::{ProjectFileNode, ProjectMetadata};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use biovault::data::BioVaultDb;

// Application State
pub struct AppState {
    pub db: Mutex<Connection>,
    pub biovault_db: Arc<Mutex<BioVaultDb>>,
    pub queue_processor_paused: Arc<AtomicBool>,
}

// Settings
#[derive(Serialize, Deserialize, Clone)]
pub struct Settings {
    pub docker_path: String,
    pub java_path: String,
    pub syftbox_path: String,
    pub biovault_path: String,
    pub email: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            docker_path: String::from("/usr/local/bin/docker"),
            java_path: String::from("/usr/bin/java"),
            syftbox_path: String::from("/usr/local/bin/syftbox"),
            biovault_path: String::from("bv"),
            email: String::new(),
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

#[derive(Serialize, Deserialize, Debug)]
pub struct FileMetadata {
    pub participant_id: Option<String>,
    pub data_type: Option<String>,
    pub source: Option<String>,
    pub grch_version: Option<String>,
    pub row_count: Option<i64>,
    pub chromosome_count: Option<i64>,
    pub inferred_sex: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct GenotypeMetadata {
    pub data_type: String,
    pub source: Option<String>,
    pub grch_version: Option<String>,
    pub row_count: Option<i64>,
    pub chromosome_count: Option<i64>,
    pub inferred_sex: Option<String>,
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

// Project Types
#[derive(Serialize, Deserialize)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub author: String,
    pub workflow: String,
    pub template: String,
    pub project_path: String,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct ProjectListEntry {
    pub id: Option<i64>,
    pub name: String,
    pub author: Option<String>,
    pub workflow: Option<String>,
    pub template: Option<String>,
    pub project_path: String,
    pub created_at: Option<String>,
    pub source: String,
    pub orphaned: bool,
}

#[derive(Serialize)]
pub struct ProjectEditorLoadResponse {
    pub project_id: Option<i64>,
    pub project_path: String,
    pub metadata: ProjectMetadata,
    pub file_tree: Vec<ProjectFileNode>,
    pub has_project_yaml: bool,
}

// Run Types
#[derive(Serialize)]
pub struct Run {
    pub id: i64,
    pub project_id: i64,
    pub project_name: String,
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
    pub has_project: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageFilterScope {
    Inbox,
    Sent,
    All,
}

// Jupyter Types
#[derive(Serialize)]
pub struct JupyterStatus {
    pub running: bool,
    pub port: Option<i32>,
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
}

#[derive(Serialize)]
pub struct SyftBoxConfigInfo {
    pub is_authenticated: bool,
    pub config_path: String,
    pub has_access_token: bool,
    pub has_refresh_token: bool,
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
