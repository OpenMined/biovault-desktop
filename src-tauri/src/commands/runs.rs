use crate::types::{AppState, FileRecord, Participant, Run, RunStartResult};
use biovault::cli::commands::run::{execute as run_execute, RunParams};
use biovault::config::Config;
use rusqlite::params;
use std::collections::BTreeSet;
use std::env;
use std::fs::{self};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use tauri::Emitter;

const DEPENDENCY_BINARIES: [&str; 5] = ["nextflow", "java", "docker", "syftbox", "uv"];

#[tauri::command]
pub fn start_analysis(
    state: tauri::State<AppState>,
    participant_ids: Vec<i64>,
    project_id: i64,
) -> Result<RunStartResult, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    // Get project from CLI database
    let biovault_db = state.biovault_db.lock().unwrap();
    let project_obj = biovault_db
        .get_project(&project_id.to_string())
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

    // Create run using CLI library (unified runs table)
    let run_id = biovault_db
        .create_step_run(
            project_id,
            run_dir.to_str().unwrap(),
            participant_ids.len() as i32,
        )
        .map_err(|e| e.to_string())?;

    // Add run participants
    for participant_id in &participant_ids {
        biovault_db
            .conn
            .execute(
                "INSERT INTO run_participants (run_id, participant_id) VALUES (?1, ?2)",
                params![run_id, participant_id],
            )
            .map_err(|e| e.to_string())?;
    }

    drop(biovault_db);

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
        let biovault_db = state.biovault_db.lock().unwrap();
        biovault_db
            .conn
            .query_row(
                "SELECT p.project_path, r.work_dir
         FROM runs r
         JOIN projects p ON r.step_id = p.id
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

    let start_line = format!("=== Run {} started at {} ===", run_id, timestamp);
    writeln!(log_file, "\n{}", start_line).map_err(|e| e.to_string())?;
    crate::desktop_log!("{}", start_line);

    let details_line = format!(
        "Calling biovault::run directly with project: {} and samplesheet: {}",
        project_path,
        samplesheet_path.display()
    );
    writeln!(log_file, "{}", details_line).map_err(|e| e.to_string())?;
    crate::desktop_log!("{}", details_line);
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

    // Capture original environment for logging
    let original_path = env::var("PATH").unwrap_or_default();
    let original_java_home = env::var("JAVA_HOME").ok();

    let mut env_lines = vec![
        "=== Nextflow environment ===".to_string(),
        format!("  BIOVAULT_HOME = {}", biovault_home.display()),
        format!("  Run directory = {}", run_dir_path.display()),
        format!("  Work directory = {}", work_subdir.display()),
        format!("  Results directory = {}", results_subdir.display()),
        format!("  Samplesheet = {}", samplesheet_path.display()),
        format!(
            "  PATH (original) = {}",
            if original_path.is_empty() {
                "<unset>".to_string()
            } else {
                original_path.clone()
            }
        ),
        format!(
            "  JAVA_HOME (original) = {}",
            original_java_home
                .clone()
                .unwrap_or_else(|| "<unset>".to_string())
        ),
    ];

    let config = match biovault::config::get_config() {
        Ok(cfg) => Some(cfg),
        Err(err) => {
            env_lines.push(format!(
                "  WARNING: Failed to load BioVault config: {}",
                err
            ));
            None
        }
    };

    let nextflow_bin_display = config
        .as_ref()
        .and_then(|cfg| cfg.get_binary_path("nextflow"))
        .unwrap_or_else(|| "nextflow".to_string());
    env_lines.push(format!(
        "  Nextflow binary preference = {}",
        nextflow_bin_display
    ));

    if let Some(ref cfg) = config {
        env_lines.push("  Configured binary paths:".to_string());
        for binary in DEPENDENCY_BINARIES {
            match cfg.get_binary_path(binary) {
                Some(path) => env_lines.push(format!("    {} = {}", binary, path)),
                None => env_lines.push(format!("    {} = <not configured>", binary)),
            }
        }

        if let Some(augmented_path) = build_augmented_path(cfg) {
            env::set_var("PATH", &augmented_path);
            env_lines.push(format!("  PATH (augmented) = {}", augmented_path));
        } else {
            env_lines.push("  PATH (augmented) = <unchanged>".to_string());
        }

        let mut java_home_set = false;
        if let Some(java_bin) = cfg.get_binary_path("java") {
            env_lines.push(format!("  java binary = {}", java_bin));
            if let Some(java_home) = derive_java_home(&java_bin) {
                env::set_var("JAVA_HOME", &java_home);
                env_lines.push(format!(
                    "  JAVA_HOME derived from java binary = {}",
                    java_home
                ));
                java_home_set = true;
            } else {
                env_lines.push(format!(
                    "  WARNING: Could not derive JAVA_HOME from java binary: {}",
                    java_bin
                ));
            }
        }

        if !java_home_set {
            if let Some(ref existing) = original_java_home {
                env_lines.push(format!(
                    "  JAVA_HOME retained (pre-existing) = {}",
                    existing
                ));
            }
        }
    } else if let Some(existing) = original_java_home.clone() {
        env_lines.push(format!(
            "  JAVA_HOME retained (pre-existing) = {}",
            existing
        ));
    }

    let nxf_home_path = biovault_home.join("data").join("nextflow");
    match fs::create_dir_all(&nxf_home_path) {
        Ok(_) => {
            env::set_var("NXF_HOME", &nxf_home_path);
            env_lines.push(format!("  NXF_HOME = {}", nxf_home_path.to_string_lossy()));
        }
        Err(err) => env_lines.push(format!(
            "  WARNING: Failed to prepare NXF_HOME at {}: {}",
            nxf_home_path.to_string_lossy(),
            err
        )),
    }

    env_lines.push(format!(
        "  PATH (effective) = {}",
        env::var("PATH").unwrap_or_else(|_| "<unset>".to_string())
    ));
    env_lines.push(format!(
        "  JAVA_HOME (effective) = {}",
        env::var("JAVA_HOME").unwrap_or_else(|_| "<unset>".to_string())
    ));
    env_lines.push(format!(
        "  NXF_HOME (effective) = {}",
        env::var("NXF_HOME").unwrap_or_else(|_| "<unset>".to_string())
    ));
    env_lines.push(String::new());

    append_run_log_lines(&mut log_file, &window, &env_lines)?;

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
        let biovault_db = state.biovault_db.lock().unwrap();
        biovault_db
            .update_run_status(run_id, status_str, true)
            .map_err(|e| e.to_string())?;
    }

    // Write final status to log
    let mut log_file = fs::OpenOptions::new().append(true).open(&log_path).ok();
    if let Some(ref mut file) = log_file {
        let summary_line = format!("=== Analysis {} ===", status_str);
        let _ = writeln!(file, "\n{}", summary_line);
        crate::desktop_log!("{}", summary_line);
        if let Err(ref e) = result {
            let error_line = format!("Error: {}", e);
            let _ = writeln!(file, "{}", error_line);
            crate::desktop_error!("{}", error_line);
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
    let biovault_db = state.biovault_db.lock().unwrap();
    let mut stmt = biovault_db.conn
        .prepare(
            "SELECT r.id, r.step_id, p.name, r.work_dir, r.participant_count, r.status, r.created_at
             FROM runs r
             JOIN projects p ON r.step_id = p.id
             WHERE r.step_id IS NOT NULL
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
    let biovault_db = state.biovault_db.lock().unwrap();

    let work_dir: String = biovault_db
        .conn
        .query_row(
            "SELECT work_dir FROM runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    biovault_db
        .conn
        .execute(
            "DELETE FROM run_participants WHERE run_id = ?1",
            params![run_id],
        )
        .map_err(|e| e.to_string())?;

    biovault_db
        .conn
        .execute("DELETE FROM runs WHERE id = ?1", params![run_id])
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
    let biovault_db = state.biovault_db.lock().unwrap();

    let work_dir: String = biovault_db
        .conn
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
    let biovault_db = state.biovault_db.lock().unwrap();

    let work_dir: String = biovault_db
        .conn
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

/// Build augmented PATH from configured binary paths
fn build_augmented_path(cfg: &Config) -> Option<String> {
    let mut entries = BTreeSet::new();

    // Extract parent directories from configured binary paths
    for key in DEPENDENCY_BINARIES {
        if let Some(bin_path) = cfg.get_binary_path(key) {
            if !bin_path.is_empty() {
                if let Some(parent) = Path::new(&bin_path).parent() {
                    entries.insert(parent.to_path_buf());
                }
            }
        }
    }

    if entries.is_empty() {
        return None;
    }

    // Prepend configured binary directories to existing PATH
    let mut paths: Vec<PathBuf> = entries.into_iter().collect();
    if let Some(existing) = env::var_os("PATH") {
        paths.extend(env::split_paths(&existing));
    }

    env::join_paths(paths)
        .ok()
        .and_then(|joined| joined.into_string().ok())
}

fn derive_java_home(java_bin: &str) -> Option<String> {
    let path = Path::new(java_bin);
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let bin_dir = resolved.parent()?;

    if bin_dir
        .file_name()
        .map(|name| name == "bin")
        .unwrap_or(false)
    {
        return bin_dir
            .parent()
            .map(|home| home.to_string_lossy().into_owned());
    }

    // Some macOS installs resolve to .../Contents/Home/bin/java
    if bin_dir.to_string_lossy().ends_with("Contents/Home/bin") {
        return bin_dir
            .parent()
            .map(|home| home.to_string_lossy().into_owned());
    }

    None
}

fn append_run_log_lines(
    log_file: &mut fs::File,
    window: &tauri::Window,
    lines: &[String],
) -> Result<(), String> {
    for line in lines {
        writeln!(log_file, "{}", line)
            .map_err(|e| format!("Failed to write to log file: {}", e))?;
        crate::desktop_log!("{}", line);
        let _ = window.emit("log-line", line.clone());
        if line.is_empty() {
            println!();
        } else {
            println!("{}", line);
        }
    }
    Ok(())
}
