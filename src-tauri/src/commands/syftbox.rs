use crate::types::{SyftBoxConfigInfo, SyftBoxState};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::net::{TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use syftbox_sdk::syftbox::control as syftctl;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

static SYFTBOX_RUNNING: AtomicBool = AtomicBool::new(false);
static SUBSCRIPTION_DISCOVERY_UNAVAILABLE: AtomicBool = AtomicBool::new(false);
static LAST_SUBSCRIPTION_404_LOG: AtomicU64 = AtomicU64::new(0);
static LAST_QUEUE_POLL_LOG: AtomicU64 = AtomicU64::new(0);
static LAST_CONTROL_PLANE_OK_LOG: AtomicU64 = AtomicU64::new(0);
static LAST_KNOWN_WS_CONNECTED: AtomicBool = AtomicBool::new(false);
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
    let email = creds
        .email
        .clone()
        .filter(|e| !e.trim().is_empty())
        .unwrap_or_else(|| cfg.email.clone());
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
    let client_url =
        resolve_or_assign_client_url(&creds, &runtime.config_path, Some(&runtime.data_dir))?;

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
    data_dir: Option<&Path>,
) -> Result<String, String> {
    let embedded = crate::syftbox_backend_is_embedded();

    // 1) Start from explicit env override
    let mut candidate = env::var("SYFTBOX_CLIENT_URL")
        .ok()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());

    // 2) Fallback to explicit value in creds
    if candidate.is_none() {
        candidate = creds
            .client_url
            .as_ref()
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty());
    }

    // Also get token from creds
    let mut token = creds
        .access_token
        .as_ref()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());

    // 3) Fallback to existing syftbox config.json
    if config_path.exists() {
        if let Ok(existing) = fs::read_to_string(config_path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&existing) {
                if candidate.is_none() {
                    candidate = val
                        .get("client_url")
                        .and_then(|u| u.as_str())
                        .map(|u| u.trim().to_string())
                        .filter(|u| !u.is_empty());
                }
                if token.is_none() {
                    token = val
                        .get("client_token")
                        .and_then(|t| t.as_str())
                        .map(|t| t.trim().to_string())
                        .filter(|t| !t.is_empty());
                }
            }
        }
    }

    // 4) Fallback to default (embedded uses an ephemeral port by default)
    let candidate = if let Some(url) = candidate {
        url
    } else if embedded {
        allocate_ephemeral_client_url()
            .ok_or_else(|| "Failed to assign a control-plane port for SyftBox".to_string())?
    } else {
        "http://127.0.0.1:7938".to_string()
    };

    // Try to bind chosen address; if busy, pick random free port.
    // Pass token to verify we can access an existing daemon.
    // Pass config_path and data_dir to identify and kill orphaned daemons.
    if let Some(bound) =
        try_bind_or_ephemeral(&candidate, token.as_deref(), Some(config_path), data_dir)
    {
        if bound != candidate {
            crate::desktop_log!("🔧 Requested SyftBox port busy, assigned {}", bound);
        }
        return Ok(bound);
    }

    Err("Failed to assign a control-plane port for SyftBox".to_string())
}

fn allocate_ephemeral_client_url() -> Option<String> {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| format!("http://127.0.0.1:{}", addr.port()))
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
pub struct SyftBoxDiscoveryFile {
    pub path: String,
    #[serde(default)]
    pub etag: Option<String>,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub last_modified: Option<DateTime<Utc>>,
    #[serde(default)]
    pub action: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyftBoxDiscoveryResponse {
    #[serde(default)]
    files: Vec<SyftBoxDiscoveryFile>,
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
    pub latency: Option<SyftBoxLatencyStats>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct SyftBoxLatencyStats {
    #[serde(default, rename = "serverUrl")]
    pub server_url: Option<String>,
    #[serde(default)]
    pub samples: Vec<u64>,
    #[serde(default, rename = "avgMs")]
    pub avg_ms: u64,
    #[serde(default, rename = "minMs")]
    pub min_ms: u64,
    #[serde(default, rename = "maxMs")]
    pub max_ms: u64,
    #[serde(default, rename = "lastPingMs")]
    pub last_ping_ms: u64,
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
    pub backend: String,
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

#[derive(Debug, Clone, Serialize)]
pub struct TurnProbeResult {
    pub ok: bool,
    pub turn_url: String,
    pub host: String,
    pub port: u16,
    pub resolved_addrs: Vec<String>,
    pub tcp_reachable: bool,
    pub udp_send_ok: bool,
    pub udp_response_ok: bool,
    pub stun_binding_ok: bool,
    pub reflexive_addr: Option<String>,
    pub rtt_ms: Option<u128>,
    pub details: String,
    pub attempt_logs: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerLinkTestOptions {
    pub peer_email: String,
    pub rounds: Option<u32>,
    pub payload_kb: Option<u32>,
    pub timeout_s: Option<u64>,
    pub poll_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PeerLinkTestResult {
    pub ok: bool,
    pub local_email: String,
    pub peer_email: String,
    pub run_id: String,
    pub rounds: u32,
    pub completed_rounds: u32,
    pub failed_rounds: u32,
    pub payload_bytes: usize,
    pub min_rtt_ms: Option<u128>,
    pub p50_rtt_ms: Option<u128>,
    pub p95_rtt_ms: Option<u128>,
    pub max_rtt_ms: Option<u128>,
    pub avg_rtt_ms: Option<f64>,
    pub details: String,
    pub attempt_logs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
struct PeerLinkFrame {
    kind: String,
    request_id: String,
    run_id: String,
    from: String,
    to: String,
    seq: u32,
    sent_ms: u128,
    payload_len: usize,
}

fn set_default_env_var_if_unset(key: &str, value: &str) {
    if std::env::var_os(key).is_none() {
        std::env::set_var(key, value);
    }
}

fn apply_syftbox_fast_mode_defaults() {
    // Keep this fallback-capable (no strict/p2p-only) for normal desktop usage.
    set_default_env_var_if_unset("SYFTBOX_HOTLINK", "1");
    set_default_env_var_if_unset("SYFTBOX_HOTLINK_SOCKET_ONLY", "1");
    set_default_env_var_if_unset("SYFTBOX_HOTLINK_TCP_PROXY", "1");
    set_default_env_var_if_unset("SYFTBOX_HOTLINK_QUIC", "1");

    // Explicitly pin known-good fast tuning defaults.
    set_default_env_var_if_unset("SYFTBOX_HOTLINK_TCP_PROXY_CHUNK_SIZE", "61440");
    set_default_env_var_if_unset("SYFTBOX_HOTLINK_WEBRTC_BUFFERED_HIGH", "1048576");
    set_default_env_var_if_unset("SYFTBOX_HOTLINK_WEBRTC_BACKPRESSURE_WAIT_MS", "1500");

    // Keep packet-level hotlink logs off by default to avoid overwhelming
    // desktop log windows. Set SYFTBOX_HOTLINK_DEBUG=1 when deep transport
    // debugging is needed.
    set_default_env_var_if_unset("SYFTBOX_HOTLINK_DEBUG", "0");
}

fn resolve_turn_target(server_url: &str) -> Result<(String, u16, String), String> {
    let trimmed = server_url.trim();
    if trimmed.is_empty() {
        return Err("Server URL is empty".to_string());
    }

    if let Ok(ice_servers) = std::env::var("SYFTBOX_HOTLINK_ICE_SERVERS") {
        if !ice_servers.trim().is_empty() {
            if let Some(raw_turn) = ice_servers
                .split(',')
                .map(|v| v.trim())
                .find(|v| v.starts_with("turn:") || v.starts_with("turns:"))
            {
                let no_proto = raw_turn
                    .trim_start_matches("turn:")
                    .trim_start_matches("turns:");
                let host_port = no_proto.split('?').next().unwrap_or(no_proto);
                if let Some((host, port_str)) = host_port.rsplit_once(':') {
                    if let Ok(port) = port_str.parse::<u16>() {
                        return Ok((host.to_string(), port, raw_turn.to_string()));
                    }
                }
                return Ok((host_port.to_string(), 3478, raw_turn.to_string()));
            }
        }
    }

    let parsed = reqwest::Url::parse(trimmed).map_err(|e| format!("Invalid server URL: {e}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "Server URL has no host".to_string())?
        .to_string();
    let turn_url = format!("turn:{host}:3478?transport=udp");
    Ok((host, 3478, turn_url))
}

#[tauri::command]
pub fn test_turn_connection(server_url: Option<String>) -> Result<TurnProbeResult, String> {
    let resolved_server_url = if let Some(v) = server_url {
        v
    } else {
        let cfg = biovault::config::Config::load().map_err(|e| e.to_string())?;
        cfg.syftbox_credentials
            .as_ref()
            .and_then(|c| c.server_url.clone())
            .unwrap_or_else(|| "https://syftbox.net".to_string())
    };

    let (host, port, turn_url) = resolve_turn_target(&resolved_server_url)?;
    let socket_addrs: Vec<_> = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("Failed to resolve {host}:{port}: {e}"))?
        .collect();
    let mut attempt_logs: Vec<String> = Vec::new();
    attempt_logs.push(format!("server_url={}", resolved_server_url.trim()));
    attempt_logs.push(format!("resolved_turn_url={turn_url}"));
    if let Ok(ice_servers) = std::env::var("SYFTBOX_HOTLINK_ICE_SERVERS") {
        if !ice_servers.trim().is_empty() {
            attempt_logs.push(format!("env_ice_servers={ice_servers}"));
        }
    }
    let turn_user_set = std::env::var("SYFTBOX_HOTLINK_TURN_USER")
        .ok()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let turn_pass_set = std::env::var("SYFTBOX_HOTLINK_TURN_PASS")
        .ok()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    attempt_logs.push(format!(
        "env_turn_user_set={turn_user_set} env_turn_pass_set={turn_pass_set}"
    ));

    if socket_addrs.is_empty() {
        return Err(format!("No addresses resolved for {host}:{port}"));
    }

    let resolved_addrs: Vec<String> = socket_addrs.iter().map(|a| a.to_string()).collect();
    attempt_logs.push(format!("resolved_addrs={}", resolved_addrs.join(",")));

    let timeout = Duration::from_secs(2);
    let mut tcp_reachable = false;
    for addr in &socket_addrs {
        match TcpStream::connect_timeout(addr, timeout) {
            Ok(_) => {
                tcp_reachable = true;
                attempt_logs.push(format!("tcp_connect {addr} -> ok"));
                break;
            }
            Err(e) => {
                attempt_logs.push(format!("tcp_connect {addr} -> fail ({e})"));
            }
        }
    }

    let mut udp_send_ok = false;
    let mut udp_response_ok = false;
    let mut stun_binding_ok = false;
    let mut reflexive_addr: Option<String> = None;
    let mut rtt_ms: Option<u128> = None;
    let mut stun_failure: Option<String> = None;

    for addr in &socket_addrs {
        let req = build_stun_binding_request();
        let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else {
            stun_failure = Some("Failed to bind local UDP socket".to_string());
            attempt_logs.push("udp_bind 0.0.0.0:0 -> fail".to_string());
            break;
        };
        attempt_logs.push(format!("udp_bind 0.0.0.0:0 -> ok; probing {addr}"));
        let _ = sock.set_write_timeout(Some(timeout));
        let _ = sock.set_read_timeout(Some(timeout));
        if let Err(e) = sock.connect(addr) {
            attempt_logs.push(format!("udp_connect {addr} -> fail ({e})"));
            continue;
        }
        attempt_logs.push(format!("udp_connect {addr} -> ok"));
        let start = Instant::now();
        if let Err(e) = sock.send(&req) {
            attempt_logs.push(format!("udp_send_binding_request {addr} -> fail ({e})"));
            continue;
        }
        udp_send_ok = true;
        attempt_logs.push(format!("udp_send_binding_request {addr} -> ok"));
        let mut buf = [0u8; 1500];
        match sock.recv(&mut buf) {
            Ok(n) => {
                udp_response_ok = true;
                attempt_logs.push(format!("udp_recv {addr} -> ok bytes={n}"));
                match parse_stun_binding_response(&buf[..n], &req[8..20]) {
                    Ok(mapped) => {
                        stun_binding_ok = true;
                        reflexive_addr = mapped;
                        rtt_ms = Some(start.elapsed().as_millis());
                        attempt_logs.push(format!(
                            "stun_binding {addr} -> ok mapped={}",
                            reflexive_addr
                                .clone()
                                .unwrap_or_else(|| "<not-provided>".to_string())
                        ));
                        break;
                    }
                    Err(e) => {
                        attempt_logs.push(format!("stun_binding {addr} -> fail ({e})"));
                        stun_failure = Some(e);
                    }
                }
            }
            Err(e) => {
                attempt_logs.push(format!("udp_recv {addr} -> fail ({e})"));
            }
        }
    }

    let ok = stun_binding_ok;
    let details = if ok {
        match (&reflexive_addr, rtt_ms) {
            (Some(addr), Some(ms)) => format!(
                "TURN probe passed for {} (stun_binding=true, reflexive_addr={}, rtt_ms={})",
                turn_url, addr, ms
            ),
            _ => format!("TURN probe passed for {} (stun_binding=true)", turn_url),
        }
    } else if tcp_reachable || udp_send_ok {
        format!(
            "TURN port reachable but STUN binding failed for {} (tcp={}, udp_send={}, udp_response={}, reason={})",
            turn_url,
            tcp_reachable,
            udp_send_ok,
            udp_response_ok,
            stun_failure.unwrap_or_else(|| "no_stun_response".to_string())
        )
    } else {
        format!(
            "TURN probe failed for {} (tcp={}, udp_send={})",
            turn_url, tcp_reachable, udp_send_ok
        )
    };
    attempt_logs.push(format!("final_ok={ok}"));
    attempt_logs.push(format!(
        "final_status tcp_reachable={} udp_send_ok={} udp_response_ok={} stun_binding_ok={} reflexive_addr={} rtt_ms={}",
        tcp_reachable,
        udp_send_ok,
        udp_response_ok,
        stun_binding_ok,
        reflexive_addr.clone().unwrap_or_else(|| "<none>".to_string()),
        rtt_ms
            .map(|v| v.to_string())
            .unwrap_or_else(|| "<none>".to_string())
    ));
    for line in &attempt_logs {
        crate::desktop_log!("[TURN probe] {}", line);
    }

    Ok(TurnProbeResult {
        ok,
        turn_url,
        host,
        port,
        resolved_addrs,
        tcp_reachable,
        udp_send_ok,
        udp_response_ok,
        stun_binding_ok,
        reflexive_addr,
        rtt_ms,
        details,
        attempt_logs,
    })
}

fn current_syftbox_email() -> Result<String, String> {
    let cfg = biovault::config::Config::load().map_err(|e| e.to_string())?;
    let email = cfg
        .syftbox_credentials
        .as_ref()
        .and_then(|c| c.email.as_ref())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            let v = cfg.email.trim().to_string();
            if v.is_empty() {
                None
            } else {
                Some(v)
            }
        })
        .ok_or_else(|| "Cannot run peer link test: no SyftBox email set in config.".to_string())?;
    Ok(email)
}

fn peer_link_rpc_dir(datasites_root: &Path, email: &str) -> std::path::PathBuf {
    datasites_root
        .join(email)
        .join("app_data")
        .join("biovault")
        .join("rpc")
        .join("peer_link")
}

fn write_json_file(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }
    fs::write(
        path,
        serde_json::to_string_pretty(value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    Ok(())
}

fn process_peer_link_requests(
    local_email: &str,
    local_rpc_dir: &Path,
    datasites_root: &Path,
    attempt_logs: &mut Vec<String>,
) {
    let entries = match fs::read_dir(local_rpc_dir) {
        Ok(v) => v,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let is_request = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("request"))
            .unwrap_or(false);
        if !is_request {
            continue;
        }

        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(frame) = serde_json::from_str::<PeerLinkFrame>(&raw) else {
            continue;
        };
        if frame.kind != "request" {
            continue;
        }
        if frame.to != local_email {
            continue;
        }

        let responder_dir = peer_link_rpc_dir(datasites_root, local_email);
        let response_path = responder_dir.join(format!("{}.response", frame.request_id));
        if response_path.exists() {
            continue;
        }

        let response = PeerLinkFrame {
            kind: "response".to_string(),
            request_id: frame.request_id.clone(),
            run_id: frame.run_id.clone(),
            from: local_email.to_string(),
            to: frame.from.clone(),
            seq: frame.seq,
            sent_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            payload_len: frame.payload_len,
        };
        let value = serde_json::to_value(&response).unwrap_or_else(|_| json!({}));
        match write_json_file(&response_path, &value) {
            Ok(()) => attempt_logs.push(format!(
                "auto_responded request_id={} from={} to={} seq={} path={}",
                frame.request_id,
                frame.from,
                local_email,
                frame.seq,
                response_path.display()
            )),
            Err(err) => attempt_logs.push(format!(
                "auto_response_failed request_id={} err={}",
                frame.request_id, err
            )),
        }
    }
}

#[tauri::command]
pub fn test_peer_link(options: PeerLinkTestOptions) -> Result<PeerLinkTestResult, String> {
    let local_email = current_syftbox_email()?;
    let peer_email = options.peer_email.trim().to_string();
    if peer_email.is_empty() {
        return Err("Peer email is required.".to_string());
    }
    if peer_email == local_email {
        return Err("Peer email must be different from your current email.".to_string());
    }

    let rounds = options.rounds.unwrap_or(3).clamp(1, 100);
    let payload_kb = options.payload_kb.unwrap_or(32).clamp(1, 1024);
    let payload_bytes = (payload_kb as usize) * 1024;
    let timeout_s = options.timeout_s.unwrap_or(60).clamp(3, 600);
    let poll_ms = options.poll_ms.unwrap_or(100).clamp(20, 1000);
    let poll_sleep = Duration::from_millis(poll_ms);

    let biovault_home = crate::resolve_biovault_home_path();
    let datasites_root = biovault_home.join("datasites");
    if !datasites_root.exists() {
        return Err(format!(
            "Datasites root not found: {}",
            datasites_root.display()
        ));
    }

    let local_rpc_dir = peer_link_rpc_dir(&datasites_root, &local_email);
    let peer_rpc_dir = peer_link_rpc_dir(&datasites_root, &peer_email);
    fs::create_dir_all(&local_rpc_dir)
        .map_err(|e| format!("Failed to create {}: {}", local_rpc_dir.display(), e))?;
    fs::create_dir_all(&peer_rpc_dir)
        .map_err(|e| format!("Failed to create {}: {}", peer_rpc_dir.display(), e))?;

    let run_id = format!("peerlink-{}", uuid::Uuid::new_v4());
    let mut attempt_logs = vec![
        format!("local_email={}", local_email),
        format!("peer_email={}", peer_email),
        format!("datasites_root={}", datasites_root.display()),
        format!("local_rpc_dir={}", local_rpc_dir.display()),
        format!("peer_rpc_dir={}", peer_rpc_dir.display()),
        format!("run_id={}", run_id),
        format!("rounds={}", rounds),
        format!("payload_bytes={}", payload_bytes),
        format!("timeout_s={}", timeout_s),
        format!("poll_ms={}", poll_ms),
        "note=Run the same test from the peer app at the same time for ping-pong.".to_string(),
    ];

    let payload = "x".repeat(payload_bytes);
    let mut rtts: Vec<u128> = Vec::new();
    let mut failed_rounds: u32 = 0;

    for seq in 1..=rounds {
        process_peer_link_requests(
            &local_email,
            &local_rpc_dir,
            &datasites_root,
            &mut attempt_logs,
        );

        let request_id = format!(
            "{}-{}-to-{}-r{}",
            run_id,
            local_email.replace('@', "_"),
            peer_email.replace('@', "_"),
            seq
        );
        let request_file = peer_rpc_dir.join(format!("{}.request", request_id));
        let response_file = local_rpc_dir.join(format!("{}.response", request_id));
        let sent_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        let request_frame = PeerLinkFrame {
            kind: "request".to_string(),
            request_id: request_id.clone(),
            run_id: run_id.clone(),
            from: local_email.clone(),
            to: peer_email.clone(),
            seq,
            sent_ms,
            payload_len: payload_bytes,
        };
        let request_json = json!({
            "frame": request_frame,
            "payload": payload,
        });
        write_json_file(&request_file, &request_json)?;
        attempt_logs.push(format!(
            "round={} request_written path={}",
            seq,
            request_file.display()
        ));

        let started = Instant::now();
        let mut round_ok = false;
        loop {
            process_peer_link_requests(
                &local_email,
                &local_rpc_dir,
                &datasites_root,
                &mut attempt_logs,
            );

            if response_file.exists() {
                let elapsed_ms = started.elapsed().as_millis();
                rtts.push(elapsed_ms);
                attempt_logs.push(format!(
                    "round={} response_received path={} rtt_ms={}",
                    seq,
                    response_file.display(),
                    elapsed_ms
                ));
                round_ok = true;
                break;
            }

            if started.elapsed() >= Duration::from_secs(timeout_s) {
                attempt_logs.push(format!(
                    "round={} timeout waiting_for={} after={}s",
                    seq,
                    response_file.display(),
                    timeout_s
                ));
                failed_rounds += 1;
                break;
            }
            std::thread::sleep(poll_sleep);
        }

        if !round_ok {
            break;
        }
    }

    let completed_rounds = rtts.len() as u32;
    let ok = failed_rounds == 0 && completed_rounds == rounds;
    let mut sorted = rtts.clone();
    sorted.sort_unstable();
    let min_rtt_ms = sorted.first().copied();
    let max_rtt_ms = sorted.last().copied();
    let p50_rtt_ms = if sorted.is_empty() {
        None
    } else {
        Some(sorted[((sorted.len() - 1) as f64 * 0.50).round() as usize])
    };
    let p95_rtt_ms = if sorted.is_empty() {
        None
    } else {
        Some(sorted[((sorted.len() - 1) as f64 * 0.95).round() as usize])
    };
    let avg_rtt_ms = if sorted.is_empty() {
        None
    } else {
        Some(sorted.iter().sum::<u128>() as f64 / sorted.len() as f64)
    };

    let details = if ok {
        format!(
            "Peer link test passed ({} rounds). RTT p50={}ms p95={}ms.",
            completed_rounds,
            p50_rtt_ms.unwrap_or(0),
            p95_rtt_ms.unwrap_or(0)
        )
    } else {
        format!(
            "Peer link test incomplete. completed={} failed={} rounds={}.\n\
Make sure peer '{}' runs Peer Link Test against '{}' at the same time.",
            completed_rounds, failed_rounds, rounds, peer_email, local_email
        )
    };

    Ok(PeerLinkTestResult {
        ok,
        local_email,
        peer_email,
        run_id,
        rounds,
        completed_rounds,
        failed_rounds,
        payload_bytes,
        min_rtt_ms,
        p50_rtt_ms,
        p95_rtt_ms,
        max_rtt_ms,
        avg_rtt_ms,
        details,
        attempt_logs,
    })
}

fn build_stun_binding_request() -> [u8; 20] {
    // STUN header: type(2)=0x0001 binding request, length(2)=0,
    // magic cookie(4)=0x2112A442, transaction id(12)=random bytes.
    let mut out = [0u8; 20];
    out[0] = 0x00;
    out[1] = 0x01;
    out[2] = 0x00;
    out[3] = 0x00;
    out[4] = 0x21;
    out[5] = 0x12;
    out[6] = 0xA4;
    out[7] = 0x42;
    let id = uuid::Uuid::new_v4();
    out[8..20].copy_from_slice(&id.as_bytes()[..12]);
    out
}

fn parse_stun_binding_response(payload: &[u8], tx_id: &[u8]) -> Result<Option<String>, String> {
    const STUN_COOKIE: [u8; 4] = [0x21, 0x12, 0xA4, 0x42];
    if payload.len() < 20 {
        return Err("response_too_short".to_string());
    }

    let msg_type = u16::from_be_bytes([payload[0], payload[1]]);
    let msg_len = u16::from_be_bytes([payload[2], payload[3]]) as usize;
    if payload[4..8] != STUN_COOKIE {
        return Err("missing_stun_cookie".to_string());
    }
    if &payload[8..20] != tx_id {
        return Err("transaction_id_mismatch".to_string());
    }
    if payload.len() < 20 + msg_len {
        return Err("truncated_stun_payload".to_string());
    }

    if msg_type == 0x0111 {
        let reason = parse_stun_error_reason(&payload[..20 + msg_len])
            .unwrap_or_else(|| "error_response".to_string());
        return Err(format!("stun_error:{reason}"));
    }
    if msg_type != 0x0101 {
        return Err(format!("unexpected_stun_type:0x{msg_type:04x}"));
    }

    Ok(parse_xor_mapped_address(&payload[..20 + msg_len]))
}

fn parse_stun_error_reason(payload: &[u8]) -> Option<String> {
    let mut idx = 20usize;
    while idx + 4 <= payload.len() {
        let attr_type = u16::from_be_bytes([payload[idx], payload[idx + 1]]);
        let attr_len = u16::from_be_bytes([payload[idx + 2], payload[idx + 3]]) as usize;
        idx += 4;
        if idx + attr_len > payload.len() {
            return None;
        }
        let value = &payload[idx..idx + attr_len];
        if attr_type == 0x0009 && attr_len >= 4 {
            let class = (value[2] & 0x07) as u16;
            let number = value[3] as u16;
            let code = class * 100 + number;
            let reason = if attr_len > 4 {
                String::from_utf8_lossy(&value[4..]).to_string()
            } else {
                "".to_string()
            };
            if reason.trim().is_empty() {
                return Some(code.to_string());
            }
            return Some(format!("{code}:{reason}"));
        }
        idx += attr_len;
        let rem = idx % 4;
        if rem != 0 {
            idx += 4 - rem;
        }
    }
    None
}

fn parse_xor_mapped_address(payload: &[u8]) -> Option<String> {
    const STUN_COOKIE_U16: u16 = 0x2112;
    const STUN_COOKIE: [u8; 4] = [0x21, 0x12, 0xA4, 0x42];

    let mut idx = 20usize;
    while idx + 4 <= payload.len() {
        let attr_type = u16::from_be_bytes([payload[idx], payload[idx + 1]]);
        let attr_len = u16::from_be_bytes([payload[idx + 2], payload[idx + 3]]) as usize;
        idx += 4;
        if idx + attr_len > payload.len() {
            return None;
        }
        let value = &payload[idx..idx + attr_len];
        if attr_type == 0x0020 && attr_len >= 8 {
            let family = value[1];
            let x_port = u16::from_be_bytes([value[2], value[3]]);
            let port = x_port ^ STUN_COOKIE_U16;
            if family == 0x01 && attr_len >= 8 {
                let a = value[4] ^ STUN_COOKIE[0];
                let b = value[5] ^ STUN_COOKIE[1];
                let c = value[6] ^ STUN_COOKIE[2];
                let d = value[7] ^ STUN_COOKIE[3];
                return Some(format!("{a}.{b}.{c}.{d}:{port}"));
            }
        }
        idx += attr_len;
        let rem = idx % 4;
        if rem != 0 {
            idx += 4 - rem;
        }
    }
    None
}

fn normalize_percent(value: f64) -> f64 {
    if value <= 1.0 {
        (value * 100.0).min(100.0)
    } else {
        value
    }
}

fn syftbox_backend_label() -> String {
    if crate::syftbox_backend_is_embedded() {
        "Embedded (syftbox-rs)".to_string()
    } else {
        "Process (syftbox binary)".to_string()
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

fn should_log_queue_poll(is_connected: bool) -> bool {
    let interval_secs = if is_connected { 60 } else { 10 };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let last = LAST_QUEUE_POLL_LOG.load(Ordering::Relaxed);
    if now.saturating_sub(last) >= interval_secs {
        LAST_QUEUE_POLL_LOG.store(now, Ordering::Relaxed);
        true
    } else {
        false
    }
}

fn should_log_control_plane_ok() -> bool {
    let is_connected = LAST_KNOWN_WS_CONNECTED.load(Ordering::Relaxed);
    let interval_secs = if is_connected { 60 } else { 10 };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let last = LAST_CONTROL_PLANE_OK_LOG.load(Ordering::Relaxed);
    if now.saturating_sub(last) >= interval_secs {
        LAST_CONTROL_PLANE_OK_LOG.store(now, Ordering::Relaxed);
        true
    } else {
        false
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
            if !should_log_control_plane_ok() {
                return;
            }
            let s = status
                .map(|c| c.to_string())
                .unwrap_or_else(|| "unknown".into());
            crate::desktop_log!("🛰️ {} {} -> {}", method, url, s);
        }
    }
}

fn try_bind_or_ephemeral(
    url: &str,
    token: Option<&str>,
    config_path: Option<&Path>,
    data_dir: Option<&Path>,
) -> Option<String> {
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

    let base_url = format!("http://{}", host_port);

    // Check if something is listening and if we can authenticate to it
    match check_control_plane_access(&base_url, token) {
        ControlPlaneStatus::Free => {
            // Nothing listening, try to bind
            if TcpListener::bind(&host_port).is_ok() {
                return Some(base_url);
            }
        }
        ControlPlaneStatus::OurDaemon => {
            // Our daemon is already running on this port, reuse it
            crate::desktop_log!("🔧 Port {} has our daemon running, reusing", host_port);
            return Some(base_url);
        }
        ControlPlaneStatus::DifferentDaemon => {
            // Check if this is an orphaned daemon from our BioVault home
            if let Some(pids) = find_our_syftbox_pids(config_path, data_dir) {
                if !pids.is_empty() {
                    crate::desktop_log!(
                        "🔧 Found orphaned daemon(s) for our config: {:?}, killing",
                        pids
                    );
                    for pid in &pids {
                        terminate_pid_best_effort(*pid);
                    }
                    // Wait a bit for processes to die
                    std::thread::sleep(std::time::Duration::from_millis(500));

                    // Retry - port should be free now
                    if TcpListener::bind(&host_port).is_ok() {
                        crate::desktop_log!("🔧 Port {} now free after killing orphan", host_port);
                        return Some(base_url);
                    }
                }
            }
            // Different daemon or couldn't kill, need ephemeral port
            crate::desktop_log!(
                "🔧 Port {} is used by different daemon, selecting ephemeral",
                host_port
            );
        }
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

fn terminate_pid_best_effort(pid: u32) {
    if pid == 0 {
        return;
    }

    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        super::hide_console_window(&mut cmd);
        let _ = cmd.status();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new("kill");
        cmd.arg("-TERM").arg(pid.to_string());
        super::hide_console_window(&mut cmd);
        let _ = cmd.status();
    }
}

/// Forcefully kill all syftbox processes associated with this biovault home.
/// This ensures we have exactly one syftbox process per home.
fn kill_all_syftbox_for_home(config_path: Option<&Path>, data_dir: Option<&Path>) {
    if let Some(pids) = find_our_syftbox_pids(config_path, data_dir) {
        if !pids.is_empty() {
            crate::desktop_log!(
                "🔧 Killing {} existing syftbox process(es) for this home: {:?}",
                pids.len(),
                pids
            );
            for pid in &pids {
                terminate_pid_best_effort(*pid);
            }
            // Wait for processes to die
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }
}

#[cfg(target_os = "windows")]
fn find_our_syftbox_pids(config_path: Option<&Path>, data_dir: Option<&Path>) -> Option<Vec<u32>> {
    let config_str = config_path.map(|p| p.to_string_lossy().to_string());
    let data_dir_str = data_dir.map(|p| p.to_string_lossy().to_string());

    if config_str.is_none() && data_dir_str.is_none() {
        return None;
    }

    let ps_script = r#"Get-CimInstance Win32_Process -Filter "Name='syftbox.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }"#;
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", ps_script]);
    super::hide_console_window(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut pids = Vec::new();
    for line in stdout.lines() {
        let mut parts = line.splitn(2, '|');
        let pid_str = parts.next().unwrap_or("").trim();
        let cmdline = parts.next().unwrap_or("").trim();
        if pid_str.is_empty() {
            continue;
        }

        let matches = config_str
            .as_ref()
            .map(|s| !cmdline.is_empty() && cmdline.contains(s.as_str()))
            .unwrap_or(false)
            || data_dir_str
                .as_ref()
                .map(|s| !cmdline.is_empty() && cmdline.contains(s.as_str()))
                .unwrap_or(false);

        if !matches {
            continue;
        }

        if let Ok(pid) = pid_str.parse::<u32>() {
            pids.push(pid);
        }
    }

    Some(pids)
}

#[cfg(not(target_os = "windows"))]
fn find_our_syftbox_pids(config_path: Option<&Path>, data_dir: Option<&Path>) -> Option<Vec<u32>> {
    let mut cmd = Command::new("ps");
    cmd.arg("aux");
    super::hide_console_window(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }

    let ps_output = String::from_utf8_lossy(&output.stdout);
    let config_str = config_path.map(|p| p.to_string_lossy().to_string());
    let data_dir_str = data_dir.map(|p| p.to_string_lossy().to_string());

    // Need at least one identifier to match
    if config_str.is_none() && data_dir_str.is_none() {
        return None;
    }

    let mut pids = Vec::new();
    for line in ps_output.lines() {
        if !line.contains("syftbox") {
            continue;
        }
        // Skip grep/ps itself
        if line.contains("grep") || line.contains("ps aux") {
            continue;
        }

        let matches = config_str
            .as_ref()
            .map(|s| line.contains(s.as_str()))
            .unwrap_or(false)
            || data_dir_str
                .as_ref()
                .map(|s| line.contains(s.as_str()))
                .unwrap_or(false);

        if matches {
            // Parse PID from ps aux output (second column)
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() > 1 {
                if let Ok(pid) = parts[1].parse::<u32>() {
                    pids.push(pid);
                }
            }
        }
    }

    Some(pids)
}

#[derive(Debug)]
enum ControlPlaneStatus {
    Free,            // Nothing listening on port
    OurDaemon,       // Our daemon with matching token
    DifferentDaemon, // Different daemon or auth failed
}

fn check_control_plane_access(base_url: &str, token: Option<&str>) -> ControlPlaneStatus {
    use std::time::Duration;

    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
    {
        Ok(c) => c,
        Err(_) => return ControlPlaneStatus::Free,
    };

    let status_url = format!("{}/v1/status", base_url.trim_end_matches('/'));

    // First check if anything is listening (without auth)
    let request = client.get(&status_url);
    let request = if let Some(t) = token {
        request.bearer_auth(t)
    } else {
        request
    };

    match request.send() {
        Ok(resp) => {
            let status_code = resp.status().as_u16();
            if status_code == 200 {
                // Successfully authenticated - this is our daemon (or compatible)
                ControlPlaneStatus::OurDaemon
            } else if status_code == 401 || status_code == 403 {
                // Auth failed - different daemon with different token
                ControlPlaneStatus::DifferentDaemon
            } else {
                // Other response (maybe no auth required?) - treat as different daemon
                ControlPlaneStatus::DifferentDaemon
            }
        }
        Err(e) => {
            // Connection failed - port is likely free
            if e.is_connect() {
                ControlPlaneStatus::Free
            } else {
                // Timeout or other error - assume something is there
                ControlPlaneStatus::DifferentDaemon
            }
        }
    }
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
    #[cfg(target_os = "windows")]
    {
        find_our_syftbox_pids(Some(&runtime.config_path), Some(&runtime.data_dir))
            .unwrap_or_default()
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut pids = Vec::new();
        let mut cmd = Command::new("ps");
        cmd.arg("aux");
        super::hide_console_window(&mut cmd);
        if let Ok(output) = cmd.output() {
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
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "start", "", &url]);
        super::hide_console_window(&mut cmd);
        cmd.spawn()
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
            let runtime_clone = runtime.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                ensure_syftbox_config(&runtime_clone)
            })
            .await
            {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => {
                    crate::desktop_log!("⚠️ Failed to write syftbox/config.json after auth: {}", e);
                }
                Err(join_err) => {
                    crate::desktop_log!(
                        "⚠️ Failed to write syftbox/config.json after auth (task join): {}",
                        join_err
                    );
                }
            }

            // Restart the local SyftBox daemon so it picks up fresh auth tokens.
            let restart_runtime = runtime.clone();
            tauri::async_runtime::spawn_blocking(move || {
                apply_syftbox_fast_mode_defaults();
                if let Err(e) = syftctl::stop_syftbox(&restart_runtime) {
                    crate::desktop_log!("ℹ️ Failed to stop SyftBox after auth: {}", e);
                }
                if let Err(e) = syftctl::start_syftbox(&restart_runtime) {
                    crate::desktop_log!("⚠️ Failed to restart SyftBox after auth: {}", e);
                }
            });
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
    let mut email: Option<String> = None;
    let mut server_url: Option<String> = None;

    if let Some(cfg) = config.as_ref() {
        match cfg.get_syftbox_data_dir() {
            Ok(dir) => data_dir = Some(dir.to_string_lossy().to_string()),
            Err(e) => data_dir_error = Some(e.to_string()),
        }
        if let Ok(runtime) = cfg.to_syftbox_runtime_config() {
            log_path = resolve_syftbox_log_path(&runtime);
        }
        if !cfg.email.trim().is_empty() {
            email = Some(cfg.email.clone());
        }
        if let Some(creds) = cfg.syftbox_credentials.as_ref() {
            if let Some(creds_email) = creds.email.as_ref() {
                if !creds_email.trim().is_empty() {
                    email = Some(creds_email.clone());
                }
            }
            if let Some(url) = creds.server_url.as_ref() {
                if !url.trim().is_empty() {
                    server_url = Some(url.clone());
                }
            }
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
    if server_url.is_none() {
        if let Ok(raw) = std::fs::read_to_string(&config_path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(url) = val.get("server_url").and_then(|v| v.as_str()) {
                    if !url.trim().is_empty() {
                        server_url = Some(url.to_string());
                    }
                }
            }
        }
    }
    if let Some(ref addr) = server_url {
        crate::desktop_log!("  Server URL: {}", addr);
    }
    if let Some(ref email_val) = email {
        crate::desktop_log!("  Email: {}", email_val);
    }

    Ok(SyftBoxConfigInfo {
        is_authenticated,
        config_path,
        has_access_token,
        has_refresh_token,
        email,
        server_url,
        data_dir,
        data_dir_error,
        log_path,
    })
}

#[tauri::command]
pub fn get_syftbox_state() -> Result<SyftBoxState, String> {
    let (running, mode, mut log_path, error, pid, client_url, tx_bytes, rx_bytes) =
        match load_runtime_config() {
            Ok(runtime) => {
                let state = syftctl::state(&runtime).map_err(|e| e.to_string())?;
                let log_path = resolve_syftbox_log_path(&runtime);

                // Get PID from process list
                let pids = find_syftbox_pids(&runtime);
                let pid = pids.first().copied();

                // Get client_url from config
                let client_url = fs::read_to_string(&runtime.config_path)
                    .ok()
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                    .and_then(|val| {
                        val.get("client_url")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    });

                // Get TX/RX bytes from status endpoint
                let (tx_bytes, rx_bytes) = get_tx_rx_bytes(&client_url);

                (
                    state.running,
                    state.mode,
                    log_path,
                    None::<String>,
                    pid,
                    client_url,
                    tx_bytes,
                    rx_bytes,
                )
            }
            Err(e) => {
                crate::desktop_log!("⚠️ No runtime config for SyftBox state: {}", e);
                (
                    false,
                    syftctl::SyftBoxMode::Direct,
                    None,
                    Some(e),
                    None,
                    None,
                    0,
                    0,
                )
            }
        };
    if log_path.is_none() {
        log_path = fallback_log_path();
    }
    SYFTBOX_RUNNING.store(running, Ordering::SeqCst);
    Ok(SyftBoxState {
        running,
        mode: format!("{:?}", mode),
        backend: syftbox_backend_label(),
        log_path,
        error,
        pid,
        client_url,
        tx_bytes,
        rx_bytes,
    })
}

fn get_tx_rx_bytes(client_url: &Option<String>) -> (u64, u64) {
    let Some(url) = client_url else {
        return (0, 0);
    };

    // Load token from config
    let token = load_syftbox_client_config()
        .ok()
        .map(|cfg| cfg.client_token);
    let Some(token) = token else {
        return (0, 0);
    };

    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
    {
        Ok(c) => c,
        Err(_) => return (0, 0),
    };

    let status_url = format!("{}/v1/status", url.trim_end_matches('/'));
    match client.get(&status_url).bearer_auth(&token).send() {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(status) = resp.json::<SyftBoxStatus>() {
                let runtime = status.runtime.unwrap_or_default();
                // Combine websocket and http bytes
                let ws = runtime.websocket.unwrap_or_default();
                let http = runtime.http.unwrap_or_default();
                let tx = ws.bytes_sent_total.unwrap_or(0) + http.bytes_sent_total.unwrap_or(0);
                let rx = ws.bytes_recv_total.unwrap_or(0) + http.bytes_recv_total.unwrap_or(0);
                return (tx, rx);
            }
        }
        _ => {}
    }
    (0, 0)
}

#[tauri::command]
pub fn start_syftbox_client() -> Result<SyftBoxState, String> {
    apply_syftbox_fast_mode_defaults();

    let runtime = load_runtime_config()?;
    ensure_syftbox_config(&runtime)?;

    // If the config file still isn't present, report a friendly auth/setup message.
    if !runtime.config_path.exists() {
        return Err(
            "SyftBox is not connected yet. Open Settings → SyftBox and sign in first.".to_string(),
        );
    }

    // Forcefully kill any existing syftbox processes for this home directory
    // This ensures exactly one syftbox process per biovault home
    kill_all_syftbox_for_home(Some(&runtime.config_path), Some(&runtime.data_dir));

    // Also try the standard stop method for good measure
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
            // Get updated state info
            let pids = find_syftbox_pids(&runtime);
            let pid = pids.first().copied();
            let client_url = fs::read_to_string(&runtime.config_path)
                .ok()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|val| {
                    val.get("client_url")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                });
            let (tx_bytes, rx_bytes) = get_tx_rx_bytes(&client_url);

            Ok(SyftBoxState {
                running: true,
                mode: if runtime.data_dir.join(".sbenv").exists() {
                    "Sbenv".to_string()
                } else {
                    "Direct".to_string()
                },
                backend: syftbox_backend_label(),
                log_path: resolve_syftbox_log_path(&runtime),
                error: None,
                pid,
                client_url,
                tx_bytes,
                rx_bytes,
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
                backend: syftbox_backend_label(),
                log_path: resolve_syftbox_log_path(&runtime),
                error: None,
                pid: None,
                client_url: None,
                tx_bytes: 0,
                rx_bytes: 0,
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
        if let Ok(raw) = fs::read_to_string(&runtime.config_path) {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                if let Some(url) = val.get("client_url").and_then(|v| v.as_str()) {
                    if !url.trim().is_empty() {
                        client_url = Some(url.to_string());
                    }
                }
                if let Some(token) = val.get("client_token").and_then(|v| v.as_str()) {
                    if !token.trim().is_empty() {
                        client_token = Some(token.to_string());
                    }
                }
                if let Some(url) = val.get("server_url").and_then(|v| v.as_str()) {
                    if !url.trim().is_empty() {
                        server_url = Some(url.to_string());
                    }
                }
                if let Some(token) = val.get("refresh_token").and_then(|v| v.as_str()) {
                    if !token.trim().is_empty() {
                        refresh_token = Some(token.to_string());
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
        backend: syftbox_backend_label(),
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
    let cfg = match load_syftbox_client_config() {
        Ok(cfg) => cfg,
        Err(err) => {
            return Ok(SyftBoxQueueStatus {
                control_plane_url: None,
                data_dir: None,
                sync: None,
                uploads: None,
                status: None,
                latency: None,
                error: Some(err),
            });
        }
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut sync: Option<SyftBoxSyncStatus> = None;
    let mut uploads: Option<Vec<SyftBoxUploadInfo>> = None;
    let mut status: Option<SyftBoxStatus> = None;
    let mut latency: Option<SyftBoxLatencyStats> = None;
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

    match cp_get::<SyftBoxLatencyStats>(
        &client,
        &cfg.client_url,
        "/v1/stats/latency",
        &cfg.client_token,
    )
    .await
    {
        Ok(s) => {
            latency = Some(s);
        }
        Err(e) => {
            crate::desktop_log!("⚠️ syftbox_queue_status latency: {}", e);
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
    let is_connected = status
        .as_ref()
        .and_then(|s| s.runtime.as_ref())
        .and_then(|r| r.websocket.as_ref())
        .and_then(|w| w.connected)
        .unwrap_or(false);
    LAST_KNOWN_WS_CONNECTED.store(is_connected, Ordering::Relaxed);
    if should_log_queue_poll(is_connected) {
        crate::desktop_log!(
            "📡 SyftBox queue poll → sync: {} upload: {} errors: {} | sample sync: [{}] uploads: [{}]",
            sync_count,
            upload_count,
            err_msg,
            sample_sync.join(" | "),
            sample_uploads.join(" | ")
        );
    }

    Ok(SyftBoxQueueStatus {
        control_plane_url: Some(cfg.client_url),
        data_dir: cfg.data_dir,
        sync,
        uploads,
        status,
        latency,
        error: if errors.is_empty() {
            None
        } else {
            Some(errors.join("; "))
        },
    })
}

#[tauri::command]
pub async fn syftbox_subscriptions_discovery() -> Result<Vec<SyftBoxDiscoveryFile>, String> {
    if SUBSCRIPTION_DISCOVERY_UNAVAILABLE.load(Ordering::Relaxed) {
        return Ok(Vec::new());
    }
    let cfg = load_syftbox_client_config()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let resp: SyftBoxDiscoveryResponse = match cp_get(
        &client,
        &cfg.client_url,
        "/v1/subscriptions/discovery/files",
        &cfg.client_token,
    )
    .await
    {
        Ok(resp) => resp,
        Err(e) => {
            if e.contains("HTTP 404") {
                SUBSCRIPTION_DISCOVERY_UNAVAILABLE.store(true, Ordering::Relaxed);
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let last = LAST_SUBSCRIPTION_404_LOG.load(Ordering::Relaxed);
                if now.saturating_sub(last) > 60 {
                    LAST_SUBSCRIPTION_404_LOG.store(now, Ordering::Relaxed);
                    crate::desktop_log!(
                        "⚠️ syftbox_subscriptions_discovery unsupported (404). Disabling further checks."
                    );
                }
                return Ok(Vec::new());
            }
            return Err(e);
        }
    };

    Ok(resp.files)
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
pub async fn trigger_syftbox_sync() -> Result<(), String> {
    let cfg = load_syftbox_client_config()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let url = format!("{}/v1/sync/now", cfg.client_url.trim_end_matches('/'));

    let resp = client
        .post(&url)
        .bearer_auth(&cfg.client_token)
        .send()
        .await
        .map_err(|e| format!("Failed to trigger sync: {}", e))?;

    if resp.status().is_success() {
        record_control_plane_event("POST", &url, Some(resp.status().as_u16()), None);
        Ok(())
    } else {
        let err = format!("Trigger sync failed: HTTP {}", resp.status());
        record_control_plane_event(
            "POST",
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
