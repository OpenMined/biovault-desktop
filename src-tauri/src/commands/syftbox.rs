use crate::types::{SyftBoxConfigInfo, SyftBoxState};
use serde_json::json;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use syftbox_sdk::syftbox::control as syftctl;

static SYFTBOX_RUNNING: AtomicBool = AtomicBool::new(false);

fn load_runtime_config() -> Result<syftbox_sdk::syftbox::config::SyftboxRuntimeConfig, String> {
    let cfg = biovault::config::Config::load().map_err(|e| e.to_string())?;
    cfg.to_syftbox_runtime_config().map_err(|e| e.to_string())
}

fn ensure_syftbox_config(
    runtime: &syftbox_sdk::syftbox::config::SyftboxRuntimeConfig,
) -> Result<(), String> {
    let cfg = biovault::config::Config::load().map_err(|e| e.to_string())?;
    let creds = cfg.syftbox_credentials.clone().unwrap_or_default();
    let email = if cfg.email.trim().is_empty() {
        creds.email.unwrap_or_default()
    } else {
        cfg.email.clone()
    };
    let server_url = creds
        .server_url
        .unwrap_or_else(|| "https://syftbox.net".to_string());
    let client_url = creds
        .client_url
        .unwrap_or_else(|| "http://localhost:7938".to_string());

    let config_json = json!({
        "data_dir": runtime.data_dir.to_string_lossy(),
        "email": email,
        "server_url": server_url,
        "client_url": client_url,
        "client_token": creds.access_token.unwrap_or_default(),
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
    match syftctl::start_syftbox(&runtime) {
        Ok(started) => {
            if started {
                crate::desktop_log!("🚀 SyftBox started");
            } else {
                crate::desktop_log!("ℹ️ SyftBox already running");
            }
            SYFTBOX_RUNNING.store(true, Ordering::SeqCst);
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
