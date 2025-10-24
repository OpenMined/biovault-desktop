use crate::types::AppState;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::Emitter;

#[derive(Debug, Serialize, Deserialize)]
pub struct Pipeline {
    pub id: i64,
    pub name: String,
    pub pipeline_path: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PipelineRun {
    pub id: i64,
    pub pipeline_id: i64,
    pub status: String,
    pub work_dir: String,
    pub results_dir: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PipelineStep {
    pub id: String,
    pub uses: String,                             // Project path or ID
    pub with: HashMap<String, String>,            // Input bindings
    pub publish: Option<HashMap<String, String>>, // Published outputs
    pub store: Option<PipelineStore>,             // Storage configuration
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PipelineStore {
    pub kind: String, // "sql" for now
    pub destination: String,
    pub source: String,
    pub table_name: String,
    pub key_column: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PipelineSpec {
    pub name: String,
    pub inputs: HashMap<String, String>, // Input name -> type
    pub steps: Vec<PipelineStep>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PipelineCreateRequest {
    pub name: String,
    pub directory: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PipelineEditorPayload {
    pub pipeline_id: Option<i64>,
    pub pipeline_path: String,
    pub spec: Option<PipelineSpec>,
    pub projects: Vec<ProjectInfo>, // Available projects for dropdown
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub id: i64,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PipelineValidationResult {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub diagram: String,
}

fn get_pipelines_dir() -> Result<PathBuf, String> {
    let home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    Ok(home.join("pipelines"))
}

#[tauri::command]
pub async fn get_pipelines(state: tauri::State<'_, AppState>) -> Result<Vec<Pipeline>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let mut stmt = db
        .prepare("SELECT id, name, pipeline_path, created_at, updated_at FROM pipelines ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;

    let pipelines = stmt
        .query_map([], |row| {
            Ok(Pipeline {
                id: row.get(0)?,
                name: row.get(1)?,
                pipeline_path: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(pipelines)
}

#[tauri::command]
pub async fn create_pipeline(
    state: tauri::State<'_, AppState>,
    request: PipelineCreateRequest,
) -> Result<Pipeline, String> {
    let pipelines_dir = get_pipelines_dir()?;
    fs::create_dir_all(&pipelines_dir)
        .map_err(|e| format!("Failed to create pipelines directory: {}", e))?;

    let pipeline_dir = if let Some(dir) = request.directory {
        PathBuf::from(dir)
    } else {
        pipelines_dir.join(&request.name)
    };

    // Create pipeline directory
    fs::create_dir_all(&pipeline_dir)
        .map_err(|e| format!("Failed to create pipeline directory: {}", e))?;

    let pipeline_yaml_path = pipeline_dir.join("pipeline.yaml");

    // Check if pipeline.yaml already exists
    if pipeline_yaml_path.exists() {
        return Err(format!(
            "pipeline.yaml already exists at {}",
            pipeline_yaml_path.display()
        ));
    }

    // Create minimal pipeline.yaml
    let default_spec = format!(
        r#"name: {}
inputs:
  # Define pipeline inputs here
  # example_input: File

steps:
  # Add pipeline steps here
  # - id: step1
  #   uses: path/to/project
  #   with:
  #     input_name: inputs.example_input
"#,
        request.name
    );

    fs::write(&pipeline_yaml_path, default_spec)
        .map_err(|e| format!("Failed to write pipeline.yaml: {}", e))?;

    // Add to database
    let db = state.db.lock().map_err(|e| e.to_string())?;

    db.execute(
        "INSERT INTO pipelines (name, pipeline_path) VALUES (?1, ?2)",
        params![request.name, pipeline_dir.to_string_lossy()],
    )
    .map_err(|e| format!("Failed to insert pipeline: {}", e))?;

    let id = db.last_insert_rowid();

    Ok(Pipeline {
        id,
        name: request.name,
        pipeline_path: pipeline_dir.to_string_lossy().to_string(),
        created_at: chrono::Local::now().to_rfc3339(),
        updated_at: chrono::Local::now().to_rfc3339(),
    })
}

#[tauri::command]
pub async fn load_pipeline_editor(
    state: tauri::State<'_, AppState>,
    pipeline_id: Option<i64>,
    pipeline_path: Option<String>,
) -> Result<PipelineEditorPayload, String> {
    let path = if let Some(id) = pipeline_id {
        // Load from database
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let path: String = db
            .query_row(
                "SELECT pipeline_path FROM pipelines WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Pipeline not found: {}", e))?;
        PathBuf::from(path)
    } else if let Some(p) = pipeline_path {
        PathBuf::from(p)
    } else {
        return Err("Either pipeline_id or pipeline_path must be provided".to_string());
    };

    let yaml_path = path.join("pipeline.yaml");

    // Load pipeline spec if file exists
    let spec = if yaml_path.exists() {
        let content = fs::read_to_string(&yaml_path)
            .map_err(|e| format!("Failed to read pipeline.yaml: {}", e))?;
        // Parse YAML to PipelineSpec
        serde_yaml::from_str::<PipelineSpec>(&content).ok()
    } else {
        None
    };

    // Get available projects from database
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare("SELECT id, name, project_path FROM projects ORDER BY name")
        .map_err(|e| e.to_string())?;

    let projects = stmt
        .query_map([], |row| {
            Ok(ProjectInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(PipelineEditorPayload {
        pipeline_id,
        pipeline_path: path.to_string_lossy().to_string(),
        spec,
        projects,
    })
}

#[tauri::command]
pub async fn save_pipeline_editor(
    state: tauri::State<'_, AppState>,
    pipeline_id: Option<i64>,
    pipeline_path: String,
    spec: PipelineSpec,
) -> Result<Pipeline, String> {
    let path = PathBuf::from(&pipeline_path);
    let yaml_path = path.join("pipeline.yaml");

    // Convert spec to YAML
    let yaml_content = serde_yaml::to_string(&spec)
        .map_err(|e| format!("Failed to serialize pipeline spec: {}", e))?;

    // Write to file
    fs::write(&yaml_path, yaml_content)
        .map_err(|e| format!("Failed to write pipeline.yaml: {}", e))?;

    let db = state.db.lock().map_err(|e| e.to_string())?;

    // Update or insert into database
    if let Some(id) = pipeline_id {
        // Update existing
        db.execute(
            "UPDATE pipelines SET name = ?1, updated_at = datetime('now') WHERE id = ?2",
            params![spec.name, id],
        )
        .map_err(|e| format!("Failed to update pipeline: {}", e))?;

        // Get updated record
        db.query_row(
            "SELECT id, name, pipeline_path, created_at, updated_at FROM pipelines WHERE id = ?1",
            params![id],
            |row| {
                Ok(Pipeline {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    pipeline_path: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .map_err(|e| e.to_string())
    } else {
        // Insert new
        db.execute(
            "INSERT INTO pipelines (name, pipeline_path) VALUES (?1, ?2)",
            params![spec.name, pipeline_path],
        )
        .map_err(|e| format!("Failed to insert pipeline: {}", e))?;

        let id = db.last_insert_rowid();

        Ok(Pipeline {
            id,
            name: spec.name,
            pipeline_path,
            created_at: chrono::Local::now().to_rfc3339(),
            updated_at: chrono::Local::now().to_rfc3339(),
        })
    }
}

#[tauri::command]
pub async fn delete_pipeline(
    state: tauri::State<'_, AppState>,
    pipeline_id: i64,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    // Get pipeline path first
    let path: String = db
        .query_row(
            "SELECT pipeline_path FROM pipelines WHERE id = ?1",
            params![pipeline_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Pipeline not found: {}", e))?;

    // Delete from database
    db.execute("DELETE FROM pipelines WHERE id = ?1", params![pipeline_id])
        .map_err(|e| format!("Failed to delete pipeline: {}", e))?;

    // Delete directory if it exists and is in the pipelines folder
    let pipelines_dir = get_pipelines_dir()?;
    let path_buf = PathBuf::from(path);

    // Only delete if the path is within the pipelines directory
    if path_buf.starts_with(&pipelines_dir) && path_buf.exists() {
        fs::remove_dir_all(&path_buf)
            .map_err(|e| format!("Failed to delete pipeline directory: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn validate_pipeline(pipeline_path: String) -> Result<PipelineValidationResult, String> {
    use std::process::Command;

    let output = Command::new("bv")
        .args(["pipeline", "validate", "--diagram", &pipeline_path])
        .output()
        .map_err(|e| format!("Failed to run bv validate: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if output.status.success() {
        Ok(PipelineValidationResult {
            valid: true,
            errors: vec![],
            warnings: vec![],
            diagram: stdout.to_string(),
        })
    } else {
        let errors = stderr
            .lines()
            .filter(|line| line.contains("ERROR"))
            .map(|s| s.to_string())
            .collect();

        let warnings = stderr
            .lines()
            .filter(|line| line.contains("WARNING"))
            .map(|s| s.to_string())
            .collect();

        Ok(PipelineValidationResult {
            valid: false,
            errors,
            warnings,
            diagram: stdout.to_string(),
        })
    }
}

#[tauri::command]
pub async fn run_pipeline(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    pipeline_id: i64,
    input_overrides: HashMap<String, String>,
    results_dir: Option<String>,
) -> Result<PipelineRun, String> {
    use chrono::Local;
    use std::process::Command;

    let db = state.db.lock().map_err(|e| e.to_string())?;

    // Get pipeline path
    let pipeline_path: String = db
        .query_row(
            "SELECT pipeline_path FROM pipelines WHERE id = ?1",
            params![pipeline_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Pipeline not found: {}", e))?;

    let yaml_path = PathBuf::from(&pipeline_path).join("pipeline.yaml");

    // Generate results directory
    let timestamp = Local::now().format("%Y%m%d_%H%M%S");
    let results_path = if let Some(dir) = results_dir {
        PathBuf::from(dir)
    } else {
        let home = biovault::config::get_biovault_home()
            .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
        home.join("runs").join(format!("pipeline_{}", timestamp))
    };

    // Create results directory
    fs::create_dir_all(&results_path)
        .map_err(|e| format!("Failed to create results directory: {}", e))?;

    // Create pipeline run record
    db.execute(
        "INSERT INTO pipeline_runs (pipeline_id, status, work_dir, results_dir) VALUES (?1, ?2, ?3, ?4)",
        params![
            pipeline_id,
            "running",
            results_path.to_string_lossy(),
            results_path.to_string_lossy(),
        ],
    )
    .map_err(|e| format!("Failed to create pipeline run: {}", e))?;

    let run_id = db.last_insert_rowid();

    // Prepare bv run command
    let mut cmd = Command::new("bv");
    cmd.arg("run").arg(yaml_path.to_string_lossy().to_string());

    // Add input overrides
    for (key, value) in input_overrides {
        cmd.arg("--set").arg(format!("inputs.{}={}", key, value));
    }

    // Set results directory
    cmd.arg("--results-dir").arg(&results_path);

    // Spawn the process and stream output
    let window_clone = window.clone();
    std::thread::spawn(move || {
        match cmd.output() {
            Ok(output) => {
                // Emit log lines
                for line in String::from_utf8_lossy(&output.stdout).lines() {
                    let _ = window_clone.emit("pipeline-log-line", line);
                }

                for line in String::from_utf8_lossy(&output.stderr).lines() {
                    let _ = window_clone.emit("pipeline-log-line", line);
                }

                // Update status
                let status = if output.status.success() {
                    "success"
                } else {
                    "failed"
                };

                // Update database with final status
                // Note: In production, we'd need to pass the db connection properly
                let _ = window_clone.emit("pipeline-complete", status);
            }
            Err(e) => {
                let _ = window_clone.emit(
                    "pipeline-log-line",
                    format!("Error running pipeline: {}", e),
                );
                let _ = window_clone.emit("pipeline-complete", "failed");
            }
        }
    });

    Ok(PipelineRun {
        id: run_id,
        pipeline_id,
        status: "running".to_string(),
        work_dir: results_path.to_string_lossy().to_string(),
        results_dir: Some(results_path.to_string_lossy().to_string()),
        created_at: chrono::Local::now().to_rfc3339(),
        completed_at: None,
    })
}

#[tauri::command]
pub async fn get_pipeline_runs(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<PipelineRun>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let mut stmt = db
        .prepare("SELECT id, pipeline_id, status, work_dir, results_dir, created_at, completed_at FROM pipeline_runs ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;

    let runs = stmt
        .query_map([], |row| {
            Ok(PipelineRun {
                id: row.get(0)?,
                pipeline_id: row.get(1)?,
                status: row.get(2)?,
                work_dir: row.get(3)?,
                results_dir: row.get(4)?,
                created_at: row.get(5)?,
                completed_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(runs)
}

#[tauri::command]
pub async fn delete_pipeline_run(
    state: tauri::State<'_, AppState>,
    run_id: i64,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    // Get work directory first
    let work_dir: Option<String> = db
        .query_row(
            "SELECT work_dir FROM pipeline_runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .ok();

    // Delete from database
    db.execute("DELETE FROM pipeline_runs WHERE id = ?1", params![run_id])
        .map_err(|e| format!("Failed to delete pipeline run: {}", e))?;

    // Delete work directory if it exists
    if let Some(dir) = work_dir {
        let path = PathBuf::from(dir);
        if path.exists() {
            fs::remove_dir_all(&path).ok(); // Ignore errors here
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn preview_pipeline_spec(spec: PipelineSpec) -> Result<String, String> {
    // Convert spec to YAML for preview
    serde_yaml::to_string(&spec).map_err(|e| format!("Failed to generate pipeline preview: {}", e))
}
