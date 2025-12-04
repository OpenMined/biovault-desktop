// WebSocket bridge for browser development
// This allows the Chrome browser to call Tauri commands via WebSocket

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::net::{TcpListener, TcpStream};
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

        // Execute the Tauri command
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

        let response_text = serde_json::to_string(&ws_response).unwrap();
        if let Err(e) = write.send(Message::Text(response_text)).await {
            crate::desktop_log!("❌ WebSocket write error: {}", e);
            break;
        }
    }

    crate::desktop_log!("🔌 WebSocket connection closed: {}", addr);
}

async fn execute_command(app: &AppHandle, cmd: &str, args: Value) -> Result<Value, String> {
    // Get the app state
    let state = app.state::<crate::AppState>();

    // Match command names and call the appropriate function
    // This is a simplified version - you'll need to add all commands
    match cmd {
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
