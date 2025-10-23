use crate::types::{AppState, Project, ProjectEditorLoadResponse, ProjectListEntry};
use biovault::data::{project_yaml_hash, ProjectMetadata};
use biovault::project_spec::{self, InputSpec, OutputSpec, ParameterSpec, ProjectSpec};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct SaveProjectPayload {
    name: String,
    author: String,
    workflow: String,
    #[serde(default)]
    template: Option<String>,
    #[serde(default)]
    assets: Vec<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    parameters: Vec<ParameterPayload>,
    #[serde(default)]
    inputs: Vec<InputPayload>,
    #[serde(default)]
    outputs: Vec<OutputPayload>,
}

#[derive(Deserialize)]
struct ParameterPayload {
    name: String,
    #[serde(rename = "type")]
    raw_type: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    default: Option<String>,
    #[serde(default)]
    choices: Option<Vec<String>>,
    #[serde(default)]
    advanced: Option<bool>,
}

#[derive(Deserialize)]
struct InputPayload {
    name: String,
    #[serde(rename = "type")]
    raw_type: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    mapping: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
struct OutputPayload {
    name: String,
    #[serde(rename = "type")]
    raw_type: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Serialize)]
pub struct ProjectPreviewResponse {
    yaml: String,
    template: String,
}

fn ensure_within_projects_dir(path: &Path) -> Result<(), String> {
    let projects_dir = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to determine BioVault home: {}", e))?
        .join("projects");

    let base = projects_dir.canonicalize().unwrap_or(projects_dir.clone());
    let target = path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize {}: {}", path.display(), e))?;

    if !target.starts_with(&base) {
        return Err(format!(
            "Refusing to delete directory outside projects folder: {}",
            target.display()
        ));
    }

    Ok(())
}

fn parse_spec_payload(data: SaveProjectPayload) -> Result<(ProjectMetadata, ProjectSpec), String> {
    let SaveProjectPayload {
        name,
        author,
        workflow,
        template,
        assets,
        version,
        parameters,
        inputs,
        outputs,
    } = data;

    let name_trimmed = name.trim();
    if name_trimmed.is_empty() {
        return Err("Project name cannot be empty".into());
    }

    let workflow_trimmed = workflow.trim();
    if workflow_trimmed.is_empty() {
        return Err("Workflow cannot be empty".into());
    }

    let mut author_value = author.trim().to_string();
    if author_value.is_empty() {
        author_value = biovault::config::Config::load()
            .map(|cfg| cfg.email)
            .unwrap_or_default();
    }

    let template_value = template.and_then(|t| {
        let trimmed = t.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    let mut cleaned_assets: Vec<String> = assets
        .into_iter()
        .map(|entry| entry.trim().replace('\\', "/"))
        .filter(|entry| !entry.is_empty())
        .collect();
    cleaned_assets.sort();
    cleaned_assets.dedup();

    let parameter_specs: Vec<ParameterSpec> = parameters
        .into_iter()
        .map(
            |ParameterPayload {
                 name,
                 raw_type,
                 description,
                 default,
                 choices,
                 advanced,
             }| {
                let description = description
                    .map(|d| d.trim().to_string())
                    .filter(|d| !d.is_empty());

                let choices = choices.and_then(|items| {
                    let cleaned: Vec<String> = items
                        .into_iter()
                        .map(|choice| choice.trim().to_string())
                        .filter(|choice| !choice.is_empty())
                        .collect();
                    if cleaned.is_empty() {
                        None
                    } else {
                        Some(cleaned)
                    }
                });

                let default = default.and_then(|raw| {
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        match serde_yaml::from_str::<serde_yaml::Value>(trimmed) {
                            Ok(value) => Some(value),
                            Err(_) => Some(serde_yaml::Value::String(trimmed.to_string())),
                        }
                    }
                });

                ParameterSpec {
                    name: name.trim().to_string(),
                    raw_type: raw_type.trim().to_string(),
                    description,
                    default,
                    choices,
                    advanced,
                }
            },
        )
        .collect();

    let input_specs: Vec<InputSpec> = inputs
        .into_iter()
        .map(|input| InputSpec {
            name: input.name.trim().to_string(),
            raw_type: input.raw_type.trim().to_string(),
            description: input
                .description
                .map(|d| d.trim().to_string())
                .filter(|d| !d.is_empty()),
            format: input
                .format
                .map(|f| f.trim().to_string())
                .filter(|f| !f.is_empty()),
            path: input
                .path
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty()),
            mapping: input.mapping.map(|map| {
                map.into_iter()
                    .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
                    .collect()
            }),
        })
        .collect();

    let output_specs: Vec<OutputSpec> = outputs
        .into_iter()
        .map(|output| OutputSpec {
            name: output.name.trim().to_string(),
            raw_type: output.raw_type.trim().to_string(),
            description: output
                .description
                .map(|d| d.trim().to_string())
                .filter(|d| !d.is_empty()),
            format: output
                .format
                .map(|f| f.trim().to_string())
                .filter(|f| !f.is_empty()),
            path: output
                .path
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty()),
        })
        .collect();

    let version_value = match version {
        Some(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => "1.0.0".to_string(),
    };

    let metadata = ProjectMetadata {
        name: name_trimmed.to_string(),
        author: author_value.clone(),
        workflow: workflow_trimmed.to_string(),
        template: template_value.clone(),
        version: Some(version_value.clone()),
        assets: cleaned_assets.clone(),
        parameters: parameter_specs.clone(),
        inputs: input_specs.clone(),
        outputs: output_specs.clone(),
    };

    let spec = ProjectSpec {
        name: name_trimmed.to_string(),
        author: author_value,
        workflow: workflow_trimmed.to_string(),
        template: template_value,
        version: Some(version_value),
        assets: cleaned_assets,
        parameters: parameter_specs,
        inputs: input_specs,
        outputs: output_specs,
    };

    Ok((metadata, spec))
}

#[tauri::command]
pub fn preview_project_spec(payload: serde_json::Value) -> Result<ProjectPreviewResponse, String> {
    let data: SaveProjectPayload =
        serde_json::from_value(payload).map_err(|e| format!("Invalid project payload: {}", e))?;
    let (_, spec) = parse_spec_payload(data)?;

    let yaml =
        serde_yaml::to_string(&spec).map_err(|e| format!("Failed to serialize preview: {}", e))?;
    let template = project_spec::generate_template_nf(&spec)
        .map_err(|e| format!("Failed to generate template preview: {}", e))?;

    Ok(ProjectPreviewResponse { yaml, template })
}

#[tauri::command]
pub fn import_project(
    _state: tauri::State<AppState>,
    url: String,
    overwrite: bool,
) -> Result<Project, String> {
    eprintln!("🔍 import_project called with URL: {}", url);

    let imported = tauri::async_runtime::block_on(
        biovault::cli::commands::project_management::import_project_record(
            url.clone(),
            None,
            overwrite,
        ),
    )
    .map_err(|e| format!("Failed to import project: {}", e))?;

    eprintln!("✅ Project imported via library: {}", imported.name);

    Ok(Project {
        id: imported.id,
        name: imported.name,
        author: imported.author,
        workflow: imported.workflow,
        template: imported.template,
        project_path: imported.project_path,
        created_at: imported.created_at,
    })
}

#[tauri::command]
pub fn get_projects(state: tauri::State<AppState>) -> Result<Vec<ProjectListEntry>, String> {
    use std::collections::HashSet;

    eprintln!("🔍 get_projects called (using library)");

    let db_guard = state.biovault_db.lock().unwrap();
    let cli_projects = db_guard
        .list_projects()
        .map_err(|e| format!("Failed to list projects: {}", e))?;

    let mut entries: Vec<ProjectListEntry> = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();

    for project in cli_projects {
        let path_buf = PathBuf::from(&project.project_path);
        let canonical = path_buf
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(&project.project_path));
        seen_paths.insert(canonical.to_string_lossy().to_string());

        entries.push(ProjectListEntry {
            id: Some(project.id),
            name: project.name,
            author: Some(project.author),
            workflow: Some(project.workflow),
            template: Some(project.template),
            project_path: project.project_path,
            created_at: Some(project.created_at),
            source: "database".into(),
            orphaned: false,
        });
    }
    drop(db_guard);

    let projects_dir = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to determine BioVault home: {}", e))?
        .join("projects");

    if projects_dir.exists() {
        if let Ok(read_dir) = fs::read_dir(&projects_dir) {
            for entry in read_dir.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }

                let canonical = path
                    .canonicalize()
                    .unwrap_or_else(|_| path.clone())
                    .to_string_lossy()
                    .to_string();

                if seen_paths.contains(&canonical) {
                    continue;
                }

                let name = entry.file_name().to_string_lossy().to_string();

                entries.push(ProjectListEntry {
                    id: None,
                    name,
                    author: None,
                    workflow: None,
                    template: None,
                    project_path: path.to_string_lossy().to_string(),
                    created_at: None,
                    source: "filesystem".into(),
                    orphaned: true,
                });
            }
        }
    }

    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    eprintln!("✅ Returning {} project entry(ies)", entries.len());
    Ok(entries)
}

#[tauri::command]
pub fn delete_project(state: tauri::State<AppState>, project_id: i64) -> Result<(), String> {
    eprintln!(
        "🔍 delete_project called with ID: {} (using library)",
        project_id
    );

    let (project_path, project_name) = {
        let db = state.biovault_db.lock().unwrap();
        let id_str = project_id.to_string();
        let project = db
            .get_project(&id_str)
            .map_err(|e| format!("Failed to load project {}: {}", project_id, e))?
            .ok_or_else(|| format!("Project {} not found", project_id))?;

        db.delete_project(&id_str)
            .map_err(|e| format!("Failed to delete project: {}", e))?;

        (project.project_path, project.name)
    };

    let path_buf = PathBuf::from(&project_path);
    if path_buf.exists() {
        eprintln!("🗑️  Removing project directory: {}", path_buf.display());
        if let Err(err) = fs::remove_dir_all(&path_buf) {
            use std::io::ErrorKind;
            if err.kind() != ErrorKind::NotFound {
                return Err(format!(
                    "Project '{}' removed from database but failed to delete folder {}: {}",
                    project_name,
                    path_buf.display(),
                    err
                ));
            }
        }
    }

    eprintln!("✅ Project '{}' deleted", project_name);
    Ok(())
}

#[tauri::command]
pub fn delete_project_folder(project_path: String) -> Result<(), String> {
    let path = PathBuf::from(&project_path);

    if !path.exists() {
        eprintln!(
            "ℹ️  Project folder already missing, considered deleted: {}",
            project_path
        );
        return Ok(());
    }

    ensure_within_projects_dir(&path)?;

    fs::remove_dir_all(&path)
        .map_err(|e| format!("Failed to delete project folder {}: {}", path.display(), e))?;

    eprintln!("✅ Deleted project folder {}", path.display());
    Ok(())
}

#[tauri::command]
pub fn create_project(
    _state: tauri::State<AppState>,
    name: String,
    example: Option<String>,
    directory: Option<String>,
) -> Result<Project, String> {
    eprintln!(
        "🔍 create_project called with name: {} example: {:?}",
        name, example
    );

    let target_dir = directory.map(PathBuf::from);

    let created = biovault::cli::commands::project_management::create_project_record(
        name.clone(),
        example,
        target_dir,
    )
    .map_err(|e| format!("Failed to create project: {}", e))?;

    eprintln!(
        "✅ Project '{}' created successfully via library",
        created.name
    );

    Ok(Project {
        id: created.id,
        name: created.name,
        author: created.author,
        workflow: created.workflow,
        template: created.template,
        project_path: created.project_path,
        created_at: created.created_at,
    })
}

#[tauri::command]
pub fn get_available_project_examples() -> Result<HashMap<String, serde_json::Value>, String> {
    use std::fs;
    use std::path::PathBuf;

    // Get the path to the biovault submodule's examples.yaml
    let examples_yaml_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("Failed to get parent directory")?
        .join("biovault/cli/examples/examples.yaml");

    if !examples_yaml_path.exists() {
        return Err(format!(
            "Examples file not found at: {}",
            examples_yaml_path.display()
        ));
    }

    let yaml_content = fs::read_to_string(&examples_yaml_path)
        .map_err(|e| format!("Failed to read examples.yaml: {}", e))?;

    let yaml: serde_yaml::Value = serde_yaml::from_str(&yaml_content)
        .map_err(|e| format!("Failed to parse examples.yaml: {}", e))?;

    let examples = yaml
        .get("examples")
        .and_then(|e| e.as_mapping())
        .ok_or("Invalid examples.yaml format")?;

    let mut result = HashMap::new();
    for (key, value) in examples {
        let example_name = key.as_str().ok_or("Invalid example name")?.to_string();
        let json_value =
            serde_json::to_value(value).map_err(|e| format!("Failed to convert to JSON: {}", e))?;
        result.insert(example_name, json_value);
    }

    Ok(result)
}

#[tauri::command]
pub fn get_default_project_path(name: Option<String>) -> Result<String, String> {
    let raw = name.unwrap_or_else(|| "new-project".to_string());
    let trimmed = raw.trim();

    let mut candidate = trimmed.replace(['/', '\\'], "-").trim().to_string();

    if candidate.is_empty() || candidate == "." || candidate == ".." {
        candidate = "new-project".to_string();
    }

    let projects_dir = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to determine BioVault home: {}", e))?
        .join("projects");

    let path = projects_dir.join(candidate);
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn load_project_editor(
    state: tauri::State<AppState>,
    project_id: Option<i64>,
    project_path: Option<String>,
) -> Result<ProjectEditorLoadResponse, String> {
    if project_id.is_none() && project_path.is_none() {
        return Err("Either project_id or project_path must be provided".into());
    }

    let (path_buf, resolved_project_id, fallback_name) = if let Some(id) = project_id {
        let record = {
            let db = state.biovault_db.lock().unwrap();
            db.get_project(&id.to_string())
                .map_err(|e| format!("Failed to load project {}: {}", id, e))?
                .ok_or_else(|| format!("Project {} not found", id))?
        };
        (
            PathBuf::from(&record.project_path),
            Some(record.id),
            Some(record.name),
        )
    } else {
        let raw_path = project_path.unwrap();
        (PathBuf::from(&raw_path), None, None)
    };

    let metadata_result = biovault::data::load_project_metadata(&path_buf)
        .map_err(|e| format!("Failed to read project.yaml: {}", e))?;
    let has_project_yaml = metadata_result.is_some();

    let default_author = biovault::config::Config::load()
        .map(|cfg| cfg.email)
        .unwrap_or_default();

    let directory_name = path_buf
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".to_string());

    let mut metadata = metadata_result.unwrap_or_else(|| ProjectMetadata {
        name: fallback_name
            .clone()
            .unwrap_or_else(|| directory_name.clone()),
        author: default_author.clone(),
        workflow: "workflow.nf".into(),
        template: None,
        version: None,
        assets: Vec::new(),
        parameters: Vec::new(),
        inputs: Vec::new(),
        outputs: Vec::new(),
    });

    if metadata.name.trim().is_empty() {
        metadata.name = fallback_name.unwrap_or_else(|| directory_name.clone());
    }

    if metadata.author.trim().is_empty() && !default_author.is_empty() {
        metadata.author = default_author;
    }

    if metadata.workflow.trim().is_empty() {
        metadata.workflow = "workflow.nf".into();
    }

    if metadata
        .version
        .as_ref()
        .map(|v| v.trim().is_empty())
        .unwrap_or(true)
    {
        metadata.version = Some("1.0.0".into());
    }

    metadata.assets = metadata
        .assets
        .iter()
        .map(|entry| entry.trim().replace('\\', "/"))
        .filter(|entry| !entry.is_empty())
        .collect();

    let file_tree = biovault::data::build_project_file_tree(&path_buf)
        .map_err(|e| format!("Failed to build file tree: {}", e))?;

    Ok(ProjectEditorLoadResponse {
        project_id: resolved_project_id,
        project_path: path_buf.to_string_lossy().to_string(),
        metadata,
        file_tree,
        has_project_yaml,
    })
}

#[tauri::command]
pub fn save_project_editor(
    state: tauri::State<AppState>,
    project_id: Option<i64>,
    project_path: String,
    payload: serde_json::Value,
) -> Result<Project, String> {
    let data: SaveProjectPayload =
        serde_json::from_value(payload).map_err(|e| format!("Invalid project payload: {}", e))?;
    let (metadata, _spec) = parse_spec_payload(data)?;

    let project_path_buf = PathBuf::from(&project_path);
    if !project_path_buf.exists() {
        fs::create_dir_all(&project_path_buf).map_err(|e| {
            format!(
                "Failed to create project directory {}: {}",
                project_path_buf.display(),
                e
            )
        })?;
    }

    biovault::data::save_project_metadata(&project_path_buf, &metadata)
        .map_err(|e| format!("Failed to save project.yaml: {}", e))?;

    let template_for_db = metadata
        .template
        .clone()
        .unwrap_or_else(|| "custom".to_string());

    let project_record = {
        let db = state.biovault_db.lock().unwrap();
        if let Some(id) = project_id {
            db.update_project_by_id(
                id,
                &metadata.name,
                &metadata.author,
                &metadata.workflow,
                &template_for_db,
                &project_path_buf,
            )
            .map_err(|e| format!("Failed to update project: {}", e))?;

            db.get_project(&id.to_string())
                .map_err(|e| format!("Failed to reload project {}: {}", id, e))?
                .ok_or_else(|| format!("Project {} not found after update", id))?
        } else {
            db.register_project(
                &metadata.name,
                &metadata.author,
                &metadata.workflow,
                &template_for_db,
                &project_path_buf,
            )
            .map_err(|e| format!("Failed to register project: {}", e))?;

            db.get_project(&metadata.name)
                .map_err(|e| format!("Failed to load project '{}': {}", metadata.name, e))?
                .ok_or_else(|| {
                    format!("Project '{}' not found after registration", metadata.name)
                })?
        }
    };

    Ok(Project {
        id: project_record.id,
        name: project_record.name,
        author: project_record.author,
        workflow: project_record.workflow,
        template: project_record.template,
        project_path: project_record.project_path,
        created_at: project_record.created_at,
    })
}

#[tauri::command]
pub fn get_project_spec_digest(project_path: String) -> Result<Option<String>, String> {
    let project_root = PathBuf::from(&project_path);
    project_yaml_hash(&project_root).map_err(|e| format!("Failed to hash project.yaml: {}", e))
}
