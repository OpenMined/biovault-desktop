use crate::init_db;
use crate::types::{AppState, Settings, DEFAULT_SYFTBOX_SERVER_URL};
use biovault::cli::commands::init;
use biovault::cli::commands::jupyter as jupyter_cli;
use biovault::config::SyftboxCredentials;
use biovault::data::BioVaultDb;
use rusqlite::Connection;
use serde_json::Value;
use std::env;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri_plugin_autostart::ManagerExt;

const PLACEHOLDER_EMAIL: &str = "setup@pending";

fn normalize_server_url(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    trimmed.trim_end_matches('/').to_string()
}

fn remove_dir_all_with_retry(path: &std::path::Path, max_wait: Duration) -> io::Result<()> {
    let deadline = SystemTime::now() + max_wait;
    let mut last_err: Option<io::Error> = None;

    while SystemTime::now() < deadline {
        match fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(err) => {
                let raw = err.raw_os_error();
                let retryable = matches!(raw, Some(5) | Some(32) | Some(145))
                    || err.kind() == io::ErrorKind::PermissionDenied;
                if !retryable {
                    return Err(err);
                }
                last_err = Some(err);
                std::thread::sleep(Duration::from_millis(300));
            }
        }
    }

    Err(last_err.unwrap_or_else(|| io::Error::other("Timed out while removing directory")))
}

fn stop_all_jupyter_best_effort() {
    let db = match BioVaultDb::new() {
        Ok(db) => db,
        Err(err) => {
            crate::desktop_log!(
                "⚠️ RESET: Failed to open BioVault DB to stop Jupyter: {}",
                err
            );
            return;
        }
    };

    let envs = match db.list_dev_envs() {
        Ok(envs) => envs,
        Err(err) => {
            crate::desktop_log!("⚠️ RESET: Failed to list dev envs to stop Jupyter: {}", err);
            return;
        }
    };

    for env in envs {
        if env.jupyter_pid.is_none() && env.jupyter_port.is_none() {
            continue;
        }

        let project_path = env.project_path.clone();
        crate::desktop_log!("RESET: Stopping Jupyter for project: {}", project_path);
        match tauri::async_runtime::block_on(jupyter_cli::stop(&project_path)) {
            Ok(_) => {}
            Err(err) => crate::desktop_log!(
                "⚠️ RESET: Failed to stop Jupyter for {}: {}",
                project_path,
                err
            ),
        }
    }
}

fn best_effort_stop_syftbox_for_reset() {
    match crate::stop_syftbox_client() {
        Ok(_) => (),
        Err(err) => {
            crate::desktop_log!("⚠️ RESET: Failed to stop SyftBox via API: {}", err);
        }
    }

    if crate::syftbox_backend_is_embedded() {}

    // Fallback for partially configured states (e.g. before onboarding) where runtime config can't be loaded.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut cmd = Command::new("taskkill");
        cmd.args(["/IM", "syftbox.exe", "/T", "/F"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.status();
    }
}

fn reset_all_data_impl(state: &AppState, preserve_keys: bool) -> Result<(), String> {
    crate::desktop_log!(
        "dY-`‹,? RESET: Deleting all BioVault data (preserve_keys={})",
        preserve_keys
    );

    state.queue_processor_paused.store(true, Ordering::SeqCst);
    struct PauseGuard<'a> {
        flag: &'a std::sync::atomic::AtomicBool,
    }
    impl<'a> Drop for PauseGuard<'a> {
        fn drop(&mut self) {
            self.flag.store(false, Ordering::SeqCst);
        }
    }
    let _pause_guard = PauseGuard {
        flag: &state.queue_processor_paused,
    };

    // Stop background processes (to prevent Windows file locks and unblock updates/deletes).
    crate::desktop_log!("RESET: Stopping SyftBox...");
    best_effort_stop_syftbox_for_reset();
    stop_all_jupyter_best_effort();

    // Stop filesystem watchers that keep BIOVAULT_HOME directories open on Windows.
    if let Ok(mut slot) = state.message_watcher.lock() {
        if let Some(handle) = slot.as_mut() {
            crate::desktop_log!("RESET: Stopping message watcher...");
            handle.stop();
        }
        *slot = None;
    }

    let biovault_path = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;

    // Close the legacy desktop connection (unused but kept for compatibility)
    {
        let placeholder = Connection::open_in_memory()
            .map_err(|e| format!("Failed to create placeholder connection: {}", e))?;
        let mut desktop_conn = state
            .db
            .lock()
            .map_err(|_| "Failed to lock desktop database connection".to_string())?;
        let _ = std::mem::replace(&mut *desktop_conn, placeholder);
    }

    // Close the shared BioVault database connection so we can delete the files
    {
        let placeholder = Connection::open_in_memory()
            .map_err(|e| format!("Failed to create placeholder connection: {}", e))?;
        let mut shared_db = state
            .biovault_db
            .lock()
            .map_err(|_| "Failed to lock BioVault database".to_string())?;
        let _ = std::mem::replace(&mut shared_db.conn, placeholder);
    }

    if biovault_path.exists() {
        let syc_path = biovault_path.join(".syc");
        let mut syc_backup: Option<PathBuf> = None;

        if preserve_keys && syc_path.exists() {
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let backup_path = biovault_path
                .parent()
                .unwrap_or(&biovault_path)
                .join(format!(".syc-backup-{}", ts));

            fs::rename(&syc_path, &backup_path).map_err(|e| {
                format!(
                    "Failed to move .syc out of BIOVAULT_HOME ({} -> {}): {}",
                    syc_path.display(),
                    backup_path.display(),
                    e
                )
            })?;
            syc_backup = Some(backup_path);
        }

        let delete_result = remove_dir_all_with_retry(&biovault_path, Duration::from_secs(15))
            .map_err(|e| format!("Failed to delete {}: {}", biovault_path.display(), e));

        // Attempt to restore keys even if deletion failed.
        if let Some(backup_path) = &syc_backup {
            if !biovault_path.exists() {
                let _ = fs::create_dir_all(&biovault_path);
            }
            let restore_target = biovault_path.join(".syc");
            if let Err(err) = fs::rename(backup_path, &restore_target) {
                crate::desktop_log!(
                    "⚠️ RESET: Failed to restore .syc ({} -> {}): {}",
                    backup_path.display(),
                    restore_target.display(),
                    err
                );
            }
        }

        delete_result?;
    }

    // Also delete the pointer file that stores the BioVault home location
    if let Some(config_dir) = dirs::config_dir() {
        let pointer_path = config_dir.join("BioVault").join("home_path");
        if pointer_path.exists() {
            fs::remove_file(&pointer_path)
                .map_err(|e| format!("Failed to delete pointer file: {}", e))?;
            crate::desktop_log!("   Deleted pointer: {}", pointer_path.display());
        }

        // Best-effort removal of the directory if now empty
        let biovault_config_dir = config_dir.join("BioVault");
        if biovault_config_dir.exists() {
            let _ = fs::remove_dir(&biovault_config_dir);
        }
    }

    // Recreate the BioVault home and connections so the running app sees a clean state
    let new_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to recreate BioVault home: {}", e))?;

    {
        let mut desktop_conn = state
            .db
            .lock()
            .map_err(|_| "Failed to lock desktop database connection".to_string())?;
        let new_conn = Connection::open(new_home.join("biovault.db"))
            .map_err(|e| format!("Failed to open desktop database: {}", e))?;
        init_db(&new_conn).map_err(|e| format!("Failed to initialize desktop database: {}", e))?;
        *desktop_conn = new_conn;
    }

    {
        let new_db = biovault::data::BioVaultDb::new()
            .map_err(|e| format!("Failed to initialize BioVault database: {}", e))?;
        let mut shared_db = state
            .biovault_db
            .lock()
            .map_err(|_| "Failed to lock BioVault database".to_string())?;
        *shared_db = new_db;
    }

    crate::desktop_log!("バ. RESET: All data deleted successfully");
    Ok(())
}

#[tauri::command]
pub fn get_config_path() -> Result<String, String> {
    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    Ok(biovault_home
        .join("config.yaml")
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
pub fn get_database_path() -> Result<String, String> {
    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    Ok(biovault_home
        .join("biovault.db")
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn check_is_onboarded() -> Result<bool, String> {
    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    let config_path = biovault_home.join("config.yaml");
    let exists = config_path.exists();
    if !exists {
        crate::desktop_log!(
            "🔍 Checking onboarding: config_path={:?}, exists={}",
            config_path,
            exists
        );
        return Ok(false);
    }

    match biovault::config::Config::load() {
        Ok(config) => {
            let email = config.email.trim();
            let onboarded = !email.is_empty() && email != PLACEHOLDER_EMAIL;
            crate::desktop_log!(
                "🔍 Checking onboarding: config_path={:?}, email='{}', onboarded={}",
                config_path,
                email,
                onboarded
            );
            Ok(onboarded)
        }
        Err(err) => {
            crate::desktop_log!(
                "🔍 Checking onboarding: config_path={:?}, failed to load config: {}",
                config_path,
                err
            );
            Ok(false)
        }
    }
}

#[tauri::command]
pub fn reset_all_data(state: tauri::State<AppState>) -> Result<(), String> {
    reset_all_data_impl(&state, true)
}

#[tauri::command]
pub fn reset_everything(state: tauri::State<AppState>) -> Result<(), String> {
    reset_all_data_impl(&state, false)
}

#[tauri::command]
pub async fn complete_onboarding(email: String) -> Result<(), String> {
    println!("🏁 [complete_onboarding] called with email: {}", email);
    println!(
        "🏁 [complete_onboarding] SYC_VAULT env: {:?}",
        env::var("SYC_VAULT")
    );

    let biovault_path = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to resolve BioVault home: {}", e))?;
    println!(
        "🏁 [complete_onboarding] BIOVAULT_HOME: {}",
        biovault_path.display()
    );

    if crate::commands::profiles::email_in_use_by_other_profile(&email, &biovault_path)
        .unwrap_or(false)
    {
        return Err(
            "That email already exists as another profile. Switch to that profile instead."
                .to_string(),
        );
    }

    // Check vault state BEFORE init
    let syc_path = biovault_path.join(".syc");
    println!(
        "🏁 [complete_onboarding] .syc path: {}, exists: {}",
        syc_path.display(),
        syc_path.exists()
    );
    if syc_path.exists() {
        let keys_path = syc_path.join("keys");
        let bundles_path = syc_path.join("bundles");
        println!(
            "🏁 [complete_onboarding] .syc/keys exists: {}, .syc/bundles exists: {}",
            keys_path.exists(),
            bundles_path.exists()
        );
    }

    // Call bv init to set up templates and directory structure
    eprintln!("DEBUG: About to call init::execute()");
    crate::desktop_log!("🚀 Initializing BioVault with email: {}", email);
    init::execute(Some(&email), true)
        .await
        .map_err(|e| format!("Failed to initialize BioVault: {}", e))?;

    // Ensure the config.yaml email matches the onboarding input (even if a placeholder existed before).
    let config_path = biovault_path.join("config.yaml");
    match biovault::config::Config::load() {
        Ok(mut cfg) => {
            if cfg.email.trim() != email.trim() {
                cfg.email = email.clone();
                if let Err(err) = cfg.save(&config_path) {
                    crate::desktop_log!(
                        "⚠️ Failed to persist onboarding email to config.yaml: {}",
                        err
                    );
                } else {
                    crate::desktop_log!(
                        "✅ Updated config.yaml email to onboarding value: {}",
                        cfg.email
                    );
                }
            }
        }
        Err(err) => {
            crate::desktop_log!(
                "⚠️ Failed to load config.yaml after init (email may not be saved): {}",
                err
            );
        }
    }

    eprintln!("DEBUG: init::execute() complete, calling save_dependency_states()");
    crate::desktop_log!("✅ Init complete, now saving dependency states...");

    // Also save the current dependency states for later retrieval
    match super::dependencies::save_dependency_states(&biovault_path) {
        Ok(_) => {
            eprintln!("DEBUG: save_dependency_states() returned OK");
            crate::desktop_log!("✅ Dependency states saved successfully");
            match biovault::config::Config::load() {
                Ok(config) => {
                    println!("✓ Dependency binaries detected and saved:");
                    for binary in super::dependencies::dependency_names() {
                        match config.get_binary_path(binary) {
                            Some(path) => {
                                println!("  - {}: {}", binary, path);
                                crate::desktop_log!("  {} binary path: {}", binary, path);
                            }
                            None => {
                                println!("  - {}: <not found>", binary);
                                crate::desktop_log!("  {} binary path not set", binary);
                            }
                        }
                    }
                }
                Err(err) => {
                    println!("⚠️  Failed to read saved dependency paths: {}", err);
                    crate::desktop_log!("⚠️  Failed to read saved dependency paths: {}", err);
                }
            }
        }
        Err(e) => {
            eprintln!("DEBUG: save_dependency_states() returned ERROR: {}", e);
            crate::desktop_log!("⚠️  ERROR saving dependency states: {}", e);
            return Err(format!("Failed to save dependency states: {}", e));
        }
    }

    eprintln!("DEBUG: Onboarding complete");
    crate::desktop_log!("✅ Onboarding complete for: {}", email);

    // Register/refresh the current profile entry (best-effort).
    if let Err(err) = crate::commands::profiles::register_current_profile_email(&email) {
        crate::desktop_log!("⚠️ Failed to register profile for {}: {}", email, err);
    }

    Ok(())
}

#[tauri::command]
pub fn get_settings() -> Result<Settings, String> {
    println!("⚙️ [get_settings] called");
    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    let settings_path = biovault_home.join("database").join("settings.json");
    let legacy_settings_path = dirs::desktop_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Desktop")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("BioVault")
        .join("database")
        .join("settings.json");
    println!(
        "⚙️ [get_settings] settings_path: {}",
        settings_path.display()
    );

    let mut settings = if settings_path.exists() {
        println!("⚙️ [get_settings] settings.json exists, loading...");
        let content = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings: {}", e))?
    } else if legacy_settings_path.exists() {
        // Back-compat migration from legacy Desktop/BioVault location.
        let content = fs::read_to_string(&legacy_settings_path)
            .map_err(|e| format!("Failed to read legacy settings: {}", e))?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        println!("⚙️ [get_settings] settings.json does NOT exist, using defaults");
        Settings::default()
    };
    println!(
        "⚙️ [get_settings] initial email from settings.json: '{}'",
        settings.email
    );

    // Load email from BioVault config if not set in settings
    if settings.email.is_empty() {
        println!("⚙️ [get_settings] email empty, loading from config.yaml...");
        println!(
            "⚙️ [get_settings] BIOVAULT_HOME: {}",
            biovault_home.display()
        );
        let config_path = biovault_home.join("config.yaml");
        println!(
            "⚙️ [get_settings] config_path: {}, exists: {}",
            config_path.display(),
            config_path.exists()
        );

        if config_path.exists() {
            match biovault::config::Config::load() {
                Ok(config) => {
                    println!(
                        "⚙️ [get_settings] config.yaml loaded, email: '{}'",
                        config.email
                    );
                    settings.email = config.email;
                }
                Err(e) => {
                    println!("⚙️ [get_settings] config.yaml load failed: {}", e);
                }
            }
        }
    }
    println!("⚙️ [get_settings] final email: '{}'", settings.email);

    // Keep SyftBox server URL aligned with the BioVault config
    if let Ok(config) = biovault::config::Config::load() {
        if let Some(creds) = config.syftbox_credentials.as_ref() {
            if let Some(server_url) = creds.server_url.as_ref() {
                let normalized = normalize_server_url(server_url);
                if !normalized.is_empty() {
                    settings.syftbox_server_url = normalized;
                }
            }
        }
    }

    if settings.syftbox_server_url.trim().is_empty() {
        settings.syftbox_server_url = DEFAULT_SYFTBOX_SERVER_URL.to_string();
    } else {
        let normalized = normalize_server_url(&settings.syftbox_server_url);
        settings.syftbox_server_url = if normalized.is_empty() {
            DEFAULT_SYFTBOX_SERVER_URL.to_string()
        } else {
            normalized
        };
    }

    // Apply environment variable override for display
    if let Ok(env_path) = env::var("BIOVAULT_PATH") {
        settings.biovault_path = format!("{} (env override)", env_path);
    }

    Ok(settings)
}

#[tauri::command]
pub fn save_settings(mut settings: Settings) -> Result<(), String> {
    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    let settings_path = biovault_home.join("database").join("settings.json");

    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create settings directory: {}", e))?;
    }

    // Normalise server URL before persisting
    let normalized_server = normalize_server_url(&settings.syftbox_server_url);
    settings.syftbox_server_url = if normalized_server.is_empty() {
        DEFAULT_SYFTBOX_SERVER_URL.to_string()
    } else {
        normalized_server
    };

    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    fs::write(&settings_path, json).map_err(|e| format!("Failed to write settings: {}", e))?;

    let config_path = biovault_home.join("config.yaml");

    // Load or create config
    let mut config = if config_path.exists() {
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?
    } else {
        fs::create_dir_all(&biovault_home)
            .map_err(|e| format!("Failed to create BioVault directory: {}", e))?;

        biovault::config::Config {
            email: String::new(),
            syftbox_config: None,
            version: None,
            binary_paths: None,
            syftbox_credentials: None,
        }
    };

    // Update email if the user provided one, otherwise preserve existing
    if !settings.email.is_empty() && settings.email.trim() != PLACEHOLDER_EMAIL {
        if crate::commands::profiles::email_in_use_by_other_profile(&settings.email, &biovault_home)
            .unwrap_or(false)
        {
            return Err(
                "That email already exists as another profile. Switch to that profile instead."
                    .to_string(),
            );
        }
        config.email = settings.email.clone();
    }

    let previous_server = config
        .syftbox_credentials
        .as_ref()
        .and_then(|creds| creds.server_url.as_ref())
        .map(|url| normalize_server_url(url))
        .unwrap_or_else(|| DEFAULT_SYFTBOX_SERVER_URL.to_string());

    let server_changed = previous_server != settings.syftbox_server_url;
    let creds = config
        .syftbox_credentials
        .get_or_insert_with(SyftboxCredentials::default);
    creds.server_url = Some(settings.syftbox_server_url.clone());
    if server_changed {
        creds.access_token = None;
        creds.refresh_token = None;
    }

    // Save config
    config
        .save(&config_path)
        .map_err(|e| format!("Failed to save config: {}", e))?;

    // Best-effort profile registration (keeps profile list in sync if identity changes).
    if !config.email.trim().is_empty() && config.email.trim() != PLACEHOLDER_EMAIL {
        if let Err(err) = crate::commands::profiles::register_current_profile_email(&config.email) {
            crate::desktop_log!("⚠️ Failed to refresh profile registration: {}", err);
        }
    }

    Ok(())
}

#[tauri::command]
pub fn set_syftbox_dev_server(server_url: String) -> Result<(), String> {
    let normalized = normalize_server_url(&server_url);
    if normalized.is_empty() {
        return Err("Server URL cannot be empty".to_string());
    }

    crate::desktop_log!("🛠️ set_syftbox_dev_server called -> {}", normalized);

    // Load config (create minimal if missing)
    let biovault_home = env::var("BIOVAULT_HOME").unwrap_or_else(|_| {
        let home_dir = dirs::home_dir().unwrap();
        dirs::desktop_dir()
            .unwrap_or_else(|| home_dir.join("Desktop"))
            .join("BioVault")
            .to_string_lossy()
            .to_string()
    });
    let config_path = PathBuf::from(&biovault_home).join("config.yaml");

    crate::desktop_log!("📝 Using BioVault config: {}", config_path.display());

    let mut config = if config_path.exists() {
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?
    } else {
        fs::create_dir_all(&biovault_home)
            .map_err(|e| format!("Failed to create BioVault directory: {}", e))?;

        biovault::config::Config {
            email: String::new(),
            syftbox_config: None,
            version: None,
            binary_paths: None,
            syftbox_credentials: None,
        }
    };

    // Update BioVault config
    let creds = config
        .syftbox_credentials
        .get_or_insert_with(SyftboxCredentials::default);
    creds.server_url = Some(normalized.clone());
    // Clear tokens when switching servers to avoid mismatched creds
    creds.access_token = None;
    creds.refresh_token = None;

    crate::desktop_log!("🔄 Writing server_url to config.yaml and clearing tokens");

    config
        .save(&config_path)
        .map_err(|e| format!("Failed to save config: {}", e))?;

    // Also update SyftBox client config at the resolved path (best-effort)
    if let Ok(syftbox_config_path) = config.get_syftbox_config_path() {
        crate::desktop_log!(
            "🧭 Resolved SyftBox config path: {}",
            syftbox_config_path.display()
        );
        let mut json: Value = if syftbox_config_path.exists() {
            let content = fs::read_to_string(&syftbox_config_path)
                .map_err(|e| format!("Failed to read SyftBox config: {}", e))?;
            serde_json::from_str(&content).unwrap_or(Value::Object(Default::default()))
        } else {
            Value::Object(Default::default())
        };

        if let Value::Object(ref mut map) = json {
            map.insert("server_url".to_string(), Value::String(normalized.clone()));
            if !config.email.trim().is_empty() {
                map.insert("email".to_string(), Value::String(config.email.clone()));
            }
        }

        if let Some(parent) = syftbox_config_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create SyftBox config dir: {}", e))?;
        }

        let formatted = serde_json::to_string_pretty(&json)
            .map_err(|e| format!("Failed to serialize SyftBox config: {}", e))?;
        fs::write(&syftbox_config_path, formatted)
            .map_err(|e| format!("Failed to write SyftBox config: {}", e))?;
        crate::desktop_log!("✅ Updated SyftBox client config with server_url");
    }

    // Simulate restart of SyftBox client (state flag)
    crate::stop_syftbox_client()?;
    crate::desktop_log!("🛑 SyftBox client stopped for server switch");
    crate::start_syftbox_client()?;
    crate::desktop_log!("🚀 SyftBox client started with new server settings");

    Ok(())
}

#[tauri::command]
pub fn get_env_var(key: String) -> Option<String> {
    std::env::var(&key).ok()
}

#[tauri::command]
pub fn get_default_syftbox_server_url() -> String {
    DEFAULT_SYFTBOX_SERVER_URL.to_string()
}

#[tauri::command]
pub fn open_in_vscode(path: String) -> Result<(), String> {
    use std::path::Path;
    use std::process::Command;

    let path_buf = Path::new(&path);

    // If path is a file, open the parent directory instead
    let target_path = if path_buf.is_file() {
        path_buf
            .parent()
            .ok_or_else(|| format!("Cannot determine parent directory for: {}", path))?
            .to_str()
            .ok_or_else(|| "Invalid path encoding".to_string())?
    } else {
        &path
    };

    crate::desktop_log!("📂 Opening in VSCode: {}", target_path);

    let mut cmd = Command::new("code");
    cmd.arg(target_path);
    super::hide_console_window(&mut cmd);
    cmd.spawn().map_err(|e| {
        format!(
            "Failed to open VSCode: {}. Make sure the 'code' command is installed.",
            e
        )
    })?;

    Ok(())
}

#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("explorer");
        cmd.arg(&path);
        super::hide_console_window(&mut cmd);
        cmd.spawn().map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Save raw bytes to a file
#[tauri::command]
pub fn save_file_bytes(path: String, content: Vec<u8>) -> Result<(), String> {
    use std::fs;
    use std::path::Path;

    let path = Path::new(&path);

    // Create parent directories if needed
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directories: {}", e))?;
    }

    fs::write(path, content).map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn show_in_folder(file_path: String) -> Result<(), String> {
    crate::desktop_log!("📁 show_in_folder called with: {}", file_path);

    #[cfg(target_os = "macos")]
    {
        crate::desktop_log!("🍎 Opening in Finder (macOS)...");
        let result = std::process::Command::new("open")
            .arg("-R")
            .arg(&file_path)
            .spawn()
            .map_err(|e| e.to_string());

        if let Err(ref e) = result {
            crate::desktop_log!("❌ Failed to open Finder: {}", e);
        } else {
            crate::desktop_log!("✅ Finder command executed");
        }

        result?;
    }

    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("explorer");
        cmd.arg("/select,").arg(&file_path);
        super::hide_console_window(&mut cmd);
        cmd.spawn().map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        // On Linux, open the parent directory (revealing file is more complex)
        if let Some(parent) = std::path::Path::new(&file_path).parent() {
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            return Err("Could not determine parent directory".to_string());
        }
    }

    Ok(())
}

/// Check if the app is running in dev mode (BIOVAULT_DEV_MODE=1)
#[tauri::command]
pub fn is_dev_mode() -> bool {
    env::var("BIOVAULT_DEV_MODE")
        .map(|v| v == "1" || v.to_lowercase() == "true")
        .unwrap_or(false)
}

/// Check if updater is disabled (DISABLE_UPDATER=1 or in dev mode)
#[tauri::command]
pub fn is_updater_disabled() -> bool {
    // Disable updater in dev mode
    if is_dev_mode() {
        return true;
    }
    env::var("DISABLE_UPDATER")
        .map(|v| v == "1" || v.to_lowercase() == "true")
        .unwrap_or(false)
}

/// Check if dev syftbox mode is enabled (BIOVAULT_DEV_SYFTBOX=1)
#[tauri::command]
pub fn is_dev_syftbox_enabled() -> bool {
    env::var("BIOVAULT_DEV_SYFTBOX")
        .map(|v| v == "1" || v.to_lowercase() == "true")
        .unwrap_or(false)
}

/// Get the dev syftbox server URL from environment
#[tauri::command]
pub fn get_dev_syftbox_server_url() -> Option<String> {
    env::var("SYFTBOX_SERVER_URL").ok()
}

/// Check if the syftbox server is reachable (for dev mode)
#[tauri::command]
pub async fn check_dev_syftbox_server() -> Result<bool, String> {
    let server_url =
        env::var("SYFTBOX_SERVER_URL").unwrap_or_else(|_| "http://localhost:8080".to_string());

    crate::desktop_log!("🔍 Checking dev syftbox server at: {}", server_url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    match client.get(&server_url).send().await {
        Ok(response) => {
            let reachable = response.status().is_success() || response.status().is_redirection();
            crate::desktop_log!(
                "  Server response: {} (reachable: {})",
                response.status(),
                reachable
            );
            Ok(reachable)
        }
        Err(e) => {
            crate::desktop_log!("  Server not reachable: {}", e);
            Ok(false)
        }
    }
}

/// Get full dev mode information
#[tauri::command]
pub fn get_dev_mode_info() -> serde_json::Value {
    let dev_mode = env::var("BIOVAULT_DEV_MODE")
        .map(|v| v == "1" || v.to_lowercase() == "true")
        .unwrap_or(false);
    let dev_syftbox = env::var("BIOVAULT_DEV_SYFTBOX")
        .map(|v| v == "1" || v.to_lowercase() == "true")
        .unwrap_or(false);
    let server_url = env::var("SYFTBOX_SERVER_URL").ok();
    let syftbox_config_path = env::var("SYFTBOX_CONFIG_PATH").ok();
    let biovault_home = env::var("BIOVAULT_HOME").ok();

    serde_json::json!({
        "dev_mode": dev_mode,
        "dev_syftbox": dev_syftbox,
        "server_url": server_url,
        "syftbox_config_path": syftbox_config_path,
        "biovault_home": biovault_home,
    })
}

#[tauri::command]
pub fn get_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    let autostart = app.autolaunch();
    autostart
        .is_enabled()
        .map_err(|e| format!("Failed to check autostart status: {}", e))
}

#[tauri::command]
pub fn set_autostart_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let autostart = app.autolaunch();

    if enabled {
        autostart
            .enable()
            .map_err(|e| format!("Failed to enable autostart: {}", e))
    } else {
        autostart
            .disable()
            .map_err(|e| format!("Failed to disable autostart: {}", e))
    }
}
