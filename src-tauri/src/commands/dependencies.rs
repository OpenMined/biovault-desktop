use biovault::cli::commands::check::DependencyCheckResult;
use chrono::Local;
use std::collections::HashSet;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

fn resolve_biovault_home_path() -> PathBuf {
    if let Ok(home) = biovault::config::get_biovault_home() {
        return home;
    }

    env::var("BIOVAULT_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home_dir = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            dirs::desktop_dir()
                .unwrap_or_else(|| home_dir.join("Desktop"))
                .join("BioVault")
        })
}

fn desktop_log_path() -> PathBuf {
    let base = resolve_biovault_home_path();
    base.join("logs").join("desktop.log")
}

fn log_desktop_event(message: &str) {
    let timestamp = Local::now().format("%Y-%m-%dT%H:%M:%S%:z");
    let log_line = format!("[{}] {}\n", timestamp, message);

    if let Err(err) = (|| -> std::io::Result<()> {
        let log_path = desktop_log_path();
        if let Some(parent) = log_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;
        file.write_all(log_line.as_bytes())?;
        Ok(())
    })() {
        eprintln!("Failed to write desktop log: {}", err);
    }
}

// Helper function to save dependency states (used by complete_onboarding in settings.rs)
pub fn save_dependency_states(biovault_path: &Path) -> Result<(), String> {
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
pub async fn check_dependencies() -> Result<DependencyCheckResult, String> {
    eprintln!("🔍 check_dependencies called");

    // Call the library function directly
    biovault::cli::commands::check::check_dependencies_result()
        .map_err(|e| format!("Failed to check dependencies: {}", e))
}

#[tauri::command]
pub async fn check_single_dependency(
    name: String,
    path: Option<String>,
) -> Result<biovault::cli::commands::check::DependencyResult, String> {
    eprintln!(
        "🔍 check_single_dependency called: {} (path: {:?})",
        name, path
    );

    // Call the library function to check just this one dependency
    biovault::cli::commands::check::check_single_dependency(&name, path)
        .map_err(|e| format!("Failed to check dependency: {}", e))
}

#[tauri::command]
pub fn get_saved_dependency_states() -> Result<DependencyCheckResult, String> {
    eprintln!("📋 Getting saved dependency states from file");

    let biovault_home = env::var("BIOVAULT_HOME").unwrap_or_else(|_| {
        let home_dir = dirs::home_dir().unwrap();
        dirs::desktop_dir()
            .unwrap_or_else(|| home_dir.join("Desktop"))
            .join("BioVault")
            .to_string_lossy()
            .to_string()
    });
    let biovault_path = PathBuf::from(&biovault_home);
    let states_path = biovault_path.join("dependency_states.json");

    // Try to load saved states first
    if states_path.exists() {
        eprintln!("  Loading from: {}", states_path.display());
        let json_str = fs::read_to_string(&states_path)
            .map_err(|e| format!("Failed to read dependency states: {}", e))?;

        let mut saved_result: DependencyCheckResult = serde_json::from_str(&json_str)
            .map_err(|e| format!("Failed to parse dependency states: {}", e))?;

        if let Ok(config) = biovault::config::Config::load() {
            for dep in &mut saved_result.dependencies {
                if dep.path.is_none() {
                    dep.path = config.get_binary_path(&dep.name);
                }
            }
        }

        eprintln!(
            "  Loaded {} saved dependencies",
            saved_result.dependencies.len()
        );
        return Ok(saved_result);
    }

    // If no saved states, check with current config paths
    eprintln!("  No saved states found, checking with current config");
    let config_path = biovault_path.join("config.yaml");

    if !config_path.exists() {
        eprintln!("  Config doesn't exist, returning empty dependencies");
        return Ok(DependencyCheckResult {
            dependencies: vec![],
            all_satisfied: false,
        });
    }

    // Load config to get saved custom paths
    let config =
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;

    // Check each dependency with the saved custom path (if any)
    let mut dependencies = vec![];
    for dep_name in ["java", "docker", "nextflow", "syftbox", "uv"] {
        let custom_path = config.get_binary_path(dep_name);
        if let Ok(dep_result) =
            biovault::cli::commands::check::check_single_dependency(dep_name, custom_path)
        {
            dependencies.push(dep_result);
        }
    }

    // Check if all are satisfied
    let all_satisfied = dependencies
        .iter()
        .all(|dep| dep.found && (dep.running.is_none() || dep.running == Some(true)));

    let result = DependencyCheckResult {
        dependencies,
        all_satisfied,
    };

    // Save these states for next time
    if let Ok(json) = serde_json::to_string_pretty(&result) {
        let _ = fs::write(&states_path, json);
        eprintln!("  Saved current states to: {}", states_path.display());
    }

    Ok(result)
}

#[tauri::command]
pub async fn save_custom_path(name: String, path: String) -> Result<(), String> {
    eprintln!("💾 save_custom_path called: {} -> {}", name, path);

    let sanitized = if path.trim().is_empty() {
        None
    } else {
        Some(path.trim().to_string())
    };

    biovault::config::Config::save_binary_path(&name, sanitized.clone())
        .map_err(|e| format!("Failed to save config: {}", e))?;

    // Also update saved dependency states
    update_saved_dependency_states()?;

    eprintln!(
        "✅ Saved custom path for {}: {}",
        name,
        sanitized
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or("(reset)")
    );
    Ok(())
}

#[tauri::command]
pub fn update_saved_dependency_states() -> Result<(), String> {
    eprintln!("🔄 Updating saved dependency states");

    let biovault_home = env::var("BIOVAULT_HOME").unwrap_or_else(|_| {
        let home_dir = dirs::home_dir().unwrap();
        dirs::desktop_dir()
            .unwrap_or_else(|| home_dir.join("Desktop"))
            .join("BioVault")
            .to_string_lossy()
            .to_string()
    });
    let biovault_path = PathBuf::from(&biovault_home);

    save_dependency_states(&biovault_path)?;
    Ok(())
}

#[tauri::command]
pub fn check_brew_installed() -> Result<bool, String> {
    eprintln!("🍺 Checking if Homebrew is installed (using library)");
    log_desktop_event("Checking Homebrew installation status");

    // Call the library function
    let result = biovault::cli::commands::check::check_brew_installed()
        .map_err(|e| format!("Failed to check brew: {}", e))?;

    log_desktop_event(&format!("Homebrew present: {}", result));
    Ok(result)
}

#[tauri::command]
pub async fn install_brew() -> Result<String, String> {
    eprintln!("🍺 Installing Homebrew (using library)");
    log_desktop_event("Homebrew installation requested from desktop app");

    // Call the library function
    match biovault::cli::commands::check::install_brew() {
        Ok(path) => {
            log_desktop_event(&format!(
                "Homebrew installation completed successfully. Detected brew at: {}",
                path
            ));
            Ok(path)
        }
        Err(err) => {
            eprintln!("🍺 Homebrew installation error: {:#?}", err);
            log_desktop_event(&format!("Homebrew installation debug: {:#?}", err));
            log_desktop_event(&format!("Homebrew installation failed: {}", err));
            Err(format!("Failed to install brew: {}", err))
        }
    }
}

#[tauri::command]
pub fn check_command_line_tools_installed() -> Result<bool, String> {
    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }

    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("xcode-select")
            .arg("-p")
            .status()
            .map_err(|e| format!("Failed to check Command Line Tools: {}", e))?;

        Ok(status.success())
    }
}

#[tauri::command]
pub async fn install_dependency(name: String) -> Result<String, String> {
    eprintln!("📦 install_dependency called: {}", name);

    // Call the library function to install just this one dependency
    let installed_path = biovault::cli::commands::setup::install_single_dependency(&name)
        .await
        .map_err(|e| format!("Failed to install {}: {}", name, e))?;

    if let Some(path) = installed_path {
        eprintln!("✅ Installed {} at: {}", name, path);
        Ok(path)
    } else {
        eprintln!(
            "✅ Installed {} (path not detected - may not be in PATH)",
            name
        );
        Ok(String::new())
    }
}

#[tauri::command]
pub async fn install_dependencies(names: Vec<String>) -> Result<(), String> {
    eprintln!("📦 install_dependencies called: {:?}", names);
    let mut unique = Vec::new();
    let mut seen = HashSet::new();
    for name in names {
        if seen.insert(name.clone()) {
            unique.push(name);
        }
    }

    if unique.is_empty() {
        return Ok(());
    }

    biovault::cli::commands::setup::install_dependencies(&unique)
        .await
        .map_err(|e| format!("Failed to install dependencies: {}", e))?;

    Ok(())
}
