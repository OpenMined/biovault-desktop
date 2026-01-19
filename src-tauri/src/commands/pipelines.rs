use crate::types::AppState;
use biovault::syftbox::storage::SyftBoxStorage;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use walkdir::WalkDir;

// Use CLI library types and functions
use biovault::cli::commands::pipeline::run_pipeline as cli_run_pipeline;
use biovault::cli::commands::project_management::{
    resolve_pipeline_dependencies, DependencyContext,
};
use biovault::data::BioVaultDb;
pub use biovault::data::{Pipeline, PipelineRun, RunConfig};
use biovault::flow_spec::FlowFile;
use biovault::module_spec::ModuleFile;
pub use biovault::pipeline_spec::PipelineSpec;
use biovault::pipeline_spec::FLOW_YAML_FILE;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    /// Legacy: database file IDs (deprecated, use urls instead)
    #[serde(default, alias = "file_ids")]
    pub file_ids: Vec<i64>,
    /// Syft URLs to resolve to local file paths
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default, alias = "participant_ids")]
    pub participant_ids: Vec<String>,
    #[serde(default, alias = "dataset_name")]
    pub dataset_name: Option<String>,
    #[serde(default)]
    pub dataset_shape: Option<String>,
    #[serde(default)]
    pub dataset_data_type: Option<String>,
    #[serde(default, alias = "dataset_owner")]
    pub dataset_owner: Option<String>,
    #[serde(default, alias = "asset_keys")]
    pub asset_keys: Vec<String>,
    #[serde(default, alias = "data_type")]
    pub data_type: Option<String>,
    #[serde(default, alias = "data_source")]
    pub data_source: Option<String>,
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

#[derive(Debug, Clone)]
enum ShapeExpr {
    String,
    Bool,
    File,
    Directory,
    GenotypeRecord,
    List(Box<ShapeExpr>),
    Map(Box<ShapeExpr>),
    Record(Vec<RecordField>),
}

#[derive(Debug, Clone)]
struct RecordField {
    name: String,
    ty: ShapeExpr,
}

#[derive(Debug, Clone)]
enum DatasetInputValue {
    Path(String),
    Json(serde_json::Value),
}

fn strip_wrapped<'a>(raw: &'a str, prefix: &str, suffix: char) -> Option<&'a str> {
    if raw.len() < prefix.len() + 1 {
        return None;
    }
    if !raw[..prefix.len()].eq_ignore_ascii_case(prefix) {
        return None;
    }
    if !raw.ends_with(suffix) {
        return None;
    }
    Some(raw[prefix.len()..raw.len() - 1].trim())
}

fn split_top_level(raw: &str, delimiter: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth: usize = 0;
    let mut start = 0;
    for (idx, ch) in raw.char_indices() {
        match ch {
            '[' | '{' => depth += 1,
            ']' | '}' => depth = depth.saturating_sub(1),
            _ => {}
        }
        if ch == delimiter && depth == 0 {
            parts.push(raw[start..idx].trim().to_string());
            start = idx + 1;
        }
    }
    parts.push(raw[start..].trim().to_string());
    parts.retain(|part| !part.is_empty());
    parts
}

fn split_top_level_once(raw: &str, delimiter: char) -> Option<(String, String)> {
    let mut depth: usize = 0;
    for (idx, ch) in raw.char_indices() {
        match ch {
            '[' | '{' => depth += 1,
            ']' | '}' => depth = depth.saturating_sub(1),
            _ => {}
        }
        if ch == delimiter && depth == 0 {
            return Some((
                raw[..idx].trim().to_string(),
                raw[idx + 1..].trim().to_string(),
            ));
        }
    }
    None
}

fn parse_shape_expr(raw: &str) -> Option<ShapeExpr> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let base = trimmed.strip_suffix('?').unwrap_or(trimmed).trim();
    if let Some(inner) = strip_wrapped(base, "List[", ']') {
        return Some(ShapeExpr::List(Box::new(parse_shape_expr(inner)?)));
    }
    if let Some(inner) = strip_wrapped(base, "Map[", ']') {
        let parts = split_top_level(inner, ',');
        if parts.len() != 2 {
            return None;
        }
        if !parts[0].eq_ignore_ascii_case("String") {
            return None;
        }
        return Some(ShapeExpr::Map(Box::new(parse_shape_expr(&parts[1])?)));
    }
    if let Some(inner) =
        strip_wrapped(base, "Record{", '}').or_else(|| strip_wrapped(base, "Dict{", '}'))
    {
        if inner.is_empty() {
            return None;
        }
        let mut fields = Vec::new();
        for field in split_top_level(inner, ',') {
            let (name, ty_raw) = split_top_level_once(&field, ':')?;
            if name.is_empty() {
                return None;
            }
            fields.push(RecordField {
                name,
                ty: parse_shape_expr(&ty_raw)?,
            });
        }
        return Some(ShapeExpr::Record(fields));
    }
    match base.to_ascii_lowercase().as_str() {
        "string" => Some(ShapeExpr::String),
        "bool" => Some(ShapeExpr::Bool),
        "file" => Some(ShapeExpr::File),
        "directory" => Some(ShapeExpr::Directory),
        "genotyperecord" => Some(ShapeExpr::GenotypeRecord),
        _ => None,
    }
}

fn lookup_file_path(db: &BioVaultDb, file_id: i64) -> Option<String> {
    db.conn
        .query_row(
            "SELECT file_path FROM files WHERE id = ?1",
            [file_id],
            |row| row.get(0),
        )
        .ok()
}

fn resolve_asset_path(
    db: &BioVaultDb,
    asset: &biovault::data::DatasetAssetRecord,
    data_type: &str,
) -> Option<String> {
    match data_type {
        "mock" => asset
            .mock_path
            .clone()
            .or_else(|| asset.mock_file_id.and_then(|id| lookup_file_path(db, id))),
        "real" => asset.private_path.clone().or_else(|| {
            asset
                .private_file_id
                .and_then(|id| lookup_file_path(db, id))
        }),
        "both" => asset
            .private_path
            .clone()
            .or_else(|| {
                asset
                    .private_file_id
                    .and_then(|id| lookup_file_path(db, id))
            })
            .or_else(|| asset.mock_path.clone())
            .or_else(|| asset.mock_file_id.and_then(|id| lookup_file_path(db, id))),
        _ => asset
            .private_path
            .clone()
            .or_else(|| {
                asset
                    .private_file_id
                    .and_then(|id| lookup_file_path(db, id))
            })
            .or_else(|| asset.mock_path.clone())
            .or_else(|| asset.mock_file_id.and_then(|id| lookup_file_path(db, id))),
    }
}

fn parse_stem_and_ext(path: &str) -> Option<(String, String)> {
    let file_name = Path::new(path).file_name()?.to_string_lossy();
    let dot = file_name.rfind('.')?;
    if dot == 0 {
        return None;
    }
    let stem = file_name[..dot].to_string();
    let ext = file_name[dot + 1..].to_ascii_lowercase();
    Some((stem, ext))
}

fn build_dataset_input_value(
    db: &BioVaultDb,
    assets: &[biovault::data::DatasetAssetRecord],
    data_type: &str,
    shape: &ShapeExpr,
) -> Result<(DatasetInputValue, usize), String> {
    match shape {
        ShapeExpr::File | ShapeExpr::Directory => {
            let path = assets
                .iter()
                .find_map(|asset| resolve_asset_path(db, asset, data_type))
                .ok_or_else(|| "No file found for dataset selection.".to_string())?;
            Ok((DatasetInputValue::Path(path), 1))
        }
        ShapeExpr::Record(fields) => {
            let mut field_lookup = HashMap::new();
            for field in fields {
                if !matches!(field.ty, ShapeExpr::File | ShapeExpr::Directory) {
                    return Err(format!(
                        "Unsupported record field type for '{}'. Only File/Directory are supported.",
                        field.name
                    ));
                }
                field_lookup.insert(field.name.to_ascii_lowercase(), field.name.clone());
            }

            let mut record_map = serde_json::Map::new();
            for asset in assets {
                let path = match resolve_asset_path(db, asset, data_type) {
                    Some(path) => path,
                    None => continue,
                };
                let (_, ext) = match parse_stem_and_ext(&path) {
                    Some(parts) => parts,
                    None => continue,
                };
                if let Some(field_name) = field_lookup.get(&ext) {
                    record_map.insert(field_name.clone(), serde_json::Value::String(path));
                }
            }

            if record_map.is_empty() {
                return Err("No matching files found for record-shaped dataset.".to_string());
            }

            for field_name in field_lookup.values() {
                if !record_map.contains_key(field_name) {
                    return Err(format!(
                        "Dataset is missing required field '{}'.",
                        field_name
                    ));
                }
            }

            Ok((
                DatasetInputValue::Json(serde_json::Value::Object(record_map)),
                field_lookup.len(),
            ))
        }
        ShapeExpr::Map(value) => match value.as_ref() {
            ShapeExpr::File | ShapeExpr::Directory => {
                let mut map = serde_json::Map::new();
                for asset in assets {
                    let path = match resolve_asset_path(db, asset, data_type) {
                        Some(path) => path,
                        None => continue,
                    };
                    let key = if !asset.asset_key.trim().is_empty() {
                        asset.asset_key.clone()
                    } else if let Some((stem, _)) = parse_stem_and_ext(&path) {
                        stem
                    } else {
                        asset.asset_uuid.clone()
                    };
                    if map.contains_key(&key) {
                        return Err(format!("Duplicate dataset asset key '{}'.", key));
                    }
                    map.insert(key, serde_json::Value::String(path));
                }
                if map.is_empty() {
                    return Err("No files found for dataset selection.".to_string());
                }
                let count = map.len();
                Ok((
                    DatasetInputValue::Json(serde_json::Value::Object(map)),
                    count,
                ))
            }
            ShapeExpr::Record(fields) => {
                let mut field_lookup = HashMap::new();
                for field in fields {
                    if !matches!(field.ty, ShapeExpr::File | ShapeExpr::Directory) {
                        return Err(format!(
                            "Unsupported record field type for '{}'. Only File/Directory are supported.",
                            field.name
                        ));
                    }
                    field_lookup.insert(field.name.to_ascii_lowercase(), field.name.clone());
                }

                let mut grouped: HashMap<String, HashMap<String, String>> = HashMap::new();
                for asset in assets {
                    let path = match resolve_asset_path(db, asset, data_type) {
                        Some(path) => path,
                        None => continue,
                    };
                    let (stem, ext) = match parse_stem_and_ext(&path) {
                        Some(parts) => parts,
                        None => continue,
                    };
                    let Some(field_name) = field_lookup.get(&ext) else {
                        continue;
                    };
                    grouped
                        .entry(stem)
                        .or_default()
                        .insert(field_name.clone(), path);
                }

                if grouped.is_empty() {
                    return Err("No matching files found for dataset selection.".to_string());
                }

                let mut outer = serde_json::Map::new();
                for (dataset_name, fields_map) in grouped {
                    for field_name in field_lookup.values() {
                        if !fields_map.contains_key(field_name) {
                            return Err(format!(
                                "Dataset '{}' is missing required field '{}'.",
                                dataset_name, field_name
                            ));
                        }
                    }
                    let mut inner = serde_json::Map::new();
                    for (field_name, path) in fields_map {
                        inner.insert(field_name, serde_json::Value::String(path));
                    }
                    outer.insert(dataset_name, serde_json::Value::Object(inner));
                }

                let file_count = field_lookup.len() * outer.len();
                Ok((
                    DatasetInputValue::Json(serde_json::Value::Object(outer)),
                    file_count,
                ))
            }
            _ => Err("Unsupported Map value type for dataset selection.".to_string()),
        },
        ShapeExpr::List(_) => {
            Err("List-shaped dataset selections should use URL selection.".to_string())
        }
        ShapeExpr::String | ShapeExpr::Bool | ShapeExpr::GenotypeRecord => {
            Err("Unsupported dataset shape for direct dataset selection.".to_string())
        }
    }
}

fn get_pipelines_dir() -> Result<PathBuf, String> {
    let home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    Ok(home.join("pipelines"))
}

fn get_projects_dir() -> Result<PathBuf, String> {
    let home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to get BioVault home: {}", e))?;
    Ok(home.join("projects"))
}

fn syftbox_storage_from_config(
    config: &biovault::config::Config,
) -> Result<SyftBoxStorage, String> {
    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to get SyftBox data dir: {}", e))?;
    Ok(SyftBoxStorage::new(&data_dir))
}

fn load_pipeline_spec_from_storage(
    storage: &SyftBoxStorage,
    path: &Path,
) -> Result<PipelineSpec, String> {
    let bytes = storage
        .read_with_shadow(path)
        .map_err(|e| format!("Failed to read flow.yaml: {}", e))?;
    let flow: FlowFile =
        serde_yaml::from_slice(&bytes).map_err(|e| format!("Failed to parse flow.yaml: {}", e))?;
    flow.to_pipeline_spec()
        .map_err(|e| format!("Failed to convert flow spec: {}", e))
}

fn append_pipeline_log(window: &tauri::WebviewWindow, log_path: &Path, message: &str) {
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
    let pipelines = biovault_db.list_pipelines().map_err(|e| e.to_string())?;

    for pipeline in &pipelines {
        match pipeline.spec.as_ref() {
            Some(spec) => {
                let input_types: Vec<String> = spec
                    .inputs
                    .iter()
                    .map(|(name, input)| format!("{}:{}", name, input.raw_type()))
                    .collect();
                crate::desktop_log!(
                    "Pipeline spec debug: '{}' inputs [{}] steps {}",
                    pipeline.name,
                    input_types.join(", "),
                    spec.steps.len()
                );
            }
            None => {
                crate::desktop_log!(
                    "Pipeline spec debug: '{}' missing spec (path: {})",
                    pipeline.name,
                    pipeline.pipeline_path
                );
            }
        }
    }

    Ok(pipelines)
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

    let is_import_dir = directory.is_some();
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

    let mut flow_yaml_path = pipeline_dir.join(FLOW_YAML_FILE);
    let mut imported_spec: Option<PipelineSpec> = None;

    // If importing from a file, always copy to managed directory (like GitHub imports)
    if let Some(pipeline_file_path) = pipeline_file {
        let source_flow_yaml_path = PathBuf::from(&pipeline_file_path);
        if !source_flow_yaml_path.exists() {
            return Err(format!(
                "Selected flow.yaml does not exist at {}",
                source_flow_yaml_path.display()
            ));
        }

        // Load flow spec from source
        let yaml_str = fs::read_to_string(&source_flow_yaml_path)
            .map_err(|e| format!("Failed to read flow.yaml: {}", e))?;
        let mut flow = FlowFile::parse_yaml(&yaml_str)
            .map_err(|e| format!("Failed to parse flow.yaml: {}", e))?;
        if flow.kind != "Flow" {
            return Err(format!("Expected Flow kind but found '{}'", flow.kind));
        }
        name = flow.metadata.name.clone();

        // Copy to managed directory (like GitHub imports do)
        let source_parent = source_flow_yaml_path.parent().ok_or_else(|| {
            format!(
                "Unable to determine parent directory for {}",
                source_flow_yaml_path.display()
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
        flow_yaml_path = managed_pipeline_dir.join(FLOW_YAML_FILE);

        // Resolve and import dependencies
        // Use spawn_blocking because BioVaultDb is not Send
        // base_path is the directory containing flow.yaml (where module.yaml might also be)
        let dependency_context = DependencyContext::Local {
            base_path: source_parent.to_path_buf(), // This is already the directory containing flow.yaml
        };
        let flow_yaml_path_clone = flow_yaml_path.clone();

        let flow_result = tauri::async_runtime::spawn_blocking(move || {
            tauri::async_runtime::block_on(async {
                resolve_pipeline_dependencies(
                    &mut flow,
                    &dependency_context,
                    &flow_yaml_path_clone,
                    overwrite,
                    true, // quiet = true for Tauri (no console output)
                )
                .await
                .map_err(|e| e.to_string())?;
                Ok::<FlowFile, String>(flow)
            })
        })
        .await
        .map_err(|e| format!("Failed to spawn dependency resolution: {}", e))?;

        let flow = flow_result.map_err(|e| format!("Failed to resolve dependencies: {}", e))?;
        let spec = flow
            .to_pipeline_spec()
            .map_err(|e| format!("Failed to convert flow spec: {}", e))?;

        // Note: resolve_pipeline_dependencies already saves the spec (with description preserved)
        imported_spec = Some(spec);
    } else {
        fs::create_dir_all(&pipeline_dir)
            .map_err(|e| format!("Failed to create pipeline directory: {}", e))?;

        crate::desktop_log!(
            "create_pipeline debug: name='{}' dir_present={} flow_yaml_exists={} overwrite={} path={}",
            name,
            is_import_dir,
            flow_yaml_path.exists(),
            overwrite,
            flow_yaml_path.display()
        );

        if flow_yaml_path.exists() {
            if is_import_dir {
                imported_spec = PipelineSpec::load(&flow_yaml_path).ok();
            } else if !overwrite {
                return Err(format!(
                    "flow.yaml already exists at {}",
                    flow_yaml_path.display()
                ));
            }
        } else if is_import_dir {
            return Err(format!("flow.yaml not found in {}", pipeline_dir.display()));
        }

        if !flow_yaml_path.exists() || (!is_import_dir && overwrite) {
            crate::desktop_log!(
                "create_pipeline debug: writing default flow.yaml to {}",
                flow_yaml_path.display()
            );
            let default_spec = PipelineSpec {
                name: name.clone(),
                description: None,
                context: None,
                inputs: Default::default(),
                steps: Vec::new(),
            };
            let flow = FlowFile::from_pipeline_spec(&default_spec)
                .map_err(|e| format!("Failed to build default flow spec: {}", e))?;
            let yaml = serde_yaml::to_string(&flow)
                .map_err(|e| format!("Failed to serialize flow.yaml: {}", e))?;
            fs::write(&flow_yaml_path, yaml)
                .map_err(|e| format!("Failed to write flow.yaml: {}", e))?;
        }
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

    let yaml_path = path.join(FLOW_YAML_FILE);

    // Load pipeline spec if file exists
    let spec = if yaml_path.exists() {
        let content = fs::read_to_string(&yaml_path)
            .map_err(|e| format!("Failed to read flow.yaml: {}", e))?;
        let flow = FlowFile::parse_yaml(&content).ok();
        flow.and_then(|f| f.to_pipeline_spec().ok())
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
    let yaml_path = path.join(FLOW_YAML_FILE);

    let flow = FlowFile::from_pipeline_spec(&spec)
        .map_err(|e| format!("Failed to convert pipeline spec to flow: {}", e))?;
    let yaml_content = serde_yaml::to_string(&flow)
        .map_err(|e| format!("Failed to serialize flow.yaml: {}", e))?;

    fs::write(&yaml_path, yaml_content).map_err(|e| format!("Failed to write flow.yaml: {}", e))?;

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

    let flow_path = PathBuf::from(&pipeline_path).join(FLOW_YAML_FILE);
    let target = if flow_path.exists() {
        flow_path.to_string_lossy().to_string()
    } else {
        pipeline_path
    };

    let mut cmd = ProcessCommand::new("bv");
    cmd.args(["pipeline", "validate", "--diagram", &target]);
    super::hide_console_window(&mut cmd);
    let output = cmd
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
    window: tauri::WebviewWindow,
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

    let yaml_path = PathBuf::from(&pipeline_path).join(FLOW_YAML_FILE);

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
                "🔍 Selection payload: files={} participants={} dataset={}",
                sel.file_ids.len(),
                sel.participant_ids.len(),
                sel.dataset_name
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("none")
            ),
        );
    } else {
        append_pipeline_log(&window, &log_path, "🔍 Selection payload: none provided");
    }

    if let Some(sel) = selection {
        let PipelineRunSelection {
            file_ids,
            urls,
            participant_ids,
            dataset_name,
            dataset_shape,
            dataset_data_type,
            dataset_owner,
            asset_keys,
            data_type,
            data_source,
        } = sel;

        // Filter empty strings
        let dataset_owner = dataset_owner.filter(|v| !v.trim().is_empty());
        let data_type_sel = data_type.filter(|v| !v.trim().is_empty());
        let data_source = data_source.filter(|v| !v.trim().is_empty());
        let asset_keys: Vec<String> = asset_keys
            .into_iter()
            .filter(|v| !v.trim().is_empty())
            .collect();

        let apply_selection_context = |selection: &mut serde_json::Value| {
            if let Some(map) = selection.as_object_mut() {
                if let Some(value) = dataset_owner.clone() {
                    map.insert("dataset_owner".to_string(), serde_json::json!(value));
                }
                if !asset_keys.is_empty() {
                    map.insert(
                        "asset_keys".to_string(),
                        serde_json::json!(asset_keys.clone()),
                    );
                }
                if let Some(value) = data_type_sel.clone() {
                    map.insert("data_type".to_string(), serde_json::json!(value));
                }
                if let Some(value) = data_source.clone() {
                    map.insert("data_source".to_string(), serde_json::json!(value));
                }
            }
        };

        // Prefer URLs over file_ids (URLs are the new way, file_ids are legacy)
        let use_urls = !urls.is_empty();
        let use_file_ids = !file_ids.is_empty() && !use_urls;
        let dataset_name = dataset_name.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });
        let mut dataset_handled = false;

        // For network datasets (from other users), skip local DB lookup and use URLs directly
        let is_network_dataset = data_source.as_deref() == Some("network_dataset");

        // When dataset_name is provided, try the dataset path first (regardless of URLs/file_ids)
        // This properly handles Map/Record-shaped datasets like GWAS (Map[String, Record{bed, bim, fam}])
        // Skip for network datasets which don't exist in local DB
        if let Some(dataset_name) = dataset_name.clone() {
            if is_network_dataset {
                eprintln!(
                    "[pipeline] Skipping local DB lookup for network dataset '{}', using URLs instead",
                    dataset_name
                );
            } else {
                let data_type = dataset_data_type
                    .clone()
                    .unwrap_or_else(|| "mock".to_string());
                let (dataset_record, dataset_assets) =
                    biovault::data::get_dataset_with_assets(&biovault_db, &dataset_name)
                        .map_err(|e| format!("Failed to load dataset '{}': {}", dataset_name, e))?
                        .ok_or_else(|| format!("Dataset '{}' not found", dataset_name))?;

                let manifest =
                    biovault::data::build_manifest_from_db(&dataset_record, &dataset_assets);
                let shape = dataset_shape
                    .clone()
                    .and_then(|value| {
                        let trimmed = value.trim();
                        if trimmed.is_empty() {
                            None
                        } else {
                            Some(trimmed.to_string())
                        }
                    })
                    .or_else(|| biovault::cli::commands::datasets::infer_dataset_shape(&manifest))
                    .ok_or_else(|| {
                        format!(
                            "Dataset '{}' does not declare a shape and none could be inferred.",
                            dataset_name
                        )
                    })?;

                let shape_expr = parse_shape_expr(&shape).ok_or_else(|| {
                    format!("Unsupported dataset shape '{}' for selection.", shape)
                })?;

                // List-shaped datasets need URL selection, fall through to URL/file_id paths
                if let ShapeExpr::List(inner_type) = &shape_expr {
                    eprintln!(
                    "[pipeline] Dataset '{}' has List shape (item type: {:?}), using URL selection path",
                    dataset_name, inner_type
                );
                } else {
                    let spec = PipelineSpec::load(&yaml_path)
                        .map_err(|e| format!("Failed to load pipeline spec: {}", e))?;
                    let input_name = spec
                        .inputs
                        .iter()
                        .find(|(_, input_spec)| {
                            biovault::project_spec::types_compatible(&shape, input_spec.raw_type())
                        })
                        .map(|(name, _)| name.clone())
                        .ok_or_else(|| {
                            format!(
                                "Pipeline does not declare an input compatible with '{}'",
                                shape
                            )
                        })?;

                    let (dataset_value, file_count) = build_dataset_input_value(
                        &biovault_db,
                        &dataset_assets,
                        &data_type,
                        &shape_expr,
                    )?;

                    let dataset_count = match &shape_expr {
                        ShapeExpr::Map(_) => match &dataset_value {
                            DatasetInputValue::Json(serde_json::Value::Object(map)) => map.len(),
                            _ => 0,
                        },
                        ShapeExpr::Record(_) | ShapeExpr::File | ShapeExpr::Directory => 1,
                        _ => 0,
                    };

                    let input_path = match dataset_value {
                        DatasetInputValue::Path(path) => path,
                        DatasetInputValue::Json(value) => {
                            let inputs_dir = results_path.join("inputs");
                            fs::create_dir_all(&inputs_dir).map_err(|e| {
                                format!("Failed to prepare inputs directory for dataset: {}", e)
                            })?;
                            let dataset_path =
                                inputs_dir.join(format!("{}_input.json", input_name));
                            let payload = serde_json::to_string_pretty(&value)
                                .map_err(|e| format!("Failed to serialize dataset map: {}", e))?;
                            fs::write(&dataset_path, payload)
                                .map_err(|e| format!("Failed to write dataset map: {}", e))?;
                            dataset_path.to_string_lossy().to_string()
                        }
                    };

                    input_overrides.insert(format!("inputs.{}", input_name), input_path.clone());

                    selection_counts = Some((file_count, dataset_count));

                    selection_metadata = Some(serde_json::json!({
                        "dataset_name": dataset_name,
                        "dataset_shape": shape,
                        "dataset_data_type": data_type,
                        "dataset_input": input_name,
                        "dataset_input_path": input_path,
                        "dataset_count": dataset_count,
                        "file_count": file_count,
                    }));

                    dataset_handled = true;
                }
                // If List-shaped, fall through to URL/file_id handling below
            }
        }

        if dataset_handled {
            // dataset selection handled, skip legacy flows
        } else if use_urls {
            // Resolve syft:// URLs to local paths
            let config = biovault::config::Config::load()
                .map_err(|e| format!("Failed to load config: {}", e))?;
            let data_dir = config
                .get_syftbox_data_dir()
                .map_err(|e| format!("Failed to get SyftBox data dir: {}", e))?;

            let mut seen_urls = HashSet::new();
            let mut unique_urls = Vec::new();
            for url in urls {
                if seen_urls.insert(url.clone()) {
                    unique_urls.push(url);
                }
            }

            if unique_urls.is_empty() {
                return Err("No valid URLs were provided for the pipeline run.".to_string());
            }

            let mut rows = Vec::new();
            let mut participant_labels_set: HashSet<String> = HashSet::new();
            let mut resolved_count = 0;

            for (idx, url) in unique_urls.iter().enumerate() {
                let local_path = biovault::data::resolve_syft_url(&data_dir, url)
                    .map_err(|e| format!("Failed to resolve URL '{}': {}", url, e))?;

                if !local_path.exists() {
                    append_pipeline_log(
                        &window,
                        &log_path,
                        &format!("⚠️  File not found for URL: {} -> {:?}", url, local_path),
                    );
                    continue;
                }

                resolved_count += 1;
                let file_path = local_path.to_string_lossy().to_string();

                // Use participant_id from selection if provided, otherwise extract from filename
                let participant = if idx < participant_ids.len() && !participant_ids[idx].is_empty()
                {
                    participant_ids[idx].clone()
                } else {
                    local_path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("unknown")
                        .to_string()
                };

                participant_labels_set.insert(participant.clone());
                rows.push((participant, file_path));
            }

            if rows.is_empty() {
                return Err("No files could be resolved from the provided URLs.".to_string());
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
            selection_counts = Some((resolved_count, participant_total));

            input_overrides.insert(
                "inputs.samplesheet".to_string(),
                sheet_path.to_string_lossy().to_string(),
            );

            generated_samplesheet_path = Some(sheet_path.to_string_lossy().to_string());

            let file_paths: Vec<String> = rows.iter().map(|(_, path)| path.clone()).collect();
            let mut selection_value = serde_json::json!({
                "urls": unique_urls,
                "participant_ids": participant_ids,
                "participant_labels": participant_labels,
                "samplesheet_path": sheet_path.to_string_lossy(),
                "participant_count": participant_total,
                "file_paths": file_paths,
            });
            apply_selection_context(&mut selection_value);
            selection_metadata = Some(selection_value);
        } else if use_file_ids {
            // Legacy: use file_ids (deprecated)
            let mut seen_files = HashSet::new();
            let mut unique_file_ids = Vec::new();
            for id in file_ids {
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

            let dedup_participant_ids: Vec<String> = {
                let mut seen = HashSet::new();
                participant_ids
                    .into_iter()
                    .filter(|id| seen.insert(id.clone()))
                    .collect()
            };

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
            let file_paths: Vec<String> = rows.iter().map(|(_, path)| path.clone()).collect();
            let mut selection_value = serde_json::json!({
                "file_ids": unique_file_ids,
                "participant_ids": dedup_participant_ids,
                "participant_labels": participant_labels,
                "samplesheet_path": sheet_path.to_string_lossy(),
                "participant_count": participant_count,
                "file_paths": file_paths,
            });
            apply_selection_context(&mut selection_value);
            selection_metadata = Some(selection_value);
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
    for (key, value) in &input_overrides {
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
        append_pipeline_log(
            &window_clone,
            &log_path_clone,
            &format!("📄 Pipeline YAML: {}", yaml_path_spawn),
        );
        append_pipeline_log(
            &window_clone,
            &log_path_clone,
            &format!("📂 Results dir: {}", results_dir_spawn),
        );
        append_pipeline_log(
            &window_clone,
            &log_path_clone,
            &format!("🔧 Extra args: {:?}", extra_args_spawn),
        );

        // Call CLI library function directly
        let result = cli_run_pipeline(
            &yaml_path_spawn,
            extra_args_spawn.clone(),
            false, // dry_run
            false, // resume
            Some(results_dir_spawn.clone()),
        )
        .await;

        let status = match &result {
            Err(err) => {
                append_pipeline_log(
                    &window_clone,
                    &log_path_clone,
                    &format!("❌ Pipeline run failed: {}", err),
                );
                "failed"
            }
            Ok(()) => {
                append_pipeline_log(
                    &window_clone,
                    &log_path_clone,
                    "✅ Pipeline run completed successfully",
                );
                "success"
            }
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
    let flow = FlowFile::from_pipeline_spec(&spec)
        .map_err(|e| format!("Failed to convert pipeline preview: {}", e))?;
    serde_yaml::to_string(&flow).map_err(|e| format!("Failed to generate flow preview: {}", e))
}

/// Import a pipeline from a message (received via pipeline request)
#[tauri::command]
pub async fn import_pipeline_from_message(
    state: tauri::State<'_, AppState>,
    name: String,
    _version: String,
    spec: serde_json::Value,
) -> Result<i64, String> {
    let pipelines_dir = get_pipelines_dir()?;
    let pipeline_dir = pipelines_dir.join(&name);

    // Check if pipeline already exists
    if pipeline_dir.exists() {
        // For now, we'll overwrite - in the future could prompt user
        // or rename with version suffix
        fs::remove_dir_all(&pipeline_dir)
            .map_err(|e| format!("Failed to remove existing pipeline: {}", e))?;
    }

    // Create pipeline directory
    fs::create_dir_all(&pipeline_dir)
        .map_err(|e| format!("Failed to create pipeline directory: {}", e))?;

    let flow: FlowFile = serde_json::from_value(spec)
        .map_err(|e| format!("Failed to parse flow spec from message: {}", e))?;
    let yaml_content = serde_yaml::to_string(&flow)
        .map_err(|e| format!("Failed to convert flow spec to YAML: {}", e))?;

    let flow_yaml_path = pipeline_dir.join(FLOW_YAML_FILE);
    fs::write(&flow_yaml_path, &yaml_content)
        .map_err(|e| format!("Failed to write flow.yaml: {}", e))?;

    // Register in database
    let db = state.biovault_db.lock().map_err(|e| e.to_string())?;
    let pipeline_dir_str = pipeline_dir.to_string_lossy().to_string();

    // Check if pipeline with same name exists in DB - delete then re-register
    let existing = db.list_pipelines().map_err(|e| e.to_string())?;
    if let Some(existing_pipeline) = existing.iter().find(|p| p.name == name) {
        db.delete_pipeline(existing_pipeline.id)
            .map_err(|e| format!("Failed to remove existing pipeline from database: {}", e))?;
    }

    // Register pipeline
    let pipeline_id = db
        .register_pipeline(&name, &pipeline_dir_str)
        .map_err(|e| format!("Failed to register pipeline in database: {}", e))?;

    Ok(pipeline_id)
}

fn should_skip_request_path(rel: &Path) -> bool {
    if rel
        .file_name()
        .map(|n| n == "syft.pub.yaml")
        .unwrap_or(false)
    {
        return true;
    }

    let skip_dirs = [
        ".git",
        ".nextflow",
        ".venv",
        "__pycache__",
        "node_modules",
        "target",
        "work",
        "results",
        "runs",
    ];

    rel.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|name| skip_dirs.iter().any(|skip| skip == &name))
    })
}

fn copy_pipeline_request_dir(
    storage: &SyftBoxStorage,
    src: &Path,
    dest: &Path,
) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("Failed to create destination: {}", e))?;

    for entry in WalkDir::new(src)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        let rel = path
            .strip_prefix(src)
            .map_err(|e| format!("Failed to resolve path: {}", e))?;

        if should_skip_request_path(rel) {
            continue;
        }

        let dest_path = dest.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&dest_path).map_err(|e| {
                format!("Failed to create directory {}: {}", dest_path.display(), e)
            })?;
            continue;
        }

        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;
        }

        let bytes = storage
            .read_with_shadow(path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
        fs::write(&dest_path, &bytes)
            .map_err(|e| format!("Failed to write {}: {}", dest_path.display(), e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn import_pipeline_from_request(
    state: tauri::State<'_, AppState>,
    name: Option<String>,
    pipeline_location: String,
    overwrite: bool,
) -> Result<Pipeline, String> {
    let config =
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;
    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to get SyftBox data dir: {}", e))?;
    let storage = syftbox_storage_from_config(&config)?;

    let source_root = biovault::data::resolve_syft_url(&data_dir, &pipeline_location)
        .map_err(|e| format!("Failed to resolve pipeline location: {}", e))?;
    if !source_root.exists() {
        return Err(format!(
            "Pipeline source folder not found at {}",
            source_root.display()
        ));
    }

    let flow_yaml = source_root.join(FLOW_YAML_FILE);
    if !flow_yaml.exists() {
        return Err(format!("flow.yaml not found in {}", source_root.display()));
    }

    let spec = load_pipeline_spec_from_storage(&storage, &flow_yaml)?;
    let resolved_name = name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or(spec.name.clone());

    let pipelines_dir = get_pipelines_dir()?;
    fs::create_dir_all(&pipelines_dir)
        .map_err(|e| format!("Failed to create pipelines directory: {}", e))?;

    let dest_dir = pipelines_dir.join(&resolved_name);
    if dest_dir.exists() {
        if overwrite {
            fs::remove_dir_all(&dest_dir)
                .map_err(|e| format!("Failed to remove existing pipeline: {}", e))?;
        } else {
            return Err(format!(
                "Pipeline '{}' already exists at {}. Use overwrite to replace.",
                resolved_name,
                dest_dir.display()
            ));
        }
    }

    copy_pipeline_request_dir(&storage, &source_root, &dest_dir)?;

    let projects_source = source_root.join("projects");
    if projects_source.exists() {
        let projects_dir = get_projects_dir()?;
        fs::create_dir_all(&projects_dir)
            .map_err(|e| format!("Failed to create projects directory: {}", e))?;

        for entry in fs::read_dir(&projects_source)
            .map_err(|e| format!("Failed to read projects folder: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read project entry: {}", e))?;
            let entry_path = entry.path();
            if !entry_path.is_dir() {
                continue;
            }

            let project_dir_name = entry.file_name().to_string_lossy().to_string();
            let dest_project_dir = projects_dir.join(&project_dir_name);

            if dest_project_dir.exists() {
                if overwrite {
                    fs::remove_dir_all(&dest_project_dir).map_err(|e| {
                        format!(
                            "Failed to remove existing project directory {}: {}",
                            dest_project_dir.display(),
                            e
                        )
                    })?;
                } else {
                    continue;
                }
            }

            copy_pipeline_request_dir(&storage, &entry_path, &dest_project_dir)?;

            let module_yaml_path = dest_project_dir.join("module.yaml");
            if !module_yaml_path.exists() {
                continue;
            }

            let yaml_content = fs::read_to_string(&module_yaml_path).map_err(|e| {
                format!(
                    "Failed to read module.yaml at {}: {}",
                    module_yaml_path.display(),
                    e
                )
            })?;
            let module = ModuleFile::parse_yaml(&yaml_content).map_err(|e| {
                format!(
                    "Failed to parse module.yaml at {}: {}",
                    module_yaml_path.display(),
                    e
                )
            })?;
            let project_yaml = module.to_project_spec().map_err(|e| {
                format!(
                    "Failed to convert module.yaml at {}: {}",
                    module_yaml_path.display(),
                    e
                )
            })?;

            let identifier = format!(
                "{}@{}",
                project_yaml.name,
                project_yaml
                    .version
                    .clone()
                    .unwrap_or_else(|| "0.1.0".to_string())
            );
            let db = state.biovault_db.lock().map_err(|e| e.to_string())?;

            if overwrite {
                if db
                    .get_project(&identifier)
                    .map_err(|e| e.to_string())?
                    .is_some()
                {
                    db.update_project(
                        &project_yaml.name,
                        project_yaml.version.as_deref().unwrap_or("0.1.0"),
                        &project_yaml.author,
                        &project_yaml.workflow,
                        project_yaml.template.as_deref().unwrap_or("imported"),
                        &dest_project_dir,
                    )
                    .map_err(|e| e.to_string())?;
                } else {
                    db.register_project(
                        &project_yaml.name,
                        project_yaml.version.as_deref().unwrap_or("0.1.0"),
                        &project_yaml.author,
                        &project_yaml.workflow,
                        project_yaml.template.as_deref().unwrap_or("imported"),
                        &dest_project_dir,
                    )
                    .map_err(|e| e.to_string())?;
                }
            } else if db
                .get_project(&identifier)
                .map_err(|e| e.to_string())?
                .is_none()
            {
                db.register_project(
                    &project_yaml.name,
                    project_yaml.version.as_deref().unwrap_or("0.1.0"),
                    &project_yaml.author,
                    &project_yaml.workflow,
                    project_yaml.template.as_deref().unwrap_or("imported"),
                    &dest_project_dir,
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }

    let pipeline_dir_str = dest_dir.to_string_lossy().to_string();
    let biovault_db = state.biovault_db.lock().map_err(|e| e.to_string())?;

    if overwrite {
        let existing = biovault_db
            .list_pipelines()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|p| p.name == resolved_name || p.pipeline_path == pipeline_dir_str);
        if let Some(existing_pipeline) = existing {
            biovault_db
                .delete_pipeline(existing_pipeline.id)
                .map_err(|e| e.to_string())?;
        }
    }

    let id = biovault_db
        .register_pipeline(&resolved_name, &pipeline_dir_str)
        .map_err(|e| e.to_string())?;

    let timestamp = chrono::Local::now().to_rfc3339();

    Ok(Pipeline {
        id,
        name: resolved_name,
        pipeline_path: pipeline_dir_str,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        spec: Some(spec),
    })
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
