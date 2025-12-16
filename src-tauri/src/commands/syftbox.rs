use crate::types::{SyftBoxConfigInfo, SyftBoxState};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::net::TcpListener;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use syftbox_sdk::syftbox::control as syftctl;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

static SYFTBOX_RUNNING: AtomicBool = AtomicBool::new(false);
static CONTROL_PLANE_LOG: once_cell::sync::Lazy<Mutex<Vec<ControlPlaneLogEntry>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(Vec::new()));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlPlaneLogEntry {
    pub timestamp: String,
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub error: Option<String>,
}

fn load_runtime_config() -> Result<syftbox_sdk::syftbox::config::SyftboxRuntimeConfig, String> {
    let mut cfg = biovault::config::Config::load()
        .map_err(|e| format!("SyftBox not configured yet: {}", e))?;

    // Require an email to build a usable runtime config, even if tokens are missing.
    let email = cfg
        .syftbox_credentials
        .as_ref()
        .and_then(|c| c.email.as_deref())
        .filter(|e| !e.trim().is_empty())
        .or_else(|| {
            let trimmed = cfg.email.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .ok_or_else(|| {
            "SyftBox email is not set. Add an email in Settings → SyftBox and try again."
                .to_string()
        })?
        .to_string();

    // If BioVault email is empty but creds have one, populate it so the runtime config has an identity.
    if cfg.email.trim().is_empty() {
        cfg.email = email.clone();
    }

    cfg.to_syftbox_runtime_config()
        .map_err(|e| format!("SyftBox config is incomplete: {}", e))
}

fn ensure_syftbox_config(
    runtime: &syftbox_sdk::syftbox::config::SyftboxRuntimeConfig,
) -> Result<(), String> {
    let mut cfg = biovault::config::Config::load().map_err(|e| e.to_string())?;

    let mut creds = cfg.syftbox_credentials.clone().unwrap_or_default();
    let email = if cfg.email.trim().is_empty() {
        creds.email.clone().unwrap_or_default()
    } else {
        cfg.email.clone()
    };
    if email.trim().is_empty() {
        return Err(
            "SyftBox email is not set. Add an email in Settings → SyftBox and try again."
                .to_string(),
        );
    }
    let server_url = creds
        .server_url
        .clone()
        .unwrap_or_else(|| "https://syftbox.net".to_string());
    let client_url = resolve_or_assign_client_url(&creds, &runtime.config_path)?;

    let existing_client_token = load_existing_client_token(&runtime.config_path);
    let client_token = creds
        .access_token
        .clone()
        .filter(|t| !t.trim().is_empty())
        .or(existing_client_token)
        .ok_or_else(|| "SyftBox access token is missing. Please sign in to SyftBox.".to_string())?;

    // Persist chosen client_url back into BioVault config so subsequent runs are consistent.
    creds.client_url = Some(client_url.clone());
    // Also persist token so subsequent runs don't block.
    if creds
        .access_token
        .as_ref()
        .filter(|t| !t.trim().is_empty())
        .is_none()
    {
        creds.access_token = Some(client_token.clone());
    }
    creds.data_dir = Some(runtime.data_dir.to_string_lossy().to_string());
    cfg.syftbox_credentials = Some(creds.clone());
    let config_path = biovault::config::Config::get_config_path().map_err(|e| e.to_string())?;
    if let Err(e) = cfg.save(config_path) {
        crate::desktop_log!(
            "⚠️ Failed to persist syftbox client_url into config.yaml: {}",
            e
        );
    }

    let config_json = json!({
        "data_dir": runtime.data_dir.to_string_lossy(),
        "email": email,
        "server_url": server_url,
        "client_url": client_url,
        "client_token": client_token,
        "refresh_token": creds.refresh_token.unwrap_or_default()
    });

    if let Some(parent) = runtime.config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if let Some(parent) = runtime.data_dir.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&runtime.data_dir).map_err(|e| e.to_string())?;
    fs::write(
        &runtime.config_path,
        serde_json::to_string_pretty(&config_json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

fn resolve_or_assign_client_url(
    creds: &biovault::config::SyftboxCredentials,
    config_path: &Path,
) -> Result<String, String> {
    // 1) Start from explicit value in creds
    let mut candidate = creds
        .client_url
        .as_ref()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());

    // 2) Fallback to existing syftbox config.json
    if candidate.is_none() && config_path.exists() {
        if let Ok(existing) = fs::read_to_string(config_path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&existing) {
                candidate = val
                    .get("client_url")
                    .and_then(|u| u.as_str())
                    .map(|u| u.trim().to_string())
                    .filter(|u| !u.is_empty());
            }
        }
    }

    // 3) Fallback to default
    let candidate = candidate.unwrap_or_else(|| "http://127.0.0.1:7938".to_string());

    // Try to bind chosen address; if busy, pick random free port.
    if let Some(bound) = try_bind_or_ephemeral(&candidate) {
        if bound != candidate {
            crate::desktop_log!("🔧 Requested SyftBox port busy, assigned {}", bound);
        }
        return Ok(bound);
    }

    Err("Failed to assign a control-plane port for SyftBox".to_string())
}

fn resolve_syftbox_log_path(
    runtime: &syftbox_sdk::syftbox::config::SyftboxRuntimeConfig,
) -> Option<String> {
    let mut candidates = vec![];

    candidates.push(
        runtime
            .data_dir
            .join(".syftbox")
            .join("logs")
            .join("syftbox.log"),
    );

    candidates.push(
        runtime
            .data_dir
            .join(".syftbox")
            .join("logs")
            .join("syftbox.log"),
    );

    if let Some(parent) = runtime.config_path.parent() {
        candidates.push(parent.join("logs").join("syftbox.log"));
    }

    for cand in &candidates {
        if cand.exists() {
            return Some(cand.to_string_lossy().to_string());
        }
    }

    candidates
        .into_iter()
        .next()
        .map(|p| p.to_string_lossy().to_string())
}

fn fallback_log_path() -> Option<String> {
    biovault::config::Config::default_syftbox_data_dir()
        .ok()
        .map(|d| d.join(".syftbox").join("logs").join("syftbox.log"))
        .map(|p| p.to_string_lossy().to_string())
}

#[derive(Debug, Clone, Deserialize)]
struct SyftBoxClientConfigFile {
    client_url: Option<String>,
    client_token: Option<String>,
    data_dir: Option<String>,
}

#[derive(Debug, Clone)]
struct SyftBoxClientConfig {
    client_url: String,
    client_token: String,
    data_dir: Option<String>,
}

fn load_syftbox_client_config() -> Result<SyftBoxClientConfig, String> {
    let config = biovault::config::Config::load()
        .map_err(|e| format!("SyftBox not configured yet: {}", e))?;
    let config_path = config
        .get_syftbox_config_path()
        .map_err(|e| format!("Failed to resolve syftbox config path: {}", e))?;
    let cfg_raw = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read syftbox config: {}", e))?;
    let cfg: SyftBoxClientConfigFile = serde_json::from_str(&cfg_raw)
        .map_err(|e| format!("Failed to parse syftbox config: {}", e))?;

    let client_url = cfg
        .client_url
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "SyftBox client_url missing from syftbox/config.json".to_string())?;
    let client_token = cfg
        .client_token
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "SyftBox client_token missing from syftbox/config.json".to_string())?;

    Ok(SyftBoxClientConfig {
        client_url,
        client_token,
        data_dir: cfg.data_dir,
    })
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyftBoxSyncFileStatus {
    pub path: String,
    pub state: String,
    #[serde(default)]
    pub conflict_state: Option<String>,
    #[serde(default)]
    pub progress: f64,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyftBoxSyncSummary {
    #[serde(default)]
    pub pending: i32,
    #[serde(default)]
    pub syncing: i32,
    #[serde(default)]
    pub completed: i32,
    #[serde(default)]
    pub error: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyftBoxSyncStatus {
    #[serde(default)]
    pub files: Vec<SyftBoxSyncFileStatus>,
    #[serde(default)]
    pub summary: Option<SyftBoxSyncSummary>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyftBoxUploadInfo {
    pub id: String,
    pub key: String,
    #[serde(default)]
    pub local_path: Option<String>,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub uploaded_bytes: i64,
    #[serde(default)]
    pub part_size: Option<i64>,
    #[serde(default)]
    pub part_count: Option<i32>,
    #[serde(default)]
    pub completed_parts: Option<Vec<i32>>,
    #[serde(default)]
    pub progress: f64,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SyftBoxQueueStatus {
    pub control_plane_url: Option<String>,
    pub data_dir: Option<String>,
    pub sync: Option<SyftBoxSyncStatus>,
    pub uploads: Option<Vec<SyftBoxUploadInfo>>,
    pub status: Option<SyftBoxStatus>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SyftBoxUploadList {
    uploads: Vec<SyftBoxUploadInfo>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct SyftBoxStatus {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub ts: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub revision: Option<String>,
    #[serde(default)]
    pub build_date: Option<String>,
    #[serde(default)]
    pub datasite: Option<SyftBoxDatasiteStatus>,
    #[serde(default)]
    pub runtime: Option<SyftBoxRuntimeStatus>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct SyftBoxDatasiteStatus {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub config: Option<SyftBoxDatasiteConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct SyftBoxDatasiteConfig {
    #[serde(default)]
    pub data_dir: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub server_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct SyftBoxRuntimeStatus {
    #[serde(default)]
    pub client: Option<SyftBoxRuntimeClient>,
    #[serde(default)]
    pub websocket: Option<SyftBoxRuntimeSocket>,
    #[serde(default)]
    pub http: Option<SyftBoxRuntimeHttp>,
    #[serde(default)]
    pub sync: Option<SyftBoxRuntimeSync>,
    #[serde(default)]
    pub uploads: Option<SyftBoxRuntimeUploads>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct SyftBoxRuntimeClient {
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub revision: Option<String>,
    #[serde(default)]
    pub build_date: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub uptime_sec: Option<i64>,
    #[serde(default)]
    pub server_url: Option<String>,
    #[serde(default)]
    pub client_url: Option<String>,
    #[serde(default)]
    pub client_token_configured: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct SyftBoxRuntimeSocket {
    #[serde(default)]
    pub connected: Option<bool>,
    #[serde(default)]
    pub bytes_sent_total: Option<u64>,
    #[serde(default)]
    pub bytes_recv_total: Option<u64>,
    #[serde(default)]
    pub last_sent_at: Option<String>,
    #[serde(default)]
    pub last_recv_at: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct SyftBoxRuntimeHttp {
    #[serde(default)]
    pub bytes_sent_total: Option<u64>,
    #[serde(default)]
    pub bytes_recv_total: Option<u64>,
    #[serde(default)]
    pub last_sent_at: Option<String>,
    #[serde(default)]
    pub last_recv_at: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct SyftBoxRuntimeSync {
    #[serde(default)]
    pub last_full_sync_at: Option<String>,
    #[serde(default)]
    pub tracked_files: Option<u64>,
    #[serde(default)]
    pub syncing_files: Option<u64>,
    #[serde(default)]
    pub conflicted_files: Option<u64>,
    #[serde(default)]
    pub rejected_files: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct SyftBoxRuntimeUploads {
    #[serde(default)]
    pub total: Option<u64>,
    #[serde(default)]
    pub uploading: Option<u64>,
    #[serde(default)]
    pub pending: Option<u64>,
    #[serde(default)]
    pub paused: Option<u64>,
    #[serde(default)]
    pub error: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyftBoxDiagnostics {
    pub running: bool,
    pub mode: String,
    pub pids: Vec<u32>,
    pub config_path: Option<String>,
    pub data_dir: Option<String>,
    pub log_path: Option<String>,
    pub client_url: Option<String>,
    pub server_url: Option<String>,
    pub client_token: Option<String>,
    pub refresh_token: Option<String>,
    pub status: Option<SyftBoxStatus>,
    pub control_plane_requests: Vec<ControlPlaneLogEntry>,
}

fn normalize_percent(value: f64) -> f64 {
    if value <= 1.0 {
        (value * 100.0).min(100.0)
    } else {
        value
    }
}

fn normalize_sync_status(sync: &mut SyftBoxSyncStatus) {
    for file in &mut sync.files {
        file.progress = normalize_percent(file.progress);
    }
}

fn normalize_uploads(list: &mut [SyftBoxUploadInfo]) {
    for upload in list.iter_mut() {
        upload.progress = normalize_percent(upload.progress);
    }
}

fn record_control_plane_event(method: &str, url: &str, status: Option<u16>, error: Option<String>) {
    let entry = ControlPlaneLogEntry {
        timestamp: Utc::now().to_rfc3339(),
        method: method.to_string(),
        url: url.to_string(),
        status,
        error: error.clone(),
    };
    if let Ok(mut log) = CONTROL_PLANE_LOG.lock() {
        log.push(entry);
        if log.len() > 100 {
            let excess = log.len() - 100;
            log.drain(0..excess);
        }
    }
    match error {
        Some(err) => crate::desktop_log!("🛰️ {} {} -> error: {}", method, url, err),
        None => {
            let s = status
                .map(|c| c.to_string())
                .unwrap_or_else(|| "unknown".into());
            crate::desktop_log!("🛰️ {} {} -> {}", method, url, s);
        }
    }
}

fn try_bind_or_ephemeral(url: &str) -> Option<String> {
    // Normalize to host:port
    let mut trimmed = url.trim().to_string();
    trimmed = trimmed
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .to_string();
    let host_port = if let Some((hp, _rest)) = trimmed.split_once('/') {
        hp.to_string()
    } else {
        trimmed
    };
    let host_port = if host_port.is_empty() {
        "127.0.0.1:7938".to_string()
    } else if host_port.contains(':') {
        host_port
    } else {
        format!("{}:7938", host_port)
    };

    // First try binding the requested host:port
    if TcpListener::bind(&host_port).is_ok() {
        return Some(format!("http://{}", host_port));
    }

    // Fallback to an ephemeral port
    if let Ok(listener) = TcpListener::bind("127.0.0.1:0") {
        if let Ok(addr) = listener.local_addr() {
            let port = addr.port();
            drop(listener);
            return Some(format!("http://127.0.0.1:{}", port));
        }
    }
    None
}

async fn cp_get<T: for<'de> Deserialize<'de>>(
    client: &reqwest::Client,
    base: &str,
    path: &str,
    token: &str,
) -> Result<T, String> {
    let url = format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    let resp = client.get(&url).bearer_auth(token).send().await;

    let resp = match resp {
        Ok(resp) => resp,
        Err(e) => {
            let err = format!("Request to {} failed: {}", url, e);
            record_control_plane_event("GET", &url, None, Some(err.clone()));
            return Err(err);
        }
    };

    let status = resp.status();
    if !status.is_success() {
        let err = format!("Request to {} failed: HTTP {}", url, status);
        record_control_plane_event("GET", &url, Some(status.as_u16()), Some(err.clone()));
        return Err(err);
    }

    let parsed = resp.json::<T>().await;
    match parsed {
        Ok(val) => {
            record_control_plane_event("GET", &url, Some(status.as_u16()), None);
            Ok(val)
        }
        Err(e) => {
            let err = format!("Failed to decode response from {}: {}", url, e);
            record_control_plane_event("GET", &url, Some(status.as_u16()), Some(err.clone()));
            Err(err)
        }
    }
}

fn probe_control_plane_ready(max_attempts: usize, delay_ms: u64) -> Result<(), String> {
    let cfg = load_syftbox_client_config()?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let endpoints = ["/v1/sync/status", "/v1/uploads/"];
    for attempt in 0..max_attempts {
        let mut all_ok = true;
        for path in endpoints {
            let url = format!(
                "{}/{}",
                cfg.client_url.trim_end_matches('/'),
                path.trim_start_matches('/')
            );
            match client.get(&url).bearer_auth(&cfg.client_token).send() {
                Ok(resp) if resp.status().is_success() => {
                    record_control_plane_event("GET", &url, Some(resp.status().as_u16()), None);
                }
                Ok(resp) => {
                    let err = format!("HTTP {}", resp.status());
                    record_control_plane_event(
                        "GET",
                        &url,
                        Some(resp.status().as_u16()),
                        Some(err),
                    );
                    all_ok = false;
                }
                Err(e) => {
                    let err = format!("{}", e);
                    record_control_plane_event("GET", &url, None, Some(err));
                    all_ok = false;
                }
            }
        }

        if all_ok {
            return Ok(());
        }

        if attempt + 1 < max_attempts {
            std::thread::sleep(Duration::from_millis(delay_ms));
        }
    }

    Err("SyftBox control plane is not responding".to_string())
}

fn find_syftbox_pids(runtime: &syftbox_sdk::syftbox::config::SyftboxRuntimeConfig) -> Vec<u32> {
    let mut pids = Vec::new();
    if let Ok(output) = Command::new("ps").arg("aux").output() {
        if output.status.success() {
            let ps_output = String::from_utf8_lossy(&output.stdout);
            let config_str = runtime.config_path.to_string_lossy();
            let data_dir_str = runtime.data_dir.to_string_lossy();
            for line in ps_output.lines() {
                if !line.contains("syftbox") {
                    continue;
                }
                if !(line.contains(&*config_str) || line.contains(&*data_dir_str)) {
                    continue;
                }
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() > 1 {
                    if let Ok(pid) = parts[1].parse::<u32>() {
                        pids.push(pid);
                    }
                }
            }
        }
    }
    pids
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    crate::desktop_log!("🌐 Opening URL: {}", url);

    // Use webbrowser crate or OS-specific command to open URL
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", &url])
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn syftbox_request_otp(email: String, server_url: Option<String>) -> Result<(), String> {
    crate::desktop_log!(
        "📧 syftbox_request_otp called for: {} (server: {:?})",
        email,
        server_url
    );

    if let Ok(cfg) = biovault::config::Config::load() {
        if let Some(creds) = cfg.syftbox_credentials.as_ref() {
            crate::desktop_log!(
                "ℹ️ syftbox_credentials server_url: {:?}",
                creds.server_url.as_ref()
            );
        }
    }
    if let Ok(env_server) = std::env::var("SYFTBOX_SERVER_URL") {
        crate::desktop_log!("ℹ️ SYFTBOX_SERVER_URL env: {}", env_server);
    }

    match biovault::cli::commands::syftbox::request_otp(Some(email), None, server_url.clone()).await
    {
        Ok(_) => {}
        Err(err) => {
            crate::desktop_log!("❌ syftbox_request_otp error: {:?}", err);
            return Err(format!(
                "Failed to request OTP via {:?}: {}",
                server_url, err
            ));
        }
    }

    crate::desktop_log!("✅ OTP request sent successfully");
    Ok(())
}

#[tauri::command]
pub async fn syftbox_submit_otp(
    code: String,
    email: String,
    server_url: Option<String>,
) -> Result<(), String> {
    crate::desktop_log!("🔐 syftbox_submit_otp called (server: {:?})", server_url);

    match biovault::cli::commands::syftbox::submit_otp(
        &code,
        Some(email),
        None,
        server_url.clone(),
        None,
        None,
    )
    .await
    {
        Ok(_) => {}
        Err(err) => {
            crate::desktop_log!("❌ syftbox_submit_otp error: {:?}", err);
            return Err(format!(
                "Failed to verify OTP via {:?}: {}",
                server_url, err
            ));
        }
    }

    // After auth, ensure `syftbox/config.json` exists so queue polling + control plane startup
    // have the local client_url/token config available (matches macOS onboarding behavior).
    match load_runtime_config() {
        Ok(runtime) => {
            if let Err(e) = ensure_syftbox_config(&runtime) {
                crate::desktop_log!("⚠️ Failed to write syftbox/config.json after auth: {}", e);
            }
        }
        Err(e) => {
            crate::desktop_log!("⚠️ Could not load runtime config after auth: {}", e);
        }
    }

    crate::desktop_log!("✅ OTP verified and credentials stored");
    Ok(())
}

#[tauri::command]
pub fn check_syftbox_auth() -> Result<bool, String> {
    crate::desktop_log!("🔍 check_syftbox_auth called");

    // Load BioVault config to check if syftbox_credentials exist
    let config = match biovault::config::Config::load() {
        Ok(cfg) => cfg,
        Err(_) => return Ok(false), // No config = not authenticated
    };

    // Check if syftbox_credentials exist and have required fields
    let is_authenticated = if let Some(creds) = config.syftbox_credentials {
        creds.access_token.is_some() && creds.refresh_token.is_some()
    } else {
        false
    };

    crate::desktop_log!("  Authentication status: {}", is_authenticated);
    Ok(is_authenticated)
}

#[tauri::command]
pub fn get_syftbox_config_info() -> Result<SyftBoxConfigInfo, String> {
    crate::desktop_log!("🔍 get_syftbox_config_info called");

    // Get the syftbox config path
    let config = biovault::config::Config::load().ok();
    let mut data_dir: Option<String> = None;
    let mut data_dir_error: Option<String> = None;
    let mut log_path: Option<String> = None;

    if let Some(cfg) = config.as_ref() {
        match cfg.get_syftbox_data_dir() {
            Ok(dir) => data_dir = Some(dir.to_string_lossy().to_string()),
            Err(e) => data_dir_error = Some(e.to_string()),
        }
        if let Ok(runtime) = cfg.to_syftbox_runtime_config() {
            log_path = resolve_syftbox_log_path(&runtime);
        }
    } else if let Ok(env_dir) = std::env::var("SYFTBOX_DATA_DIR") {
        data_dir = Some(env_dir);
    }
    let syftbox_config_path = match &config {
        Some(cfg) => cfg.get_syftbox_config_path().ok(),
        None => None,
    };

    let config_path = syftbox_config_path
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| {
            // Default path if not configured
            biovault::config::Config::default_syftbox_config_path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| "<BioVault syftbox/config.json>".to_string())
        });

    // Check if authenticated by looking at syftbox_credentials
    let (has_access_token, has_refresh_token) = match config {
        Some(cfg) => match cfg.syftbox_credentials {
            Some(creds) => (creds.access_token.is_some(), creds.refresh_token.is_some()),
            None => (false, false),
        },
        None => (false, false),
    };

    let is_authenticated = has_access_token && has_refresh_token;

    crate::desktop_log!("  Config path: {}", config_path);
    crate::desktop_log!("  Has access token: {}", has_access_token);
    crate::desktop_log!("  Has refresh token: {}", has_refresh_token);
    crate::desktop_log!("  Is authenticated: {}", is_authenticated);
    if let Some(ref dir) = data_dir {
        crate::desktop_log!("  Data dir: {}", dir);
    }
    if let Some(ref err) = data_dir_error {
        crate::desktop_log!("  Data dir error: {}", err);
    }
    if log_path.is_none() {
        log_path = fallback_log_path();
    }

    Ok(SyftBoxConfigInfo {
        is_authenticated,
        config_path,
        has_access_token,
        has_refresh_token,
        data_dir,
        data_dir_error,
        log_path,
    })
}

#[tauri::command]
pub fn get_syftbox_state() -> Result<SyftBoxState, String> {
    let (running, mode, mut log_path, error) = match load_runtime_config() {
        Ok(runtime) => {
            let state = syftctl::state(&runtime).map_err(|e| e.to_string())?;
            let log_path = resolve_syftbox_log_path(&runtime);
            (
                state.running,
                state.mode,
                log_path,
                None::<String>, // no error
            )
        }
        Err(e) => {
            crate::desktop_log!("⚠️ No runtime config for SyftBox state: {}", e);
            (false, syftctl::SyftBoxMode::Direct, None, Some(e))
        }
    };
    if log_path.is_none() {
        log_path = fallback_log_path();
    }
    SYFTBOX_RUNNING.store(running, Ordering::SeqCst);
    Ok(SyftBoxState {
        running,
        mode: format!("{:?}", mode),
        log_path,
        error,
    })
}

#[tauri::command]
pub fn start_syftbox_client() -> Result<SyftBoxState, String> {
    let runtime = load_runtime_config()?;
    ensure_syftbox_config(&runtime)?;

    // If the config file still isn't present, report a friendly auth/setup message.
    if !runtime.config_path.exists() {
        return Err(
            "SyftBox is not connected yet. Open Settings → SyftBox and sign in first.".to_string(),
        );
    }

    // Ensure we don't leave an older syftbox instance running with the same config.
    if let Err(e) = syftctl::stop_syftbox(&runtime) {
        crate::desktop_log!("ℹ️ Attempt to stop existing SyftBox before start: {}", e);
    }

    match syftctl::start_syftbox(&runtime) {
        Ok(started) => {
            if started {
                crate::desktop_log!("🚀 SyftBox started");
            } else {
                crate::desktop_log!("ℹ️ SyftBox already running");
            }
            SYFTBOX_RUNNING.store(true, Ordering::SeqCst);
            // Verify control plane is reachable so we don't leave the UI stuck on 404s.
            if let Err(e) = probe_control_plane_ready(10, 500) {
                crate::desktop_log!("⚠️ SyftBox control plane not responding: {}", e);
                return Err(e);
            }
            Ok(SyftBoxState {
                running: true,
                mode: if runtime.data_dir.join(".sbenv").exists() {
                    "Sbenv".to_string()
                } else {
                    "Direct".to_string()
                },
                log_path: resolve_syftbox_log_path(&runtime),
                error: None,
            })
        }
        Err(e) => {
            crate::desktop_log!("❌ Failed to start SyftBox: {}", e);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub fn stop_syftbox_client() -> Result<SyftBoxState, String> {
    let runtime = load_runtime_config()?;
    match syftctl::stop_syftbox(&runtime) {
        Ok(stopped) => {
            if stopped {
                crate::desktop_log!("🛑 SyftBox stopped");
            } else {
                crate::desktop_log!("ℹ️ SyftBox was not running");
            }
            SYFTBOX_RUNNING.store(false, Ordering::SeqCst);
            Ok(SyftBoxState {
                running: false,
                mode: if runtime.data_dir.join(".sbenv").exists() {
                    "Sbenv".to_string()
                } else {
                    "Direct".to_string()
                },
                log_path: resolve_syftbox_log_path(&runtime),
                error: None,
            })
        }
        Err(e) => {
            crate::desktop_log!("❌ Failed to stop SyftBox: {}", e);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub fn get_syftbox_diagnostics() -> Result<SyftBoxDiagnostics, String> {
    let mut running = false;
    let mut mode = "Unknown".to_string();
    let mut pids: Vec<u32> = vec![];
    let mut config_path: Option<String> = None;
    let mut data_dir: Option<String> = None;
    let mut log_path: Option<String> = None;
    let mut client_url: Option<String> = None;
    let mut server_url: Option<String> = None;
    let mut client_token: Option<String> = None;
    let mut refresh_token: Option<String> = None;
    let mut status: Option<SyftBoxStatus> = None;

    if let Ok(cfg) = biovault::config::Config::load() {
        if let Some(creds) = cfg.syftbox_credentials.as_ref() {
            client_url = creds.client_url.clone();
            server_url = creds.server_url.clone();
            client_token = creds.access_token.clone();
            refresh_token = creds.refresh_token.clone();
            data_dir = creds.data_dir.clone();
        }
        if config_path.is_none() {
            if let Ok(path) = cfg.get_syftbox_config_path() {
                config_path = Some(path.to_string_lossy().to_string());
            }
        }
    }

    if let Ok(runtime) = load_runtime_config() {
        data_dir = Some(runtime.data_dir.to_string_lossy().to_string());
        if config_path.is_none() {
            config_path = Some(runtime.config_path.to_string_lossy().to_string());
        }
        if log_path.is_none() {
            log_path = resolve_syftbox_log_path(&runtime);
        }
        if client_url.is_none() || client_token.is_none() || server_url.is_none() {
            if let Ok(raw) = fs::read_to_string(&runtime.config_path) {
                if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                    if client_url.is_none() {
                        client_url = val
                            .get("client_url")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                    }
                    if client_token.is_none() {
                        client_token = val
                            .get("client_token")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                    }
                    if server_url.is_none() {
                        server_url = val
                            .get("server_url")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                    }
                    if refresh_token.is_none() {
                        refresh_token = val
                            .get("refresh_token")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                    }
                }
            }
        }
        if let Ok(state) = syftctl::state(&runtime) {
            running = state.running;
            mode = format!("{:?}", state.mode);
        }
        pids = find_syftbox_pids(&runtime);
        if log_path.is_none() {
            log_path = resolve_syftbox_log_path(&runtime);
        }
    }

    // Try to grab a fresh status snapshot so diagnostics always has runtime info.
    if status.is_none() {
        if let (Some(url), Some(token)) = (client_url.clone(), client_token.clone()) {
            let cp_url = format!(
                "{}/{}",
                url.trim_end_matches('/'),
                "v1/status".trim_start_matches('/')
            );
            if let Ok(client) = reqwest::blocking::Client::builder()
                .timeout(Duration::from_millis(1500))
                .build()
            {
                match client.get(&cp_url).bearer_auth(&token).send() {
                    Ok(resp) => {
                        let code = resp.status().as_u16();
                        if resp.status().is_success() {
                            match resp.json::<SyftBoxStatus>() {
                                Ok(s) => {
                                    record_control_plane_event("GET", &cp_url, Some(code), None);
                                    status = Some(s);
                                }
                                Err(e) => {
                                    record_control_plane_event(
                                        "GET",
                                        &cp_url,
                                        Some(code),
                                        Some(format!("decode error: {}", e)),
                                    );
                                }
                            }
                        } else {
                            record_control_plane_event(
                                "GET",
                                &cp_url,
                                Some(code),
                                Some(format!("HTTP {}", code)),
                            );
                        }
                    }
                    Err(e) => {
                        record_control_plane_event("GET", &cp_url, None, Some(format!("{}", e)));
                    }
                }
            }
        }
    }

    let control_plane_requests = CONTROL_PLANE_LOG
        .lock()
        .map(|v| v.clone())
        .unwrap_or_default();

    Ok(SyftBoxDiagnostics {
        running,
        mode,
        pids,
        config_path,
        data_dir,
        log_path,
        client_url,
        server_url,
        client_token,
        refresh_token,
        status,
        control_plane_requests,
    })
}

#[tauri::command]
pub async fn syftbox_queue_status() -> Result<SyftBoxQueueStatus, String> {
    let cfg = load_syftbox_client_config()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut sync: Option<SyftBoxSyncStatus> = None;
    let mut uploads: Option<Vec<SyftBoxUploadInfo>> = None;
    let mut status: Option<SyftBoxStatus> = None;
    let mut errors: Vec<String> = Vec::new();

    match cp_get::<SyftBoxSyncStatus>(
        &client,
        &cfg.client_url,
        "/v1/sync/status",
        &cfg.client_token,
    )
    .await
    {
        Ok(mut status) => {
            normalize_sync_status(&mut status);
            sync = Some(status);
        }
        Err(e) => {
            crate::desktop_log!("⚠️ syftbox_queue_status sync: {}", e);
            errors.push(e);
        }
    }

    match cp_get::<SyftBoxUploadList>(&client, &cfg.client_url, "/v1/uploads/", &cfg.client_token)
        .await
    {
        Ok(mut list) => {
            normalize_uploads(&mut list.uploads);
            uploads = Some(list.uploads);
        }
        Err(e) => {
            crate::desktop_log!("⚠️ syftbox_queue_status uploads: {}", e);
            errors.push(e);
        }
    }

    match cp_get::<SyftBoxStatus>(&client, &cfg.client_url, "/v1/status", &cfg.client_token).await {
        Ok(s) => {
            status = Some(s);
        }
        Err(e) => {
            crate::desktop_log!("⚠️ syftbox_queue_status status: {}", e);
            errors.push(e);
        }
    }

    let sync_count = sync.as_ref().map(|s| s.files.len()).unwrap_or(0);
    let upload_count = uploads.as_ref().map(|u| u.len()).unwrap_or(0);
    let err_msg = if errors.is_empty() {
        "none".to_string()
    } else {
        errors.join("; ")
    };
    let sample_sync: Vec<String> = sync
        .as_ref()
        .map(|s| {
            s.files
                .iter()
                .take(2)
                .map(|f| format!("{} [{}% {}]", f.path, f.progress, f.state))
                .collect()
        })
        .unwrap_or_default();
    let sample_uploads: Vec<String> = uploads
        .as_ref()
        .map(|u| {
            u.iter()
                .take(2)
                .map(|f| format!("{} [{}% {}]", f.key, f.progress, f.state))
                .collect()
        })
        .unwrap_or_default();
    crate::desktop_log!(
        "📡 SyftBox queue poll → sync: {} upload: {} errors: {} | sample sync: [{}] uploads: [{}]",
        sync_count,
        upload_count,
        err_msg,
        sample_sync.join(" | "),
        sample_uploads.join(" | ")
    );

    Ok(SyftBoxQueueStatus {
        control_plane_url: Some(cfg.client_url),
        data_dir: cfg.data_dir,
        sync,
        uploads,
        status,
        error: if errors.is_empty() {
            None
        } else {
            Some(errors.join("; "))
        },
    })
}

#[tauri::command]
pub async fn syftbox_upload_action(id: String, action: String) -> Result<(), String> {
    let cfg = load_syftbox_client_config()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let (path, method) = match action.as_str() {
        "pause" => (format!("/v1/uploads/{}/pause", id), "POST"),
        "resume" => (format!("/v1/uploads/{}/resume", id), "POST"),
        "restart" => (format!("/v1/uploads/{}/restart", id), "POST"),
        "cancel" => (format!("/v1/uploads/{}", id), "DELETE"),
        _ => return Err("Unsupported upload action".to_string()),
    };

    let url = format!(
        "{}/{}",
        cfg.client_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    );

    let request = match action.as_str() {
        "cancel" => client.delete(&url),
        _ => client.post(&url),
    }
    .bearer_auth(&cfg.client_token);

    let resp = request
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    if resp.status().is_success() {
        record_control_plane_event(method, &url, Some(resp.status().as_u16()), None);
        Ok(())
    } else {
        let err = format!("Upload action failed: HTTP {}", resp.status());
        record_control_plane_event(
            method,
            &url,
            Some(resp.status().as_u16()),
            Some(err.clone()),
        );
        Err(err)
    }
}

#[tauri::command]
pub fn open_path_in_file_manager(app_handle: AppHandle, path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }
    app_handle
        .opener()
        .reveal_item_in_dir(p)
        .map_err(|e| format!("Failed to open path: {}", e))
}
fn load_existing_client_token(config_path: &Path) -> Option<String> {
    if !config_path.exists() {
        return None;
    }
    if let Ok(raw) = fs::read_to_string(config_path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(tok) = val
                .get("client_token")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
            {
                return Some(tok);
            }
        }
    }
    None
}
