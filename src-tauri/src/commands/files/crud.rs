use crate::commands::files::facets::facets_for_participant_ids;
use crate::types::{AppState, FileRecord};
use std::collections::HashMap;

#[tauri::command]
pub fn get_files(state: tauri::State<AppState>) -> Result<Vec<FileRecord>, String> {
    crate::desktop_log!("🔍 get_files called (using library)");

    let db = state.biovault_db.lock().unwrap();
    let cli_files = biovault::data::list_files(&db, None, None, false, None)
        .map_err(|e| format!("Failed to list files: {}", e))?;

    let participant_ids: Vec<String> = cli_files
        .iter()
        .filter_map(|f| f.participant_id.clone())
        .collect();
    let facets_by_participant =
        facets_for_participant_ids(&db, &participant_ids).unwrap_or_default();
    let metadata_sources = sources_for_file_ids(
        &db,
        &cli_files.iter().map(|file| file.id).collect::<Vec<_>>(),
    )
    .unwrap_or_default();

    // Convert CLI FileRecords to desktop FileRecords
    let files: Vec<FileRecord> = cli_files
        .into_iter()
        .map(|f| {
            let file_id = f.id;
            let source = f
                .source
                .as_ref()
                .filter(|source| !source.trim().is_empty())
                .cloned()
                .or_else(|| metadata_sources.get(&file_id).cloned());
            let facets = f
                .participant_id
                .as_ref()
                .and_then(|pid| facets_by_participant.get(pid).cloned())
                .unwrap_or_default();
            FileRecord {
                id: file_id,
                participant_id: f.participant_id,
                participant_name: f.participant_name,
                file_path: f.file_path,
                file_hash: f.file_hash,
                file_type: f.file_type,
                file_size: f.file_size,
                data_type: f.data_type,
                source,
                grch_version: f.grch_version,
                row_count: f.row_count,
                chromosome_count: f.chromosome_count,
                inferred_sex: f.inferred_sex,
                facets,
                status: f.status,
                processing_error: f.processing_error,
                created_at: f.created_at,
                updated_at: f.updated_at,
            }
        })
        .collect();

    crate::desktop_log!("✅ Returning {} files", files.len());
    Ok(files)
}

fn sources_for_file_ids(
    db: &biovault::data::BioVaultDb,
    file_ids: &[i64],
) -> Result<HashMap<i64, String>, String> {
    if file_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let mut sources = HashMap::new();
    let mut stmt = db
        .conn
        .prepare(
            "SELECT f.id,
                    COALESCE(g.source, v.source, a.source, r.source, d.source) AS source
             FROM files f
             LEFT JOIN genotype_metadata g ON g.file_id = f.id
             LEFT JOIN variant_metadata v ON v.file_id = f.id
             LEFT JOIN aligned_metadata a ON a.file_id = f.id
             LEFT JOIN reference_metadata r ON r.file_id = f.id
             LEFT JOIN database_metadata d ON d.file_id = f.id
             WHERE COALESCE(g.source, v.source, a.source, r.source, d.source) IS NOT NULL
               AND TRIM(COALESCE(g.source, v.source, a.source, r.source, d.source)) != ''",
        )
        .map_err(|e| format!("Failed to prepare source lookup: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("Failed to read source lookup: {}", e))?;
    for row in rows {
        let (file_id, source) = row.map_err(|e| format!("Failed to collect sources: {}", e))?;
        sources.insert(file_id, source);
    }
    Ok(sources)
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

#[tauri::command]
pub fn update_file_reference(
    state: tauri::State<AppState>,
    file_id: i64,
    reference_file_id: Option<i64>,
    reference_index_file_id: Option<i64>,
) -> Result<(), String> {
    crate::desktop_log!(
        "🔗 Updating reference for file {} -> ref: {:?}, idx: {:?}",
        file_id,
        reference_file_id,
        reference_index_file_id
    );

    let db = state.biovault_db.lock().unwrap();
    biovault::data::update_file_reference(&db, file_id, reference_file_id, reference_index_file_id)
        .map_err(|e| format!("Failed to update file reference: {}", e))?;

    crate::desktop_log!("✅ Updated reference for file {}", file_id);
    Ok(())
}

#[tauri::command]
pub fn get_file_reference(
    state: tauri::State<AppState>,
    file_id: i64,
) -> Result<(Option<i64>, Option<i64>), String> {
    let db = state.biovault_db.lock().unwrap();
    biovault::data::get_file_reference(&db, file_id)
        .map_err(|e| format!("Failed to get file reference: {}", e))
}
