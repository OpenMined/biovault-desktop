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
    eprintln!("🔌 WebSocket connection from: {}", addr);

    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("❌ WebSocket handshake error: {}", e);
            return;
        }
    };

    let (mut write, mut read) = ws_stream.split();

    while let Some(msg) = read.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                eprintln!("❌ WebSocket read error: {}", e);
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
                eprintln!("❌ Failed to parse request: {}", e);
                continue;
            }
        };

        eprintln!("📨 WS Request: {} (id: {})", request.cmd, request.id);

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
            eprintln!("❌ WebSocket write error: {}", e);
            break;
        }
    }

    eprintln!("🔌 WebSocket connection closed: {}", addr);
}

async fn execute_command(app: &AppHandle, cmd: &str, _args: Value) -> Result<Value, String> {
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
        "check_is_onboarded" => {
            let result = crate::check_is_onboarded().map_err(|e| e.to_string())?;
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
        _ => {
            eprintln!("⚠️  Unhandled command: {}", cmd);
            Err(format!("Unhandled command: {}", cmd))
        }
    }
}

pub async fn start_ws_server(app: AppHandle, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let listener = TcpListener::bind(&addr).await?;

    eprintln!("🚀 WebSocket server listening on ws://{}", addr);
    eprintln!("📝 Browser mode: Commands will be proxied via WebSocket");

    let app = Arc::new(app);

    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let app_clone = Arc::clone(&app);
            tokio::spawn(handle_connection(stream, app_clone));
        }
    });

    Ok(())
}
