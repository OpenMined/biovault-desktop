use super::messages;
use crate::resolve_biovault_home_path;
use crate::types::{
    CreateSessionRequest, MessageSendRequest, Session, SessionJupyterStatus, SessionMessage,
    DEFAULT_JUPYTER_PYTHON,
};
use biovault::cli::commands::jupyter;
use biovault::cli::commands::messages::get_message_db_path;
use biovault::data::BioVaultDb;
use biovault::messages::{Message as VaultMessage, MessageDb, MessageStatus};
use serde_json::json;
use rand::Rng;
use rusqlite::OptionalExtension;
use std::fs;
use std::path::Path;

// Embed the session template notebook at compile time
const SESSION_TEMPLATE_NOTEBOOK: &str =
    include_str!("../../resources/templates/session_template.ipynb");
const DEV_NOTEBOOK_DO: &str = "/Users/madhavajay/dev/biovault-desktop/workspace3/src-tauri/resources/templates/sc_test_do.ipynb";
const DEV_NOTEBOOK_DS: &str = "/Users/madhavajay/dev/biovault-desktop/workspace3/src-tauri/resources/templates/sc_test_ds.ipynb";

fn generate_session_id() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 6] = rng.gen();
    hex::encode(bytes)
}

fn get_sessions_dir() -> std::path::PathBuf {
    let biovault_home = resolve_biovault_home_path();
    let owner = get_owner_email();

    // Place sessions inside the owner's datasite shared/biovault/sessions so they replicate to peers
    biovault_home
        .join("datasites")
        .join(owner)
        .join("shared")
        .join("biovault")
        .join("sessions")
}

fn get_owner_email() -> String {
    let config_path = resolve_biovault_home_path().join("config.yaml");
    if config_path.exists() {
        if let Ok(content) = fs::read_to_string(&config_path) {
            if let Ok(yaml) = serde_yaml::from_str::<serde_yaml::Value>(&content) {
                if let Some(email) = yaml.get("email").and_then(|e| e.as_str()) {
                    return email.to_string();
                }
            }
        }
    }
    "owner@local".to_string()
}

fn load_message_config() -> Result<biovault::config::Config, String> {
    biovault::config::Config::load().map_err(|e| format!("Failed to load BioVault config: {}", e))
}

fn open_message_db(config: &biovault::config::Config) -> Result<MessageDb, String> {
    let db_path = get_message_db_path(config)
        .map_err(|e| format!("Failed to locate message database: {}", e))?;
    MessageDb::new(&db_path).map_err(|e| format!("Failed to open message database: {}", e))
}

fn session_exists(session_id: &str) -> Result<bool, String> {
    let db = BioVaultDb::new().map_err(|e| format!("Failed to open database: {}", e))?;
    let exists: Option<i64> = db
        .connection()
        .query_row(
            "SELECT id FROM sessions WHERE session_id = ?1 LIMIT 1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to query sessions: {}", e))?;
    Ok(exists.is_some())
}

fn send_session_invite_message(
    peer_email: &str,
    session_id: &str,
    session_name: &str,
    owner: &str,
    description: &Option<String>,
) {
    let metadata = serde_json::json!({
        "session_invite": {
            "session_id": session_id,
            "session_name": session_name,
            "from": owner,
            "description": description,
            "created_at": chrono::Utc::now().to_rfc3339(),
        }
    });

    let body = format!(
        "{} invited you to the session \"{}\" (ID: {}).",
        owner, session_name, session_id
    );
    let subject = format!("Session Invite: {}", session_name);

    if let Err(e) = messages::send_message(MessageSendRequest {
        to: Some(peer_email.to_string()),
        body,
        subject: Some(subject),
        reply_to: None,
        message_type: Some("text".to_string()),
        metadata: Some(metadata),
    }) {
        eprintln!("Warning: Failed to send session invite message: {}", e);
    }
}

fn send_session_invite_response_message(
    requester: &str,
    session_id: &str,
    responder: &str,
    accepted: bool,
    reason: &Option<String>,
    session_name: &str,
) {
    let status = if accepted { "accepted" } else { "rejected" };
    let metadata = serde_json::json!({
        "session_invite_response": {
            "session_id": session_id,
            "status": status,
            "responder": responder,
            "reason": reason,
            "session_name": session_name,
            "responded_at": chrono::Utc::now().to_rfc3339(),
        }
    });

    let body = if accepted {
        format!(
            "{} accepted your session invite for \"{}\" (ID: {}).",
            responder, session_name, session_id
        )
    } else {
        format!(
            "{} declined your session invite for \"{}\" (ID: {}).{}",
            responder,
            session_name,
            session_id,
            reason
                .as_ref()
                .map(|r| format!(" Reason: {}", r))
                .unwrap_or_default()
        )
    };
    let subject = format!("Session invite {}: {}", status, session_name);

    if let Err(e) = messages::send_message(MessageSendRequest {
        to: Some(requester.to_string()),
        body,
        subject: Some(subject),
        reply_to: None,
        message_type: Some("text".to_string()),
        metadata: Some(metadata),
    }) {
        eprintln!(
            "Warning: Failed to send session invite response message: {}",
            e
        );
    }
}

#[cfg(unix)]
fn symlink_dev_notebook(src: &str, dest: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(src, dest).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn symlink_dev_notebook(src: &str, dest: &Path) -> Result<(), String> {
    // Fallback: copy on non-Unix
    fs::copy(src, dest).map(|_| ()).map_err(|e| e.to_string())
}

fn link_dev_notebooks(session_path: &Path) {
    let links = [
        (DEV_NOTEBOOK_DO, session_path.join("sc_test_do.ipynb")),
        (DEV_NOTEBOOK_DS, session_path.join("sc_test_ds.ipynb")),
    ];

    for (src, dest) in links.iter() {
        if Path::new(src).exists() {
            if dest.exists() {
                continue;
            }
            if let Err(e) = symlink_dev_notebook(src, dest) {
                eprintln!(
                    "Warning: Failed to link notebook {} -> {}: {}",
                    src,
                    dest.display(),
                    e
                );
            }
        }
    }
}

fn ensure_session_permissions(session_path: &Path, owner: &str, peer: &Option<String>) {
    // Create syft.pub.yaml to allow the peer to read (and admin remains with owner)
    // Owner gets admin; peer gets read; write remains empty (owner has implicit rights)
    let perm_path = session_path.join("syft.pub.yaml");
    if perm_path.exists() {
        return;
    }

    let mut read_list = vec![];
    if let Some(peer_email) = peer {
        read_list.push(peer_email.clone());
    }

    let doc = json!({
        "rules": [
            {
                "pattern": "**",
                "access": {
                    "admin": [owner],
                    "read": read_list,
                    "write": Vec::<String>::new(),
                },
            },
        ],
    });

    if let Ok(yaml) = serde_yaml::to_string(&doc) {
        let _ = std::fs::write(&perm_path, yaml);
    }
}

#[tauri::command]
pub fn get_sessions() -> Result<Vec<Session>, String> {
    let db = BioVaultDb::new().map_err(|e| format!("Failed to open database: {}", e))?;

    let sessions: Vec<Session> = db
        .connection()
        .prepare(
            "SELECT id, session_id, name, description, session_path, owner, peer, role, status,
                    jupyter_port, jupyter_pid, jupyter_url, jupyter_token, created_at, updated_at
             FROM sessions ORDER BY created_at DESC",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?
        .query_map([], |row| {
            Ok(Session {
                id: row.get(0)?,
                session_id: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                session_path: row.get(4)?,
                owner: row.get(5)?,
                peer: row.get(6)?,
                role: row.get(7)?,
                status: row.get(8)?,
                jupyter_port: row.get(9)?,
                jupyter_pid: row.get(10)?,
                jupyter_url: row.get(11)?,
                jupyter_token: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
            })
        })
        .map_err(|e| format!("Failed to query sessions: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to collect sessions: {}", e))?;

    Ok(sessions)
}

#[tauri::command]
pub fn get_session(session_id: String) -> Result<Session, String> {
    let db = BioVaultDb::new().map_err(|e| format!("Failed to open database: {}", e))?;

    let session: Session = db
        .connection()
        .query_row(
            "SELECT id, session_id, name, description, session_path, owner, peer, role, status,
                    jupyter_port, jupyter_pid, jupyter_url, jupyter_token, created_at, updated_at
             FROM sessions WHERE session_id = ?1",
            [&session_id],
            |row| {
                Ok(Session {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    session_path: row.get(4)?,
                    owner: row.get(5)?,
                    peer: row.get(6)?,
                    role: row.get(7)?,
                    status: row.get(8)?,
                    jupyter_port: row.get(9)?,
                    jupyter_pid: row.get(10)?,
                    jupyter_url: row.get(11)?,
                    jupyter_token: row.get(12)?,
                    created_at: row.get(13)?,
                    updated_at: row.get(14)?,
                })
            },
        )
        .map_err(|e| format!("Session not found: {}", e))?;

    Ok(session)
}

#[tauri::command]
pub fn create_session(request: CreateSessionRequest) -> Result<Session, String> {
    let db = BioVaultDb::new().map_err(|e| format!("Failed to open database: {}", e))?;

    let session_id = generate_session_id();
    let sessions_dir = get_sessions_dir();
    let session_path = sessions_dir.join(&session_id);
    let owner = get_owner_email();

    if request
        .peer
        .as_ref()
        .is_some_and(|peer| peer.eq_ignore_ascii_case(&owner))
    {
        return Err("Peer email cannot be your own email".to_string());
    }

    // Create session directory
    fs::create_dir_all(&session_path)
        .map_err(|e| format!("Failed to create session directory: {}", e))?;

    // Create data subdirectory
    fs::create_dir_all(session_path.join("data"))
        .map_err(|e| format!("Failed to create data directory: {}", e))?;

    ensure_session_permissions(&session_path, &owner, &request.peer);

    let session_path_str = session_path.to_string_lossy().to_string();

    // Dev helper: link notebooks into the session folder
    link_dev_notebooks(&session_path);

    db.connection()
        .execute(
            "INSERT INTO sessions (session_id, name, description, session_path, owner, peer, role, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'owner', 'active')",
            rusqlite::params![
                &session_id,
                &request.name,
                &request.description,
                &session_path_str,
                &owner,
                &request.peer,
            ],
        )
        .map_err(|e| format!("Failed to create session: {}", e))?;

    // Write session config file for beaver env var detection
    let config = serde_json::json!({
        "session_id": &session_id,
        "name": &request.name,
        "owner": &owner,
        "peer": &request.peer,
        "created_at": chrono::Utc::now().to_rfc3339(),
    });
    let config_path = session_path.join("session.json");
    fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| format!("Failed to write session config: {}", e))?;

    // Copy template notebook to session folder
    let template_path = session_path.join("template.ipynb");
    fs::write(&template_path, SESSION_TEMPLATE_NOTEBOOK)
        .map_err(|e| format!("Failed to write template notebook: {}", e))?;

    // Send session invitation to peer if specified
    if let Some(peer_email) = &request.peer {
        let biovault_home = resolve_biovault_home_path();

        // Create RPC folder structure for the peer
        let rpc_path = biovault_home
            .join("datasites")
            .join(peer_email)
            .join("app_data")
            .join("biovault")
            .join("rpc")
            .join("session");

        if let Err(e) = fs::create_dir_all(&rpc_path) {
            eprintln!("Warning: Failed to create RPC folder: {}", e);
        } else {
            let invitation = serde_json::json!({
                "session_id": &session_id,
                "requester": &owner,
                "target": peer_email,
                "session_name": &request.name,
                "description": &request.description,
                "created_at": chrono::Utc::now().to_rfc3339(),
                "message": format!("{} invites you to a BioVault session", owner),
                "status": "pending"
            });

            let request_file = rpc_path.join(format!("{}.request", session_id));
            if let Err(e) = fs::write(
                &request_file,
                serde_json::to_string_pretty(&invitation).unwrap(),
            ) {
                eprintln!("Warning: Failed to write session invitation: {}", e);
            } else {
                println!("📨 Session invitation sent to {}", peer_email);
            }
        }

        // Also notify via messaging
        send_session_invite_message(
            peer_email,
            &session_id,
            &request.name,
            &owner,
            &request.description,
        );
    }

    get_session(session_id)
}

#[tauri::command]
pub fn update_session_peer(session_id: String, peer: Option<String>) -> Result<Session, String> {
    let db = BioVaultDb::new().map_err(|e| format!("Failed to open database: {}", e))?;
    let owner = get_owner_email();

    if peer
        .as_ref()
        .is_some_and(|p| p.eq_ignore_ascii_case(&owner))
    {
        return Err("Peer email cannot be your own email".to_string());
    }

    db.connection()
        .execute(
            "UPDATE sessions SET peer = ?1, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?2",
            rusqlite::params![&peer, &session_id],
        )
        .map_err(|e| format!("Failed to update session: {}", e))?;

    let session = get_session(session_id.clone())?;

    // Send session invitation to peer via RPC folder
    if let Some(peer_email) = &peer {
        let biovault_home = resolve_biovault_home_path();

        // Create RPC folder structure for the peer
        // datasites/<peer_email>/app_data/biovault/rpc/session/
        let rpc_path = biovault_home
            .join("datasites")
            .join(peer_email)
            .join("app_data")
            .join("biovault")
            .join("rpc")
            .join("session");

        if let Err(e) = fs::create_dir_all(&rpc_path) {
            eprintln!("Warning: Failed to create RPC folder: {}", e);
        } else {
            // Write session invitation request
            let invitation = serde_json::json!({
                "session_id": &session_id,
                "requester": &owner,
                "target": peer_email,
                "session_name": &session.name,
                "description": &session.description,
                "created_at": chrono::Utc::now().to_rfc3339(),
                "message": format!("{} invites you to a BioVault session", owner),
                "status": "pending"
            });

            let request_file = rpc_path.join(format!("{}.request", session_id));
            if let Err(e) = fs::write(
                &request_file,
                serde_json::to_string_pretty(&invitation).unwrap(),
            ) {
                eprintln!("Warning: Failed to write session invitation: {}", e);
            } else {
                println!("📨 Session invitation sent to {}", peer_email);
            }
        }

        send_session_invite_message(
            peer_email,
            &session.session_id,
            &session.name,
            &owner,
            &session.description,
        );
    }

    Ok(session)
}

#[tauri::command]
pub fn delete_session(session_id: String) -> Result<(), String> {
    let session = get_session(session_id.clone())?;
    let db = BioVaultDb::new().map_err(|e| format!("Failed to open database: {}", e))?;

    // Stop Jupyter if running
    if session.jupyter_pid.is_some() {
        let _ = tauri::async_runtime::block_on(jupyter::stop(&session.session_path));
    }

    // Delete session from database
    db.connection()
        .execute("DELETE FROM sessions WHERE session_id = ?1", [&session_id])
        .map_err(|e| format!("Failed to delete session: {}", e))?;

    // Optionally delete session directory (keep data for safety)
    // fs::remove_dir_all(&session.session_path).ok();

    Ok(())
}

#[tauri::command]
pub async fn launch_session_jupyter(
    session_id: String,
    python_version: Option<String>,
) -> Result<SessionJupyterStatus, String> {
    let session = get_session(session_id.clone())?;
    let version = python_version.unwrap_or_else(|| DEFAULT_JUPYTER_PYTHON.to_string());
    let session_path = session.session_path.clone();
    let version_clone = version.clone();
    let session_id_clone = session_id.clone();
    let owner = session.owner.clone();
    let biovault_home = resolve_biovault_home_path();

    tauri::async_runtime::spawn_blocking(move || {
        // Set environment variables for beaver auto-detection
        // These will be inherited by the Jupyter process
        std::env::set_var("BEAVER_SESSION_ID", &session_id_clone);
        std::env::set_var("SYFTBOX_EMAIL", &owner);
        std::env::set_var(
            "SYFTBOX_DATA_DIR",
            biovault_home.to_string_lossy().to_string(),
        );

        tauri::async_runtime::block_on(jupyter::start(&session_path, &version_clone))
    })
    .await
    .map_err(|e| format!("Failed to launch Jupyter (task join): {}", e))?
    .map_err(|e| format!("Failed to launch Jupyter: {}", e))?;

    get_session_jupyter_status(session_id)
}

#[tauri::command]
pub async fn stop_session_jupyter(session_id: String) -> Result<SessionJupyterStatus, String> {
    let session = get_session(session_id.clone())?;
    let session_path = session.session_path.clone();

    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(jupyter::stop(&session_path))
    })
    .await
    .map_err(|e| format!("Failed to stop Jupyter (task join): {}", e))?
    .map_err(|e| format!("Failed to stop Jupyter: {}", e))?;

    get_session_jupyter_status(session_id)
}

#[tauri::command]
pub async fn reset_session_jupyter(
    session_id: String,
    python_version: Option<String>,
) -> Result<SessionJupyterStatus, String> {
    let session = get_session(session_id.clone())?;
    let version = python_version.unwrap_or_else(|| DEFAULT_JUPYTER_PYTHON.to_string());
    let session_path = session.session_path.clone();
    let version_clone = version.clone();

    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(jupyter::reset(&session_path, &version_clone))
    })
    .await
    .map_err(|e| format!("Failed to reset Jupyter (task join): {}", e))?
    .map_err(|e| format!("Failed to reset Jupyter: {}", e))?;

    // Stop after reset
    let stop_path = session.session_path.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(jupyter::stop(&stop_path))
    })
    .await;

    get_session_jupyter_status(session_id)
}

#[tauri::command]
pub fn get_session_jupyter_status(session_id: String) -> Result<SessionJupyterStatus, String> {
    let session = get_session(session_id.clone())?;
    let db = BioVaultDb::new().map_err(|e| format!("Failed to open database: {}", e))?;

    let canonical = Path::new(&session.session_path)
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| session.session_path.clone());

    let env = db
        .get_dev_env(&canonical)
        .map_err(|e| format!("Failed to query Jupyter environment: {}", e))?;

    let status = env.map_or(
        SessionJupyterStatus {
            session_id: session_id.clone(),
            running: false,
            port: None,
            url: None,
            token: None,
        },
        |env| SessionJupyterStatus {
            session_id: session_id.clone(),
            running: env.jupyter_pid.is_some() && env.jupyter_port.is_some(),
            port: env.jupyter_port,
            url: env.jupyter_url.clone(),
            token: env.jupyter_token.clone(),
        },
    );

    // Update session.json with Jupyter info when running
    if status.running {
        let config_path = Path::new(&session.session_path).join("session.json");
        if config_path.exists() {
            if let Ok(content) = fs::read_to_string(&config_path) {
                if let Ok(mut config) = serde_json::from_str::<serde_json::Value>(&content) {
                    config["jupyter_port"] = serde_json::json!(status.port);
                    config["jupyter_url"] = serde_json::json!(status.url);
                    let _ = fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap());
                }
            }
        }
    }

    Ok(status)
}

// Session Messages
#[tauri::command]
pub fn get_session_messages(session_id: String) -> Result<Vec<SessionMessage>, String> {
    let msgs = get_session_chat_messages(session_id)?;
    Ok(msgs
        .into_iter()
        .map(|m| SessionMessage {
            id: 0,
            session_id: 0,
            sender: m.from,
            body: m.body,
            created_at: m.created_at.to_rfc3339(),
        })
        .collect())
}

#[tauri::command]
pub fn send_session_message(session_id: String, body: String) -> Result<SessionMessage, String> {
    send_session_chat_message(session_id, body).map(|m| SessionMessage {
        id: 0,
        session_id: 0,
        sender: m.from,
        body: m.body,
        created_at: m.created_at.to_rfc3339(),
    })
}

#[tauri::command]
pub fn open_session_folder(session_id: String) -> Result<(), String> {
    let session = get_session(session_id)?;

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&session.session_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&session.session_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&session.session_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    Ok(())
}

// Session Invitation types
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct SessionInvitation {
    pub session_id: String,
    pub requester: String,
    pub target: String,
    pub created_at: String,
    pub message: Option<String>,
    #[serde(default)]
    pub session_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub status: String,
}

#[tauri::command]
pub fn get_session_invitations() -> Result<Vec<SessionInvitation>, String> {
    let owner = get_owner_email();
    let biovault_home = resolve_biovault_home_path();
    let mut invitations = Vec::new();

    let is_rejected = |session_id: &str| {
        let path = biovault_home
            .join("datasites")
            .join(&owner)
            .join("app_data")
            .join("biovault")
            .join("rpc")
            .join("session")
            .join(format!("{}.rejected", session_id));
        path.exists()
    };

    // Look for invitations in our RPC folder
    // datasites/<our_email>/app_data/biovault/rpc/session/
    let rpc_path = biovault_home
        .join("datasites")
        .join(&owner)
        .join("app_data")
        .join("biovault")
        .join("rpc")
        .join("session");

    if rpc_path.exists() {
        if let Ok(entries) = fs::read_dir(&rpc_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|ext| ext == "request") {
                    if let Ok(content) = fs::read_to_string(&path) {
                        if let Ok(invitation) = serde_json::from_str::<SessionInvitation>(&content)
                        {
                            // Only return pending invitations
                            if invitation.status == "pending"
                                && !session_exists(&invitation.session_id)?
                                && !is_rejected(&invitation.session_id)
                            {
                                invitations.push(invitation);
                            }
                        }
                    }
                }
            }
        }
    }

    // Also include invites delivered via the messaging system
    if let Ok(config) = load_message_config() {
        if let Ok(db) = open_message_db(&config) {
            if let Ok(messages) = db.list_messages(None) {
                for msg in messages {
                    if msg.to != owner {
                        continue;
                    }
                    if !matches!(msg.status, MessageStatus::Received | MessageStatus::Read) {
                        continue;
                    }
                    if let Some(meta) = msg.metadata {
                        if let Some(invite) = meta.get("session_invite") {
                            if let Some(session_id) =
                                invite.get("session_id").and_then(|v| v.as_str())
                            {
                                if session_exists(session_id)? || is_rejected(session_id) {
                                    continue;
                                }
                                let session_name = invite
                                    .get("session_name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Session")
                                    .to_string();
                                let description = invite
                                    .get("description")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                                let created_at = invite
                                    .get("created_at")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    .unwrap_or_else(|| msg.created_at.to_rfc3339());
                                let requester = invite
                                    .get("from")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(&msg.from)
                                    .to_string();
                                invitations.push(SessionInvitation {
                                    session_id: session_id.to_string(),
                                    requester,
                                    target: owner.clone(),
                                    created_at,
                                    message: None,
                                    session_name: Some(session_name),
                                    description,
                                    status: "pending".to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    use std::collections::HashMap;

    // De-duplicate by (session_id, requester) keeping the newest created_at
    let mut dedup: HashMap<(String, String), SessionInvitation> = HashMap::new();
    for invite in invitations.into_iter() {
        let key = (invite.session_id.clone(), invite.requester.clone());
        match dedup.get(&key) {
            None => {
                dedup.insert(key, invite);
            }
            Some(existing) => {
                if invite.created_at > existing.created_at {
                    dedup.insert(key, invite);
                }
            }
        }
    }

    let mut invites: Vec<SessionInvitation> = dedup.into_values().collect();

    // Sort by created_at descending
    invites.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    Ok(invites)
}

#[tauri::command]
pub fn accept_session_invitation(session_id: String) -> Result<Session, String> {
    let owner = get_owner_email();
    let biovault_home = resolve_biovault_home_path();

    // Find the invitation
    let rpc_path = biovault_home
        .join("datasites")
        .join(&owner)
        .join("app_data")
        .join("biovault")
        .join("rpc")
        .join("session");

    let request_file = rpc_path.join(format!("{}.request", session_id));

    if !request_file.exists() {
        return Err(format!("Invitation not found: {}", session_id));
    }

    let content = fs::read_to_string(&request_file)
        .map_err(|e| format!("Failed to read invitation: {}", e))?;

    let mut invitation: SessionInvitation =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse invitation: {}", e))?;

    if invitation.session_name.is_none() {
        invitation.session_name = Some(format!("Session with {}", invitation.requester));
    }

    // Update invitation status to accepted
    let mut updated_invitation = invitation.clone();
    updated_invitation.status = "accepted".to_string();
    fs::write(
        &request_file,
        serde_json::to_string_pretty(&updated_invitation).unwrap(),
    )
    .map_err(|e| format!("Failed to update invitation: {}", e))?;

    // Create local session as the "peer" (invited party)
    let sessions_dir = get_sessions_dir();
    let session_path = sessions_dir.join(&session_id);

    fs::create_dir_all(&session_path)
        .map_err(|e| format!("Failed to create session directory: {}", e))?;
    fs::create_dir_all(session_path.join("data"))
        .map_err(|e| format!("Failed to create data directory: {}", e))?;

    ensure_session_permissions(&session_path, &owner, &Some(invitation.requester.clone()));

    // Dev helper: link notebooks into the session folder
    link_dev_notebooks(&session_path);

    let session_path_str = session_path.to_string_lossy().to_string();

    let session_name = invitation
        .session_name
        .clone()
        .unwrap_or_else(|| format!("Session with {}", invitation.requester));
    let session_description = invitation.description.clone();

    let db = BioVaultDb::new().map_err(|e| format!("Failed to open database: {}", e))?;

    db.connection()
        .execute(
            "INSERT INTO sessions (session_id, name, description, session_path, owner, peer, role, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'peer', 'active')",
            rusqlite::params![
                &session_id,
                &session_name,
                &session_description,
                &session_path_str,
                &owner,
                &invitation.requester, // The requester becomes our peer
            ],
        )
        .map_err(|e| format!("Failed to create session: {}", e))?;

    // Write session config
    let config = serde_json::json!({
        "session_id": &session_id,
        "name": &session_name,
        "owner": &owner,
        "peer": &invitation.requester,
        "created_at": chrono::Utc::now().to_rfc3339(),
    });
    let config_path = session_path.join("session.json");
    fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| format!("Failed to write session config: {}", e))?;

    // Copy template notebook
    let template_path = session_path.join("template.ipynb");
    fs::write(&template_path, SESSION_TEMPLATE_NOTEBOOK)
        .map_err(|e| format!("Failed to write template notebook: {}", e))?;

    // Send acceptance response to requester
    let requester_rpc = biovault_home
        .join("datasites")
        .join(&invitation.requester)
        .join("app_data")
        .join("biovault")
        .join("rpc")
        .join("session");

    let _ = fs::create_dir_all(&requester_rpc);

    let response = serde_json::json!({
        "session_id": &session_id,
        "status": "accepted",
        "accepted_at": chrono::Utc::now().to_rfc3339(),
        "responder": &owner,
        "session_name": &session_name,
    });

    let response_file = requester_rpc.join(format!("{}.response", session_id));
    let _ = fs::write(
        &response_file,
        serde_json::to_string_pretty(&response).unwrap(),
    );

    // Notify requester via messaging
    send_session_invite_response_message(
        &invitation.requester,
        &session_id,
        &owner,
        true,
        &None,
        &session_name,
    );

    println!(
        "✅ Session invitation accepted from {}",
        invitation.requester
    );

    get_session(session_id)
}

#[tauri::command]
pub fn reject_session_invitation(session_id: String, reason: Option<String>) -> Result<(), String> {
    let owner = get_owner_email();
    let biovault_home = resolve_biovault_home_path();

    let rpc_path = biovault_home
        .join("datasites")
        .join(&owner)
        .join("app_data")
        .join("biovault")
        .join("rpc")
        .join("session");

    let request_file = rpc_path.join(format!("{}.request", session_id));

    if !request_file.exists() {
        return Err(format!("Invitation not found: {}", session_id));
    }

    let content = fs::read_to_string(&request_file)
        .map_err(|e| format!("Failed to read invitation: {}", e))?;

    let mut invitation: SessionInvitation =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse invitation: {}", e))?;

    if invitation.session_name.is_none() {
        invitation.session_name = Some(format!("Session with {}", invitation.requester));
    }

    // Update invitation status to rejected
    let mut updated_invitation = invitation.clone();
    updated_invitation.status = "rejected".to_string();
    fs::write(
        &request_file,
        serde_json::to_string_pretty(&updated_invitation).unwrap(),
    )
    .map_err(|e| format!("Failed to update invitation: {}", e))?;

    // Send rejection response to requester
    let requester_rpc = biovault_home
        .join("datasites")
        .join(&invitation.requester)
        .join("app_data")
        .join("biovault")
        .join("rpc")
        .join("session");

    let _ = fs::create_dir_all(&requester_rpc);

    let response = serde_json::json!({
        "session_id": &session_id,
        "status": "rejected",
        "rejected_at": chrono::Utc::now().to_rfc3339(),
        "reason": reason,
        "responder": &owner,
        "session_name": &invitation.session_name,
    });

    let response_file = requester_rpc.join(format!("{}.response", session_id));
    let _ = fs::write(
        &response_file,
        serde_json::to_string_pretty(&response).unwrap(),
    );

    // Mark locally so we can hide the invite from list in case of stale message copies
    let _ = fs::write(
        rpc_path.join(format!("{}.rejected", session_id)),
        "rejected",
    );

    send_session_invite_response_message(
        &invitation.requester,
        &session_id,
        &owner,
        false,
        &reason,
        &invitation
            .session_name
            .clone()
            .unwrap_or_else(|| format!("Session with {}", invitation.requester)),
    );

    println!(
        "❌ Session invitation rejected from {}",
        invitation.requester
    );

    Ok(())
}

#[tauri::command]
pub fn get_session_chat_messages(session_id: String) -> Result<Vec<VaultMessage>, String> {
    let config = load_message_config()?;
    let db = open_message_db(&config)?;

    let mut messages = db
        .list_messages(None)
        .map_err(|e| format!("Failed to list messages: {}", e))?;

    messages.retain(|m| {
        if let Some(meta) = m.metadata.as_ref() {
            if let Some(session_chat) = meta.get("session_chat") {
                if let Some(id) = session_chat.get("session_id").and_then(|v| v.as_str()) {
                    return id == session_id;
                }
            }
            if let Some(invite) = meta.get("session_invite") {
                if let Some(id) = invite.get("session_id").and_then(|v| v.as_str()) {
                    return id == session_id;
                }
            }
        }
        false
    });

    messages.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(messages)
}

#[tauri::command]
pub fn send_session_chat_message(session_id: String, body: String) -> Result<VaultMessage, String> {
    if body.trim().is_empty() {
        return Err("Message body cannot be empty".to_string());
    }

    let session = get_session(session_id.clone())?;
    let recipient = if session.role == "owner" {
        session
            .peer
            .clone()
            .ok_or_else(|| "No peer set for this session".to_string())?
    } else {
        session.owner.clone()
    };

    let subject = format!("Session: {}", session.name);
    let metadata = serde_json::json!({
        "session_chat": {
            "session_id": session_id,
            "session_name": session.name,
            "from": get_owner_email(),
            "created_at": chrono::Utc::now().to_rfc3339(),
        }
    });

    messages::send_message(MessageSendRequest {
        to: Some(recipient),
        body,
        subject: Some(subject),
        reply_to: None,
        message_type: Some("text".to_string()),
        metadata: Some(metadata),
    })
}
