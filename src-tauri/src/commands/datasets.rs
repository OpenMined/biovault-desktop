use crate::types::AppState;
use biovault::data::datasets::{build_manifest_from_db, get_dataset_with_assets};
use biovault::data::BioVaultDb;
use rusqlite::OptionalExtension;
use serde::Serialize;
use serde_yaml;
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
            asset.kind = Some("twin".to_string());
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

    // Resolve vault path (strict: SYC_VAULT or SYFTBOX_DATA_DIR/.syc).
    let vault_path = biovault::config::resolve_syc_vault_path()
        .map_err(|e| format!("Failed to resolve SYC_VAULT: {e}"))?;
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
