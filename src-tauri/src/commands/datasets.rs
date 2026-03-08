use crate::types::AppState;
use biovault::data::datasets::{analyze_dataset_asset_paths, build_manifest_from_db, get_dataset_with_assets, summarize_dataset_asset_paths};
use biovault::data::BioVaultDb;
use biovault::cli::commands::datasets::infer_dataset_shape;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_yaml;
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::path::{Path, PathBuf};
use uuid::Uuid;

fn load_config_best_effort() -> biovault::config::Config {
    if let Ok(cfg) = biovault::config::Config::load() {
        return cfg;
    }

    // UI can legitimately call dataset/network scans before `bv init` has been run.
    // Use SyftBox's config (present in devstack) to discover the current identity.
    let fallback = biovault::config::Config::new(String::new());
    let syftbox_email = fallback
        .get_syftbox_config_path()
        .ok()
        .and_then(|path| syftbox_sdk::syftbox::config::SyftBoxConfigFile::load(&path).ok())
        .map(|cfg| cfg.email)
        .unwrap_or_default();

    let trimmed = syftbox_email.trim();
    if trimmed.is_empty() {
        fallback
    } else {
        biovault::config::Config::new(trimmed.to_string())
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct DatasetSaveResult {
    pub dataset_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct UiDatasetAssetInput {
    pub name: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub mock_path: String,
    #[serde(default)]
    pub mock_url: String,
    #[serde(default)]
    pub file_type: String,
    #[serde(default)]
    pub participant_id: String,
    #[serde(default)]
    pub file_role: String,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
pub struct SaveDatasetFromUiRequest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub enabled_columns: Vec<String>,
    #[serde(default)]
    pub custom_columns: Vec<String>,
    #[serde(default)]
    pub assets: Vec<UiDatasetAssetInput>,
    #[serde(default)]
    pub original_name: Option<String>,
}

fn is_url_like(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("syft://")
}

fn non_empty_trimmed(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn ui_asset_metadata_value<'a>(asset: &'a UiDatasetAssetInput, key: &str) -> Option<&'a str> {
    asset.metadata.get(key).map(|value| value.as_str()).filter(|value| !value.trim().is_empty())
}

fn ui_asset_group(asset: &UiDatasetAssetInput) -> Option<String> {
    match (
        ui_asset_metadata_value(asset, "__asset_structure"),
        ui_asset_metadata_value(asset, "__asset_group"),
    ) {
        (Some("twin_list"), Some(group)) if !group.trim().is_empty() => Some(group.trim().to_string()),
        _ => None,
    }
}

fn validate_ui_dataset_assets(assets: &[UiDatasetAssetInput]) -> Result<(), String> {
    let mut seen_names = BTreeSet::new();
    let mut private_paths = BTreeSet::new();
    let mut mock_paths = BTreeSet::new();

    for asset in assets {
        let name = asset.name.trim();
        if name.is_empty() {
            continue;
        }

        if ui_asset_group(asset).is_some() {
            continue;
        }

        if !seen_names.insert(name.to_string()) {
            return Err(format!("Duplicate asset name '{}' is not allowed", name));
        }

        if let Some(path) = non_empty_trimmed(&asset.path) {
            private_paths.insert(path);
        }

        if let Some(path) = non_empty_trimmed(&asset.mock_path) {
            mock_paths.insert(path);
        }
    }

    let overlaps: Vec<String> = private_paths.intersection(&mock_paths).cloned().collect();
    if !overlaps.is_empty() {
        let preview = overlaps.into_iter().take(5).collect::<Vec<_>>().join(", ");
        return Err(format!(
            "The same file is being used as both private and mock data: {}",
            preview
        ));
    }

    Ok(())
}

fn build_twin_list_asset(
    asset_key: String,
    rows: Vec<UiDatasetAssetInput>,
    dataset_name: &str,
    email: &str,
) -> biovault::cli::commands::datasets::DatasetAsset {
    let mut group_extra = BTreeMap::new();
    let mut private_entries = Vec::new();
    let mut mock_entries = Vec::new();

    for row in rows {
        let mut entry_extra: BTreeMap<String, String> = row
            .metadata
            .into_iter()
            .filter(|(key, _)| !key.starts_with("__"))
            .collect();
        let entry_name = row.name.trim().to_string();
        if !entry_name.is_empty() {
            entry_extra.insert("entry_name".to_string(), entry_name.clone());
        }
        if !row.file_type.trim().is_empty() {
            entry_extra.insert("file_type".to_string(), row.file_type.trim().to_string());
        }
        if !row.file_role.trim().is_empty() {
            entry_extra.insert("file_role".to_string(), row.file_role.trim().to_string());
        }

        if !row.path.trim().is_empty() {
            let mut entry = serde_yaml::Mapping::new();
            entry.insert(
                serde_yaml::Value::String("id".to_string()),
                serde_yaml::Value::String(Uuid::new_v4().to_string()),
            );
            entry.insert(
                serde_yaml::Value::String("file_path".to_string()),
                serde_yaml::Value::String(row.path.trim().to_string()),
            );
            if !row.participant_id.trim().is_empty() {
                entry.insert(
                    serde_yaml::Value::String("participant_id".to_string()),
                    serde_yaml::Value::String(row.participant_id.trim().to_string()),
                );
            }
            for (key, value) in &entry_extra {
                entry.insert(
                    serde_yaml::Value::String(key.clone()),
                    serde_yaml::Value::String(value.clone()),
                );
            }
            private_entries.push(serde_yaml::Value::Mapping(entry));
        }

        let mock_url = non_empty_trimmed(&row.mock_url);
        let mock_path = non_empty_trimmed(&row.mock_path);
        if let Some(url_or_path) = mock_url.clone().or(mock_path.clone()) {
            let is_url = is_url_like(&url_or_path);
            let resolved_url = if is_url {
                url_or_path.clone()
            } else {
                let filename = Path::new(&url_or_path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("mock.dat");
                format!(
                    "syft://{}/public/biovault/datasets/{}/assets/{}",
                    email, dataset_name, filename
                )
            };

            let mut entry = serde_yaml::Mapping::new();
            entry.insert(
                serde_yaml::Value::String("id".to_string()),
                serde_yaml::Value::String(Uuid::new_v4().to_string()),
            );
            entry.insert(
                serde_yaml::Value::String("url".to_string()),
                serde_yaml::Value::String(resolved_url),
            );
            if !row.participant_id.trim().is_empty() {
                entry.insert(
                    serde_yaml::Value::String("participant_id".to_string()),
                    serde_yaml::Value::String(row.participant_id.trim().to_string()),
                );
            }
            if !is_url {
                entry.insert(
                    serde_yaml::Value::String("source_path".to_string()),
                    serde_yaml::Value::String(url_or_path),
                );
            }
            for (key, value) in &entry_extra {
                entry.insert(
                    serde_yaml::Value::String(key.clone()),
                    serde_yaml::Value::String(value.clone()),
                );
            }
            mock_entries.push(serde_yaml::Value::Mapping(entry));
        }

        if group_extra.is_empty() {
            if !row.file_type.trim().is_empty() {
                group_extra.insert(
                    "file_type".to_string(),
                    serde_yaml::Value::String(row.file_type.trim().to_string()),
                );
            }
            group_extra.insert(
                "__asset_structure".to_string(),
                serde_yaml::Value::String("twin_list".to_string()),
            );
        }
    }

    let mock_csv_url = format!(
        "syft://{}/public/biovault/datasets/{}/assets/{}.csv",
        email, dataset_name, asset_key
    );

    let private_value = (!private_entries.is_empty()).then(|| {
        serde_yaml::Value::Mapping(serde_yaml::Mapping::from_iter([
            (
                serde_yaml::Value::String("url".to_string()),
                serde_yaml::Value::String(format!("{{root.private_url}}#assets.{}.private", asset_key)),
            ),
            (
                serde_yaml::Value::String("type".to_string()),
                serde_yaml::Value::String("twin_list".to_string()),
            ),
            (
                serde_yaml::Value::String("entries".to_string()),
                serde_yaml::Value::Sequence(private_entries.clone()),
            ),
        ]))
    });

    let mock_value = (!mock_entries.is_empty()).then(|| {
        serde_yaml::Value::Mapping(serde_yaml::Mapping::from_iter([
            (
                serde_yaml::Value::String("url".to_string()),
                serde_yaml::Value::String(mock_csv_url.clone()),
            ),
            (
                serde_yaml::Value::String("type".to_string()),
                serde_yaml::Value::String("twin_list".to_string()),
            ),
            (
                serde_yaml::Value::String("entries".to_string()),
                serde_yaml::Value::Sequence(mock_entries),
            ),
        ]))
    });

    biovault::cli::commands::datasets::DatasetAsset {
        kind: Some("twin_list".to_string()),
        url: Some(mock_csv_url),
        private: private_value,
        mock: mock_value,
        mappings: Some(biovault::cli::commands::datasets::DatasetAssetMapping {
            private: (!private_entries.is_empty()).then_some(
                biovault::cli::commands::datasets::DatasetAssetMappingEndpoint {
                    file_path: None,
                    db_file_id: None,
                    entries: Some(private_entries),
                },
            ),
            mock: None,
        }),
        extra: group_extra,
        ..Default::default()
    }
}

fn infer_ui_dataset_shape(assets: &[UiDatasetAssetInput]) -> Option<String> {
    let primary_assets: Vec<&UiDatasetAssetInput> = assets
        .iter()
        .filter(|asset| {
            let role = asset.file_role.trim().to_ascii_lowercase();
            role.is_empty() || role == "primary"
        })
        .filter(|asset| !asset.path.trim().is_empty())
        .collect();

    if primary_assets.is_empty() {
        return None;
    }

    let all_have_participant = primary_assets
        .iter()
        .all(|asset| !asset.participant_id.trim().is_empty());
    if !all_have_participant {
        return None;
    }

    let aligned = primary_assets
        .iter()
        .all(|asset| asset.file_type.trim() == "Aligned Reads");
    if aligned {
        let has_aligned_index = primary_assets
            .iter()
            .any(|asset| ui_asset_metadata_value(asset, "aligned_index").is_some());
        let has_reference = primary_assets
            .iter()
            .any(|asset| ui_asset_metadata_value(asset, "reference_file").is_some());
        let has_reference_index = primary_assets
            .iter()
            .any(|asset| ui_asset_metadata_value(asset, "reference_index").is_some());
        let has_ref_version = primary_assets
            .iter()
            .any(|asset| ui_asset_metadata_value(asset, "ref_version").is_some());

        let mut fields = vec![
            "participant_id: String".to_string(),
            "aligned_file: File".to_string(),
        ];
        if has_aligned_index {
            fields.push("aligned_index: File?".to_string());
        }
        if has_reference {
            fields.push("reference_file: File?".to_string());
        }
        if has_reference_index {
            fields.push("reference_index: File?".to_string());
        }
        if has_ref_version {
            fields.push("ref_version: String?".to_string());
        }
        return Some(format!("List[Record{{{}}}]", fields.join(", ")));
    }

    let variants = primary_assets
        .iter()
        .all(|asset| asset.file_type.trim() == "Variants");
    if variants {
        let has_variant_index = primary_assets
            .iter()
            .any(|asset| ui_asset_metadata_value(asset, "vcf_index").is_some());
        let has_reference = primary_assets
            .iter()
            .any(|asset| ui_asset_metadata_value(asset, "reference_file").is_some());
        let has_reference_index = primary_assets
            .iter()
            .any(|asset| ui_asset_metadata_value(asset, "reference_index").is_some());
        let has_ref_version = primary_assets
            .iter()
            .any(|asset| ui_asset_metadata_value(asset, "ref_version").is_some());

        let mut fields = vec![
            "participant_id: String".to_string(),
            "vcf_file: File".to_string(),
        ];
        if has_variant_index {
            fields.push("vcf_index: File?".to_string());
        }
        if has_reference {
            fields.push("reference_file: File?".to_string());
        }
        if has_reference_index {
            fields.push("reference_index: File?".to_string());
        }
        if has_ref_version {
            fields.push("ref_version: String?".to_string());
        }
        return Some(format!("List[Record{{{}}}]", fields.join(", ")));
    }

    let reads = primary_assets.iter().all(|asset| asset.file_type.trim() == "Reads");
    if reads {
        let has_read_pair = primary_assets
            .iter()
            .any(|asset| ui_asset_metadata_value(asset, "read_pair").is_some());
        let has_lane = primary_assets
            .iter()
            .any(|asset| ui_asset_metadata_value(asset, "lane").is_some());

        let mut fields = vec![
            "participant_id: String".to_string(),
            "read_file: File".to_string(),
        ];
        if has_read_pair {
            fields.push("read_pair: String?".to_string());
        }
        if has_lane {
            fields.push("lane: String?".to_string());
        }
        return Some(format!("List[Record{{{}}}]", fields.join(", ")));
    }

    None
}

#[derive(Serialize)]
pub struct DatasetWithAssets {
    pub dataset: Dataset,
    pub assets: Vec<DatasetAsset>,
}

#[derive(Serialize)]
pub struct Dataset {
    pub id: i64,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: Option<String>,
    pub schema: String,
    pub public_url: Option<String>,
    pub private_url: Option<String>,
    pub http_relay_servers: Vec<String>,
    pub extra: serde_json::Value,
}

#[derive(Serialize)]
pub struct DatasetAsset {
    pub asset_key: String,
    pub asset_uuid: String,
    pub kind: String,
    pub url: String,
    pub private_ref: Option<String>,
    pub mock_ref: Option<String>,
    pub private_file_id: Option<i64>,
    pub mock_file_id: Option<i64>,
    pub private_path: Option<String>,
    pub mock_path: Option<String>,
    pub resolved_private_path: Option<String>,
    pub resolved_mock_path: Option<String>,
    pub extra: serde_json::Value,
}

#[derive(Serialize)]
pub struct DerivedDatasetAsset {
    pub path: String,
    pub asset_name: String,
    pub file_type: String,
    pub participant_id: String,
    pub file_role: String,
    pub derived_fields: std::collections::BTreeMap<String, String>,
}

#[derive(Serialize)]
pub struct DerivedDatasetAssetSummary {
    pub assets: Vec<DerivedDatasetAsset>,
    pub suggested_columns: Vec<String>,
}

#[derive(Serialize)]
pub struct DatasetProcessingAction {
    pub key: String,
    pub label: String,
    pub description: String,
}

#[derive(Serialize)]
pub struct DatasetProcessingSummary {
    pub participant_count: usize,
    pub primary_asset_count: usize,
    pub reference_count: usize,
    pub index_count: usize,
    pub warnings: Vec<String>,
    pub suggested_actions: Vec<DatasetProcessingAction>,
}

#[tauri::command]
pub fn list_datasets_with_assets(
    state: tauri::State<AppState>,
) -> Result<Vec<DatasetWithAssets>, String> {
    let db = state.biovault_db.lock().unwrap();
    let rows = biovault::data::list_datasets_with_assets(&db)
        .map_err(|e| format!("Failed to list datasets: {}", e))?;

    let mut out = Vec::with_capacity(rows.len());
    for (ds, assets) in rows {
        // Resolve file paths for linked file IDs so UI can prefill local paths
        let mut resolved_assets = Vec::with_capacity(assets.len());
        for a in assets {
            let resolved_private_path = if let Some(fid) = a.private_file_id {
                db.conn
                    .query_row("SELECT file_path FROM files WHERE id = ?1", [fid], |row| {
                        row.get(0)
                    })
                    .ok()
            } else {
                a.private_path.clone()
            };

            let resolved_mock_path = if let Some(fid) = a.mock_file_id {
                db.conn
                    .query_row("SELECT file_path FROM files WHERE id = ?1", [fid], |row| {
                        row.get(0)
                    })
                    .ok()
            } else {
                a.mock_path.clone()
            };

            resolved_assets.push(DatasetAsset {
                asset_key: a.asset_key,
                asset_uuid: a.asset_uuid,
                kind: a.kind,
                url: a.url,
                private_ref: a.private_ref,
                mock_ref: a.mock_ref,
                private_file_id: a.private_file_id,
                mock_file_id: a.mock_file_id,
                private_path: a.private_path,
                mock_path: a.mock_path,
                resolved_private_path,
                resolved_mock_path,
                extra: a.extra,
            });
        }

        out.push(DatasetWithAssets {
            dataset: Dataset {
                id: ds.id,
                name: ds.name,
                version: ds.version,
                author: ds.author,
                description: ds.description,
                schema: ds.schema,
                public_url: ds.public_url,
                private_url: ds.private_url,
                http_relay_servers: ds.http_relay_servers,
                extra: ds.extra,
            },
            assets: resolved_assets,
        });
    }

    Ok(out)
}

#[tauri::command]
pub fn analyze_dataset_assets(paths: Vec<String>) -> Result<Vec<DerivedDatasetAsset>, String> {
    Ok(analyze_dataset_asset_paths(&paths)
        .into_iter()
        .map(|analysis| DerivedDatasetAsset {
            path: analysis.path,
            asset_name: analysis.asset_name,
            file_type: analysis.file_type,
            participant_id: analysis.participant_id,
            file_role: analysis.file_role,
            derived_fields: analysis.derived_fields,
        })
        .collect())
}

#[tauri::command]
pub fn analyze_dataset_assets_summary(paths: Vec<String>) -> Result<DerivedDatasetAssetSummary, String> {
    let summary = summarize_dataset_asset_paths(&paths);
    Ok(DerivedDatasetAssetSummary {
        assets: summary
            .assets
            .into_iter()
            .map(|analysis| DerivedDatasetAsset {
                path: analysis.path,
                asset_name: analysis.asset_name,
                file_type: analysis.file_type,
                participant_id: analysis.participant_id,
                file_role: analysis.file_role,
                derived_fields: analysis.derived_fields,
            })
            .collect(),
        suggested_columns: summary.suggested_columns,
    })
}

#[tauri::command]
pub fn summarize_dataset_processing(
    assets: Vec<UiDatasetAssetInput>,
) -> Result<DatasetProcessingSummary, String> {
    let mut participant_ids = BTreeSet::new();
    let mut primary_asset_count = 0usize;
    let mut reference_count = 0usize;
    let mut index_count = 0usize;
    let mut missing_reference = 0usize;
    let mut missing_index = 0usize;
    let mut missing_participant = 0usize;

    for asset in &assets {
        let role = asset.file_role.trim().to_ascii_lowercase();
        let file_type = asset.file_type.trim();

        if !asset.participant_id.trim().is_empty() {
            participant_ids.insert(asset.participant_id.trim().to_string());
        }

        match role.as_str() {
            "reference" => reference_count += 1,
            "index" => index_count += 1,
            _ => {
                if !asset.path.trim().is_empty() {
                    primary_asset_count += 1;
                }
            }
        }

        if !asset.path.trim().is_empty() && (role.is_empty() || role == "primary") {
            if asset.participant_id.trim().is_empty() {
                missing_participant += 1;
            }
            if (file_type == "Aligned Reads" || file_type == "Variants")
                && ui_asset_metadata_value(asset, "reference_file").is_none()
            {
                missing_reference += 1;
            }
            if (file_type == "Aligned Reads"
                && ui_asset_metadata_value(asset, "aligned_index").is_none())
                || (file_type == "Variants"
                    && ui_asset_metadata_value(asset, "vcf_index").is_none())
            {
                missing_index += 1;
            }
        }
    }

    let mut warnings = Vec::new();
    let mut suggested_actions = Vec::new();

    if missing_participant > 0 {
        warnings.push(format!(
            "{} asset{} still need participant IDs",
            missing_participant,
            if missing_participant == 1 { "" } else { "s" }
        ));
        suggested_actions.push(DatasetProcessingAction {
            key: "participant_id".to_string(),
            label: "Derive Participant IDs".to_string(),
            description: "Fill participant IDs from filenames before grouping or flow requests.".to_string(),
        });
    }

    if missing_reference > 0 {
        warnings.push(format!(
            "{} primary asset{} still need a reference attachment",
            missing_reference,
            if missing_reference == 1 { "" } else { "s" }
        ));
        suggested_actions.push(DatasetProcessingAction {
            key: "reference_file".to_string(),
            label: "Attach References".to_string(),
            description: "Use detected reference files and builds to connect aligned or variant assets.".to_string(),
        });
    }

    if missing_index > 0 {
        warnings.push(format!(
            "{} primary asset{} still need an index link",
            missing_index,
            if missing_index == 1 { "" } else { "s" }
        ));
        suggested_actions.push(DatasetProcessingAction {
            key: "file_role".to_string(),
            label: "Link Index Files".to_string(),
            description: "Detect primary vs index files, then populate aligned or variant index relationships.".to_string(),
        });
    }

    if participant_ids.len() > 1 {
        suggested_actions.push(DatasetProcessingAction {
            key: "group_by_participant".to_string(),
            label: "Group By Participant".to_string(),
            description: "You have multiple participant IDs, so this dataset can be structured around participant records.".to_string(),
        });
    }

    Ok(DatasetProcessingSummary {
        participant_count: participant_ids.len(),
        primary_asset_count,
        reference_count,
        index_count,
        warnings,
        suggested_actions,
    })
}

#[tauri::command]
pub fn upsert_dataset_manifest(
    state: tauri::State<AppState>,
    manifest: biovault::cli::commands::datasets::DatasetManifest,
) -> Result<i64, String> {
    let mut db = state.biovault_db.lock().unwrap();
    biovault::data::upsert_dataset(&mut db, &manifest)
        .map_err(|e| format!("Failed to save dataset: {}", e))
}

#[tauri::command]
pub fn delete_dataset(state: tauri::State<AppState>, name: String) -> Result<usize, String> {
    if let Err(err) = unpublish_dataset(name.clone()) {
        crate::desktop_log!(
            "⚠️ Failed to unpublish dataset '{}' before delete: {}",
            name,
            err
        );
    }
    let db = state.biovault_db.lock().unwrap();
    biovault::data::delete_dataset(&db, &name)
        .map_err(|e| format!("Failed to delete dataset: {}", e))
}

#[tauri::command]
pub async fn publish_dataset(
    state: tauri::State<'_, AppState>,
    manifest_path: Option<String>,
    name: Option<String>,
    copy_mock: bool,
) -> Result<(), String> {
    if let Some(path) = manifest_path {
        return biovault::cli::commands::datasets::publish(Some(path), name, copy_mock)
            .await
            .map_err(|e| format!("Failed to publish dataset: {}", e));
    }

    let Some(name) = name else {
        return Err("Provide either a manifest path or dataset name".to_string());
    };

    let manifest = {
        let db = state.biovault_db.lock().unwrap();
        let Some((dataset, assets)) = get_dataset_with_assets(&db, &name)
            .map_err(|e| format!("Failed to load dataset: {}", e))?
        else {
            return Err(format!("Dataset '{}' not found in database", name));
        };

        build_manifest_from_db(&dataset, &assets)
    };
    let temp_path = env::temp_dir().join(format!("biovault-dataset-{}.yaml", Uuid::new_v4()));
    let yaml = serde_yaml::to_string(&manifest)
        .map_err(|e| format!("Failed to serialize dataset manifest: {}", e))?;
    std::fs::write(&temp_path, yaml)
        .map_err(|e| format!("Failed to write dataset manifest: {}", e))?;

    let result = biovault::cli::commands::datasets::publish(
        Some(temp_path.to_string_lossy().to_string()),
        None,
        copy_mock,
    )
    .await;

    let _ = std::fs::remove_file(&temp_path);
    result.map_err(|e| format!("Failed to publish dataset: {}", e))
}

#[tauri::command]
pub fn unpublish_dataset(name: String) -> Result<(), String> {
    let config =
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;
    let email = config.email.clone();
    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to resolve SyftBox data dir: {}", e))?;
    let storage = biovault::syftbox::storage::SyftBoxStorage::new(&data_dir);

    let public_dir = data_dir
        .join("datasites")
        .join(&email)
        .join("public")
        .join("biovault")
        .join("datasets")
        .join(&name);

    if public_dir.exists() {
        std::fs::remove_dir_all(&public_dir)
            .map_err(|e| format!("Failed to remove published dataset: {}", e))?;
    }

    // Update datasets.yaml index
    let index_path = data_dir
        .join("datasites")
        .join(&email)
        .join("public")
        .join("biovault")
        .join("datasets.yaml");

    if index_path.exists() {
        match storage.read_plaintext_file(&index_path) {
            Ok(bytes) => {
                if let Ok(mut index) = serde_yaml::from_slice::<
                    biovault::cli::commands::datasets::DatasetIndex,
                >(&bytes)
                {
                    index.resources.retain(|r| r.name != name);
                    let index_yaml = serde_yaml::to_string(&index)
                        .map_err(|e| format!("Failed to serialize datasets index: {}", e))?;
                    storage
                        .write_plaintext_file(&index_path, index_yaml.as_bytes(), true)
                        .map_err(|e| format!("Failed to update datasets index: {}", e))?;
                }
            }
            Err(_) => {
                // Nothing to do if index missing
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn save_dataset_with_files(
    state: tauri::State<'_, AppState>,
    manifest: biovault::cli::commands::datasets::DatasetManifest,
    original_name: Option<String>,
) -> Result<DatasetSaveResult, String> {
    save_dataset_manifest_internal(state, manifest, original_name).await
}

#[tauri::command]
pub async fn save_dataset_from_ui(
    state: tauri::State<'_, AppState>,
    request: SaveDatasetFromUiRequest,
) -> Result<DatasetSaveResult, String> {
    validate_ui_dataset_assets(&request.assets)?;
    let config = load_config_best_effort();
    let email = config.email.clone();

    let mut manifest = biovault::cli::commands::datasets::DatasetManifest {
        name: request.name.trim().to_string(),
        description: request.description.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()),
        version: request
            .version
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        schema: Some("net.biovault.datasets:1.0.0".to_string()),
        author: None,
        public_url: None,
        private_url: None,
        http_relay_servers: vec![],
        extra: BTreeMap::from([
            (
                "enabled_columns".to_string(),
                serde_yaml::to_value(request.enabled_columns).unwrap_or(serde_yaml::Value::Sequence(vec![])),
            ),
            (
                "custom_columns".to_string(),
                serde_yaml::to_value(request.custom_columns).unwrap_or(serde_yaml::Value::Sequence(vec![])),
            ),
        ]),
        ..Default::default()
    };
    manifest.shape = infer_ui_dataset_shape(&request.assets);

    let mut grouped_assets: BTreeMap<String, Vec<UiDatasetAssetInput>> = BTreeMap::new();
    let mut standalone_assets = Vec::new();
    for asset in request.assets.into_iter().filter(|asset| {
        !asset.name.trim().is_empty()
            && (!asset.path.trim().is_empty()
                || !asset.mock_path.trim().is_empty()
                || !asset.mock_url.trim().is_empty())
    }) {
        if let Some(group) = ui_asset_group(&asset) {
            grouped_assets.entry(group).or_default().push(asset);
        } else {
            standalone_assets.push(asset);
        }
    }

    for (group_key, rows) in grouped_assets {
        manifest.assets.insert(
            group_key.clone(),
            build_twin_list_asset(group_key, rows, &manifest.name, &email),
        );
    }

    for asset in standalone_assets {
        let private_path = non_empty_trimmed(&asset.path);
        let mock_path = non_empty_trimmed(&asset.mock_path);
        let mock_url = non_empty_trimmed(&asset.mock_url)
            .or_else(|| mock_path.clone().filter(|value| is_url_like(value)));
        let mut extra = BTreeMap::new();
        extra.insert(
            "file_type".to_string(),
            serde_yaml::Value::String(asset.file_type),
        );
        extra.insert(
            "participant_id".to_string(),
            serde_yaml::Value::String(asset.participant_id),
        );
        extra.insert(
            "file_role".to_string(),
            serde_yaml::Value::String(asset.file_role),
        );
        for (key, value) in asset.metadata {
            extra.insert(key, serde_yaml::Value::String(value));
        }
        if let Some(url) = mock_url.clone() {
            extra.insert(
                "mock_url".to_string(),
                serde_yaml::Value::String(url),
            );
        }

        let kind = if private_path.is_some() && (mock_path.is_some() || mock_url.is_some()) {
            Some("twin".to_string())
        } else {
            Some("file".to_string())
        };
        let mock_yaml = mock_url
            .as_ref()
            .map(|url| serde_yaml::Value::String(url.clone()));
        let mock_mapping = mock_path
            .filter(|value| !is_url_like(value))
            .map(|path| biovault::cli::commands::datasets::DatasetAssetMappingEndpoint {
                file_path: Some(path),
                db_file_id: None,
                entries: None,
            });

        manifest.assets.insert(
            asset.name.clone(),
            biovault::cli::commands::datasets::DatasetAsset {
                kind,
                mock: mock_yaml,
                mappings: Some(biovault::cli::commands::datasets::DatasetAssetMapping {
                    private: private_path.map(|path| {
                        biovault::cli::commands::datasets::DatasetAssetMappingEndpoint {
                            file_path: Some(path),
                            db_file_id: None,
                            entries: None,
                        }
                    }),
                    mock: mock_mapping,
                }),
                extra,
                ..Default::default()
            },
        );
    }

    save_dataset_manifest_internal(state, manifest, request.original_name).await
}

async fn save_dataset_manifest_internal(
    state: tauri::State<'_, AppState>,
    mut manifest: biovault::cli::commands::datasets::DatasetManifest,
    original_name: Option<String>,
) -> Result<DatasetSaveResult, String> {
    // Ensure defaults similar to publish flow
    let config =
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;
    let email = config.email.clone();
    if manifest.name.trim().is_empty() {
        return Err("Dataset name cannot be empty".to_string());
    }

    // Handle rename: if original_name exists and differs from new name, rename in DB and clean up old files
    if let Some(ref orig) = original_name {
        if !orig.is_empty() && orig != &manifest.name {
            let db = state.biovault_db.lock().unwrap();
            // Check if a dataset with the new name already exists
            let existing: Option<i64> = db
                .conn
                .query_row(
                    "SELECT id FROM datasets WHERE name = ?1",
                    [&manifest.name],
                    |row| row.get(0),
                )
                .ok();
            if existing.is_some() {
                return Err(format!(
                    "Cannot rename: a dataset named '{}' already exists",
                    manifest.name
                ));
            }
            // Rename the dataset in DB
            db.conn
                .execute(
                    "UPDATE datasets SET name = ?1 WHERE name = ?2",
                    [&manifest.name, orig],
                )
                .map_err(|e| format!("Failed to rename dataset: {}", e))?;
            drop(db);

            // Clean up old published folders
            let data_dir = config
                .get_syftbox_data_dir()
                .map_err(|e| format!("Failed to get data dir: {}", e))?;
            let datasite = data_dir.join("datasites").join(&email);

            // Remove old public folder
            let old_public_dir = datasite
                .join("public")
                .join("biovault")
                .join("datasets")
                .join(orig);
            if old_public_dir.exists() {
                let _ = std::fs::remove_dir_all(&old_public_dir);
            }

            // Remove old private folder
            let old_private_dir = datasite
                .join("private")
                .join("biovault")
                .join("datasets")
                .join(orig);
            if old_private_dir.exists() {
                let _ = std::fs::remove_dir_all(&old_private_dir);
            }

            // Update datasets.yaml index to remove old entry
            let index_path = datasite
                .join("public")
                .join("biovault")
                .join("datasets.yaml");
            if index_path.exists() {
                if let Ok(bytes) = std::fs::read(&index_path) {
                    if let Ok(mut index) = serde_yaml::from_slice::<
                        biovault::cli::commands::datasets::DatasetIndex,
                    >(&bytes)
                    {
                        index.resources.retain(|r| r.name != *orig);
                        if let Ok(yaml) = serde_yaml::to_string(&index) {
                            let _ = std::fs::write(&index_path, yaml);
                        }
                    }
                }
            }
        }
    }
    if manifest.author.is_none() {
        manifest.author = Some(email.clone());
    }
    if manifest.schema.is_none() {
        manifest.schema = Some("net.biovault.datasets:1.0.0".to_string());
    }
    if manifest.version.is_none() {
        manifest.version = Some("1.0.0".to_string());
    }
    if manifest.http_relay_servers.is_empty() {
        manifest.http_relay_servers = vec!["syftbox.net".to_string()];
    }
    manifest.public_url.get_or_insert_with(|| {
        format!(
            "syft://{}/public/biovault/datasets/{}/dataset.yaml",
            email, manifest.name
        )
    });
    manifest.private_url.get_or_insert_with(|| {
        format!(
            "syft://{}/private/biovault/datasets/{}/dataset.yaml",
            email, manifest.name
        )
    });

    let mut db = state.biovault_db.lock().unwrap();

    // Import files if needed and attach db ids
    for (asset_key, asset) in manifest.assets.iter_mut() {
        if asset.id.is_none() {
            asset.id = Some(Uuid::new_v4().to_string());
        }
        if asset.kind.is_none() {
            let has_private = asset
                .mappings
                .as_ref()
                .and_then(|mapping| mapping.private.as_ref())
                .is_some();
            let has_mock = asset
                .mappings
                .as_ref()
                .and_then(|mapping| mapping.mock.as_ref())
                .is_some();
            asset.kind = Some(if has_private && has_mock {
                "twin".to_string()
            } else {
                "file".to_string()
            });
        }
        if asset.url.is_none() {
            asset.url = Some(format!("{{root.private_url}}#assets.{}", asset_key));
        }

        if let Some(mapping) = asset.mappings.as_mut() {
            // Private - single file
            if let Some(priv_ep) = mapping.private.as_mut() {
                if priv_ep.db_file_id.is_none() {
                    if let Some(path) = priv_ep.file_path.clone() {
                        let file_id = import_file_if_needed(&db, &path)?;
                        priv_ep.db_file_id = Some(file_id);
                        priv_ep.file_path = Some(path);
                    }
                }
                // Handle twin_list entries
                if let Some(entries) = priv_ep.entries.as_mut() {
                    for entry in entries.iter_mut() {
                        if let Some(entry_map) = entry.as_mapping_mut() {
                            let file_path = entry_map
                                .get(serde_yaml::Value::String("file_path".to_string()))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            let has_db_id = entry_map
                                .get(serde_yaml::Value::String("db_file_id".to_string()))
                                .and_then(|v| v.as_i64())
                                .is_some();

                            if !has_db_id {
                                if let Some(path) = file_path {
                                    if let Ok(file_id) = import_file_if_needed(&db, &path) {
                                        entry_map.insert(
                                            serde_yaml::Value::String("db_file_id".to_string()),
                                            serde_yaml::Value::Number(file_id.into()),
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // Mock - single file
            if let Some(mock_ep) = mapping.mock.as_mut() {
                if mock_ep.db_file_id.is_none() {
                    if let Some(path) = mock_ep.file_path.clone() {
                        let file_id = import_file_if_needed(&db, &path)?;
                        mock_ep.db_file_id = Some(file_id);
                        mock_ep.file_path = Some(path.clone());
                        // If manifest mock is empty, set to public URL for publish readability
                        if asset.mock.is_none() {
                            if let Some(pub_url) = &manifest.public_url {
                                if let Some(fname) = std::path::Path::new(&path)
                                    .file_name()
                                    .and_then(|f| f.to_str())
                                {
                                    asset.mock = Some(serde_yaml::Value::String(format!(
                                        "{}/assets/{}",
                                        pub_url.trim_end_matches("dataset.yaml"),
                                        fname
                                    )));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if manifest.shape.is_none() {
        manifest.shape = infer_dataset_shape(&manifest);
    }

    // Save to DB
    let dataset_id = biovault::data::upsert_dataset(&mut db, &manifest)
        .map_err(|e| format!("Failed to save dataset: {}", e))?;

    // Write/update mapping.yaml for private assets
    let mut mapping_entries: Vec<(String, String)> = Vec::new();
    if let Some(priv_url) = &manifest.private_url {
        for (asset_key, asset) in manifest.assets.iter() {
            if let Some(mapping) = &asset.mappings {
                if let Some(priv_ep) = &mapping.private {
                    if let Some(path) = priv_ep.file_path.clone() {
                        let private_fragment = format!("{}#assets.{}", priv_url, asset_key);
                        mapping_entries.push((private_fragment, path));
                    } else if let Some(fid) = priv_ep.db_file_id {
                        if let Ok(p) = db.conn.query_row(
                            "SELECT file_path FROM files WHERE id = ?1",
                            [fid],
                            |row| row.get::<_, String>(0),
                        ) {
                            let private_fragment = format!("{}#assets.{}", priv_url, asset_key);
                            mapping_entries.push((private_fragment, p));
                        }
                    }
                }
            }
        }
    }

    if !mapping_entries.is_empty() {
        biovault::data::datasets::update_local_mappings(&mapping_entries)
            .map_err(|e| format!("Failed to update mapping.yaml: {}", e))?;
    }

    Ok(DatasetSaveResult { dataset_id })
}

fn import_file_if_needed(db: &BioVaultDb, path: &str) -> Result<i64, String> {
    if path.trim().is_empty() {
        return Err("File path is required".to_string());
    }

    // First try to find existing file by path
    if let Ok(Some(id)) = db
        .conn
        .query_row("SELECT id FROM files WHERE file_path = ?1", [path], |row| {
            row.get(0)
        })
        .optional()
    {
        return Ok(id);
    }

    // Insert minimally - skip expensive hashing, use placeholder
    // Hash can be computed lazily in background if needed
    let file_type = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e));
    let file_size = std::fs::metadata(path)
        .ok()
        .map(|m| m.len() as i64)
        .unwrap_or(0);
    // Use size-based placeholder instead of blocking hash computation
    let file_hash = format!("pending_{}", file_size);

    db.conn
        .execute(
            "INSERT INTO files (participant_id, file_path, file_hash, file_type, file_size, data_type, status, created_at, updated_at)
             VALUES (NULL, ?1, ?2, ?3, ?4, ?5, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            rusqlite::params![path, file_hash, file_type, file_size, "File"],
        )
        .map_err(|e| format!("Failed to insert file {}: {}", path, e))?;

    Ok(db.conn.last_insert_rowid())
}

#[tauri::command]
pub fn is_dataset_published(name: String) -> Result<bool, String> {
    let config =
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;
    let email = config.email.clone();
    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to get SyftBox data dir: {}", e))?;

    let public_dir = data_dir
        .join("datasites")
        .join(&email)
        .join("public")
        .join("biovault")
        .join("datasets")
        .join(&name);

    Ok(public_dir.exists())
}

#[tauri::command]
pub fn get_datasets_folder_path() -> Result<String, String> {
    let config =
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;
    let email = config.email.clone();
    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to get SyftBox data dir: {}", e))?;

    let datasets_dir = data_dir
        .join("datasites")
        .join(&email)
        .join("public")
        .join("biovault")
        .join("datasets");

    Ok(datasets_dir.to_string_lossy().to_string())
}

/// Resolve a syft:// URL to a local filesystem path.
/// Handles both public URLs (direct path resolution) and private URLs with #fragments (via mapping.yaml)
#[tauri::command]
pub fn resolve_syft_url_to_local_path(syft_url: String) -> Result<String, String> {
    let config =
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;
    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to get SyftBox data dir: {}", e))?;

    let local_path = biovault::data::resolve_syft_url(&data_dir, &syft_url)
        .map_err(|e| format!("Failed to resolve syft URL: {}", e))?;

    Ok(local_path.to_string_lossy().to_string())
}

/// Batch resolve multiple syft:// URLs to local paths.
/// Returns a list of (url, Option<resolved_path>) tuples.
/// The resolved_path is None if the URL couldn't be resolved or the file doesn't exist.
#[tauri::command]
pub fn resolve_syft_urls_batch(urls: Vec<String>) -> Result<Vec<SyftUrlResolution>, String> {
    let config =
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;
    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to get SyftBox data dir: {}", e))?;

    let results = biovault::data::resolve_syft_urls(&data_dir, &urls)
        .map_err(|e| format!("Failed to resolve syft URLs: {}", e))?;

    Ok(results
        .into_iter()
        .map(|(url, path)| SyftUrlResolution { url, path })
        .collect())
}

#[derive(Debug, serde::Serialize)]
pub struct SyftUrlResolution {
    pub url: String,
    pub path: Option<String>,
}

/// Resolve a relative path (like "public/biovault/datasets/foo/dataset.yaml")
/// to a full local filesystem path by joining with the user's datasite directory.
#[tauri::command]
pub fn resolve_local_dataset_path(dir_path: String) -> Result<String, String> {
    let config =
        biovault::config::Config::load().map_err(|e| format!("Failed to load config: {}", e))?;
    let email = config.email.clone();
    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to get SyftBox data dir: {}", e))?;

    let local_path = data_dir.join("datasites").join(email).join(&dir_path);

    Ok(local_path.to_string_lossy().to_string())
}

// Network dataset discovery types
#[derive(Serialize, Clone, Debug)]
pub struct DiscoveredDatasetAsset {
    pub key: String,
    pub kind: Option<String>,
    pub mock_url: Option<String>,
    pub mock_size: Option<u64>,
    pub mock_path: Option<String>,
    pub mock_entries: Vec<DiscoveredDatasetMockEntry>,
}

#[derive(Serialize, Clone, Debug)]
pub struct DiscoveredDatasetMockEntry {
    pub url: String,
    pub participant_id: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct DiscoveredDataset {
    pub name: String,
    pub owner: String,
    pub owner_fingerprint: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
    pub schema: Option<String>,
    pub author: Option<String>,
    pub public_url: Option<String>,
    pub dataset_path: String,
    pub assets: Vec<DiscoveredDatasetAsset>,
    pub is_trusted: bool,
    pub is_own: bool,
    pub available: bool,
    pub present_assets: usize,
    pub total_assets: usize,
    pub missing_assets: usize,
    pub downloaded_bytes: u64,
    pub expected_bytes: Option<u64>,
    pub is_subscribed: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct NetworkDatasetScanResult {
    pub datasets: Vec<DiscoveredDataset>,
    pub current_identity: String,
}

fn subscriptions_path() -> Result<PathBuf, String> {
    let config = load_config_best_effort();
    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to get SyftBox data dir: {}", e))?;
    Ok(data_dir.join(".data").join("syft.sub.yaml"))
}

fn load_subscriptions() -> Result<biovault::subscriptions::Subscriptions, String> {
    let path = subscriptions_path()?;
    biovault::subscriptions::load(&path).map_err(|e| format!("Failed to load syft.sub.yaml: {}", e))
}

fn save_subscriptions(cfg: &biovault::subscriptions::Subscriptions) -> Result<(), String> {
    let path = subscriptions_path()?;
    biovault::subscriptions::save(&path, cfg)
        .map_err(|e| format!("Failed to write syft.sub.yaml: {}", e))
}

fn dataset_subscription_rule(owner: &str, name: &str) -> biovault::subscriptions::Rule {
    biovault::subscriptions::Rule {
        action: biovault::subscriptions::Action::Allow,
        datasite: Some(owner.to_string()),
        path: format!("public/biovault/datasets/{}/**", name),
    }
}

fn is_dataset_subscribed(
    cfg: &biovault::subscriptions::Subscriptions,
    owner: &str,
    name: &str,
) -> bool {
    let target = dataset_subscription_rule(owner, name);
    cfg.rules.iter().any(|rule| {
        rule.action == biovault::subscriptions::Action::Allow
            && rule
                .datasite
                .as_deref()
                .map(|ds| ds.eq_ignore_ascii_case(owner))
                .unwrap_or(false)
            && rule.path == target.path
    })
}

fn add_dataset_subscription(
    cfg: &mut biovault::subscriptions::Subscriptions,
    owner: &str,
    name: &str,
) -> bool {
    if is_dataset_subscribed(cfg, owner, name) {
        return false;
    }
    cfg.rules.push(dataset_subscription_rule(owner, name));
    true
}

fn remove_dataset_subscription(
    cfg: &mut biovault::subscriptions::Subscriptions,
    owner: &str,
    name: &str,
) -> bool {
    let target_path = dataset_subscription_rule(owner, name).path;
    let before = cfg.rules.len();
    cfg.rules.retain(|rule| {
        !(rule.action == biovault::subscriptions::Action::Allow
            && rule
                .datasite
                .as_deref()
                .map(|ds| ds.eq_ignore_ascii_case(owner))
                .unwrap_or(false)
            && rule.path == target_path)
    });
    before != cfg.rules.len()
}

#[tauri::command]
pub fn subscribe_dataset(owner: String, name: String) -> Result<bool, String> {
    let owner = owner.trim().to_string();
    let name = name.trim().to_string();
    if owner.is_empty() || name.is_empty() {
        return Err("Missing dataset owner or name".to_string());
    }
    let mut cfg = load_subscriptions()?;
    let changed = add_dataset_subscription(&mut cfg, &owner, &name);
    if changed {
        save_subscriptions(&cfg)?;
    }
    Ok(true)
}

#[tauri::command]
pub fn unsubscribe_dataset(owner: String, name: String) -> Result<bool, String> {
    let owner = owner.trim().to_string();
    let name = name.trim().to_string();
    if owner.is_empty() || name.is_empty() {
        return Err("Missing dataset owner or name".to_string());
    }
    let mut cfg = load_subscriptions()?;
    let changed = remove_dataset_subscription(&mut cfg, &owner, &name);
    if changed {
        save_subscriptions(&cfg)?;
    }
    Ok(false)
}

#[tauri::command]
pub fn network_scan_datasets() -> Result<NetworkDatasetScanResult, String> {
    let config = load_config_best_effort();
    let current_email = config.email.clone();
    let data_dir = config
        .get_syftbox_data_dir()
        .map_err(|e| format!("Failed to get SyftBox data dir: {}", e))?;

    let datasites_dir = data_dir.join("datasites");

    // Resolve vault path (strict: SBC_VAULT or SYFTBOX_DATA_DIR/.sbc).
    let vault_path = biovault::config::resolve_sbc_vault_path()
        .map_err(|e| format!("Failed to resolve SBC_VAULT: {e}"))?;
    let bundles_dir = vault_path.join("bundles");

    let mut datasets = Vec::new();
    let current_slug = syftbox_sdk::sanitize_identity(&current_email);
    let subs_cfg =
        load_subscriptions().unwrap_or_else(|_| biovault::subscriptions::default_config());

    if !datasites_dir.exists() {
        return Ok(NetworkDatasetScanResult {
            datasets,
            current_identity: current_email,
        });
    }

    let entries = std::fs::read_dir(&datasites_dir)
        .map_err(|e| format!("Failed to read datasites: {}", e))?;

    for entry in entries.flatten() {
        let datasite_path = entry.path();
        if !datasite_path.is_dir() {
            continue;
        }

        let owner = datasite_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        let owner_slug = syftbox_sdk::sanitize_identity(&owner);
        let is_own = owner_slug == current_slug;

        // Check if this peer is trusted (has imported bundle) - own datasets are always "trusted"
        let bundle_path = bundles_dir.join(format!("{}.json", owner_slug));
        let is_trusted = is_own || bundle_path.exists();

        // Try to get fingerprint from bundle
        let owner_fingerprint = if bundle_path.exists() {
            std::fs::read_to_string(&bundle_path)
                .ok()
                .and_then(|content| {
                    serde_json::from_str::<serde_json::Value>(&content)
                        .ok()
                        .and_then(|v| {
                            v.get("fingerprint")
                                .and_then(|f| f.as_str())
                                .map(String::from)
                        })
                })
        } else {
            None
        };

        // Look for datasets.yaml index
        let index_path = datasite_path
            .join("public")
            .join("biovault")
            .join("datasets.yaml");

        if !index_path.exists() {
            continue;
        }

        // Parse the datasets index
        let index_bytes = match std::fs::read(&index_path) {
            Ok(b) => b,
            Err(_) => continue,
        };

        let index: biovault::cli::commands::datasets::DatasetIndex =
            match serde_yaml::from_slice(&index_bytes) {
                Ok(i) => i,
                Err(_) => continue,
            };

        // Load each dataset's manifest
        for resource in index.resources {
            let dataset_dir = datasite_path
                .join("public")
                .join("biovault")
                .join("datasets")
                .join(&resource.name);
            let manifest_path = dataset_dir.join("dataset.yaml");

            if !manifest_path.exists() {
                continue;
            }

            let manifest_bytes = match std::fs::read(&manifest_path) {
                Ok(b) => b,
                Err(_) => continue,
            };

            let manifest: biovault::cli::commands::datasets::DatasetManifest =
                match serde_yaml::from_slice(&manifest_bytes) {
                    Ok(m) => m,
                    Err(_) => continue,
                };

            // Build assets list with mock info
            let mut discovered_assets = Vec::new();
            let mut missing_assets: usize = 0;
            let mut present_assets: usize = 0;
            let mut downloaded_bytes: u64 = 0;
            let mut expected_bytes: u64 = 0;

            for (key, asset) in &manifest.assets {
                let mock_url = asset.mock.as_ref().and_then(|m| match m {
                    serde_yaml::Value::String(s) => Some(s.clone()),
                    serde_yaml::Value::Mapping(map) => map
                        .get(serde_yaml::Value::String("url".to_string()))
                        .and_then(|v| v.as_str().map(|s| s.to_string())),
                    _ => None,
                });

                let mut mock_entries = Vec::new();
                if let Some(serde_yaml::Value::Mapping(map)) = asset.mock.as_ref() {
                    if let Some(serde_yaml::Value::Sequence(entries)) =
                        map.get(serde_yaml::Value::String("entries".to_string()))
                    {
                        for entry in entries {
                            if let serde_yaml::Value::Mapping(entry_map) = entry {
                                let url = entry_map
                                    .get(serde_yaml::Value::String("url".to_string()))
                                    .and_then(|v| v.as_str())
                                    .map(String::from);
                                if let Some(url) = url {
                                    let participant_id = entry_map
                                        .get(serde_yaml::Value::String(
                                            "participant_id".to_string(),
                                        ))
                                        .and_then(|v| v.as_str())
                                        .map(String::from);
                                    mock_entries.push(DiscoveredDatasetMockEntry {
                                        url,
                                        participant_id,
                                    });
                                }
                            }
                        }
                    }
                }

                // Try to find mock file and get its size
                let (mock_size, mock_path) = if let Some(ref url) = mock_url {
                    // Mock URL like: syft://owner/public/biovault/datasets/name/assets/file.csv
                    // Try to resolve to local path
                    let assets_dir = dataset_dir.join("assets");
                    if let Some(filename) = url.split('/').next_back() {
                        let local_mock = assets_dir.join(filename);
                        if local_mock.exists() {
                            let size = std::fs::metadata(&local_mock).ok().map(|m| m.len());
                            (size, Some(local_mock.to_string_lossy().to_string()))
                        } else {
                            (None, None)
                        }
                    } else {
                        (None, None)
                    }
                } else {
                    (None, None)
                };

                // Resolve local asset path to check availability/size
                let mut found = false;
                let mut size_bytes: Option<u64> = None;

                // 1) Prefer resolved mock_path
                if let Some(ref mp) = mock_path {
                    if let Ok(metadata) = std::fs::metadata(mp) {
                        found = true;
                        size_bytes = Some(metadata.len());
                    }
                }
                // 2) If no mock_path hit, try deriving from mock_url filename
                if !found {
                    if let Some(ref url) = mock_url {
                        if let Some(filename) = url.split('/').next_back() {
                            let candidate = dataset_dir.join("assets").join(filename);
                            if let Ok(metadata) = std::fs::metadata(&candidate) {
                                found = true;
                                size_bytes = Some(metadata.len());
                            }
                        }
                    }
                }
                // 3) Fallback to key-based path
                if !found {
                    let asset_path = dataset_dir.join(key);
                    if let Ok(metadata) = std::fs::metadata(&asset_path) {
                        found = true;
                        size_bytes = Some(metadata.len());
                    }
                }

                if found {
                    present_assets += 1;
                    if let Some(sz) = size_bytes {
                        downloaded_bytes = downloaded_bytes.saturating_add(sz);
                    }
                } else {
                    missing_assets += 1;
                }

                if let Some(ms) = mock_size {
                    expected_bytes = expected_bytes.saturating_add(ms);
                } else if let Some(sz) = size_bytes {
                    expected_bytes = expected_bytes.saturating_add(sz);
                }

                discovered_assets.push(DiscoveredDatasetAsset {
                    key: key.clone(),
                    kind: asset.kind.clone(),
                    mock_url,
                    mock_size,
                    mock_path,
                    mock_entries,
                });
            }

            datasets.push(DiscoveredDataset {
                name: manifest.name.clone(),
                owner: owner.clone(),
                owner_fingerprint: owner_fingerprint.clone(),
                description: manifest.description.clone(),
                version: manifest.version.clone(),
                schema: manifest.schema.clone(),
                author: manifest.author.clone(),
                public_url: manifest.public_url.clone(),
                dataset_path: manifest_path.to_string_lossy().to_string(),
                assets: discovered_assets,
                is_trusted,
                is_own,
                available: missing_assets == 0 && !manifest.assets.is_empty(),
                present_assets,
                total_assets: manifest.assets.len(),
                missing_assets,
                downloaded_bytes,
                expected_bytes: if expected_bytes > 0 {
                    Some(expected_bytes)
                } else {
                    None
                },
                is_subscribed: is_dataset_subscribed(&subs_cfg, &owner, &manifest.name),
            });
        }
    }

    // Sort: own datasets first, then by owner, then by name
    datasets.sort_by(|a, b| {
        b.is_own
            .cmp(&a.is_own)
            .then_with(|| a.owner.cmp(&b.owner))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(NetworkDatasetScanResult {
        datasets,
        current_identity: current_email,
    })
}
