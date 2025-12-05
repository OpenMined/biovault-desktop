use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::types::AppState;
use biovault::config::Config;

#[derive(Serialize, Default, Debug, Clone)]
pub struct KeyStatus {
    identity: String,
    vault_path: String,
    bundle_path: String,
    export_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    vault_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    export_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    export_matches: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bundle: Option<Value>,
    exists: bool,
}

#[derive(Serialize, Debug, Clone)]
pub struct KeyOperationResult {
    identity: String,
    fingerprint: String,
    vault_path: String,
    bundle_path: String,
    export_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    mnemonic: Option<String>,
}

#[tauri::command]
pub fn key_get_status(email: Option<String>) -> Result<KeyStatus, String> {
    let config = load_config(email.as_deref())?;
    let email = resolve_email(email.as_deref(), &config)?;
    let (data_root, vault_path) = resolve_paths(&config, None, None)?;
    let bundle_path = vault_path
        .join("bundles")
        .join(format!("{}.json", syftbox_sdk::sanitize_identity(&email)));
    let export_path = resolve_export_path(&data_root, &email);

    println!("🔑 key_get_status: email={}, vault_path={}, bundle_path={}", email, vault_path.display(), bundle_path.display());

    let existing = load_existing_bundle(&vault_path, &email)?;
    println!("🔑 key_get_status: exists={}", existing.is_some());

    let mut export_fp = None;
    let mut export_matches = None;
    if let Some(info) = existing.as_ref() {
        if export_path.exists() {
            if let Ok(einfo) = biovault::syftbox::syc::parse_public_bundle_file(&export_path) {
                export_matches = Some(einfo.fingerprint == info.fingerprint);
                export_fp = Some(einfo.fingerprint);
            }
        }
    }

    Ok(KeyStatus {
        identity: email,
        vault_path: vault_path.to_string_lossy().to_string(),
        bundle_path: bundle_path.to_string_lossy().to_string(),
        export_path: export_path.to_string_lossy().to_string(),
        vault_fingerprint: existing.as_ref().map(|i| i.fingerprint.clone()),
        export_fingerprint: export_fp,
        export_matches,
        bundle: existing.as_ref().map(|i| i.value.clone()),
        exists: existing.is_some(),
    })
}

#[derive(Serialize, Debug, Clone)]
pub struct VaultDebugInfo {
    pub syc_vault_env: Option<String>,
    pub vault_path: String,
    pub vault_exists: bool,
    pub keys_dir_exists: bool,
    pub bundles_dir_exists: bool,
    pub key_files: Vec<String>,
    pub bundle_files: Vec<String>,
}

#[tauri::command]
pub fn key_check_vault_debug() -> Result<VaultDebugInfo, String> {
    let syc_vault_env = std::env::var("SYC_VAULT").ok();
    let vault_path = resolve_vault_default(None);
    let vault_exists = vault_path.exists();
    let keys_dir = vault_path.join("keys");
    let bundles_dir = vault_path.join("bundles");
    let keys_dir_exists = keys_dir.exists();
    let bundles_dir_exists = bundles_dir.exists();

    let mut key_files = Vec::new();
    let mut bundle_files = Vec::new();

    if keys_dir_exists {
        if let Ok(entries) = std::fs::read_dir(&keys_dir) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    key_files.push(name.to_string());
                }
            }
        }
    }

    if bundles_dir_exists {
        if let Ok(entries) = std::fs::read_dir(&bundles_dir) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    bundle_files.push(name.to_string());
                }
            }
        }
    }

    println!("🔍 VAULT DEBUG: env={:?} path={} exists={} keys={:?} bundles={:?}",
        syc_vault_env, vault_path.display(), vault_exists, key_files, bundle_files);

    Ok(VaultDebugInfo {
        syc_vault_env,
        vault_path: vault_path.to_string_lossy().to_string(),
        vault_exists,
        keys_dir_exists,
        bundles_dir_exists,
        key_files,
        bundle_files,
    })
}

#[tauri::command]
pub async fn key_generate(
    email: Option<String>,
    force: Option<bool>,
    _state: tauri::State<'_, AppState>,
) -> Result<KeyOperationResult, String> {
    let config = load_config(email.as_deref())?;
    let email = resolve_email(email.as_deref(), &config)?;
    let (data_root, vault_path) = resolve_paths(&config, None, None)?;

    let overwrite = force.unwrap_or(false);
    println!("🔑 key_generate: email={}, force={}, vault_path={}", email, overwrite, vault_path.display());

    let outcome = biovault::syftbox::syc::provision_local_identity_with_options(
        &email,
        &data_root,
        Some(&vault_path),
        overwrite,
    )
    .map_err(|e| format!("failed to generate identity: {e}"))?;

    println!("🔑 key_generate: generated={}, has_mnemonic={}", outcome.generated, outcome.recovery_mnemonic.is_some());

    let bundle = biovault::syftbox::syc::parse_public_bundle_file(&outcome.public_bundle_path)
        .map_err(|e| format!("failed to parse bundle: {e}"))?;
    Ok(KeyOperationResult {
        identity: bundle.identity.clone(),
        fingerprint: bundle.fingerprint.clone(),
        vault_path: outcome.vault_path.to_string_lossy().to_string(),
        bundle_path: outcome.bundle_path.to_string_lossy().to_string(),
        export_path: outcome.public_bundle_path.to_string_lossy().to_string(),
        mnemonic: outcome.recovery_mnemonic.clone(),
    })
}

#[tauri::command]
pub async fn key_restore(
    email: String,
    mnemonic: String,
    _state: tauri::State<'_, AppState>,
) -> Result<KeyOperationResult, String> {
    let config = load_config(Some(email.as_str()))?;
    let (data_root, vault_path) = resolve_paths(&config, None, None)?;
    let outcome = biovault::syftbox::syc::restore_identity_from_mnemonic(
        &email,
        &mnemonic,
        &data_root,
        Some(&vault_path),
    )
    .map_err(|e| format!("failed to restore identity: {e}"))?;
    let bundle = biovault::syftbox::syc::parse_public_bundle_file(&outcome.public_bundle_path)
        .map_err(|e| format!("failed to parse bundle: {e}"))?;
    Ok(KeyOperationResult {
        identity: bundle.identity.clone(),
        fingerprint: bundle.fingerprint.clone(),
        vault_path: outcome.vault_path.to_string_lossy().to_string(),
        bundle_path: outcome.bundle_path.to_string_lossy().to_string(),
        export_path: outcome.public_bundle_path.to_string_lossy().to_string(),
        mnemonic: outcome.recovery_mnemonic.clone(),
    })
}

fn resolve_email<'a>(
    email: Option<&'a str>,
    config: &'a biovault::config::Config,
) -> Result<String, String> {
    if let Some(e) = email {
        let trimmed = e.trim();
        if !trimmed.is_empty() && trimmed != "setup@pending" {
            return Ok(trimmed.to_string());
        }
    }
    let config_email = config.email.trim();
    if !config_email.is_empty() && config_email != "setup@pending" {
        return Ok(config.email.clone());
    }
    Err("email is required (setup not complete)".to_string())
}

fn resolve_paths(
    config: &biovault::config::Config,
    data_override: Option<&Path>,
    vault_override: Option<&Path>,
) -> Result<(PathBuf, PathBuf), String> {
    let data_root = if let Some(dir) = data_override {
        dir.to_path_buf()
    } else {
        // Try syftbox config first, fall back to biovault home for pre-init key operations
        config.get_syftbox_data_dir().unwrap_or_else(|_| {
            biovault::config::get_biovault_home()
                .map(|h| h.join("data"))
                .unwrap_or_else(|_| {
                    dirs::home_dir()
                        .map(|h| h.join("Desktop").join("BioVault").join("data"))
                        .unwrap_or_else(|| PathBuf::from("BioVault").join("data"))
                })
        })
    };
    let encrypted_root = syftbox_sdk::syftbox::syc::resolve_encrypted_root(&data_root);
    let vault_path = resolve_vault_default(vault_override);
    Ok((encrypted_root, vault_path))
}

fn resolve_export_path(data_root: &Path, identity: &str) -> PathBuf {
    let base = if data_root
        .file_name()
        .map(|n| n == "datasites")
        .unwrap_or(false)
    {
        data_root.to_path_buf()
    } else {
        data_root.join("datasites")
    };
    base.join(identity)
        .join("public")
        .join("crypto")
        .join("did.json")
}

fn resolve_vault_default(vault_override: Option<&Path>) -> PathBuf {
    if let Some(v) = vault_override {
        println!("🔑 resolve_vault: using override: {}", v.display());
        return v.to_path_buf();
    }
    if let Some(env_vault) = std::env::var_os("SYC_VAULT") {
        println!("🔑 resolve_vault: using SYC_VAULT env: {:?}", env_vault);
        return PathBuf::from(env_vault);
    }
    let default = dirs::home_dir()
        .map(|h| h.join(".syc"))
        .unwrap_or_else(|| PathBuf::from(".syc"));
    println!("🔑 resolve_vault: using default: {}", default.display());
    default
}

fn load_existing_bundle(
    vault_path: &Path,
    identity: &str,
) -> Result<Option<syftbox_sdk::PublicBundleInfo>, String> {
    let slug = syftbox_sdk::sanitize_identity(identity);
    let bundle_path = vault_path.join("bundles").join(format!("{slug}.json"));
    if !bundle_path.exists() {
        return Ok(None);
    }
    let info = biovault::syftbox::syc::parse_public_bundle_file(&bundle_path)
        .map_err(|e| format!("failed to read existing bundle: {e}"))?;
    Ok(Some(info))
}

fn load_config(email: Option<&str>) -> Result<Config, String> {
    match Config::load() {
        Ok(cfg) => Ok(cfg),
        Err(err) => {
            if let Some(e) = email {
                if !e.trim().is_empty() {
                    return Ok(Config::new(e.trim().to_string()));
                }
            }
            Err(format!("failed to load config: {err}"))
        }
    }
}

#[derive(Serialize, Debug, Clone)]
pub struct ContactInfo {
    pub identity: String,
    pub fingerprint: String,
    pub bundle_path: String,
}

/// List all public key bundles in the vault (contacts), excluding the current identity
#[tauri::command]
pub fn key_list_contacts(current_email: Option<String>) -> Result<Vec<ContactInfo>, String> {
    let _config =
        load_config(current_email.as_deref()).unwrap_or_else(|_| Config::new(String::new()));
    let vault_path = resolve_vault_default(None);
    let bundles_dir = vault_path.join("bundles");

    if !bundles_dir.exists() {
        return Ok(vec![]);
    }

    let current_slug = current_email
        .as_ref()
        .map(|e| syftbox_sdk::sanitize_identity(e))
        .unwrap_or_default();

    let mut contacts = Vec::new();

    let entries = std::fs::read_dir(&bundles_dir)
        .map_err(|e| format!("failed to read bundles directory: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e == "json").unwrap_or(false) {
            // Skip current identity
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                if stem == current_slug {
                    continue;
                }
            }

            if let Ok(info) = biovault::syftbox::syc::parse_public_bundle_file(&path) {
                contacts.push(ContactInfo {
                    identity: info.identity,
                    fingerprint: info.fingerprint,
                    bundle_path: path.to_string_lossy().to_string(),
                });
            }
        }
    }

    // Sort by identity
    contacts.sort_by(|a, b| a.identity.to_lowercase().cmp(&b.identity.to_lowercase()));

    Ok(contacts)
}

#[derive(Serialize, Debug, Clone)]
pub struct RefreshResult {
    pub updated: Vec<String>,
    pub added: Vec<String>,
    pub unchanged: Vec<String>,
    pub errors: Vec<String>,
}

/// Refresh contacts from SyftBox datasites - checks did.json files and updates local bundles
#[tauri::command]
pub async fn key_refresh_contacts(
    _state: tauri::State<'_, AppState>,
) -> Result<RefreshResult, String> {
    let config = load_config(None)?;
    let (data_root, vault_path) = resolve_paths(&config, None, None)?;
    let bundles_dir = vault_path.join("bundles");

    // Ensure bundles directory exists
    if !bundles_dir.exists() {
        std::fs::create_dir_all(&bundles_dir)
            .map_err(|e| format!("failed to create bundles directory: {e}"))?;
    }

    // Find datasites directory
    let datasites_dir = if data_root
        .file_name()
        .map(|n| n == "datasites")
        .unwrap_or(false)
    {
        data_root.clone()
    } else {
        data_root.join("datasites")
    };

    if !datasites_dir.exists() {
        return Ok(RefreshResult {
            updated: vec![],
            added: vec![],
            unchanged: vec![],
            errors: vec!["Datasites directory not found".to_string()],
        });
    }

    let mut result = RefreshResult {
        updated: vec![],
        added: vec![],
        unchanged: vec![],
        errors: vec![],
    };

    // Iterate through all datasites looking for did.json files
    let entries =
        std::fs::read_dir(&datasites_dir).map_err(|e| format!("failed to read datasites: {e}"))?;

    for entry in entries.flatten() {
        let datasite_path = entry.path();
        if !datasite_path.is_dir() {
            continue;
        }

        let did_path = datasite_path.join("public").join("crypto").join("did.json");
        if !did_path.exists() {
            continue;
        }

        // Parse the remote did.json
        match biovault::syftbox::syc::parse_public_bundle_file(&did_path) {
            Ok(remote_info) => {
                let slug = syftbox_sdk::sanitize_identity(&remote_info.identity);
                let local_bundle_path = bundles_dir.join(format!("{slug}.json"));

                if local_bundle_path.exists() {
                    // Check if fingerprints differ
                    match biovault::syftbox::syc::parse_public_bundle_file(&local_bundle_path) {
                        Ok(local_info) => {
                            if local_info.fingerprint != remote_info.fingerprint {
                                // Update local bundle
                                if let Err(e) = std::fs::copy(&did_path, &local_bundle_path) {
                                    result.errors.push(format!("{}: {e}", remote_info.identity));
                                } else {
                                    result.updated.push(remote_info.identity);
                                }
                            } else {
                                result.unchanged.push(remote_info.identity);
                            }
                        }
                        Err(e) => {
                            result.errors.push(format!(
                                "{}: failed to parse local: {e}",
                                remote_info.identity
                            ));
                        }
                    }
                } else {
                    // Add new contact
                    if let Err(e) = std::fs::copy(&did_path, &local_bundle_path) {
                        result.errors.push(format!("{}: {e}", remote_info.identity));
                    } else {
                        result.added.push(remote_info.identity);
                    }
                }
            }
            Err(e) => {
                if let Some(name) = datasite_path.file_name().and_then(|n| n.to_str()) {
                    result.errors.push(format!("{name}: {e}"));
                }
            }
        }
    }

    Ok(result)
}

#[derive(Serialize, Debug, Clone)]
pub struct DiscoveredContact {
    pub identity: String,
    pub fingerprint: String,
    pub did_path: String,
    pub is_imported: bool,
    pub has_changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_bundle_path: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct NetworkScanResult {
    pub contacts: Vec<DiscoveredContact>,
    pub discovered: Vec<DiscoveredContact>,
    pub current_identity: String,
}

/// Scan datasites for did.json files and return contacts/discovered lists
/// Does NOT auto-import - just reports what's found
#[tauri::command]
pub fn network_scan_datasites() -> Result<NetworkScanResult, String> {
    let config = load_config(None)?;
    let current_email = config.email.clone();
    let (data_root, vault_path) = resolve_paths(&config, None, None)?;
    let bundles_dir = vault_path.join("bundles");

    // Find datasites directory
    let datasites_dir = if data_root
        .file_name()
        .map(|n| n == "datasites")
        .unwrap_or(false)
    {
        data_root.clone()
    } else {
        data_root.join("datasites")
    };

    let mut contacts = Vec::new();
    let mut discovered = Vec::new();

    let current_slug = syftbox_sdk::sanitize_identity(&current_email);

    if datasites_dir.exists() {
        let entries = std::fs::read_dir(&datasites_dir)
            .map_err(|e| format!("failed to read datasites: {e}"))?;

        for entry in entries.flatten() {
            let datasite_path = entry.path();
            if !datasite_path.is_dir() {
                continue;
            }

            let did_path = datasite_path.join("public").join("crypto").join("did.json");
            if !did_path.exists() {
                continue;
            }

            if let Ok(remote_info) = biovault::syftbox::syc::parse_public_bundle_file(&did_path) {
                let slug = syftbox_sdk::sanitize_identity(&remote_info.identity);

                // Skip current identity
                if slug == current_slug {
                    continue;
                }

                let local_bundle_path = bundles_dir.join(format!("{slug}.json"));
                let is_imported = local_bundle_path.exists();

                let (has_changed, local_fingerprint) = if is_imported {
                    match biovault::syftbox::syc::parse_public_bundle_file(&local_bundle_path) {
                        Ok(local_info) => {
                            let changed = local_info.fingerprint != remote_info.fingerprint;
                            (changed, Some(local_info.fingerprint))
                        }
                        Err(_) => (false, None),
                    }
                } else {
                    (false, None)
                };

                let contact = DiscoveredContact {
                    identity: remote_info.identity,
                    fingerprint: remote_info.fingerprint,
                    did_path: did_path.to_string_lossy().to_string(),
                    is_imported,
                    has_changed,
                    local_fingerprint,
                    local_bundle_path: if is_imported {
                        Some(local_bundle_path.to_string_lossy().to_string())
                    } else {
                        None
                    },
                };

                if is_imported {
                    contacts.push(contact);
                } else {
                    discovered.push(contact);
                }
            }
        }
    }

    // Sort both lists alphabetically
    contacts.sort_by(|a, b| a.identity.to_lowercase().cmp(&b.identity.to_lowercase()));
    discovered.sort_by(|a, b| a.identity.to_lowercase().cmp(&b.identity.to_lowercase()));

    Ok(NetworkScanResult {
        contacts,
        discovered,
        current_identity: current_email,
    })
}

/// Import a contact's public key bundle from their datasite
#[tauri::command]
pub fn network_import_contact(identity: String) -> Result<ContactInfo, String> {
    let config = load_config(None)?;
    let (data_root, vault_path) = resolve_paths(&config, None, None)?;
    let bundles_dir = vault_path.join("bundles");

    // Ensure bundles directory exists
    if !bundles_dir.exists() {
        std::fs::create_dir_all(&bundles_dir)
            .map_err(|e| format!("failed to create bundles directory: {e}"))?;
    }

    // Find datasites directory
    let datasites_dir = if data_root
        .file_name()
        .map(|n| n == "datasites")
        .unwrap_or(false)
    {
        data_root.clone()
    } else {
        data_root.join("datasites")
    };

    let did_path = datasites_dir
        .join(&identity)
        .join("public")
        .join("crypto")
        .join("did.json");

    if !did_path.exists() {
        return Err(format!("DID not found for {identity}"));
    }

    let remote_info = biovault::syftbox::syc::parse_public_bundle_file(&did_path)
        .map_err(|e| format!("failed to parse DID: {e}"))?;

    let slug = syftbox_sdk::sanitize_identity(&remote_info.identity);
    let local_bundle_path = bundles_dir.join(format!("{slug}.json"));

    std::fs::copy(&did_path, &local_bundle_path)
        .map_err(|e| format!("failed to import bundle: {e}"))?;

    Ok(ContactInfo {
        identity: remote_info.identity,
        fingerprint: remote_info.fingerprint,
        bundle_path: local_bundle_path.to_string_lossy().to_string(),
    })
}

/// Remove a contact's public key bundle from the vault
#[tauri::command]
pub fn network_remove_contact(identity: String) -> Result<(), String> {
    let config = load_config(None)?;
    let (_, vault_path) = resolve_paths(&config, None, None)?;
    let bundles_dir = vault_path.join("bundles");

    let slug = syftbox_sdk::sanitize_identity(&identity);
    let bundle_path = bundles_dir.join(format!("{slug}.json"));

    if bundle_path.exists() {
        std::fs::remove_file(&bundle_path).map_err(|e| format!("failed to remove bundle: {e}"))?;
    }

    Ok(())
}

/// Trust a changed key by re-importing from the datasite
#[tauri::command]
pub fn network_trust_changed_key(identity: String) -> Result<ContactInfo, String> {
    // Simply re-import the contact, which overwrites the existing bundle
    network_import_contact(identity)
}

#[derive(Serialize, Debug, Clone)]
pub struct RepublishResult {
    pub identity: String,
    pub fingerprint: String,
    pub export_path: String,
    pub vault_matches_export: bool,
}

/// Re-publish the public DID from the local vault to the public export location
/// Useful when the did.json file gets out of sync with the vault bundle
#[tauri::command]
pub fn key_republish(email: Option<String>) -> Result<RepublishResult, String> {
    let config = load_config(email.as_deref())?;
    let email = resolve_email(email.as_deref(), &config)?;
    let (data_root, vault_path) = resolve_paths(&config, None, None)?;

    let slug = syftbox_sdk::sanitize_identity(&email);
    let bundle_path = vault_path.join("bundles").join(format!("{slug}.json"));
    let export_path = resolve_export_path(&data_root, &email);

    if !bundle_path.exists() {
        return Err(format!(
            "No bundle found in vault for {email}. Generate keys first."
        ));
    }

    // Read the vault bundle
    let vault_info = biovault::syftbox::syc::parse_public_bundle_file(&bundle_path)
        .map_err(|e| format!("failed to read vault bundle: {e}"))?;

    // Ensure parent directory exists
    if let Some(parent) = export_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create export directory: {e}"))?;
    }

    // Copy the bundle to the export location
    std::fs::copy(&bundle_path, &export_path)
        .map_err(|e| format!("failed to publish bundle: {e}"))?;

    // Verify the copy
    let export_info = biovault::syftbox::syc::parse_public_bundle_file(&export_path)
        .map_err(|e| format!("failed to verify exported bundle: {e}"))?;

    Ok(RepublishResult {
        identity: vault_info.identity,
        fingerprint: vault_info.fingerprint.clone(),
        export_path: export_path.to_string_lossy().to_string(),
        vault_matches_export: vault_info.fingerprint == export_info.fingerprint,
    })
}
