use crate::types::{AppState, Settings};
use biovault::cli::commands::init;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

// Helper function to save dependency states during onboarding
fn save_dependency_states(biovault_path: &Path) -> Result<(), String> {
    // Check current dependency states
    let check_result = biovault::cli::commands::check::check_dependencies_result()
        .map_err(|e| format!("Failed to check dependencies: {}", e))?;

    // Save as JSON for easy retrieval
    let states_path = biovault_path.join("dependency_states.json");
    let json = serde_json::to_string_pretty(&check_result)
        .map_err(|e| format!("Failed to serialize dependency states: {}", e))?;

    fs::write(&states_path, json)
        .map_err(|e| format!("Failed to write dependency states: {}", e))?;

    eprintln!("💾 Saved dependency states to: {}", states_path.display());
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
pub fn check_is_onboarded() -> Result<bool, String> {
    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    let config_path = biovault_home.join("config.yaml");
    Ok(config_path.exists())
}

#[tauri::command]
pub fn reset_all_data(_state: tauri::State<AppState>) -> Result<(), String> {
    eprintln!("🗑️ RESET: Deleting all BioVault data");

    // Delete the active BioVault home directory (resolves env vars and persisted location)
    let biovault_path = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;

    if biovault_path.exists() {
        fs::remove_dir_all(&biovault_path)
            .map_err(|e| format!("Failed to delete BIOVAULT_HOME: {}", e))?;
        eprintln!("   Deleted: {}", biovault_path.display());
    }

    eprintln!("✅ RESET: All data deleted successfully");
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
    eprintln!("🚀 Initializing BioVault with email: {}", email);
    init::execute(Some(&email), true)
        .await
        .map_err(|e| format!("Failed to initialize BioVault: {}", e))?;

    // Also save the current dependency states for later retrieval
    save_dependency_states(&biovault_path)?;

    eprintln!("✅ Onboarding complete for: {}", email);
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
    eprintln!("📁 show_in_folder called with: {}", file_path);

    #[cfg(target_os = "macos")]
    {
        eprintln!("🍎 Opening in Finder (macOS)...");
        let result = std::process::Command::new("open")
            .arg("-R")
            .arg(&file_path)
            .spawn()
            .map_err(|e| e.to_string());

        if let Err(ref e) = result {
            eprintln!("❌ Failed to open Finder: {}", e);
        } else {
            eprintln!("✅ Finder command executed");
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
