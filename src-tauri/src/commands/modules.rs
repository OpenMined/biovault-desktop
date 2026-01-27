use crate::types::{AppState, Module, ModuleEditorLoadResponse, ModuleListEntry};
use biovault::data::{hash_file, ModuleMetadata, UpdateModuleParams};
use biovault::module_spec::{self, InputSpec, ModuleSpec, OutputSpec, ParameterSpec};
use biovault::module_spec::{ModuleAsset, ModuleFile};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct SaveModulePayload {
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
pub struct ModulePreviewResponse {
    yaml: String,
    template: String,
    workflow: String,
}

fn ensure_within_modules_dir(path: &Path) -> Result<(), String> {
    let modules_dir = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to determine BioVault home: {}", e))?
        .join("modules");

    let base = modules_dir.canonicalize().unwrap_or(modules_dir.clone());
    let target = path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize {}: {}", path.display(), e))?;

    if !target.starts_with(&base) {
        return Err(format!(
            "Refusing to delete directory outside modules folder: {}",
            target.display()
        ));
    }

    Ok(())
}

fn parse_spec_payload(data: SaveModulePayload) -> Result<(ModuleMetadata, ModuleSpec), String> {
    let SaveModulePayload {
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
        return Err("Module name cannot be empty".into());
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

    let metadata = ModuleMetadata {
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

    let spec = ModuleSpec {
        name: name_trimmed.to_string(),
        author: author_value,
        workflow: workflow_trimmed.to_string(),
        description: None,
        template: template_value,
        version: Some(version_value),
        datasites: None,
        env: BTreeMap::new(),
        assets: cleaned_assets,
        parameters: parameter_specs,
        inputs: input_specs,
        outputs: output_specs,
        steps: Vec::new(),
    };

    Ok((metadata, spec))
}

fn format_module_yaml(spec: &ModuleSpec) -> Result<String, String> {
    let module = ModuleFile::from_module_spec(spec);
    serde_yaml::to_string(&module).map_err(|e| format!("Failed to serialize module.yaml: {}", e))
}

#[tauri::command]
pub fn preview_module_spec(payload: serde_json::Value) -> Result<ModulePreviewResponse, String> {
    let data: SaveModulePayload =
        serde_json::from_value(payload).map_err(|e| format!("Invalid module payload: {}", e))?;
    let (_, spec) = parse_spec_payload(data)?;

    let yaml = format_module_yaml(&spec)?;
    let template = module_spec::generate_template_nf(&spec)
        .map_err(|e| format!("Failed to generate template preview: {}", e))?;
    let workflow = module_spec::generate_workflow_stub(&spec)
        .map_err(|e| format!("Failed to generate workflow preview: {}", e))?;

    Ok(ModulePreviewResponse {
        yaml,
        template,
        workflow,
    })
}

#[tauri::command]
pub fn import_module(
    _state: tauri::State<AppState>,
    url: String,
    overwrite: bool,
) -> Result<Module, String> {
    crate::desktop_log!("🔍 import_module called with URL: {}", url);

    let imported = tauri::async_runtime::block_on(
        biovault::cli::commands::module_management::import_module_record(
            url.clone(),
            None,
            overwrite,
        ),
    )
    .map_err(|e| format!("Failed to import module: {}", e))?;

    crate::desktop_log!("✅ Module imported via library: {}", imported.name);

    Ok(Module {
        id: imported.id,
        name: imported.name,
        version: imported.version,
        author: imported.author,
        workflow: imported.workflow,
        template: imported.template,
        module_path: imported.module_path,
        created_at: imported.created_at,
    })
}

#[tauri::command]
pub async fn import_flow_with_deps(
    url: String,
    name_override: Option<String>,
    overwrite: bool,
) -> Result<String, String> {
    // Spawn blocking to avoid Send issues with BioVaultDb
    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(async {
            biovault::cli::commands::module_management::import_flow_with_deps(
                &url,
                name_override,
                overwrite,
            )
            .await
            .map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn import_module_from_folder(
    state: tauri::State<AppState>,
    folder_path: String,
) -> Result<Module, String> {
    crate::desktop_log!(
        "📁 import_module_from_folder called with path: {}",
        folder_path
    );

    let path = PathBuf::from(&folder_path);

    // Check if the directory exists
    if !path.exists() {
        return Err(format!("Directory does not exist: {}", folder_path));
    }

    if !path.is_dir() {
        return Err(format!("Path is not a directory: {}", folder_path));
    }

    // Check if module.yaml exists in the folder
    let module_yaml_path = path.join("module.yaml");
    if !module_yaml_path.exists() {
        return Err(format!(
            "No module.yaml found in directory: {}",
            folder_path
        ));
    }

    // Parse the module.yaml to get module metadata
    let yaml_content = std::fs::read_to_string(&module_yaml_path)
        .map_err(|e| format!("Failed to read module.yaml: {}", e))?;

    let module = ModuleFile::parse_yaml(&yaml_content)
        .map_err(|e| format!("Failed to parse module.yaml: {}", e))?;
    let spec = module
        .to_module_spec()
        .map_err(|e| format!("Failed to convert module.yaml: {}", e))?;

    let metadata = ModuleMetadata {
        name: spec.name,
        author: spec.author,
        workflow: spec.workflow,
        template: spec.template,
        version: spec.version,
        assets: spec.assets,
        parameters: spec.parameters,
        inputs: spec.inputs,
        outputs: spec.outputs,
    };

    // Register the module in the database
    let db = state.biovault_db.lock().unwrap();

    // Check if module with same path already exists
    let existing_modules = db
        .list_modules()
        .map_err(|e| format!("Failed to list modules: {}", e))?;

    for module in existing_modules {
        if PathBuf::from(&module.module_path).canonicalize().ok() == path.canonicalize().ok() {
            return Err(format!(
                "Module already imported from this path: {}",
                folder_path
            ));
        }
    }

    // Extract template and version with default values
    let template = metadata.template.unwrap_or_else(|| "imported".to_string());
    let version = metadata.version.unwrap_or_else(|| "1.0.0".to_string());

    // Register the new module
    let module_id = db
        .register_module(
            &metadata.name,
            &version,
            &metadata.author,
            &metadata.workflow,
            &template,
            &path,
        )
        .map_err(|e| format!("Failed to register module: {}", e))?;

    crate::desktop_log!(
        "✅ Module imported from folder: {} (ID: {})",
        metadata.name,
        module_id
    );

    Ok(Module {
        id: module_id,
        name: metadata.name,
        version,
        author: metadata.author,
        workflow: metadata.workflow,
        template,
        module_path: folder_path,
        created_at: chrono::Utc::now().to_rfc3339(),
    })
}

#[tauri::command]
pub fn get_modules(state: tauri::State<AppState>) -> Result<Vec<ModuleListEntry>, String> {
    use std::collections::HashSet;

    crate::desktop_log!("🔍 get_modules called (using library)");

    let db_guard = state.biovault_db.lock().unwrap();
    let cli_modules = db_guard
        .list_modules()
        .map_err(|e| format!("Failed to list modules: {}", e))?;

    let mut entries: Vec<ModuleListEntry> = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();

    for module in cli_modules {
        let path_buf = PathBuf::from(&module.module_path);
        let canonical = path_buf
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(&module.module_path));
        seen_paths.insert(canonical.to_string_lossy().to_string());

        entries.push(ModuleListEntry {
            id: Some(module.id),
            name: module.name,
            version: Some(module.version),
            author: Some(module.author),
            workflow: Some(module.workflow),
            template: Some(module.template),
            module_path: module.module_path,
            created_at: Some(module.created_at),
            source: "database".into(),
            orphaned: false,
        });
    }
    drop(db_guard);

    let modules_dir = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to determine BioVault home: {}", e))?
        .join("modules");

    if modules_dir.exists() {
        if let Ok(read_dir) = fs::read_dir(&modules_dir) {
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

                entries.push(ModuleListEntry {
                    id: None,
                    name,
                    version: None,
                    author: None,
                    workflow: None,
                    template: None,
                    module_path: path.to_string_lossy().to_string(),
                    created_at: None,
                    source: "filesystem".into(),
                    orphaned: true,
                });
            }
        }
    }

    // Sort by created_at descending (most recent first), then by name
    entries.sort_by(|a, b| {
        match (&a.created_at, &b.created_at) {
            (Some(time_a), Some(time_b)) => time_b.cmp(time_a), // Reverse for descending
            (Some(_), None) => std::cmp::Ordering::Less,        // Items with timestamps come first
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.name.to_lowercase().cmp(&b.name.to_lowercase()), // Fallback to name
        }
    });

    crate::desktop_log!("✅ Returning {} module entry(ies)", entries.len());
    Ok(entries)
}

#[tauri::command]
pub fn delete_module(state: tauri::State<AppState>, module_id: i64) -> Result<(), String> {
    crate::desktop_log!(
        "🔍 delete_module called with ID: {} (using library)",
        module_id
    );

    let (module_path, module_name) = {
        let db = state.biovault_db.lock().unwrap();
        let id_str = module_id.to_string();
        let module = db
            .get_module(&id_str)
            .map_err(|e| format!("Failed to load module {}: {}", module_id, e))?
            .ok_or_else(|| format!("Module {} not found", module_id))?;

        db.delete_module(&id_str)
            .map_err(|e| format!("Failed to delete module: {}", e))?;

        (module.module_path, module.name)
    };

    let path_buf = PathBuf::from(&module_path);
    if path_buf.exists() {
        crate::desktop_log!("🗑️  Removing module directory: {}", path_buf.display());
        if let Err(err) = fs::remove_dir_all(&path_buf) {
            use std::io::ErrorKind;
            if err.kind() != ErrorKind::NotFound {
                return Err(format!(
                    "Module '{}' removed from database but failed to delete folder {}: {}",
                    module_name,
                    path_buf.display(),
                    err
                ));
            }
        }
    }

    crate::desktop_log!("✅ Module '{}' deleted", module_name);
    Ok(())
}

#[tauri::command]
pub fn delete_module_folder(module_path: String) -> Result<(), String> {
    let path = PathBuf::from(&module_path);

    if !path.exists() {
        crate::desktop_log!(
            "ℹ️  Module folder already missing, considered deleted: {}",
            module_path
        );
        return Ok(());
    }

    ensure_within_modules_dir(&path)?;

    fs::remove_dir_all(&path)
        .map_err(|e| format!("Failed to delete module folder {}: {}", path.display(), e))?;

    crate::desktop_log!("✅ Deleted module folder {}", path.display());
    Ok(())
}

#[tauri::command]
pub fn create_module(
    _state: tauri::State<AppState>,
    name: String,
    example: Option<String>,
    directory: Option<String>,
    create_python_script: Option<bool>,
    script_name: Option<String>,
) -> Result<Module, String> {
    crate::desktop_log!(
        "🔍 create_module called with name: {} example: {:?} python_script: {:?}",
        name,
        example,
        create_python_script
    );

    let target_dir = directory.map(PathBuf::from);

    let created = biovault::cli::commands::module_management::create_module_record(
        name.clone(),
        example,
        target_dir,
    )
    .map_err(|e| format!("Failed to create module: {}", e))?;

    // Add Python script if requested for blank modules
    if create_python_script.unwrap_or(false) && created.template == "dynamic-nextflow" {
        let module_path = PathBuf::from(&created.module_path);
        let assets_dir = module_path.join("assets");
        std::fs::create_dir_all(&assets_dir)
            .map_err(|e| format!("Failed to create assets directory: {}", e))?;

        let filename = script_name.as_deref().unwrap_or("process.py");
        let script_path = assets_dir.join(filename);
        let script_content = biovault::module_spec::generate_python_script_template(filename);

        std::fs::write(&script_path, script_content)
            .map_err(|e| format!("Failed to write Python script: {}", e))?;

        // Update module.yaml to include the asset
        let module_yaml_path = module_path.join("module.yaml");
        let yaml_content = std::fs::read_to_string(&module_yaml_path)
            .map_err(|e| format!("Failed to read module.yaml: {}", e))?;

        let mut module = ModuleFile::parse_yaml(&yaml_content)
            .map_err(|e| format!("Failed to parse module.yaml: {}", e))?;

        let assets = module.spec.assets.get_or_insert_with(Vec::new);
        if !assets.iter().any(|asset| asset.path == filename) {
            assets.push(ModuleAsset {
                path: filename.to_string(),
            });
        }

        let updated_yaml = serde_yaml::to_string(&module)
            .map_err(|e| format!("Failed to serialize module.yaml: {}", e))?;
        std::fs::write(&module_yaml_path, updated_yaml)
            .map_err(|e| format!("Failed to update module.yaml: {}", e))?;

        crate::desktop_log!(
            "✅ Created Python script: {} and updated assets",
            script_path.display()
        );
    }

    crate::desktop_log!(
        "✅ Module '{}' created successfully via library",
        created.name
    );

    Ok(Module {
        id: created.id,
        name: created.name,
        version: created.version,
        author: created.author,
        workflow: created.workflow,
        template: created.template,
        module_path: created.module_path,
        created_at: created.created_at,
    })
}

#[tauri::command]
pub fn get_available_module_examples() -> Result<HashMap<String, serde_json::Value>, String> {
    use std::fs;
    use std::path::PathBuf;

    // Get the path to the flow examples directory
    let flow_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("Failed to get parent directory")?
        .join("biovault/cli/examples/flow");

    if !flow_dir.exists() {
        return Err(format!(
            "Flow examples directory not found at: {}",
            flow_dir.display()
        ));
    }

    let mut result = HashMap::new();

    // Scan for subdirectories with module.yaml
    let entries =
        fs::read_dir(&flow_dir).map_err(|e| format!("Failed to read flow directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        // Skip files, only process directories
        if !path.is_dir() {
            continue;
        }

        let module_yaml = path.join("module.yaml");
        if module_yaml.exists() {
            // Load the module.yaml
            let yaml_content = fs::read_to_string(&module_yaml)
                .map_err(|e| format!("Failed to read {}: {}", module_yaml.display(), e))?;

            let module = ModuleFile::parse_yaml(&yaml_content)
                .map_err(|e| format!("Failed to parse {}: {}", module_yaml.display(), e))?;
            let spec = module
                .to_module_spec()
                .map_err(|e| format!("Failed to convert {}: {}", module_yaml.display(), e))?;

            // Use directory name as key
            let dir_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or("Invalid directory name")?
                .to_string();

            // Convert to JSON
            let json_value = serde_json::to_value(&spec)
                .map_err(|e| format!("Failed to convert to JSON: {}", e))?;

            result.insert(dir_name, json_value);
        }
    }

    Ok(result)
}

#[tauri::command]
pub fn get_default_module_path(name: Option<String>) -> Result<String, String> {
    let raw = name.unwrap_or_else(|| "new-module".to_string());
    let trimmed = raw.trim();

    let mut candidate = trimmed.replace(['/', '\\'], "-").trim().to_string();

    if candidate.is_empty() || candidate == "." || candidate == ".." {
        candidate = "new-module".to_string();
    }

    let modules_dir = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to determine BioVault home: {}", e))?
        .join("modules");

    let path = modules_dir.join(candidate);
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn load_module_editor(
    state: tauri::State<AppState>,
    module_id: Option<i64>,
    module_path: Option<String>,
) -> Result<ModuleEditorLoadResponse, String> {
    if module_id.is_none() && module_path.is_none() {
        return Err("Either module_id or module_path must be provided".into());
    }

    let (path_buf, resolved_module_id, fallback_name) = if let Some(id) = module_id {
        let record = {
            let db = state.biovault_db.lock().unwrap();
            db.get_module(&id.to_string())
                .map_err(|e| format!("Failed to load module {}: {}", id, e))?
                .ok_or_else(|| format!("Module {} not found", id))?
        };

        let mut proj_path = PathBuf::from(&record.module_path);

        // If the path points to a file (e.g., module.yaml), use its parent directory
        if proj_path.is_file() {
            crate::desktop_log!(
                "⚠️ Module path is a file, using parent directory: {}",
                proj_path.display()
            );
            proj_path = proj_path
                .parent()
                .ok_or_else(|| {
                    format!(
                        "Invalid module path (file with no parent): {}",
                        record.module_path
                    )
                })?
                .to_path_buf();
        }

        // Validate the module directory exists
        if !proj_path.exists() {
            return Err(format!(
                "Module directory not found: {}. The module may have been imported incorrectly or moved.",
                proj_path.display()
            ));
        }

        if !proj_path.is_dir() {
            return Err(format!(
                "Module path is not a directory: {}",
                proj_path.display()
            ));
        }

        (proj_path, Some(record.id), Some(record.name))
    } else {
        let raw_path = module_path.unwrap();
        let mut proj_path = PathBuf::from(&raw_path);

        // Check if this might be a module NAME instead of a path
        // (no slashes and not an absolute path)
        if !raw_path.contains('/') && !raw_path.contains('\\') && !proj_path.is_absolute() {
            crate::desktop_log!(
                "🔍 '{}' looks like a module name, attempting database lookup",
                raw_path
            );

            // Try to find module by name in database
            let db = state.biovault_db.lock().unwrap();
            if let Ok(Some(record)) = db.get_module(&raw_path) {
                crate::desktop_log!(
                    "✅ Found module '{}' in database at: {}",
                    raw_path,
                    record.module_path
                );
                proj_path = PathBuf::from(&record.module_path);

                // Handle file paths in database
                if proj_path.is_file() {
                    proj_path = proj_path
                        .parent()
                        .ok_or_else(|| {
                            format!(
                                "Invalid module path (file with no parent): {}",
                                record.module_path
                            )
                        })?
                        .to_path_buf();
                }

                drop(db); // Release lock
                (proj_path, Some(record.id), Some(record.name))
            } else {
                crate::desktop_log!(
                    "⚠️ Module name '{}' not found in database, treating as path",
                    raw_path
                );
                drop(db); // Release lock

                // Treat as path
                if proj_path.is_file() {
                    proj_path = proj_path
                        .parent()
                        .ok_or_else(|| {
                            format!("Invalid module path (file with no parent): {}", raw_path)
                        })?
                        .to_path_buf();
                }

                (proj_path, None, None)
            }
        } else {
            // Definitely a path (has slashes or is absolute)
            if proj_path.is_file() {
                proj_path = proj_path
                    .parent()
                    .ok_or_else(|| {
                        format!("Invalid module path (file with no parent): {}", raw_path)
                    })?
                    .to_path_buf();
            }

            (proj_path, None, None)
        }
    };

    let metadata_result = biovault::data::load_module_metadata(&path_buf)
        .map_err(|e| format!("Failed to read module.yaml: {}", e))?;
    let has_module_yaml = metadata_result.is_some();

    let default_author = biovault::config::Config::load()
        .map(|cfg| cfg.email)
        .unwrap_or_default();

    let directory_name = path_buf
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "module".to_string());

    let mut metadata = metadata_result.unwrap_or_else(|| ModuleMetadata {
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

    let file_tree = biovault::data::build_module_file_tree(&path_buf)
        .map_err(|e| format!("Failed to build file tree: {}", e))?;

    Ok(ModuleEditorLoadResponse {
        module_id: resolved_module_id,
        module_path: path_buf.to_string_lossy().to_string(),
        metadata,
        file_tree,
        has_module_yaml,
    })
}

#[tauri::command]
pub fn save_module_editor(
    state: tauri::State<AppState>,
    module_id: Option<i64>,
    module_path: String,
    payload: serde_json::Value,
) -> Result<Module, String> {
    let data: SaveModulePayload =
        serde_json::from_value(payload).map_err(|e| format!("Invalid module payload: {}", e))?;
    let (metadata, spec) = parse_spec_payload(data)?;

    let module_path_buf = PathBuf::from(&module_path);
    if !module_path_buf.exists() {
        fs::create_dir_all(&module_path_buf).map_err(|e| {
            format!(
                "Failed to create module directory {}: {}",
                module_path_buf.display(),
                e
            )
        })?;
    }

    biovault::data::save_module_metadata(&module_path_buf, &metadata)
        .map_err(|e| format!("Failed to save module.yaml: {}", e))?;

    // Regenerate workflow.nf if template is dynamic-nextflow
    if metadata.template.as_deref() == Some("dynamic-nextflow") {
        let workflow_stub = module_spec::generate_workflow_stub(&spec)
            .map_err(|e| format!("Failed to generate workflow stub: {}", e))?;
        let workflow_path = module_path_buf.join(&metadata.workflow);
        fs::write(&workflow_path, workflow_stub)
            .map_err(|e| format!("Failed to write workflow.nf: {}", e))?;
    }

    let template_for_db = metadata
        .template
        .clone()
        .unwrap_or_else(|| "custom".to_string());
    let version_for_db = metadata
        .version
        .clone()
        .unwrap_or_else(|| "1.0.0".to_string());

    let make_update_params = || UpdateModuleParams {
        name: metadata.name.as_str(),
        version: version_for_db.as_str(),
        author: metadata.author.as_str(),
        workflow: metadata.workflow.as_str(),
        template: template_for_db.as_str(),
        module_path: module_path_buf.as_path(),
    };

    let module_record = {
        let db = state.biovault_db.lock().unwrap();
        if let Some(id) = module_id {
            // Update existing module by ID
            db.update_module_by_id(id, make_update_params())
                .map_err(|e| format!("Failed to update module: {}", e))?;

            db.get_module(&id.to_string())
                .map_err(|e| format!("Failed to reload module {}: {}", id, e))?
                .ok_or_else(|| format!("Module {} not found after update", id))?
        } else {
            // No module_id provided - try to find existing module by name or register new one
            match db.get_module(&metadata.name) {
                Ok(Some(existing)) => {
                    // Module exists - update it
                    db.update_module_by_id(existing.id, make_update_params())
                        .map_err(|e| format!("Failed to update existing module: {}", e))?;

                    existing
                }
                Ok(None) | Err(_) => {
                    // Module doesn't exist - register new one
                    db.register_module(
                        &metadata.name,
                        &version_for_db,
                        &metadata.author,
                        &metadata.workflow,
                        &template_for_db,
                        &module_path_buf,
                    )
                    .map_err(|e| format!("Failed to register module: {}", e))?;

                    db.get_module(&metadata.name)
                        .map_err(|e| format!("Failed to load module '{}': {}", metadata.name, e))?
                        .ok_or_else(|| {
                            format!("Module '{}' not found after registration", metadata.name)
                        })?
                }
            }
        }
    };

    Ok(Module {
        id: module_record.id,
        name: module_record.name,
        version: module_record.version,
        author: module_record.author,
        workflow: module_record.workflow,
        template: module_record.template,
        module_path: module_record.module_path,
        created_at: module_record.created_at,
    })
}

#[tauri::command]
pub fn get_module_spec_digest(module_path: String) -> Result<Option<String>, String> {
    let module_root = PathBuf::from(&module_path);
    let yaml_path = module_root.join("module.yaml");

    if !yaml_path.exists() {
        return Ok(None);
    }

    hash_file(yaml_path.to_str().unwrap())
        .map(Some)
        .map_err(|e| format!("Failed to hash module.yaml: {}", e))
}

#[tauri::command]
#[allow(dead_code)]
pub fn get_supported_input_types() -> module_spec::TypeInfo {
    module_spec::get_supported_input_types()
}

#[tauri::command]
#[allow(dead_code)]
pub fn get_supported_output_types() -> module_spec::TypeInfo {
    module_spec::get_supported_output_types()
}

#[tauri::command]
#[allow(dead_code)]
pub fn get_supported_parameter_types() -> Vec<String> {
    module_spec::get_supported_parameter_types()
}

#[tauri::command]
#[allow(dead_code)]
pub fn get_common_formats() -> Vec<String> {
    module_spec::get_common_formats()
}
