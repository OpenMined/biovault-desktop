use crate::types::{AppState, FileRecord, ImportResult};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

// Re-export FileMetadata from parent module
use super::FileMetadata;

#[tauri::command]
pub async fn import_files_with_metadata(
    state: tauri::State<'_, AppState>,
    file_metadata: std::collections::HashMap<String, FileMetadata>,
) -> Result<ImportResult, String> {
    crate::desktop_log!(
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

    crate::desktop_log!(
        "✅ Imported {} files, skipped {} (using library)",
        lib_result.imported,
        lib_result.skipped
    );

    // Log any errors
    for error in &lib_result.errors {
        crate::desktop_log!("⚠️  Import error: {}", error);
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
    crate::desktop_log!(
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

    crate::desktop_log!(
        "✅ Added {} files to queue, skipped {} (using library)",
        lib_result.imported,
        lib_result.skipped
    );

    // Log any errors
    for error in &lib_result.errors {
        crate::desktop_log!("⚠️  Import error: {}", error);
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
pub async fn import_files(
    state: tauri::State<'_, AppState>,
    files: Vec<String>,
    pattern: String,
    file_id_map: std::collections::HashMap<String, String>,
) -> Result<ImportResult, String> {
    crate::desktop_log!(
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

    crate::desktop_log!(
        "📥 Importing from common root: {} with {} extension(s), {} total files",
        common_root.display(),
        extensions.len(),
        files.len()
    );

    crate::desktop_log!("🎯 Using pattern: '{}'", pattern);
    crate::desktop_log!("\n=== PARTICIPANT ID EXTRACTION ===");

    // First scan for files
    let mut all_csv_imports = Vec::new();

    for ext in &extensions {
        crate::desktop_log!("\n📂 Scanning files with extension: {}", ext);

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
                        crate::desktop_log!("   ✓ {} → participant: {}", filename, id);
                        Some(id)
                    }
                    Ok(None) => {
                        crate::desktop_log!("   ✗ {} → no match", filename);
                        None
                    }
                    Err(err) => {
                        crate::desktop_log!(
                            "   ⚠️ {} → failed to extract using pattern '{}': {}",
                            filename,
                            pattern,
                            err
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

        crate::desktop_log!("✅ Found {} files with extension {}", file_count, ext);
    }

    crate::desktop_log!("\n=== END EXTRACTION ===\n");

    // Fast import to pending queue (no hashing/analysis)
    let db = state.biovault_db.lock().unwrap();
    let lib_result = biovault::data::import_files_as_pending(&db, all_csv_imports)
        .map_err(|e| format!("Failed to import files: {}", e))?;

    crate::desktop_log!(
        "✅ Added {} files to queue, skipped {} (background processing will complete)",
        lib_result.imported,
        lib_result.skipped
    );

    // Link files to participants in bulk if needed
    if !file_id_map.is_empty() {
        crate::desktop_log!(
            "🔗 Bulk linking {} files to participants",
            file_id_map.len()
        );

        // Call library function for bulk linking
        let linked_count = biovault::data::link_files_bulk(&db, &file_id_map)
            .map_err(|e| format!("Failed to link files: {}", e))?;

        crate::desktop_log!("✅ Bulk linked {} file(s)", linked_count);
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

    crate::desktop_log!("✅ Imported {} files successfully", imported_files.len());

    Ok(ImportResult {
        success: true,
        message: format!("Successfully imported {} files", imported_files.len()),
        conflicts: Vec::new(),
        imported_files,
    })
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
