use crate::init_db;
use crate::types::{AppState, Settings};
use biovault::cli::commands::init;
use rusqlite::Connection;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri_plugin_autostart::ManagerExt;

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
    crate::desktop_log!(
        "🔍 Checking onboarding: config_path={:?}, exists={}",
        config_path,
        exists
    );
    Ok(exists)
}

#[tauri::command]
pub fn reset_all_data(state: tauri::State<AppState>) -> Result<(), String> {
    crate::desktop_log!("🗑️ RESET: Deleting all BioVault data");

    let biovault_path = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;

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
        fs::remove_dir_all(&biovault_path)
            .map_err(|e| format!("Failed to delete BIOVAULT_HOME: {}", e))?;
        crate::desktop_log!("   Deleted: {}", biovault_path.display());
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

    crate::desktop_log!("✅ RESET: All data deleted successfully");
    Ok(())
}

#[tauri::command]
pub async fn complete_onboarding(email: String) -> Result<(), String> {
    let biovault_home = env::var("BIOVAULT_HOME").unwrap_or_else(|_| {
        let home_dir = dirs::home_dir().unwrap();
        dirs::desktop_dir()
            .unwrap_or_else(|| home_dir.join("Desktop"))
            .join("BioVault")
            .to_string_lossy()
            .to_string()
    });

    let biovault_path = PathBuf::from(&biovault_home);

    // Call bv init to set up templates and directory structure
    eprintln!("DEBUG: About to call init::execute()");
    crate::desktop_log!("🚀 Initializing BioVault with email: {}", email);
    init::execute(Some(&email), true)
        .await
        .map_err(|e| format!("Failed to initialize BioVault: {}", e))?;

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
                    for binary in ["java", "docker", "nextflow", "syftbox", "uv"] {
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
    Ok(())
}

#[tauri::command]
pub fn get_settings() -> Result<Settings, String> {
    let desktop_dir = dirs::desktop_dir().ok_or("Could not find desktop directory")?;
    let settings_path = desktop_dir
        .join("BioVault")
        .join("database")
        .join("settings.json");

    let mut settings = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings: {}", e))?
    } else {
        Settings::default()
    };

    // Load email from BioVault config if not set in settings
    if settings.email.is_empty() {
        let biovault_home = env::var("BIOVAULT_HOME").unwrap_or_else(|_| {
            let home_dir = dirs::home_dir().unwrap();
            dirs::desktop_dir()
                .unwrap_or_else(|| home_dir.join("Desktop"))
                .join("BioVault")
                .to_string_lossy()
                .to_string()
        });
        let config_path = PathBuf::from(&biovault_home).join("config.yaml");

        if config_path.exists() {
            if let Ok(config) = biovault::config::Config::load() {
                settings.email = config.email;
            }
        }
    }

    // Apply environment variable override for display
    if let Ok(env_path) = env::var("BIOVAULT_PATH") {
        settings.biovault_path = format!("{} (env override)", env_path);
    }

    Ok(settings)
}

#[tauri::command]
pub fn save_settings(settings: Settings) -> Result<(), String> {
    let desktop_dir = dirs::desktop_dir().ok_or("Could not find desktop directory")?;
    let settings_path = desktop_dir
        .join("BioVault")
        .join("database")
        .join("settings.json");

    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    fs::write(&settings_path, json).map_err(|e| format!("Failed to write settings: {}", e))?;

    // Also save email to BioVault config if it's set
    if !settings.email.is_empty() {
        let biovault_home = env::var("BIOVAULT_HOME").unwrap_or_else(|_| {
            let home_dir = dirs::home_dir().unwrap();
            dirs::desktop_dir()
                .unwrap_or_else(|| home_dir.join("Desktop"))
                .join("BioVault")
                .to_string_lossy()
                .to_string()
        });
        let config_path = PathBuf::from(&biovault_home).join("config.yaml");

        // Load or create config
        let mut config = if config_path.exists() {
            biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?
        } else {
            // Create minimal config
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

        // Update email
        config.email = settings.email.clone();

        // Save config
        config
            .save(&config_path)
            .map_err(|e| format!("Failed to save config: {}", e))?;
    }

    Ok(())
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

    Command::new("code").arg(target_path).spawn().map_err(|e| {
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
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
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
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&file_path)
            .spawn()
            .map_err(|e| e.to_string())?;
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
