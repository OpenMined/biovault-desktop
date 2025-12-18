// WebSocket bridge for browser development
// This allows the Chrome browser to call Tauri commands via WebSocket

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[derive(Deserialize)]
struct WsRequest {
    id: u32,
    cmd: String,
    #[serde(default)]
    args: Value,
}

#[derive(Serialize)]
struct WsResponse {
    id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

async fn handle_connection(stream: TcpStream, app: Arc<AppHandle>) {
    let addr = stream
        .peer_addr()
        .expect("connected streams should have a peer address");
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

        crate::desktop_log!("📨 WS Request: {} (id: {})", request.cmd, request.id);

        // Execute each request concurrently so a slow command doesn't stall the bridge.
        let app = Arc::clone(&app);
        let tx = tx.clone();
        tokio::spawn(async move {
            let response = execute_command(&app, &request.cmd, request.args).await;
            let ws_response = match response {
                Ok(result) => WsResponse {
                    id: request.id,
                    result: Some(result),
                    error: None,
                },
                Err(error) => WsResponse {
                    id: request.id,
                    result: None,
                    error: Some(error),
                },
            };

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

async fn execute_command(app: &AppHandle, cmd: &str, args: Value) -> Result<Value, String> {
    // Get the app state
    let state = app.state::<crate::AppState>();

    // Match command names and call the appropriate function
    // This is a simplified version - you'll need to add all commands
    match cmd {
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
        "get_files" => {
            let result = crate::get_files(state).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_projects" => {
            let result = crate::get_projects(state).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_runs" => {
            let result = crate::get_runs(state).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_command_logs" => {
            let result = crate::get_command_logs().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_settings" => {
            let result = crate::get_settings().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
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
            crate::update_saved_dependency_states().map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
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
        "get_available_project_examples" => {
            let result = crate::get_available_project_examples().map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_default_project_path" => {
            let name: Option<String> = args
                .get("name")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::get_default_project_path(name).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "create_project" => {
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
            let result = crate::create_project(
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
        "load_project_editor" => {
            let project_id: Option<i64> = args
                .get("projectId")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let project_path: Option<String> = args
                .get("projectPath")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::load_project_editor(state, project_id, project_path)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "save_project_editor" => {
            let project_id: Option<i64> = args
                .get("projectId")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let project_path: String = serde_json::from_value(
                args.get("projectPath")
                    .cloned()
                    .ok_or_else(|| "Missing projectPath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse projectPath: {}", e))?;
            let payload: serde_json::Value = args
                .get("payload")
                .cloned()
                .ok_or_else(|| "Missing payload".to_string())?;
            let result = crate::save_project_editor(state, project_id, project_path, payload)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "get_jupyter_status" => {
            let project_path: String = serde_json::from_value(
                args.get("projectPath")
                    .cloned()
                    .ok_or_else(|| "Missing projectPath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse projectPath: {}", e))?;
            let result = crate::get_jupyter_status(project_path).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "launch_jupyter" => {
            let project_path: String = serde_json::from_value(
                args.get("projectPath")
                    .cloned()
                    .ok_or_else(|| "Missing projectPath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse projectPath: {}", e))?;
            let python_version: Option<String> = args
                .get("pythonVersion")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::launch_jupyter(project_path, python_version)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "stop_jupyter" => {
            let project_path: String = serde_json::from_value(
                args.get("projectPath")
                    .cloned()
                    .ok_or_else(|| "Missing projectPath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse projectPath: {}", e))?;
            let result = crate::stop_jupyter(project_path)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "reset_jupyter" => {
            let project_path: String = serde_json::from_value(
                args.get("projectPath")
                    .cloned()
                    .ok_or_else(|| "Missing projectPath".to_string())?,
            )
            .map_err(|e| format!("Failed to parse projectPath: {}", e))?;
            let python_version: Option<String> = args
                .get("pythonVersion")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let result = crate::reset_jupyter(project_path, python_version)
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
        "trigger_syftbox_sync" => {
            crate::trigger_syftbox_sync()
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

        // --------------------------------------------------------------------
        // Sessions (required for session invite/accept/reject flows)
        // --------------------------------------------------------------------
        "get_sessions" => {
            let result = crate::get_sessions().map_err(|e| e.to_string())?;
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
        "get_pipelines" => {
            let state = app.state::<crate::AppState>();
            let result = crate::get_pipelines(state)
                .await
                .map_err(|e| e.to_string())?;
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
        // Pipeline commands
        // --------------------------------------------------------------------
        "get_runs_base_dir" => {
            let result = crate::commands::pipelines::get_runs_base_dir()
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
        "get_pipeline_runs" => {
            let result = crate::commands::pipelines::get_pipeline_runs(state.clone())
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "import_pipeline_with_deps" => {
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
                crate::commands::projects::import_pipeline_with_deps(url, name_override, overwrite)
                    .await
                    .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap())
        }
        "run_pipeline" => {
            // Get the main window for event emission
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "Main window not found".to_string())?;

            let pipeline_id: i64 = serde_json::from_value(
                args.get("pipelineId")
                    .cloned()
                    .ok_or_else(|| "Missing pipelineId".to_string())?,
            )
            .map_err(|e| format!("Failed to parse pipelineId: {}", e))?;

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

            let selection: Option<crate::commands::pipelines::PipelineRunSelection> = args
                .get("selection")
                .and_then(|v| serde_json::from_value(v.clone()).ok());

            let result = crate::commands::pipelines::run_pipeline(
                state.clone(),
                window,
                pipeline_id,
                input_overrides,
                results_dir,
                selection,
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
        _ => {
            crate::desktop_log!("⚠️  Unhandled command: {}", cmd);
            Err(format!("Unhandled command: {}", cmd))
        }
    }
}

pub async fn start_ws_server(app: AppHandle, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let listener = TcpListener::bind(&addr).await?;

    crate::desktop_log!("🚀 WebSocket server listening on ws://{}", addr);
    crate::desktop_log!("📝 Browser mode: Commands will be proxied via WebSocket");

    let app = Arc::new(app);

    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let app_clone = Arc::clone(&app);
            tokio::spawn(handle_connection(stream, app_clone));
        }
    });

    Ok(())
}
