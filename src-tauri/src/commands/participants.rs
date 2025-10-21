use crate::types::{AppState, Participant};

#[tauri::command]
pub fn get_participants(state: tauri::State<AppState>) -> Result<Vec<Participant>, String> {
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
pub fn delete_participant(
    state: tauri::State<AppState>,
    participant_id: i64,
) -> Result<(), String> {
    eprintln!("🗑️ delete_participant called (using library)");

    let db = state.biovault_db.lock().unwrap();
    biovault::data::delete_participant(&db, participant_id)
        .map_err(|e| format!("Failed to delete participant: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn delete_participants_bulk(
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
