use crate::types::AppState;
use biovault::syftbox::storage::SyftBoxStorage;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Emitter;
use walkdir::WalkDir;

// Use CLI library types and functions
use biovault::cli::commands::flow::run_flow as cli_run_flow;
use biovault::cli::commands::module_management::{resolve_flow_dependencies, DependencyContext};
use biovault::data::BioVaultDb;
pub use biovault::data::{Flow, Run, RunConfig};
pub use biovault::flow_spec::FlowSpec;
use biovault::flow_spec::FLOW_YAML_FILE;
use biovault::flow_spec::{FlowFile, FlowModuleDef, FlowModuleSource, FlowStepUses};
use biovault::module_spec::ModuleFile;

#[cfg(not(target_os = "windows"))]
use libc;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowCreateRequest {
    pub name: String,
    pub directory: Option<String>,
    pub flow_file: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowRunSelection {
    /// Legacy: database file IDs (deprecated, use urls instead)
    #[serde(default, alias = "file_ids")]
    pub file_ids: Vec<i64>,
    /// Syft URLs to resolve to local file paths
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default, alias = "participant_ids")]
    pub participant_ids: Vec<String>,
    #[serde(default, alias = "dataset_name")]
    pub dataset_name: Option<String>,
    #[serde(default)]
    pub dataset_shape: Option<String>,
    #[serde(default)]
    pub dataset_data_type: Option<String>,
    #[serde(default, alias = "dataset_owner")]
    pub dataset_owner: Option<String>,
    #[serde(default, alias = "asset_keys")]
    pub asset_keys: Vec<String>,
    #[serde(default, alias = "data_type")]
    pub data_type: Option<String>,
    #[serde(default, alias = "data_source")]
    pub data_source: Option<String>,
}

/// Persistent flow state - saved to flow.state.json for resume/recovery
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FlowState {
    /// Progress: completed tasks
    #[serde(default)]
    pub completed: u32,
    /// Progress: total tasks
    #[serde(default)]
    pub total: u32,
    /// Concurrency setting (maxForks)
    #[serde(default)]
    pub concurrency: Option<u32>,
    /// Number of running containers at last update
    #[serde(default)]
    pub container_count: u32,
    /// Last update timestamp (ISO 8601)
    #[serde(default)]
    pub last_updated: Option<String>,
    /// Run status at last update
    #[serde(default)]
    pub status: Option<String>,
}

fn flow_state_path(results_dir: &Path) -> PathBuf {
    results_dir.join("flow.state.json")
}

fn save_flow_state(results_dir: &Path, state: &FlowState) -> Result<(), String> {
    let path = flow_state_path(results_dir);
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize flow state: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write flow state: {}", e))?;
    Ok(())
}

fn load_flow_state(results_dir: &Path) -> Option<FlowState> {
    let path = flow_state_path(results_dir);
    if !path.exists() {
        return None;
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn flow_pause_marker(results_dir: &Path) -> PathBuf {
    results_dir.join(".flow.pause")
}

fn flow_pid_path(results_dir: &Path) -> PathBuf {
    results_dir.join("flow.pid")
}

#[cfg(target_os = "windows")]
fn configure_child_process(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn configure_child_process(_cmd: &mut Command) {}

fn try_remove_lock_file(lock_path: &Path) -> bool {
    // Try direct removal
    if fs::remove_file(lock_path).is_ok() {
        return true;
    }

    // Try clearing readonly flag
    if let Ok(metadata) = fs::metadata(lock_path) {
        let mut perms = metadata.permissions();
        perms.set_readonly(false);
        if fs::set_permissions(lock_path, perms).is_ok() && fs::remove_file(lock_path).is_ok() {
            return true;
        }
    }

    // On Windows: try renaming first (sometimes works when delete doesn't)
    #[cfg(target_os = "windows")]
    {
        let temp_name = lock_path.with_extension("lock.deleting");
        if fs::rename(lock_path, &temp_name).is_ok() {
            let _ = fs::remove_file(&temp_name);
            return !lock_path.exists();
        }
    }

    false
}

fn clear_nextflow_locks(
    flow_path: &Path,
    window: Option<&tauri::WebviewWindow>,
    log_path: &Path,
    max_retries: u32,
) -> Result<usize, String> {
    let nextflow_dir = flow_path.join(".nextflow");
    if !nextflow_dir.exists() {
        return Ok(0);
    }

    let mut total_removed = 0usize;

    for attempt in 0..max_retries {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            append_flow_log(
                window,
                log_path,
                &format!(
                    "🔄 Retry lock cleanup attempt {}/{}",
                    attempt + 1,
                    max_retries
                ),
            );
        }

        for entry in WalkDir::new(&nextflow_dir)
            .into_iter()
            .filter_map(Result::ok)
        {
            if entry.file_type().is_file() && entry.file_name().to_string_lossy() == "LOCK" {
                let lock_path = entry.path();
                if try_remove_lock_file(lock_path) {
                    total_removed += 1;
                    append_flow_log(
                        window,
                        log_path,
                        &format!("🧹 Removed Nextflow lock {}", lock_path.display()),
                    );
                }
            }
        }

        // Check if any locks remain
        if list_nextflow_locks(flow_path).is_empty() {
            break;
        }
    }

    // Log any remaining locks
    let remaining = list_nextflow_locks(flow_path);
    for lock_path in &remaining {
        append_flow_log(
            window,
            log_path,
            &format!("⚠️  Failed to remove lock {}", lock_path.display()),
        );
    }

    Ok(total_removed)
}

fn list_nextflow_locks(flow_path: &Path) -> Vec<PathBuf> {
    let nextflow_dir = flow_path.join(".nextflow");
    if !nextflow_dir.exists() {
        return Vec::new();
    }
    WalkDir::new(&nextflow_dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_file() && entry.file_name().to_string_lossy() == "LOCK"
        })
        .map(|entry| entry.into_path())
        .collect()
}

/// Check if the Nextflow cache appears potentially corrupted
/// Returns true if LOCK files exist in cache/*/db directories (sign of interrupted run)
fn is_nextflow_cache_potentially_corrupted(flow_path: &Path) -> bool {
    let cache_dir = flow_path.join(".nextflow").join("cache");
    if !cache_dir.exists() {
        return false;
    }

    // Check each session directory for LOCK files in the db subdirectory
    if let Ok(entries) = fs::read_dir(&cache_dir) {
        for entry in entries.filter_map(Result::ok) {
            let db_dir = entry.path().join("db");
            let lock_file = db_dir.join("LOCK");
            if lock_file.exists() {
                return true;
            }
        }
    }
    false
}

/// Clear the entire .nextflow/cache directory to avoid corrupted DB issues after pause
fn clear_nextflow_cache(
    flow_path: &Path,
    window: Option<&tauri::WebviewWindow>,
    log_path: &Path,
) -> Result<usize, String> {
    let cache_dir = flow_path.join(".nextflow").join("cache");
    if !cache_dir.exists() {
        return Ok(0);
    }

    let mut cleared = 0usize;

    // Remove all session directories in the cache
    if let Ok(entries) = fs::read_dir(&cache_dir) {
        for entry in entries.filter_map(Result::ok) {
            let session_path = entry.path();
            if session_path.is_dir() {
                match fs::remove_dir_all(&session_path) {
                    Ok(_) => {
                        cleared += 1;
                        append_flow_log(
                            window,
                            log_path,
                            &format!(
                                "🧹 Cleared Nextflow cache session: {}",
                                session_path.display()
                            ),
                        );
                    }
                    Err(e) => {
                        append_flow_log(
                            window,
                            log_path,
                            &format!(
                                "⚠️  Failed to clear cache {}: {}",
                                session_path.display(),
                                e
                            ),
                        );
                    }
                }
            }
        }
    }

    Ok(cleared)
}

fn append_flow_env_var(window: Option<&tauri::WebviewWindow>, log_path: &Path, key: &str) {
    let value = env::var(key).unwrap_or_else(|_| "(unset)".to_string());
    let display = if value.trim().is_empty() {
        "(unset)".to_string()
    } else {
        value
    };
    append_flow_log(window, log_path, &format!("env {}={}", key, display));
}

fn truncate_output(bytes: &[u8], limit: usize) -> String {
    if bytes.is_empty() {
        return "(empty)".to_string();
    }
    let text = String::from_utf8_lossy(bytes);
    if text.len() <= limit {
        text.to_string()
    } else {
        format!("{}... (truncated)", &text[..limit])
    }
}

fn probe_container_runtime(window: Option<&tauri::WebviewWindow>, log_path: &Path) {
    let mut bins: Vec<String> = Vec::new();
    if let Ok(runtime) = env::var("BIOVAULT_CONTAINER_RUNTIME") {
        let trimmed = runtime.trim();
        if !trimmed.is_empty() {
            bins.push(trimmed.to_string());
        }
    }
    if bins.is_empty() {
        bins.push("docker".to_string());
        bins.push("podman".to_string());
    }
    bins.dedup();

    append_flow_log(
        window,
        log_path,
        &format!("Container runtime candidates: {:?}", bins),
    );

    for bin in bins {
        let mut cmd = Command::new(&bin);
        cmd.arg("info");
        configure_child_process(&mut cmd);
        let output = cmd.output();
        match output {
            Ok(out) => {
                let status = out.status;
                let stdout = truncate_output(&out.stdout, 800);
                let stderr = truncate_output(&out.stderr, 800);
                append_flow_log(
                    window,
                    log_path,
                    &format!(
                        "{} info status={} stdout={} stderr={}",
                        bin, status, stdout, stderr
                    ),
                );
                if status.success() {
                    append_flow_log(window, log_path, &format!("Container runtime OK: {}", bin));
                    break;
                }
            }
            Err(err) => {
                append_flow_log(
                    window,
                    log_path,
                    &format!("{} info exec failed: {}", bin, err),
                );
            }
        }
    }
}

fn is_pid_running(pid: i32) -> bool {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("tasklist");
        cmd.args(["/FI", &format!("PID eq {}", pid)]);
        configure_child_process(&mut cmd);
        if let Ok(output) = cmd.output() {
            if let Ok(stdout) = String::from_utf8(output.stdout) {
                return stdout.contains(&pid.to_string()) && !stdout.contains("No tasks");
            }
        }
        false
    }

    #[cfg(not(target_os = "windows"))]
    unsafe {
        libc::kill(pid, 0) == 0
    }
}

/// Get the container runtime binary (docker or podman)
fn get_container_runtime() -> Option<String> {
    // Check BIOVAULT_CONTAINER_RUNTIME env var first
    if let Ok(runtime) = env::var("BIOVAULT_CONTAINER_RUNTIME") {
        let runtime = runtime.to_lowercase();
        if runtime == "podman" || runtime == "docker" {
            return Some(runtime);
        }
    }

    // Default to docker, but check if podman is preferred
    let mut docker_cmd = Command::new("docker");
    docker_cmd.arg("--version");
    configure_child_process(&mut docker_cmd);

    let mut podman_cmd = Command::new("podman");
    podman_cmd.arg("--version");
    configure_child_process(&mut podman_cmd);

    // Prefer docker if available
    if docker_cmd
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Some("docker".to_string());
    }
    if podman_cmd
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Some("podman".to_string());
    }

    None
}

/// Get list of running container IDs that might be related to nextflow
fn get_nextflow_container_ids() -> Vec<String> {
    let runtime = match get_container_runtime() {
        Some(r) => r,
        None => return Vec::new(),
    };

    // Get all running container IDs along with their image names
    let mut cmd = Command::new(&runtime);
    cmd.args([
        "ps",
        "-q",
        "--filter",
        "ancestor=nfcore",
        "--filter",
        "status=running",
    ]);
    configure_child_process(&mut cmd);

    let mut containers = Vec::new();

    // Also try to find containers by looking at labels or working directories
    // Nextflow containers often have specific patterns
    let mut cmd2 = Command::new(&runtime);
    cmd2.args(["ps", "--format", "{{.ID}} {{.Image}}"]);
    configure_child_process(&mut cmd2);

    if let Ok(output) = cmd2.output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    let container_id = parts[0];
                    let image = parts[1].to_lowercase();
                    // Match common nextflow/bioinformatics container patterns
                    if image.contains("nfcore")
                        || image.contains("biocontainer")
                        || image.contains("quay.io/biocontainers")
                        || image.contains("nextflow")
                    {
                        containers.push(container_id.to_string());
                    }
                }
            }
        }
    }

    containers
}

/// Stop specific containers by ID
fn stop_containers(container_ids: &[String]) -> usize {
    if container_ids.is_empty() {
        return 0;
    }

    let runtime = match get_container_runtime() {
        Some(r) => r,
        None => return 0,
    };

    let mut stopped = 0;
    for id in container_ids {
        let mut cmd = Command::new(&runtime);
        cmd.args(["stop", "-t", "5", id]); // 5 second timeout
        configure_child_process(&mut cmd);
        if cmd.status().map(|s| s.success()).unwrap_or(false) {
            stopped += 1;
        }
    }
    stopped
}

/// Get count of ALL running containers (for display purposes)
fn get_running_container_count() -> usize {
    let runtime = match get_container_runtime() {
        Some(r) => r,
        None => return 0,
    };

    let mut cmd = Command::new(&runtime);
    cmd.args(["ps", "-q"]);
    configure_child_process(&mut cmd);

    match cmd.output() {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            stdout.lines().filter(|line| !line.is_empty()).count()
        }
        _ => 0,
    }
}

fn parse_flow_run_metadata(
    run: &Run,
) -> Result<
    (
        HashMap<String, String>,
        Option<FlowRunSelection>,
        Option<u32>,
    ),
    String,
> {
    let mut input_overrides = HashMap::new();
    let mut selection: Option<FlowRunSelection> = None;
    let mut nextflow_max_forks: Option<u32> = None;

    let metadata_str = match run.metadata.as_ref() {
        Some(value) if !value.trim().is_empty() => value,
        _ => return Ok((input_overrides, selection, nextflow_max_forks)),
    };

    let metadata_value: serde_json::Value =
        serde_json::from_str(metadata_str).map_err(|e| format!("Invalid run metadata: {}", e))?;

    if let Some(obj) = metadata_value
        .get("input_overrides")
        .and_then(|v| v.as_object())
    {
        for (key, value) in obj {
            if let Some(str_value) = value.as_str() {
                input_overrides.insert(key.clone(), str_value.to_string());
            }
        }
    }
    if let Some(obj) = metadata_value
        .get("parameter_overrides")
        .and_then(|v| v.as_object())
    {
        for (key, value) in obj {
            if let Some(str_value) = value.as_str() {
                input_overrides.insert(key.clone(), str_value.to_string());
            }
        }
    }
    if let Some(value) = metadata_value.get("nextflow_max_forks") {
        nextflow_max_forks = value.as_u64().map(|v| v as u32);
    }
    if let Some(selection_value) = metadata_value.get("data_selection") {
        selection = serde_json::from_value(selection_value.clone()).ok();
    }

    Ok((input_overrides, selection, nextflow_max_forks))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FlowEditorPayload {
    pub flow_id: Option<i64>,
    pub flow_path: String,
    pub spec: Option<FlowSpec>,
    pub modules: Vec<ModuleInfo>, // Available modules for dropdown
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ModuleInfo {
    pub id: i64,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FlowValidationResult {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub diagram: String,
}

#[derive(Debug, Clone)]
enum ShapeExpr {
    String,
    Bool,
    File,
    Directory,
    GenotypeRecord,
    List(Box<ShapeExpr>),
    Map(Box<ShapeExpr>),
    Record(Vec<RecordField>),
}

#[derive(Debug, Clone)]
struct RecordField {
    name: String,
    ty: ShapeExpr,
}

#[derive(Debug, Clone)]
enum DatasetInputValue {
    Path(String),
    Json(serde_json::Value),
}

fn strip_wrapped<'a>(raw: &'a str, prefix: &str, suffix: char) -> Option<&'a str> {
    if raw.len() < prefix.len() + 1 {
        return None;
    }
    if !raw[..prefix.len()].eq_ignore_ascii_case(prefix) {
        return None;
    }
    if !raw.ends_with(suffix) {
        return None;
    }
    Some(raw[prefix.len()..raw.len() - 1].trim())
}

fn split_top_level(raw: &str, delimiter: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth: usize = 0;
    let mut start = 0;
    for (idx, ch) in raw.char_indices() {
        match ch {
            '[' | '{' => depth += 1,
            ']' | '}' => depth = depth.saturating_sub(1),
            _ => {}
        }
        if ch == delimiter && depth == 0 {
            parts.push(raw[start..idx].trim().to_string());
            start = idx + 1;
        }
    }
    parts.push(raw[start..].trim().to_string());
    parts.retain(|part| !part.is_empty());
    parts
}

fn split_top_level_once(raw: &str, delimiter: char) -> Option<(String, String)> {
    let mut depth: usize = 0;
    for (idx, ch) in raw.char_indices() {
        match ch {
            '[' | '{' => depth += 1,
            ']' | '}' => depth = depth.saturating_sub(1),
            _ => {}
        }
        if ch == delimiter && depth == 0 {
            return Some((
                raw[..idx].trim().to_string(),
                raw[idx + 1..].trim().to_string(),
            ));
        }
    }
    None
}

fn parse_shape_expr(raw: &str) -> Option<ShapeExpr> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let base = trimmed.strip_suffix('?').unwrap_or(trimmed).trim();
    if let Some(inner) = strip_wrapped(base, "List[", ']') {
        return Some(ShapeExpr::List(Box::new(parse_shape_expr(inner)?)));
    }
    if let Some(inner) = strip_wrapped(base, "Map[", ']') {
        let parts = split_top_level(inner, ',');
        if parts.len() != 2 {
            return None;
        }
        if !parts[0].eq_ignore_ascii_case("String") {
            return None;
        }
        return Some(ShapeExpr::Map(Box::new(parse_shape_expr(&parts[1])?)));
    }
    if let Some(inner) =
        strip_wrapped(base, "Record{", '}').or_else(|| strip_wrapped(base, "Dict{", '}'))
    {
        if inner.is_empty() {
            return None;
        }
        let mut fields = Vec::new();
        for field in split_top_level(inner, ',') {
            let (name, ty_raw) = split_top_level_once(&field, ':')?;
            if name.is_empty() {
                return None;
            }
            fields.push(RecordField {
                name,
                ty: parse_shape_expr(&ty_raw)?,
            });
        }
        return Some(ShapeExpr::Record(fields));
    }
    match base.to_ascii_lowercase().as_str() {
        "string" => Some(ShapeExpr::String),
        "bool" => Some(ShapeExpr::Bool),
        "file" => Some(ShapeExpr::File),
        "directory" => Some(ShapeExpr::Directory),
        "genotyperecord" => Some(ShapeExpr::GenotypeRecord),
        _ => None,
    }
}

fn lookup_file_path(db: &BioVaultDb, file_id: i64) -> Option<String> {
    db.conn
        .query_row(
            "SELECT file_path FROM files WHERE id = ?1",
            [file_id],
            |row| row.get(0),
        )
        .ok()
}

fn resolve_asset_path(
    db: &BioVaultDb,
    asset: &biovault::data::DatasetAssetRecord,
    data_type: &str,
) -> Option<String> {
    match data_type {
        "mock" => asset
            .mock_path
            .clone()
            .or_else(|| asset.mock_file_id.and_then(|id| lookup_file_path(db, id))),
        "real" => asset.private_path.clone().or_else(|| {
            asset
                .private_file_id
                .and_then(|id| lookup_file_path(db, id))
        }),
        "both" => asset
            .private_path
            .clone()
            .or_else(|| {
                asset
                    .private_file_id
                    .and_then(|id| lookup_file_path(db, id))
            })
            .or_else(|| asset.mock_path.clone())
            .or_else(|| asset.mock_file_id.and_then(|id| lookup_file_path(db, id))),
        _ => asset
            .private_path
            .clone()
            .or_else(|| {
                asset
                    .private_file_id
                    .and_then(|id| lookup_file_path(db, id))
            })
            .or_else(|| asset.mock_path.clone())
            .or_else(|| asset.mock_file_id.and_then(|id| lookup_file_path(db, id))),
    }
}

fn parse_stem_and_ext(path: &str) -> Option<(String, String)> {
    let file_name = Path::new(path).file_name()?.to_string_lossy();
    let dot = file_name.rfind('.')?;
    if dot == 0 {
        return None;
    }
    let stem = file_name[..dot].to_string();
    let ext = file_name[dot + 1..].to_ascii_lowercase();
    Some((stem, ext))
}

fn build_dataset_input_value(
    db: &BioVaultDb,
    assets: &[biovault::data::DatasetAssetRecord],
    data_type: &str,
    shape: &ShapeExpr,
) -> Result<(DatasetInputValue, usize), String> {
    match shape {
        ShapeExpr::File | ShapeExpr::Directory => {
            let path = assets
                .iter()
                .find_map(|asset| resolve_asset_path(db, asset, data_type))
                .ok_or_else(|| "No file found for dataset selection.".to_string())?;
            Ok((DatasetInputValue::Path(path), 1))
        }
        ShapeExpr::Record(fields) => {
            let mut field_lookup = HashMap::new();
            for field in fields {
                if !matches!(field.ty, ShapeExpr::File | ShapeExpr::Directory) {
                    return Err(format!(
                        "Unsupported record field type for '{}'. Only File/Directory are supported.",
                        field.name
                    ));
                }
                field_lookup.insert(field.name.to_ascii_lowercase(), field.name.clone());
            }

            let mut record_map = serde_json::Map::new();
            for asset in assets {
                let path = match resolve_asset_path(db, asset, data_type) {
                    Some(path) => path,
                    None => continue,
                };
                let (_, ext) = match parse_stem_and_ext(&path) {
                    Some(parts) => parts,
                    None => continue,
                };
                if let Some(field_name) = field_lookup.get(&ext) {
                    record_map.insert(field_name.clone(), serde_json::Value::String(path));
                }
            }

            if record_map.is_empty() {
                return Err("No matching files found for record-shaped dataset.".to_string());
            }

            for field_name in field_lookup.values() {
                if !record_map.contains_key(field_name) {
                    return Err(format!(
                        "Dataset is missing required field '{}'.",
                        field_name
                    ));
                }
            }

            Ok((
                DatasetInputValue::Json(serde_json::Value::Object(record_map)),
                field_lookup.len(),
            ))
        }
        ShapeExpr::Map(value) => match value.as_ref() {
            ShapeExpr::File | ShapeExpr::Directory => {
                let mut map = serde_json::Map::new();
                for asset in assets {
                    let path = match resolve_asset_path(db, asset, data_type) {
                        Some(path) => path,
                        None => continue,
                    };
                    let key = if !asset.asset_key.trim().is_empty() {
                        asset.asset_key.clone()
                    } else if let Some((stem, _)) = parse_stem_and_ext(&path) {
                        stem
                    } else {
                        asset.asset_uuid.clone()
                    };
                    if map.contains_key(&key) {
                        return Err(format!("Duplicate dataset asset key '{}'.", key));
                    }
                    map.insert(key, serde_json::Value::String(path));
                }
                if map.is_empty() {
                    return Err("No files found for dataset selection.".to_string());
                }
                let count = map.len();
                Ok((
                    DatasetInputValue::Json(serde_json::Value::Object(map)),
                    count,
                ))
            }
            ShapeExpr::Record(fields) => {
                let mut field_lookup = HashMap::new();
                for field in fields {
                    if !matches!(field.ty, ShapeExpr::File | ShapeExpr::Directory) {
                        return Err(format!(
                            "Unsupported record field type for '{}'. Only File/Directory are supported.",
                            field.name
                        ));
                    }
                    field_lookup.insert(field.name.to_ascii_lowercase(), field.name.clone());
                }

                let mut grouped: HashMap<String, HashMap<String, String>> = HashMap::new();
                for asset in assets {
                    let path = match resolve_asset_path(db, asset, data_type) {
                        Some(path) => path,
                        None => continue,
                    };
                    let (stem, ext) = match parse_stem_and_ext(&path) {
                        Some(parts) => parts,
                        None => continue,
                    };
                    let Some(field_name) = field_lookup.get(&ext) else {
                        continue;
                    };
                    grouped
                        .entry(stem)
                        .or_default()
                        .insert(field_name.clone(), path);
                }

                if grouped.is_empty() {
                    return Err("No matching files found for dataset selection.".to_string());
                }

                let mut outer = serde_json::Map::new();
                for (dataset_name, fields_map) in grouped {
                    for field_name in field_lookup.values() {
                        if !fields_map.contains_key(field_name) {
                            return Err(format!(
                                "Dataset '{}' is missing required field '{}'.",
                                dataset_name, field_name
                            ));
                        }
                    }
                    let mut inner = serde_json::Map::new();
                    for (field_name, path) in fields_map {
                        inner.insert(field_name, serde_json::Value::String(path));
                    }
                    outer.insert(dataset_name, serde_json::Value::Object(inner));
                }

                let file_count = field_lookup.len() * outer.len();
                Ok((
                    DatasetInputValue::Json(serde_json::Value::Object(outer)),
                    file_count,
                ))
            }
            _ => Err("Unsupported Map value type for dataset selection.".to_string()),
        },
        ShapeExpr::List(_) => {
            Err("List-shaped dataset selections should use URL selection.".to_string())
        }
        ShapeExpr::String | ShapeExpr::Bool | ShapeExpr::GenotypeRecord => {
            Err("Unsupported dataset shape for direct dataset selection.".to_string())
        }
    }
}

fn get_flows_dir() -> Result<PathBuf, String> {
    let home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    Ok(home.join("flows"))
}

fn get_modules_dir() -> Result<PathBuf, String> {
    let home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    Ok(home.join("modules"))
}

fn syftbox_storage_from_config(
    config: &biovault::config::Config,
) -> Result<SyftBoxStorage, String> {
    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to get SyftBox data dir: {}", e))?;
    Ok(SyftBoxStorage::new(&data_dir))
}

fn load_flow_spec_from_storage(storage: &SyftBoxStorage, path: &Path) -> Result<FlowSpec, String> {
    let flow = load_flow_file_from_storage(storage, path)?;
    flow.to_flow_spec()
        .map_err(|e| format!("Failed to convert flow spec: {}", e))
}

fn load_flow_file_from_storage(storage: &SyftBoxStorage, path: &Path) -> Result<FlowFile, String> {
    let bytes = storage
        .read_with_shadow(path)
        .map_err(|e| format!("Failed to read flow.yaml: {}", e))?;
    let flow: FlowFile =
        serde_yaml::from_slice(&bytes).map_err(|e| format!("Failed to parse flow.yaml: {}", e))?;
    Ok(flow)
}

fn is_local_source(source: &FlowModuleSource) -> bool {
    if let Some(kind) = source.kind.as_deref() {
        if kind.eq_ignore_ascii_case("local") {
            return true;
        }
    }
    if source.url.is_some() {
        return false;
    }
    source.path.is_some() || source.subpath.is_some()
}

fn local_path_from_source(source: &FlowModuleSource) -> Option<String> {
    if !is_local_source(source) {
        return None;
    }
    if let Some(path) = source.path.as_ref().filter(|p| !p.trim().is_empty()) {
        return Some(path.clone());
    }
    if let Some(path) = source.subpath.as_ref().filter(|p| !p.trim().is_empty()) {
        return Some(path.clone());
    }
    Some(".".to_string())
}

fn module_yaml_exists(module_root: &Path) -> bool {
    if module_root.is_file() {
        return module_root
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|name| matches!(name, "module.yaml" | "module.yml"));
    }
    module_root.join("module.yaml").exists() || module_root.join("module.yml").exists()
}

fn missing_local_module_paths(source_root: &Path, flow: &FlowFile) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();

    for path in &flow.spec.module_paths {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            paths.push(trimmed.to_string());
        }
    }

    for module in flow.spec.modules.values() {
        if let FlowModuleDef::Ref(reference) = module {
            if let Some(source) = reference.source.as_ref() {
                if let Some(path) = local_path_from_source(source) {
                    paths.push(path);
                }
            }
        }
    }

    for step in &flow.spec.steps {
        if let Some(FlowStepUses::Ref(reference)) = step.uses.as_ref() {
            if let Some(source) = reference.source.as_ref() {
                if let Some(path) = local_path_from_source(source) {
                    paths.push(path);
                }
            }
        }
    }

    let mut missing: Vec<String> = Vec::new();
    let mut seen = HashSet::new();

    for raw in paths {
        if !seen.insert(raw.clone()) {
            continue;
        }
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }

        let candidate = Path::new(trimmed);
        let full_path = if candidate.is_absolute() {
            PathBuf::from(candidate)
        } else {
            source_root.join(candidate)
        };

        if !full_path.exists() || !module_yaml_exists(&full_path) {
            missing.push(raw);
        }
    }

    missing
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowRequestSyncStatus {
    pub ready: bool,
    pub source_present: bool,
    pub flow_yaml_present: bool,
    pub missing_paths: Vec<String>,
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn flow_request_sync_status(
    flow_location: String,
) -> Result<FlowRequestSyncStatus, String> {
    let config =
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;
    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to get SyftBox data dir: {}", e))?;
    let storage = syftbox_storage_from_config(&config)?;

    let source_root = biovault::data::resolve_syft_url(&data_dir, &flow_location)
        .map_err(|e| format!("Failed to resolve flow location: {}", e))?;
    if !source_root.exists() {
        return Ok(FlowRequestSyncStatus {
            ready: false,
            source_present: false,
            flow_yaml_present: false,
            missing_paths: Vec::new(),
            reason: Some(
                "Flow files are not synced yet. Click \"Sync Request\" first.".to_string(),
            ),
        });
    }

    let flow_yaml = source_root.join(FLOW_YAML_FILE);
    if !flow_yaml.exists() {
        return Ok(FlowRequestSyncStatus {
            ready: false,
            source_present: true,
            flow_yaml_present: false,
            missing_paths: Vec::new(),
            reason: Some(
                "flow.yaml has not synced yet. Click \"Sync Request\" and try again.".to_string(),
            ),
        });
    }

    let flow_file = load_flow_file_from_storage(&storage, &flow_yaml)?;
    let missing_paths = missing_local_module_paths(&source_root, &flow_file);
    let ready = missing_paths.is_empty();
    let reason = if ready {
        None
    } else {
        Some(format!(
            "Flow dependencies are still syncing. Missing: {}",
            missing_paths.join(", ")
        ))
    };

    Ok(FlowRequestSyncStatus {
        ready,
        source_present: true,
        flow_yaml_present: true,
        missing_paths,
        reason,
    })
}

fn append_flow_log(window: Option<&tauri::WebviewWindow>, log_path: &Path, message: &str) {
    if let Some(parent) = log_path.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            crate::desktop_log!("Failed to ensure flow log directory {:?}: {}", parent, err);
        }
    }

    match OpenOptions::new().create(true).append(true).open(log_path) {
        Ok(mut file) => {
            let _ = writeln!(file, "{}", message);
        }
        Err(err) => {
            crate::desktop_log!(
                "Failed to write flow log at {:?}: {} | message: {}",
                log_path,
                err,
                message
            );
        }
    }

    if let Some(w) = window {
        let _ = w.emit("flow-log-line", message.to_string());
    }
}

#[tauri::command]
pub async fn get_flows(state: tauri::State<'_, AppState>) -> Result<Vec<Flow>, String> {
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    let flows = biovault_db.list_flows().map_err(|e| e.to_string())?;

    for flow in &flows {
        match flow.spec.as_ref() {
            Some(spec) => {
                let input_types: Vec<String> = spec
                    .inputs
                    .iter()
                    .map(|(name, input)| format!("{}:{}", name, input.raw_type()))
                    .collect();
                crate::desktop_log!(
                    "Flow spec debug: '{}' inputs [{}] steps {}",
                    flow.name,
                    input_types.join(", "),
                    spec.steps.len()
                );
            }
            None => {
                crate::desktop_log!(
                    "Flow spec debug: '{}' missing spec (path: {})",
                    flow.name,
                    flow.flow_path
                );
            }
        }
    }

    Ok(flows)
}

#[tauri::command]
pub async fn get_runs_base_dir() -> Result<String, String> {
    let home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    let runs_dir = home.join("runs");
    fs::create_dir_all(&runs_dir).map_err(|e| format!("Failed to create runs directory: {}", e))?;
    Ok(runs_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn create_flow(
    state: tauri::State<'_, AppState>,
    request: FlowCreateRequest,
) -> Result<Flow, String> {
    let FlowCreateRequest {
        mut name,
        directory,
        flow_file,
        overwrite,
    } = request;

    let flows_dir = get_flows_dir()?;
    fs::create_dir_all(&flows_dir)
        .map_err(|e| format!("Failed to create flows directory: {}", e))?;

    let is_import_dir = directory.is_some();
    let mut flow_dir = if let Some(dir) = directory {
        PathBuf::from(dir)
    } else {
        flows_dir.join(&name)
    };

    // If the provided directory points to a file, fall back to its parent directory
    if let Ok(metadata) = fs::metadata(&flow_dir) {
        if metadata.is_file() {
            if let Some(parent) = flow_dir.parent() {
                flow_dir = parent.to_path_buf();
            }
        }
    }

    let mut flow_yaml_path = flow_dir.join(FLOW_YAML_FILE);
    let mut imported_spec: Option<FlowSpec> = None;

    // If importing from a file, always copy to managed directory (like GitHub imports)
    if let Some(flow_file_path) = flow_file {
        let source_flow_yaml_path = PathBuf::from(&flow_file_path);
        if !source_flow_yaml_path.exists() {
            return Err(format!(
                "Selected flow.yaml does not exist at {}",
                source_flow_yaml_path.display()
            ));
        }

        // Load flow spec from source
        let yaml_str = fs::read_to_string(&source_flow_yaml_path)
            .map_err(|e| format!("Failed to read flow.yaml: {}", e))?;
        let flow = FlowFile::parse_yaml(&yaml_str)
            .map_err(|e| format!("Failed to parse flow.yaml: {}", e))?;
        if flow.kind != "Flow" {
            return Err(format!("Expected Flow kind but found '{}'", flow.kind));
        }
        name = flow.metadata.name.clone();

        // Copy to managed directory (like GitHub imports do)
        let source_parent = source_flow_yaml_path.parent().ok_or_else(|| {
            format!(
                "Unable to determine parent directory for {}",
                source_flow_yaml_path.display()
            )
        })?;

        // Create flow directory in managed location
        let managed_flow_dir = flows_dir.join(&name);

        if managed_flow_dir.exists() {
            if overwrite {
                fs::remove_dir_all(&managed_flow_dir)
                    .map_err(|e| format!("Failed to remove existing flow directory: {}", e))?;
            } else {
                return Err(format!(
                    "Flow '{}' already exists at {}. Use overwrite to replace.",
                    name,
                    managed_flow_dir.display()
                ));
            }
        }

        fs::create_dir_all(&managed_flow_dir)
            .map_err(|e| format!("Failed to create flow directory: {}", e))?;

        flow_dir = managed_flow_dir.clone();
        flow_yaml_path = managed_flow_dir.join(FLOW_YAML_FILE);

        // Resolve and import dependencies
        // Use spawn_blocking because BioVaultDb is not Send
        // base_path is the directory containing flow.yaml (where module.yaml might also be)
        let dependency_context = DependencyContext::Local {
            base_path: source_parent.to_path_buf(), // This is already the directory containing flow.yaml
        };
        let flow_yaml_path_clone = flow_yaml_path.clone();

        let flow_result = tauri::async_runtime::spawn_blocking(move || {
            tauri::async_runtime::block_on(async {
                let spec = FlowFile::parse_yaml(&yaml_str)
                    .map_err(|e| format!("Failed to parse flow.yaml: {}", e))?;
                let mut spec = spec
                    .to_flow_spec()
                    .map_err(|e| format!("Failed to convert flow spec: {}", e))?;
                resolve_flow_dependencies(
                    &mut spec,
                    &dependency_context,
                    &flow_yaml_path_clone,
                    overwrite,
                    true, // quiet = true for Tauri (no console output)
                )
                .await
                .map_err(|e| e.to_string())?;
                Ok::<FlowSpec, String>(spec)
            })
        })
        .await
        .map_err(|e| format!("Failed to spawn dependency resolution: {}", e))?;

        let spec = flow_result.map_err(|e| format!("Failed to resolve dependencies: {}", e))?;

        // Note: resolve_flow_dependencies already saves the spec (with description preserved)
        imported_spec = Some(spec);
    } else {
        fs::create_dir_all(&flow_dir)
            .map_err(|e| format!("Failed to create flow directory: {}", e))?;

        crate::desktop_log!(
            "create_flow debug: name='{}' dir_present={} flow_yaml_exists={} overwrite={} path={}",
            name,
            is_import_dir,
            flow_yaml_path.exists(),
            overwrite,
            flow_yaml_path.display()
        );

        if flow_yaml_path.exists() {
            if is_import_dir {
                imported_spec = FlowSpec::load(&flow_yaml_path).ok();
            } else if !overwrite {
                return Err(format!(
                    "flow.yaml already exists at {}",
                    flow_yaml_path.display()
                ));
            }
        } else if is_import_dir {
            return Err(format!("flow.yaml not found in {}", flow_dir.display()));
        }

        if !flow_yaml_path.exists() || (!is_import_dir && overwrite) {
            crate::desktop_log!(
                "create_flow debug: writing default flow.yaml to {}",
                flow_yaml_path.display()
            );
            let default_spec = FlowSpec {
                name: name.clone(),
                description: None,
                multiparty: None,
                roles: Vec::new(),
                context: None,
                vars: Default::default(),
                coordination: None,
                mpc: None,
                inputs: Default::default(),
                steps: Vec::new(),
                datasites: Vec::new(),
            };
            let flow = FlowFile::from_flow_spec(&default_spec)
                .map_err(|e| format!("Failed to build default flow spec: {}", e))?;
            let yaml = serde_yaml::to_string(&flow)
                .map_err(|e| format!("Failed to serialize flow.yaml: {}", e))?;
            fs::write(&flow_yaml_path, yaml)
                .map_err(|e| format!("Failed to write flow.yaml: {}", e))?;
        }
    }

    let flow_dir_str = flow_dir.to_string_lossy().to_string();
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;

    if overwrite {
        let existing = biovault_db
            .list_flows()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|p| p.name == name || p.flow_path == flow_dir_str);

        if let Some(existing_flow) = existing {
            biovault_db
                .delete_flow(existing_flow.id)
                .map_err(|e| e.to_string())?;
        }
    }

    // Register in database using CLI library
    let id = biovault_db
        .register_flow(&name, &flow_dir_str)
        .map_err(|e| e.to_string())?;

    let timestamp = chrono::Local::now().to_rfc3339();

    Ok(Flow {
        id,
        name,
        flow_path: flow_dir_str,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        spec: imported_spec,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportFlowFromJsonRequest {
    pub name: String,
    pub flow_json: serde_json::Value,
    #[serde(default)]
    pub overwrite: bool,
}

#[tauri::command]
pub async fn import_flow_from_json(
    state: tauri::State<'_, AppState>,
    request: ImportFlowFromJsonRequest,
) -> Result<Flow, String> {
    let ImportFlowFromJsonRequest {
        name,
        flow_json,
        overwrite,
    } = request;

    let flows_dir = get_flows_dir()?;
    fs::create_dir_all(&flows_dir)
        .map_err(|e| format!("Failed to create flows directory: {}", e))?;

    let flow_dir = flows_dir.join(&name);

    // Always allow overwrite for invitation imports - check DB first
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    let flow_dir_str = flow_dir.to_string_lossy().to_string();

    // Check if flow already exists in DB
    let existing = biovault_db
        .list_flows()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| p.name == name || p.flow_path == flow_dir_str);

    if let Some(existing_flow) = existing {
        // Flow already exists - return it (no need to re-import)
        if !overwrite {
            return Ok(existing_flow);
        }
        // Delete existing for overwrite
        biovault_db
            .delete_flow(existing_flow.id)
            .map_err(|e| e.to_string())?;
    }

    if flow_dir.exists() && overwrite {
        fs::remove_dir_all(&flow_dir)
            .map_err(|e| format!("Failed to remove existing flow directory: {}", e))?;
    }

    fs::create_dir_all(&flow_dir)
        .map_err(|e| format!("Failed to create flow directory: {}", e))?;

    // The flow_json might be a Flow object (from get_flows) or a FlowFile
    // Try to extract the spec and build a proper FlowFile
    let flow_file: FlowFile = if flow_json.get("apiVersion").is_some() {
        // It's already a FlowFile format
        serde_json::from_value(flow_json.clone())
            .map_err(|e| format!("Failed to parse FlowFile JSON: {}", e))?
    } else if let Some(spec_value) = flow_json.get("spec") {
        // It's a Flow object with a spec field - reconstruct FlowFile
        let spec: FlowSpec = serde_json::from_value(spec_value.clone())
            .map_err(|e| format!("Failed to parse FlowSpec: {}", e))?;
        FlowFile::from_flow_spec(&spec)
            .map_err(|e| format!("Failed to build FlowFile from spec: {}", e))?
    } else {
        // Try to parse as FlowSpec directly
        let spec: FlowSpec = serde_json::from_value(flow_json.clone())
            .map_err(|e| format!("Failed to parse as FlowSpec: {}", e))?;
        FlowFile::from_flow_spec(&spec)
            .map_err(|e| format!("Failed to build FlowFile from spec: {}", e))?
    };

    let yaml_content = serde_yaml::to_string(&flow_file)
        .map_err(|e| format!("Failed to convert flow to YAML: {}", e))?;

    let flow_yaml_path = flow_dir.join(FLOW_YAML_FILE);
    fs::write(&flow_yaml_path, &yaml_content)
        .map_err(|e| format!("Failed to write flow.yaml: {}", e))?;

    // Parse spec for return value
    let imported_spec = flow_file.to_flow_spec().ok();

    let id = biovault_db
        .register_flow(&name, &flow_dir_str)
        .map_err(|e| e.to_string())?;

    let timestamp = chrono::Local::now().to_rfc3339();

    Ok(Flow {
        id,
        name,
        flow_path: flow_dir_str,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        spec: imported_spec,
    })
}

#[tauri::command]
pub async fn load_flow_editor(
    state: tauri::State<'_, AppState>,
    flow_id: Option<i64>,
    flow_path: Option<String>,
) -> Result<FlowEditorPayload, String> {
    let path = if let Some(id) = flow_id {
        // Load from database using CLI library
        let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
        let flow = biovault_db
            .get_flow(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Flow {} not found", id))?;
        PathBuf::from(flow.flow_path)
    } else if let Some(p) = flow_path {
        PathBuf::from(p)
    } else {
        return Err("Either flow_id or flow_path must be provided".to_string());
    };

    let yaml_path = path.join(FLOW_YAML_FILE);

    // Load flow spec if file exists
    let spec = if yaml_path.exists() {
        let content = fs::read_to_string(&yaml_path)
            .map_err(|e| format!("Failed to read flow.yaml: {}", e))?;
        let flow = FlowFile::parse_yaml(&content).ok();
        flow.and_then(|f| f.to_flow_spec().ok())
    } else {
        None
    };

    // Get available modules from database using CLI library
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    let modules_list = biovault_db.list_modules().map_err(|e| e.to_string())?;
    drop(biovault_db); // Release lock

    let modules = modules_list
        .iter()
        .map(|p| ModuleInfo {
            id: p.id,
            name: p.name.clone(),
            path: p.module_path.clone(),
        })
        .collect::<Vec<_>>();

    Ok(FlowEditorPayload {
        flow_id,
        flow_path: path.to_string_lossy().to_string(),
        spec,
        modules,
    })
}

#[tauri::command]
pub async fn save_flow_editor(
    state: tauri::State<'_, AppState>,
    flow_id: Option<i64>,
    flow_path: String,
    spec: FlowSpec,
) -> Result<Flow, String> {
    let path = PathBuf::from(&flow_path);
    let yaml_path = path.join(FLOW_YAML_FILE);

    let flow = FlowFile::from_flow_spec(&spec)
        .map_err(|e| format!("Failed to convert flow spec to flow: {}", e))?;
    let yaml_content = serde_yaml::to_string(&flow)
        .map_err(|e| format!("Failed to serialize flow.yaml: {}", e))?;

    fs::write(&yaml_path, yaml_content).map_err(|e| format!("Failed to write flow.yaml: {}", e))?;

    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;

    // Update or insert into database using CLI library
    if let Some(id) = flow_id {
        // Update timestamp using CLI library
        biovault_db.touch_flow(id).map_err(|e| e.to_string())?;

        // Get updated record
        biovault_db
            .get_flow(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Flow not found after update".to_string())
    } else {
        // Register new flow
        let id = biovault_db
            .register_flow(&spec.name, &flow_path)
            .map_err(|e| e.to_string())?;

        Ok(Flow {
            id,
            name: spec.name.clone(),
            flow_path: flow_path.clone(),
            created_at: chrono::Local::now().to_rfc3339(),
            updated_at: chrono::Local::now().to_rfc3339(),
            spec: Some(spec), // Return the spec that was just saved
        })
    }
}

#[tauri::command]
pub async fn delete_flow(state: tauri::State<'_, AppState>, flow_id: i64) -> Result<(), String> {
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;

    // Get flow before deleting
    let flow = biovault_db.get_flow(flow_id).map_err(|e| e.to_string())?;

    if let Some(p) = flow {
        // Delete from database using CLI library
        biovault_db
            .delete_flow(flow_id)
            .map_err(|e| e.to_string())?;

        // Delete directory if it exists and is in the flows folder
        let flows_dir = get_flows_dir()?;
        let path_buf = PathBuf::from(p.flow_path);

        // Only delete if the path is within the flows directory
        if path_buf.starts_with(&flows_dir) && path_buf.exists() {
            fs::remove_dir_all(&path_buf)
                .map_err(|e| format!("Failed to delete flow directory: {}", e))?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn validate_flow(flow_path: String) -> Result<FlowValidationResult, String> {
    use std::process::Command as ProcessCommand;

    let flow_path = PathBuf::from(&flow_path).join(FLOW_YAML_FILE);
    let target = flow_path.to_string_lossy().to_string();

    let mut cmd = ProcessCommand::new("bv");
    cmd.args(["flow", "validate", "--diagram", &target]);
    super::hide_console_window(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run bv validate: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if output.status.success() {
        Ok(FlowValidationResult {
            valid: true,
            errors: vec![],
            warnings: vec![],
            diagram: stdout.to_string(),
        })
    } else {
        let errors = stderr
            .lines()
            .filter(|line| line.contains("ERROR"))
            .map(|s| s.to_string())
            .collect();

        let warnings = stderr
            .lines()
            .filter(|line| line.contains("WARNING"))
            .map(|s| s.to_string())
            .collect();

        Ok(FlowValidationResult {
            valid: false,
            errors,
            warnings,
            diagram: stdout.to_string(),
        })
    }
}

#[tauri::command]
pub async fn run_flow(
    state: tauri::State<'_, AppState>,
    window: tauri::WebviewWindow,
    flow_id: i64,
    input_overrides: HashMap<String, String>,
    results_dir: Option<String>,
    selection: Option<FlowRunSelection>,
    nextflow_max_forks: Option<u32>,
    resume: Option<bool>,
) -> Result<Run, String> {
    run_flow_impl(
        state,
        Some(window),
        flow_id,
        input_overrides,
        results_dir,
        selection,
        None,
        nextflow_max_forks,
        resume.unwrap_or(false),
        None,
    )
    .await
}

/// Internal implementation that takes an optional window (for WS bridge mode)
pub async fn run_flow_impl(
    state: tauri::State<'_, AppState>,
    window: Option<tauri::WebviewWindow>,
    flow_id: i64,
    mut input_overrides: HashMap<String, String>,
    results_dir: Option<String>,
    selection: Option<FlowRunSelection>,
    run_id: Option<String>,
    nextflow_max_forks: Option<u32>,
    resume: bool,
    existing_run_id: Option<i64>,
) -> Result<Run, String> {
    use chrono::Local;

    let home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;

    let mut selection_metadata: Option<serde_json::Value> = None;
    let mut selection_counts: Option<(usize, usize)> = None;
    let mut generated_samplesheet_path: Option<String> = None;

    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;

    // Get flow using CLI library
    let flow = biovault_db
        .get_flow(flow_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Flow {} not found", flow_id))?;

    let flow_name = flow.name.clone();
    let flow_path = flow.flow_path.clone();

    let mut existing_run: Option<Run> = None;
    if let Some(existing_id) = existing_run_id {
        existing_run = biovault_db
            .get_flow_run(existing_id)
            .map_err(|e| e.to_string())?;
    }

    let yaml_path = PathBuf::from(&flow_path).join(FLOW_YAML_FILE);

    // Generate results directory
    let timestamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let results_path = if let Some(run) = existing_run.as_ref() {
        run.results_dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(&run.work_dir))
    } else if let Some(dir) = &results_dir {
        PathBuf::from(dir)
    } else {
        home.join("runs").join(format!("flow_{}", timestamp))
    };

    // Create results directory
    fs::create_dir_all(&results_path)
        .map_err(|e| format!("Failed to create results directory: {}", e))?;

    let log_path = results_path.join("flow.log");
    append_flow_log(
        window.as_ref(),
        &log_path,
        &format!("📦 Flow: {}", flow_name),
    );
    append_flow_log(
        window.as_ref(),
        &log_path,
        &format!("📂 Results directory: {}", results_path.display()),
    );
    let _ = fs::remove_file(flow_pause_marker(&results_path));

    if let Some(sel) = &selection {
        append_flow_log(
            window.as_ref(),
            &log_path,
            &format!(
                "🔍 Selection payload: files={} participants={} dataset={}",
                sel.file_ids.len(),
                sel.participant_ids.len(),
                sel.dataset_name
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("none")
            ),
        );
    } else {
        append_flow_log(
            window.as_ref(),
            &log_path,
            "🔍 Selection payload: none provided",
        );
    }

    if let Some(sel) = selection {
        let FlowRunSelection {
            file_ids,
            urls,
            participant_ids,
            dataset_name,
            dataset_shape,
            dataset_data_type,
            dataset_owner,
            asset_keys,
            data_type,
            data_source,
        } = sel;

        // Filter empty strings
        let dataset_owner = dataset_owner.filter(|v| !v.trim().is_empty());
        let data_type_sel = data_type.filter(|v| !v.trim().is_empty());
        let data_source = data_source.filter(|v| !v.trim().is_empty());
        let asset_keys: Vec<String> = asset_keys
            .into_iter()
            .filter(|v| !v.trim().is_empty())
            .collect();

        let apply_selection_context = |selection: &mut serde_json::Value| {
            if let Some(map) = selection.as_object_mut() {
                if let Some(value) = dataset_owner.clone() {
                    map.insert("dataset_owner".to_string(), serde_json::json!(value));
                }
                if !asset_keys.is_empty() {
                    map.insert(
                        "asset_keys".to_string(),
                        serde_json::json!(asset_keys.clone()),
                    );
                }
                if let Some(value) = data_type_sel.clone() {
                    map.insert("data_type".to_string(), serde_json::json!(value));
                }
                if let Some(value) = data_source.clone() {
                    map.insert("data_source".to_string(), serde_json::json!(value));
                }
            }
        };

        // Prefer URLs over file_ids (URLs are the new way, file_ids are legacy)
        let use_urls = !urls.is_empty();
        let use_file_ids = !file_ids.is_empty() && !use_urls;
        let dataset_name = dataset_name.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });
        let mut dataset_handled = false;

        // For network datasets (from other users), skip local DB lookup and use URLs directly
        let is_network_dataset = data_source.as_deref() == Some("network_dataset");

        // When dataset_name is provided, try the dataset path first (regardless of URLs/file_ids)
        // This properly handles Map/Record-shaped datasets like GWAS (Map[String, Record{bed, bim, fam}])
        // Skip for network datasets which don't exist in local DB
        if let Some(dataset_name) = dataset_name.clone() {
            if is_network_dataset {
                eprintln!(
                    "[flow] Skipping local DB lookup for network dataset '{}', using URLs instead",
                    dataset_name
                );
            } else {
                let data_type = dataset_data_type
                    .clone()
                    .unwrap_or_else(|| "mock".to_string());
                let (dataset_record, dataset_assets) =
                    biovault::data::get_dataset_with_assets(&biovault_db, &dataset_name)
                        .map_err(|e| format!("Failed to load dataset '{}': {}", dataset_name, e))?
                        .ok_or_else(|| format!("Dataset '{}' not found", dataset_name))?;

                let manifest =
                    biovault::data::build_manifest_from_db(&dataset_record, &dataset_assets);
                let shape = dataset_shape
                    .clone()
                    .and_then(|value| {
                        let trimmed = value.trim();
                        if trimmed.is_empty() {
                            None
                        } else {
                            Some(trimmed.to_string())
                        }
                    })
                    .or_else(|| biovault::cli::commands::datasets::infer_dataset_shape(&manifest))
                    .ok_or_else(|| {
                        format!(
                            "Dataset '{}' does not declare a shape and none could be inferred.",
                            dataset_name
                        )
                    })?;

                let shape_expr = parse_shape_expr(&shape).ok_or_else(|| {
                    format!("Unsupported dataset shape '{}' for selection.", shape)
                })?;

                // List-shaped datasets need URL selection, fall through to URL/file_id paths
                if let ShapeExpr::List(inner_type) = &shape_expr {
                    eprintln!(
                    "[flow] Dataset '{}' has List shape (item type: {:?}), using URL selection path",
                    dataset_name, inner_type
                );
                } else {
                    let spec = FlowSpec::load(&yaml_path)
                        .map_err(|e| format!("Failed to load flow spec: {}", e))?;
                    let input_name = spec
                        .inputs
                        .iter()
                        .find(|(_, input_spec)| {
                            biovault::module_spec::types_compatible(&shape, input_spec.raw_type())
                        })
                        .map(|(name, _)| name.clone())
                        .ok_or_else(|| {
                            format!("Flow does not declare an input compatible with '{}'", shape)
                        })?;

                    let (dataset_value, file_count) = build_dataset_input_value(
                        &biovault_db,
                        &dataset_assets,
                        &data_type,
                        &shape_expr,
                    )?;

                    let dataset_count = match &shape_expr {
                        ShapeExpr::Map(_) => match &dataset_value {
                            DatasetInputValue::Json(serde_json::Value::Object(map)) => map.len(),
                            _ => 0,
                        },
                        ShapeExpr::Record(_) | ShapeExpr::File | ShapeExpr::Directory => 1,
                        _ => 0,
                    };

                    let input_path = match dataset_value {
                        DatasetInputValue::Path(path) => path,
                        DatasetInputValue::Json(value) => {
                            let inputs_dir = results_path.join("inputs");
                            fs::create_dir_all(&inputs_dir).map_err(|e| {
                                format!("Failed to prepare inputs directory for dataset: {}", e)
                            })?;
                            let dataset_path =
                                inputs_dir.join(format!("{}_input.json", input_name));
                            let payload = serde_json::to_string_pretty(&value)
                                .map_err(|e| format!("Failed to serialize dataset map: {}", e))?;
                            fs::write(&dataset_path, payload)
                                .map_err(|e| format!("Failed to write dataset map: {}", e))?;
                            dataset_path.to_string_lossy().to_string()
                        }
                    };

                    input_overrides.insert(format!("inputs.{}", input_name), input_path.clone());

                    selection_counts = Some((file_count, dataset_count));

                    selection_metadata = Some(serde_json::json!({
                        "dataset_name": dataset_name,
                        "dataset_shape": shape,
                        "dataset_data_type": data_type,
                        "dataset_input": input_name,
                        "dataset_input_path": input_path,
                        "dataset_count": dataset_count,
                        "file_count": file_count,
                    }));

                    dataset_handled = true;
                }
                // If List-shaped, fall through to URL/file_id handling below
            }
        }

        if dataset_handled {
            // dataset selection handled, skip legacy flows
        } else if use_urls {
            // Resolve syft:// URLs to local paths
            let config = biovault::config::Config::load()
                .map_err(|e| format!("Failed to load config: {}", e))?;
            let data_dir = config
                .get_syftbox_data_dir()
                .map_err(|e| format!("Failed to get SyftBox data dir: {}", e))?;

            let mut seen_urls = HashSet::new();
            let mut unique_urls = Vec::new();
            for url in urls {
                if seen_urls.insert(url.clone()) {
                    unique_urls.push(url);
                }
            }

            if unique_urls.is_empty() {
                return Err("No valid URLs were provided for the flow run.".to_string());
            }

            let mut rows = Vec::new();
            let mut participant_labels_set: HashSet<String> = HashSet::new();
            let mut resolved_count = 0;

            for (idx, url) in unique_urls.iter().enumerate() {
                let local_path = biovault::data::resolve_syft_url(&data_dir, url)
                    .map_err(|e| format!("Failed to resolve URL '{}': {}", url, e))?;

                if !local_path.exists() {
                    append_flow_log(
                        window.as_ref(),
                        &log_path,
                        &format!("⚠️  File not found for URL: {} -> {:?}", url, local_path),
                    );
                    continue;
                }

                resolved_count += 1;
                let file_path = local_path.to_string_lossy().to_string();

                // Use participant_id from selection if provided, otherwise extract from filename
                let participant = if idx < participant_ids.len() && !participant_ids[idx].is_empty()
                {
                    participant_ids[idx].clone()
                } else {
                    local_path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("unknown")
                        .to_string()
                };

                participant_labels_set.insert(participant.clone());
                rows.push((participant, file_path));
            }

            if rows.is_empty() {
                return Err("No files could be resolved from the provided URLs.".to_string());
            }

            let inputs_dir = results_path.join("inputs");
            fs::create_dir_all(&inputs_dir).map_err(|e| {
                format!("Failed to prepare inputs directory for samplesheet: {}", e)
            })?;
            let sheet_path = inputs_dir.join("selected_participants.csv");

            let mut writer = csv::Writer::from_path(&sheet_path)
                .map_err(|e| format!("Failed to create samplesheet: {}", e))?;
            writer
                .write_record(["participant_id", "genotype_file"])
                .map_err(|e| format!("Failed to write samplesheet header: {}", e))?;

            for (participant, file_path) in &rows {
                writer
                    .write_record([participant, file_path])
                    .map_err(|e| format!("Failed to write samplesheet entry: {}", e))?;
            }
            writer
                .flush()
                .map_err(|e| format!("Failed to finalize samplesheet: {}", e))?;

            let mut participant_labels: Vec<String> = participant_labels_set.into_iter().collect();
            participant_labels.sort();

            let participant_total = participant_labels.len();
            selection_counts = Some((resolved_count, participant_total));

            input_overrides.insert(
                "inputs.samplesheet".to_string(),
                sheet_path.to_string_lossy().to_string(),
            );

            generated_samplesheet_path = Some(sheet_path.to_string_lossy().to_string());

            let file_paths: Vec<String> = rows.iter().map(|(_, path)| path.clone()).collect();
            let mut selection_value = serde_json::json!({
                "urls": unique_urls,
                "participant_ids": participant_ids,
                "participant_labels": participant_labels,
                "samplesheet_path": sheet_path.to_string_lossy(),
                "participant_count": participant_total,
                "file_paths": file_paths,
            });
            apply_selection_context(&mut selection_value);
            selection_metadata = Some(selection_value);
        } else if use_file_ids {
            // Legacy: use file_ids (deprecated)
            let mut seen_files = HashSet::new();
            let mut unique_file_ids = Vec::new();
            for id in file_ids {
                if seen_files.insert(id) {
                    unique_file_ids.push(id);
                }
            }

            if unique_file_ids.is_empty() {
                return Err("No valid file IDs were provided for the flow run.".to_string());
            }

            let mut rows = Vec::new();
            let mut participant_labels_set: HashSet<String> = HashSet::new();

            for file_id in &unique_file_ids {
                let record = biovault::data::get_file_by_id(&biovault_db, *file_id)
                    .map_err(|e| format!("Failed to load file {}: {}", file_id, e))?
                    .ok_or_else(|| format!("File {} not found in the BioVault catalog", file_id))?;

                if record.file_path.trim().is_empty() {
                    return Err(format!(
                        "File {} does not have a recorded path in the catalog.",
                        file_id
                    ));
                }

                let participant = record
                    .participant_id
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| {
                        Path::new(&record.file_path)
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("unknown")
                            .to_string()
                    });

                participant_labels_set.insert(participant.clone());
                rows.push((participant, record.file_path));
            }

            let dedup_participant_ids: Vec<String> = {
                let mut seen = HashSet::new();
                participant_ids
                    .into_iter()
                    .filter(|id| seen.insert(id.clone()))
                    .collect()
            };

            let inputs_dir = results_path.join("inputs");
            fs::create_dir_all(&inputs_dir).map_err(|e| {
                format!("Failed to prepare inputs directory for samplesheet: {}", e)
            })?;
            let sheet_path = inputs_dir.join("selected_participants.csv");

            let mut writer = csv::Writer::from_path(&sheet_path)
                .map_err(|e| format!("Failed to create samplesheet: {}", e))?;
            writer
                .write_record(["participant_id", "genotype_file"])
                .map_err(|e| format!("Failed to write samplesheet header: {}", e))?;

            for (participant, file_path) in &rows {
                writer
                    .write_record([participant, file_path])
                    .map_err(|e| format!("Failed to write samplesheet entry: {}", e))?;
            }
            writer
                .flush()
                .map_err(|e| format!("Failed to finalize samplesheet: {}", e))?;

            let mut participant_labels: Vec<String> = participant_labels_set.into_iter().collect();
            participant_labels.sort();

            let participant_total = participant_labels.len();
            selection_counts = Some((unique_file_ids.len(), participant_total));

            input_overrides.insert(
                "inputs.samplesheet".to_string(),
                sheet_path.to_string_lossy().to_string(),
            );

            generated_samplesheet_path = Some(sheet_path.to_string_lossy().to_string());

            let participant_count = participant_labels.len();
            let file_paths: Vec<String> = rows.iter().map(|(_, path)| path.clone()).collect();
            let mut selection_value = serde_json::json!({
                "file_ids": unique_file_ids,
                "participant_ids": dedup_participant_ids,
                "participant_labels": participant_labels,
                "samplesheet_path": sheet_path.to_string_lossy(),
                "participant_count": participant_count,
                "file_paths": file_paths,
            });
            apply_selection_context(&mut selection_value);
            selection_metadata = Some(selection_value);
        }
    }

    if let Some((file_count, participant_count)) = selection_counts {
        append_flow_log(
            window.as_ref(),
            &log_path,
            &format!(
                "📥 Inputs: {} file(s), {} participant(s)",
                file_count, participant_count
            ),
        );
    }

    if let Some(path) = &generated_samplesheet_path {
        append_flow_log(
            window.as_ref(),
            &log_path,
            &format!("📝 Generated samplesheet: {}", path),
        );
    }

    // Separate inputs from parameters for metadata storage
    let mut inputs_map = HashMap::new();
    let mut params_map = HashMap::new();

    for (key, value) in &input_overrides {
        if key.starts_with("inputs.") {
            inputs_map.insert(key.clone(), value.clone());
        } else {
            params_map.insert(key.clone(), value.clone());
        }
    }

    // Create metadata JSON
    let mut metadata_root = serde_json::Map::new();
    metadata_root.insert("input_overrides".to_string(), serde_json::json!(inputs_map));
    metadata_root.insert(
        "parameter_overrides".to_string(),
        serde_json::json!(params_map),
    );
    if let Some(value) = nextflow_max_forks {
        metadata_root.insert("nextflow_max_forks".to_string(), serde_json::json!(value));
    }
    if let Some(selection_json) = selection_metadata {
        metadata_root.insert("data_selection".to_string(), selection_json);
    }
    let metadata_value = serde_json::Value::Object(metadata_root);
    let metadata_str = serde_json::to_string(&metadata_value)
        .map_err(|e| format!("Failed to serialize metadata: {}", e))?;

    let mut extra_args = Vec::new();
    for (key, value) in &input_overrides {
        extra_args.push("--set".to_string());
        extra_args.push(format!("{}={}", key, value));
    }
    if let Some(value) = nextflow_max_forks {
        extra_args.push("--nxf-max-forks".to_string());
        extra_args.push(value.to_string());
    }

    let yaml_path_str = yaml_path.to_string_lossy().to_string();
    let results_dir_str = results_path.to_string_lossy().to_string();

    // Build command preview for logging
    let quote_arg = |arg: &str| -> String {
        if arg.is_empty() {
            "\"\"".to_string()
        } else if arg
            .chars()
            .any(|c| c.is_whitespace() || c == '"' || c == '\'')
        {
            let escaped = arg.replace('\\', "\\\\").replace('"', "\\\"");
            format!("\"{}\"", escaped)
        } else {
            arg.to_string()
        }
    };

    let mut command_preview = format!("bv flow run {}", quote_arg(&yaml_path_str));
    for arg in &extra_args {
        command_preview.push(' ');
        command_preview.push_str(&quote_arg(arg));
    }
    command_preview.push(' ');
    command_preview.push_str("--results-dir ");
    command_preview.push_str(&quote_arg(&results_dir_str));

    append_flow_log(
        window.as_ref(),
        &log_path,
        &format!("▶️  Command: {}", command_preview),
    );

    // Create flow run record using CLI library with metadata (or reuse existing run)
    let (run_db_id, run_record) = if let Some(run) = existing_run {
        let _ = biovault_db.update_flow_run_status(run.id, "running", true);
        (run.id, run)
    } else {
        let run_db_id = biovault_db
            .create_flow_run_with_metadata(
                flow_id,
                &results_path.to_string_lossy(),
                Some(&results_path.to_string_lossy()),
                Some(&metadata_str),
            )
            .map_err(|e| e.to_string())?;

        let run_record = biovault_db
            .get_flow_run(run_db_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Flow run record not found after creation".to_string())?;
        (run_db_id, run_record)
    };

    drop(biovault_db); // Release lock

    // Spawn async task to run flow (so we can return immediately)
    let window_clone = window.clone();
    let biovault_db_clone = state.biovault_db.clone();
    let run_id_clone = run_db_id;
    let log_path_clone = log_path.clone();
    let flow_name_clone = flow_name.clone();
    let yaml_path_spawn = yaml_path_str.clone();
    let results_dir_spawn = results_dir_str.clone();
    let extra_args_spawn = extra_args.clone();
    let resume_flag = resume;

    let run_id_override = run_id
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    tauri::async_runtime::spawn(async move {
        append_flow_log(
            window_clone.as_ref(),
            &log_path_clone,
            &format!("🚀 Starting flow run: {}", flow_name_clone),
        );
        append_flow_log(
            window_clone.as_ref(),
            &log_path_clone,
            &format!("📄 Flow YAML: {}", yaml_path_spawn),
        );
        append_flow_log(
            window_clone.as_ref(),
            &log_path_clone,
            &format!("📂 Results dir: {}", results_dir_spawn),
        );
        append_flow_log(
            window_clone.as_ref(),
            &log_path_clone,
            &format!("🔧 Extra args: {:?}", extra_args_spawn),
        );
        append_flow_env_var(
            window_clone.as_ref(),
            &log_path_clone,
            "BIOVAULT_CONTAINER_RUNTIME",
        );
        append_flow_env_var(
            window_clone.as_ref(),
            &log_path_clone,
            "BIOVAULT_BUNDLED_NEXTFLOW",
        );
        append_flow_env_var(
            window_clone.as_ref(),
            &log_path_clone,
            "BIOVAULT_DOCKER_CONFIG",
        );
        probe_container_runtime(window_clone.as_ref(), &log_path_clone);
        if let Some(value) = nextflow_max_forks {
            append_flow_log(
                window_clone.as_ref(),
                &log_path_clone,
                &format!("🧵 Nextflow maxForks: {}", value),
            );
        }
        if resume_flag {
            append_flow_log(
                window_clone.as_ref(),
                &log_path_clone,
                "↩️  Resuming flow run with Nextflow cache",
            );
        }

        // Call CLI library function directly
        let previous_run_id = std::env::var("BIOVAULT_FLOW_RUN_ID").ok();
        if let Some(run_id) = run_id_override.as_ref() {
            std::env::set_var("BIOVAULT_FLOW_RUN_ID", run_id);
            append_flow_log(
                window_clone.as_ref(),
                &log_path_clone,
                &format!("🔧 Using BIOVAULT_FLOW_RUN_ID={}", run_id),
            );
        }

        let previous_desktop_log = std::env::var("BIOVAULT_DESKTOP_LOG_FILE").ok();
        std::env::set_var(
            "BIOVAULT_DESKTOP_LOG_FILE",
            log_path_clone.to_string_lossy().to_string(),
        );
        let previous_pid_file = std::env::var("BIOVAULT_FLOW_PID_FILE").ok();
        let pid_path = PathBuf::from(&results_dir_spawn).join("flow.pid");
        std::env::set_var(
            "BIOVAULT_FLOW_PID_FILE",
            pid_path.to_string_lossy().to_string(),
        );
        append_flow_log(
            window_clone.as_ref(),
            &log_path_clone,
            &format!(
                "📝 Streaming Nextflow logs to {}",
                log_path_clone.to_string_lossy()
            ),
        );

        let pause_marker_path = PathBuf::from(&results_dir_spawn).join(".flow.pause");
        let result = cli_run_flow(
            &yaml_path_spawn,
            extra_args_spawn.clone(),
            false, // dry_run
            resume_flag,
            Some(results_dir_spawn.clone()),
        )
        .await;

        match previous_desktop_log {
            Some(prev) => std::env::set_var("BIOVAULT_DESKTOP_LOG_FILE", prev),
            None => std::env::remove_var("BIOVAULT_DESKTOP_LOG_FILE"),
        }
        match previous_pid_file {
            Some(prev) => std::env::set_var("BIOVAULT_FLOW_PID_FILE", prev),
            None => std::env::remove_var("BIOVAULT_FLOW_PID_FILE"),
        }

        match (run_id_override.as_ref(), previous_run_id) {
            (Some(_), Some(prev)) => std::env::set_var("BIOVAULT_FLOW_RUN_ID", prev),
            (Some(_), None) => std::env::remove_var("BIOVAULT_FLOW_RUN_ID"),
            _ => {}
        }

        let pause_requested = pause_marker_path.exists();
        if pause_requested {
            let _ = fs::remove_file(&pause_marker_path);
        }

        let status = match (&result, pause_requested) {
            (_, true) => {
                append_flow_log(
                    window_clone.as_ref(),
                    &log_path_clone,
                    "⏸️  Flow run paused",
                );
                "paused"
            }
            (Err(err), false) => {
                append_flow_log(
                    window_clone.as_ref(),
                    &log_path_clone,
                    &format!("❌ Flow run failed: {}", err),
                );
                "failed"
            }
            (Ok(()), false) => {
                append_flow_log(
                    window_clone.as_ref(),
                    &log_path_clone,
                    "✅ Flow run completed successfully",
                );
                "success"
            }
        };

        // Update status using CLI library
        if let Ok(biovault_db) = biovault_db_clone.lock() {
            let _ = biovault_db.update_flow_run_status(run_id_clone, status, true);
        }

        if let Some(w) = &window_clone {
            let _ = w.emit("flow-complete", status);
        }
    });

    Ok(run_record)
}

#[tauri::command]
pub async fn get_flow_runs(state: tauri::State<'_, AppState>) -> Result<Vec<Run>, String> {
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    biovault_db.list_flow_runs().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_flow_run(state: tauri::State<'_, AppState>, run_id: i64) -> Result<(), String> {
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;

    // Get work directory before deleting
    let run = biovault_db
        .get_flow_run(run_id)
        .map_err(|e| e.to_string())?;

    // Delete from database
    biovault_db
        .delete_flow_run(run_id)
        .map_err(|e| e.to_string())?;

    // Delete work directory if it exists
    if let Some(r) = run {
        let path = PathBuf::from(r.work_dir);
        if path.exists() {
            fs::remove_dir_all(&path).ok(); // Ignore errors here
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn reconcile_flow_runs(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut updates: Vec<(i64, String, bool)> = Vec::new();
    let now = std::time::SystemTime::now();
    let grace_period = std::time::Duration::from_secs(120);
    let runs = {
        let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
        biovault_db.list_flow_runs().map_err(|e| e.to_string())?
    };

    for run in runs {
        if run.status != "running" && run.status != "paused" {
            continue;
        }

        // Skip multiparty runs - they don't have a process to track
        if let Some(ref metadata_str) = run.metadata {
            if let Ok(metadata) = serde_json::from_str::<serde_json::Value>(metadata_str) {
                if metadata.get("type").and_then(|v| v.as_str()) == Some("multiparty") {
                    continue;
                }
            }
        }

        let results_dir = run
            .results_dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(&run.work_dir));
        let pause_marker = flow_pause_marker(&results_dir);
        let pid_path = flow_pid_path(&results_dir);
        let log_path = results_dir.join("flow.log");

        let mut is_running = false;
        if let Ok(pid_str) = fs::read_to_string(&pid_path) {
            if let Ok(pid) = pid_str.trim().parse::<i32>() {
                is_running = is_pid_running(pid);
            }
        }

        if is_running {
            if run.status != "running" {
                updates.push((run.id, "running".to_string(), false));
            }
            continue;
        }

        if pause_marker.exists() {
            if run.status != "paused" {
                updates.push((run.id, "paused".to_string(), false));
            }
            continue;
        }

        let is_recent_run = chrono::DateTime::parse_from_rfc3339(&run.created_at)
            .map(|created| {
                let created = created.with_timezone(&chrono::Utc).into();
                now.duration_since(created).unwrap_or_default() < grace_period
            })
            .unwrap_or(false);

        if !log_path.exists() && !pid_path.exists() && is_recent_run {
            // Avoid marking brand-new runs as failed before the pid/log are created.
            continue;
        }

        if let Ok(log_contents) = fs::read_to_string(&log_path) {
            if log_contents.contains("✅ Flow run completed successfully") {
                updates.push((run.id, "success".to_string(), true));
                continue;
            }
            if log_contents.contains("❌ Flow run failed") {
                updates.push((run.id, "failed".to_string(), true));
                continue;
            }
            if let Ok(metadata) = fs::metadata(&log_path) {
                if let Ok(modified) = metadata.modified() {
                    if now.duration_since(modified).unwrap_or_default() < grace_period {
                        // Log is still being written; keep status as-is.
                        continue;
                    }
                }
            }
        }

        // If the process is gone and we have no explicit status, mark failed to avoid stuck runs.
        updates.push((run.id, "failed".to_string(), true));
    }

    if !updates.is_empty() {
        let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
        for (run_id, status, completed) in updates {
            let _ = biovault_db.update_flow_run_status(run_id, &status, completed);
        }
    }

    Ok(())
}

/// Find the flow.container file - could be in results_dir or a subdirectory (module dir)
fn find_flow_container_file(results_dir: &Path) -> Option<PathBuf> {
    // First check directly in results_dir
    let direct = results_dir.join("flow.container");
    if direct.exists() {
        return Some(direct);
    }

    // Search one level deep (module directories)
    if let Ok(entries) = fs::read_dir(results_dir) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                let container_file = path.join("flow.container");
                if container_file.exists() {
                    return Some(container_file);
                }
            }
        }
    }

    None
}

#[tauri::command]
pub async fn pause_flow_run(state: tauri::State<'_, AppState>, run_id: i64) -> Result<(), String> {
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    let run = biovault_db
        .get_flow_run(run_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Flow run {} not found", run_id))?;

    let results_dir = run
        .results_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&run.work_dir));
    let log_path = results_dir.join("flow.log");
    let pause_marker = flow_pause_marker(&results_dir);
    let _ = fs::write(&pause_marker, "paused");

    let pid_path = flow_pid_path(&results_dir);
    let pid_str =
        fs::read_to_string(&pid_path).map_err(|e| format!("Failed to read PID file: {}", e))?;
    let pid: i32 = pid_str
        .trim()
        .parse()
        .map_err(|_| "Invalid PID value".to_string())?;

    // Check if Nextflow is running in a Docker container (Windows mode)
    // The container file may be in results_dir or a module subdirectory
    let container_file = find_flow_container_file(&results_dir);
    let container_name = container_file
        .as_ref()
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let container_count = get_running_container_count();
    append_flow_log(
        None,
        &log_path,
        &format!(
            "⏸️  Pause requested (PID: {}, {} container(s) running{})",
            pid,
            container_count,
            container_name
                .as_ref()
                .map(|n| format!(", Nextflow container: {}", n))
                .unwrap_or_default()
        ),
    );

    // Graceful shutdown strategy:
    // - If Nextflow runs in a container: use `docker stop` (sends SIGTERM to Java inside)
    // - If Nextflow runs natively: send SIGTERM (Unix) or taskkill (Windows)
    let _using_container = container_name.is_some();

    if let Some(ref name) = container_name {
        // Docker container mode - use `docker stop` for graceful shutdown
        // This sends SIGTERM to PID 1 (Java/Nextflow) inside the container
        append_flow_log(
            None,
            &log_path,
            &format!("🐳 Stopping Nextflow container '{}' gracefully...", name),
        );

        let runtime = get_container_runtime().unwrap_or_else(|| "docker".to_string());
        let mut cmd = Command::new(&runtime);
        cmd.args(["stop", "-t", "30", name]); // 30 second timeout for graceful stop
        configure_child_process(&mut cmd);

        match cmd.status() {
            Ok(status) if status.success() => {
                append_flow_log(
                    None,
                    &log_path,
                    "✅ Nextflow container stopped gracefully - cache should be intact!",
                );
            }
            Ok(_) => {
                append_flow_log(
                    None,
                    &log_path,
                    "⚠️  Container stop returned non-zero (may have been force-killed)",
                );
            }
            Err(e) => {
                append_flow_log(
                    None,
                    &log_path,
                    &format!("⚠️  Failed to stop container: {}", e),
                );
            }
        }

        // Clean up the container file
        if let Some(ref path) = container_file {
            let _ = fs::remove_file(path);
        }
    } else {
        // Native mode - send signal directly to process
        #[cfg(target_os = "windows")]
        {
            append_flow_log(
                None,
                &log_path,
                "📤 Sending graceful shutdown signal (taskkill)...",
            );
            let mut cmd = Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/T"]);
            configure_child_process(&mut cmd);
            let _ = cmd.status();
        }

        #[cfg(not(target_os = "windows"))]
        {
            append_flow_log(None, &log_path, "📤 Sending SIGTERM...");
            unsafe {
                let _ = libc::kill(pid, libc::SIGTERM);
            }
        }

        // Wait for graceful shutdown
        let graceful_timeout_ms = 30_000u64;
        let mut waited_ms = 0u64;

        while is_pid_running(pid) && waited_ms < graceful_timeout_ms {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            waited_ms += 1000;

            if waited_ms.is_multiple_of(10_000) {
                let containers = get_running_container_count();
                append_flow_log(
                    None,
                    &log_path,
                    &format!(
                        "⏳ Waiting for graceful shutdown... ({}s, {} container(s))",
                        waited_ms / 1000,
                        containers
                    ),
                );
            }
        }

        if !is_pid_running(pid) {
            append_flow_log(
                None,
                &log_path,
                "✅ Nextflow exited gracefully - cache should be intact!",
            );
        } else {
            // Force kill if still running
            append_flow_log(
                None,
                &log_path,
                "⚠️  Graceful shutdown timed out - force terminating (cache may be corrupted)",
            );

            #[cfg(target_os = "windows")]
            {
                let mut forced_cmd = Command::new("taskkill");
                forced_cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
                configure_child_process(&mut forced_cmd);
                let _ = forced_cmd.status();
            }

            #[cfg(not(target_os = "windows"))]
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }

            std::thread::sleep(std::time::Duration::from_millis(2000));
        }
    }

    // Clean up orphaned containers (task containers spawned by Nextflow)
    let remaining_containers = get_nextflow_container_ids();
    if !remaining_containers.is_empty() {
        append_flow_log(
            None,
            &log_path,
            &format!(
                "🧹 Stopping {} orphaned container(s)...",
                remaining_containers.len()
            ),
        );
        let stopped = stop_containers(&remaining_containers);
        if stopped > 0 {
            append_flow_log(
                None,
                &log_path,
                &format!("✅ Stopped {} orphaned container(s)", stopped),
            );
        }
    }

    // Extra delay for OS to release file handles
    std::thread::sleep(std::time::Duration::from_millis(1000));

    let _ = fs::remove_file(&pid_path);
    let _ = biovault_db.update_flow_run_status(run_id, "paused", false);
    append_flow_log(None, &log_path, "⏸️  Run paused successfully");

    Ok(())
}

#[tauri::command]
pub async fn resume_flow_run(
    state: tauri::State<'_, AppState>,
    window: tauri::WebviewWindow,
    run_id: i64,
    nextflow_max_forks: Option<u32>,
    force_remove_lock: Option<bool>,
) -> Result<Run, String> {
    let (flow_id, results_dir, input_overrides, selection, resolved_max_forks, _flow_path) = {
        let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
        let run = biovault_db
            .get_flow_run(run_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Flow run {} not found", run_id))?;
        let flow_id = run
            .flow_id
            .ok_or_else(|| "Flow run is missing flow_id".to_string())?;
        let flow_path = biovault_db
            .get_flow(flow_id)
            .map_err(|e| e.to_string())?
            .map(|flow| flow.flow_path)
            .unwrap_or_default();
        let results_dir = run
            .results_dir
            .clone()
            .or_else(|| Some(run.work_dir.clone()));
        let (input_overrides, selection, mut parsed_max_forks) = parse_flow_run_metadata(&run)?;
        if let Some(override_value) = nextflow_max_forks {
            parsed_max_forks = Some(override_value);
            let mut metadata_value = if let Some(raw) = run.metadata.as_ref() {
                serde_json::from_str(raw).unwrap_or_else(|_| serde_json::json!({}))
            } else {
                serde_json::json!({})
            };
            if let Some(obj) = metadata_value.as_object_mut() {
                obj.insert(
                    "nextflow_max_forks".to_string(),
                    serde_json::json!(override_value),
                );
            }
            let metadata_str = serde_json::to_string(&metadata_value)
                .map_err(|e| format!("Failed to serialize metadata: {}", e))?;
            let _ = biovault_db.update_flow_run_metadata(run_id, &metadata_str);
        }
        (
            flow_id,
            results_dir,
            input_overrides,
            selection,
            parsed_max_forks,
            flow_path,
        )
    };

    // Clear Nextflow locks from ALL module directories (not just flow directory)
    // because Nextflow runs from module directories, not flow directories
    if let Some(results_dir) = results_dir.as_ref() {
        let log_path = PathBuf::from(results_dir).join("flow.log");

        // Get all lock files from modules directory
        if let Ok(modules_dir) = get_modules_dir() {
            let mut all_locks: Vec<PathBuf> = Vec::new();

            // Walk each module directory and collect locks
            if let Ok(entries) = fs::read_dir(&modules_dir) {
                for entry in entries.filter_map(Result::ok) {
                    let module_path = entry.path();
                    if module_path.is_dir() {
                        all_locks.extend(list_nextflow_locks(&module_path));
                    }
                }
            }

            if !all_locks.is_empty() {
                append_flow_log(
                    Some(&window),
                    &log_path,
                    &format!(
                        "⚠️  Nextflow locks detected in modules: {}",
                        all_locks.len()
                    ),
                );
            }

            // Use more retries when force flag is set
            let max_retries = if force_remove_lock.unwrap_or(false) {
                6
            } else {
                3
            };

            // Clear locks from each module directory
            // Note: We only clear LOCK files, not the entire cache, to preserve resume capability
            // The cache DB is only cleared if force_remove_lock is set (user explicitly requested)
            if let Ok(entries) = fs::read_dir(&modules_dir) {
                for entry in entries.filter_map(Result::ok) {
                    let module_path = entry.path();
                    if module_path.is_dir() {
                        let _ = clear_nextflow_locks(
                            &module_path,
                            Some(&window),
                            &log_path,
                            max_retries,
                        );
                        // Only clear cache if force flag is set - this loses resume state but fixes corruption
                        if force_remove_lock.unwrap_or(false) {
                            let _ = clear_nextflow_cache(&module_path, Some(&window), &log_path);
                        }
                    }
                }
            }

            // Check if any locks remain
            let mut locks_after: Vec<PathBuf> = Vec::new();
            if let Ok(entries) = fs::read_dir(&modules_dir) {
                for entry in entries.filter_map(Result::ok) {
                    let module_path = entry.path();
                    if module_path.is_dir() {
                        locks_after.extend(list_nextflow_locks(&module_path));
                    }
                }
            }

            if !locks_after.is_empty() {
                let sample: Vec<String> = locks_after
                    .iter()
                    .take(5)
                    .map(|path| path.display().to_string())
                    .collect();
                let sample_joined = sample.join("; ");
                return Err(format!(
                    "NEXTFLOW_LOCKS_REMAIN: {}",
                    if sample_joined.is_empty() {
                        "Lock files remain after cleanup.".to_string()
                    } else {
                        sample_joined
                    }
                ));
            }

            // Check for potential cache corruption (LOCK files in cache/*/db directories)
            // This happens when Nextflow was killed mid-execution
            if !force_remove_lock.unwrap_or(false) {
                let mut has_corrupted_cache = false;
                if let Ok(entries) = fs::read_dir(&modules_dir) {
                    for entry in entries.filter_map(Result::ok) {
                        let module_path = entry.path();
                        if module_path.is_dir()
                            && is_nextflow_cache_potentially_corrupted(&module_path)
                        {
                            has_corrupted_cache = true;
                            break;
                        }
                    }
                }
                if has_corrupted_cache {
                    return Err("NEXTFLOW_CACHE_CORRUPTED: Cache database may be corrupted from interrupted run.".to_string());
                }
            }
        }
    }

    run_flow_impl(
        state,
        Some(window),
        flow_id,
        input_overrides,
        results_dir,
        selection,
        Some(run_id.to_string()),
        resolved_max_forks,
        true,
        Some(run_id),
    )
    .await
}

/// Get the number of running containers (docker/podman)
#[tauri::command]
pub fn get_container_count() -> usize {
    get_running_container_count()
}

/// Get flow state for a run (progress, concurrency, etc.)
#[tauri::command]
pub fn get_flow_state(
    state: tauri::State<AppState>,
    run_id: i64,
) -> Result<Option<FlowState>, String> {
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    let run = biovault_db
        .get_flow_run(run_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Flow run {} not found", run_id))?;

    let results_dir = run
        .results_dir
        .as_ref()
        .or(Some(&run.work_dir))
        .map(PathBuf::from)
        .ok_or_else(|| "No results directory".to_string())?;

    Ok(load_flow_state(&results_dir))
}

/// Save flow state for a run
#[tauri::command]
pub fn save_flow_state_cmd(
    state: tauri::State<AppState>,
    run_id: i64,
    completed: u32,
    total: u32,
    concurrency: Option<u32>,
    container_count: u32,
) -> Result<(), String> {
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    let run = biovault_db
        .get_flow_run(run_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Flow run {} not found", run_id))?;

    let results_dir = run
        .results_dir
        .as_ref()
        .or(Some(&run.work_dir))
        .map(PathBuf::from)
        .ok_or_else(|| "No results directory".to_string())?;

    let flow_state = FlowState {
        completed,
        total,
        concurrency,
        container_count,
        last_updated: Some(chrono::Utc::now().to_rfc3339()),
        status: Some(run.status.clone()),
    };

    save_flow_state(&results_dir, &flow_state)
}

#[tauri::command]
pub fn get_flow_run_logs(state: tauri::State<AppState>, run_id: i64) -> Result<String, String> {
    get_flow_run_logs_tail(state, run_id, 500)
}

#[tauri::command]
pub fn get_flow_run_logs_tail(
    state: tauri::State<AppState>,
    run_id: i64,
    lines: usize,
) -> Result<String, String> {
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    let run = biovault_db
        .get_flow_run(run_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Flow run {} not found", run_id))?;

    let results_dir = run
        .results_dir
        .as_ref()
        .or(Some(&run.work_dir))
        .ok_or_else(|| "Flow run has no results_dir or work_dir".to_string())?;
    let log_path = PathBuf::from(results_dir).join("flow.log");

    if !log_path.exists() {
        return Ok(
            "No logs available for this flow run yet. Logs will appear once execution starts."
                .to_string(),
        );
    }

    let file = fs::File::open(&log_path).map_err(|e| format!("Failed to open log file: {}", e))?;
    let reader = BufReader::new(file);
    let all_lines: Vec<String> = reader.lines().map_while(Result::ok).collect();

    let total_lines = all_lines.len();
    let start_index = total_lines.saturating_sub(lines);
    let tail_lines: Vec<String> = all_lines.into_iter().skip(start_index).collect();

    Ok(tail_lines.join("\n"))
}

#[tauri::command]
pub fn get_flow_run_logs_full(
    state: tauri::State<AppState>,
    run_id: i64,
) -> Result<String, String> {
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    let run = biovault_db
        .get_flow_run(run_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Flow run {} not found", run_id))?;

    let results_dir = run
        .results_dir
        .as_ref()
        .or(Some(&run.work_dir))
        .ok_or_else(|| "Flow run has no results_dir or work_dir".to_string())?;
    let log_path = PathBuf::from(results_dir).join("flow.log");

    if !log_path.exists() {
        return Ok(
            "No logs available for this flow run yet. Logs will appear once execution starts."
                .to_string(),
        );
    }

    fs::read_to_string(&log_path).map_err(|e| format!("Failed to read log file: {}", e))
}

#[tauri::command]
pub fn path_exists(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).exists())
}

#[tauri::command]
pub fn get_flow_run_work_dir(state: tauri::State<AppState>, run_id: i64) -> Result<String, String> {
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    let run = biovault_db
        .get_flow_run(run_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Flow run {} not found", run_id))?;

    let results_dir = run
        .results_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&run.work_dir));
    let log_path = results_dir.join("flow.log");

    // Try to find work directory from flow.log
    if let Ok(contents) = fs::read_to_string(&log_path) {
        for line in contents.lines().rev() {
            if let Some(idx) = line.find("Current working directory:") {
                let path = line[idx + "Current working directory:".len()..].trim();
                let mut candidate = PathBuf::from(path);
                if candidate.is_file() {
                    candidate.pop();
                }
                while candidate.file_name().is_some()
                    && candidate.file_name().and_then(|v| v.to_str()) != Some("work")
                {
                    candidate.pop();
                }
                if candidate.file_name().and_then(|v| v.to_str()) == Some("work") {
                    return Ok(candidate.to_string_lossy().to_string());
                }
            }
        }
    }

    // Fallback: Try to find work directory in modules folder
    // The work directory is created inside the module directory
    if let Ok(modules_dir) = get_modules_dir() {
        if let Ok(entries) = fs::read_dir(&modules_dir) {
            // Find most recently modified work directory
            let mut newest_work: Option<(PathBuf, std::time::SystemTime)> = None;
            for entry in entries.filter_map(Result::ok) {
                let module_path = entry.path();
                let work_path = module_path.join("work");
                if work_path.is_dir() {
                    if let Ok(metadata) = fs::metadata(&work_path) {
                        if let Ok(modified) = metadata.modified() {
                            if newest_work.as_ref().is_none_or(|(_, t)| modified > *t) {
                                newest_work = Some((work_path, modified));
                            }
                        }
                    }
                }
            }
            if let Some((work_path, _)) = newest_work {
                return Ok(work_path.to_string_lossy().to_string());
            }
        }
    }

    Ok(run.work_dir.clone())
}

#[tauri::command]
pub async fn preview_flow_spec(spec: FlowSpec) -> Result<String, String> {
    let flow = FlowFile::from_flow_spec(&spec)
        .map_err(|e| format!("Failed to convert flow preview: {}", e))?;
    serde_yaml::to_string(&flow).map_err(|e| format!("Failed to generate flow preview: {}", e))
}

/// Import a flow from a message (received via flow request)
#[tauri::command]
pub async fn import_flow_from_message(
    state: tauri::State<'_, AppState>,
    name: String,
    _version: String,
    spec: serde_json::Value,
) -> Result<i64, String> {
    let flows_dir = get_flows_dir()?;
    let flow_dir = flows_dir.join(&name);

    // Check if flow already exists
    if flow_dir.exists() {
        // For now, we'll overwrite - in the future could prompt user
        // or rename with version suffix
        fs::remove_dir_all(&flow_dir)
            .map_err(|e| format!("Failed to remove existing flow: {}", e))?;
    }

    // Create flow directory
    fs::create_dir_all(&flow_dir).map_err(|e| format!("Failed to create flow directory: {}", e))?;

    let flow: FlowFile = serde_json::from_value(spec)
        .map_err(|e| format!("Failed to parse flow spec from message: {}", e))?;
    let yaml_content = serde_yaml::to_string(&flow)
        .map_err(|e| format!("Failed to convert flow spec to YAML: {}", e))?;

    let flow_yaml_path = flow_dir.join(FLOW_YAML_FILE);
    fs::write(&flow_yaml_path, &yaml_content)
        .map_err(|e| format!("Failed to write flow.yaml: {}", e))?;

    // Register in database
    let db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    let flow_dir_str = flow_dir.to_string_lossy().to_string();

    // Check if flow with same name exists in DB - delete then re-register
    let existing = db.list_flows().map_err(|e| e.to_string())?;
    if let Some(existing_flow) = existing.iter().find(|p| p.name == name) {
        db.delete_flow(existing_flow.id)
            .map_err(|e| format!("Failed to remove existing flow from database: {}", e))?;
    }

    // Register flow
    let flow_id = db
        .register_flow(&name, &flow_dir_str)
        .map_err(|e| format!("Failed to register flow in database: {}", e))?;

    Ok(flow_id)
}

fn should_skip_request_path(rel: &Path) -> bool {
    if rel
        .file_name()
        .map(|n| n == "syft.pub.yaml")
        .unwrap_or(false)
    {
        return true;
    }

    let skip_dirs = [
        ".git",
        ".nextflow",
        ".venv",
        "__pycache__",
        "node_modules",
        "target",
        "work",
        "results",
        "runs",
    ];

    rel.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|name| skip_dirs.iter().any(|skip| skip == &name))
    })
}

fn copy_flow_request_dir(storage: &SyftBoxStorage, src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("Failed to create destination: {}", e))?;

    for entry in WalkDir::new(src)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        let rel = path
            .strip_prefix(src)
            .map_err(|e| format!("Failed to resolve path: {}", e))?;

        if should_skip_request_path(rel) {
            continue;
        }

        let dest_path = dest.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&dest_path).map_err(|e| {
                format!("Failed to create directory {}: {}", dest_path.display(), e)
            })?;
            continue;
        }

        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;
        }

        let bytes = storage
            .read_with_shadow(path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
        fs::write(&dest_path, &bytes)
            .map_err(|e| format!("Failed to write {}: {}", dest_path.display(), e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn import_flow_from_request(
    state: tauri::State<'_, AppState>,
    name: Option<String>,
    flow_location: String,
    overwrite: bool,
) -> Result<Flow, String> {
    let config =
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;
    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to get SyftBox data dir: {}", e))?;
    let storage = syftbox_storage_from_config(&config)?;

    let source_root = biovault::data::resolve_syft_url(&data_dir, &flow_location)
        .map_err(|e| format!("Failed to resolve flow location: {}", e))?;
    if !source_root.exists() {
        return Err(format!(
            "Flow source folder not found at {}",
            source_root.display()
        ));
    }

    let flow_yaml = source_root.join(FLOW_YAML_FILE);
    if !flow_yaml.exists() {
        return Err(format!("flow.yaml not found in {}", source_root.display()));
    }

    let spec = load_flow_spec_from_storage(&storage, &flow_yaml)?;
    let resolved_name = name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or(spec.name.clone());

    let flows_dir = get_flows_dir()?;
    fs::create_dir_all(&flows_dir)
        .map_err(|e| format!("Failed to create flows directory: {}", e))?;

    let dest_dir = flows_dir.join(&resolved_name);
    if dest_dir.exists() {
        if overwrite {
            fs::remove_dir_all(&dest_dir)
                .map_err(|e| format!("Failed to remove existing flow: {}", e))?;
        } else {
            return Err(format!(
                "Flow '{}' already exists at {}. Use overwrite to replace.",
                resolved_name,
                dest_dir.display()
            ));
        }
    }

    copy_flow_request_dir(&storage, &source_root, &dest_dir)?;

    let modules_source = source_root.join("modules");
    if modules_source.exists() {
        let modules_dir = get_modules_dir()?;
        fs::create_dir_all(&modules_dir)
            .map_err(|e| format!("Failed to create modules directory: {}", e))?;

        for entry in fs::read_dir(&modules_source)
            .map_err(|e| format!("Failed to read modules folder: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read module entry: {}", e))?;
            let entry_path = entry.path();
            if !entry_path.is_dir() {
                continue;
            }

            let module_dir_name = entry.file_name().to_string_lossy().to_string();
            let dest_module_dir = modules_dir.join(&module_dir_name);

            if dest_module_dir.exists() {
                if overwrite {
                    fs::remove_dir_all(&dest_module_dir).map_err(|e| {
                        format!(
                            "Failed to remove existing module directory {}: {}",
                            dest_module_dir.display(),
                            e
                        )
                    })?;
                } else {
                    continue;
                }
            }

            copy_flow_request_dir(&storage, &entry_path, &dest_module_dir)?;

            let module_yaml_path = dest_module_dir.join("module.yaml");
            if !module_yaml_path.exists() {
                continue;
            }

            let yaml_content = fs::read_to_string(&module_yaml_path).map_err(|e| {
                format!(
                    "Failed to read module.yaml at {}: {}",
                    module_yaml_path.display(),
                    e
                )
            })?;
            let module = ModuleFile::parse_yaml(&yaml_content).map_err(|e| {
                format!(
                    "Failed to parse module.yaml at {}: {}",
                    module_yaml_path.display(),
                    e
                )
            })?;
            let module_yaml = module.to_module_spec().map_err(|e| {
                format!(
                    "Failed to convert module.yaml at {}: {}",
                    module_yaml_path.display(),
                    e
                )
            })?;

            let identifier = format!(
                "{}@{}",
                module_yaml.name,
                module_yaml
                    .version
                    .clone()
                    .unwrap_or_else(|| "0.1.0".to_string())
            );
            let db = state.biovault_db.lock().map_err(|e| e.to_string())?;

            if overwrite {
                if db
                    .get_module(&identifier)
                    .map_err(|e| e.to_string())?
                    .is_some()
                {
                    db.update_module(
                        &module_yaml.name,
                        module_yaml.version.as_deref().unwrap_or("0.1.0"),
                        &module_yaml.author,
                        &module_yaml.workflow,
                        module_yaml.runtime.as_deref().unwrap_or("imported"),
                        &dest_module_dir,
                    )
                    .map_err(|e| e.to_string())?;
                } else {
                    db.register_module(
                        &module_yaml.name,
                        module_yaml.version.as_deref().unwrap_or("0.1.0"),
                        &module_yaml.author,
                        &module_yaml.workflow,
                        module_yaml.runtime.as_deref().unwrap_or("imported"),
                        &dest_module_dir,
                    )
                    .map_err(|e| e.to_string())?;
                }
            } else if db
                .get_module(&identifier)
                .map_err(|e| e.to_string())?
                .is_none()
            {
                db.register_module(
                    &module_yaml.name,
                    module_yaml.version.as_deref().unwrap_or("0.1.0"),
                    &module_yaml.author,
                    &module_yaml.workflow,
                    module_yaml.runtime.as_deref().unwrap_or("imported"),
                    &dest_module_dir,
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }

    let flow_dir_str = dest_dir.to_string_lossy().to_string();
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;

    if overwrite {
        let existing = biovault_db
            .list_flows()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|p| p.name == resolved_name || p.flow_path == flow_dir_str);
        if let Some(existing_flow) = existing {
            biovault_db
                .delete_flow(existing_flow.id)
                .map_err(|e| e.to_string())?;
        }
    }

    let id = biovault_db
        .register_flow(&resolved_name, &flow_dir_str)
        .map_err(|e| e.to_string())?;

    let timestamp = chrono::Local::now().to_rfc3339();

    Ok(Flow {
        id,
        name: resolved_name,
        flow_path: flow_dir_str,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        spec: Some(spec),
    })
}

// ============================================================================
// Run Configurations (using CLI library)
// ============================================================================

#[tauri::command]
pub async fn save_run_config(
    state: tauri::State<'_, AppState>,
    flow_id: i64,
    name: String,
    config_data: serde_json::Value,
) -> Result<i64, String> {
    let db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    db.save_flow_run_config(flow_id, &name, &config_data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_run_configs(
    state: tauri::State<'_, AppState>,
    flow_id: i64,
) -> Result<Vec<RunConfig>, String> {
    let db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    db.list_flow_run_configs(flow_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_run_config(
    state: tauri::State<'_, AppState>,
    config_id: i64,
) -> Result<Option<RunConfig>, String> {
    let db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    db.get_flow_run_config(config_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_run_config(
    state: tauri::State<'_, AppState>,
    config_id: i64,
) -> Result<(), String> {
    let db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    db.delete_flow_run_config(config_id)
        .map_err(|e| e.to_string())
}
