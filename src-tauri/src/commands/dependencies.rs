use biovault::cli::commands::check::DependencyCheckResult;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Cache for dependency states to avoid repeated subprocess checks.
/// TTL is 30 seconds - after that, the next call will refresh.
static DEPENDENCY_CACHE: Mutex<Option<(DependencyCheckResult, Instant)>> = Mutex::new(None);
const DEPENDENCY_CACHE_TTL: Duration = Duration::from_secs(30);

#[cfg(target_os = "windows")]
fn configure_child_process(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn configure_child_process(_cmd: &mut Command) {}

pub(crate) fn dependency_names() -> Vec<&'static str> {
    let mut deps = vec!["java", "docker", "nextflow"];
    if !crate::syftbox_backend_is_embedded() {
        deps.push("syftbox");
    }
    deps.push("syqure");
    deps.push("uv");
    deps
}

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
            let raw_path = dep.path.clone().unwrap();
            let path = std::fs::canonicalize(&raw_path)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or(raw_path);
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
            for binary in dependency_names() {
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

    // Run in blocking thread pool since this calls subprocess checks (java, docker, etc.)
    tokio::task::spawn_blocking(|| {
        biovault::cli::commands::check::check_dependencies_result()
            .map_err(|e| format!("Failed to check dependencies: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
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

    // Run in blocking thread pool since this calls subprocess checks
    tokio::task::spawn_blocking(move || {
        biovault::cli::commands::check::check_single_dependency(&name, path)
            .map_err(|e| format!("Failed to check dependency: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Returns saved dependency states from disk cache.
///
/// This is a fast read-only operation that does NOT re-verify dependencies.
/// It reads from the in-memory cache or disk file without running subprocess checks.
///
/// To refresh/re-verify dependencies, call:
/// - `check_dependencies` for a full re-check
/// - `update_saved_dependency_states` to refresh and persist
#[tauri::command]
pub fn get_saved_dependency_states() -> Result<DependencyCheckResult, String> {
    // Check in-memory cache first (TTL-based)
    match DEPENDENCY_CACHE.lock() {
        Ok(cache) => {
            if let Some((ref cached_result, cached_at)) = *cache {
                if cached_at.elapsed() < DEPENDENCY_CACHE_TTL {
                    crate::desktop_log!(
                        "📋 Returning cached dependency states (age: {:?})",
                        cached_at.elapsed()
                    );
                    return Ok(cached_result.clone());
                }
            }
        }
        Err(err) => {
            crate::desktop_log!(
                "⚠️ Dependency cache lock poisoned; bypassing cache: {}",
                err
            );
        }
    }

    crate::desktop_log!("📋 Getting saved dependency states (cache miss/expired)");

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

    // Load saved states from disk without re-checking (fast path)
    if states_path.exists() {
        crate::desktop_log!("  Loading from: {}", states_path.display());
        let json_str = fs::read_to_string(&states_path)
            .map_err(|e| format!("Failed to read dependency states: {}", e))?;

        let mut saved_result: DependencyCheckResult = serde_json::from_str(&json_str)
            .map_err(|e| format!("Failed to parse dependency states: {}", e))?;

        // Fill missing paths from config (cheap operation, no subprocess calls)
        if let Ok(config) = biovault::config::Config::load() {
            for dep in &mut saved_result.dependencies {
                if dep.path.is_none() {
                    dep.path = config.get_binary_path(&dep.name);
                }
            }
        }

        // Update the in-memory cache
        match DEPENDENCY_CACHE.lock() {
            Ok(mut cache) => {
                *cache = Some((saved_result.clone(), Instant::now()));
            }
            Err(err) => {
                crate::desktop_log!(
                    "⚠️ Dependency cache lock poisoned; cache not updated: {}",
                    err
                );
            }
        }

        crate::desktop_log!(
            "  Loaded {} saved dependencies (no re-check)",
            saved_result.dependencies.len()
        );
        return Ok(saved_result);
    }

    // If no saved states, return empty result
    // The UI should call check_dependencies or update_saved_dependency_states to populate
    crate::desktop_log!("  No saved states found, returning empty result");
    Ok(DependencyCheckResult {
        dependencies: vec![],
        all_satisfied: false,
    })
}

#[tauri::command]
pub async fn check_docker_running() -> Result<bool, String> {
    // Check BIOVAULT_CONTAINER_RUNTIME env var first (e.g., "podman" on Windows).
    // If unset, try configured docker path, then "docker", then "podman".
    let mut bins: Vec<String> = Vec::new();
    let runtime_env = env::var("BIOVAULT_CONTAINER_RUNTIME").ok();
    if let Ok(runtime) = env::var("BIOVAULT_CONTAINER_RUNTIME") {
        let trimmed = runtime.trim();
        if !trimmed.is_empty() {
            bins.push(trimmed.to_string());
        }
    }
    if bins.is_empty() {
        if let Ok(cfg) = biovault::config::Config::load() {
            if let Some(path) = cfg.get_binary_path("docker") {
                if !path.trim().is_empty() {
                    bins.push(path);
                }
            }
        }
        bins.push("docker".to_string());
        bins.push("podman".to_string());
    }

    bins.dedup();
    if let Some(runtime) = runtime_env.as_deref() {
        if !runtime.trim().is_empty() {
            crate::desktop_log!(
                "Container runtime override: BIOVAULT_CONTAINER_RUNTIME={}",
                runtime
            );
        }
    }
    crate::desktop_log!("Container runtime candidates: {:?}", bins);

    // Run in spawn_blocking to avoid blocking the Tokio runtime
    let result = tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let mut last_err: Option<String> = None;
        for bin in bins {
            let mut cmd = Command::new(&bin);
            cmd.arg("info");
            cmd.stdout(Stdio::null());
            cmd.stderr(Stdio::null());
            configure_child_process(&mut cmd);

            match cmd.status() {
                Ok(status) => {
                    if status.success() {
                        crate::desktop_log!("Container runtime OK: {}", bin);
                        return Ok(true);
                    }
                    last_err = Some(format!("'{} info' returned {}", bin, status));
                    crate::desktop_log!("Container runtime not ready: {} (status {})", bin, status);
                }
                Err(e) => {
                    last_err = Some(format!("Failed to execute '{}': {}", bin, e));
                    crate::desktop_log!("Container runtime exec failed: {} ({})", bin, e);
                }
            }
        }
        if let Some(err) = last_err {
            crate::desktop_log!("Container runtime check failed: {}", err);
        }
        Ok(false)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    result
}

#[tauri::command]
pub async fn save_custom_path(name: String, path: String) -> Result<(), String> {
    crate::desktop_log!("💾 save_custom_path called: {} -> {}", name, path);

    let sanitized = if path.trim().is_empty() {
        None
    } else {
        let trimmed = path.trim().to_string();
        Some(
            std::fs::canonicalize(&trimmed)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or(trimmed),
        )
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

    // Invalidate the in-memory cache so the next get_saved_dependency_states call will refresh
    match DEPENDENCY_CACHE.lock() {
        Ok(mut cache) => {
            *cache = None;
        }
        Err(err) => {
            crate::desktop_log!(
                "⚠️ Dependency cache lock poisoned; cache not invalidated: {}",
                err
            );
        }
    }

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
            if let Some(raw_path) = maybe_path {
                let path = std::fs::canonicalize(&raw_path)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or(raw_path);
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
