use biovault::cli::commands::check::DependencyCheckResult;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

// Helper function to save dependency states (used by complete_onboarding in settings.rs)
pub fn save_dependency_states(biovault_path: &Path) -> Result<DependencyCheckResult, String> {
    eprintln!("DEBUG: save_dependency_states() CALLED");
    eprintln!("DEBUG: biovault_path = {:?}", biovault_path);

    // Check current dependency states
    eprintln!("DEBUG: About to call check_dependencies_result()");
    let check_result = match biovault::cli::commands::check::check_dependencies_result() {
        Ok(result) => {
            eprintln!(
                "DEBUG: check_dependencies_result() returned OK with {} deps",
                result.dependencies.len()
            );
            result
        }
        Err(e) => {
            eprintln!("DEBUG: check_dependencies_result() FAILED: {}", e);
            return Err(format!("Failed to check dependencies: {}", e));
        }
    };

    eprintln!(
        "DEBUG: Processing {} dependencies",
        check_result.dependencies.len()
    );

    // Save binary paths to config.yaml for any found dependencies
    for (idx, dep) in check_result.dependencies.iter().enumerate() {
        eprintln!(
            "DEBUG: [{}/{}] Processing {}: found={}, path={:?}",
            idx + 1,
            check_result.dependencies.len(),
            dep.name,
            dep.found,
            dep.path
        );

        if dep.found && dep.path.is_some() {
            let path = dep.path.clone().unwrap();
            eprintln!("DEBUG:   Calling save_binary_path({}, {})", dep.name, path);

            match biovault::config::Config::save_binary_path(&dep.name, Some(path.clone())) {
                Ok(_) => {
                    eprintln!("DEBUG:   ✅ SAVED {} = {}", dep.name, path);
                }
                Err(e) => {
                    eprintln!("DEBUG:   ❌ FAILED to save {}: {}", dep.name, e);
                }
            }
        } else {
            eprintln!(
                "DEBUG:   SKIPPING {} (found={}, has_path={})",
                dep.name,
                dep.found,
                dep.path.is_some()
            );
        }
    }

    eprintln!("DEBUG: Finished processing all dependencies");

    // Save as JSON for easy retrieval
    let states_path = biovault_path.join("dependency_states.json");
    let json = serde_json::to_string_pretty(&check_result)
        .map_err(|e| format!("Failed to serialize dependency states: {}", e))?;

    fs::write(&states_path, json)
        .map_err(|e| format!("Failed to write dependency states: {}", e))?;

    eprintln!(
        "DEBUG: Saved dependency_states.json to: {}",
        states_path.display()
    );

    // Verify config was updated by reading it back
    eprintln!("DEBUG: Verifying config.yaml contents...");
    match biovault::config::Config::load() {
        Ok(config) => {
            eprintln!("DEBUG: Config loaded successfully, checking binary_paths:");
            for binary in ["java", "docker", "nextflow", "syftbox", "uv"] {
                match config.get_binary_path(binary) {
                    Some(path) => {
                        eprintln!("DEBUG:   ✅ {} = {}", binary, path);
                    }
                    None => {
                        eprintln!("DEBUG:   ❌ {} = <NOT SET>", binary);
                    }
                }
            }
        }
        Err(e) => {
            eprintln!("DEBUG: ⚠️ FAILED to load config for verification: {}", e);
        }
    }

    eprintln!("DEBUG: save_dependency_states() COMPLETE");
    Ok(check_result)
}

#[tauri::command]
pub async fn check_dependencies() -> Result<DependencyCheckResult, String> {
    crate::desktop_log!("🔍 check_dependencies called");

    // Call the library function directly
    biovault::cli::commands::check::check_dependencies_result()
        .map_err(|e| format!("Failed to check dependencies: {}", e))
}

#[tauri::command]
pub async fn check_single_dependency(
    name: String,
    path: Option<String>,
) -> Result<biovault::cli::commands::check::DependencyResult, String> {
    crate::desktop_log!(
        "🔍 check_single_dependency called: {} (path: {:?})",
        name,
        path
    );

    // Call the library function to check just this one dependency
    biovault::cli::commands::check::check_single_dependency(&name, path)
        .map_err(|e| format!("Failed to check dependency: {}", e))
}

#[tauri::command]
pub fn get_saved_dependency_states() -> Result<DependencyCheckResult, String> {
    crate::desktop_log!("📋 Getting saved dependency states from file");

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
        crate::desktop_log!("  Loading from: {}", states_path.display());
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

        crate::desktop_log!(
            "  Loaded {} saved dependencies",
            saved_result.dependencies.len()
        );
        return Ok(saved_result);
    }

    // If no saved states, check with current config paths
    crate::desktop_log!("  No saved states found, checking with current config");
    let config_path = biovault_path.join("config.yaml");

    if !config_path.exists() {
        crate::desktop_log!("  Config doesn't exist, returning empty dependencies");
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
        crate::desktop_log!("  Saved current states to: {}", states_path.display());
    }

    Ok(result)
}

#[tauri::command]
pub async fn check_docker_running() -> Result<bool, String> {
    // Prefer configured docker path, fall back to PATH
    let docker_bin = biovault::config::Config::load()
        .ok()
        .and_then(|cfg| cfg.get_binary_path("docker"))
        .unwrap_or_else(|| "docker".to_string());

    // Run a quick health check
    let status = Command::new(&docker_bin)
        .arg("info")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("Failed to execute '{}': {}", docker_bin, e))?;

    Ok(status.success())
}

#[tauri::command]
pub async fn save_custom_path(name: String, path: String) -> Result<(), String> {
    crate::desktop_log!("💾 save_custom_path called: {} -> {}", name, path);

    let sanitized = if path.trim().is_empty() {
        None
    } else {
        Some(path.trim().to_string())
    };

    biovault::config::Config::save_binary_path(&name, sanitized.clone())
        .map_err(|e| format!("Failed to save config: {}", e))?;

    // Also update saved dependency states
    update_saved_dependency_states()?;

    crate::desktop_log!(
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
    crate::desktop_log!("🔄 Updating saved dependency states");

    let biovault_home = env::var("BIOVAULT_HOME").unwrap_or_else(|_| {
        let home_dir = dirs::home_dir().unwrap();
        dirs::desktop_dir()
            .unwrap_or_else(|| home_dir.join("Desktop"))
            .join("BioVault")
            .to_string_lossy()
            .to_string()
    });
    let biovault_path = PathBuf::from(&biovault_home);

    let _ = save_dependency_states(&biovault_path)?;
    Ok(())
}

#[tauri::command]
pub fn check_brew_installed() -> Result<bool, String> {
    crate::desktop_log!("🍺 Checking if Homebrew is installed (using library)");
    crate::desktop_log!("Checking Homebrew installation status");

    // Call the library function
    let result = biovault::cli::commands::check::check_brew_installed()
        .map_err(|e| format!("Failed to check brew: {}", e))?;

    crate::desktop_log!("Homebrew present: {}", result);
    Ok(result)
}

#[tauri::command]
pub async fn install_brew() -> Result<String, String> {
    crate::desktop_log!("🍺 Installing Homebrew (using library)");
    crate::desktop_log!("Homebrew installation requested from desktop app");

    // Call the library function
    match biovault::cli::commands::check::install_brew() {
        Ok(path) => {
            crate::desktop_log!(
                "Homebrew installation completed successfully. Detected brew at: {}",
                path
            );
            Ok(path)
        }
        Err(err) => {
            crate::desktop_log!("🍺 Homebrew installation error: {:#?}", err);
            crate::desktop_log!("Homebrew installation debug: {:#?}", err);
            crate::desktop_error!("Homebrew installation failed: {}", err);
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
pub async fn install_dependency(window: tauri::Window, name: String) -> Result<String, String> {
    use serde_json::json;
    use tauri::Emitter;

    crate::desktop_log!("📦 install_dependency called: {}", name);
    crate::desktop_log!("Desktop requested installation of {}", name);

    // Emit start event
    let _ = window.emit(
        "dependency-install-start",
        json!({
            "dependency": name.clone(),
        }),
    );

    // Call the library function to install just this one dependency
    let install_result = biovault::cli::commands::setup::install_single_dependency(&name)
        .await
        .map(|maybe_path| {
            if let Some(path) = maybe_path {
                crate::desktop_log!("✅ Installed {} at: {}", name, path);

                // Save the binary path to config
                if let Err(e) =
                    biovault::config::Config::save_binary_path(&name, Some(path.clone()))
                {
                    crate::desktop_log!("⚠️  Failed to save binary path to config: {}", e);
                } else {
                    crate::desktop_log!("💾 Saved {} binary path to config: {}", name, path);
                }

                path
            } else {
                crate::desktop_log!(
                    "✅ Installed {} (path not detected - may not be in PATH)",
                    name
                );
                String::new()
            }
        })
        .map_err(|e| format!("Failed to install {}: {}", name, e));

    // Emit finish event
    let status_payload = match &install_result {
        Ok(_) => json!({
            "dependency": name.clone(),
            "status": "success",
        }),
        Err(error) => json!({
            "dependency": name.clone(),
            "status": "error",
            "error": error,
        }),
    };
    let _ = window.emit("dependency-install-finished", status_payload);

    install_result
}

#[tauri::command]
pub async fn install_dependencies(names: Vec<String>) -> Result<(), String> {
    crate::desktop_log!("📦 install_dependencies called: {:?}", names);
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
