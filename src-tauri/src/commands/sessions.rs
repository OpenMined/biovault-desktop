use super::messages;
use crate::resolve_biovault_home_path;
use crate::types::{
    CreateSessionRequest, MessageSendRequest, Session, SessionJupyterStatus, SessionMessage,
    DEFAULT_JUPYTER_PYTHON,
};
use biovault::cli::commands::jupyter;
use biovault::cli::commands::messages::get_message_db_path;
use biovault::data::sessions::{
    add_session_dataset, get_session_datasets, remove_session_dataset, AddSessionDatasetRequest,
    SessionDataset,
};
use biovault::data::BioVaultDb;
use biovault::messages::{Message as VaultMessage, MessageDb, MessageStatus};
use rand::Rng;
use rusqlite::OptionalExtension;
use serde_json::json;
use std::fs;
use std::path::Path;

// Embed notebooks at compile time
const SESSION_TEMPLATE_NOTEBOOK: &str =
    include_str!("../../resources/templates/session_template.ipynb");
const DEMO_DO_NOTEBOOK: &str = include_str!("../../resources/templates/demo_do.ipynb");
const DEMO_DS_NOTEBOOK: &str = include_str!("../../resources/templates/demo_ds.ipynb");

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

fn get_private_sessions_dir() -> std::path::PathBuf {
    // Private (non-synced) sessions root lives alongside BIOVAULT_HOME, not inside datasites
    resolve_biovault_home_path().join("sessions")
}

fn get_private_session_path(session_id: &str) -> std::path::PathBuf {
    get_private_sessions_dir().join(session_id)
}

fn ensure_private_session_dir(session_id: &str) -> Result<std::path::PathBuf, String> {
    let private_root = get_private_session_path(session_id);
    fs::create_dir_all(&private_root)
        .map_err(|e| format!("Failed to create private session dir: {}", e))?;

    // Ensure a data subdir exists for local artifacts (not synced)
    fs::create_dir_all(private_root.join("data"))
        .map_err(|e| format!("Failed to create private data directory: {}", e))?;

    Ok(private_root)
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

/// Copy example notebooks into the session folder
/// In dev mode, creates symlinks so edits are written back to source
/// In release mode, copies the embedded content
fn copy_example_notebooks(session_path: &Path) {
    // Files to copy/symlink: (dest_name, embedded_content, source_filename)
    let notebooks = [
        (
            "template.ipynb",
            SESSION_TEMPLATE_NOTEBOOK,
            "session_template.ipynb",
        ),
        ("demo_do.ipynb", DEMO_DO_NOTEBOOK, "demo_do.ipynb"),
        ("demo_ds.ipynb", DEMO_DS_NOTEBOOK, "demo_ds.ipynb"),
    ];

    #[cfg(debug_assertions)]
    let templates_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("templates");

    for (dest_name, _content, source_name) in notebooks.iter() {
        let dest = session_path.join(dest_name);
        if dest.exists() {
            continue;
        }

        #[cfg(debug_assertions)]
        {
            // Dev mode: create symlink to source file
            let source = templates_dir.join(source_name);
            if source.exists() {
                #[cfg(unix)]
                {
                    if let Err(e) = std::os::unix::fs::symlink(&source, &dest) {
                        eprintln!("Warning: Failed to symlink notebook {}: {}", dest_name, e);
                    } else {
                        eprintln!(
                            "[Sessions] Symlinked demo notebook: {} -> {}",
                            dest_name,
                            source.display()
                        );
                    }
                }
                #[cfg(windows)]
                {
                    // Windows symlinks require admin or dev mode, fall back to copy
                    if let Err(e) = fs::write(&dest, _content) {
                        eprintln!("Warning: Failed to copy notebook {}: {}", dest_name, e);
                    } else {
                        eprintln!("[Sessions] Copied demo notebook: {}", dest_name);
                    }
                }
                continue;
            }
        }

        // Release mode (or symlink source not found): copy embedded content
        #[cfg(not(debug_assertions))]
        {
            if let Err(e) = fs::write(&dest, _content) {
                eprintln!("Warning: Failed to copy notebook {}: {}", dest_name, e);
            } else {
                eprintln!("[Sessions] Copied demo notebook: {}", dest_name);
            }
        }
    }
}

/// Ensure the RPC session folder has proper syft.pub.yaml permissions for SyftBox sync
fn ensure_rpc_session_permissions(rpc_path: &Path) {
    let perm_path = rpc_path.join("syft.pub.yaml");
    if perm_path.exists() {
        return;
    }

    // Use the same permission format as DEFAULT_RPC_PERMISSION_CONTENT from syftbox-sdk
    let permissions = r#"rules:
  - pattern: "**/*.request"
    access:
      admin: []
      read:
        - "*"
      write:
        - "*"
  - pattern: "**/*.response"
    access:
      admin: []
      read:
        - "*"
      write:
        - "*"
  - pattern: "**/*.rejected"
    access:
      admin: []
      read:
        - "*"
      write:
        - "*"
"#;

    if let Err(e) = fs::write(&perm_path, permissions) {
        eprintln!("Warning: Failed to write RPC session permissions: {}", e);
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

    // Create private (non-synced) session workspace for notebooks/venv
    let private_session_path = ensure_private_session_dir(&session_id)?;
    fs::create_dir_all(private_session_path.join("data"))
        .map_err(|e| format!("Failed to create private data directory: {}", e))?;

    ensure_session_permissions(&session_path, &owner, &request.peer);

    let session_path_str = session_path.to_string_lossy().to_string();

    // Note: Example notebooks are copied at launch time if user opts in,
    // not at session creation time

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

    // Write session config file to private path (not shared with peer)
    let config = serde_json::json!({
        "session_id": &session_id,
        "name": &request.name,
        "owner": &owner,
        "peer": &request.peer,
        "created_at": chrono::Utc::now().to_rfc3339(),
    });
    let config_path = private_session_path.join("session.json");
    fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| format!("Failed to write session config: {}", e))?;

    // Note: Example notebooks are copied at launch time if user opts in

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
            // Ensure proper SyftBox permissions for the RPC session folder
            ensure_rpc_session_permissions(&rpc_path);

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
                println!("   Path: {:?}", request_file);
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
            // Ensure proper SyftBox permissions for the RPC session folder
            ensure_rpc_session_permissions(&rpc_path);

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
                println!("   Path: {:?}", request_file);
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
        let _ = tauri::async_runtime::block_on(jupyter::stop(
            ensure_private_session_dir(&session_id)?
                .to_string_lossy()
                .as_ref(),
        ));
    }

    // Delete session from database
    db.connection()
        .execute("DELETE FROM sessions WHERE session_id = ?1", [&session_id])
        .map_err(|e| format!("Failed to delete session: {}", e))?;

    // Delete shared session directory (synced folder)
    let shared_session_path = get_sessions_dir().join(&session_id);
    if shared_session_path.exists() {
        if let Err(e) = fs::remove_dir_all(&shared_session_path) {
            eprintln!(
                "[Sessions] Warning: Failed to delete shared session dir {}: {}",
                shared_session_path.display(),
                e
            );
        } else {
            eprintln!(
                "[Sessions] Deleted shared session dir: {}",
                shared_session_path.display()
            );
        }
    }

    // Delete private session directory (local notebooks, jupyter data)
    let private_session_path = get_private_session_path(&session_id);
    if private_session_path.exists() {
        if let Err(e) = fs::remove_dir_all(&private_session_path) {
            eprintln!(
                "[Sessions] Warning: Failed to delete private session dir {}: {}",
                private_session_path.display(),
                e
            );
        } else {
            eprintln!(
                "[Sessions] Deleted private session dir: {}",
                private_session_path.display()
            );
        }
    }

    Ok(())
}

/// Write session.json file for beaver integration
fn write_session_json(session_path: &std::path::Path, session: &Session) -> Result<(), String> {
    let session_json = json!({
        "session_id": session.session_id,
        "peer": session.peer,
        "owner": session.owner,
        "role": session.role,
        "status": session.status
    });

    let json_path = session_path.join("session.json");
    fs::write(
        &json_path,
        serde_json::to_string_pretty(&session_json).unwrap(),
    )
    .map_err(|e| format!("Failed to write session.json: {}", e))?;

    eprintln!(
        "[Sessions] Wrote session.json to {} for beaver integration",
        json_path.display()
    );

    Ok(())
}

#[tauri::command]
pub async fn launch_session_jupyter(
    session_id: String,
    python_version: Option<String>,
    copy_examples: Option<bool>,
) -> Result<SessionJupyterStatus, String> {
    let session = get_session(session_id.clone())?;
    let version = python_version.unwrap_or_else(|| DEFAULT_JUPYTER_PYTHON.to_string());
    let _session_path = session.session_path.clone();
    let private_session_path = ensure_private_session_dir(&session_id)?;
    let version_clone = version.clone();
    let session_id_clone = session_id.clone();
    let owner = session.owner.clone();
    let biovault_home = resolve_biovault_home_path();

    // Write session.json for beaver active_session() detection
    write_session_json(&private_session_path, &session)?;

    // Copy example notebooks if requested
    if copy_examples.unwrap_or(false) {
        copy_example_notebooks(&private_session_path);
    }

    tauri::async_runtime::spawn_blocking(move || {
        // Set environment variables for beaver auto-detection
        // These will be inherited by the Jupyter process
        std::env::set_var("BEAVER_SESSION_ID", &session_id_clone);
        std::env::set_var("SYFTBOX_EMAIL", &owner);
        std::env::set_var(
            "SYFTBOX_DATA_DIR",
            biovault_home.to_string_lossy().to_string(),
        );
        std::env::set_var("BIOVAULT_HOME", biovault_home.to_string_lossy().to_string());

        tauri::async_runtime::block_on(jupyter::start(
            &private_session_path.to_string_lossy(),
            &version_clone,
        ))
    })
    .await
    .map_err(|e| format!("Failed to launch Jupyter (task join): {}", e))?
    .map_err(|e| format!("Failed to launch Jupyter: {}", e))?;

    get_session_jupyter_status(session_id)
}

#[tauri::command]
pub async fn stop_session_jupyter(session_id: String) -> Result<SessionJupyterStatus, String> {
    let _session = get_session(session_id.clone())?;
    let session_path = ensure_private_session_dir(&session_id)?;

    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(jupyter::stop(&session_path.to_string_lossy()))
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
    let _session = get_session(session_id.clone())?;
    let version = python_version.unwrap_or_else(|| DEFAULT_JUPYTER_PYTHON.to_string());
    let session_path = ensure_private_session_dir(&session_id)?;
    let version_clone = version.clone();

    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(jupyter::reset(
            &session_path.to_string_lossy(),
            &version_clone,
        ))
    })
    .await
    .map_err(|e| format!("Failed to reset Jupyter (task join): {}", e))?
    .map_err(|e| format!("Failed to reset Jupyter: {}", e))?;

    // Stop after reset
    let stop_path = ensure_private_session_dir(&session_id)?;
    let _ = tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(jupyter::stop(&stop_path.to_string_lossy()))
    })
    .await;

    get_session_jupyter_status(session_id)
}

#[tauri::command]
pub fn get_session_jupyter_status(session_id: String) -> Result<SessionJupyterStatus, String> {
    let _session = get_session(session_id.clone())?;
    let db = BioVaultDb::new().map_err(|e| format!("Failed to open database: {}", e))?;

    let private_session_path = ensure_private_session_dir(&session_id)?;
    let canonical = private_session_path
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| private_session_path.to_string_lossy().to_string());

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

    // Update session.json in private path with Jupyter info when running
    if status.running {
        let private_session_path = get_private_session_path(&session_id);
        let config_path = private_session_path.join("session.json");
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
    let private_session_path = ensure_private_session_dir(&session_id)?;

    fs::create_dir_all(&session_path)
        .map_err(|e| format!("Failed to create session directory: {}", e))?;
    fs::create_dir_all(private_session_path.join("data"))
        .map_err(|e| format!("Failed to create private data directory: {}", e))?;

    ensure_session_permissions(&session_path, &owner, &Some(invitation.requester.clone()));

    // Note: Example notebooks are copied at launch time if user opts in

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

    // Write session config to private path (not shared with peer)
    let config = serde_json::json!({
        "session_id": &session_id,
        "name": &session_name,
        "owner": &owner,
        "peer": &invitation.requester,
        "created_at": chrono::Utc::now().to_rfc3339(),
    });
    let config_path = private_session_path.join("session.json");
    fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| format!("Failed to write session config: {}", e))?;

    // Note: Example notebooks are copied at launch time if user opts in

    // Send acceptance response to requester
    let requester_rpc = biovault_home
        .join("datasites")
        .join(&invitation.requester)
        .join("app_data")
        .join("biovault")
        .join("rpc")
        .join("session");

    let _ = fs::create_dir_all(&requester_rpc);
    ensure_rpc_session_permissions(&requester_rpc);

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
    ensure_rpc_session_permissions(&requester_rpc);

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

#[derive(serde::Serialize, Debug, Clone)]
pub struct BeaverSummary {
    pub filename: String,
    pub path: String,
    pub sender: Option<String>,
    pub created_at: Option<String>,
    pub name: Option<String>,
    pub envelope_id: Option<String>,
    pub envelope_type: Option<String>,
    pub manifest_type: Option<String>,
    pub manifest_func: Option<String>,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
}

#[tauri::command]
pub fn get_session_beaver_summaries(session_id: String) -> Result<Vec<BeaverSummary>, String> {
    let session = get_session(session_id.clone())?;
    let owner = session.owner.clone();
    let biovault_home = resolve_biovault_home_path();

    let mut results = Vec::new();
    let mut seen_files = std::collections::HashSet::new();

    // Path 1: Owner's session folder (our outgoing messages)
    // {biovault_home}/unencrypted/{owner}/shared/biovault/sessions/{session_id}/
    let owner_path = biovault_home
        .join("unencrypted")
        .join(&owner)
        .join("shared")
        .join("biovault")
        .join("sessions")
        .join(&session.session_id);

    // Path 2: Peer's session folder (their messages synced to us via datasites)
    // {biovault_home}/unencrypted/datasites/{peer}/shared/biovault/sessions/{session_id}/
    let peer_path = if let Some(ref peer) = session.peer {
        Some(
            biovault_home
                .join("unencrypted")
                .join("datasites")
                .join(peer)
                .join("shared")
                .join("biovault")
                .join("sessions")
                .join(&session.session_id),
        )
    } else {
        None
    };

    // Collect paths to scan
    let paths_to_scan: Vec<&std::path::Path> = [Some(owner_path.as_path()), peer_path.as_deref()]
        .into_iter()
        .flatten()
        .filter(|p| p.exists())
        .collect();

    for scan_path in paths_to_scan {
        let entries = match std::fs::read_dir(scan_path) {
            Ok(e) => e,
            Err(e) => {
                eprintln!(
                    "[Sessions] Warning: Failed to read session folder {}: {}",
                    scan_path.display(),
                    e
                );
                continue;
            }
        };

        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("beaver") {
                continue;
            }

            let filename = path
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown.beaver".to_string());

            // Skip if we've already seen this file (dedup across owner/peer paths)
            if !seen_files.insert(filename.clone()) {
                continue;
            }

            let contents = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!(
                        "Warning: Failed to read beaver file {}: {}",
                        path.display(),
                        e
                    );
                    continue;
                }
            };

            let json: serde_json::Value = match serde_json::from_str(&contents) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!(
                        "Warning: Failed to parse beaver file {}: {}",
                        path.display(),
                        e
                    );
                    continue;
                }
            };

            let manifest = json.get("manifest").cloned().unwrap_or_default();
            let manifest_type = manifest
                .get("type")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let manifest_func = manifest
                .get("func_name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let inputs = json
                .get("inputs")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();

            let outputs = json
                .get("outputs")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();

            results.push(BeaverSummary {
                filename,
                path: path.to_string_lossy().to_string(),
                sender: json
                    .get("sender")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                created_at: json
                    .get("created_at")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                name: json
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                envelope_id: json
                    .get("envelope_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                envelope_type: json
                    .get("manifest")
                    .and_then(|m| m.get("envelope_type"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| manifest_type.clone()),
                manifest_type,
                manifest_func,
                inputs,
                outputs,
            });
        }
    }

    // Sort by created_at descending
    results.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(results)
}

#[tauri::command]
pub fn send_session_chat_message(session_id: String, body: String) -> Result<VaultMessage, String> {
    if body.trim().is_empty() {
        return Err("Message body cannot be empty".to_string());
    }

    let session = get_session(session_id.clone())?;
    // peer field always represents "the other person" regardless of role
    let recipient = session
        .peer
        .clone()
        .ok_or_else(|| "No peer set for this session".to_string())?;

    let subject = format!("Session: {}", session.name);
    let metadata = serde_json::json!({
        "session_chat": {
            "session_id": session_id.clone(),
            "session_name": session.name,
            "from": get_owner_email(),
            "created_at": chrono::Utc::now().to_rfc3339(),
        }
    });

    // Find the last message in this session's thread to chain messages together
    // This ensures all session chat messages appear in the same thread in Messages tab
    let reply_to = find_session_thread_message(&session_id);

    messages::send_message(MessageSendRequest {
        to: Some(recipient),
        body,
        subject: Some(subject),
        reply_to,
        message_type: Some("text".to_string()),
        metadata: Some(metadata),
    })
}

/// Find an existing message in the session thread to reply to
/// This allows session chat messages to be grouped in the same thread
fn find_session_thread_message(session_id: &str) -> Option<String> {
    let config = load_message_config().ok()?;
    let db = open_message_db(&config).ok()?;

    let messages = db.list_messages(None).ok()?;

    // Find any message with this session_id in metadata (prefer the first/oldest one for thread consistency)
    let mut session_messages: Vec<_> = messages
        .into_iter()
        .filter(|m| {
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
        })
        .collect();

    // Sort by created_at ascending to get the first message (which starts the thread)
    session_messages.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    // Return the first message's ID - this is the thread starter, replying to it chains all messages
    session_messages.first().map(|m| m.id.clone())
}

// ============================================================================
// Session Datasets
// ============================================================================

/// Parsed dataset URL info
struct DatasetUrlInfo {
    owner: String,
    name: String,
}

/// Parse a syft:// dataset URL to extract owner and name
fn parse_dataset_url(url: &str) -> Option<DatasetUrlInfo> {
    // Format: syft://owner@domain/public/biovault/datasets/name/dataset.yaml
    if !url.starts_with("syft://") {
        return None;
    }

    let remainder = &url[7..]; // Skip "syft://"
    let parts: Vec<&str> = remainder.split('/').collect();

    if parts.len() < 5 {
        return None;
    }

    let owner = parts[0].to_string();

    // Find "datasets" in the path and get the next part as name
    for (i, part) in parts.iter().enumerate() {
        if *part == "datasets" && i + 1 < parts.len() {
            return Some(DatasetUrlInfo {
                owner,
                name: parts[i + 1].to_string(),
            });
        }
    }

    None
}

#[tauri::command]
pub fn add_dataset_to_session(
    session_id: String,
    dataset_url: String,
    role: Option<String>,
) -> Result<SessionDataset, String> {
    let db = BioVaultDb::new().map_err(|e| format!("Failed to open database: {}", e))?;

    // Verify session exists
    let _: i64 = db
        .connection()
        .query_row(
            "SELECT id FROM sessions WHERE session_id = ?1",
            [&session_id],
            |row| row.get(0),
        )
        .map_err(|_| format!("Session not found: {}", session_id))?;

    let info = parse_dataset_url(&dataset_url)
        .ok_or_else(|| format!("Invalid dataset URL: {}", dataset_url))?;

    let request = AddSessionDatasetRequest {
        session_id: session_id.clone(),
        dataset_public_url: dataset_url.clone(),
        dataset_owner: info.owner.clone(),
        dataset_name: info.name.clone(),
        role,
    };

    add_session_dataset(&db, &request)
        .map_err(|e| format!("Failed to add dataset to session: {}", e))?;

    // Return the newly added dataset
    let datasets = get_session_datasets(&db, &session_id)
        .map_err(|e| format!("Failed to get session datasets: {}", e))?;

    datasets
        .into_iter()
        .find(|d| d.dataset_public_url == dataset_url)
        .ok_or_else(|| "Failed to retrieve added dataset".to_string())
}

#[tauri::command]
pub fn remove_dataset_from_session(
    session_id: String,
    dataset_url: String,
) -> Result<bool, String> {
    let db = BioVaultDb::new().map_err(|e| format!("Failed to open database: {}", e))?;

    remove_session_dataset(&db, &session_id, &dataset_url)
        .map_err(|e| format!("Failed to remove dataset from session: {}", e))
}

#[tauri::command]
pub fn list_session_datasets(session_id: String) -> Result<Vec<SessionDataset>, String> {
    let db = BioVaultDb::new().map_err(|e| format!("Failed to open database: {}", e))?;

    get_session_datasets(&db, &session_id)
        .map_err(|e| format!("Failed to list session datasets: {}", e))
}

/// Create a session with associated datasets
#[tauri::command]
pub fn create_session_with_datasets(
    request: CreateSessionRequest,
    datasets: Vec<String>,
) -> Result<Session, String> {
    // First create the session
    let session = create_session(request)?;

    // Then add the datasets
    let db = BioVaultDb::new().map_err(|e| format!("Failed to open database: {}", e))?;

    for dataset_url in datasets {
        if let Some(info) = parse_dataset_url(&dataset_url) {
            let req = AddSessionDatasetRequest {
                session_id: session.session_id.clone(),
                dataset_public_url: dataset_url,
                dataset_owner: info.owner,
                dataset_name: info.name,
                role: Some("shared".to_string()),
            };
            if let Err(e) = add_session_dataset(&db, &req) {
                eprintln!("Warning: Failed to add dataset to session: {}", e);
            }
        }
    }

    // Update session.json with dataset info
    let private_session_path = get_private_session_path(&session.session_id);
    if private_session_path.exists() {
        if let Ok(datasets_list) = get_session_datasets(&db, &session.session_id) {
            let config_path = private_session_path.join("session.json");
            if config_path.exists() {
                if let Ok(content) = fs::read_to_string(&config_path) {
                    if let Ok(mut config) = serde_json::from_str::<serde_json::Value>(&content) {
                        config["datasets"] = serde_json::json!(datasets_list
                            .iter()
                            .map(|d| serde_json::json!({
                                "owner": d.dataset_owner,
                                "name": d.dataset_name,
                                "public_url": d.dataset_public_url,
                                "role": d.role,
                            }))
                            .collect::<Vec<_>>());
                        let _ =
                            fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap());
                    }
                }
            }
        }
    }

    Ok(session)
}
