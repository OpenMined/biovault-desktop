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
