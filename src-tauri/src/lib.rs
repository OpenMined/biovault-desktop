use chrono::Local;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use walkdir::WalkDir;

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    docker_path: String,
    java_path: String,
    syftbox_path: String,
    biovault_path: String,
    email: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            docker_path: String::from("/usr/local/bin/docker"),
            java_path: String::from("/usr/bin/java"),
            syftbox_path: String::from("/usr/local/bin/syftbox"),
            biovault_path: String::from("bv"),
            email: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct PatternSuggestion {
    pattern: String,
    description: String,
}

#[derive(Serialize, Deserialize)]
struct ExtensionCount {
    extension: String,
    count: usize,
}

#[derive(Serialize)]
struct ImportResult {
    success: bool,
    message: String,
    conflicts: Vec<FileConflict>,
    imported_files: Vec<FileRecord>,
}

#[derive(Serialize)]
struct FileConflict {
    path: String,
    existing_hash: String,
    new_hash: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Participant {
    id: i64,
    participant_id: String,
    created_at: String,
    file_count: i64,
}

#[derive(Serialize, Deserialize)]
struct FileRecord {
    id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    participant_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    participant_name: Option<String>,
    file_path: String,
    file_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    grch_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    row_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chromosome_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    inferred_sex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    processing_error: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize, Deserialize)]
struct Project {
    id: i64,
    name: String,
    author: String,
    workflow: String,
    template: String,
    project_path: String,
    created_at: String,
}

#[derive(Serialize)]
struct Run {
    id: i64,
    project_id: i64,
    project_name: String,
    work_dir: String,
    participant_count: i64,
    status: String,
    created_at: String,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct ProjectYaml {
    name: String,
    author: String,
    workflow: String,
    template: String,
    assets: Vec<String>,
}

struct AppState {
    db: Mutex<Connection>,
    queue_processor_paused: Arc<AtomicBool>,
}

/// Helper to run bv CLI commands and parse JSON output
fn run_bv_command(args: &[&str]) -> Result<serde_json::Value, String> {
    // Priority: BIOVAULT_PATH env var > settings > default "bv"
    let bv_path = if let Ok(env_path) = env::var("BIOVAULT_PATH") {
        env_path
    } else {
        let settings = get_settings()?;
        if settings.biovault_path.is_empty() {
            "bv".to_string()
        } else {
            settings.biovault_path
        }
    };

    let full_command = format!("{} {}", bv_path, args.join(" "));
    eprintln!("🔧 Running bv command: {}", full_command);

    let output = std::process::Command::new(&bv_path)
        .args(args)
        .env(
            "BIOVAULT_HOME",
            env::var("BIOVAULT_HOME").unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap()
                    .join(".biovault")
                    .to_string_lossy()
                    .to_string()
            }),
        )
        .output()
        .map_err(|e| format!("Failed to execute bv command: {}", e))?;

    let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("❌ bv command failed: {}", stderr);

        // Log the failed command
        let log_entry = LogEntry {
            timestamp: timestamp.clone(),
            command: full_command.clone(),
            output: None,
            error: Some(stderr.to_string()),
        };
        let _ = append_log(&log_entry);

        return Err(format!("bv command failed: {}", stderr));
    }

    let json_str = String::from_utf8(output.stdout)
        .map_err(|e| format!("Invalid UTF-8 in bv output: {}", e))?;

    eprintln!("📦 bv response: {}", &json_str[..json_str.len().min(200)]);

    // Log the successful command
    let log_entry = LogEntry {
        timestamp,
        command: full_command,
        output: Some(json_str.clone()),
        error: None,
    };
    let _ = append_log(&log_entry);

    serde_json::from_str(&json_str).map_err(|e| format!("Failed to parse bv JSON output: {}", e))
}

fn init_db(conn: &Connection) -> Result<(), rusqlite::Error> {
    // NOTE: Files and Participants tables are managed by CLI via biovault.db
    // Desktop only manages its own tables: projects, runs, run_participants

    conn.execute(
        "CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            author TEXT NOT NULL,
            workflow TEXT NOT NULL,
            template TEXT NOT NULL,
            project_path TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            work_dir TEXT NOT NULL,
            participant_count INTEGER NOT NULL,
            status TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (project_id) REFERENCES projects(id)
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS run_participants (
            run_id INTEGER NOT NULL,
            participant_id INTEGER NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(id),
            -- Note: participant_id references participants(id) managed by CLI
            PRIMARY KEY (run_id, participant_id)
        )",
        [],
    )?;

    // Create indexes for desktop-only tables
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_runs_project_id ON runs(project_id)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)",
        [],
    )?;

    Ok(())
}

#[tauri::command]
fn get_extensions(path: String) -> Result<Vec<ExtensionCount>, String> {
    eprintln!("🔍 get_extensions called for path: {}", path);

    // Use CLI to scan directory
    let result = run_bv_command(&["files", "scan", &path, "--format", "json"])?;

    let data = result.get("data").ok_or_else(|| {
        let err = format!("Missing 'data' field in response: {:?}", result);
        eprintln!("❌ {}", err);
        err
    })?;

    let extensions_array = data.get("extensions").ok_or_else(|| {
        let err = format!("Missing 'extensions' field in data: {:?}", data);
        eprintln!("❌ {}", err);
        err
    })?;

    // Parse CLI output: { extension, count, total_size }
    // We only need extension and count
    let extensions: Vec<ExtensionCount> = serde_json::from_value(extensions_array.clone())
        .map_err(|e| {
            let err = format!(
                "Failed to parse extensions from {:?}: {}",
                extensions_array, e
            );
            eprintln!("❌ {}", err);
            err
        })?;

    eprintln!("✅ Found {} extensions", extensions.len());
    Ok(extensions)
}

#[tauri::command]
fn search_txt_files(path: String, extensions: Vec<String>) -> Result<Vec<String>, String> {
    let mut files = Vec::new();

    // Normalize extensions (remove leading dots)
    let normalized_exts: Vec<String> = extensions
        .iter()
        .map(|ext| ext.trim_start_matches('.').to_string())
        .collect();

    for entry in WalkDir::new(&path).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            if let Some(file_ext) = entry.path().extension() {
                if let Some(ext_str) = file_ext.to_str() {
                    if normalized_exts.contains(&ext_str.to_string()) {
                        if let Some(path_str) = entry.path().to_str() {
                            files.push(path_str.to_string());
                        }
                    }
                }
            }
        }
    }

    Ok(files)
}

#[tauri::command]
fn suggest_patterns(files: Vec<String>) -> Result<Vec<PatternSuggestion>, String> {
    eprintln!("🔍 suggest_patterns called with {} files", files.len());

    if files.is_empty() {
        return Ok(vec![]);
    }

    // Extract directory and extension from first file
    let first_file = Path::new(&files[0]);
    let dir = first_file
        .parent()
        .and_then(|p| p.to_str())
        .ok_or("Invalid file path")?;

    let extension = first_file
        .extension()
        .and_then(|e| e.to_str())
        .ok_or("Files must have an extension")?;
    let ext_with_dot = format!(".{}", extension);

    eprintln!(
        "📂 Analyzing directory: {} with extension: {}",
        dir, ext_with_dot
    );

    // Use CLI to suggest patterns
    let result = run_bv_command(&[
        "files",
        "suggest-patterns",
        dir,
        "--ext",
        &ext_with_dot,
        "--format",
        "json",
    ])?;

    let data = result.get("data").ok_or_else(|| {
        let err = format!("Missing 'data' field in response: {:?}", result);
        eprintln!("❌ {}", err);
        err
    })?;

    let suggestions_array = data.get("suggestions").ok_or_else(|| {
        let err = format!("Missing 'suggestions' field in data: {:?}", data);
        eprintln!("❌ {}", err);
        err
    })?;

    // Parse CLI output: { pattern, description, example, sample_extractions }
    // We only need pattern and description
    let suggestions: Vec<PatternSuggestion> = serde_json::from_value(suggestions_array.clone())
        .map_err(|e| {
            let err = format!(
                "Failed to parse suggestions from {:?}: {}",
                suggestions_array, e
            );
            eprintln!("❌ {}", err);
            err
        })?;

    eprintln!("✅ Found {} pattern suggestions", suggestions.len());
    Ok(suggestions)
}

/// Find the common root directory of multiple paths
fn find_common_root(paths: &[PathBuf]) -> Option<PathBuf> {
    if paths.is_empty() {
        return None;
    }

    // Start with the parent directory of the first file
    let mut common = paths[0].parent()?.to_path_buf();

    // For each other path, find the common ancestor
    for path in &paths[1..] {
        let path_parent = path.parent()?;

        // Keep going up until we find a common ancestor
        while !path_parent.starts_with(&common) {
            common = common.parent()?.to_path_buf();
        }
    }

    Some(common)
}

#[derive(Serialize, Deserialize, Debug)]
struct FileMetadata {
    participant_id: Option<String>,
    data_type: Option<String>,
    source: Option<String>,
    grch_version: Option<String>,
    row_count: Option<i64>,
    chromosome_count: Option<i64>,
    inferred_sex: Option<String>,
}

#[tauri::command]
async fn import_files_with_metadata(
    _state: tauri::State<'_, AppState>,
    file_metadata: std::collections::HashMap<String, FileMetadata>,
) -> Result<ImportResult, String> {
    eprintln!(
        "🔍 import_files_with_metadata called with {} files",
        file_metadata.len()
    );

    if file_metadata.is_empty() {
        return Err("No files selected".to_string());
    }

    // Create temporary CSV file
    use std::io::Write;
    use tempfile::NamedTempFile;

    let mut temp_file =
        NamedTempFile::new().map_err(|e| format!("Failed to create temp file: {}", e))?;

    // Write CSV header
    writeln!(
        temp_file,
        "file_path,participant_id,data_type,source,grch_version,row_count,chromosome_count,inferred_sex"
    )
    .map_err(|e| format!("Failed to write CSV header: {}", e))?;

    // Write CSV rows
    for (file_path, metadata) in &file_metadata {
        writeln!(
            temp_file,
            "{},{},{},{},{},{},{},{}",
            file_path,
            metadata.participant_id.as_deref().unwrap_or(""),
            metadata.data_type.as_deref().unwrap_or(""),
            metadata.source.as_deref().unwrap_or(""),
            metadata.grch_version.as_deref().unwrap_or(""),
            metadata
                .row_count
                .map(|v| v.to_string())
                .unwrap_or_default(),
            metadata
                .chromosome_count
                .map(|v| v.to_string())
                .unwrap_or_default(),
            metadata.inferred_sex.as_deref().unwrap_or("")
        )
        .map_err(|e| format!("Failed to write CSV row: {}", e))?;
    }

    temp_file
        .flush()
        .map_err(|e| format!("Failed to flush CSV: {}", e))?;

    // Get the temp file path
    let csv_path = temp_file.path().to_str().ok_or("Invalid temp file path")?;
    eprintln!("📝 Created temp CSV: {}", csv_path);

    // Call import-csv command
    let result = run_bv_command(&["files", "import-csv", csv_path, "--format", "json"])?;

    eprintln!("✅ Import CSV result: {:?}", result);

    // Parse the result
    let imported_count = result
        .get("data")
        .and_then(|d| d.get("imported"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let _skipped_count = result
        .get("data")
        .and_then(|d| d.get("skipped"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    eprintln!("✅ Imported {} files successfully", imported_count);

    // Fetch imported file records
    let files_result = run_bv_command(&["files", "list", "--format", "json"])?;
    let files_data = files_result
        .get("data")
        .and_then(|d| d.get("files"))
        .ok_or("Missing files data")?;
    let all_files: Vec<FileRecord> = serde_json::from_value(files_data.clone())
        .map_err(|e| format!("Failed to parse files: {}", e))?;

    // Filter to just the files we imported
    let imported_file_paths: Vec<String> = file_metadata.keys().cloned().collect();
    let imported_files: Vec<FileRecord> = all_files
        .into_iter()
        .filter(|f| imported_file_paths.contains(&f.file_path))
        .collect();

    Ok(ImportResult {
        success: true,
        message: format!("Successfully imported {} files", imported_count),
        conflicts: Vec::new(),
        imported_files,
    })
}

#[tauri::command]
async fn import_files_pending(
    _state: tauri::State<'_, AppState>,
    file_metadata: std::collections::HashMap<String, FileMetadata>,
) -> Result<ImportResult, String> {
    eprintln!(
        "🚀 import_files_pending called with {} files (fast import)",
        file_metadata.len()
    );

    if file_metadata.is_empty() {
        return Err("No files selected".to_string());
    }

    // Create temporary CSV file
    use std::io::Write;
    use tempfile::NamedTempFile;

    let mut temp_file =
        NamedTempFile::new().map_err(|e| format!("Failed to create temp file: {}", e))?;

    // Write CSV header (minimal - just what's needed for pending import)
    writeln!(
        temp_file,
        "file_path,participant_id,data_type,source,grch_version"
    )
    .map_err(|e| format!("Failed to write CSV header: {}", e))?;

    eprintln!("📊 Total files to write to CSV: {}", file_metadata.len());

    // Write CSV rows
    for (file_path, metadata) in &file_metadata {
        eprintln!(
            "📝 CSV row - file: {}, participant_id: {:?}, data_type: {:?}, source: {:?}, grch: {:?}",
            file_path,
            metadata.participant_id,
            metadata.data_type,
            metadata.source,
            metadata.grch_version
        );
        writeln!(
            temp_file,
            "{},{},{},{},{}",
            file_path,
            metadata.participant_id.as_deref().unwrap_or(""),
            metadata.data_type.as_deref().unwrap_or("Unknown"),
            metadata.source.as_deref().unwrap_or(""),
            metadata.grch_version.as_deref().unwrap_or("")
        )
        .map_err(|e| format!("Failed to write CSV row: {}", e))?;
    }

    temp_file
        .flush()
        .map_err(|e| format!("Failed to flush CSV: {}", e))?;

    // Get the temp file path
    let csv_path = temp_file.path().to_str().ok_or("Invalid temp file path")?;
    eprintln!("📝 Created temp CSV: {}", csv_path);

    // Read and display CSV contents for debugging
    if let Ok(contents) = std::fs::read_to_string(csv_path) {
        eprintln!("📄 CSV Contents:\n{}", contents);
    }

    // Call import-pending command (fast import - no hashing)
    let result = run_bv_command(&["files", "import-pending", csv_path, "--format", "json"])?;

    eprintln!("✅ Import pending result: {:?}", result);

    // Parse the result
    let imported_count = result
        .get("data")
        .and_then(|d| d.get("imported"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    eprintln!("✅ Added {} files to queue", imported_count);

    Ok(ImportResult {
        success: true,
        message: format!("Added {} files to queue for processing", imported_count),
        conflicts: Vec::new(),
        imported_files: Vec::new(), // Will be populated when queue is processed
    })
}

#[tauri::command]
async fn process_queue(
    _state: tauri::State<'_, AppState>,
    limit: usize,
) -> Result<serde_json::Value, String> {
    eprintln!("⚙️ process_queue called with limit: {}", limit);

    // Call process-queue command
    let result = run_bv_command(&[
        "files",
        "process-queue",
        "--limit",
        &limit.to_string(),
        "--format",
        "json",
    ])?;

    eprintln!("✅ Process queue result: {:?}", result);

    Ok(result)
}

#[tauri::command]
fn pause_queue_processor(state: tauri::State<AppState>) -> Result<bool, String> {
    state.queue_processor_paused.store(true, Ordering::SeqCst);
    Ok(true)
}

#[tauri::command]
fn resume_queue_processor(state: tauri::State<AppState>) -> Result<bool, String> {
    state.queue_processor_paused.store(false, Ordering::SeqCst);
    Ok(true)
}

#[tauri::command]
fn get_queue_processor_status(state: tauri::State<AppState>) -> Result<bool, String> {
    Ok(!state.queue_processor_paused.load(Ordering::SeqCst))
}

#[tauri::command]
async fn import_files(
    _state: tauri::State<'_, AppState>,
    files: Vec<String>,
    pattern: String,
    file_id_map: std::collections::HashMap<String, String>,
) -> Result<ImportResult, String> {
    eprintln!(
        "🔍 import_files called with {} files, pattern: {}",
        files.len(),
        pattern
    );

    if files.is_empty() {
        return Err("No files selected".to_string());
    }

    // Find common root directory of all files
    let paths: Vec<PathBuf> = files.iter().map(PathBuf::from).collect();
    let common_root = find_common_root(&paths).ok_or("Could not find common root directory")?;

    // Get all unique extensions from selected files
    let mut extensions: HashSet<String> = HashSet::new();
    for file_path in &files {
        if let Some(ext) = Path::new(file_path).extension().and_then(|e| e.to_str()) {
            extensions.insert(format!(".{}", ext));
        }
    }

    if extensions.is_empty() {
        return Err("No file extensions found".to_string());
    }

    eprintln!(
        "📥 Importing from common root: {} with {} extension(s), {} total files",
        common_root.display(),
        extensions.len(),
        files.len()
    );

    // Import recursively from common root for each extension
    for ext in &extensions {
        eprintln!("📂 Importing files with extension: {}", ext);

        // Build import command
        let mut args = vec![
            "files",
            "import",
            common_root.to_str().unwrap(),
            "--ext",
            ext.as_str(),
            "--recursive",
            "--non-interactive",
            "--format",
            "json",
        ];

        // Add pattern if provided
        let pattern_arg;
        if !pattern.is_empty() {
            pattern_arg = pattern.clone();
            args.push("--pattern");
            args.push(&pattern_arg);
        }

        // Run import
        let result = run_bv_command(&args)?;
        eprintln!("✅ Import result: {:?}", result);
    }

    // Link files to participants in bulk if needed
    if !file_id_map.is_empty() {
        eprintln!(
            "🔗 Bulk linking {} files to participants",
            file_id_map.len()
        );

        // Serialize the file_id_map to JSON
        let json_map = serde_json::to_string(&file_id_map)
            .map_err(|e| format!("Failed to serialize file map: {}", e))?;

        // Call bulk link command with JSON
        let _link_result = run_bv_command(&["files", "link-bulk", &json_map, "--format", "json"])?;

        eprintln!("✅ Bulk link complete");
    }

    // Fetch files to get updated participant links
    let files_result = run_bv_command(&["files", "list", "--format", "json"])?;
    let files_data = files_result
        .get("data")
        .and_then(|d| d.get("files"))
        .ok_or("Missing files data")?;
    let all_files: Vec<FileRecord> = serde_json::from_value(files_data.clone())
        .map_err(|e| format!("Failed to parse files: {}", e))?;

    // Filter to just the files we imported
    let imported_files: Vec<FileRecord> = all_files
        .into_iter()
        .filter(|f| files.contains(&f.file_path))
        .collect();

    eprintln!("✅ Imported {} files successfully", imported_files.len());

    Ok(ImportResult {
        success: true,
        message: format!("Successfully imported {} files", imported_files.len()),
        conflicts: Vec::new(),
        imported_files,
    })
}

#[tauri::command]
fn get_participants(_state: tauri::State<AppState>) -> Result<Vec<Participant>, String> {
    eprintln!("🔍 get_participants called");

    let result = run_bv_command(&["participants", "list", "--format", "json"])?;

    let data = result.get("data").ok_or_else(|| {
        let err = format!("Missing 'data' field in response: {:?}", result);
        eprintln!("❌ {}", err);
        err
    })?;

    let participants: Vec<Participant> = serde_json::from_value(data.clone()).map_err(|e| {
        let err = format!("Failed to parse participants from {:?}: {}", data, e);
        eprintln!("❌ {}", err);
        err
    })?;

    eprintln!("✅ Returning {} participants", participants.len());
    Ok(participants)
}

#[tauri::command]
fn get_files(_state: tauri::State<AppState>) -> Result<Vec<FileRecord>, String> {
    eprintln!("🔍 get_files called");

    let result = run_bv_command(&["files", "list", "--format", "json"])?;

    let data_obj = result.get("data").ok_or_else(|| {
        let err = format!("Missing 'data' field in response: {:?}", result);
        eprintln!("❌ {}", err);
        err
    })?;

    let files_array = data_obj.get("files").ok_or_else(|| {
        let err = format!("Missing 'files' field in data: {:?}", data_obj);
        eprintln!("❌ {}", err);
        err
    })?;

    let files: Vec<FileRecord> = serde_json::from_value(files_array.clone()).map_err(|e| {
        let err = format!("Failed to parse files from {:?}: {}", files_array, e);
        eprintln!("❌ {}", err);
        err
    })?;

    eprintln!("✅ Returning {} files", files.len());
    Ok(files)
}

#[tauri::command]
fn import_project(
    _state: tauri::State<AppState>,
    url: String,
    overwrite: bool,
) -> Result<Project, String> {
    eprintln!("🔍 import_project called with URL: {}", url);

    // Build arguments
    let mut args = vec!["project", "import", &url, "--format", "json"];

    let overwrite_flag = if overwrite {
        args.push("--overwrite");
        "--overwrite"
    } else {
        ""
    };

    if overwrite {
        args.push(overwrite_flag);
    }

    let result = run_bv_command(&args)?;

    let data = result.get("data").ok_or_else(|| {
        let err = format!("Missing 'data' field in response: {:?}", result);
        eprintln!("❌ {}", err);
        err
    })?;

    let project: Project = serde_json::from_value(data.clone()).map_err(|e| {
        let err = format!("Failed to parse project from {:?}: {}", data, e);
        eprintln!("❌ {}", err);
        err
    })?;

    eprintln!("✅ Project imported: {}", project.name);
    Ok(project)
}

#[tauri::command]
fn get_projects(_state: tauri::State<AppState>) -> Result<Vec<Project>, String> {
    eprintln!("🔍 get_projects called");

    let result = run_bv_command(&["project", "list", "--format", "json"])?;

    let data = result.get("data").ok_or_else(|| {
        let err = format!("Missing 'data' field in response: {:?}", result);
        eprintln!("❌ {}", err);
        err
    })?;

    let projects: Vec<Project> = serde_json::from_value(data.clone()).map_err(|e| {
        let err = format!("Failed to parse projects from {:?}: {}", data, e);
        eprintln!("❌ {}", err);
        err
    })?;

    eprintln!("✅ Returning {} projects", projects.len());
    Ok(projects)
}

#[tauri::command]
fn delete_project(_state: tauri::State<AppState>, project_id: i64) -> Result<(), String> {
    eprintln!("🔍 delete_project called with ID: {}", project_id);

    // Use project ID as identifier
    let id_str = project_id.to_string();
    let result = run_bv_command(&["project", "delete", &id_str, "--format", "json"])?;

    eprintln!("✅ Project deleted: {:?}", result);
    Ok(())
}

#[derive(Serialize)]
struct RunStartResult {
    run_id: i64,
    work_dir: String,
}

#[tauri::command]
fn start_analysis(
    state: tauri::State<AppState>,
    participant_ids: Vec<i64>,
    project_id: i64,
) -> Result<RunStartResult, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let conn = state.db.lock().unwrap();

    let project: (String, String) = conn
        .query_row(
            "SELECT name, project_path FROM projects WHERE id = ?1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    // Use BIOVAULT_HOME environment variable or default (consistent with CLI)
    let biovault_home = env::var("BIOVAULT_HOME").unwrap_or_else(|_| {
        // Check for existing ~/.biovault (backward compatibility)
        let home_dir = dirs::home_dir().expect("Could not determine home directory");
        let legacy_biovault = home_dir.join(".biovault");
        if legacy_biovault.join("config.yaml").exists() {
            legacy_biovault.to_string_lossy().to_string()
        } else {
            // Default to Desktop/BioVault (new default)
            dirs::desktop_dir()
                .unwrap_or_else(|| home_dir.join("Desktop"))
                .join("BioVault")
                .to_string_lossy()
                .to_string()
        }
    });
    let biovault_dir = PathBuf::from(biovault_home);
    let runs_dir = biovault_dir.join("runs");

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let run_dir = runs_dir.join(format!("{}_{}", project.0, timestamp));
    let work_dir = run_dir.join("work");
    let results_dir = run_dir.join("results");

    fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&results_dir).map_err(|e| e.to_string())?;

    let mut csv_content = String::from("participant_id,genotype_file_path\n");

    // Get all files via CLI
    let files_result = run_bv_command(&["files", "list", "--format", "json"])?;
    let files_data = files_result
        .get("data")
        .and_then(|d| d.get("files"))
        .ok_or("Missing files data")?;
    let all_files: Vec<FileRecord> = serde_json::from_value(files_data.clone())
        .map_err(|e| format!("Failed to parse files: {}", e))?;

    // Get all participants via CLI
    let participants_result = run_bv_command(&["participants", "list", "--format", "json"])?;
    let participants_data = participants_result
        .get("data")
        .ok_or("Missing participants data")?;
    let all_participants: Vec<Participant> = serde_json::from_value(participants_data.clone())
        .map_err(|e| format!("Failed to parse participants: {}", e))?;

    for participant_id in &participant_ids {
        // Find participant by database ID
        let participant = all_participants
            .iter()
            .find(|p| p.id == *participant_id)
            .ok_or_else(|| format!("Participant with id {} not found", participant_id))?;

        // Find first file for this participant
        let file = all_files
            .iter()
            .find(|f| {
                f.participant_id
                    .as_ref()
                    .map(|pid| pid == participant.participant_id.as_str())
                    .unwrap_or(false)
            })
            .ok_or_else(|| {
                format!(
                    "No files found for participant {}",
                    participant.participant_id
                )
            })?;

        csv_content.push_str(&format!(
            "{},{}\n",
            participant.participant_id, file.file_path
        ));
    }

    let samplesheet_path = work_dir.join("samplesheet.csv");
    fs::write(&samplesheet_path, csv_content).map_err(|e| e.to_string())?;

    // Create the log file immediately so event listeners can attach
    let log_path = run_dir.join("run.log");
    let mut log_file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to create log file: {}", e))?;

    writeln!(log_file, "=== Preparing analysis... ===").map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO runs (project_id, work_dir, participant_count, status) VALUES (?1, ?2, ?3, ?4)",
        params![
            project_id,
            run_dir.to_str().unwrap(),
            participant_ids.len() as i64,
            "running"
        ],
    ).map_err(|e| e.to_string())?;

    let run_id = conn.last_insert_rowid();

    for participant_id in &participant_ids {
        conn.execute(
            "INSERT INTO run_participants (run_id, participant_id) VALUES (?1, ?2)",
            params![run_id, participant_id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(RunStartResult {
        run_id,
        work_dir: run_dir.to_str().unwrap().to_string(),
    })
}

#[tauri::command]
fn execute_analysis(
    state: tauri::State<AppState>,
    run_id: i64,
    window: tauri::Window,
) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::time::{SystemTime, UNIX_EPOCH};

    // Priority: BIOVAULT_PATH env var > settings > default "bv"
    let bv_path = if let Ok(env_path) = env::var("BIOVAULT_PATH") {
        env_path
    } else {
        let settings = get_settings()?;
        if settings.biovault_path.is_empty() {
            "bv".to_string()
        } else {
            settings.biovault_path
        }
    };

    let conn = state.db.lock().unwrap();

    let (project_path, work_dir): (String, String) = conn
        .query_row(
            "SELECT p.project_path, r.work_dir
         FROM runs r
         JOIN projects p ON r.project_id = p.id
         WHERE r.id = ?1",
            params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    drop(conn);

    let run_dir_path = PathBuf::from(&work_dir);

    // Derive biovault_home from work_dir path
    // work_dir is like: /path/to/biovault/runs/project_timestamp
    // So biovault_home is two levels up
    let biovault_home = run_dir_path
        .parent() // /path/to/biovault/runs
        .and_then(|p| p.parent()) // /path/to/biovault
        .ok_or("Invalid work_dir path")?
        .to_path_buf();

    let work_subdir = run_dir_path.join("work");
    let results_subdir = run_dir_path.join("results");
    let samplesheet_path = work_subdir.join("samplesheet.csv");
    let log_path = run_dir_path.join("run.log");

    // Append to existing log file (created during start_analysis)
    let mut log_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open log file: {}", e))?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    writeln!(
        log_file,
        "\n=== Run {} started at {} ===",
        run_id, timestamp
    )
    .map_err(|e| e.to_string())?;
    writeln!(
        log_file,
        "Command: {} run --work-dir {} --results-dir {} {} {}",
        bv_path,
        work_subdir.display(),
        results_subdir.display(),
        project_path,
        samplesheet_path.display()
    )
    .map_err(|e| e.to_string())?;
    writeln!(log_file).map_err(|e| e.to_string())?;

    // Emit initial log lines to UI
    let _ = window.emit(
        "log-line",
        format!("=== Run {} started at {} ===", run_id, timestamp),
    );
    let _ = window.emit(
        "log-line",
        format!(
            "Command: {} run --work-dir {} --results-dir {} {} {}",
            bv_path,
            work_subdir.display(),
            results_subdir.display(),
            project_path,
            samplesheet_path.display()
        ),
    );
    let _ = window.emit("log-line", "");

    let mut child = Command::new(&bv_path)
        .arg("run")
        .arg("--work-dir")
        .arg(work_subdir.to_str().unwrap())
        .arg("--results-dir")
        .arg(results_subdir.to_str().unwrap())
        .arg(&project_path)
        .arg(samplesheet_path.to_str().unwrap())
        .current_dir(&biovault_home) // Set working directory to biovault_home
        .envs(env::vars()) // Inherit all environment variables (PATH, etc.)
        .env(
            "BIOVAULT_HOME",
            env::var("BIOVAULT_HOME")
                .unwrap_or_else(|_| biovault_home.to_string_lossy().to_string()),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn process: {} (bv_path: {})", e, bv_path))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let log_path_clone = log_path.clone();
    let window_clone = window.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut log_file = fs::OpenOptions::new()
            .append(true)
            .open(&log_path_clone)
            .ok();

        for line in reader.lines().map_while(Result::ok) {
            let _ = window_clone.emit("log-line", line.clone());
            if let Some(ref mut file) = log_file {
                let _ = writeln!(file, "{}", line);
            }
        }
    });

    let log_path_clone2 = log_path.clone();
    let window_clone2 = window.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut log_file = fs::OpenOptions::new()
            .append(true)
            .open(&log_path_clone2)
            .ok();

        for line in reader.lines().map_while(Result::ok) {
            let stderr_line = format!("STDERR: {}", line);
            let _ = window_clone2.emit("log-line", stderr_line.clone());
            if let Some(ref mut file) = log_file {
                let _ = writeln!(file, "{}", stderr_line);
            }
        }
    });

    let status = child.wait().map_err(|e| e.to_string())?;

    let conn = state.db.lock().unwrap();
    let status_str = if status.success() {
        "success"
    } else {
        "failed"
    };

    conn.execute(
        "UPDATE runs SET status = ?1 WHERE id = ?2",
        params![status_str, run_id],
    )
    .map_err(|e| e.to_string())?;

    // Write final status to log
    let mut log_file = fs::OpenOptions::new().append(true).open(&log_path).ok();
    if let Some(ref mut file) = log_file {
        let _ = writeln!(file, "\n=== Analysis {} ===", status_str);
        let _ = writeln!(file, "Exit code: {}", status.code().unwrap_or(-1));
    }

    let _ = window.emit("analysis-complete", status_str);

    if status.success() {
        Ok(format!(
            "Analysis completed successfully. Output in: {}",
            work_dir
        ))
    } else {
        Err("Analysis failed".to_string())
    }
}

#[tauri::command]
fn get_runs(state: tauri::State<AppState>) -> Result<Vec<Run>, String> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT r.id, r.project_id, p.name, r.work_dir, r.participant_count, r.status, r.created_at
             FROM runs r
             JOIN projects p ON r.project_id = p.id
             ORDER BY r.created_at DESC"
        )
        .map_err(|e| e.to_string())?;

    let runs = stmt
        .query_map([], |row| {
            Ok(Run {
                id: row.get(0)?,
                project_id: row.get(1)?,
                project_name: row.get(2)?,
                work_dir: row.get(3)?,
                participant_count: row.get(4)?,
                status: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(runs)
}

#[tauri::command]
fn delete_run(state: tauri::State<AppState>, run_id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();

    let work_dir: String = conn
        .query_row(
            "SELECT work_dir FROM runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    conn.execute(
        "DELETE FROM run_participants WHERE run_id = ?1",
        params![run_id],
    )
    .map_err(|e| e.to_string())?;

    conn.execute("DELETE FROM runs WHERE id = ?1", params![run_id])
        .map_err(|e| e.to_string())?;

    if Path::new(&work_dir).exists() {
        let _ = fs::remove_dir_all(&work_dir);
    }

    Ok(())
}

#[tauri::command]
fn delete_participant(_state: tauri::State<AppState>, participant_id: i64) -> Result<(), String> {
    // Use CLI command - note: CLI unlinks files instead of deleting them
    let _result = run_bv_command(&[
        "participants",
        "delete",
        &participant_id.to_string(),
        "--format",
        "json",
    ])?;

    Ok(())
}

#[tauri::command]
fn delete_participants_bulk(
    _state: tauri::State<AppState>,
    participant_ids: Vec<i64>,
) -> Result<usize, String> {
    if participant_ids.is_empty() {
        return Ok(0);
    }

    let mut args: Vec<String> = Vec::with_capacity(participant_ids.len() + 4);
    args.push("participants".to_string());
    args.push("delete-bulk".to_string());
    for id in &participant_ids {
        args.push(id.to_string());
    }
    args.push("--format".to_string());
    args.push("json".to_string());

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let result = run_bv_command(&arg_refs)?;

    if let Some(not_found) = result
        .get("data")
        .and_then(|d| d.get("not_found"))
        .and_then(|v| v.as_array())
    {
        if !not_found.is_empty() {
            eprintln!("⚠️  Some participants were not found: {:?}", not_found);
        }
    }

    let deleted = result
        .get("data")
        .and_then(|d| d.get("deleted"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    Ok(deleted as usize)
}

#[tauri::command]
fn delete_file(_state: tauri::State<AppState>, file_id: i64) -> Result<(), String> {
    // Use CLI command
    let _result = run_bv_command(&["files", "delete", &file_id.to_string(), "--format", "json"])?;

    Ok(())
}

#[tauri::command]
fn delete_files_bulk(_state: tauri::State<AppState>, file_ids: Vec<i64>) -> Result<usize, String> {
    if file_ids.is_empty() {
        return Ok(0);
    }

    eprintln!("🗑️ Deleting {} files in bulk", file_ids.len());

    // Convert IDs to comma-separated string for bulk delete
    let ids_str = file_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",");

    // Call bulk delete command
    let result = run_bv_command(&["files", "delete-bulk", &ids_str, "--format", "json"])?;

    // Parse the result
    let deleted = result
        .get("data")
        .and_then(|d| d.get("deleted"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;

    eprintln!("✅ Deleted {} files", deleted);

    Ok(deleted)
}

#[derive(Serialize, Deserialize)]
struct GenotypeMetadata {
    data_type: String,
    source: Option<String>,
    grch_version: Option<String>,
    row_count: Option<i64>,
    chromosome_count: Option<i64>,
    inferred_sex: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct LogEntry {
    timestamp: String,
    command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn get_log_file_path() -> PathBuf {
    let biovault_home = env::var("BIOVAULT_HOME").unwrap_or_else(|_| {
        dirs::home_dir()
            .unwrap()
            .join(".biovault")
            .to_string_lossy()
            .to_string()
    });
    Path::new(&biovault_home).join("desktop_commands.log")
}

fn append_log(entry: &LogEntry) -> Result<(), String> {
    let log_path = get_log_file_path();

    // Ensure directory exists
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create log directory: {}", e))?;
    }

    let json_line = serde_json::to_string(entry)
        .map_err(|e| format!("Failed to serialize log entry: {}", e))?;

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open log file: {}", e))?;

    writeln!(file, "{}", json_line).map_err(|e| format!("Failed to write to log file: {}", e))?;

    Ok(())
}

#[tauri::command]
fn get_command_logs() -> Result<Vec<LogEntry>, String> {
    let log_path = get_log_file_path();

    if !log_path.exists() {
        return Ok(Vec::new());
    }

    let file =
        std::fs::File::open(&log_path).map_err(|e| format!("Failed to open log file: {}", e))?;

    let reader = BufReader::new(file);
    let mut logs = Vec::new();

    for line_str in reader.lines().map_while(Result::ok) {
        if let Ok(entry) = serde_json::from_str::<LogEntry>(&line_str) {
            logs.push(entry);
        }
    }

    Ok(logs)
}

#[tauri::command]
fn clear_command_logs() -> Result<(), String> {
    let log_path = get_log_file_path();

    if log_path.exists() {
        fs::remove_file(&log_path).map_err(|e| format!("Failed to delete log file: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
async fn detect_file_types(
    _state: tauri::State<'_, AppState>,
    files: Vec<String>,
) -> Result<HashMap<String, GenotypeMetadata>, String> {
    if files.is_empty() {
        return Ok(HashMap::new());
    }

    eprintln!("🔍 Detecting file types for {} files", files.len());

    // Build CLI args: files detect file1 file2 file3 ... --format json
    let mut args = vec!["files", "detect"];
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs);
    args.push("--format");
    args.push("json");

    match run_bv_command(&args) {
        Ok(response) => {
            // Parse the detection results
            if let Some(detections) = response.get("detections") {
                let mut results = HashMap::new();

                for file_path in &files {
                    if let Some(metadata) = detections.get(file_path) {
                        let genotype_meta: GenotypeMetadata =
                            serde_json::from_value(metadata.clone()).unwrap_or(GenotypeMetadata {
                                data_type: "Unknown".to_string(),
                                source: None,
                                grch_version: None,
                                row_count: None,
                                chromosome_count: None,
                                inferred_sex: None,
                            });
                        results.insert(file_path.clone(), genotype_meta);
                    } else {
                        // File not in results, insert Unknown
                        results.insert(
                            file_path.clone(),
                            GenotypeMetadata {
                                data_type: "Unknown".to_string(),
                                source: None,
                                grch_version: None,
                                row_count: None,
                                chromosome_count: None,
                                inferred_sex: None,
                            },
                        );
                    }
                }

                eprintln!("✅ Detected {} file types", results.len());
                Ok(results)
            } else {
                Err("Missing detections in response".to_string())
            }
        }
        Err(e) => {
            eprintln!("❌ Failed to detect file types: {}", e);
            // Return Unknown for all files on error
            let mut results = HashMap::new();
            for file_path in files {
                results.insert(
                    file_path,
                    GenotypeMetadata {
                        data_type: "Unknown".to_string(),
                        source: None,
                        grch_version: None,
                        row_count: None,
                        chromosome_count: None,
                        inferred_sex: None,
                    },
                );
            }
            Ok(results)
        }
    }
}

#[tauri::command]
async fn analyze_file_types(
    _state: tauri::State<'_, AppState>,
    files: Vec<String>,
) -> Result<HashMap<String, GenotypeMetadata>, String> {
    if files.is_empty() {
        return Ok(HashMap::new());
    }

    eprintln!(
        "🔬 Analyzing files for row count, chromosomes, and sex: {} files",
        files.len()
    );

    // Build CLI args: files analyze file1 file2 file3 ... --format json
    let mut args = vec!["files", "analyze"];
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs);
    args.push("--format");
    args.push("json");

    match run_bv_command(&args) {
        Ok(response) => {
            if let Some(analysis) = response.get("analysis") {
                let mut results = HashMap::new();

                for file_path in &files {
                    if let Some(metadata) = analysis.get(file_path) {
                        let genotype_meta: GenotypeMetadata =
                            serde_json::from_value(metadata.clone()).unwrap_or(GenotypeMetadata {
                                data_type: "Unknown".to_string(),
                                source: None,
                                grch_version: None,
                                row_count: None,
                                chromosome_count: None,
                                inferred_sex: None,
                            });
                        results.insert(file_path.clone(), genotype_meta);
                    } else {
                        results.insert(
                            file_path.clone(),
                            GenotypeMetadata {
                                data_type: "Unknown".to_string(),
                                source: None,
                                grch_version: None,
                                row_count: None,
                                chromosome_count: None,
                                inferred_sex: None,
                            },
                        );
                    }
                }

                eprintln!("✅ Analyzed {} files", results.len());
                Ok(results)
            } else {
                Err("Missing analysis in response".to_string())
            }
        }
        Err(e) => {
            eprintln!("❌ Failed to analyze files: {}", e);
            let mut results = HashMap::new();
            for file_path in files {
                results.insert(
                    file_path,
                    GenotypeMetadata {
                        data_type: "Unknown".to_string(),
                        source: None,
                        grch_version: None,
                        row_count: None,
                        chromosome_count: None,
                        inferred_sex: None,
                    },
                );
            }
            Ok(results)
        }
    }
}

#[tauri::command]
fn get_run_logs(state: tauri::State<AppState>, run_id: i64) -> Result<String, String> {
    let conn = state.db.lock().unwrap();

    let work_dir: String = conn
        .query_row(
            "SELECT work_dir FROM runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let log_path = PathBuf::from(&work_dir).join("run.log");

    if !log_path.exists() {
        return Ok(
            "No logs available for this run yet. Logs will appear once the analysis starts."
                .to_string(),
        );
    }

    let log_content =
        fs::read_to_string(&log_path).map_err(|e| format!("Failed to read log file: {}", e))?;

    Ok(log_content)
}

#[tauri::command]
fn get_config_path() -> Result<String, String> {
    std::env::var("BIOVAULT_HOME").map_err(|_| "BIOVAULT_HOME not set".to_string())
}

#[tauri::command]
fn get_settings() -> Result<Settings, String> {
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

    // Apply environment variable override for display
    if let Ok(env_path) = env::var("BIOVAULT_PATH") {
        settings.biovault_path = format!("{} (env override)", env_path);
    }

    Ok(settings)
}

#[tauri::command]
fn save_settings(settings: Settings) -> Result<(), String> {
    let desktop_dir = dirs::desktop_dir().ok_or("Could not find desktop directory")?;
    let settings_path = desktop_dir
        .join("BioVault")
        .join("database")
        .join("settings.json");

    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    fs::write(&settings_path, json).map_err(|e| format!("Failed to write settings: {}", e))?;

    Ok(())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
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
fn show_in_folder(file_path: String) -> Result<(), String> {
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

fn load_biovault_email(biovault_home: &Option<PathBuf>) -> String {
    let config_path = if let Some(home) = biovault_home {
        home.join("config.yaml")
    } else {
        dirs::home_dir()
            .map(|h| h.join(".biovault").join("config.yaml"))
            .unwrap_or_default()
    };

    if config_path.exists() {
        if let Ok(content) = fs::read_to_string(&config_path) {
            if let Ok(yaml) = serde_yaml::from_str::<serde_yaml::Value>(&content) {
                if let Some(email) = yaml.get("email").and_then(|e| e.as_str()) {
                    return email.to_string();
                }
            }
        }
    }

    "No Config".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();

    let biovault_home = args
        .iter()
        .position(|arg| arg == "--biovault-config")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .or_else(|| std::env::var("BIOVAULT_HOME").ok().map(PathBuf::from));

    if let Some(home) = &biovault_home {
        std::env::set_var("BIOVAULT_HOME", home);
    }

    let email = load_biovault_email(&biovault_home);
    let window_title = format!("BioVault Desktop - {}", email);

    // Use unified database location (same as CLI)
    let biovault_home_dir = if let Some(home) = &biovault_home {
        home.clone()
    } else {
        dirs::home_dir()
            .expect("Could not find home directory")
            .join(".biovault")
    };

    std::fs::create_dir_all(&biovault_home_dir).expect("Could not create biovault directory");

    let db_path = biovault_home_dir.join("biovault.db");
    let conn = Connection::open(&db_path).expect("Could not open database");
    init_db(&conn).expect("Could not initialize database");

    let queue_processor_paused = Arc::new(AtomicBool::new(false)); // Start running

    let app_state = AppState {
        db: Mutex::new(conn),
        queue_processor_paused: queue_processor_paused.clone(),
    };

    // Spawn background queue processor
    let paused_flag = queue_processor_paused.clone();
    let biovault_home_for_processor = env::var("BIOVAULT_HOME")
        .unwrap_or_else(|_| biovault_home_dir.to_string_lossy().to_string());

    std::thread::spawn(move || {
        loop {
            // Check if paused
            if !paused_flag.load(Ordering::SeqCst) {
                // Process a batch of 10 files
                let bv_path = env::var("BIOVAULT_PATH").unwrap_or_else(|_| "bv".to_string());

                match std::process::Command::new(&bv_path)
                    .args([
                        "files",
                        "process-queue",
                        "--limit",
                        "10",
                        "--format",
                        "json",
                    ])
                    .env("BIOVAULT_HOME", &biovault_home_for_processor)
                    .output()
                {
                    Ok(output) => {
                        if output.status.success() {
                            let stdout = String::from_utf8_lossy(&output.stdout);
                            // Parse JSON to check if any files were processed
                            if let Ok(result) = serde_json::from_str::<serde_json::Value>(&stdout) {
                                let processed = result
                                    .get("data")
                                    .and_then(|d| d.get("processed"))
                                    .and_then(|p| p.as_u64())
                                    .unwrap_or(0);

                                // Only log if files were actually processed
                                if processed > 0 {
                                    eprintln!("✅ Queue processor: processed {} files", processed);
                                }
                            }
                        } else {
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            eprintln!("❌ Queue processor error: {}", stderr);
                        }
                    }
                    Err(e) => {
                        eprintln!("❌ Queue processor command failed: {}", e);
                    }
                }
            }

            // Wait 2 seconds before next check
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&window_title);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search_txt_files,
            suggest_patterns,
            get_extensions,
            import_files,
            import_files_with_metadata,
            import_files_pending,
            process_queue,
            pause_queue_processor,
            resume_queue_processor,
            get_queue_processor_status,
            get_participants,
            get_files,
            import_project,
            get_projects,
            delete_project,
            start_analysis,
            execute_analysis,
            get_runs,
            get_run_logs,
            delete_run,
            delete_participant,
            delete_participants_bulk,
            delete_file,
            delete_files_bulk,
            detect_file_types,
            analyze_file_types,
            get_settings,
            save_settings,
            open_folder,
            show_in_folder,
            get_config_path,
            get_command_logs,
            clear_command_logs
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
