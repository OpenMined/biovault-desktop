use crate::types::AppState;
use std::sync::atomic::Ordering;

#[tauri::command]
pub async fn process_queue(
    state: tauri::State<'_, AppState>,
    limit: usize,
) -> Result<serde_json::Value, String> {
    crate::desktop_log!(
        "⚙️ process_queue called with limit: {} (using library)",
        limit
    );

    let db = state.biovault_db.lock().unwrap();

    // Get pending files from database
    let pending_files = biovault::data::get_pending_files(&db, limit)
        .map_err(|e| format!("Failed to get pending files: {}", e))?;

    if pending_files.is_empty() {
        crate::desktop_log!("No pending files in queue");
        return Ok(serde_json::json!({
            "success": true,
            "data": {
                "processed": 0,
                "errors": 0,
                "total": 0
            }
        }));
    }

    crate::desktop_log!("📦 Processing {} pending files...", pending_files.len());

    let mut processed = 0;
    let mut errors = 0;

    for file in pending_files.iter() {
        crate::desktop_log!("  Processing: {}", file.file_path);

        // Mark as processing
        if let Err(e) = biovault::data::update_file_status(&db, file.id, "processing", None) {
            crate::desktop_log!("⚠️  Failed to update status for {}: {}", file.file_path, e);
            continue;
        }

        // Process the file: hash + detect metadata + analyze
        match process_single_file_sync(&db, file) {
            Ok(_) => {
                if let Err(e) = biovault::data::update_file_status(&db, file.id, "complete", None) {
                    crate::desktop_log!(
                        "⚠️  Failed to mark complete for {}: {}",
                        file.file_path,
                        e
                    );
                }
                processed += 1;
                crate::desktop_log!("    ✓ Complete");
            }
            Err(e) => {
                let error_msg = e.to_string();
                if let Err(e) =
                    biovault::data::update_file_status(&db, file.id, "error", Some(&error_msg))
                {
                    crate::desktop_log!(
                        "⚠️  Failed to update error status for {}: {}",
                        file.file_path,
                        e
                    );
                }
                errors += 1;
                crate::desktop_log!("    ✗ Error: {}", error_msg);
            }
        }
    }

    crate::desktop_log!("✅ Processed {} files, {} errors", processed, errors);

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
                    crate::desktop_log!("⚠️  Warning: Failed to analyze {}: {}", file.file_path, e);
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
    crate::desktop_log!("⏸️ pause_queue_processor called");

    // Pause the processor first
    state.queue_processor_paused.store(true, Ordering::SeqCst);
    crate::desktop_log!("   Set pause flag to true");

    // Small delay to let current loop iteration check the flag
    std::thread::sleep(std::time::Duration::from_millis(100));

    // Reset any files marked as "processing" back to "pending" so they can be picked up again when resumed
    let db = state.biovault_db.lock().unwrap();
    let conn = db.connection();

    let reset_count = conn
        .execute(
            "UPDATE files SET status = 'pending' WHERE status = 'processing'",
            [],
        )
        .map_err(|e| format!("Failed to reset processing files: {}", e))?;

    if reset_count > 0 {
        crate::desktop_log!(
            "   Reset {} processing file(s) back to pending",
            reset_count
        );
    }

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
pub fn clear_pending_queue(state: tauri::State<AppState>) -> Result<usize, String> {
    crate::desktop_log!("🗑️ clear_pending_queue called");

    // Pause the queue processor first to prevent race conditions
    state.queue_processor_paused.store(true, Ordering::SeqCst);
    crate::desktop_log!("   Paused queue processor");

    // Small delay to let any in-flight operations complete
    std::thread::sleep(std::time::Duration::from_millis(100));

    let db = state.biovault_db.lock().unwrap();
    let conn = db.connection();

    // Delete files with status 'pending' or 'processing'
    let deleted = conn
        .execute(
            "DELETE FROM files WHERE status IN ('pending', 'processing')",
            [],
        )
        .map_err(|e| format!("Failed to clear pending queue: {}", e))?;

    crate::desktop_log!(
        "✅ Cleared {} files (pending + processing) from queue",
        deleted
    );
    Ok(deleted)
}

#[derive(serde::Serialize)]
pub struct QueueInfo {
    pub total_pending: usize,
    pub processing_count: usize,
    pub queue_position: Option<usize>, // Position of specific file if file_id provided
    pub is_processor_running: bool,
    pub currently_processing: Option<QueueFileInfo>,
    pub estimated_time_remaining_seconds: Option<f64>, // Estimated seconds remaining for queue
}

#[derive(serde::Serialize)]
pub struct QueueFileInfo {
    pub id: i64,
    pub file_path: String,
}

#[tauri::command]
pub fn get_queue_info(
    state: tauri::State<AppState>,
    file_id: Option<i64>,
) -> Result<QueueInfo, String> {
    let db = state.biovault_db.lock().unwrap();

    // Use library function to get queue info (includes time estimates)
    let lib_info = biovault::data::get_queue_info(&db, file_id)
        .map_err(|e| format!("Failed to get queue info: {}", e))?;

    let is_processor_running = !state.queue_processor_paused.load(Ordering::SeqCst);

    // Convert library QueueFileInfo to Tauri QueueFileInfo
    let currently_processing = lib_info.currently_processing.map(|info| QueueFileInfo {
        id: info.id,
        file_path: info.file_path,
    });

    Ok(QueueInfo {
        total_pending: lib_info.total_pending,
        processing_count: lib_info.processing_count,
        queue_position: lib_info.queue_position,
        is_processor_running,
        currently_processing,
        estimated_time_remaining_seconds: lib_info.estimated_time_remaining_seconds,
    })
}
