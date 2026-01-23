use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};
use walkdir::WalkDir;

use crate::logging::LogLevel;
use tauri::Manager;

const STORE_VERSION: u32 = 1;
const STORE_DIR_NAME: &str = ".bvprofiles";
const STORE_FILE_NAME: &str = "profiles.json";
const PROFILE_LOCK_FILE: &str = ".bvprofile.lock";

fn env_flag_true(key: &str) -> bool {
    env::var(key)
        .map(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

pub fn profiles_enabled() -> bool {
    if env_flag_true("BIOVAULT_DISABLE_PROFILES") {
        return false;
    }
    if env::var_os("BIOVAULT_TEST_HOME").is_some() {
        return false;
    }
    true
}

fn profiles_store_path() -> Result<PathBuf, String> {
    if let Ok(path) = env::var("BIOVAULT_PROFILES_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    if let Ok(dir) = env::var("BIOVAULT_PROFILES_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return Ok(expand_tilde(trimmed).join(STORE_FILE_NAME));
        }
    }
    let home = dirs::home_dir().ok_or("Could not determine home directory".to_string())?;
    Ok(home.join(STORE_DIR_NAME).join(STORE_FILE_NAME))
}

fn expand_tilde(path: &str) -> PathBuf {
    if let Some(stripped) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    } else if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    PathBuf::from(path)
}

fn normalize_home_input(path: &str) -> PathBuf {
    let expanded = expand_tilde(path);
    if expanded.is_absolute() {
        return expanded;
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(expanded)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ProfileStore {
    version: u32,
    current_profile_id: Option<String>,
    profiles: Vec<ProfileEntry>,
    #[serde(default)]
    force_picker_once: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProfileEntry {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    biovault_home: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_used_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cached_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProfileSummary {
    pub id: String,
    pub email: Option<String>,
    pub biovault_home: String,
    pub vault_path: String,
    pub fingerprint: Option<String>,
    pub onboarded: bool,
    pub running: bool,
    pub is_current: bool,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProfilesBootState {
    pub enabled: bool,
    pub should_show_picker: bool,
    pub current_profile_id: Option<String>,
    pub profiles: Vec<ProfileSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup_message: Option<String>,
    pub opened_from_app: bool,
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

fn normalize_email(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

fn resolve_legacy_home_without_syftbox_env() -> Result<PathBuf, String> {
    // Desktop app should not accidentally adopt a transient SYFTBOX_DATA_DIR/.biovault as its default home.
    // Temporarily ignore SyftBox env vars while resolving the legacy home.
    let saved_data_dir: Option<OsString> = env::var_os("SYFTBOX_DATA_DIR");
    let saved_email: Option<OsString> = env::var_os("SYFTBOX_EMAIL");

    if saved_data_dir.is_some() {
        env::remove_var("SYFTBOX_DATA_DIR");
    }
    if saved_email.is_some() {
        env::remove_var("SYFTBOX_EMAIL");
    }

    let result = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to resolve BioVault home: {}", e));

    if let Some(v) = saved_data_dir {
        env::set_var("SYFTBOX_DATA_DIR", v);
    }
    if let Some(v) = saved_email {
        env::set_var("SYFTBOX_EMAIL", v);
    }

    result
}

pub fn email_in_use_by_other_profile(email: &str, current_home: &Path) -> Result<bool, String> {
    if !profiles_enabled() {
        return Ok(false);
    }
    let store = ensure_legacy_profile_migrated(load_store()?)?;
    let email_norm = normalize_email(email);
    if email_norm.is_empty() {
        return Ok(false);
    }
    let current_home_str = current_home.to_string_lossy().to_string();
    Ok(store.profiles.iter().any(|p| {
        p.email
            .as_deref()
            .map(normalize_email)
            .is_some_and(|e| e == email_norm)
            && p.biovault_home != current_home_str
    }))
}

fn is_onboarded_home(home: &Path) -> bool {
    let cfg = home.join("config.yaml");
    if !cfg.exists() {
        return false;
    }
    let content = match fs::read_to_string(cfg) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let yaml: serde_yaml::Value = match serde_yaml::from_str(&content) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let email = yaml
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    !email.is_empty() && email != "setup@pending"
}

fn read_home_email(home: &Path) -> Option<String> {
    let cfg = home.join("config.yaml");
    let content = fs::read_to_string(cfg).ok()?;
    let yaml: serde_yaml::Value = serde_yaml::from_str(&content).ok()?;
    let email = yaml.get("email").and_then(|v| v.as_str())?.trim();
    if email.is_empty() || email == "setup@pending" {
        None
    } else {
        Some(email.to_string())
    }
}

fn load_store() -> Result<ProfileStore, String> {
    let path = profiles_store_path()?;
    if !path.exists() {
        return Ok(ProfileStore {
            version: STORE_VERSION,
            ..Default::default()
        });
    }
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read profiles store: {}", e))?;
    let mut store: ProfileStore = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Failed to parse profiles store: {}", e))?;
    if store.version == 0 {
        store.version = STORE_VERSION;
    }
    Ok(store)
}

fn save_store(store: &ProfileStore) -> Result<(), String> {
    let path = profiles_store_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create profiles store dir: {}", e))?;
    }
    let json = serde_json::to_vec_pretty(store)
        .map_err(|e| format!("Failed to serialize profiles store: {}", e))?;
    let parent = path
        .parent()
        .ok_or("Invalid profiles store path".to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("Failed to create temp profiles store: {}", e))?;
    use std::io::Write;
    tmp.write_all(&json)
        .map_err(|e| format!("Failed to write temp profiles store: {}", e))?;
    tmp.flush()
        .map_err(|e| format!("Failed to flush temp profiles store: {}", e))?;
    tmp.persist(&path)
        .map_err(|e| format!("Failed to persist profiles store: {}", e))?;
    Ok(())
}

fn profile_lock_path(home: &Path) -> PathBuf {
    home.join(PROFILE_LOCK_FILE)
}

pub struct ProfileLock {
    _file: fs::File,
    _path: PathBuf,
}

#[cfg(unix)]
fn try_lock_file_exclusive(file: &fs::File) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    let fd = file.as_raw_fd();
    let res = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
    if res == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(not(unix))]
fn try_lock_file_exclusive(_file: &fs::File) -> Result<(), String> {
    Ok(())
}

fn try_acquire_profile_lock(home: &Path, create_home: bool) -> Result<ProfileLock, String> {
    if create_home {
        fs::create_dir_all(home).map_err(|e| format!("Failed to create profile home: {}", e))?;
    } else if !home.exists() {
        return Err("Profile home does not exist".to_string());
    }
    let lock_path = profile_lock_path(home);
    let file = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|e| format!("Failed to open profile lock file: {}", e))?;
    try_lock_file_exclusive(&file).map_err(|_| "Profile already running".to_string())?;
    Ok(ProfileLock {
        _file: file,
        _path: lock_path,
    })
}

fn resolve_vault_path_for_home(home: &Path) -> String {
    let colocated = syftbox_sdk::syftbox::syc::vault_path_for_home(home);
    colocated.to_string_lossy().to_string()
}

fn summarize_profile(entry: &ProfileEntry, current: Option<&str>) -> ProfileSummary {
    let home = PathBuf::from(&entry.biovault_home);
    let email = entry
        .email
        .clone()
        .or_else(|| read_home_email(&home))
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty());
    let fingerprint = entry.cached_fingerprint.clone();
    let vault_path = resolve_vault_path_for_home(&home);
    let onboarded = is_onboarded_home(&home);
    let is_current = current.is_some_and(|c| c == entry.id);
    let running = if is_current {
        true
    } else if home.exists() {
        match try_acquire_profile_lock(&home, false) {
            Ok(_lock) => false,
            Err(_) => true,
        }
    } else {
        false
    };
    ProfileSummary {
        id: entry.id.clone(),
        email,
        biovault_home: entry.biovault_home.clone(),
        vault_path,
        fingerprint,
        onboarded,
        running,
        is_current,
        last_used_at: entry.last_used_at.clone(),
    }
}

fn find_profile_by_id_or_email(store: &ProfileStore, selector: &str) -> Option<ProfileEntry> {
    let by_id = store.profiles.iter().find(|p| p.id == selector);
    if let Some(p) = by_id {
        return Some(p.clone());
    }
    let selector_norm = normalize_email(selector);
    store
        .profiles
        .iter()
        .find(|p| {
            p.email
                .as_deref()
                .map(normalize_email)
                .is_some_and(|e| e == selector_norm)
        })
        .cloned()
}

fn legacy_pointer_file_path() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("BioVault").join("home_path"))
}

fn read_legacy_pointer_file() -> Option<PathBuf> {
    let pointer_path = legacy_pointer_file_path()?;
    let contents = fs::read_to_string(&pointer_path).ok()?;
    let trimmed = contents.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

fn remove_legacy_pointer_file() {
    if let Some(pointer_path) = legacy_pointer_file_path() {
        let _ = fs::remove_file(&pointer_path);
        // Also try to remove the parent dir if empty
        if let Some(parent) = pointer_path.parent() {
            let _ = fs::remove_dir(parent);
        }
    }
}

fn ensure_legacy_profile_migrated(mut store: ProfileStore) -> Result<ProfileStore, String> {
    if !store.profiles.is_empty() {
        // Already have profiles, but check if we should clean up old pointer file
        remove_legacy_pointer_file();
        return Ok(store);
    }

    // First, check for legacy pointer file and migrate from it
    if let Some(pointer_home) = read_legacy_pointer_file() {
        if pointer_home.exists() || pointer_home.to_string_lossy().contains("BioVault") {
            let email = read_home_email(&pointer_home);
            // Canonicalize the path to ensure consistency with resolve_or_create_profile_for_home
            let home_canon = canonicalize_best_effort(&pointer_home);
            let home_str = home_canon.to_string_lossy().to_string();
            let id = uuid::Uuid::new_v4().to_string();
            let entry = ProfileEntry {
                id: id.clone(),
                email,
                biovault_home: home_str,
                created_at: now_rfc3339(),
                last_used_at: Some(now_rfc3339()),
                cached_fingerprint: None,
            };
            store.current_profile_id = Some(id);
            store.profiles.push(entry);
            save_store(&store)?;

            // Clean up old pointer file after successful migration
            remove_legacy_pointer_file();
            crate::desktop_log!("✅ Migrated legacy pointer file to profiles system");
            return Ok(store);
        }
    }

    // Fall back to resolving legacy home (Desktop/BioVault default)
    let home = resolve_legacy_home_without_syftbox_env()?;
    let email = read_home_email(&home);

    // Canonicalize the path to ensure consistency with resolve_or_create_profile_for_home
    let home_canon = canonicalize_best_effort(&home);
    let home_str = home_canon.to_string_lossy().to_string();

    let id = uuid::Uuid::new_v4().to_string();
    let entry = ProfileEntry {
        id: id.clone(),
        email,
        biovault_home: home_str,
        created_at: now_rfc3339(),
        last_used_at: Some(now_rfc3339()),
        cached_fingerprint: None,
    };
    store.current_profile_id = Some(id);
    store.profiles.push(entry);
    save_store(&store)?;

    // Clean up old pointer file if it exists
    remove_legacy_pointer_file();

    Ok(store)
}

fn should_show_picker(store: &ProfileStore) -> bool {
    if env_flag_true("BIOVAULT_FORCE_PROFILE_PICKER") {
        return true;
    }
    if env_flag_true("BIOVAULT_NO_PROFILE_PICKER") {
        return false;
    }
    if store.force_picker_once {
        return true;
    }
    // Show picker only when multiple profiles exist so switching is relevant.
    store.profiles.len() > 1
}

fn is_ws_bridge_dev_mode() -> bool {
    env::var_os("DEV_WS_BRIDGE").is_some()
}

fn allow_new_instance_in_dev() -> bool {
    env_flag_true("BIOVAULT_ALLOW_NEW_INSTANCE_IN_DEV")
        || env_flag_true("BIOVAULT_TEST_ALLOW_NEW_INSTANCE")
}

fn schedule_hard_exit_after_restart() {
    // In dev builds (including browser WS-bridge mode), `app.exit(0)` can be non-deterministic during
    // rapid restarts, sometimes leaving a blank window. Force the process to exit shortly after
    // returning the command response.
    if !(is_ws_bridge_dev_mode() || cfg!(debug_assertions)) {
        return;
    }
    let delay_ms = if is_ws_bridge_dev_mode() { 250 } else { 750 };
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(delay_ms));
        std::process::exit(0);
    });
}

fn close_all_windows_and_exit(app: &tauri::AppHandle) {
    // Close all windows explicitly to avoid zombie webviews in dev mode
    use tauri::Manager;
    for (_, window) in app.webview_windows() {
        let _ = window.close();
    }
    app.exit(0);
    schedule_hard_exit_after_restart();
}

fn is_tauri_dev_mode() -> bool {
    // In tauri dev mode, the frontend is served by Vite dev server.
    // We can't spawn a new binary because it won't have access to Vite.
    // Detect this by checking if we're a debug build but NOT in WS bridge mode.
    cfg!(debug_assertions) && !is_ws_bridge_dev_mode()
}

pub fn apply_profile_selection_from_args(args: &[String]) -> Result<(), String> {
    if !profiles_enabled() {
        return Ok(());
    }
    let selector = args
        .iter()
        .position(|a| a == "--profile" || a == "--profile-id")
        .and_then(|i| args.get(i + 1))
        .cloned();
    if selector.is_none() {
        return Ok(());
    }
    let selector = selector.unwrap();

    let store = ensure_legacy_profile_migrated(load_store()?)?;
    let entry = find_profile_by_id_or_email(&store, &selector)
        .ok_or_else(|| format!("Unknown profile: {}", selector))?;
    env::set_var("BIOVAULT_PROFILE_ID", &entry.id);
    env::set_var("BIOVAULT_HOME", &entry.biovault_home);
    Ok(())
}

pub fn apply_current_profile_if_ready(args: &[String]) -> Result<(), String> {
    if !profiles_enabled() {
        return Ok(());
    }
    if env::var_os("BIOVAULT_HOME").is_some() {
        return Ok(());
    }
    let has_selector = args.iter().any(|a| a == "--profile" || a == "--profile-id");
    if has_selector {
        return Ok(());
    }

    let store = ensure_legacy_profile_migrated(load_store()?)?;
    if should_show_picker(&store) {
        return Ok(());
    }

    let current_id = store
        .current_profile_id
        .clone()
        .or_else(|| store.profiles.first().map(|p| p.id.clone()));
    let Some(current_id) = current_id else {
        return Ok(());
    };
    let Some(entry) = store.profiles.iter().find(|p| p.id == current_id) else {
        return Ok(());
    };
    env::set_var("BIOVAULT_PROFILE_ID", &entry.id);
    env::set_var("BIOVAULT_HOME", &entry.biovault_home);
    Ok(())
}

pub fn maybe_enter_bootstrap_mode(args: &[String]) -> Result<(), String> {
    if !profiles_enabled() {
        return Ok(());
    }

    let mut store = ensure_legacy_profile_migrated(load_store()?)?;
    let has_selector = args.iter().any(|a| a == "--profile" || a == "--profile-id");
    if has_selector || !should_show_picker(&store) {
        return Ok(());
    }

    // In picker mode, avoid selecting a BIOVAULT_HOME until the user chooses a profile.
    env::set_var("BIOVAULT_PROFILE_PICKER", "1");
    env::remove_var("BIOVAULT_HOME");
    env::remove_var("BIOVAULT_PROFILE_ID");

    // Ensure there is a "current" for highlighting in the picker.
    if store.current_profile_id.is_none() && !store.profiles.is_empty() {
        store.current_profile_id = Some(store.profiles[0].id.clone());
        save_store(&store)?;
    }

    Ok(())
}

pub fn acquire_selected_profile_lock(args: &[String]) -> Result<Option<ProfileLock>, String> {
    if !profiles_enabled() {
        return Ok(None);
    }
    if env::var_os("BIOVAULT_PROFILE_PICKER").is_some() {
        return Ok(None);
    }
    let home = env::var("BIOVAULT_HOME")
        .map(PathBuf::from)
        .map_err(|_| "BIOVAULT_HOME not set".to_string())?;

    let wait = args.iter().any(|a| a == "--wait-for-profile-lock");
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        match try_acquire_profile_lock(&home, true) {
            Ok(lock) => return Ok(Some(lock)),
            Err(err) => {
                if !wait || Instant::now() >= deadline {
                    env::set_var("BIOVAULT_FORCE_PROFILE_PICKER", "1");
                    env::set_var("BIOVAULT_PROFILE_PICKER", "1");
                    env::set_var("BIOVAULT_PROFILE_LOCK_CONFLICT", "1");
                    crate::logging::log_desktop_event(
                        LogLevel::Warn,
                        &format!("Profile lock conflict for {}: {}", home.display(), err),
                    );
                    env::remove_var("BIOVAULT_HOME");
                    env::remove_var("BIOVAULT_PROFILE_ID");
                    return Ok(None);
                }
                thread::sleep(Duration::from_millis(200));
            }
        }
    }
}

fn canonicalize_best_effort(path: &Path) -> PathBuf {
    // Try direct canonicalization first
    if let Ok(canon) = fs::canonicalize(path) {
        return canon;
    }

    // If path doesn't exist, canonicalize the longest existing ancestor and append the rest.
    // This handles symlinks in parent directories even when the final path doesn't exist yet.
    let mut current = path.to_path_buf();
    let mut suffix = PathBuf::new();

    while !current.as_os_str().is_empty() && !current.exists() {
        if let Some(name) = current.file_name() {
            suffix = PathBuf::from(name).join(&suffix);
        }
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        } else {
            break;
        }
    }

    if current.as_os_str().is_empty() || !current.exists() {
        // No existing ancestor found, return original path
        return path.to_path_buf();
    }

    match fs::canonicalize(&current) {
        Ok(canon_parent) => canon_parent.join(suffix),
        Err(_) => path.to_path_buf(),
    }
}

fn resolve_or_create_profile_for_home(
    store: &mut ProfileStore,
    home: &Path,
) -> Result<String, String> {
    fs::create_dir_all(home).map_err(|e| format!("Failed to create profile home: {}", e))?;
    let home_canon = canonicalize_best_effort(home);
    let home_str = home_canon.to_string_lossy().to_string();

    if let Some(existing) = store.profiles.iter().find(|p| {
        canonicalize_best_effort(Path::new(&p.biovault_home)).to_string_lossy()
            == home_canon.to_string_lossy()
    }) {
        return Ok(existing.id.clone());
    }

    let id = uuid::Uuid::new_v4().to_string();
    store.profiles.push(ProfileEntry {
        id: id.clone(),
        email: None,
        biovault_home: home_str,
        created_at: now_rfc3339(),
        last_used_at: Some(now_rfc3339()),
        cached_fingerprint: None,
    });
    Ok(id)
}

fn dir_is_empty(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(true);
    }
    if !path.is_dir() {
        return Err("Destination exists and is not a directory".to_string());
    }
    let mut entries = fs::read_dir(path).map_err(|e| format!("Failed to read dir: {}", e))?;
    Ok(entries.next().is_none())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    for entry in WalkDir::new(src).follow_links(false) {
        let entry = entry.map_err(|e| format!("Failed to walk directory: {}", e))?;
        let rel = entry
            .path()
            .strip_prefix(src)
            .map_err(|e| format!("Failed to compute relative path: {}", e))?;
        let target = dst.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)
                .map_err(|e| format!("Failed to create directory {}: {}", target.display(), e))?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    format!("Failed to create parent dir {}: {}", parent.display(), e)
                })?;
            }
            fs::copy(entry.path(), &target).map_err(|e| {
                format!(
                    "Failed to copy {} -> {}: {}",
                    entry.path().display(),
                    target.display(),
                    e
                )
            })?;
        } else {
            // Ignore unusual file types (symlinks, sockets, etc.) for now.
        }
    }
    Ok(())
}

#[tauri::command]
pub fn profiles_get_boot_state() -> Result<ProfilesBootState, String> {
    if !profiles_enabled() {
        return Ok(ProfilesBootState {
            enabled: false,
            should_show_picker: false,
            current_profile_id: None,
            profiles: Vec::new(),
            startup_message: None,
            opened_from_app: false,
        });
    }

    let mut store = ensure_legacy_profile_migrated(load_store()?)?;
    let mut current = env::var("BIOVAULT_PROFILE_ID")
        .ok()
        .map(|val| val.trim().to_string())
        .filter(|val| !val.is_empty())
        .filter(|val| store.profiles.iter().any(|p| p.id == *val));
    if current.is_none() {
        if let Ok(home) = env::var("BIOVAULT_HOME") {
            let trimmed = home.trim();
            if !trimmed.is_empty() {
                let normalized = normalize_home_input(trimmed);
                // Try to find existing profile for this home
                current = store
                    .profiles
                    .iter()
                    .find(|p| normalize_home_input(&p.biovault_home) == normalized)
                    .map(|p| p.id.clone());

                // Auto-register current BIOVAULT_HOME as a profile if not found
                if current.is_none() && normalized.exists() {
                    let email = read_home_email(&normalized);
                    let home_canon = canonicalize_best_effort(&normalized);
                    let home_str = home_canon.to_string_lossy().to_string();
                    let id = uuid::Uuid::new_v4().to_string();
                    let entry = ProfileEntry {
                        id: id.clone(),
                        email,
                        biovault_home: home_str,
                        created_at: now_rfc3339(),
                        last_used_at: Some(now_rfc3339()),
                        cached_fingerprint: None,
                    };
                    store.profiles.push(entry);
                    store.current_profile_id = Some(id.clone());
                    let _ = save_store(&store);
                    current = Some(id);
                    crate::desktop_log!(
                        "✅ Auto-registered current BIOVAULT_HOME as profile: {}",
                        normalized.display()
                    );
                }
            }
        }
    }
    if current.is_none() {
        current = store.current_profile_id.clone();
    }
    // Only show the picker UI when this process is actually running in picker mode (bootstrap),
    // or when explicitly requested (e.g. Settings -> Switch Profile).
    let picker_mode = env::var_os("BIOVAULT_PROFILE_PICKER").is_some()
        || env_flag_true("BIOVAULT_FORCE_PROFILE_PICKER");
    let should_show = picker_mode || store.force_picker_once;

    let mut profiles: Vec<ProfileSummary> = store
        .profiles
        .iter()
        .map(|p| summarize_profile(p, current.as_deref()))
        .collect();
    profiles.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));

    let startup_message = if env::var_os("BIOVAULT_PROFILE_LOCK_CONFLICT").is_some() {
        Some("That profile is already running in another BioVault process.".to_string())
    } else {
        None
    };

    let opened_from_app = store.force_picker_once;
    if store.force_picker_once {
        store.force_picker_once = false;
        let _ = save_store(&store);
    }

    Ok(ProfilesBootState {
        enabled: true,
        should_show_picker: should_show,
        current_profile_id: current,
        profiles,
        startup_message,
        opened_from_app,
    })
}

#[tauri::command]
pub fn profiles_get_default_home() -> Result<String, String> {
    let home_dir = dirs::home_dir().ok_or("Could not determine home directory".to_string())?;
    let desktop_dir = dirs::desktop_dir().unwrap_or_else(|| home_dir.join("Desktop"));
    Ok(desktop_dir.join("BioVault").to_string_lossy().to_string())
}

fn spawn_with_profile(
    profile_id: &str,
    wait_for_lock: bool,
    probe_spawn: bool,
    profile_home: Option<&Path>,
    exit_on_close: bool,
) -> Result<(), String> {
    let exe = env::current_exe().map_err(|e| format!("Failed to locate current exe: {}", e))?;
    let mut cmd = Command::new(exe);
    cmd.arg("--profile-id").arg(profile_id);
    if wait_for_lock {
        cmd.arg("--wait-for-profile-lock");
    }
    // Ensure we don't inherit the bootstrap home.
    cmd.env_remove("BIOVAULT_HOME");
    cmd.env_remove("BIOVAULT_PROFILE_ID");
    cmd.env_remove("BIOVAULT_EXIT_ON_CLOSE");
    cmd.env_remove("BIOVAULT_PROFILE_PICKER");
    cmd.env_remove("BIOVAULT_PROFILE_LOCK_CONFLICT");
    cmd.env_remove("BIOVAULT_FORCE_PROFILE_PICKER");
    if let Some(home) = profile_home {
        cmd.env("BIOVAULT_HOME", home.to_string_lossy().to_string());
    }
    cmd.env("BIOVAULT_PROFILE_ID", profile_id);
    if exit_on_close {
        cmd.env("BIOVAULT_EXIT_ON_CLOSE", "1");
    }

    // Forward store override if present (useful for dev/test scripts).
    if let Ok(store_path) = env::var("BIOVAULT_PROFILES_PATH") {
        cmd.env("BIOVAULT_PROFILES_PATH", store_path);
    }
    if let Ok(store_dir) = env::var("BIOVAULT_PROFILES_DIR") {
        cmd.env("BIOVAULT_PROFILES_DIR", store_dir);
    }
    if probe_spawn {
        cmd.env("BIOVAULT_SPAWN_PROBE_ONLY", "1");
    }

    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to spawn new BioVault instance: {}", e))
}

fn spawn_picker_instance() -> Result<(), String> {
    let exe = env::current_exe().map_err(|e| format!("Failed to locate current exe: {}", e))?;
    let mut cmd = Command::new(exe);
    cmd.env_remove("BIOVAULT_HOME");
    cmd.env_remove("BIOVAULT_PROFILE_PICKER");
    cmd.env_remove("BIOVAULT_PROFILE_LOCK_CONFLICT");
    cmd.env_remove("BIOVAULT_PROFILE_ID");
    cmd.env("BIOVAULT_FORCE_PROFILE_PICKER", "1");
    if let Ok(store_path) = env::var("BIOVAULT_PROFILES_PATH") {
        cmd.env("BIOVAULT_PROFILES_PATH", store_path);
    }
    if let Ok(store_dir) = env::var("BIOVAULT_PROFILES_DIR") {
        cmd.env("BIOVAULT_PROFILES_DIR", store_dir);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to spawn BioVault profile picker: {}", e))
}

fn update_current_profile(store: &mut ProfileStore, profile_id: &str) {
    store.current_profile_id = Some(profile_id.to_string());
    for p in &mut store.profiles {
        if p.id == profile_id {
            p.last_used_at = Some(now_rfc3339());
        }
    }
}

#[tauri::command]
pub fn profiles_open_new_instance(profile_id: String) -> Result<(), String> {
    if !profiles_enabled() {
        return Err("Profiles are disabled".to_string());
    }
    if is_ws_bridge_dev_mode() && !allow_new_instance_in_dev() {
        return Err("New Instance is not supported in browser dev mode".to_string());
    }
    let store = ensure_legacy_profile_migrated(load_store()?)?;
    let entry = store
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .cloned()
        .ok_or_else(|| "Unknown profile".to_string())?;

    let is_active_profile = env::var("BIOVAULT_PROFILE_ID")
        .map(|val| val == profile_id)
        .unwrap_or(false);
    let is_active_home = env::var("BIOVAULT_HOME")
        .ok()
        .map(PathBuf::from)
        .map(|p| canonicalize_best_effort(&p))
        .is_some_and(|active| canonicalize_best_effort(Path::new(&entry.biovault_home)) == active);
    if is_active_profile || is_active_home {
        return Err("Profile is already active".to_string());
    }

    let home = PathBuf::from(&entry.biovault_home);
    {
        let _lock = try_acquire_profile_lock(&home, true)
            .map_err(|_| "Profile is already running in another instance".to_string())?;
    }

    spawn_with_profile(&profile_id, false, true, Some(&home), true)
}

#[tauri::command]
pub fn profiles_switch(app: tauri::AppHandle, profile_id: String) -> Result<(), String> {
    if !profiles_enabled() {
        return Err("Profiles are disabled".to_string());
    }
    let mut store = ensure_legacy_profile_migrated(load_store()?)?;
    let entry = store
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .cloned()
        .ok_or_else(|| "Unknown profile".to_string())?;
    update_current_profile(&mut store, &profile_id);
    save_store(&store)?;

    if is_tauri_dev_mode() {
        return Err("DEV_MODE_RESTART_REQUIRED".to_string());
    }

    let home = PathBuf::from(&entry.biovault_home);
    spawn_with_profile(&profile_id, true, false, Some(&home), false)?;
    close_all_windows_and_exit(&app);
    Ok(())
}

/// Switch profile in-place without restarting the app.
/// Updates env vars and reinitializes database connections.
#[tauri::command]
pub fn profiles_switch_in_place(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    profile_id: String,
) -> Result<(), String> {
    if !profiles_enabled() {
        return Err("Profiles are disabled".to_string());
    }

    let mut store = ensure_legacy_profile_migrated(load_store()?)?;
    let entry = store
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .cloned()
        .ok_or_else(|| "Unknown profile".to_string())?;

    // Ensure the target profile is not already running elsewhere.
    let home = PathBuf::from(&entry.biovault_home);
    let new_lock = try_acquire_profile_lock(&home, true)
        .map_err(|_| "Profile is already running in another instance".to_string())?;

    // Update current profile in store
    update_current_profile(&mut store, &profile_id);
    save_store(&store)?;

    // Stop SyftBox daemon before switching (it's tied to the old profile's config)
    if let Err(e) = crate::stop_syftbox_client() {
        crate::desktop_log!(
            "⚠️ Failed to stop SyftBox daemon during profile switch: {}",
            e
        );
        // Continue anyway - daemon might not have been running
    }

    // Clear picker mode flags so the app doesn't show picker again after reload
    env::remove_var("BIOVAULT_PROFILE_PICKER");
    env::remove_var("BIOVAULT_FORCE_PROFILE_PICKER");
    env::remove_var("BIOVAULT_PROFILE_LOCK_CONFLICT");

    // Update environment variables
    env::set_var("BIOVAULT_HOME", &entry.biovault_home);
    env::set_var("BIOVAULT_PROFILE_ID", &entry.id);

    // Ensure SYC_VAULT matches the single explicit vault location.
    biovault::config::require_syc_vault_env()
        .map_err(|e| format!("Failed to resolve SYC_VAULT: {e}"))?;

    // Ensure home directory exists
    fs::create_dir_all(&home).map_err(|e| format!("Failed to create profile home: {}", e))?;

    // Re-initialize desktop database
    {
        let mut desktop_conn = state
            .db
            .lock()
            .map_err(|_| "Failed to lock desktop database connection".to_string())?;
        let new_conn = rusqlite::Connection::open(home.join("biovault.db"))
            .map_err(|e| format!("Failed to open desktop database: {}", e))?;
        crate::init_db(&new_conn)
            .map_err(|e| format!("Failed to initialize desktop database: {}", e))?;
        *desktop_conn = new_conn;
    }

    // Re-initialize biovault database
    {
        let new_db = biovault::data::BioVaultDb::new()
            .map_err(|e| format!("Failed to initialize BioVault database: {}", e))?;
        let mut shared_db = state
            .biovault_db
            .lock()
            .map_err(|_| "Failed to lock BioVault database".to_string())?;
        *shared_db = new_db;
    }

    if let Ok(mut guard) = crate::PROFILE_LOCK.lock() {
        *guard = Some(new_lock);
    }

    if let Some(window) = app.get_webview_window("main") {
        let email = read_home_email(&home).unwrap_or_else(|| "Select Profile".to_string());
        let title = if std::env::var("BIOVAULT_DEBUG_BANNER")
            .map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false)
        {
            format!("BioVault - {} [{}]", email, entry.biovault_home)
        } else {
            format!("BioVault - {}", email)
        };
        let _ = window.set_title(&title);
    }

    crate::desktop_log!(
        "✅ Switched to profile: {} ({})",
        entry.biovault_home,
        profile_id
    );
    Ok(())
}

/// Create a new profile and switch to it in-place without restarting.
#[tauri::command]
pub fn profiles_create_and_switch_in_place(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    home_path: String,
) -> Result<String, String> {
    if !profiles_enabled() {
        return Err("Profiles are disabled".to_string());
    }

    let trimmed = home_path.trim();
    if trimmed.is_empty() {
        return Err("Home path is required".to_string());
    }
    let home = normalize_home_input(trimmed);

    // Check if this is already the current home
    if let Ok(current_home) = biovault::config::get_biovault_home() {
        if current_home == home {
            return Err("This folder is already your current profile".to_string());
        }
    }

    let new_lock = try_acquire_profile_lock(&home, true)
        .map_err(|_| "Profile is already running in another instance".to_string())?;

    // Create/find profile for this home
    let mut store = ensure_legacy_profile_migrated(load_store()?)?;
    let profile_id = resolve_or_create_profile_for_home(&mut store, &home)?;
    update_current_profile(&mut store, &profile_id);
    save_store(&store)?;

    // Stop SyftBox daemon before switching
    if let Err(e) = crate::stop_syftbox_client() {
        crate::desktop_log!(
            "⚠️ Failed to stop SyftBox daemon during profile creation: {}",
            e
        );
    }

    // Clear picker mode flags so the app doesn't show picker again after reload
    env::remove_var("BIOVAULT_PROFILE_PICKER");
    env::remove_var("BIOVAULT_FORCE_PROFILE_PICKER");
    env::remove_var("BIOVAULT_PROFILE_LOCK_CONFLICT");

    // Update environment variables
    env::set_var("BIOVAULT_HOME", home.to_string_lossy().to_string());
    env::set_var("BIOVAULT_PROFILE_ID", &profile_id);

    // Ensure SYC_VAULT matches the single explicit vault location.
    biovault::config::require_syc_vault_env()
        .map_err(|e| format!("Failed to resolve SYC_VAULT: {e}"))?;

    // Ensure home directory exists
    fs::create_dir_all(&home).map_err(|e| format!("Failed to create profile home: {}", e))?;

    // Re-initialize desktop database
    {
        let mut desktop_conn = state
            .db
            .lock()
            .map_err(|_| "Failed to lock desktop database connection".to_string())?;
        let new_conn = rusqlite::Connection::open(home.join("biovault.db"))
            .map_err(|e| format!("Failed to open desktop database: {}", e))?;
        crate::init_db(&new_conn)
            .map_err(|e| format!("Failed to initialize desktop database: {}", e))?;
        *desktop_conn = new_conn;
    }

    // Re-initialize biovault database
    {
        let new_db = biovault::data::BioVaultDb::new()
            .map_err(|e| format!("Failed to initialize BioVault database: {}", e))?;
        let mut shared_db = state
            .biovault_db
            .lock()
            .map_err(|_| "Failed to lock BioVault database".to_string())?;
        *shared_db = new_db;
    }

    if let Ok(mut guard) = crate::PROFILE_LOCK.lock() {
        *guard = Some(new_lock);
    }

    if let Some(window) = app.get_webview_window("main") {
        let email = read_home_email(&home).unwrap_or_else(|| "Select Profile".to_string());
        let title = if std::env::var("BIOVAULT_DEBUG_BANNER")
            .map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false)
        {
            format!("BioVault - {} [{}]", email, home.to_string_lossy())
        } else {
            format!("BioVault - {}", email)
        };
        let _ = window.set_title(&title);
    }

    crate::desktop_log!(
        "✅ Created and switched to profile: {} ({})",
        home.display(),
        profile_id
    );
    Ok(profile_id)
}

#[tauri::command]
pub fn profiles_open_picker(app: tauri::AppHandle) -> Result<(), String> {
    if !profiles_enabled() {
        return Err("Profiles are disabled".to_string());
    }

    let mut store = ensure_legacy_profile_migrated(load_store()?)?;
    if store.profiles.len() <= 1 {
        return Err("Only one profile exists".to_string());
    }
    store.force_picker_once = true;
    save_store(&store)?;

    if is_tauri_dev_mode() {
        return Err("DEV_MODE_RESTART_REQUIRED".to_string());
    }

    spawn_picker_instance()?;
    close_all_windows_and_exit(&app);
    Ok(())
}

#[tauri::command]
pub fn profiles_quit_picker(app: tauri::AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct HomeCheckResult {
    pub has_existing_config: bool,
    pub existing_email: Option<String>,
}

#[tauri::command]
pub fn profiles_check_home_for_existing_email(
    home_path: String,
) -> Result<HomeCheckResult, String> {
    let trimmed = home_path.trim();
    if trimmed.is_empty() {
        return Ok(HomeCheckResult {
            has_existing_config: false,
            existing_email: None,
        });
    }
    let home = normalize_home_input(trimmed);
    let config_path = home.join("config.yaml");

    if !config_path.exists() {
        return Ok(HomeCheckResult {
            has_existing_config: false,
            existing_email: None,
        });
    }

    // Try to read the email from existing config
    let contents =
        fs::read_to_string(&config_path).map_err(|e| format!("Failed to read config: {}", e))?;

    // Simple YAML parsing for email field
    let email = contents
        .lines()
        .find(|line| line.trim().starts_with("email:"))
        .and_then(|line| {
            let parts: Vec<&str> = line.splitn(2, ':').collect();
            parts
                .get(1)
                .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
        })
        .filter(|e| !e.is_empty() && e != "placeholder@example.com");

    Ok(HomeCheckResult {
        has_existing_config: true,
        existing_email: email,
    })
}

#[tauri::command]
pub fn profiles_create_with_home_and_switch(
    app: tauri::AppHandle,
    home_path: String,
) -> Result<(), String> {
    if !profiles_enabled() {
        return Err("Profiles are disabled".to_string());
    }
    let trimmed = home_path.trim();
    if trimmed.is_empty() {
        return Err("Home path is required".to_string());
    }
    let home = normalize_home_input(trimmed);

    let mut store = ensure_legacy_profile_migrated(load_store()?)?;
    let profile_id = resolve_or_create_profile_for_home(&mut store, &home)?;
    update_current_profile(&mut store, &profile_id);
    save_store(&store)?;

    if is_tauri_dev_mode() {
        return Err("DEV_MODE_RESTART_REQUIRED".to_string());
    }

    spawn_with_profile(&profile_id, true, false, Some(&home), false)?;
    close_all_windows_and_exit(&app);
    Ok(())
}

#[tauri::command]
pub fn profiles_move_home(profile_id: String, new_home_path: String) -> Result<(), String> {
    if !profiles_enabled() {
        return Err("Profiles are disabled".to_string());
    }
    let new_home_trimmed = new_home_path.trim();
    if new_home_trimmed.is_empty() {
        return Err("New home path is required".to_string());
    }
    let new_home = normalize_home_input(new_home_trimmed);

    let mut store = ensure_legacy_profile_migrated(load_store()?)?;
    let entry = store
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .cloned()
        .ok_or_else(|| "Unknown profile".to_string())?;

    let old_home = PathBuf::from(&entry.biovault_home);
    if !old_home.exists() {
        return Err("Profile home does not exist".to_string());
    }

    // Ensure the profile is not currently running (acquire the lock ourselves).
    let _lock = try_acquire_profile_lock(&old_home, false)?;

    let old_canon = canonicalize_best_effort(&old_home);
    let new_canon = canonicalize_best_effort(&new_home);
    if old_canon == new_canon {
        return Ok(());
    }

    if !dir_is_empty(&new_home)? {
        return Err("Destination folder must be empty".to_string());
    }

    // Try fast move; if it fails (e.g., cross-device), fall back to copy+delete.
    let moved = fs::rename(&old_home, &new_home).is_ok();
    if !moved {
        fs::create_dir_all(&new_home)
            .map_err(|e| format!("Failed to create destination dir: {}", e))?;
        copy_dir_recursive(&old_home, &new_home)?;
        fs::remove_dir_all(&old_home)
            .map_err(|e| format!("Failed to remove old home dir: {}", e))?;
    }

    // Update store
    for p in &mut store.profiles {
        if p.id == entry.id {
            p.biovault_home = canonicalize_best_effort(&new_home)
                .to_string_lossy()
                .to_string();
            p.last_used_at = Some(now_rfc3339());
        }
    }
    save_store(&store)?;
    Ok(())
}

#[tauri::command]
pub fn profiles_delete_profile(profile_id: String, delete_home: bool) -> Result<(), String> {
    if !profiles_enabled() {
        return Err("Profiles are disabled".to_string());
    }

    let mut store = ensure_legacy_profile_migrated(load_store()?)?;
    let current_id = store.current_profile_id.clone();
    if current_id.as_deref() == Some(profile_id.as_str()) {
        return Err("Cannot delete the current profile".to_string());
    }

    let entry = store
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .cloned()
        .ok_or_else(|| "Unknown profile".to_string())?;
    let home = PathBuf::from(&entry.biovault_home);

    // Ensure the profile is not currently running (acquire the lock ourselves if it exists).
    if home.exists() {
        let _lock = try_acquire_profile_lock(&home, false)?;
    }

    store.profiles.retain(|p| p.id != entry.id);
    save_store(&store)?;

    if delete_home && home.exists() {
        fs::remove_dir_all(&home)
            .map_err(|e| format!("Failed to delete profile home {}: {}", home.display(), e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn profiles_create_and_switch(app: tauri::AppHandle) -> Result<(), String> {
    if !profiles_enabled() {
        return Err("Profiles are disabled".to_string());
    }

    let mut store = ensure_legacy_profile_migrated(load_store()?)?;

    let desktop_dir = dirs::desktop_dir().or_else(|| dirs::home_dir().map(|h| h.join("Desktop")));
    let root = desktop_dir
        .unwrap_or_else(|| PathBuf::from("."))
        .join("BioVault Profiles");
    fs::create_dir_all(&root).map_err(|e| format!("Failed to create profiles home root: {}", e))?;

    let id = uuid::Uuid::new_v4().to_string();
    let home = root.join(&id);
    fs::create_dir_all(&home).map_err(|e| format!("Failed to create profile home: {}", e))?;

    store.profiles.push(ProfileEntry {
        id: id.clone(),
        email: None,
        biovault_home: home.to_string_lossy().to_string(),
        created_at: now_rfc3339(),
        last_used_at: Some(now_rfc3339()),
        cached_fingerprint: None,
    });
    update_current_profile(&mut store, &id);
    save_store(&store)?;

    if is_tauri_dev_mode() {
        return Err("DEV_MODE_RESTART_REQUIRED".to_string());
    }

    spawn_with_profile(&id, true, false, Some(&home), false)?;
    close_all_windows_and_exit(&app);
    Ok(())
}

pub fn register_current_profile_email(email: &str) -> Result<(), String> {
    if !profiles_enabled() {
        return Ok(());
    }
    let current_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    // Canonicalize to resolve symlinks and ensure consistent path comparison
    let current_home_canon = canonicalize_best_effort(&current_home);
    let home_str = current_home_canon.to_string_lossy().to_string();

    let email_norm = normalize_email(email);
    if email_norm.is_empty() {
        return Ok(());
    }

    let mut store = ensure_legacy_profile_migrated(load_store()?)?;

    // Enforce unique email across profiles.
    if store.profiles.iter().any(|p| {
        p.email
            .as_deref()
            .map(normalize_email)
            .is_some_and(|e| e == email_norm)
            && canonicalize_best_effort(Path::new(&p.biovault_home)).to_string_lossy() != home_str
    }) {
        return Err("That email is already registered to another profile".to_string());
    }

    let cached_fingerprint = (|| {
        let slug = syftbox_sdk::sanitize_identity(email.trim());
        let vault = biovault::config::resolve_syc_vault_path().ok()?;
        let bundle_path = vault.join("bundles").join(format!("{slug}.json"));
        if !bundle_path.exists() {
            return None;
        }
        let info = biovault::syftbox::syc::parse_public_bundle_file(&bundle_path).ok()?;
        Some(info.fingerprint)
    })();

    // Find profile matching current home (comparing canonical paths), else create one.
    let mut found_id = None;
    for p in &mut store.profiles {
        let p_home_canon = canonicalize_best_effort(Path::new(&p.biovault_home));
        if p_home_canon.to_string_lossy() == home_str {
            p.email = Some(email.trim().to_string());
            p.last_used_at = Some(now_rfc3339());
            if cached_fingerprint.is_some() {
                p.cached_fingerprint = cached_fingerprint.clone();
            }
            found_id = Some(p.id.clone());
            break;
        }
    }

    if found_id.is_none() {
        let id = uuid::Uuid::new_v4().to_string();
        store.profiles.push(ProfileEntry {
            id: id.clone(),
            email: Some(email.trim().to_string()),
            biovault_home: home_str,
            created_at: now_rfc3339(),
            last_used_at: Some(now_rfc3339()),
            cached_fingerprint,
        });
        found_id = Some(id);
    }

    store.current_profile_id = found_id;
    save_store(&store)?;
    Ok(())
}
