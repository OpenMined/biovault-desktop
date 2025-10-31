use crate::types::{SyftBoxConfigInfo, SyftBoxState};
use std::sync::atomic::{AtomicBool, Ordering};

static SYFTBOX_RUNNING: AtomicBool = AtomicBool::new(false);

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
pub async fn syftbox_request_otp(email: String) -> Result<(), String> {
    crate::desktop_log!("📧 syftbox_request_otp called for: {}", email);

    biovault::cli::commands::syftbox::request_otp(Some(email), None, None)
        .await
        .map_err(|e| format!("{}", e))?;

    crate::desktop_log!("✅ OTP request sent successfully");
    Ok(())
}

#[tauri::command]
pub async fn syftbox_submit_otp(code: String, email: String) -> Result<(), String> {
    crate::desktop_log!("🔐 syftbox_submit_otp called");

    biovault::cli::commands::syftbox::submit_otp(&code, Some(email), None, None, None, None)
        .await
        .map_err(|e| format!("{}", e))?;

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
    let syftbox_config_path = match &config {
        Some(cfg) => cfg.get_syftbox_config_path().ok(),
        None => None,
    };

    let config_path = syftbox_config_path
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| {
            // Default path if not configured
            dirs::home_dir()
                .map(|h| {
                    h.join(".syftbox")
                        .join("config.json")
                        .to_string_lossy()
                        .to_string()
                })
                .unwrap_or_else(|| "~/.syftbox/config.json".to_string())
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

    Ok(SyftBoxConfigInfo {
        is_authenticated,
        config_path,
        has_access_token,
        has_refresh_token,
    })
}

#[tauri::command]
pub fn get_syftbox_state() -> Result<SyftBoxState, String> {
    let running = SYFTBOX_RUNNING.load(Ordering::SeqCst);
    Ok(SyftBoxState {
        running,
        mode: if running { "Online" } else { "Direct" }.to_string(),
    })
}

#[tauri::command]
pub fn start_syftbox_client() -> Result<SyftBoxState, String> {
    SYFTBOX_RUNNING.store(true, Ordering::SeqCst);
    Ok(SyftBoxState {
        running: true,
        mode: "Online".to_string(),
    })
}

#[tauri::command]
pub fn stop_syftbox_client() -> Result<SyftBoxState, String> {
    SYFTBOX_RUNNING.store(false, Ordering::SeqCst);
    Ok(SyftBoxState {
        running: false,
        mode: "Direct".to_string(),
    })
}
