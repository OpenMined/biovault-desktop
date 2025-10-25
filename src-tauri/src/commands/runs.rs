use crate::types::{AppState, FileRecord, Participant, Run, RunStartResult};
use biovault::cli::commands::run::{execute as run_execute, RunParams};
use rusqlite::params;
use std::env;
use std::fs::{self};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use tauri::Emitter;

#[tauri::command]
pub fn start_analysis(
    state: tauri::State<AppState>,
    participant_ids: Vec<i64>,
    project_id: i64,
) -> Result<RunStartResult, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    // Get project using CLI library
    let biovault_db = state.biovault_db.lock().unwrap();
    let project_obj = biovault_db.get_project(&project_id.to_string())
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Project {} not found", project_id))?;
    let project = (project_obj.name.clone(), project_obj.project_path.clone());

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
pub async fn execute_analysis(
    state: tauri::State<'_, AppState>,
    run_id: i64,
    window: tauri::Window,
) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let (project_path, work_dir): (String, String) = {
        let conn = state.db.lock().unwrap();
        conn.query_row(
            "SELECT p.project_path, r.work_dir
         FROM runs r
         JOIN projects p ON r.project_id = p.id
         WHERE r.id = ?1",
            params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?
    };

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
        "Calling biovault::run directly with project: {} and samplesheet: {}",
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
            "Running analysis for project: {} with samplesheet: {}",
            project_path,
            samplesheet_path.display()
        ),
    );
    let _ = window.emit("log-line", "");

    // Set BIOVAULT_HOME environment variable
    env::set_var("BIOVAULT_HOME", biovault_home.to_string_lossy().to_string());

    // Create RunParams struct to call the execute function directly
    let params = RunParams {
        project_folder: project_path.clone(),
        participant_source: samplesheet_path.to_string_lossy().to_string(),
        test: false,
        download: false,
        dry_run: false,
        with_docker: false,
        work_dir: Some(work_subdir.to_string_lossy().to_string()),
        resume: false,
        template: None,
        results_dir: Some(results_subdir.to_string_lossy().to_string()),
        nextflow_args: Vec::new(),
    };

    // Call the execute function directly
    let result = run_execute(params).await;

    let status_str = if result.is_ok() { "success" } else { "failed" };

    {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "UPDATE runs SET status = ?1 WHERE id = ?2",
            params![status_str, run_id],
        )
        .map_err(|e| e.to_string())?;
    }

    // Write final status to log
    let mut log_file = fs::OpenOptions::new().append(true).open(&log_path).ok();
    if let Some(ref mut file) = log_file {
        let _ = writeln!(file, "\n=== Analysis {} ===", status_str);
        if let Err(ref e) = result {
            let _ = writeln!(file, "Error: {}", e);
        }
    }

    let _ = window.emit("analysis-complete", status_str);

    match result {
        Ok(_) => Ok(format!(
            "Analysis completed successfully. Output in: {}",
            work_dir
        )),
        Err(e) => {
            let _ = window.emit("log-line", format!("Error: {}", e));
            Err(format!("Analysis failed: {}", e))
        }
    }
}

#[tauri::command]
pub fn get_runs(state: tauri::State<AppState>) -> Result<Vec<Run>, String> {
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
pub fn delete_run(state: tauri::State<AppState>, run_id: i64) -> Result<(), String> {
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
pub fn get_run_logs(state: tauri::State<AppState>, run_id: i64) -> Result<String, String> {
    // Default: return last 500 lines for fast initial load
    get_run_logs_tail(state, run_id, 500)
}

#[tauri::command]
pub fn get_run_logs_tail(
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
pub fn get_run_logs_full(state: tauri::State<AppState>, run_id: i64) -> Result<String, String> {
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
