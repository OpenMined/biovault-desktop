use crate::types::AppState;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Emitter;

// Use CLI library types and functions
use biovault::cli::commands::pipeline::run_pipeline as cli_run_pipeline;
use biovault::cli::commands::project_management::{
    resolve_pipeline_dependencies, DependencyContext,
};
pub use biovault::data::{Pipeline, PipelineRun, RunConfig};
pub use biovault::pipeline_spec::PipelineSpec;

#[derive(Debug, Serialize, Deserialize)]
pub struct PipelineCreateRequest {
    pub name: String,
    pub directory: Option<String>,
    pub pipeline_file: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRunSelection {
    #[serde(default)]
    pub file_ids: Vec<i64>,
    #[serde(default)]
    pub participant_ids: Vec<i64>,
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

fn append_pipeline_log(window: &tauri::Window, log_path: &Path, message: &str) {
    if let Some(parent) = log_path.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            crate::desktop_log!(
                "Failed to ensure pipeline log directory {:?}: {}",
                parent,
                err
            );
        }
    }

    match OpenOptions::new().create(true).append(true).open(log_path) {
        Ok(mut file) => {
            let _ = writeln!(file, "{}", message);
        }
        Err(err) => {
            crate::desktop_log!(
                "Failed to write pipeline log at {:?}: {} | message: {}",
                log_path,
                err,
                message
            );
        }
    }

    let _ = window.emit("pipeline-log-line", message.to_string());
}

#[tauri::command]
pub async fn get_pipelines(state: tauri::State<'_, AppState>) -> Result<Vec<Pipeline>, String> {
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    biovault_db.list_pipelines().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_runs_base_dir() -> Result<String, String> {
    let home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    let runs_dir = home.join("runs");
    fs::create_dir_all(&runs_dir).map_err(|e| format!("Failed to create runs directory: {}", e))?;
    Ok(runs_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn create_pipeline(
    state: tauri::State<'_, AppState>,
    request: PipelineCreateRequest,
) -> Result<Pipeline, String> {
    let PipelineCreateRequest {
        mut name,
        directory,
        pipeline_file,
        overwrite,
    } = request;

    let pipelines_dir = get_pipelines_dir()?;
    fs::create_dir_all(&pipelines_dir)
        .map_err(|e| format!("Failed to create pipelines directory: {}", e))?;

    let mut pipeline_dir = if let Some(dir) = directory {
        PathBuf::from(dir)
    } else {
        pipelines_dir.join(&name)
    };

    // If the provided directory points to a file, fall back to its parent directory
    if let Ok(metadata) = fs::metadata(&pipeline_dir) {
        if metadata.is_file() {
            if let Some(parent) = pipeline_dir.parent() {
                pipeline_dir = parent.to_path_buf();
            }
        }
    }

    let mut pipeline_yaml_path = pipeline_dir.join("pipeline.yaml");
    let mut imported_spec: Option<PipelineSpec> = None;

    // If importing from a file, always copy to managed directory (like GitHub imports)
    if let Some(pipeline_file_path) = pipeline_file {
        let source_pipeline_yaml_path = PathBuf::from(&pipeline_file_path);
        if !source_pipeline_yaml_path.exists() {
            return Err(format!(
                "Selected pipeline.yaml does not exist at {}",
                source_pipeline_yaml_path.display()
            ));
        }

        // Load pipeline spec from source
        let mut spec = PipelineSpec::load(&source_pipeline_yaml_path)
            .map_err(|e| format!("Failed to load pipeline.yaml: {}", e))?;
        name = spec.name.clone();

        // Copy to managed directory (like GitHub imports do)
        let source_parent = source_pipeline_yaml_path.parent().ok_or_else(|| {
            format!(
                "Unable to determine parent directory for {}",
                source_pipeline_yaml_path.display()
            )
        })?;

        // Create pipeline directory in managed location
        let managed_pipeline_dir = pipelines_dir.join(&name);

        if managed_pipeline_dir.exists() {
            if overwrite {
                fs::remove_dir_all(&managed_pipeline_dir)
                    .map_err(|e| format!("Failed to remove existing pipeline directory: {}", e))?;
            } else {
                return Err(format!(
                    "Pipeline '{}' already exists at {}. Use overwrite to replace.",
                    name,
                    managed_pipeline_dir.display()
                ));
            }
        }

        fs::create_dir_all(&managed_pipeline_dir)
            .map_err(|e| format!("Failed to create pipeline directory: {}", e))?;

        pipeline_dir = managed_pipeline_dir.clone();
        pipeline_yaml_path = managed_pipeline_dir.join("pipeline.yaml");

        // Resolve and import dependencies
        // Use spawn_blocking because BioVaultDb is not Send
        // base_path is the directory containing pipeline.yaml (where project.yaml might also be)
        let dependency_context = DependencyContext::Local {
            base_path: source_parent.to_path_buf(), // This is already the directory containing pipeline.yaml
        };
        let pipeline_yaml_path_clone = pipeline_yaml_path.clone();

        let spec_result = tauri::async_runtime::spawn_blocking(move || {
            tauri::async_runtime::block_on(async {
                resolve_pipeline_dependencies(
                    &mut spec,
                    &dependency_context,
                    &pipeline_yaml_path_clone,
                    overwrite,
                    true, // quiet = true for Tauri (no console output)
                )
                .await
                .map_err(|e| e.to_string())?;
                Ok::<PipelineSpec, String>(spec)
            })
        })
        .await
        .map_err(|e| format!("Failed to spawn dependency resolution: {}", e))?;

        let spec = spec_result.map_err(|e| format!("Failed to resolve dependencies: {}", e))?;

        // Note: resolve_pipeline_dependencies already saves the spec (with description preserved)
        imported_spec = Some(spec);
    } else {
        fs::create_dir_all(&pipeline_dir)
            .map_err(|e| format!("Failed to create pipeline directory: {}", e))?;

        if pipeline_yaml_path.exists() && !overwrite {
            return Err(format!(
                "pipeline.yaml already exists at {}",
                pipeline_yaml_path.display()
            ));
        }

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
            name
        );

        fs::write(&pipeline_yaml_path, default_spec)
            .map_err(|e| format!("Failed to write pipeline.yaml: {}", e))?;
    }

    let pipeline_dir_str = pipeline_dir.to_string_lossy().to_string();
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;

    if overwrite {
        let existing = biovault_db
            .list_pipelines()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|p| p.name == name || p.pipeline_path == pipeline_dir_str);

        if let Some(existing_pipeline) = existing {
            biovault_db
                .delete_pipeline(existing_pipeline.id)
                .map_err(|e| e.to_string())?;
        }
    }

    // Register in database using CLI library
    let id = biovault_db
        .register_pipeline(&name, &pipeline_dir_str)
        .map_err(|e| e.to_string())?;

    let timestamp = chrono::Local::now().to_rfc3339();

    Ok(Pipeline {
        id,
        name,
        pipeline_path: pipeline_dir_str,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        spec: imported_spec,
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
        let pipeline = biovault_db
            .get_pipeline(id)
            .map_err(|e| e.to_string())?
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

    // Get available projects from database using CLI library
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    let projects_list = biovault_db.list_projects().map_err(|e| e.to_string())?;
    drop(biovault_db); // Release lock

    let projects = projects_list
        .iter()
        .map(|p| ProjectInfo {
            id: p.id,
            name: p.name.clone(),
            path: p.project_path.clone(),
        })
        .collect::<Vec<_>>();

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
        biovault_db
            .get_pipeline(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Pipeline not found after update".to_string())
    } else {
        // Register new pipeline
        let id = biovault_db
            .register_pipeline(&spec.name, &pipeline_path)
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
    let pipeline = biovault_db
        .get_pipeline(pipeline_id)
        .map_err(|e| e.to_string())?;

    if let Some(p) = pipeline {
        // Delete from database using CLI library
        biovault_db
            .delete_pipeline(pipeline_id)
            .map_err(|e| e.to_string())?;

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
    use std::process::Command as ProcessCommand;

    let output = ProcessCommand::new("bv")
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
    mut input_overrides: HashMap<String, String>,
    results_dir: Option<String>,
    selection: Option<PipelineRunSelection>,
) -> Result<PipelineRun, String> {
    use chrono::Local;

    let home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;

    let mut selection_metadata: Option<serde_json::Value> = None;
    let mut selection_counts: Option<(usize, usize)> = None;
    let mut generated_samplesheet_path: Option<String> = None;

    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;

    // Get pipeline using CLI library
    let pipeline = biovault_db
        .get_pipeline(pipeline_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Pipeline {} not found", pipeline_id))?;

    let pipeline_name = pipeline.name.clone();
    let pipeline_path = pipeline.pipeline_path.clone();

    let yaml_path = PathBuf::from(&pipeline_path).join("pipeline.yaml");

    // Generate results directory
    let timestamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let results_path = if let Some(dir) = &results_dir {
        PathBuf::from(dir)
    } else {
        home.join("runs").join(format!("pipeline_{}", timestamp))
    };

    // Create results directory
    fs::create_dir_all(&results_path)
        .map_err(|e| format!("Failed to create results directory: {}", e))?;

    let log_path = results_path.join("pipeline.log");
    append_pipeline_log(
        &window,
        &log_path,
        &format!("📦 Pipeline: {}", pipeline_name),
    );
    append_pipeline_log(
        &window,
        &log_path,
        &format!("📂 Results directory: {}", results_path.display()),
    );

    if let Some(sel) = &selection {
        append_pipeline_log(
            &window,
            &log_path,
            &format!(
                "🔍 Selection payload: files={} participants={}",
                sel.file_ids.len(),
                sel.participant_ids.len()
            ),
        );
    } else {
        append_pipeline_log(&window, &log_path, "🔍 Selection payload: none provided");
    }

    if let Some(sel) = selection {
        if !sel.file_ids.is_empty() {
            let mut seen_files = HashSet::new();
            let mut unique_file_ids = Vec::new();
            for id in sel.file_ids {
                if seen_files.insert(id) {
                    unique_file_ids.push(id);
                }
            }

            if unique_file_ids.is_empty() {
                return Err("No valid file IDs were provided for the pipeline run.".to_string());
            }

            let mut rows = Vec::new();
            let mut participant_labels_set: HashSet<String> = HashSet::new();

            for file_id in &unique_file_ids {
                let record = biovault::data::get_file_by_id(&biovault_db, *file_id)
                    .map_err(|e| format!("Failed to load file {}: {}", file_id, e))?
                    .ok_or_else(|| format!("File {} not found in the BioVault catalog", file_id))?;

                if record.file_path.trim().is_empty() {
                    return Err(format!(
                        "File {} does not have a recorded path in the catalog.",
                        file_id
                    ));
                }

                let participant = record
                    .participant_id
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| {
                        Path::new(&record.file_path)
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("unknown")
                            .to_string()
                    });

                participant_labels_set.insert(participant.clone());
                rows.push((participant, record.file_path));
            }

            let mut dedup_participant_ids = Vec::new();
            if !sel.participant_ids.is_empty() {
                let mut seen = HashSet::new();
                dedup_participant_ids = sel
                    .participant_ids
                    .into_iter()
                    .filter(|id| seen.insert(*id))
                    .collect::<Vec<_>>();
            }

            let inputs_dir = results_path.join("inputs");
            fs::create_dir_all(&inputs_dir).map_err(|e| {
                format!("Failed to prepare inputs directory for samplesheet: {}", e)
            })?;
            let sheet_path = inputs_dir.join("selected_participants.csv");

            let mut writer = csv::Writer::from_path(&sheet_path)
                .map_err(|e| format!("Failed to create samplesheet: {}", e))?;
            writer
                .write_record(["participant_id", "genotype_file"])
                .map_err(|e| format!("Failed to write samplesheet header: {}", e))?;

            for (participant, file_path) in &rows {
                writer
                    .write_record([participant, file_path])
                    .map_err(|e| format!("Failed to write samplesheet entry: {}", e))?;
            }
            writer
                .flush()
                .map_err(|e| format!("Failed to finalize samplesheet: {}", e))?;

            let mut participant_labels: Vec<String> = participant_labels_set.into_iter().collect();
            participant_labels.sort();

            let participant_total = participant_labels.len();
            selection_counts = Some((unique_file_ids.len(), participant_total));

            input_overrides.insert(
                "inputs.samplesheet".to_string(),
                sheet_path.to_string_lossy().to_string(),
            );

            generated_samplesheet_path = Some(sheet_path.to_string_lossy().to_string());

            let participant_count = participant_labels.len();
            selection_metadata = Some(serde_json::json!({
                "file_ids": unique_file_ids,
                "participant_ids": dedup_participant_ids,
                "participant_labels": participant_labels,
                "samplesheet_path": sheet_path.to_string_lossy(),
                "participant_count": participant_count,
            }));
        }
    }

    if let Some((file_count, participant_count)) = selection_counts {
        append_pipeline_log(
            &window,
            &log_path,
            &format!(
                "📥 Inputs: {} file(s), {} participant(s)",
                file_count, participant_count
            ),
        );
    }

    if let Some(path) = &generated_samplesheet_path {
        append_pipeline_log(
            &window,
            &log_path,
            &format!("📝 Generated samplesheet: {}", path),
        );
    }

    // Separate inputs from parameters for metadata storage
    let mut inputs_map = HashMap::new();
    let mut params_map = HashMap::new();

    for (key, value) in &input_overrides {
        if key.starts_with("inputs.") {
            inputs_map.insert(key.clone(), value.clone());
        } else {
            params_map.insert(key.clone(), value.clone());
        }
    }

    // Create metadata JSON
    let mut metadata_root = serde_json::Map::new();
    metadata_root.insert("input_overrides".to_string(), serde_json::json!(inputs_map));
    metadata_root.insert(
        "parameter_overrides".to_string(),
        serde_json::json!(params_map),
    );
    if let Some(selection_json) = selection_metadata {
        metadata_root.insert("data_selection".to_string(), selection_json);
    }
    let metadata_value = serde_json::Value::Object(metadata_root);
    let metadata_str = serde_json::to_string(&metadata_value)
        .map_err(|e| format!("Failed to serialize metadata: {}", e))?;

    let mut extra_args = Vec::new();
    for (key, value) in input_overrides {
        extra_args.push("--set".to_string());
        extra_args.push(format!("{}={}", key, value));
    }

    let yaml_path_str = yaml_path.to_string_lossy().to_string();
    let results_dir_str = results_path.to_string_lossy().to_string();

    // Build command preview for logging
    let quote_arg = |arg: &str| -> String {
        if arg.is_empty() {
            "\"\"".to_string()
        } else if arg
            .chars()
            .any(|c| c.is_whitespace() || c == '"' || c == '\'')
        {
            let escaped = arg.replace('\\', "\\\\").replace('"', "\\\"");
            format!("\"{}\"", escaped)
        } else {
            arg.to_string()
        }
    };

    let mut command_preview = format!("bv pipeline run {}", quote_arg(&yaml_path_str));
    for arg in &extra_args {
        command_preview.push(' ');
        command_preview.push_str(&quote_arg(arg));
    }
    command_preview.push(' ');
    command_preview.push_str("--results-dir ");
    command_preview.push_str(&quote_arg(&results_dir_str));

    append_pipeline_log(
        &window,
        &log_path,
        &format!("▶️  Command: {}", command_preview),
    );

    // Create pipeline run record using CLI library with metadata
    let run_id = biovault_db
        .create_pipeline_run_with_metadata(
            pipeline_id,
            &results_path.to_string_lossy(),
            Some(&results_path.to_string_lossy()),
            Some(&metadata_str),
        )
        .map_err(|e| e.to_string())?;

    drop(biovault_db); // Release lock

    // Spawn async task to run pipeline (so we can return immediately)
    let window_clone = window.clone();
    let biovault_db_clone = state.biovault_db.clone();
    let run_id_clone = run_id;
    let log_path_clone = log_path.clone();
    let pipeline_name_clone = pipeline_name.clone();
    let yaml_path_spawn = yaml_path_str.clone();
    let results_dir_spawn = results_dir_str.clone();
    let extra_args_spawn = extra_args.clone();

    tauri::async_runtime::spawn(async move {
        append_pipeline_log(
            &window_clone,
            &log_path_clone,
            &format!("🚀 Starting pipeline run: {}", pipeline_name_clone),
        );

        // Call CLI library function directly
        let result = cli_run_pipeline(
            &yaml_path_spawn,
            extra_args_spawn,
            false, // dry_run
            false, // resume
            Some(results_dir_spawn),
        )
        .await;

        let status = if let Err(ref err) = result {
            append_pipeline_log(
                &window_clone,
                &log_path_clone,
                &format!("❌ Pipeline run failed: {}", err),
            );
            "failed"
        } else {
            append_pipeline_log(
                &window_clone,
                &log_path_clone,
                "✅ Pipeline run completed successfully",
            );
            "success"
        };

        // Update status using CLI library
        if let Ok(biovault_db) = biovault_db_clone.lock() {
            let _ = biovault_db.update_pipeline_run_status(run_id_clone, status, true);
        }

        let _ = window_clone.emit("pipeline-complete", status);
    });

    Ok(PipelineRun {
        id: run_id,
        pipeline_id: Some(pipeline_id),
        step_id: None,
        status: "running".to_string(),
        work_dir: results_path.to_string_lossy().to_string(),
        results_dir: Some(results_path.to_string_lossy().to_string()),
        participant_count: None,
        metadata: Some(metadata_str),
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
    let run = biovault_db
        .get_pipeline_run(run_id)
        .map_err(|e| e.to_string())?;

    // Delete from database
    biovault_db
        .delete_pipeline_run(run_id)
        .map_err(|e| e.to_string())?;

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

// ============================================================================
// Run Configurations (using CLI library)
// ============================================================================

#[tauri::command]
pub async fn save_run_config(
    state: tauri::State<'_, AppState>,
    pipeline_id: i64,
    name: String,
    config_data: serde_json::Value,
) -> Result<i64, String> {
    let db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    db.save_run_config(pipeline_id, &name, &config_data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_run_configs(
    state: tauri::State<'_, AppState>,
    pipeline_id: i64,
) -> Result<Vec<RunConfig>, String> {
    let db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    db.list_run_configs(pipeline_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_run_config(
    state: tauri::State<'_, AppState>,
    config_id: i64,
) -> Result<Option<RunConfig>, String> {
    let db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    db.get_run_config(config_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_run_config(
    state: tauri::State<'_, AppState>,
    config_id: i64,
) -> Result<(), String> {
    let db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    db.delete_run_config(config_id).map_err(|e| e.to_string())
}
