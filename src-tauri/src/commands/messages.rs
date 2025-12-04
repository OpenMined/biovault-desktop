use crate::types::{
    MessageFilterScope, MessageSendRequest, MessageSyncResult, MessageThreadSummary,
};
use biovault::cli::commands::messages::{get_message_db_path, init_message_system};
use biovault::messages::{Message as VaultMessage, MessageDb, MessageStatus, MessageType};
use chrono::Utc;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

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
