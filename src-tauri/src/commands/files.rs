use crate::types::{
    AppState, ExtensionCount, FileRecord, ImportResult, PatternSuggestion, SampleExtraction,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

#[tauri::command]
pub fn get_extensions(path: String) -> Result<Vec<ExtensionCount>, String> {
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
pub fn search_txt_files(path: String, extensions: Vec<String>) -> Result<Vec<String>, String> {
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
pub fn suggest_patterns(files: Vec<String>) -> Result<Vec<PatternSuggestion>, String> {
    eprintln!(
        "🔍 suggest_patterns called with {} files (using library)",
        files.len()
    );

    if files.is_empty() {
        return Ok(vec![]);
    }

    let paths: Vec<PathBuf> = files.iter().map(PathBuf::from).collect();

    let common_root = find_common_root(&paths)
        .or_else(|| {
            paths
                .first()
                .and_then(|p| p.parent().map(|parent| parent.to_path_buf()))
        })
        .ok_or("Unable to determine common directory")?;

    let dir = common_root
        .to_str()
        .ok_or("Failed to convert directory to UTF-8 string")?;

    // Collect unique extensions from provided files
    let mut extensions: HashSet<String> = HashSet::new();
    for file in &paths {
        if let Some(ext) = file.extension().and_then(|e| e.to_str()) {
            extensions.insert(format!(".{}", ext));
        }
    }

    let extension_filter = if extensions.len() == 1 {
        extensions.iter().next().map(|s| s.as_str())
    } else {
        None
    };

    eprintln!(
        "📂 Analyzing directory: {}{}",
        dir,
        extension_filter
            .map(|ext| format!(" with extension: {}", ext))
            .unwrap_or_default()
    );

    let result = biovault::data::suggest_patterns(dir, extension_filter, true)
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
            regex_pattern: s.regex_pattern,
            description: s.description,
            example: s.example,
            sample_extractions: s
                .sample_extractions
                .into_iter()
                .map(|(path, participant_id)| SampleExtraction {
                    path,
                    participant_id,
                })
                .collect(),
        })
        .collect();

    eprintln!("✅ Found {} pattern suggestions", suggestions.len());
    Ok(suggestions)
}

#[tauri::command]
pub fn extract_ids_for_files(
    files: Vec<String>,
    pattern: String,
) -> Result<HashMap<String, Option<String>>, String> {
    let trimmed = pattern.trim().to_string();
    if trimmed.is_empty() {
        return Ok(files.into_iter().map(|f| (f, None)).collect());
    }

    let mut results = HashMap::new();
    for file in files {
        let extracted = biovault::data::extract_id_from_pattern(&file, &trimmed)
            .map_err(|e| format!("Failed to extract ID for {}: {}", file, e))?;
        results.insert(file, extracted);
    }

    Ok(results)
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
pub struct FileMetadata {
    pub participant_id: Option<String>,
    pub data_type: Option<String>,
    pub source: Option<String>,
    pub grch_version: Option<String>,
    pub row_count: Option<i64>,
    pub chromosome_count: Option<i64>,
    pub inferred_sex: Option<String>,
}

#[tauri::command]
pub async fn import_files_with_metadata(
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
pub async fn import_files_pending(
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
pub async fn process_queue(
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
pub fn pause_queue_processor(state: tauri::State<AppState>) -> Result<bool, String> {
    state.queue_processor_paused.store(true, Ordering::SeqCst);
    Ok(true)
}

#[tauri::command]
pub fn resume_queue_processor(state: tauri::State<AppState>) -> Result<bool, String> {
    state.queue_processor_paused.store(false, Ordering::SeqCst);
    Ok(true)
}

#[tauri::command]
pub fn get_queue_processor_status(state: tauri::State<AppState>) -> Result<bool, String> {
    Ok(!state.queue_processor_paused.load(Ordering::SeqCst))
}

#[tauri::command]
pub async fn import_files(
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
            let filename = std::path::Path::new(&file_info.path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();

            // Extract participant ID if pattern is provided
            let participant_id = if pattern.trim().is_empty() {
                None
            } else {
                match biovault::data::extract_id_from_pattern(&file_info.path, &pattern) {
                    Ok(Some(id)) => {
                        eprintln!("   ✓ {} → participant: {}", filename, id);
                        Some(id)
                    }
                    Ok(None) => {
                        eprintln!("   ✗ {} → no match", filename);
                        None
                    }
                    Err(err) => {
                        eprintln!(
                            "   ⚠️ {} → failed to extract using pattern '{}': {}",
                            filename, pattern, err
                        );
                        None
                    }
                }
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
pub fn get_files(state: tauri::State<AppState>) -> Result<Vec<FileRecord>, String> {
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
pub fn delete_file(state: tauri::State<AppState>, file_id: i64) -> Result<(), String> {
    eprintln!("🗑️ delete_file called (using library)");

    let db = state.biovault_db.lock().unwrap();
    biovault::data::delete_file(&db, file_id)
        .map_err(|e| format!("Failed to delete file: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn delete_files_bulk(
    state: tauri::State<AppState>,
    file_ids: Vec<i64>,
) -> Result<usize, String> {
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
pub struct GenotypeMetadata {
    pub data_type: String,
    pub source: Option<String>,
    pub grch_version: Option<String>,
    pub row_count: Option<i64>,
    pub chromosome_count: Option<i64>,
    pub inferred_sex: Option<String>,
}

#[tauri::command]
pub async fn detect_file_types(
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
pub async fn analyze_file_types(
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
