use crate::types::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::Emitter;

// Use CLI library types
pub use biovault::data::{Pipeline, PipelineRun};
pub use biovault::pipeline_spec::PipelineSpec;

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
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    biovault_db.list_pipelines().map_err(|e| e.to_string())
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

    // Register in database using CLI library
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    let id = biovault_db.register_pipeline(&request.name, &pipeline_dir.to_string_lossy())
        .map_err(|e| e.to_string())?;

    Ok(Pipeline {
        id,
        name: request.name,
        pipeline_path: pipeline_dir.to_string_lossy().to_string(),
        created_at: chrono::Local::now().to_rfc3339(),
        updated_at: chrono::Local::now().to_rfc3339(),
        spec: None, // Spec will be loaded when needed
    })
}

#[tauri::command]
pub async fn load_pipeline_editor(
    state: tauri::State<'_, AppState>,
    pipeline_id: Option<i64>,
    pipeline_path: Option<String>,
) -> Result<PipelineEditorPayload, String> {
    let path = if let Some(id) = pipeline_id {
        // Load from database using CLI library
        let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
        let pipeline = biovault_db.get_pipeline(id).map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Pipeline {} not found", id))?;
        PathBuf::from(pipeline.pipeline_path)
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

    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;

    // Update or insert into database using CLI library
    if let Some(id) = pipeline_id {
        // Update timestamp using CLI library
        biovault_db.touch_pipeline(id).map_err(|e| e.to_string())?;

        // Get updated record
        biovault_db.get_pipeline(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Pipeline not found after update".to_string())
    } else {
        // Register new pipeline
        let id = biovault_db.register_pipeline(&spec.name, &pipeline_path)
            .map_err(|e| e.to_string())?;

        Ok(Pipeline {
            id,
            name: spec.name.clone(),
            pipeline_path: pipeline_path.clone(),
            created_at: chrono::Local::now().to_rfc3339(),
            updated_at: chrono::Local::now().to_rfc3339(),
            spec: Some(spec), // Return the spec that was just saved
        })
    }
}

#[tauri::command]
pub async fn delete_pipeline(
    state: tauri::State<'_, AppState>,
    pipeline_id: i64,
) -> Result<(), String> {
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;

    // Get pipeline before deleting
    let pipeline = biovault_db.get_pipeline(pipeline_id).map_err(|e| e.to_string())?;
    
    if let Some(p) = pipeline {
        // Delete from database using CLI library
        biovault_db.delete_pipeline(pipeline_id).map_err(|e| e.to_string())?;

        // Delete directory if it exists and is in the pipelines folder
        let pipelines_dir = get_pipelines_dir()?;
        let path_buf = PathBuf::from(p.pipeline_path);

        // Only delete if the path is within the pipelines directory
        if path_buf.starts_with(&pipelines_dir) && path_buf.exists() {
            fs::remove_dir_all(&path_buf)
                .map_err(|e| format!("Failed to delete pipeline directory: {}", e))?;
        }
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

    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;

    // Get pipeline using CLI library
    let pipeline = biovault_db.get_pipeline(pipeline_id).map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Pipeline {} not found", pipeline_id))?;
    
    let pipeline_path = pipeline.pipeline_path;

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

    // Create pipeline run record using CLI library
    let run_id = biovault_db.create_pipeline_run(
        pipeline_id,
        &results_path.to_string_lossy(),
        Some(&results_path.to_string_lossy())
    ).map_err(|e| e.to_string())?;

    // Prepare bv run command
    // Note: Flags must come BEFORE positional args for clap
    let mut cmd = Command::new("bv");
    cmd.arg("run");
    
    // Set results directory FIRST (before pipeline path)
    cmd.arg("--results-dir").arg(&results_path);
    
    // Then the pipeline.yaml path
    cmd.arg(yaml_path.to_string_lossy().to_string());

    // Then input overrides (trailing args)
    for (key, value) in input_overrides {
        cmd.arg("--set").arg(format!("inputs.{}={}", key, value));
    }

    // Spawn the process and stream output
    // Update status using CLI library function after completion
    let window_clone = window.clone();
    let biovault_db_clone = state.biovault_db.clone();
    let run_id_clone = run_id;
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

                let status = if output.status.success() {
                    "success"
                } else {
                    "failed"
                };

                // Update status using CLI library
                if let Ok(biovault_db) = biovault_db_clone.lock() {
                    let _ = biovault_db.update_pipeline_run_status(run_id_clone, status, true);
                }

                let _ = window_clone.emit("pipeline-complete", status);
            }
            Err(e) => {
                let _ = window_clone.emit(
                    "pipeline-log-line",
                    format!("Error running pipeline: {}", e),
                );
                
                // Update status to failed using CLI library
                if let Ok(biovault_db) = biovault_db_clone.lock() {
                    let _ = biovault_db.update_pipeline_run_status(run_id_clone, "failed", true);
                }
                
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
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    biovault_db.list_pipeline_runs().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_pipeline_run(
    state: tauri::State<'_, AppState>,
    run_id: i64,
) -> Result<(), String> {
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    
    // Get work directory before deleting
    let run = biovault_db.get_pipeline_run(run_id).map_err(|e| e.to_string())?;
    
    // Delete from database
    biovault_db.delete_pipeline_run(run_id).map_err(|e| e.to_string())?;

    // Delete work directory if it exists
    if let Some(r) = run {
        let path = PathBuf::from(r.work_dir);
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
