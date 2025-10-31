use crate::types::{AppState, FileRecord};

#[tauri::command]
pub fn get_files(state: tauri::State<AppState>) -> Result<Vec<FileRecord>, String> {
    crate::desktop_log!("🔍 get_files called (using library)");

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

    crate::desktop_log!("✅ Returning {} files", files.len());
    Ok(files)
}

#[tauri::command]
pub fn delete_file(state: tauri::State<AppState>, file_id: i64) -> Result<(), String> {
    crate::desktop_log!("🗑️ delete_file called (using library)");

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

    crate::desktop_log!(
        "🗑️ Deleting {} files in bulk (using library)",
        file_ids.len()
    );

    let db = state.biovault_db.lock().unwrap();
    let deleted = biovault::data::delete_files_bulk(&db, &file_ids)
        .map_err(|e| format!("Failed to delete files: {}", e))?;

    crate::desktop_log!("✅ Deleted {} files", deleted);
    Ok(deleted)
}
