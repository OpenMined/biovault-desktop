use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

// Global bridge process handle
static BRIDGE_PROCESS: Mutex<Option<BridgeHandle>> = Mutex::new(None);

// Message log for debugging (stores last 100 messages)
static MESSAGE_LOG: Mutex<Vec<WhatsAppLogEntry>> = Mutex::new(Vec::new());
const MAX_LOG_ENTRIES: usize = 100;

struct BridgeHandle {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WhatsAppLogEntry {
    pub timestamp: String,
    pub direction: String, // "sent" or "received"
    pub phone: String,
    pub message: String,
    pub status: String, // "success", "error", "pending"
}

fn add_log_entry(direction: &str, phone: &str, message: &str, status: &str) {
    if let Ok(mut log) = MESSAGE_LOG.lock() {
        let entry = WhatsAppLogEntry {
            timestamp: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            direction: direction.to_string(),
            phone: phone.to_string(),
            message: message.to_string(),
            status: status.to_string(),
        };
        log.push(entry);
        // Keep only last MAX_LOG_ENTRIES
        if log.len() > MAX_LOG_ENTRIES {
            log.remove(0);
        }
    }
}

// Types for WhatsApp events
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WhatsAppStatus {
    pub connected: bool,
    pub jid: Option<String>,
    pub phone: Option<String>,
    pub name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WhatsAppQrEvent {
    pub qr: String, // base64 data URL
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WhatsAppMessageEvent {
    pub id: String,
    pub from: String,
    pub text: String,
    pub timestamp: i64,
    pub jid: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WhatsAppSentEvent {
    pub to: String,
    pub id: String,
    pub timestamp: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WhatsAppError {
    pub message: String,
    pub code: String,
}

// Bridge event from JSON
#[derive(Deserialize, Debug)]
struct BridgeEvent {
    event: String,
    data: serde_json::Value,
}

// Get path to Node binary
fn get_node_path() -> String {
    // Try common Node locations
    for path in &[
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/bin/node",
        "node", // System PATH
    ] {
        if std::path::Path::new(path).exists() || path == &"node" {
            return path.to_string();
        }
    }
    "node".to_string()
}

// Get path to bridge script
fn get_bridge_path() -> Result<String, String> {
    // First try relative to the app bundle (for production)
    if let Ok(exe_path) = std::env::current_exe() {
        let resources_path = exe_path.parent().and_then(|p| p.parent()).map(|p| {
            p.join("Resources")
                .join("whatsapp-bridge")
                .join("bridge.js")
        });

        if let Some(path) = resources_path {
            if path.exists() {
                return Ok(path.to_string_lossy().to_string());
            }
        }
    }

    // For development, try relative to workspace
    let dev_paths = &[
        "../whatsapp-bridge/bridge.js",
        "../../whatsapp-bridge/bridge.js",
        "./whatsapp-bridge/bridge.js",
    ];

    for path in dev_paths {
        if std::path::Path::new(path).exists() {
            return Ok(path.to_string());
        }
    }

    // Try from BIOVAULT_HOME
    if let Ok(home) = std::env::var("BIOVAULT_HOME") {
        let home_path = std::path::Path::new(&home)
            .parent()
            .map(|p| p.join("whatsapp-bridge").join("bridge.js"));
        if let Some(path) = home_path {
            if path.exists() {
                return Ok(path.to_string_lossy().to_string());
            }
        }
    }

    Err("WhatsApp bridge not found. Please ensure whatsapp-bridge is installed.".to_string())
}

// Start the bridge process if not already running
fn ensure_bridge_running(app: &AppHandle) -> Result<(), String> {
    let mut bridge = BRIDGE_PROCESS.lock().map_err(|e| e.to_string())?;

    if bridge.is_some() {
        // Check if process is still alive
        if let Some(ref mut handle) = *bridge {
            match handle.child.try_wait() {
                Ok(Some(_)) => {
                    // Process exited, need to restart
                    *bridge = None;
                }
                Ok(None) => {
                    // Still running
                    return Ok(());
                }
                Err(_) => {
                    *bridge = None;
                }
            }
        }
    }

    // Start new bridge process
    let node_path = get_node_path();
    let bridge_path = get_bridge_path()?;

    crate::desktop_log!("📱 Starting WhatsApp bridge: {} {}", node_path, bridge_path);

    let mut child = Command::new(&node_path)
        .arg(&bridge_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start WhatsApp bridge: {}", e))?;

    let stdin = child.stdin.take().ok_or("Failed to get stdin for bridge")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to get stdout for bridge")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Failed to get stderr for bridge")?;

    // Spawn thread to read stdout and emit events
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Ok(event) = serde_json::from_str::<BridgeEvent>(&line) {
                handle_bridge_event(&app_handle, event);
            }
        }
    });

    // Spawn thread to read stderr for debugging
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            crate::desktop_log!("📱 WhatsApp bridge: {}", line);
        }
    });

    *bridge = Some(BridgeHandle { child, stdin });

    crate::desktop_log!("✅ WhatsApp bridge started");
    Ok(())
}

// Send command to bridge
fn send_bridge_command(cmd: &serde_json::Value) -> Result<(), String> {
    let mut bridge = BRIDGE_PROCESS.lock().map_err(|e| e.to_string())?;

    if let Some(ref mut handle) = *bridge {
        let json = serde_json::to_string(cmd).map_err(|e| e.to_string())?;
        writeln!(handle.stdin, "{}", json).map_err(|e| format!("Failed to send command: {}", e))?;
        handle
            .stdin
            .flush()
            .map_err(|e| format!("Failed to flush: {}", e))?;
        Ok(())
    } else {
        Err("WhatsApp bridge not running".to_string())
    }
}

// Handle events from the bridge
fn handle_bridge_event(app: &AppHandle, event: BridgeEvent) {
    crate::desktop_log!("📱 WhatsApp event: {} - {:?}", event.event, event.data);

    match event.event.as_str() {
        "qr" => {
            if let Ok(qr_event) = serde_json::from_value::<WhatsAppQrEvent>(event.data) {
                let _ = app.emit("whatsapp:qr", qr_event);
            }
        }
        "connected" => {
            if let Ok(status) = serde_json::from_value::<WhatsAppStatus>(event.data) {
                let _ = app.emit("whatsapp:connected", status);
            }
        }
        "disconnected" => {
            let _ = app.emit("whatsapp:disconnected", event.data);
        }
        "message" => {
            if let Ok(msg) = serde_json::from_value::<WhatsAppMessageEvent>(event.data) {
                // Log incoming message
                add_log_entry("received", &msg.from, &msg.text, "success");
                let _ = app.emit("whatsapp:message", msg);
            }
        }
        "sent" => {
            if let Ok(sent) = serde_json::from_value::<WhatsAppSentEvent>(event.data) {
                // Update log entry to success (find pending entry for this phone)
                if let Ok(mut log) = MESSAGE_LOG.lock() {
                    for entry in log.iter_mut().rev() {
                        if entry.direction == "sent"
                            && entry.phone == sent.to
                            && entry.status == "pending"
                        {
                            entry.status = "success".to_string();
                            break;
                        }
                    }
                }
                let _ = app.emit("whatsapp:sent", sent);
            }
        }
        "status" => {
            if let Ok(status) = serde_json::from_value::<WhatsAppStatus>(event.data) {
                let _ = app.emit("whatsapp:status", status);
            }
        }
        "error" => {
            if let Ok(err) = serde_json::from_value::<WhatsAppError>(event.data) {
                let _ = app.emit("whatsapp:error", err);
            }
        }
        _ => {
            crate::desktop_log!("Unknown WhatsApp event: {}", event.event);
        }
    }
}

// Tauri Commands

#[tauri::command]
pub fn whatsapp_start_login(app: AppHandle) -> Result<(), String> {
    crate::desktop_log!("📱 whatsapp_start_login called");

    ensure_bridge_running(&app)?;

    let cmd = serde_json::json!({ "cmd": "login" });
    send_bridge_command(&cmd)
}

#[tauri::command]
pub fn whatsapp_logout(app: AppHandle) -> Result<(), String> {
    crate::desktop_log!("📱 whatsapp_logout called");

    ensure_bridge_running(&app)?;

    let cmd = serde_json::json!({ "cmd": "logout" });
    send_bridge_command(&cmd)
}

#[tauri::command]
pub fn whatsapp_get_status(app: AppHandle) -> Result<(), String> {
    crate::desktop_log!("📱 whatsapp_get_status called");

    ensure_bridge_running(&app)?;

    let cmd = serde_json::json!({ "cmd": "status" });
    send_bridge_command(&cmd)
}

#[tauri::command]
pub fn whatsapp_send_message(app: AppHandle, to: String, text: String) -> Result<(), String> {
    crate::desktop_log!("📱 whatsapp_send_message to: {}", to);

    ensure_bridge_running(&app)?;

    let cmd = serde_json::json!({
        "cmd": "send",
        "to": to,
        "text": text
    });
    send_bridge_command(&cmd)
}

#[tauri::command]
pub fn whatsapp_shutdown() -> Result<(), String> {
    crate::desktop_log!("📱 whatsapp_shutdown called");

    let mut bridge = BRIDGE_PROCESS.lock().map_err(|e| e.to_string())?;

    if let Some(ref mut handle) = *bridge {
        // Send shutdown command
        let cmd = serde_json::json!({ "cmd": "shutdown" });
        let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
        let _ = writeln!(handle.stdin, "{}", json);
        let _ = handle.stdin.flush();

        // Wait briefly then kill if needed
        std::thread::sleep(std::time::Duration::from_millis(500));
        let _ = handle.child.kill();
    }

    *bridge = None;
    crate::desktop_log!("✅ WhatsApp bridge shutdown");
    Ok(())
}

#[tauri::command]
pub fn whatsapp_check_auth_exists() -> Result<bool, String> {
    // Check global ~/.baileys directory (shared across BioVault instances)
    let auth_dir = dirs::home_dir()
        .map(|h| h.join(".baileys").join("creds.json"))
        .ok_or("Could not determine home directory")?;

    Ok(auth_dir.exists())
}

#[tauri::command]
pub fn whatsapp_get_auth_path() -> Result<String, String> {
    let auth_dir = dirs::home_dir()
        .map(|h| h.join(".baileys"))
        .ok_or("Could not determine home directory")?;

    Ok(auth_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn whatsapp_open_auth_folder() -> Result<(), String> {
    let auth_dir = dirs::home_dir()
        .map(|h| h.join(".baileys"))
        .ok_or("Could not determine home directory")?;

    // Create directory if it doesn't exist
    if !auth_dir.exists() {
        std::fs::create_dir_all(&auth_dir)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    // Open in file explorer
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&auth_dir)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&auth_dir)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&auth_dir)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn whatsapp_reset_auth() -> Result<(), String> {
    let auth_dir = dirs::home_dir()
        .map(|h| h.join(".baileys"))
        .ok_or("Could not determine home directory")?;

    if auth_dir.exists() {
        std::fs::remove_dir_all(&auth_dir)
            .map_err(|e| format!("Failed to remove credentials: {}", e))?;
    }

    crate::desktop_log!("📱 WhatsApp credentials reset");
    Ok(())
}

#[tauri::command]
pub fn whatsapp_get_message_log() -> Result<Vec<WhatsAppLogEntry>, String> {
    let log = MESSAGE_LOG.lock().map_err(|e| e.to_string())?;
    Ok(log.clone())
}

#[tauri::command]
pub fn whatsapp_clear_message_log() -> Result<(), String> {
    let mut log = MESSAGE_LOG.lock().map_err(|e| e.to_string())?;
    log.clear();
    Ok(())
}

#[tauri::command]
pub async fn whatsapp_send_notification(app: AppHandle, message: String) -> Result<(), String> {
    // Load settings to get the notification phone number
    let settings = crate::commands::settings::load_settings_internal()?;
    let phone = settings.whatsapp_phone;

    if phone.is_empty() {
        return Err("WhatsApp notification phone not configured".to_string());
    }

    crate::desktop_log!("📱 Sending WhatsApp notification to {}: {}", phone, message);

    // Log the attempt
    add_log_entry("sent", &phone, &message, "pending");

    // Ensure bridge is running and send
    ensure_bridge_running(&app)?;

    let cmd = serde_json::json!({
        "cmd": "send",
        "to": phone,
        "text": message
    });
    send_bridge_command(&cmd)?;

    Ok(())
}
