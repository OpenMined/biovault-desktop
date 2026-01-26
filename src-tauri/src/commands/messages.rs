use crate::types::{
    BatchedMessageRefreshResult, MessageFilterScope, MessageSendRequest, MessageSyncResult,
    MessageThreadSummary,
};
use biovault::cli::commands::messages::{get_message_db_path, init_message_system};
use biovault::flow_spec::FlowFile;
use biovault::messages::{Message as VaultMessage, MessageDb, MessageStatus, MessageType};
use biovault::pipeline_spec::PipelineSpec;
use biovault::syftbox::storage::{SyftBoxStorage, WritePolicy};
use biovault::syftbox::syc;
use biovault::types::SyftPermissions;
use syftbox_sdk;
use chrono::Utc;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use walkdir::WalkDir;

fn msg_debug_enabled() -> bool {
    env::var_os("BIOVAULT_DEV_SYFTBOX").is_some() || env::var_os("SYFTBOX_DEBUG_CRYPTO").is_some()
}

fn load_config() -> Result<biovault::config::Config, String> {
    biovault::config::Config::load().map_err(|e| format!("Failed to load BioVault config: {}", e))
}

fn parse_thread_filter(scope: Option<&str>) -> Result<MessageFilterScope, String> {
    let value = scope.unwrap_or("inbox").to_lowercase();
    match value.as_str() {
        "inbox" | "received" => Ok(MessageFilterScope::Inbox),
        "sent" | "outbox" => Ok(MessageFilterScope::Sent),
        "all" | "threads" => Ok(MessageFilterScope::All),
        other => Err(format!("Unknown message filter: {}", other)),
    }
}

fn syftbox_storage(config: &biovault::config::Config) -> Result<SyftBoxStorage, String> {
    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to resolve SyftBox data dir: {}", e))?;
    Ok(SyftBoxStorage::new(&data_dir))
}

fn should_skip_pipeline_path(rel: &Path) -> bool {
    if rel.file_name() == Some(OsStr::new("syft.pub.yaml")) {
        return true;
    }

    let skip_dirs = [
        ".git",
        ".nextflow",
        ".venv",
        "__pycache__",
        "node_modules",
        "target",
        "work",
        "results",
        "runs",
    ];

    rel.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|name| skip_dirs.iter().any(|skip| skip == &name))
    })
}

fn copy_pipeline_folder(
    storage: &SyftBoxStorage,
    src: &Path,
    dest: &Path,
    recipient: &str,
) -> Result<(), String> {
    storage
        .ensure_dir(dest)
        .map_err(|e| format!("Failed to create pipeline submission folder: {}", e))?;

    for entry in WalkDir::new(src)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        let rel = path
            .strip_prefix(src)
            .map_err(|e| format!("Failed to resolve pipeline path: {}", e))?;

        if should_skip_pipeline_path(rel) {
            continue;
        }

        let dest_path = dest.join(rel);
        if entry.file_type().is_dir() {
            storage.ensure_dir(&dest_path).map_err(|e| {
                format!("Failed to create directory {}: {}", dest_path.display(), e)
            })?;
            continue;
        }

        let bytes = fs::read(path)
            .map_err(|e| format!("Failed to read pipeline file {}: {}", path.display(), e))?;
        let hint = rel.to_string_lossy().to_string();
        let policy = WritePolicy::Envelope {
            recipients: vec![recipient.to_string()],
            hint: Some(hint),
        };

        if msg_debug_enabled() {
            println!(
                "[messages][debug] encrypt pipeline file={} dest={} recipient={}",
                path.display(),
                dest_path.display(),
                recipient
            );
        }
        storage
            .write_with_shadow(&dest_path, &bytes, policy, true)
            .map_err(|e| {
                format!(
                    "Failed to write pipeline file {}: {}",
                    dest_path.display(),
                    e
                )
            })?;
    }

    Ok(())
}

fn ensure_recipient_bundle_cached(
    config: &biovault::config::Config,
    recipient: &str,
) -> Result<(), String> {
    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to resolve SyftBox data dir: {}", e))?;

    // Resolve vault path (local vault for encryption keys)
    let vault_path = biovault::config::resolve_syc_vault_path()
        .map_err(|e| format!("SYC_VAULT is required: {e}"))?;

    let bundles_dir = vault_path.join("bundles");
    let slug = syftbox_sdk::sanitize_identity(recipient);
    let local_bundle_path = bundles_dir.join(format!("{slug}.json"));

    // If it already exists, we assume it's valid for now
    if local_bundle_path.exists() {
        return Ok(());
    }

    // Try to import from recipient's datasite if visible locally
    let datasites_root = if data_dir.file_name().map_or(false, |n| n == "datasites") {
        data_dir
    } else {
        data_dir.join("datasites")
    };

    let did_path = datasites_root
        .join(recipient)
        .join("public")
        .join("crypto")
        .join("did.json");

    if !did_path.exists() {
        return Err(format!(
            "Recipient {} public key not found locally. They must be online and syncing for you to send a pipeline request.",
            recipient
        ));
    }

    // Double check the DID is valid before caching
    syc::parse_public_bundle_file(&did_path)
        .map_err(|e| format!("Invalid DID for {}: {}", recipient, e))?;

    if !bundles_dir.exists() {
        std::fs::create_dir_all(&bundles_dir)
            .map_err(|e| format!("failed to create bundles directory: {e}"))?;
    }

    std::fs::copy(&did_path, &local_bundle_path)
        .map_err(|e| format!("failed to cache recipient bundle: {e}"))?;

    Ok(())
}

fn collect_pipeline_projects(
    spec: &PipelineSpec,
    pipeline_root: &Path,
    db: &biovault::data::BioVaultDb,
) -> Result<Vec<PathBuf>, String> {
    let mut projects = HashSet::new();

    for step in &spec.steps {
        let Some(uses) = step.uses.as_ref() else {
            continue;
        };

        if uses.starts_with("http://")
            || uses.starts_with("https://")
            || uses.starts_with("syft://")
        {
            continue;
        }

        if uses.starts_with('/') {
            let candidate = PathBuf::from(uses);
            if candidate.exists() {
                projects.insert(candidate);
            }
            continue;
        }

        if uses.starts_with('.') || uses.contains('/') || uses.contains('\\') {
            let candidate = pipeline_root.join(uses);
            if candidate.exists() {
                let should_include = match (candidate.canonicalize(), pipeline_root.canonicalize())
                {
                    (Ok(candidate_path), Ok(root_path)) => !candidate_path.starts_with(root_path),
                    _ => false,
                };
                if should_include {
                    projects.insert(candidate);
                }
                continue;
            }
        }

        if let Ok(Some(project)) = db.get_project(uses) {
            projects.insert(PathBuf::from(project.project_path));
        }
    }

    Ok(projects.into_iter().collect())
}

fn copy_results_folder_filtered(
    storage: &SyftBoxStorage,
    src: &Path,
    dest: &Path,
    recipient: &str,
    allowed_rel_paths: Option<&std::collections::HashSet<String>>,
) -> Result<(), String> {
    storage
        .ensure_dir(dest)
        .map_err(|e| format!("Failed to create results folder: {}", e))?;

    for entry in WalkDir::new(src)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        let rel = path
            .strip_prefix(src)
            .map_err(|e| format!("Failed to resolve results path: {}", e))?;

        if rel.file_name() == Some(OsStr::new("syft.pub.yaml")) {
            continue;
        }

        let rel_str = rel.to_string_lossy().to_string();
        if let Some(allowed) = allowed_rel_paths {
            if !allowed.contains(&rel_str) {
                continue;
            }
        }

        let dest_path = dest.join(rel);
        if entry.file_type().is_dir() {
            storage.ensure_dir(&dest_path).map_err(|e| {
                format!("Failed to create directory {}: {}", dest_path.display(), e)
            })?;
            continue;
        }

        let bytes = fs::read(path)
            .map_err(|e| format!("Failed to read results file {}: {}", path.display(), e))?;
        let hint = rel.to_string_lossy().to_string();
        let policy = WritePolicy::Envelope {
            recipients: vec![recipient.to_string()],
            hint: Some(hint),
        };

        if msg_debug_enabled() {
            println!(
                "[messages][debug] encrypt results file={} dest={} recipient={}",
                path.display(),
                dest_path.display(),
                recipient
            );
        }
        storage
            .write_with_shadow(&dest_path, &bytes, policy, true)
            .map_err(|e| {
                format!(
                    "Failed to write results file {}: {}",
                    dest_path.display(),
                    e
                )
            })?;
    }

    Ok(())
}

fn copy_results_to_unencrypted(
    storage: &SyftBoxStorage,
    src: &Path,
    dest: &Path,
) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("Failed to create results folder: {}", e))?;

    for entry in WalkDir::new(src)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        let rel = path
            .strip_prefix(src)
            .map_err(|e| format!("Failed to resolve results path: {}", e))?;

        if rel.file_name() == Some(OsStr::new("syft.pub.yaml")) {
            continue;
        }

        let dest_path = dest.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&dest_path).map_err(|e| {
                format!("Failed to create directory {}: {}", dest_path.display(), e)
            })?;
            continue;
        }

        let bytes = storage
            .read_with_shadow(path)
            .map_err(|e| format!("Failed to read results file {}: {}", path.display(), e))?;
        if msg_debug_enabled() {
            println!(
                "[messages][debug] decrypt results file={} dest={} bytes={}",
                path.display(),
                dest_path.display(),
                bytes.len()
            );
        }

        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;
        }

        fs::write(&dest_path, &bytes).map_err(|e| {
            format!(
                "Failed to write results file {}: {}",
                dest_path.display(),
                e
            )
        })?;
    }

    Ok(())
}

#[derive(serde::Serialize)]
pub struct ResultsTreeEntry {
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: Option<u64>,
}

#[tauri::command]
pub fn list_results_tree(root: String) -> Result<Vec<ResultsTreeEntry>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        return Err(format!(
            "Results folder not found at {}",
            root_path.display()
        ));
    }

    let mut entries = Vec::new();
    for entry in WalkDir::new(&root_path)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        let rel = path
            .strip_prefix(&root_path)
            .map_err(|e| format!("Failed to resolve results path: {}", e))?;

        if rel.file_name() == Some(OsStr::new("syft.pub.yaml")) {
            continue;
        }

        let is_dir = entry.file_type().is_dir();
        let size_bytes = if is_dir {
            None
        } else {
            Some(entry.metadata().map(|m| m.len()).unwrap_or(0))
        };

        entries.push(ResultsTreeEntry {
            path: rel.to_string_lossy().to_string(),
            is_dir,
            size_bytes,
        });
    }

    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

pub fn load_biovault_email(biovault_home: &Option<PathBuf>) -> String {
    let config_path = if let Some(home) = biovault_home {
        home.join("config.yaml")
    } else {
        let home_dir = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        dirs::desktop_dir()
            .unwrap_or_else(|| home_dir.join("Desktop"))
            .join("BioVault")
            .join("config.yaml")
    };

    if config_path.exists() {
        if let Ok(content) = fs::read_to_string(&config_path) {
            if let Ok(yaml) = serde_yaml::from_str::<serde_yaml::Value>(&content) {
                if let Some(email) = yaml.get("email").and_then(|e| e.as_str()) {
                    return email.to_string();
                }
            }
        }
    }

    "Setup".to_string()
}

#[tauri::command]
pub fn list_message_threads(
    scope: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<MessageThreadSummary>, String> {
    let config = load_config()?;
    let filter = parse_thread_filter(scope.as_deref())?;
    let db_path = get_message_db_path(&config)
        .map_err(|e| format!("Failed to locate message database: {}", e))?;
    let db =
        MessageDb::new(&db_path).map_err(|e| format!("Failed to open message database: {}", e))?;

    let mut messages = db
        .list_messages(None)
        .map_err(|e| format!("Failed to list messages: {}", e))?;

    let mut threads: HashMap<String, Vec<VaultMessage>> = HashMap::new();

    for message in messages.drain(..) {
        let key = message
            .thread_id
            .clone()
            .unwrap_or_else(|| message.id.clone());
        threads.entry(key).or_default().push(message);
    }

    let mut summaries: Vec<MessageThreadSummary> = threads
        .into_iter()
        .filter_map(|(thread_id, mut msgs)| {
            if msgs.is_empty() {
                return None;
            }

            // Sort by creation time ascending to make last() the newest message
            msgs.sort_by(|a, b| a.created_at.cmp(&b.created_at));

            let last_msg = msgs.last().cloned()?;

            let include = match filter {
                MessageFilterScope::All => true,
                MessageFilterScope::Sent => msgs.iter().any(|m| m.status == MessageStatus::Sent),
                MessageFilterScope::Inbox => msgs
                    .iter()
                    .any(|m| matches!(m.status, MessageStatus::Received | MessageStatus::Read)),
            };

            if !include {
                return None;
            }

            let unread_count = msgs
                .iter()
                .filter(|m| m.status == MessageStatus::Received)
                .count();

            let has_project = msgs
                .iter()
                .any(|m| matches!(m.message_type, MessageType::Project { .. }));

            // Detect session threads from metadata
            let mut session_id: Option<String> = None;
            let mut session_name: Option<String> = None;
            for msg in &msgs {
                if let Some(meta) = &msg.metadata {
                    // Check for session_chat metadata
                    if let Some(session_chat) = meta.get("session_chat") {
                        if let Some(id) = session_chat.get("session_id").and_then(|v| v.as_str()) {
                            session_id = Some(id.to_string());
                        }
                        if let Some(name) =
                            session_chat.get("session_name").and_then(|v| v.as_str())
                        {
                            session_name = Some(name.to_string());
                        }
                        break;
                    }
                    // Check for session_invite metadata
                    if let Some(invite) = meta.get("session_invite") {
                        if let Some(id) = invite.get("session_id").and_then(|v| v.as_str()) {
                            session_id = Some(id.to_string());
                        }
                        if let Some(name) = invite.get("session_name").and_then(|v| v.as_str()) {
                            session_name = Some(name.to_string());
                        }
                        break;
                    }
                }
            }

            let mut participants: HashSet<String> = HashSet::new();
            for msg in &msgs {
                if !msg.from.is_empty() {
                    participants.insert(msg.from.clone());
                }
                if !msg.to.is_empty() {
                    participants.insert(msg.to.clone());
                }
            }

            let subject = last_msg
                .subject
                .clone()
                .unwrap_or_else(|| "(No Subject)".to_string());

            let preview = last_msg
                .body
                .split_whitespace()
                .take(40)
                .collect::<Vec<_>>()
                .join(" ");
            let preview = if preview.len() > 200 {
                format!("{}…", &preview[..200])
            } else {
                preview
            };

            Some(MessageThreadSummary {
                thread_id,
                subject,
                participants: participants.into_iter().collect(),
                unread_count,
                last_message_at: Some(last_msg.created_at.to_rfc3339()),
                last_message_preview: preview,
                has_project,
                session_id,
                session_name,
            })
        })
        .collect();

    summaries.sort_by(|a, b| b.last_message_at.cmp(&a.last_message_at));

    if let Some(limit) = limit {
        summaries.truncate(limit);
    }

    Ok(summaries)
}

#[tauri::command]
pub fn get_thread_messages(thread_id: String) -> Result<Vec<VaultMessage>, String> {
    let config = load_config()?;
    let db_path = get_message_db_path(&config)
        .map_err(|e| format!("Failed to locate message database: {}", e))?;
    let db =
        MessageDb::new(&db_path).map_err(|e| format!("Failed to open message database: {}", e))?;

    let mut fallback_message: Option<VaultMessage> = None;
    let canonical_id = match db
        .get_message(&thread_id)
        .map_err(|e| format!("Failed to load message: {}", e))?
    {
        Some(msg) => {
            let thread_key = msg.thread_id.clone().unwrap_or_else(|| msg.id.clone());
            fallback_message = Some(msg);
            thread_key
        }
        None => thread_id.clone(),
    };

    let mut messages = db
        .get_thread_messages(&canonical_id)
        .map_err(|e| format!("Failed to load thread messages: {}", e))?;

    if messages.is_empty() {
        if let Some(msg) = fallback_message {
            messages.push(msg);
        } else {
            return Err(format!("Thread not found: {}", thread_id));
        }
    }

    for message in messages.iter_mut() {
        if message.status == MessageStatus::Received {
            db.mark_as_read(&message.id)
                .map_err(|e| format!("Failed to mark message as read: {}", e))?;
            message.status = MessageStatus::Read;
            message.read_at = Some(Utc::now());
        }
    }

    Ok(messages)
}

#[tauri::command]
pub fn send_message(request: MessageSendRequest) -> Result<VaultMessage, String> {
    if request.body.trim().is_empty() {
        return Err("Message body cannot be empty".to_string());
    }

    let config = load_config()?;
    let (db, sync) = init_message_system(&config)
        .map_err(|e| format!("Failed to initialize messaging: {}", e))?;

    let mut message = if let Some(reply_id) = request.reply_to.as_ref() {
        let original = db
            .get_message(reply_id)
            .map_err(|e| format!("Failed to load original message: {}", e))?
            .ok_or_else(|| format!("Original message not found: {}", reply_id))?;
        let mut reply =
            VaultMessage::reply_to(&original, config.email.clone(), request.body.clone());
        // Allow callers to override the recipient even when sending a reply.
        // This is important for "threaded" app messages (e.g. session chat/accept/reject)
        // where we want to reply in-thread but still direct the message to the peer.
        if let Some(recipient) = request.to.clone().filter(|s| !s.trim().is_empty()) {
            reply.to = recipient;
        }
        if let Some(subject) = request.subject.as_ref().filter(|s| !s.trim().is_empty()) {
            reply.subject = Some(subject.clone());
        }
        reply
    } else {
        let recipient = request
            .to
            .clone()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "Recipient email is required".to_string())?;
        let mut outbound = VaultMessage::new(config.email.clone(), recipient, request.body.clone());
        if let Some(subject) = request.subject.as_ref().filter(|s| !s.trim().is_empty()) {
            outbound.subject = Some(subject.clone());
        }
        outbound
    };

    if let Some(metadata) = request.metadata.clone() {
        message.metadata = Some(metadata);
    }

    // Keep session-related messages grouped consistently by session_id.
    if let Some(meta) = message.metadata.as_ref() {
        let session_id = meta
            .get("session_chat")
            .and_then(|v| v.get("session_id"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
            .or_else(|| {
                meta.get("session_invite")
                    .and_then(|v| v.get("session_id"))
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_string)
            })
            .or_else(|| {
                meta.get("session_invite_response")
                    .and_then(|v| v.get("session_id"))
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_string)
            });
        if let Some(session_id) = session_id {
            message.thread_id = Some(session_id);
        }
    }

    if let Some(kind) = request
        .message_type
        .as_ref()
        .map(|s| s.trim().to_lowercase())
    {
        use biovault::messages::MessageType;
        match kind.as_str() {
            "text" | "" => {
                message.message_type = MessageType::Text;
            }
            _ => {
                // For now, unsupported message types fall back to text
                message.message_type = MessageType::Text;
            }
        }
    }

    db.insert_message(&message)
        .map_err(|e| format!("Failed to store message: {}", e))?;

    sync.send_message(&message.id)
        .map_err(|e| format!("Failed to send message: {}", e))?;

    let updated = db
        .get_message(&message.id)
        .map_err(|e| format!("Failed to reload message: {}", e))?
        .unwrap_or(message);

    Ok(updated)
}

#[tauri::command]
pub fn sync_messages() -> Result<MessageSyncResult, String> {
    let config = load_config()?;
    let (_db, sync) = init_message_system(&config)
        .map_err(|e| format!("Failed to initialize messaging: {}", e))?;

    let (ids, count) = sync
        .sync_quiet()
        .map_err(|e| format!("Failed to sync messages: {}", e))?;

    Ok(MessageSyncResult {
        new_message_ids: ids,
        new_messages: count,
    })
}

#[tauri::command]
pub fn mark_thread_as_read(thread_id: String) -> Result<usize, String> {
    let config = load_config()?;
    let db_path = get_message_db_path(&config)
        .map_err(|e| format!("Failed to locate message database: {}", e))?;
    let db =
        MessageDb::new(&db_path).map_err(|e| format!("Failed to open message database: {}", e))?;

    let messages = db
        .get_thread_messages(&thread_id)
        .map_err(|e| format!("Failed to load thread messages: {}", e))?;

    let mut updated = 0;
    for message in messages {
        if message.status == MessageStatus::Received {
            db.mark_as_read(&message.id)
                .map_err(|e| format!("Failed to mark message as read: {}", e))?;
            updated += 1;
        }
    }

    Ok(updated)
}

#[tauri::command]
pub fn delete_message(message_id: String) -> Result<(), String> {
    let config = load_config()?;
    let db_path = get_message_db_path(&config)
        .map_err(|e| format!("Failed to locate message database: {}", e))?;
    let db =
        MessageDb::new(&db_path).map_err(|e| format!("Failed to open message database: {}", e))?;

    db.delete_message(&message_id)
        .map_err(|e| format!("Failed to delete message: {}", e))
}

#[tauri::command]
pub fn delete_thread(thread_id: String) -> Result<usize, String> {
    let config = load_config()?;
    let db_path = get_message_db_path(&config)
        .map_err(|e| format!("Failed to locate message database: {}", e))?;
    let db =
        MessageDb::new(&db_path).map_err(|e| format!("Failed to open message database: {}", e))?;

    match db.get_thread_messages(&thread_id) {
        Ok(messages) if !messages.is_empty() => {
            for message in messages {
                db.delete_message(&message.id)
                    .map_err(|e| format!("Failed to delete message: {}", e))?;
            }
            Ok(1)
        }
        _ => {
            db.delete_message(&thread_id)
                .map_err(|e| format!("Failed to delete thread: {}", e))?;
            Ok(1)
        }
    }
}

// ============================================================================
// Failed Messages (decryption failures)
// ============================================================================

use biovault::messages::models::FailedMessage;
use serde::Serialize;

/// Serializable failed message for frontend
#[derive(Debug, Clone, Serialize)]
pub struct FailedMessageInfo {
    pub id: String,
    pub sender_identity: String,
    pub sender_fingerprint: String,
    pub recipient_fingerprint: Option<String>,
    pub failure_reason: String,
    pub failure_reason_display: String,
    pub error_details: String,
    pub suggested_action: String,
    pub created_at: String,
    pub dismissed: bool,
}

impl From<FailedMessage> for FailedMessageInfo {
    fn from(fm: FailedMessage) -> Self {
        Self {
            id: fm.id.clone(),
            sender_identity: fm.sender_identity.clone(),
            sender_fingerprint: fm.sender_fingerprint.clone(),
            recipient_fingerprint: fm.recipient_fingerprint.clone(),
            failure_reason: format!("{:?}", fm.failure_reason),
            failure_reason_display: fm.failure_reason.to_string(),
            error_details: fm.error_details.clone(),
            suggested_action: fm.suggested_action(),
            created_at: fm.created_at.to_rfc3339(),
            dismissed: fm.dismissed,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FailedMessagesResult {
    pub failed_messages: Vec<FailedMessageInfo>,
    pub count: usize,
}

#[tauri::command]
pub fn list_failed_messages(
    include_dismissed: Option<bool>,
) -> Result<FailedMessagesResult, String> {
    let config = load_config()?;
    let db_path = get_message_db_path(&config)
        .map_err(|e| format!("Failed to locate message database: {}", e))?;
    let db =
        MessageDb::new(&db_path).map_err(|e| format!("Failed to open message database: {}", e))?;

    let include = include_dismissed.unwrap_or(false);
    let failed = db
        .list_failed_messages(include)
        .map_err(|e| format!("Failed to list failed messages: {}", e))?;

    let count = failed.len();
    let infos: Vec<FailedMessageInfo> = failed.into_iter().map(|f| f.into()).collect();

    Ok(FailedMessagesResult {
        failed_messages: infos,
        count,
    })
}

#[tauri::command]
pub fn count_failed_messages() -> Result<usize, String> {
    let config = load_config()?;
    let db_path = get_message_db_path(&config)
        .map_err(|e| format!("Failed to locate message database: {}", e))?;
    let db =
        MessageDb::new(&db_path).map_err(|e| format!("Failed to open message database: {}", e))?;

    db.count_failed_messages()
        .map_err(|e| format!("Failed to count failed messages: {}", e))
}

#[tauri::command]
pub fn dismiss_failed_message(id: String) -> Result<bool, String> {
    let config = load_config()?;
    let db_path = get_message_db_path(&config)
        .map_err(|e| format!("Failed to locate message database: {}", e))?;
    let db =
        MessageDb::new(&db_path).map_err(|e| format!("Failed to open message database: {}", e))?;

    db.dismiss_failed_message(&id)
        .map_err(|e| format!("Failed to dismiss failed message: {}", e))
}

#[tauri::command]
pub fn delete_failed_message(id: String) -> Result<bool, String> {
    let config = load_config()?;
    let db_path = get_message_db_path(&config)
        .map_err(|e| format!("Failed to locate message database: {}", e))?;
    let db =
        MessageDb::new(&db_path).map_err(|e| format!("Failed to open message database: {}", e))?;

    db.delete_failed_message(&id)
        .map_err(|e| format!("Failed to delete failed message: {}", e))
}

/// Sync messages and also capture decryption failures
/// Returns new message count and failed message count
#[derive(Debug, Clone, Serialize)]
pub struct SyncWithFailuresResult {
    pub new_message_ids: Vec<String>,
    pub new_messages: usize,
    pub new_failed: usize,
    pub total_failed: usize,
}

#[tauri::command]
pub fn sync_messages_with_failures() -> Result<SyncWithFailuresResult, String> {
    let config = load_config()?;
    let (_db, sync) = init_message_system(&config)
        .map_err(|e| format!("Failed to initialize messaging: {}", e))?;

    let (ids, count, new_failed) = sync
        .sync_quiet_with_failures()
        .map_err(|e| format!("Failed to sync messages: {}", e))?;

    let total_failed = sync.count_failed_messages().unwrap_or(0);

    Ok(SyncWithFailuresResult {
        new_message_ids: ids,
        new_messages: count,
        new_failed,
        total_failed,
    })
}

/// Send a pipeline request to a peer asking them to run it on their private data
#[tauri::command]
pub fn send_pipeline_request(
    pipeline_name: String,
    pipeline_version: String,
    dataset_name: String,
    recipient: String,
    message: String,
) -> Result<VaultMessage, String> {
    let config = load_config()?;
    let (db, sync) = init_message_system(&config)
        .map_err(|e| format!("Failed to initialize messaging: {}", e))?;
    let storage = syftbox_storage(&config)?;

    // Ensure recipient bundle is cached for encryption
    ensure_recipient_bundle_cached(&config, &recipient)?;

    // Look up the pipeline path from the database
    let biovault_db = biovault::data::BioVaultDb::new()
        .map_err(|e| format!("Failed to open BioVault database: {}", e))?;

    let pipelines = biovault_db
        .list_pipelines()
        .map_err(|e| format!("Failed to list pipelines: {}", e))?;

    let pipeline = pipelines
        .iter()
        .find(|p| p.name == pipeline_name)
        .ok_or_else(|| format!("Pipeline '{}' not found in database", pipeline_name))?;

    let flow_yaml_path = std::path::PathBuf::from(&pipeline.pipeline_path).join("flow.yaml");
    if !flow_yaml_path.exists() {
        return Err(format!(
            "Pipeline '{}' not found at {:?}",
            pipeline_name, flow_yaml_path
        ));
    }

    // Read pipeline spec
    let pipeline_content = fs::read_to_string(&flow_yaml_path)
        .map_err(|e| format!("Failed to read flow.yaml: {}", e))?;

    let flow: FlowFile = FlowFile::parse_yaml(&pipeline_content)
        .map_err(|e| format!("Failed to parse flow.yaml: {}", e))?;
    let pipeline_spec_struct: PipelineSpec = flow
        .to_pipeline_spec()
        .map_err(|e| format!("Failed to convert flow spec: {}", e))?;

    let submission_root = config
        .get_shared_submissions_path()
        .map_err(|e| format!("Failed to resolve submissions folder: {}", e))?;

    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let mut hasher = Sha256::new();
    hasher.update(pipeline_content.as_bytes());
    let pipeline_hash = hex::encode(hasher.finalize());
    let short_hash = pipeline_hash
        .get(0..8)
        .unwrap_or(&pipeline_hash)
        .to_string();
    let submission_folder_name = format!("{}-{}-{}", pipeline_name, timestamp, short_hash);

    let submission_path = submission_root.join(&submission_folder_name);
    copy_pipeline_folder(
        &storage,
        Path::new(&pipeline.pipeline_path),
        &submission_path,
        &recipient,
    )?;

    let project_paths = collect_pipeline_projects(
        &pipeline_spec_struct,
        Path::new(&pipeline.pipeline_path),
        &biovault_db,
    )?;
    let projects_dest_root = submission_path.join("projects");
    let mut included_projects: Vec<String> = Vec::new();
    let mut seen_project_dirs = HashSet::new();
    for project_path in project_paths {
        let Some(project_dir_name) = project_path.file_name() else {
            continue;
        };
        let project_dir_name = project_dir_name.to_string_lossy().to_string();
        if !seen_project_dirs.insert(project_dir_name.clone()) {
            continue;
        }
        let dest_path = projects_dest_root.join(&project_dir_name);
        copy_pipeline_folder(&storage, &project_path, &dest_path, &recipient)?;
        included_projects.push(project_dir_name);
    }

    // Write permissions file for recipient access and results write-back
    let perms = SyftPermissions::new_for_datasite(&recipient);
    let perms_yaml = serde_yaml::to_string(&perms)
        .map_err(|e| format!("Failed to serialize permissions: {}", e))?;
    let perms_path = submission_path.join("syft.pub.yaml");
    storage
        .write_with_shadow(
            &perms_path,
            perms_yaml.as_bytes(),
            WritePolicy::Plaintext,
            true,
        )
        .map_err(|e| format!("Failed to write permissions: {}", e))?;

    let datasite_root = config
        .get_datasite_path()
        .map_err(|e| format!("Failed to resolve datasite root: {}", e))?;
    let rel_from_datasite = submission_path
        .strip_prefix(&datasite_root)
        .map_err(|e| format!("Failed to compute submission path: {}", e))?
        .to_string_lossy()
        .to_string();
    let submission_syft_url = format!("syft://{}/{}", config.email, rel_from_datasite);
    let sender_local_path = submission_path.to_string_lossy().to_string();
    let receiver_local_path_template = format!(
        "$SYFTBOX_DATA_DIR/datasites/{}/shared/biovault/submissions/{}",
        config.email, submission_folder_name
    );

    // Create the message with pipeline request metadata
    let mut msg = VaultMessage::new(config.email.clone(), recipient.clone(), message);

    msg.subject = Some(format!("Pipeline Request: {}", pipeline_name));

    // Set metadata with pipeline info
    msg.metadata = Some(serde_json::json!({
        "pipeline_request": {
            "pipeline_name": pipeline_name,
            "pipeline_version": pipeline_version,
            "dataset_name": dataset_name,
            "sender": config.email,
            "flow_spec": flow,
            "pipeline_location": submission_syft_url,
            "submission_id": submission_folder_name,
            "sender_local_path": sender_local_path,
            "receiver_local_path_template": receiver_local_path_template,
            "projects": included_projects,
        }
    }));

    // Use thread_id based on pipeline + dataset for grouping related messages
    msg.thread_id = Some(format!("pipeline-{}:{}", pipeline_name, dataset_name));

    // Insert and send
    db.insert_message(&msg)
        .map_err(|e| format!("Failed to store message: {}", e))?;

    sync.send_message(&msg.id)
        .map_err(|e| format!("Failed to send message: {}", e))?;

    let updated = db
        .get_message(&msg.id)
        .map_err(|e| format!("Failed to reload message: {}", e))?
        .unwrap_or(msg);

    Ok(updated)
}

#[tauri::command]
pub fn send_pipeline_request_results(
    request_id: String,
    run_id: i64,
    message: Option<String>,
    output_paths: Option<Vec<String>>,
) -> Result<VaultMessage, String> {
    let config = load_config()?;
    let (db, sync) = init_message_system(&config)
        .map_err(|e| format!("Failed to initialize messaging: {}", e))?;
    let storage = syftbox_storage(&config)?;

    let original = db
        .get_message(&request_id)
        .map_err(|e| format!("Failed to load request message: {}", e))?
        .ok_or_else(|| format!("Request message {} not found", request_id))?;

    let meta = original
        .metadata
        .as_ref()
        .ok_or_else(|| "Pipeline request metadata not found".to_string())?;
    let pipeline_request = meta
        .get("pipeline_request")
        .ok_or_else(|| "Pipeline request metadata missing".to_string())?;

    let pipeline_name = pipeline_request
        .get("pipeline_name")
        .and_then(|v| v.as_str())
        .unwrap_or("pipeline")
        .to_string();
    let pipeline_location = pipeline_request
        .get("pipeline_location")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Pipeline location missing from request".to_string())?;
    let sender = pipeline_request
        .get("sender")
        .and_then(|v| v.as_str())
        .unwrap_or(&original.from)
        .to_string();
    let submission_id = pipeline_request
        .get("submission_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let biovault_db = biovault::data::BioVaultDb::new()
        .map_err(|e| format!("Failed to open BioVault database: {}", e))?;
    let run = biovault_db
        .get_pipeline_run(run_id)
        .map_err(|e| format!("Failed to load pipeline run: {}", e))?
        .ok_or_else(|| format!("Pipeline run {} not found", run_id))?;

    let results_source = run
        .results_dir
        .clone()
        .unwrap_or_else(|| run.work_dir.clone());
    let results_source_path = PathBuf::from(&results_source);
    if !results_source_path.exists() {
        return Err(format!(
            "Pipeline results not found at {}",
            results_source_path.display()
        ));
    }

    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to get SyftBox data dir: {}", e))?;
    let submission_root = biovault::data::resolve_syft_url(&data_dir, pipeline_location)
        .map_err(|e| format!("Failed to resolve pipeline location: {}", e))?;
    let results_dest_root = submission_root.join("results");
    let results_dest = results_dest_root.join(format!("run_{}", run_id));

    let allowed_rel_paths = output_paths.as_ref().and_then(|paths| {
        if paths.is_empty() {
            return None;
        }
        let mut allowed = std::collections::HashSet::new();
        for path_str in paths {
            let path = PathBuf::from(&path_str);
            let rel = if path.is_absolute() {
                path.strip_prefix(&results_source_path)
                    .ok()
                    .map(|p| p.to_path_buf())
            } else {
                Some(path)
            };
            if let Some(rel_path) = rel {
                if rel_path
                    .components()
                    .any(|component| matches!(component, std::path::Component::ParentDir))
                {
                    continue;
                }
                allowed.insert(rel_path.to_string_lossy().to_string());
            }
        }
        if allowed.is_empty() {
            None
        } else {
            Some(allowed)
        }
    });

    if output_paths.is_some() && allowed_rel_paths.is_none() {
        return Err("No valid outputs selected to send.".to_string());
    }

    copy_results_folder_filtered(
        &storage,
        &results_source_path,
        &results_dest,
        &sender,
        allowed_rel_paths.as_ref(),
    )?;

    let mut files = Vec::new();
    for entry in WalkDir::new(&results_dest)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let rel = path
            .strip_prefix(&results_dest)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        files.push(serde_json::json!({
            "file_name": rel,
            "size_bytes": size,
        }));
    }

    let datasites_root = data_dir.join("datasites");
    let rel_results = results_dest
        .strip_prefix(&datasites_root)
        .map_err(|e| format!("Failed to compute results path: {}", e))?;
    let mut rel_components = rel_results.components();
    let owner_component = rel_components
        .next()
        .ok_or_else(|| "Failed to compute results path: empty".to_string())?;
    let owner = owner_component.as_os_str().to_string_lossy();
    let remainder = rel_components.as_path().to_string_lossy();
    let results_location = if remainder.is_empty() {
        format!("syft://{}", owner)
    } else {
        format!("syft://{}/{}", owner, remainder)
    };

    let body = message.unwrap_or_else(|| {
        format!(
            "Pipeline results for {} are ready. You can find them under {}.",
            pipeline_name, results_location
        )
    });

    let mut reply = VaultMessage::reply_to(&original, config.email.clone(), body);
    reply.subject = Some(format!("Pipeline Results: {}", pipeline_name));
    reply.metadata = Some(serde_json::json!({
        "pipeline_results": {
            "pipeline_name": pipeline_name,
            "run_id": run_id,
            "sender": config.email,
            "results_location": results_location,
            "files": files,
            "submission_id": submission_id,
        }
    }));

    db.insert_message(&reply)
        .map_err(|e| format!("Failed to store message: {}", e))?;
    sync.send_message(&reply.id)
        .map_err(|e| format!("Failed to send message: {}", e))?;

    let updated = db
        .get_message(&reply.id)
        .map_err(|e| format!("Failed to reload message: {}", e))?
        .unwrap_or(reply);

    Ok(updated)
}

/// Import pipeline results from a shared syft:// location into an unencrypted folder.
#[tauri::command]
pub fn import_pipeline_results(
    results_location: String,
    submission_id: Option<String>,
    run_id: Option<i64>,
    pipeline_name: Option<String>,
) -> Result<String, String> {
    let config = load_config()?;
    let storage = syftbox_storage(&config)?;

    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to get SyftBox data dir: {}", e))?;
    let source_root = biovault::data::resolve_syft_url(&data_dir, &results_location)
        .map_err(|e| format!("Failed to resolve results location: {}", e))?;
    if !source_root.exists() {
        return Err(format!(
            "Results folder not found at {}",
            source_root.display()
        ));
    }

    let base = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?
        .join("results");
    let folder_name = submission_id
        .filter(|value| !value.trim().is_empty())
        .or_else(|| pipeline_name.filter(|value| !value.trim().is_empty()))
        .unwrap_or_else(|| "pipeline_results".to_string());
    let mut dest = base.join(folder_name);
    if let Some(run_id) = run_id {
        dest = dest.join(format!("run_{}", run_id));
    }

    copy_results_to_unencrypted(&storage, &source_root, &dest)?;

    Ok(dest.to_string_lossy().to_string())
}

#[derive(serde::Deserialize)]
pub struct OutputFile {
    pub path: String,
    #[serde(rename = "fileName")]
    pub file_name: String,
}

/// Send pipeline results (published outputs) to a recipient
#[tauri::command]
pub fn send_pipeline_results(
    recipient: String,
    pipeline_name: String,
    run_id: i64,
    outputs: Vec<OutputFile>,
    message: String,
) -> Result<VaultMessage, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let config = load_config()?;
    let (db, sync) = init_message_system(&config)
        .map_err(|e| format!("Failed to initialize messaging: {}", e))?;

    // Read output files and encode as base64
    let mut results_data: Vec<serde_json::Value> = vec![];
    for output in &outputs {
        let path = std::path::Path::new(&output.path);
        if path.exists() {
            // Read file content
            let content = fs::read(path)
                .map_err(|e| format!("Failed to read output file {}: {}", output.file_name, e))?;

            // Encode as base64 for safe JSON transmission
            let base64_content = STANDARD.encode(&content);

            // Detect if it's text or binary
            let is_text = output.file_name.ends_with(".csv")
                || output.file_name.ends_with(".tsv")
                || output.file_name.ends_with(".txt")
                || output.file_name.ends_with(".json")
                || output.file_name.ends_with(".yaml")
                || output.file_name.ends_with(".yml");

            results_data.push(serde_json::json!({
                "file_name": output.file_name,
                "content_base64": base64_content,
                "size_bytes": content.len(),
                "is_text": is_text,
            }));
        } else {
            return Err(format!("Output file not found: {}", output.file_name));
        }
    }

    // Create the message with pipeline results metadata
    let body = if message.is_empty() {
        format!(
            "Pipeline results from '{}' (Run #{}) - {} file(s)",
            pipeline_name,
            run_id,
            results_data.len()
        )
    } else {
        message
    };

    let mut msg = VaultMessage::new(config.email.clone(), recipient.clone(), body);

    msg.subject = Some(format!("Pipeline Results: {}", pipeline_name));

    // Set metadata with results
    msg.metadata = Some(serde_json::json!({
        "pipeline_results": {
            "pipeline_name": pipeline_name,
            "run_id": run_id,
            "sender": config.email,
            "files": results_data,
        }
    }));

    // Use thread_id based on pipeline + run for grouping
    msg.thread_id = Some(format!("pipeline-results-{}:{}", pipeline_name, run_id));

    // Insert and send
    db.insert_message(&msg)
        .map_err(|e| format!("Failed to store message: {}", e))?;

    sync.send_message(&msg.id)
        .map_err(|e| format!("Failed to send message: {}", e))?;

    let updated = db
        .get_message(&msg.id)
        .map_err(|e| format!("Failed to reload message: {}", e))?
        .unwrap_or(msg);

    Ok(updated)
}

/// Batched message refresh: sync + list threads in a single command
/// This reduces the number of roundtrips from frontend by combining two common operations.
#[tauri::command]
pub fn refresh_messages_batched(
    scope: Option<String>,
    limit: Option<usize>,
) -> Result<BatchedMessageRefreshResult, String> {
    let config = load_config()?;
    let filter = parse_thread_filter(scope.as_deref())?;

    // Initialize message system (used for sync)
    let (db, sync) = init_message_system(&config)
        .map_err(|e| format!("Failed to initialize messaging: {}", e))?;

    // Sync messages
    let (ids, count, new_failed) = sync
        .sync_quiet_with_failures()
        .map_err(|e| format!("Failed to sync messages: {}", e))?;

    let total_failed = sync.count_failed_messages().unwrap_or(0);

    // List threads (reusing the db connection from sync)
    let mut messages = db
        .list_messages(None)
        .map_err(|e| format!("Failed to list messages: {}", e))?;

    let mut threads_map: HashMap<String, Vec<VaultMessage>> = HashMap::new();
    for message in messages.drain(..) {
        let key = message
            .thread_id
            .clone()
            .unwrap_or_else(|| message.id.clone());
        threads_map.entry(key).or_default().push(message);
    }

    let mut summaries: Vec<MessageThreadSummary> = threads_map
        .into_iter()
        .filter_map(|(thread_id, mut msgs)| {
            if msgs.is_empty() {
                return None;
            }
            msgs.sort_by(|a, b| a.created_at.cmp(&b.created_at));
            let last_msg = msgs.last().cloned()?;

            let include = match filter {
                MessageFilterScope::All => true,
                MessageFilterScope::Sent => msgs.iter().any(|m| m.status == MessageStatus::Sent),
                MessageFilterScope::Inbox => msgs
                    .iter()
                    .any(|m| matches!(m.status, MessageStatus::Received | MessageStatus::Read)),
            };
            if !include {
                return None;
            }

            let unread_count = msgs
                .iter()
                .filter(|m| m.status == MessageStatus::Received)
                .count();

            let has_project = msgs
                .iter()
                .any(|m| matches!(m.message_type, MessageType::Project { .. }));

            // Detect session threads
            let mut session_id: Option<String> = None;
            let mut session_name: Option<String> = None;
            for msg in &msgs {
                if let Some(meta) = &msg.metadata {
                    if let Some(session_chat) = meta.get("session_chat") {
                        if let Some(id) = session_chat.get("session_id").and_then(|v| v.as_str()) {
                            session_id = Some(id.to_string());
                        }
                        if let Some(name) =
                            session_chat.get("session_name").and_then(|v| v.as_str())
                        {
                            session_name = Some(name.to_string());
                        }
                        break;
                    }
                    if let Some(invite) = meta.get("session_invite") {
                        if let Some(id) = invite.get("session_id").and_then(|v| v.as_str()) {
                            session_id = Some(id.to_string());
                        }
                        if let Some(name) = invite.get("session_name").and_then(|v| v.as_str()) {
                            session_name = Some(name.to_string());
                        }
                        break;
                    }
                }
            }

            let mut participants: HashSet<String> = HashSet::new();
            for msg in &msgs {
                if !msg.from.is_empty() {
                    participants.insert(msg.from.clone());
                }
                if !msg.to.is_empty() {
                    participants.insert(msg.to.clone());
                }
            }

            let subject = last_msg
                .subject
                .clone()
                .unwrap_or_else(|| "(No Subject)".to_string());

            let preview = last_msg
                .body
                .split_whitespace()
                .take(40)
                .collect::<Vec<_>>()
                .join(" ");
            let preview = if preview.len() > 200 {
                format!("{}…", &preview[..200])
            } else {
                preview
            };

            Some(MessageThreadSummary {
                thread_id,
                subject,
                participants: participants.into_iter().collect(),
                unread_count,
                last_message_at: Some(last_msg.created_at.to_rfc3339()),
                last_message_preview: preview,
                has_project,
                session_id,
                session_name,
            })
        })
        .collect();

    // Sort by last message time descending
    summaries.sort_by(|a, b| b.last_message_at.cmp(&a.last_message_at));

    // Apply limit if provided
    if let Some(lim) = limit {
        summaries.truncate(lim);
    }

    Ok(BatchedMessageRefreshResult {
        new_message_ids: ids,
        new_messages: count,
        new_failed,
        total_failed,
        threads: summaries,
    })
}
