use rusqlite::Connection;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{
    image::Image,
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    path::BaseDirectory,
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

// WebSocket bridge for browser development
mod ws_bridge;

// Module declarations
mod commands;
mod logging;
mod types;

// Import types from types module
use types::AppState;

// Import all command functions from command modules
use commands::datasets::*;
use commands::dependencies::*;
use commands::files::*;
use commands::jupyter::*;
use commands::key::*;
use commands::logs::*;
use commands::messages::{load_biovault_email, *};
use commands::notifications::*;
use commands::participants::*;
use commands::pipelines::*;
use commands::profiles::*;
use commands::projects::*;
use commands::runs::*;
use commands::sessions::*;
use commands::settings::*;
use commands::sql::*;
use commands::syftbox::*;

// BioVault CLI library imports
use biovault::data::BioVaultDb;
use biovault::messages::watcher::start_message_rpc_watcher;
use once_cell::sync::Lazy;

pub(crate) static PROFILE_LOCK: Lazy<Mutex<Option<commands::profiles::ProfileLock>>> =
    Lazy::new(|| Mutex::new(None));

pub(crate) fn resolve_biovault_home_path() -> PathBuf {
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

pub(crate) fn syftbox_backend_is_embedded() -> bool {
    env::var("BV_SYFTBOX_BACKEND")
        .ok()
        .map(|v| v.eq_ignore_ascii_case("embedded"))
        .unwrap_or(false)
}

pub(crate) fn init_db(_conn: &Connection) -> Result<(), rusqlite::Error> {
    // NOTE: All tables now managed by CLI via BioVaultDb (schema.sql)
    // Desktop-specific DB is deprecated - keeping for backwards compat only
    // TODO: Remove this entirely and use only BioVaultDb

    // Temporary stub - all real tables are in CLI database now
    Ok(())
}

// Scan resources directory for a bundled binary by name (java/nextflow/uv)
fn find_bundled_binary(resource_dir: &Path, name: &str) -> Option<PathBuf> {
    let mut search_roots = vec![
        resource_dir.join("bundled"),
        resource_dir.join("resources").join("bundled"),
    ];

    search_roots.sort();
    search_roots.dedup();

    for root in search_roots {
        if !root.exists() {
            continue;
        }
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            let entries = match fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n == name)
                    .unwrap_or(false)
                {
                    return Some(path);
                }
            }
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn expose_bundled_binaries(app: &tauri::App) {
    let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    crate::desktop_log!("🔍 Exposing bundled binaries for platform: {}", platform);

    let bundles = [
        (
            "BIOVAULT_BUNDLED_JAVA",
            format!("bundled/java/{}/bin/java", platform),
        ),
        (
            "BIOVAULT_BUNDLED_NEXTFLOW",
            format!("bundled/nextflow/{}/nextflow", platform),
        ),
        ("BIOVAULT_BUNDLED_UV", format!("bundled/uv/{}/uv", platform)),
    ];

    for (env_key, relative_path) in bundles {
        crate::desktop_log!(
            "🔍 Checking bundled binary: {} at {}",
            env_key,
            relative_path
        );

        // Try resolving via Tauri's resource system (works in production).
        // We look under both the legacy path ("bundled/...") and the bundle-config
        // path ("resources/bundled/...") because macOS packages include the
        // "resources/" prefix inside the .app bundle.
        let resource_path_candidates = [
            relative_path.clone(),
            format!("resources/{}", relative_path),
        ];

        let mut candidate = resource_path_candidates
            .iter()
            .find_map(|path| app.path().resolve(path, BaseDirectory::Resource).ok())
            .filter(|p| p.exists());

        // In development mode only, also try the source directory.
        // We detect dev mode by checking if we're NOT inside an .app bundle.
        #[cfg(target_os = "macos")]
        let is_production = std::env::current_exe()
            .map(|p| p.to_string_lossy().contains(".app/Contents/"))
            .unwrap_or(false);
        #[cfg(not(target_os = "macos"))]
        let is_production = false; // TODO: detect production on other platforms

        if !is_production
            && (candidate.is_none() || !candidate.as_ref().map(|p| p.exists()).unwrap_or(false))
        {
            // Try multiple possible paths for dev mode
            let possible_paths = if let Ok(cwd) = std::env::current_dir() {
                vec![
                    // If CWD is workspace root
                    cwd.join("src-tauri").join("resources").join(&relative_path),
                    // If CWD is src-tauri directory
                    cwd.join("resources").join(&relative_path),
                    // Absolute path from manifest dir (compile-time)
                    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("resources")
                        .join(&relative_path),
                    // Dev path with explicit resources/ prefix (matches bundle layout)
                    cwd.join("src-tauri")
                        .join("resources")
                        .join("resources")
                        .join(&relative_path),
                ]
            } else {
                vec![]
            };

            for path in possible_paths {
                if path.exists() {
                    crate::desktop_log!("🔍 Found in dev resources: {}", path.display());
                    candidate = Some(path);
                    break;
                }
            }
        }

        // Prefer bundled path; only fall back to pre-set env if no bundled alternative
        let mut use_path: Option<std::path::PathBuf> = candidate.filter(|p| p.exists());

        if use_path.is_none() {
            // As a last resort, scan the resources directory for the binary name
            if let Ok(resource_dir) = app.path().resolve(".", BaseDirectory::Resource) {
                let binary_name = if env_key.contains("JAVA") {
                    "java"
                } else if env_key.contains("NEXTFLOW") {
                    "nextflow"
                } else if env_key.contains("UV") {
                    "uv"
                } else {
                    ""
                };

                if let Some(found) = find_bundled_binary(&resource_dir, binary_name) {
                    use_path = Some(found);
                }
            }
        }

        if use_path.is_none() {
            // Only if no bundled option exists, honor an existing env var
            if let Ok(existing) = std::env::var(env_key) {
                let existing_path = std::path::PathBuf::from(existing.trim());
                if existing_path.exists() {
                    crate::desktop_log!(
                        "⏭️  {} using pre-set path (no bundled override found): {}",
                        env_key,
                        existing_path.display()
                    );
                    use_path = Some(existing_path);
                } else {
                    crate::desktop_log!(
                        "⚠️ {} was set to a missing path ({}); no bundled alternative found",
                        env_key,
                        existing_path.display()
                    );
                }
            }
        }

        match use_path {
            Some(path) if path.exists() => {
                let candidate_str = path.to_string_lossy().to_string();
                std::env::set_var(env_key, &candidate_str);
                crate::desktop_log!("🔧 Using bundled {}: {}", env_key, candidate_str);

                if env_key == "BIOVAULT_BUNDLED_JAVA" {
                    if let Some(parent) = path.parent() {
                        if let Some(home) = parent.parent() {
                            std::env::set_var(
                                "BIOVAULT_BUNDLED_JAVA_HOME",
                                home.to_string_lossy().to_string(),
                            );
                        }
                    }
                }
            }
            _ => {
                crate::desktop_log!(
                    "⚠️ Bundled binary not found for {}: {}",
                    env_key,
                    relative_path
                );
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn expose_bundled_binaries(app: &tauri::App) {
    let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    crate::desktop_log!("🔍 Exposing bundled binaries for platform: {}", platform);

    let bundles = [
        (
            "BIOVAULT_BUNDLED_JAVA",
            format!("bundled/java/{}/bin/java.exe", platform),
        ),
        (
            "BIOVAULT_BUNDLED_NEXTFLOW",
            format!("bundled/nextflow/{}/nextflow.exe", platform),
        ),
        (
            "BIOVAULT_BUNDLED_UV",
            format!("bundled/uv/{}/uv.exe", platform),
        ),
    ];

    for (env_key, relative_path) in bundles {
        crate::desktop_log!(
            "🔍 Checking bundled binary: {} at {}",
            env_key,
            relative_path
        );

        let resource_path_candidates = [
            relative_path.clone(),
            format!("resources/{}", relative_path),
        ];

        let mut candidate = resource_path_candidates
            .iter()
            .find_map(|path| app.path().resolve(path, BaseDirectory::Resource).ok())
            .filter(|p| p.exists());

        // Dev mode: try workspace paths when not running from installed bundle.
        // We don't have a reliable production marker like macOS .app; just try a few likely paths.
        if candidate.is_none() {
            let possible_paths = if let Ok(cwd) = std::env::current_dir() {
                vec![
                    cwd.join("src-tauri").join("resources").join(&relative_path),
                    cwd.join("resources").join(&relative_path),
                    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("resources")
                        .join(&relative_path),
                    cwd.join("src-tauri")
                        .join("resources")
                        .join("resources")
                        .join(&relative_path),
                ]
            } else {
                vec![]
            };

            for path in possible_paths {
                if path.exists() {
                    crate::desktop_log!("🔍 Found in dev resources: {}", path.display());
                    candidate = Some(path);
                    break;
                }
            }
        }

        let mut use_path: Option<std::path::PathBuf> = candidate.filter(|p| p.exists());

        if use_path.is_none() {
            // As a last resort, scan the resources directory for the binary name
            if let Ok(resource_dir) = app.path().resolve(".", BaseDirectory::Resource) {
                let binary_name = if env_key.contains("JAVA") {
                    "java.exe"
                } else if env_key.contains("NEXTFLOW") {
                    "nextflow.exe"
                } else if env_key.contains("UV") {
                    "uv.exe"
                } else {
                    ""
                };

                if let Some(found) = find_bundled_binary(&resource_dir, binary_name) {
                    use_path = Some(found);
                }
            }
        }

        if use_path.is_none() {
            // Only if no bundled option exists, honor an existing env var
            if let Ok(existing) = std::env::var(env_key) {
                let existing_path = std::path::PathBuf::from(existing.trim());
                if existing_path.exists() {
                    crate::desktop_log!(
                        "⚠️  {} using pre-set path (no bundled override found): {}",
                        env_key,
                        existing_path.display()
                    );
                    use_path = Some(existing_path);
                } else {
                    crate::desktop_log!(
                        "⚠️  {} was set to a missing path ({}); no bundled alternative found",
                        env_key,
                        existing_path.display()
                    );
                }
            }
        }

        match use_path {
            Some(path) if path.exists() => {
                let candidate_str = path.to_string_lossy().to_string();
                std::env::set_var(env_key, &candidate_str);
                crate::desktop_log!("🔧 Using bundled {}: {}", env_key, candidate_str);

                if env_key == "BIOVAULT_BUNDLED_JAVA" {
                    if let Some(parent) = path.parent() {
                        if let Some(home) = parent.parent() {
                            std::env::set_var(
                                "BIOVAULT_BUNDLED_JAVA_HOME",
                                home.to_string_lossy().to_string(),
                            );
                        }
                    }
                }
            }
            _ => {
                crate::desktop_log!(
                    "⚠️ Bundled binary not found for {}: {}",
                    env_key,
                    relative_path
                );
            }
        }
    }

    if syftbox_backend_is_embedded() {
        crate::desktop_log!("🔧 SyftBox backend is embedded; skipping bundled binary lookup");
        return;
    }

    // Expose bundled syftbox as well (used by dependency check + runtime).
    // Respect an explicitly provided SYFTBOX_BINARY (e.g. dev scripts that point to syftbox-dev.exe).
    if let Ok(existing) = std::env::var("SYFTBOX_BINARY") {
        let existing = existing.trim().to_string();
        if !existing.is_empty() {
            let existing_path = std::path::PathBuf::from(&existing);
            if existing_path.exists() {
                crate::desktop_log!("🔧 Using pre-set SYFTBOX_BINARY: {}", existing);
                return;
            }
            crate::desktop_log!(
                "⚠️  SYFTBOX_BINARY was set to a missing path ({}); falling back to bundled candidates",
                existing_path.display()
            );
        }
    }

    let syftbox_candidates = [
        "syftbox/syftbox.exe".to_string(),
        "resources/syftbox/syftbox.exe".to_string(),
    ];
    let mut syftbox_path = syftbox_candidates
        .iter()
        .find_map(|path| app.path().resolve(path, BaseDirectory::Resource).ok())
        .filter(|p| p.exists());

    if syftbox_path.is_none() {
        if let Ok(cwd) = std::env::current_dir() {
            let dev_paths = [
                cwd.join("src-tauri")
                    .join("resources")
                    .join("syftbox")
                    .join("syftbox.exe"),
                cwd.join("resources").join("syftbox").join("syftbox.exe"),
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("resources")
                    .join("syftbox")
                    .join("syftbox.exe"),
            ];
            for p in dev_paths {
                if p.exists() {
                    syftbox_path = Some(p);
                    break;
                }
            }
        }
    }

    if let Some(p) = syftbox_path.filter(|p| p.exists()) {
        let s = p.to_string_lossy().to_string();
        std::env::set_var("SYFTBOX_BINARY", &s);
        crate::desktop_log!("🔧 Using bundled SYFTBOX_BINARY: {}", s);
    }
}

fn emit_message_sync(app_handle: &tauri::AppHandle, new_message_ids: &[String]) {
    if new_message_ids.is_empty() {
        return;
    }

    let payload = serde_json::json!({
        "new_message_ids": new_message_ids,
        "new_messages": new_message_ids.len(),
    });

    if let Err(err) = app_handle.emit("messages:rpc-activity", payload) {
        crate::desktop_log!("Failed to emit messages event: {}", err);
    }
}

fn extract_profile_selector(args: &[String]) -> Option<String> {
    args.iter()
        .position(|a| a == "--profile" || a == "--profile-id")
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn maybe_write_spawn_probe(args: &[String]) -> bool {
    if env::var_os("BIOVAULT_SPAWN_PROBE_ONLY").is_none_or(|v| v.is_empty()) {
        return false;
    }
    let path = match env::var("BIOVAULT_SPAWN_PROBE_PATH") {
        Ok(value) => value.trim().to_string(),
        Err(_) => return false,
    };
    if path.is_empty() {
        return false;
    }

    let Some(profile_id) = extract_profile_selector(args) else {
        return false;
    };

    let home = env::var("BIOVAULT_HOME").unwrap_or_default();
    let payload = serde_json::json!({
        "profile_id": profile_id,
        "home": home,
        "pid": std::process::id(),
        "args": args,
    });

    let path_buf = PathBuf::from(path);
    if let Some(parent) = path_buf.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            eprintln!("Failed to create spawn probe dir: {}", err);
            return false;
        }
    }

    let body = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string());
    if let Err(err) = fs::write(&path_buf, body) {
        eprintln!("Failed to write spawn probe: {}", err);
        return false;
    }

    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();

    if std::env::var("BV_SYFTBOX_BACKEND").is_err() {
        let default_backend = option_env!("BV_SYFTBOX_DEFAULT_BACKEND").unwrap_or("embedded");
        std::env::set_var("BV_SYFTBOX_BACKEND", default_backend);
    }

    fn resolve_home_ignoring_syftbox_env() -> Option<PathBuf> {
        let saved_data_dir = std::env::var_os("SYFTBOX_DATA_DIR");
        let saved_email = std::env::var_os("SYFTBOX_EMAIL");

        if saved_data_dir.is_some() {
            std::env::remove_var("SYFTBOX_DATA_DIR");
        }
        if saved_email.is_some() {
            std::env::remove_var("SYFTBOX_EMAIL");
        }

        let resolved = biovault::config::get_biovault_home().ok();

        if let Some(v) = saved_data_dir {
            std::env::set_var("SYFTBOX_DATA_DIR", v);
        }
        if let Some(v) = saved_email {
            std::env::set_var("SYFTBOX_EMAIL", v);
        }

        resolved
    }

    // Profiles bootstrap:
    // - If `--profile/--profile-id` is provided, select that profile's BIOVAULT_HOME.
    // - If multiple profiles exist, enter picker mode and let the UI prompt.
    // - Otherwise, select the current profile home (if present) or fall back to legacy resolution.
    let _ = apply_profile_selection_from_args(&args);
    if maybe_write_spawn_probe(&args) {
        return;
    }
    let _ = apply_current_profile_if_ready(&args);
    let _ = maybe_enter_bootstrap_mode(&args);

    // In profile picker mode, avoid selecting a BIOVAULT_HOME until the user chooses a profile.
    let mut profile_picker_mode = std::env::var_os("BIOVAULT_PROFILE_PICKER").is_some();

    // Allow explicit config override for dev/debug.
    if !profile_picker_mode && std::env::var_os("BIOVAULT_HOME").is_none() {
        if let Some(path) = args
            .iter()
            .position(|arg| arg == "--biovault-config")
            .and_then(|i| args.get(i + 1))
        {
            std::env::set_var("BIOVAULT_HOME", path);
        }
    }

    // Ensure BIOVAULT_HOME is always set for downstream processes and legacy code paths.
    if !profile_picker_mode && std::env::var_os("BIOVAULT_HOME").is_none() {
        if let Some(home) = resolve_home_ignoring_syftbox_env() {
            std::env::set_var("BIOVAULT_HOME", &home);
        } else if let Some(home_dir) = dirs::home_dir() {
            let desktop_dir = dirs::desktop_dir().unwrap_or_else(|| home_dir.join("Desktop"));
            std::env::set_var("BIOVAULT_HOME", desktop_dir.join("BioVault"));
        }
    }

    // Acquire per-profile lock (no-op in picker mode). If lock conflicts, drop back into picker mode.
    if !profile_picker_mode {
        if let Ok(Some(lock)) = acquire_selected_profile_lock(&args) {
            if let Ok(mut guard) = PROFILE_LOCK.lock() {
                *guard = Some(lock);
            }
        }
        if std::env::var_os("BIOVAULT_PROFILE_PICKER").is_some() {
            profile_picker_mode = true;
        }
    }

    // Ensure SYC_VAULT matches the selected BIOVAULT_HOME (profile-isolated by default).
    if !profile_picker_mode {
        let _ = ensure_profile_syc_vault_env();
        let _ = biovault::config::ensure_syc_vault_env();
    }

    let desktop_log_path_buf = logging::desktop_log_path();
    std::env::set_var(
        "BIOVAULT_DESKTOP_LOG_FILE",
        desktop_log_path_buf.to_string_lossy().to_string(),
    );

    logging::init_stdio_forwarding();

    let biovault_db = if profile_picker_mode {
        BioVaultDb {
            conn: Connection::open_in_memory().expect("Could not open in-memory BioVault database"),
        }
    } else {
        // Initialize shared BioVaultDb (handles files/participants)
        // This automatically creates the directory via get_biovault_home() if needed
        BioVaultDb::new().expect("Failed to initialize BioVault database")
    };

    // Get the actual biovault_home_dir that was used (for window title / DB paths).
    let (biovault_home_dir, home_display) = if profile_picker_mode {
        (PathBuf::from(""), "profile picker".to_string())
    } else {
        let biovault_home_dir =
            biovault::config::get_biovault_home().expect("Failed to get BioVault home directory");
        let home_display = biovault_home_dir.to_string_lossy().to_string();
        crate::desktop_log!("📂 BioVault home resolved to {}", home_display);
        (biovault_home_dir, home_display)
    };
    crate::desktop_log!(
        "Desktop logging initialised. Log file: {}",
        desktop_log_path_buf.display()
    );

    let email = if profile_picker_mode {
        "Select Profile".to_string()
    } else {
        load_biovault_email(&Some(biovault_home_dir.clone()))
    };

    // Build window title - include debug info if BIOVAULT_DEBUG_BANNER is set
    let window_title = if std::env::var("BIOVAULT_DEBUG_BANNER")
        .map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
    {
        format!("BioVault - {} [{}]", email, home_display)
    } else {
        format!("BioVault - {}", email)
    };

    let (conn, queue_processor_paused) = if profile_picker_mode {
        (
            Connection::open_in_memory().expect("Could not open in-memory desktop database"),
            Arc::new(AtomicBool::new(true)),
        )
    } else {
        // Desktop DB for runs/projects (keep separate for now)
        let db_path = biovault_home_dir.join("biovault.db");
        crate::desktop_log!("🗃️ BioVault DB path: {}", db_path.display());
        let conn = Connection::open(&db_path).expect("Could not open database");
        init_db(&conn).expect("Could not initialize database");
        (conn, Arc::new(AtomicBool::new(false))) // Start running
    };

    let app_state = AppState {
        db: Mutex::new(conn),
        biovault_db: Arc::new(Mutex::new(biovault_db)),
        queue_processor_paused: queue_processor_paused.clone(),
        message_watcher: Mutex::new(None),
    };

    // Spawn background queue processor (using library)
    if !profile_picker_mode {
        let paused_flag = queue_processor_paused.clone();
        let biovault_db_for_processor = app_state.biovault_db.clone();

        std::thread::spawn(move || {
            loop {
                // Check if paused
                if !paused_flag.load(Ordering::SeqCst) {
                    // Get pending files - lock only briefly
                    let pending_files = {
                        match biovault_db_for_processor.lock() {
                            Ok(db) => biovault::data::get_pending_files(&db, 10).ok(),
                            Err(_) => None,
                        }
                        // Lock is released here automatically
                    };

                    if let Some(files) = pending_files {
                        if !files.is_empty() {
                            let mut processed = 0;
                            let mut errors = 0;

                            for file in &files {
                                // Lock briefly to mark as processing
                                // Also check if file still exists (might have been deleted by clear queue)
                                let marked = {
                                    match biovault_db_for_processor.lock() {
                                        Ok(db) => {
                                            // Check if file still exists first
                                            let file_exists: Result<bool, _> = db.connection().query_row(
                                            "SELECT COUNT(*) FROM files WHERE id = ?1 AND status = 'pending'",
                                            [file.id],
                                            |row| Ok(row.get::<_, i64>(0)? > 0),
                                        );

                                            if let Ok(true) = file_exists {
                                                biovault::data::update_file_status(
                                                    &db,
                                                    file.id,
                                                    "processing",
                                                    None,
                                                )
                                                .is_ok()
                                            } else {
                                                false // File doesn't exist or not pending anymore
                                            }
                                        }
                                        Err(_) => false,
                                    }
                                };

                                if !marked {
                                    continue;
                                }

                                // Check pause flag before starting expensive operations
                                if paused_flag.load(Ordering::SeqCst) {
                                    // Paused - reset this file back to pending and break
                                    if let Ok(db) = biovault_db_for_processor.lock() {
                                        let _ = biovault::data::update_file_status(
                                            &db, file.id, "pending", None,
                                        );
                                    }
                                    break; // Break out of file processing loop
                                }

                                // Process file WITHOUT holding lock (expensive I/O operations)
                                let hash_result = biovault::data::hash_file(&file.file_path);

                                // Check pause flag again after hashing
                                if paused_flag.load(Ordering::SeqCst) {
                                    // Paused during processing - reset back to pending
                                    if let Ok(db) = biovault_db_for_processor.lock() {
                                        let _ = biovault::data::update_file_status(
                                            &db, file.id, "pending", None,
                                        );
                                    }
                                    break;
                                }

                                match hash_result {
                                    Ok(hash) => {
                                        // Check pause flag before metadata operations
                                        if paused_flag.load(Ordering::SeqCst) {
                                            if let Ok(db) = biovault_db_for_processor.lock() {
                                                let _ = biovault::data::update_file_status(
                                                    &db, file.id, "pending", None,
                                                );
                                            }
                                            break;
                                        }

                                        // Detect and analyze file WITHOUT holding lock
                                        let metadata = if file.data_type.as_deref()
                                            == Some("Unknown")
                                            || file.data_type.is_none()
                                        {
                                            // Detect file type first
                                            if let Ok(detected) =
                                                biovault::data::detect_genotype_metadata(
                                                    &file.file_path,
                                                )
                                            {
                                                if detected.data_type == "Genotype" {
                                                    // Check pause flag before expensive analysis
                                                    if paused_flag.load(Ordering::SeqCst) {
                                                        if let Ok(db) =
                                                            biovault_db_for_processor.lock()
                                                        {
                                                            let _ =
                                                                biovault::data::update_file_status(
                                                                    &db, file.id, "pending", None,
                                                                );
                                                        }
                                                        break;
                                                    }
                                                    // It's a genotype - analyze it fully
                                                    biovault::data::analyze_genotype_file(
                                                        &file.file_path,
                                                    )
                                                    .ok()
                                                } else {
                                                    Some(detected)
                                                }
                                            } else {
                                                None
                                            }
                                        } else if file.data_type.as_deref() == Some("Genotype") {
                                            // Check pause flag before expensive analysis
                                            if paused_flag.load(Ordering::SeqCst) {
                                                if let Ok(db) = biovault_db_for_processor.lock() {
                                                    let _ = biovault::data::update_file_status(
                                                        &db, file.id, "pending", None,
                                                    );
                                                }
                                                break;
                                            }
                                            // Already known to be genotype - analyze it
                                            biovault::data::analyze_genotype_file(&file.file_path)
                                                .ok()
                                        } else {
                                            None
                                        };

                                        // Final pause check before updating database
                                        if paused_flag.load(Ordering::SeqCst) {
                                            if let Ok(db) = biovault_db_for_processor.lock() {
                                                let _ = biovault::data::update_file_status(
                                                    &db, file.id, "pending", None,
                                                );
                                            }
                                            break;
                                        }

                                        // Lock briefly to update DB with results
                                        // First check if file still exists (might have been deleted by clear queue)
                                        match biovault_db_for_processor.lock() {
                                            Ok(db) => {
                                                // Check if file still exists before updating
                                                let file_exists: Result<bool, _> =
                                                    db.connection().query_row(
                                                        "SELECT COUNT(*) FROM files WHERE id = ?1",
                                                        [file.id],
                                                        |row| Ok(row.get::<_, i64>(0)? > 0),
                                                    );

                                                if let Ok(true) = file_exists {
                                                    if biovault::data::update_file_from_queue(
                                                        &db,
                                                        file.id,
                                                        &hash,
                                                        metadata.as_ref(),
                                                    )
                                                    .is_ok()
                                                    {
                                                        let _ = biovault::data::update_file_status(
                                                            &db, file.id, "complete", None,
                                                        );
                                                        processed += 1;
                                                    }
                                                }
                                                // If file doesn't exist anymore, it was deleted (e.g., by clear queue)
                                                // Just skip it - no error needed
                                            }
                                            Err(_) => continue,
                                        }
                                    }
                                    Err(e) => {
                                        // Lock briefly to mark error
                                        // First check if file still exists (might have been deleted by clear queue)
                                        let error_msg = format!("{}", e);
                                        if let Ok(db) = biovault_db_for_processor.lock() {
                                            // Check if file still exists before updating
                                            let file_exists: Result<bool, _> =
                                                db.connection().query_row(
                                                    "SELECT COUNT(*) FROM files WHERE id = ?1",
                                                    [file.id],
                                                    |row| Ok(row.get::<_, i64>(0)? > 0),
                                                );

                                            if let Ok(true) = file_exists {
                                                let _ = biovault::data::update_file_status(
                                                    &db,
                                                    file.id,
                                                    "error",
                                                    Some(&error_msg),
                                                );
                                                errors += 1;
                                            }
                                            // If file doesn't exist anymore, it was deleted (e.g., by clear queue)
                                            // Just skip it - no error needed
                                        }
                                    }
                                }
                            }

                            // Only log if files were actually processed
                            if processed > 0 {
                                crate::desktop_log!(
                                    "✅ Queue processor: processed {} files ({} errors)",
                                    processed,
                                    errors
                                );
                            }
                        }
                    }
                }

                // Wait 2 seconds before next check
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        });
    }

    crate::desktop_log!("Setup: building Tauri app");
    let mut builder = tauri::Builder::default();

    // Only add updater plugin if not disabled (for testing)
    if std::env::var("DISABLE_UPDATER").is_err() {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    let app = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_deep_link::init())
        .manage(app_state)
        .setup(move |app| {
            crate::desktop_log!("Setup: entered Tauri setup");
            if std::env::var("BV_WS_BRIDGE_PROBE").is_ok() {
                let probe_path = std::env::var("BIOVAULT_HOME")
                    .map(|home| format!("{}/logs/setup-probe.txt", home))
                    .unwrap_or_else(|_| "logs/setup-probe.txt".to_string());
                let _ = std::fs::create_dir_all(
                    std::path::Path::new(&probe_path)
                        .parent()
                        .unwrap_or_else(|| std::path::Path::new(".")),
                );
                let _ = std::fs::write(&probe_path, "setup");
            }
            // Surface bundled binaries (java/nextflow/uv) to the environment so dependency
            // checks and runtime execution prefer the packaged versions.
            expose_bundled_binaries(app);
            crate::desktop_log!("Setup: bundled binaries exposed");

            // Ensure bundled SyftBox binary is exposed if not already provided
            if !syftbox_backend_is_embedded() && std::env::var("SYFTBOX_BINARY").is_err() {
                // Try both legacy and nested resource paths, then fall back to a scan
                let mut syftbox_candidates: Vec<PathBuf> = Vec::new();
                if let Ok(p) = app
                    .path()
                    .resolve("syftbox/syftbox", BaseDirectory::Resource)
                {
                    syftbox_candidates.push(p);
                }
                if let Ok(p) = app
                    .path()
                    .resolve("resources/syftbox/syftbox", BaseDirectory::Resource)
                {
                    syftbox_candidates.push(p);
                }

                let mut found_syftbox: Option<PathBuf> =
                    syftbox_candidates.iter().find(|p| p.exists()).cloned();

                if found_syftbox.is_none() {
                    if let Ok(resource_dir) = app.path().resolve(".", BaseDirectory::Resource) {
                        if let Some(found) = find_bundled_binary(&resource_dir, "syftbox") {
                            found_syftbox = Some(found);
                        }
                    }
                }

                match found_syftbox {
                    Some(candidate) if candidate.exists() => {
                        let candidate_str = candidate.to_string_lossy().to_string();
                        std::env::set_var("SYFTBOX_BINARY", &candidate_str);
                        crate::desktop_log!("🔧 Using bundled SyftBox binary: {}", candidate_str);
                    }
                    _ => {
                        crate::desktop_log!("⚠️ Bundled SyftBox binary not found in resources");
                    }
                }
            }

            #[cfg(target_os = "macos")]
            {
                biovault::cli::commands::check::set_homebrew_install_logger(|message| {
                    crate::desktop_log!("{}", message);
                });
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&window_title);

                // Handle window close event - minimize to tray instead of quitting
                let window_clone = window.clone();
                let app_handle = app.handle().clone();
                let exit_on_close = profile_picker_mode
                    || std::env::var("BIOVAULT_EXIT_ON_CLOSE")
                        .map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
                        .unwrap_or(false);
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if exit_on_close {
                            app_handle.exit(0);
                        } else {
                            api.prevent_close();
                            let _ = window_clone.hide();
                        }
                    }
                });
            }

            // Create system tray menu
            let show = MenuItemBuilder::with_id("show", "Show").build(app)?;

            // Check current autostart status
            use tauri_plugin_autostart::ManagerExt;
            let autolaunch = app.autolaunch();
            let is_enabled = autolaunch.is_enabled().unwrap_or(false);

            let autostart_item = CheckMenuItemBuilder::with_id("autostart", "Start on Startup")
                .checked(is_enabled)
                .build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

            let devtools = MenuItemBuilder::with_id("devtools", "Open DevTools").build(app)?;

            let menu = MenuBuilder::new(app)
                .items(&[&show, &devtools, &autostart_item, &quit])
                .build()?;

            // Clone the autostart item for use in the event handler
            let autostart_item_clone = autostart_item.clone();

            // Load tray icon from embedded PNG
            let icon_bytes = include_bytes!("../icons/icon.png");
            let img = image::load_from_memory(icon_bytes)
                .map_err(|e| format!("Failed to decode tray icon: {}", e))?;
            let rgba = img.to_rgba8();
            let (width, height) = rgba.dimensions();
            let icon = Image::new_owned(rgba.into_raw(), width, height);

            // Create tray icon
            let _tray = TrayIconBuilder::with_id("main")
                .icon(icon)
                .menu(&menu)
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "devtools" => {
                            if let Some(window) = app.get_webview_window("main") {
                                crate::desktop_log!("Opening developer tools from tray menu");
                                window.open_devtools();
                                let _ = window.set_focus();
                            }
                        }
                        "autostart" => {
                            use tauri_plugin_autostart::ManagerExt;
                            let autolaunch = app.autolaunch();
                            match autolaunch.is_enabled() {
                                Ok(enabled) => {
                                    let result = if enabled {
                                        autolaunch.disable()
                                    } else {
                                        autolaunch.enable()
                                    };
                                    if let Err(e) = result {
                                        crate::desktop_log!("Failed to toggle autostart: {}", e);
                                    } else {
                                        // Update the menu item checkbox
                                        let _ = autostart_item_clone.set_checked(!enabled);
                                    }
                                    // Emit event to update UI
                                    let _ = app.emit("autostart-changed", ());
                                }
                                Err(e) => {
                                    crate::desktop_log!("Failed to check autostart status: {}", e)
                                }
                            }
                        }
                        "quit" => {
                            // Attempt to stop SyftBox before exiting
                            if let Err(e) = crate::stop_syftbox_client() {
                                crate::desktop_log!("⚠️ Failed to stop SyftBox on quit: {}", e);
                            }
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Start watching the SyftBox RPC message endpoint for real-time updates (shared implementation in biovault crate)
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let config = biovault::config::Config::load();
                if let Ok(cfg) = config {
                    let emit_handle = app_handle.clone();
                    match start_message_rpc_watcher(cfg, move |ids| {
                        emit_message_sync(&emit_handle, ids);
                    }) {
                        Ok(handle) => {
                            if let Ok(mut slot) =
                                app_handle.state::<AppState>().message_watcher.lock()
                            {
                                *slot = Some(handle);
                            }
                        }
                        Err(err) => {
                            crate::desktop_log!("Message watcher failed to start: {}", err);
                        }
                    }
                } else if let Err(err) = config {
                    crate::desktop_log!("Message watcher: failed to load config: {}", err);
                }
            });

            // Handle deep link URLs (biovault://...)
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();

                // Check if app was opened via deep link
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        crate::desktop_log!("🔗 App opened with deep link: {}", url);
                        let _ = handle.emit("deep-link", url.to_string());
                    }
                }

                // Listen for deep links while app is running
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        crate::desktop_log!("🔗 Deep link received: {}", url);
                        let _ = handle.emit("deep-link", url.to_string());
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Files commands
            search_txt_files,
            suggest_patterns,
            extract_ids_for_files,
            get_extensions,
            is_directory,
            import_files,
            import_files_with_metadata,
            import_files_pending,
            process_queue,
            pause_queue_processor,
            resume_queue_processor,
            get_queue_processor_status,
            get_queue_info,
            clear_pending_queue,
            get_files,
            delete_file,
            delete_files_bulk,
            detect_file_types,
            analyze_file_types,
            // Dataset commands
            list_datasets_with_assets,
            upsert_dataset_manifest,
            delete_dataset,
            publish_dataset,
            unpublish_dataset,
            save_dataset_with_files,
            is_dataset_published,
            get_datasets_folder_path,
            resolve_syft_url_to_local_path,
            resolve_syft_urls_batch,
            network_scan_datasets,
            // Participants commands
            get_participants,
            delete_participant,
            delete_participants_bulk,
            // Messages commands
            list_message_threads,
            get_thread_messages,
            send_message,
            sync_messages,
            mark_thread_as_read,
            delete_thread,
            delete_message,
            // Failed messages commands
            list_failed_messages,
            count_failed_messages,
            dismiss_failed_message,
            delete_failed_message,
            sync_messages_with_failures,
            send_pipeline_request,
            send_pipeline_request_results,
            list_results_tree,
            import_pipeline_results,
            send_pipeline_results,
            // Projects commands
            import_project,
            import_project_from_folder,
            import_pipeline_with_deps,
            import_pipeline_from_request,
            get_projects,
            delete_project,
            delete_project_folder,
            create_project,
            get_available_project_examples,
            get_default_project_path,
            load_project_editor,
            save_project_editor,
            preview_project_spec,
            get_project_spec_digest,
            get_supported_input_types,
            get_supported_output_types,
            get_supported_parameter_types,
            get_common_formats,
            // Jupyter commands
            launch_jupyter,
            stop_jupyter,
            get_jupyter_status,
            reset_jupyter,
            // Runs commands
            start_analysis,
            execute_analysis,
            get_runs,
            get_run_logs,
            get_run_logs_tail,
            get_run_logs_full,
            delete_run,
            // Pipeline commands
            get_pipelines,
            get_runs_base_dir,
            create_pipeline,
            load_pipeline_editor,
            save_pipeline_editor,
            delete_pipeline,
            validate_pipeline,
            save_run_config,
            list_run_configs,
            get_run_config,
            delete_run_config,
            run_pipeline,
            get_pipeline_runs,
            delete_pipeline_run,
            preview_pipeline_spec,
            import_pipeline_from_message,
            // SQL commands
            sql_list_tables,
            sql_get_table_schema,
            sql_run_query,
            sql_export_query,
            // Settings commands
            get_settings,
            save_settings,
            get_app_version,
            open_folder,
            save_file_bytes,
            open_in_vscode,
            show_in_folder,
            get_config_path,
            get_database_path,
            check_is_onboarded,
            complete_onboarding,
            reset_all_data,
            reset_everything,
            get_autostart_enabled,
            set_autostart_enabled,
            // Profiles
            profiles_get_boot_state,
            profiles_get_default_home,
            profiles_open_new_instance,
            profiles_switch,
            profiles_switch_in_place,
            profiles_create_and_switch_in_place,
            profiles_open_picker,
            profiles_quit_picker,
            profiles_check_home_for_existing_email,
            profiles_create_with_home_and_switch,
            profiles_move_home,
            profiles_delete_profile,
            profiles_create_and_switch,
            // Key management
            key_check_vault_debug,
            key_get_status,
            key_generate,
            key_restore,
            key_republish,
            key_list_contacts,
            key_check_contact,
            key_refresh_contacts,
            // Network commands
            network_scan_datasites,
            network_import_contact,
            network_remove_contact,
            network_trust_changed_key,
            // Dev mode commands
            is_dev_mode,
            is_updater_disabled,
            is_dev_syftbox_enabled,
            get_dev_syftbox_server_url,
            check_dev_syftbox_server,
            get_dev_mode_info,
            // Logs commands
            get_command_logs,
            clear_command_logs,
            log_frontend_message,
            get_desktop_log_text,
            clear_desktop_log,
            get_desktop_log_dir,
            // Dependencies commands
            check_dependencies,
            check_single_dependency,
            get_saved_dependency_states,
            save_custom_path,
            update_saved_dependency_states,
            check_brew_installed,
            install_brew,
            check_command_line_tools_installed,
            install_dependency,
            install_dependencies,
            check_docker_running,
            // SyftBox commands
            open_url,
            syftbox_request_otp,
            syftbox_submit_otp,
            set_syftbox_dev_server,
            get_env_var,
            get_default_syftbox_server_url,
            check_syftbox_auth,
            get_syftbox_config_info,
            get_syftbox_state,
            start_syftbox_client,
            stop_syftbox_client,
            get_syftbox_diagnostics,
            syftbox_queue_status,
            syftbox_upload_action,
            trigger_syftbox_sync,
            open_path_in_file_manager,
            test_notification,
            test_notification_applescript,
            // Sessions commands
            get_sessions,
            list_sessions,
            get_session,
            create_session,
            create_session_with_datasets,
            update_session_peer,
            delete_session,
            launch_session_jupyter,
            stop_session_jupyter,
            reset_session_jupyter,
            get_session_jupyter_status,
            get_session_messages,
            send_session_message,
            get_session_chat_messages,
            get_session_beaver_summaries,
            send_session_chat_message,
            open_session_folder,
            get_session_invitations,
            accept_session_invitation,
            reject_session_invitation,
            // Session dataset commands
            add_dataset_to_session,
            remove_dataset_from_session,
            list_session_datasets,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    crate::desktop_log!("Setup: Tauri app built");

    fn best_effort_stop_syftbox_for_exit() {
        let _ = crate::stop_syftbox_client();

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let mut cmd = std::process::Command::new("taskkill");
            cmd.args(["/IM", "syftbox.exe", "/T", "/F"]);
            cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = cmd.status();
        }
    }

    fn best_effort_stop_all_jupyter_for_exit() {
        let db = match biovault::data::BioVaultDb::new() {
            Ok(db) => db,
            Err(err) => {
                crate::desktop_log!(
                    "⚠️ Exit: Failed to open BioVault DB to stop Jupyter: {}",
                    err
                );
                return;
            }
        };

        let envs = match db.list_dev_envs() {
            Ok(envs) => envs,
            Err(err) => {
                crate::desktop_log!("⚠️ Exit: Failed to list dev envs to stop Jupyter: {}", err);
                return;
            }
        };

        for env in envs {
            if env.jupyter_pid.is_none() && env.jupyter_port.is_none() {
                continue;
            }
            let project_path = env.project_path.clone();
            crate::desktop_log!("Exit: Stopping Jupyter for project: {}", project_path);
            if let Err(err) = tauri::async_runtime::block_on(
                biovault::cli::commands::jupyter::stop(&project_path),
            ) {
                crate::desktop_log!(
                    "⚠️ Exit: Failed to stop Jupyter for {}: {}",
                    project_path,
                    err
                );
            }
        }
    }

    fn maybe_start_ws_bridge(app_handle: AppHandle) {
        let ws_bridge_enabled = std::env::var("DEV_WS_BRIDGE")
            .map(|v| !matches!(v.as_str(), "0" | "false" | "no"))
            .unwrap_or(true);
        let ws_bridge_disabled = std::env::var("DEV_WS_BRIDGE_DISABLE")
            .map(|v| matches!(v.as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);
        let bridge_port = std::env::var("DEV_WS_BRIDGE_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(3333);

        crate::desktop_log!(
            "WS bridge: enabled={} disabled={} port={}",
            ws_bridge_enabled,
            ws_bridge_disabled,
            bridge_port
        );

        if !ws_bridge_enabled || ws_bridge_disabled {
            crate::desktop_log!("WS bridge disabled by environment");
            return;
        }

        tauri::async_runtime::spawn(async move {
            if let Err(e) = ws_bridge::start_ws_server(app_handle, bridge_port).await {
                crate::desktop_log!("Failed to start WebSocket server: {}", e);
            }
        });
    }

    let mut exit_cleanup_started = false;
    maybe_start_ws_bridge(app.handle().clone());
    crate::desktop_log!("Run: entering app.run");
    app.run(move |app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if exit_cleanup_started {
                return;
            }
            exit_cleanup_started = true;
            api.prevent_exit();

            let app_handle = app_handle.clone();
            std::thread::spawn(move || {
                crate::desktop_log!("Exit: stopping background processes...");
                best_effort_stop_syftbox_for_exit();
                best_effort_stop_all_jupyter_for_exit();
                crate::desktop_log!("Exit: background processes stopped; exiting.");
                app_handle.exit(0);
            });
        }
    });
}
