use std::env;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn get_agent_api_commands(app: AppHandle) -> Result<Vec<String>, String> {
    let schema_content = if let Ok(resource_path) = app.path().resource_dir() {
        let schema_path = resource_path.join("docs").join("agent-api.json");
        std::fs::read_to_string(&schema_path).ok()
    } else {
        None
    };

    let schema_content =
        schema_content.or_else(|| std::fs::read_to_string("docs/agent-api.json").ok());
    let content = match schema_content {
        Some(content) => content,
        None => include_str!("../../../docs/agent-api.json").to_string(),
    };
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse schema: {}", e))?;
    let commands = value
        .get("commands")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "Schema missing commands".to_string())?;

    let mut names: Vec<String> = commands.keys().cloned().collect();
    names.sort();
    Ok(names)
}

#[tauri::command]
pub async fn restart_agent_bridge(app: AppHandle) -> Result<(), String> {
    let settings = crate::get_settings().map_err(|e| e.to_string())?;
    let env_enabled = env::var("DEV_WS_BRIDGE")
        .map(|v| !matches!(v.as_str(), "0" | "false" | "no"))
        .unwrap_or(true);
    let env_disabled = env::var("DEV_WS_BRIDGE_DISABLE")
        .map(|v| matches!(v.as_str(), "1" | "true" | "yes"))
        .unwrap_or(false);
    let ws_bridge_enabled = env_enabled && !env_disabled && settings.agent_bridge_enabled;

    let bridge_port = env::var("DEV_WS_BRIDGE_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(settings.agent_bridge_port);
    let http_port = env::var("DEV_WS_BRIDGE_HTTP_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(settings.agent_bridge_http_port);

    crate::ws_bridge::restart_agent_bridge(app, bridge_port, http_port, ws_bridge_enabled).await
}
