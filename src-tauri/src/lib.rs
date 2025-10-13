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

// BioVault CLI library imports
use biovault::cli::commands::check::DependencyCheckResult;
use biovault::data::BioVaultDb;

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
    biovault_db: Arc<Mutex<BioVaultDb>>,
    queue_processor_paused: Arc<AtomicBool>,
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
    eprintln!(
        "🔍 get_extensions called for path: {} (using library)",
        path
    );

    let scan_result = biovault::data::scan(&path, None, true)
        .map_err(|e| format!("Failed to scan directory: {}", e))?;

    let extensions: Vec<ExtensionCount> = scan_result
        .extensions
        .into_iter()
        .map(|ext| ExtensionCount {
            extension: ext.extension,
            count: ext.count,
        })
        .collect();

    eprintln!("✅ Found {} extensions", extensions.len());
    Ok(extensions)
}

#[tauri::command]
fn search_txt_files(path: String, extensions: Vec<String>) -> Result<Vec<String>, String> {
    eprintln!(
        "🔍 search_txt_files called for path: {} with {} extensions (using library)",
        path,
        extensions.len()
    );

    if extensions.is_empty() {
        return Ok(Vec::new());
    }

    // Scan recursively for all files
    let scan_result = biovault::data::scan(&path, None, true)
        .map_err(|e| format!("Failed to scan directory: {}", e))?;

    // Normalize extensions (add leading dot if missing)
    let normalized_exts: Vec<String> = extensions
        .iter()
        .map(|ext| {
            if ext.starts_with('.') {
                ext.clone()
            } else {
                format!(".{}", ext)
            }
        })
        .collect();

    // Filter files by extension
    let filtered_files: Vec<String> = scan_result
        .files
        .into_iter()
        .filter(|file| {
            if let Some(ext) = std::path::Path::new(&file.path).extension() {
                let ext_with_dot = format!(".{}", ext.to_string_lossy());
                normalized_exts.contains(&ext_with_dot)
            } else {
                false
            }
        })
        .map(|file| file.path)
        .collect();

    eprintln!(
        "✅ Found {} files matching extensions",
        filtered_files.len()
    );
    Ok(filtered_files)
}

#[tauri::command]
fn suggest_patterns(files: Vec<String>) -> Result<Vec<PatternSuggestion>, String> {
    eprintln!(
        "🔍 suggest_patterns called with {} files (using library)",
        files.len()
    );

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

    let result = biovault::data::suggest_patterns(dir, Some(&ext_with_dot), false)
        .map_err(|e| format!("Failed to suggest patterns: {}", e))?;

    eprintln!("\n=== PATTERN SUGGESTIONS ===");
    for (idx, suggestion) in result.suggestions.iter().enumerate() {
        eprintln!("\n📋 Suggestion #{}", idx + 1);
        eprintln!("   Pattern: {}", suggestion.pattern);
        eprintln!("   Description: {}", suggestion.description);
        eprintln!("   Example: {}", suggestion.example);
        eprintln!("   Sample extractions:");
        for (filename, extracted_id) in &suggestion.sample_extractions {
            eprintln!("      {} → {}", filename, extracted_id);
        }
    }
    eprintln!("\n=== END SUGGESTIONS ===\n");

    let suggestions: Vec<PatternSuggestion> = result
        .suggestions
        .into_iter()
        .map(|s| PatternSuggestion {
            pattern: s.pattern,
            description: s.description,
        })
        .collect();

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
    state: tauri::State<'_, AppState>,
    file_metadata: std::collections::HashMap<String, FileMetadata>,
) -> Result<ImportResult, String> {
    eprintln!(
        "🔍 import_files_with_metadata called with {} files (using library)",
        file_metadata.len()
    );

    if file_metadata.is_empty() {
        return Err("No files selected".to_string());
    }

    // Convert desktop FileMetadata to library CsvFileImport
    let csv_imports: Vec<biovault::data::CsvFileImport> = file_metadata
        .into_iter()
        .map(|(file_path, metadata)| biovault::data::CsvFileImport {
            file_path,
            participant_id: metadata.participant_id,
            data_type: metadata.data_type,
            source: metadata.source,
            grch_version: metadata.grch_version,
            row_count: metadata.row_count,
            chromosome_count: metadata.chromosome_count,
            inferred_sex: metadata.inferred_sex,
        })
        .collect();

    // Import using library (with analysis)
    let db = state.biovault_db.lock().unwrap();
    let lib_result = biovault::data::import_from_csv(&db, csv_imports, true)
        .map_err(|e| format!("Failed to import files: {}", e))?;

    eprintln!(
        "✅ Imported {} files, skipped {} (using library)",
        lib_result.imported, lib_result.skipped
    );

    // Log any errors
    for error in &lib_result.errors {
        eprintln!("⚠️  Import error: {}", error);
    }

    // Convert library FileRecords to desktop FileRecords
    let imported_files: Vec<FileRecord> = lib_result
        .files
        .into_iter()
        .map(|f| FileRecord {
            id: f.id,
            participant_id: f.participant_id,
            participant_name: f.participant_name,
            file_path: f.file_path,
            file_hash: f.file_hash,
            file_type: f.file_type,
            file_size: f.file_size,
            data_type: f.data_type,
            source: f.source,
            grch_version: f.grch_version,
            row_count: f.row_count,
            chromosome_count: f.chromosome_count,
            inferred_sex: f.inferred_sex,
            status: f.status,
            processing_error: f.processing_error,
            created_at: f.created_at,
            updated_at: f.updated_at,
        })
        .collect();

    Ok(ImportResult {
        success: lib_result.imported > 0,
        message: format!(
            "Successfully imported {} files, skipped {}",
            lib_result.imported, lib_result.skipped
        ),
        conflicts: Vec::new(),
        imported_files,
    })
}

#[tauri::command]
async fn import_files_pending(
    state: tauri::State<'_, AppState>,
    file_metadata: std::collections::HashMap<String, FileMetadata>,
) -> Result<ImportResult, String> {
    eprintln!(
        "🚀 import_files_pending called with {} files (fast import using library)",
        file_metadata.len()
    );

    if file_metadata.is_empty() {
        return Err("No files selected".to_string());
    }

    // Convert desktop FileMetadata to library CsvFileImport
    let csv_imports: Vec<biovault::data::CsvFileImport> = file_metadata
        .into_iter()
        .map(|(file_path, metadata)| biovault::data::CsvFileImport {
            file_path,
            participant_id: metadata.participant_id,
            data_type: metadata.data_type,
            source: metadata.source,
            grch_version: metadata.grch_version,
            row_count: metadata.row_count,
            chromosome_count: metadata.chromosome_count,
            inferred_sex: metadata.inferred_sex,
        })
        .collect();

    // Import as pending (no hashing/analysis, just add to queue)
    let db = state.biovault_db.lock().unwrap();
    let lib_result = biovault::data::import_files_as_pending(&db, csv_imports)
        .map_err(|e| format!("Failed to import files as pending: {}", e))?;

    eprintln!(
        "✅ Added {} files to queue, skipped {} (using library)",
        lib_result.imported, lib_result.skipped
    );

    // Log any errors
    for error in &lib_result.errors {
        eprintln!("⚠️  Import error: {}", error);
    }

    Ok(ImportResult {
        success: lib_result.imported > 0,
        message: format!(
            "Added {} files to queue for processing, skipped {}",
            lib_result.imported, lib_result.skipped
        ),
        conflicts: Vec::new(),
        imported_files: Vec::new(), // Will be populated when queue is processed
    })
}

#[tauri::command]
async fn process_queue(
    state: tauri::State<'_, AppState>,
    limit: usize,
) -> Result<serde_json::Value, String> {
    eprintln!(
        "⚙️ process_queue called with limit: {} (using library)",
        limit
    );

    let db = state.biovault_db.lock().unwrap();

    // Get pending files from database
    let pending_files = biovault::data::get_pending_files(&db, limit)
        .map_err(|e| format!("Failed to get pending files: {}", e))?;

    if pending_files.is_empty() {
        eprintln!("No pending files in queue");
        return Ok(serde_json::json!({
            "success": true,
            "data": {
                "processed": 0,
                "errors": 0,
                "total": 0
            }
        }));
    }

    eprintln!("📦 Processing {} pending files...", pending_files.len());

    let mut processed = 0;
    let mut errors = 0;

    for file in pending_files.iter() {
        eprintln!("  Processing: {}", file.file_path);

        // Mark as processing
        if let Err(e) = biovault::data::update_file_status(&db, file.id, "processing", None) {
            eprintln!("⚠️  Failed to update status for {}: {}", file.file_path, e);
            continue;
        }

        // Process the file: hash + detect metadata + analyze
        match process_single_file_sync(&db, file) {
            Ok(_) => {
                if let Err(e) = biovault::data::update_file_status(&db, file.id, "complete", None) {
                    eprintln!("⚠️  Failed to mark complete for {}: {}", file.file_path, e);
                }
                processed += 1;
                eprintln!("    ✓ Complete");
            }
            Err(e) => {
                let error_msg = e.to_string();
                if let Err(e) =
                    biovault::data::update_file_status(&db, file.id, "error", Some(&error_msg))
                {
                    eprintln!(
                        "⚠️  Failed to update error status for {}: {}",
                        file.file_path, e
                    );
                }
                errors += 1;
                eprintln!("    ✗ Error: {}", error_msg);
            }
        }
    }

    eprintln!("✅ Processed {} files, {} errors", processed, errors);

    Ok(serde_json::json!({
        "success": true,
        "data": {
            "processed": processed,
            "errors": errors,
            "total": pending_files.len()
        }
    }))
}

/// Process a single file from the queue (synchronous version for desktop)
fn process_single_file_sync(
    db: &biovault::data::BioVaultDb,
    file: &biovault::data::PendingFile,
) -> Result<(), String> {
    // 1. Hash the file
    let hash = biovault::data::hash_file(&file.file_path)
        .map_err(|e| format!("Failed to hash file: {}", e))?;

    // 2. Detect genotype metadata if not already set
    let mut metadata = if file.data_type.as_deref() == Some("Unknown") || file.data_type.is_none() {
        biovault::data::detect_genotype_metadata(&file.file_path).ok()
    } else if file.data_type.as_deref() == Some("Genotype") {
        // Already detected as Genotype, load existing metadata if available
        match biovault::data::get_genotype_metadata(db, file.id) {
            Ok(Some(existing)) => Some(existing),
            _ => {
                // No existing metadata, create placeholder
                Some(biovault::data::GenotypeMetadata {
                    data_type: "Genotype".to_string(),
                    source: None,
                    grch_version: None,
                    row_count: None,
                    chromosome_count: None,
                    inferred_sex: None,
                })
            }
        }
    } else {
        None
    };

    // 3. If this is a Genotype file, analyze it for row counts, chromosomes, sex
    if let Some(ref mut meta) = metadata {
        if meta.data_type == "Genotype" {
            match biovault::data::analyze_genotype_file(&file.file_path) {
                Ok(analysis) => {
                    // Merge analysis data into metadata
                    if meta.row_count.is_none() {
                        meta.row_count = analysis.row_count;
                    }
                    if meta.chromosome_count.is_none() {
                        meta.chromosome_count = analysis.chromosome_count;
                    }
                    if meta.inferred_sex.is_none() {
                        meta.inferred_sex = analysis.inferred_sex.clone();
                    }
                }
                Err(e) => {
                    eprintln!("⚠️  Warning: Failed to analyze {}: {}", file.file_path, e);
                    // Continue with basic metadata
                }
            }
        }
    }

    // 4. Update the file in database
    biovault::data::update_file_from_queue(db, file.id, &hash, metadata.as_ref())
        .map_err(|e| format!("Failed to update file: {}", e))?;

    Ok(())
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
    state: tauri::State<'_, AppState>,
    files: Vec<String>,
    pattern: String,
    file_id_map: std::collections::HashMap<String, String>,
) -> Result<ImportResult, String> {
    eprintln!(
        "🔍 import_files called with {} files, pattern: {} (using library)",
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

    eprintln!("🎯 Using pattern: '{}'", pattern);
    eprintln!("\n=== PARTICIPANT ID EXTRACTION ===");

    // First scan for files
    let mut all_csv_imports = Vec::new();

    for ext in &extensions {
        eprintln!("\n📂 Scanning files with extension: {}", ext);

        // Scan directory
        let scan_result = biovault::data::scan(
            common_root.to_str().unwrap(),
            Some(ext.as_str()),
            true, // recursive
        )
        .map_err(|e| format!("Failed to scan directory: {}", e))?;

        let file_count = scan_result.files.len();

        // Convert scanned files to CsvFileImport format
        for file_info in scan_result.files {
            // Extract participant ID if pattern is provided
            let participant_id = if !pattern.is_empty() {
                let extracted = biovault::data::extract_id_from_pattern(&file_info.path, &pattern);

                // Log extraction
                let filename = std::path::Path::new(&file_info.path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown");

                if let Some(ref id) = extracted {
                    eprintln!("   ✓ {} → participant: {}", filename, id);
                } else {
                    eprintln!("   ✗ {} → no match", filename);
                }

                extracted
            } else {
                None
            };

            all_csv_imports.push(biovault::data::CsvFileImport {
                file_path: file_info.path,
                participant_id,
                data_type: None,
                source: None,
                grch_version: None,
                row_count: None,
                chromosome_count: None,
                inferred_sex: None,
            });
        }

        eprintln!("✅ Found {} files with extension {}", file_count, ext);
    }

    eprintln!("\n=== END EXTRACTION ===\n");

    // Fast import to pending queue (no hashing/analysis)
    let db = state.biovault_db.lock().unwrap();
    let lib_result = biovault::data::import_files_as_pending(&db, all_csv_imports)
        .map_err(|e| format!("Failed to import files: {}", e))?;

    eprintln!(
        "✅ Added {} files to queue, skipped {} (background processing will complete)",
        lib_result.imported, lib_result.skipped
    );

    // Link files to participants in bulk if needed
    if !file_id_map.is_empty() {
        eprintln!(
            "🔗 Bulk linking {} files to participants",
            file_id_map.len()
        );

        // Call library function for bulk linking
        let linked_count = biovault::data::link_files_bulk(&db, &file_id_map)
            .map_err(|e| format!("Failed to link files: {}", e))?;

        eprintln!("✅ Bulk linked {} file(s)", linked_count);
    }

    // Fetch files to get updated participant links using library
    let cli_files = biovault::data::list_files(&db, None, None, false, None)
        .map_err(|e| format!("Failed to list files: {}", e))?;

    // Convert library FileRecords to desktop FileRecords
    let all_files: Vec<FileRecord> = cli_files
        .into_iter()
        .map(|f| FileRecord {
            id: f.id,
            participant_id: f.participant_id,
            participant_name: f.participant_name,
            file_path: f.file_path,
            file_hash: f.file_hash,
            file_type: f.file_type,
            file_size: f.file_size,
            data_type: f.data_type,
            source: f.source,
            grch_version: f.grch_version,
            row_count: f.row_count,
            chromosome_count: f.chromosome_count,
            inferred_sex: f.inferred_sex,
            status: f.status,
            processing_error: f.processing_error,
            created_at: f.created_at,
            updated_at: f.updated_at,
        })
        .collect();

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
fn get_participants(state: tauri::State<AppState>) -> Result<Vec<Participant>, String> {
    eprintln!("🔍 get_participants called (using library)");

    let db = state.biovault_db.lock().unwrap();
    let cli_participants = biovault::data::list_participants(&db)
        .map_err(|e| format!("Failed to list participants: {}", e))?;

    // Convert CLI ParticipantRecords to desktop Participants
    let participants: Vec<Participant> = cli_participants
        .into_iter()
        .map(|p| Participant {
            id: p.id,
            participant_id: p.participant_id,
            created_at: p.created_at,
            file_count: p.file_count,
        })
        .collect();

    eprintln!("✅ Returning {} participants", participants.len());
    Ok(participants)
}

#[tauri::command]
fn get_files(state: tauri::State<AppState>) -> Result<Vec<FileRecord>, String> {
    eprintln!("🔍 get_files called (using library)");

    let db = state.biovault_db.lock().unwrap();
    let cli_files = biovault::data::list_files(&db, None, None, false, None)
        .map_err(|e| format!("Failed to list files: {}", e))?;

    // Convert CLI FileRecords to desktop FileRecords
    let files: Vec<FileRecord> = cli_files
        .into_iter()
        .map(|f| FileRecord {
            id: f.id,
            participant_id: f.participant_id,
            participant_name: f.participant_name,
            file_path: f.file_path,
            file_hash: f.file_hash,
            file_type: f.file_type,
            file_size: f.file_size,
            data_type: f.data_type,
            source: f.source,
            grch_version: f.grch_version,
            row_count: f.row_count,
            chromosome_count: f.chromosome_count,
            inferred_sex: f.inferred_sex,
            status: f.status,
            processing_error: f.processing_error,
            created_at: f.created_at,
            updated_at: f.updated_at,
        })
        .collect();

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

    let imported = tauri::async_runtime::block_on(
        biovault::cli::commands::project_management::import_project_record(
            url.clone(),
            None,
            overwrite,
        ),
    )
    .map_err(|e| format!("Failed to import project: {}", e))?;

    eprintln!("✅ Project imported via library: {}", imported.name);

    Ok(Project {
        id: imported.id,
        name: imported.name,
        author: imported.author,
        workflow: imported.workflow,
        template: imported.template,
        project_path: imported.project_path,
        created_at: imported.created_at,
    })
}

#[tauri::command]
fn get_projects(state: tauri::State<AppState>) -> Result<Vec<Project>, String> {
    eprintln!("🔍 get_projects called (using library)");

    let db = state.biovault_db.lock().unwrap();
    let cli_projects = db
        .list_projects()
        .map_err(|e| format!("Failed to list projects: {}", e))?;

    // Convert CLI projects to desktop projects
    let projects: Vec<Project> = cli_projects
        .into_iter()
        .map(|p| Project {
            id: p.id,
            name: p.name,
            author: p.author,
            workflow: p.workflow,
            template: p.template,
            project_path: p.project_path,
            created_at: p.created_at,
        })
        .collect();

    eprintln!("✅ Returning {} projects", projects.len());
    Ok(projects)
}

#[tauri::command]
fn delete_project(state: tauri::State<AppState>, project_id: i64) -> Result<(), String> {
    eprintln!(
        "🔍 delete_project called with ID: {} (using library)",
        project_id
    );

    let db = state.biovault_db.lock().unwrap();
    let id_str = project_id.to_string();
    db.delete_project(&id_str)
        .map_err(|e| format!("Failed to delete project: {}", e))?;

    eprintln!("✅ Project deleted");
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

    // Use BIOVAULT_HOME environment variable or default to Desktop/BioVault
    let biovault_home = env::var("BIOVAULT_HOME").unwrap_or_else(|_| {
        let home_dir = dirs::home_dir().expect("Could not determine home directory");
        dirs::desktop_dir()
            .unwrap_or_else(|| home_dir.join("Desktop"))
            .join("BioVault")
            .to_string_lossy()
            .to_string()
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

    // Get all files via library
    let bv_db = state.biovault_db.lock().unwrap();
    let cli_files = biovault::data::list_files(&bv_db, None, None, false, None)
        .map_err(|e| format!("Failed to list files: {}", e))?;
    let all_files: Vec<FileRecord> = cli_files
        .into_iter()
        .map(|f| FileRecord {
            id: f.id,
            participant_id: f.participant_id,
            participant_name: f.participant_name,
            file_path: f.file_path,
            file_hash: f.file_hash,
            file_type: f.file_type,
            file_size: f.file_size,
            data_type: f.data_type,
            source: f.source,
            grch_version: f.grch_version,
            row_count: f.row_count,
            chromosome_count: f.chromosome_count,
            inferred_sex: f.inferred_sex,
            status: f.status,
            processing_error: f.processing_error,
            created_at: f.created_at,
            updated_at: f.updated_at,
        })
        .collect();

    // Get all participants via library
    let cli_participants = biovault::data::list_participants(&bv_db)
        .map_err(|e| format!("Failed to list participants: {}", e))?;
    let all_participants: Vec<Participant> = cli_participants
        .into_iter()
        .map(|p| Participant {
            id: p.id,
            participant_id: p.participant_id,
            created_at: p.created_at,
            file_count: p.file_count,
        })
        .collect();
    drop(bv_db);

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
fn delete_participant(state: tauri::State<AppState>, participant_id: i64) -> Result<(), String> {
    eprintln!("🗑️ delete_participant called (using library)");

    let db = state.biovault_db.lock().unwrap();
    biovault::data::delete_participant(&db, participant_id)
        .map_err(|e| format!("Failed to delete participant: {}", e))?;

    Ok(())
}

#[tauri::command]
fn delete_participants_bulk(
    state: tauri::State<AppState>,
    participant_ids: Vec<i64>,
) -> Result<usize, String> {
    if participant_ids.is_empty() {
        return Ok(0);
    }

    eprintln!(
        "🗑️ Deleting {} participants in bulk (using library)",
        participant_ids.len()
    );

    let db = state.biovault_db.lock().unwrap();
    let deleted = biovault::data::delete_participants_bulk(&db, &participant_ids)
        .map_err(|e| format!("Failed to delete participants: {}", e))?;

    eprintln!("✅ Deleted {} participants", deleted);
    Ok(deleted)
}

#[tauri::command]
fn delete_file(state: tauri::State<AppState>, file_id: i64) -> Result<(), String> {
    eprintln!("🗑️ delete_file called (using library)");

    let db = state.biovault_db.lock().unwrap();
    biovault::data::delete_file(&db, file_id)
        .map_err(|e| format!("Failed to delete file: {}", e))?;

    Ok(())
}

#[tauri::command]
fn delete_files_bulk(state: tauri::State<AppState>, file_ids: Vec<i64>) -> Result<usize, String> {
    if file_ids.is_empty() {
        return Ok(0);
    }

    eprintln!(
        "🗑️ Deleting {} files in bulk (using library)",
        file_ids.len()
    );

    let db = state.biovault_db.lock().unwrap();
    let deleted = biovault::data::delete_files_bulk(&db, &file_ids)
        .map_err(|e| format!("Failed to delete files: {}", e))?;

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
        let home_dir = dirs::home_dir().unwrap();
        dirs::desktop_dir()
            .unwrap_or_else(|| home_dir.join("Desktop"))
            .join("BioVault")
            .to_string_lossy()
            .to_string()
    });
    Path::new(&biovault_home).join("desktop_commands.log")
}

#[allow(dead_code)]
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

    eprintln!(
        "🔍 Detecting file types for {} files (using library)",
        files.len()
    );

    let mut results = HashMap::new();

    for file_path in files {
        let metadata = biovault::data::detect_genotype_metadata(&file_path).unwrap_or_else(|e| {
            eprintln!("⚠️  Failed to detect {}: {}", file_path, e);
            biovault::data::GenotypeMetadata::default()
        });

        results.insert(
            file_path.clone(),
            GenotypeMetadata {
                data_type: metadata.data_type,
                source: metadata.source,
                grch_version: metadata.grch_version,
                row_count: metadata.row_count,
                chromosome_count: metadata.chromosome_count,
                inferred_sex: metadata.inferred_sex,
            },
        );
    }

    eprintln!("✅ Detected {} file types", results.len());
    Ok(results)
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
        "🔬 Analyzing files for row count, chromosomes, and sex: {} files (using library)",
        files.len()
    );

    let mut results = HashMap::new();

    for file_path in files {
        let metadata = biovault::data::analyze_genotype_file(&file_path).unwrap_or_else(|e| {
            eprintln!("⚠️  Failed to analyze {}: {}", file_path, e);
            biovault::data::GenotypeMetadata::default()
        });

        results.insert(
            file_path.clone(),
            GenotypeMetadata {
                data_type: metadata.data_type,
                source: metadata.source,
                grch_version: metadata.grch_version,
                row_count: metadata.row_count,
                chromosome_count: metadata.chromosome_count,
                inferred_sex: metadata.inferred_sex,
            },
        );
    }

    eprintln!("✅ Analyzed {} files", results.len());
    Ok(results)
}

#[tauri::command]
fn get_run_logs(state: tauri::State<AppState>, run_id: i64) -> Result<String, String> {
    // Default: return last 500 lines for fast initial load
    get_run_logs_tail(state, run_id, 500)
}

#[tauri::command]
fn get_run_logs_tail(
    state: tauri::State<AppState>,
    run_id: i64,
    lines: usize,
) -> Result<String, String> {
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

    // Read last N lines efficiently
    let file = fs::File::open(&log_path).map_err(|e| format!("Failed to open log file: {}", e))?;
    let reader = BufReader::new(file);

    let all_lines: Vec<String> = reader.lines().map_while(Result::ok).collect();

    let total_lines = all_lines.len();
    let start_index = total_lines.saturating_sub(lines);

    let tail_lines: Vec<String> = all_lines.into_iter().skip(start_index).collect();

    Ok(tail_lines.join("\n"))
}

#[tauri::command]
fn get_run_logs_full(state: tauri::State<AppState>, run_id: i64) -> Result<String, String> {
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
    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    Ok(biovault_home
        .join("config.yaml")
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
fn check_is_onboarded() -> Result<bool, String> {
    let biovault_home = env::var("BIOVAULT_HOME").unwrap_or_else(|_| {
        let home_dir = dirs::home_dir().unwrap();
        dirs::desktop_dir()
            .unwrap_or_else(|| home_dir.join("Desktop"))
            .join("BioVault")
            .to_string_lossy()
            .to_string()
    });

    let config_path = PathBuf::from(&biovault_home).join("config.yaml");
    Ok(config_path.exists())
}

#[tauri::command]
fn reset_all_data(_state: tauri::State<AppState>) -> Result<(), String> {
    eprintln!("🗑️ RESET: Deleting all BioVault data");

    // Delete BIOVAULT_HOME directory (defaults to Desktop/BioVault)
    let biovault_home = env::var("BIOVAULT_HOME").unwrap_or_else(|_| {
        let home_dir = dirs::home_dir().unwrap();
        dirs::desktop_dir()
            .unwrap_or_else(|| home_dir.join("Desktop"))
            .join("BioVault")
            .to_string_lossy()
            .to_string()
    });

    let biovault_path = PathBuf::from(&biovault_home);

    if biovault_path.exists() {
        fs::remove_dir_all(&biovault_path)
            .map_err(|e| format!("Failed to delete BIOVAULT_HOME: {}", e))?;
        eprintln!("   Deleted: {}", biovault_path.display());
    }

    eprintln!("✅ RESET: All data deleted successfully");
    Ok(())
}

#[tauri::command]
fn complete_onboarding(email: String) -> Result<(), String> {
    let biovault_home = env::var("BIOVAULT_HOME").unwrap_or_else(|_| {
        let home_dir = dirs::home_dir().unwrap();
        dirs::desktop_dir()
            .unwrap_or_else(|| home_dir.join("Desktop"))
            .join("BioVault")
            .to_string_lossy()
            .to_string()
    });

    let biovault_path = PathBuf::from(&biovault_home);
    fs::create_dir_all(&biovault_path)
        .map_err(|e| format!("Failed to create BIOVAULT_HOME: {}", e))?;

    // Create config with email and save any custom binary paths that were configured
    let config_path = biovault_path.join("config.yaml");

    // Load existing config if it exists (to preserve binary paths set during dependency checks)
    let config = if config_path.exists() {
        if let Ok(mut existing) = biovault::config::Config::load() {
            existing.email = email.clone();
            existing
        } else {
            biovault::config::Config {
                email: email.clone(),
                syftbox_config: None,
                version: None,
                binary_paths: None,
                syftbox_credentials: None,
            }
        }
    } else {
        biovault::config::Config {
            email: email.clone(),
            syftbox_config: None,
            version: None,
            binary_paths: None,
            syftbox_credentials: None,
        }
    };

    // Save the config
    config
        .save(&config_path)
        .map_err(|e| format!("Failed to save config: {}", e))?;

    // Also save the current dependency states for later retrieval
    save_dependency_states(&biovault_path)?;

    eprintln!("✅ Onboarding complete for: {}", email);
    Ok(())
}

// Helper function to save dependency states
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
fn save_settings(settings: Settings) -> Result<(), String> {
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
        let home_dir = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        dirs::desktop_dir()
            .unwrap_or_else(|| home_dir.join("Desktop"))
            .join("BioVault")
            .join("config.yaml")
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

    "Setup".to_string()
}

#[tauri::command]
async fn check_dependencies() -> Result<DependencyCheckResult, String> {
    eprintln!("🔍 check_dependencies called");

    // Call the library function directly
    biovault::cli::commands::check::check_dependencies_result()
        .map_err(|e| format!("Failed to check dependencies: {}", e))
}

#[tauri::command]
async fn check_single_dependency(
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
fn get_saved_dependency_states() -> Result<DependencyCheckResult, String> {
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
async fn save_custom_path(name: String, path: String) -> Result<(), String> {
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
fn update_saved_dependency_states() -> Result<(), String> {
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
fn check_brew_installed() -> Result<bool, String> {
    eprintln!("🍺 Checking if Homebrew is installed (using library)");

    // Call the library function
    biovault::cli::commands::check::check_brew_installed()
        .map_err(|e| format!("Failed to check brew: {}", e))
}

#[tauri::command]
async fn install_brew() -> Result<String, String> {
    eprintln!("🍺 Installing Homebrew (using library)");

    // Call the library function
    biovault::cli::commands::check::install_brew()
        .map_err(|e| format!("Failed to install brew: {}", e))
}

#[tauri::command]
async fn install_dependency(name: String) -> Result<String, String> {
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
async fn install_dependencies(names: Vec<String>) -> Result<(), String> {
    eprintln!("📦 install_dependencies called: {:?}", names);

    // For now, return an error since setup needs to be modified to return paths
    // TODO: Call setup::install_dependencies once it's implemented
    Err("Bulk installation is not yet implemented. Please install dependencies manually and use the 'Check Again' button.".to_string())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    eprintln!("🌐 Opening URL: {}", url);

    // Use webbrowser crate or OS-specific command to open URL
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", &url])
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }

    Ok(())
}

// SyftBox OTP Authentication Commands

#[tauri::command]
async fn syftbox_request_otp(email: String) -> Result<(), String> {
    eprintln!("📧 syftbox_request_otp called for: {}", email);

    biovault::cli::commands::syftbox::request_otp(Some(email), None, None)
        .await
        .map_err(|e| format!("{}", e))?;

    eprintln!("✅ OTP request sent successfully");
    Ok(())
}

#[tauri::command]
async fn syftbox_submit_otp(code: String, email: String) -> Result<(), String> {
    eprintln!("🔐 syftbox_submit_otp called");

    biovault::cli::commands::syftbox::submit_otp(&code, Some(email), None, None, None, None)
        .await
        .map_err(|e| format!("{}", e))?;

    eprintln!("✅ OTP verified and credentials stored");
    Ok(())
}

#[tauri::command]
fn check_syftbox_auth() -> Result<bool, String> {
    eprintln!("🔍 check_syftbox_auth called");

    // Load BioVault config to check if syftbox_credentials exist
    let config = match biovault::config::Config::load() {
        Ok(cfg) => cfg,
        Err(_) => return Ok(false), // No config = not authenticated
    };

    // Check if syftbox_credentials exist and have required fields
    let is_authenticated = if let Some(creds) = config.syftbox_credentials {
        creds.access_token.is_some() && creds.refresh_token.is_some()
    } else {
        false
    };

    eprintln!("  Authentication status: {}", is_authenticated);
    Ok(is_authenticated)
}

#[derive(Serialize)]
struct SyftBoxConfigInfo {
    is_authenticated: bool,
    config_path: String,
    has_access_token: bool,
    has_refresh_token: bool,
}

#[tauri::command]
fn get_syftbox_config_info() -> Result<SyftBoxConfigInfo, String> {
    eprintln!("🔍 get_syftbox_config_info called");

    // Get the syftbox config path
    let config = biovault::config::Config::load().ok();
    let syftbox_config_path = match &config {
        Some(cfg) => cfg.get_syftbox_config_path().ok(),
        None => None,
    };

    let config_path = syftbox_config_path
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| {
            // Default path if not configured
            dirs::home_dir()
                .map(|h| {
                    h.join(".syftbox")
                        .join("config.json")
                        .to_string_lossy()
                        .to_string()
                })
                .unwrap_or_else(|| "~/.syftbox/config.json".to_string())
        });

    // Check if authenticated by looking at syftbox_credentials
    let (has_access_token, has_refresh_token) = match config {
        Some(cfg) => match cfg.syftbox_credentials {
            Some(creds) => (creds.access_token.is_some(), creds.refresh_token.is_some()),
            None => (false, false),
        },
        None => (false, false),
    };

    let is_authenticated = has_access_token && has_refresh_token;

    eprintln!("  Config path: {}", config_path);
    eprintln!("  Has access token: {}", has_access_token);
    eprintln!("  Has refresh token: {}", has_refresh_token);
    eprintln!("  Is authenticated: {}", is_authenticated);

    Ok(SyftBoxConfigInfo {
        is_authenticated,
        config_path,
        has_access_token,
        has_refresh_token,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();

    // Desktop app defaults to Desktop/BioVault if not specified via env or args
    // Priority: 1) command-line args, 2) BIOVAULT_HOME env var, 3) Desktop/BioVault
    let biovault_home = args
        .iter()
        .position(|arg| arg == "--biovault-config")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .or_else(|| std::env::var("BIOVAULT_HOME").ok().map(PathBuf::from))
        .or_else(|| {
            // Desktop app defaults to Desktop/BioVault only if nothing else specified
            let home_dir = dirs::home_dir()?;
            let desktop_dir = dirs::desktop_dir().unwrap_or_else(|| home_dir.join("Desktop"));
            Some(desktop_dir.join("BioVault"))
        });

    // Only set BIOVAULT_HOME if it's not already set by the environment
    // This allows virtualenvs or external tools to specify the location
    if std::env::var("BIOVAULT_HOME").is_err() {
        if let Some(home) = &biovault_home {
            std::env::set_var("BIOVAULT_HOME", home);
        }
    }

    // Initialize shared BioVaultDb (handles files/participants)
    // This automatically creates the directory via get_biovault_home() if needed
    let biovault_db = BioVaultDb::new().expect("Failed to initialize BioVault database");

    // Get the actual biovault_home_dir that was used (for window title)
    let biovault_home_dir =
        biovault::config::get_biovault_home().expect("Failed to get BioVault home directory");

    let email = load_biovault_email(&Some(biovault_home_dir.clone()));
    let window_title = format!("BioVault - {}", email);

    // Desktop DB for runs/projects (keep separate for now)
    let db_path = biovault_home_dir.join("biovault.db");
    let conn = Connection::open(&db_path).expect("Could not open database");
    init_db(&conn).expect("Could not initialize database");

    let queue_processor_paused = Arc::new(AtomicBool::new(false)); // Start running

    let app_state = AppState {
        db: Mutex::new(conn),
        biovault_db: Arc::new(Mutex::new(biovault_db)),
        queue_processor_paused: queue_processor_paused.clone(),
    };

    // Spawn background queue processor (using library)
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
                            let marked = {
                                match biovault_db_for_processor.lock() {
                                    Ok(db) => biovault::data::update_file_status(
                                        &db,
                                        file.id,
                                        "processing",
                                        None,
                                    )
                                    .is_ok(),
                                    Err(_) => false,
                                }
                            };

                            if !marked {
                                continue;
                            }

                            // Process file WITHOUT holding lock (expensive I/O operations)
                            let hash_result = biovault::data::hash_file(&file.file_path);

                            match hash_result {
                                Ok(hash) => {
                                    // Detect and analyze file WITHOUT holding lock
                                    let metadata = if file.data_type.as_deref() == Some("Unknown")
                                        || file.data_type.is_none()
                                    {
                                        // Detect file type first
                                        if let Ok(detected) =
                                            biovault::data::detect_genotype_metadata(
                                                &file.file_path,
                                            )
                                        {
                                            if detected.data_type == "Genotype" {
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
                                        // Already known to be genotype - analyze it
                                        biovault::data::analyze_genotype_file(&file.file_path).ok()
                                    } else {
                                        None
                                    };

                                    // Lock briefly to update DB with results
                                    match biovault_db_for_processor.lock() {
                                        Ok(db) => {
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
                                        Err(_) => continue,
                                    }
                                }
                                Err(e) => {
                                    // Lock briefly to mark error
                                    let error_msg = format!("{}", e);
                                    if let Ok(db) = biovault_db_for_processor.lock() {
                                        let _ = biovault::data::update_file_status(
                                            &db,
                                            file.id,
                                            "error",
                                            Some(&error_msg),
                                        );
                                    }
                                    errors += 1;
                                }
                            }
                        }

                        // Only log if files were actually processed
                        if processed > 0 {
                            eprintln!(
                                "✅ Queue processor: processed {} files ({} errors)",
                                processed, errors
                            );
                        }
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
            get_run_logs_tail,
            get_run_logs_full,
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
            clear_command_logs,
            check_is_onboarded,
            complete_onboarding,
            reset_all_data,
            check_dependencies,
            check_single_dependency,
            get_saved_dependency_states,
            save_custom_path,
            check_brew_installed,
            install_brew,
            install_dependency,
            install_dependencies,
            open_url,
            syftbox_request_otp,
            syftbox_submit_otp,
            check_syftbox_auth,
            get_syftbox_config_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
