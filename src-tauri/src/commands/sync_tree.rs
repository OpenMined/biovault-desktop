use crate::types::{
    SharedWithMeItem, SyftPubInfo, SyftPubPermission, SyncIgnorePatterns, SyncTreeDetails,
    SyncTreeNode,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Essential paths that are always synced and cannot be disabled.
/// These are required for BioVault to function correctly.
const ESSENTIAL_PATTERNS: &[&str] = &[
    // Public keys / DID documents (trust & encryption)
    "*/public/crypto/did.json",
    "*/public/crypto/*.yaml",
    // Dataset metadata (discover available datasets)
    "*/public/biovault/datasets.yaml",
    "*/public/biovault/datasets/*/dataset.yaml",
    "*/public/biovault/datasets/*.json",
    // RPC endpoint permissions
    "*/app_data/biovault/*.yaml",
    // All ACL/permission files (discover what's shared with you)
    "**/syft.pub.yaml",
];

fn load_runtime_config() -> Result<syftbox_sdk::syftbox::config::SyftboxRuntimeConfig, String> {
    let cfg = biovault::config::Config::load()
        .map_err(|e| format!("SyftBox not configured yet: {}", e))?;

    cfg.to_syftbox_runtime_config()
        .map_err(|e| format!("SyftBox config is incomplete: {}", e))
}

fn get_datasites_path() -> Result<PathBuf, String> {
    let runtime = load_runtime_config()?;
    Ok(PathBuf::from(&runtime.data_dir).join("datasites"))
}

fn get_syftignore_path() -> Result<PathBuf, String> {
    let runtime = load_runtime_config()?;
    Ok(PathBuf::from(&runtime.data_dir).join(".syftignore"))
}

fn get_syftsub_path() -> Result<PathBuf, String> {
    let runtime = load_runtime_config()?;
    Ok(PathBuf::from(&runtime.data_dir)
        .join(".data")
        .join("syft.sub.yaml"))
}

fn load_owner_email() -> String {
    if let Ok(cfg) = biovault::config::Config::load() {
        let trimmed = cfg.email.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    let fallback = biovault::config::Config::new(String::new());
    fallback
        .get_syftbox_config_path()
        .ok()
        .and_then(|path| syftbox_sdk::syftbox::config::SyftBoxConfigFile::load(&path).ok())
        .map(|cfg| cfg.email)
        .unwrap_or_default()
}

fn split_datasite(rel: &str) -> (String, String) {
    if rel.is_empty() {
        return ("".to_string(), "".to_string());
    }
    let mut parts = rel.splitn(2, '/');
    let ds = parts.next().unwrap_or("").to_string();
    let rest = parts.next().unwrap_or("").to_string();
    (ds, rest)
}

fn is_valid_datasite_selector(value: &str) -> bool {
    if value == "*" {
        return true;
    }
    value.contains('@')
}

fn sanitize_subscription_rules(cfg: &mut biovault::subscriptions::Subscriptions) {
    cfg.rules.retain(|rule| {
        rule.datasite
            .as_deref()
            .map(is_valid_datasite_selector)
            .unwrap_or(true)
    });
}

fn normalize_subscription_path(path: &str) -> String {
    let mut out = path.replace('\\', "/");
    while out.starts_with('/') {
        out.remove(0);
    }
    while out.contains("//") {
        out = out.replace("//", "/");
    }
    out
}

fn strip_glob_suffix(path: &str) -> String {
    let mut out = path.trim_end_matches("/**").to_string();
    out = out.trim_end_matches('/').to_string();
    out
}

fn essential_rules_for_subtree(datasite: &str, prefix: &str) -> Vec<biovault::subscriptions::Rule> {
    let mut rules = Vec::new();
    let normalized_prefix = if prefix == "**" {
        ""
    } else {
        prefix.trim_end_matches('/')
    };
    for pattern in ESSENTIAL_PATTERNS {
        if let Some(rest) = pattern.strip_prefix("*/") {
            let rest = rest.trim_start_matches('/');
            if normalized_prefix.is_empty()
                || rest == normalized_prefix
                || rest.starts_with(&format!("{}/", normalized_prefix))
            {
                rules.push(biovault::subscriptions::Rule {
                    action: biovault::subscriptions::Action::Allow,
                    datasite: Some(datasite.to_string()),
                    path: rest.to_string(),
                });
            }
        } else if let Some(rest) = pattern.strip_prefix("**/") {
            let path = if normalized_prefix.is_empty() {
                format!("**/{}", rest)
            } else {
                format!("{}/**/{}", normalized_prefix, rest)
            };
            rules.push(biovault::subscriptions::Rule {
                action: biovault::subscriptions::Action::Allow,
                datasite: Some(datasite.to_string()),
                path,
            });
        }
    }
    rules
}

fn simple_glob_match(pattern: &str, path: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some(suffix) = pattern.strip_prefix("**/") {
        if path.ends_with(suffix) || path.contains(&format!("/{}", suffix)) {
            return true;
        }
        return simple_glob_match(suffix, path);
    }
    if let Some(prefix) = pattern.strip_suffix("/**") {
        return path.starts_with(prefix) || path == prefix;
    }
    if pattern.contains("**") {
        let parts: Vec<&str> = pattern.split("**").collect();
        if parts.len() == 2 {
            return path.starts_with(parts[0]) && path.ends_with(parts[1]);
        }
    }
    if let Some(suffix) = pattern.strip_prefix("*/") {
        let parts: Vec<&str> = path.splitn(2, '/').collect();
        if parts.len() == 2 {
            return simple_glob_match(suffix, parts[1]);
        }
        return false;
    }
    if pattern.contains('*') {
        let parts: Vec<&str> = pattern.split('*').collect();
        if parts.len() == 2 {
            return path.starts_with(parts[0]) && path.ends_with(parts[1]);
        }
    }
    path == pattern || path.starts_with(&format!("{}/", pattern))
}

fn is_path_ignored(path: &str, ignore_patterns: &[String]) -> Option<String> {
    for pattern in ignore_patterns {
        if pattern.starts_with('!') {
            continue;
        }
        if pattern.starts_with('#') || pattern.trim().is_empty() {
            continue;
        }
        if simple_glob_match(pattern, path) {
            return Some(pattern.clone());
        }
    }
    None
}

fn is_path_whitelisted(path: &str, ignore_patterns: &[String]) -> bool {
    for pattern in ignore_patterns {
        if let Some(whitelist_pattern) = pattern.strip_prefix('!') {
            if simple_glob_match(whitelist_pattern, path) {
                return true;
            }
        }
    }
    false
}

fn is_path_essential(path: &str) -> bool {
    for pattern in ESSENTIAL_PATTERNS {
        if simple_glob_match(pattern, path) {
            return true;
        }
    }
    false
}

fn get_matching_essential_pattern(path: &str) -> Option<String> {
    for pattern in ESSENTIAL_PATTERNS {
        if simple_glob_match(pattern, path) {
            return Some(pattern.to_string());
        }
    }
    None
}

fn file_modified_time(path: &Path) -> Option<String> {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| {
            let dt: DateTime<Utc> = t.into();
            dt.to_rfc3339()
        })
}

fn file_size(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().map(|m| m.len())
}

fn count_children(path: &Path) -> Option<u32> {
    fs::read_dir(path).ok().map(|d| d.count() as u32)
}

#[tauri::command]
pub async fn sync_tree_list_dir(path: Option<String>) -> Result<Vec<SyncTreeNode>, String> {
    let datasites_path = get_datasites_path()?;
    let syftignore_path = get_syftignore_path()?;
    let syftsub_path = get_syftsub_path()?;

    let ignore_patterns = read_ignore_patterns(&syftignore_path);
    let subs_cfg = biovault::subscriptions::load(&syftsub_path)
        .unwrap_or_else(|_| biovault::subscriptions::default_config());
    let mut subs_cfg = subs_cfg;
    sanitize_subscription_rules(&mut subs_cfg);
    let owner_email = load_owner_email();

    let target_path = match &path {
        Some(p) => datasites_path.join(p),
        None => datasites_path.clone(),
    };

    if !target_path.exists() {
        return Ok(vec![]);
    }

    let entries =
        fs::read_dir(&target_path).map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut nodes: Vec<SyncTreeNode> = Vec::new();

    for entry in entries.flatten() {
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') {
            continue;
        }

        let is_dir = entry_path.is_dir();
        let relative_path = match &path {
            Some(p) => format!("{}/{}", p, name),
            None => name.clone(),
        };

        let is_essential = is_path_essential(&relative_path);
        let subscription_action =
            biovault::subscriptions::action_for_path(&subs_cfg, &owner_email, &relative_path);
        let is_subscribed = subscription_action == biovault::subscriptions::Action::Allow;
        let base_ignored = is_path_ignored(&relative_path, &ignore_patterns).is_some()
            && !is_path_whitelisted(&relative_path, &ignore_patterns);
        let is_ignored = if is_subscribed {
            false
        } else {
            !is_essential && base_ignored
        };

        let (child_count, has_mixed_state, has_mixed_ignore) = if is_dir {
            let count = count_children(&entry_path);
            (count, false, false)
        } else {
            (None, false, false)
        };

        nodes.push(SyncTreeNode {
            name,
            path: relative_path,
            is_dir,
            size: if is_dir { None } else { file_size(&entry_path) },
            sync_state: "completed".to_string(),
            conflict_state: "none".to_string(),
            progress: None,
            is_ignored,
            is_essential,
            is_subscribed,
            child_count,
            has_mixed_state,
            has_mixed_ignore,
            last_modified: file_modified_time(&entry_path),
        });
    }

    nodes.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(nodes)
}

#[tauri::command]
pub async fn sync_tree_get_details(path: String) -> Result<SyncTreeDetails, String> {
    let datasites_path = get_datasites_path()?;
    let syftignore_path = get_syftignore_path()?;
    let syftsub_path = get_syftsub_path()?;
    let ignore_patterns = read_ignore_patterns(&syftignore_path);
    let subs_cfg = biovault::subscriptions::load(&syftsub_path)
        .unwrap_or_else(|_| biovault::subscriptions::default_config());
    let mut subs_cfg = subs_cfg;
    sanitize_subscription_rules(&mut subs_cfg);
    let owner_email = load_owner_email();

    let full_path = datasites_path.join(&path);

    if !full_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    let is_dir = full_path.is_dir();
    let name = full_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let size = if is_dir {
        calculate_dir_size(&full_path)
    } else {
        file_size(&full_path).unwrap_or(0)
    };

    let file_count = if is_dir {
        Some(count_files_recursive(&full_path))
    } else {
        None
    };

    let essential_pattern = get_matching_essential_pattern(&path);
    let is_essential = essential_pattern.is_some();
    let ignore_match = is_path_ignored(&path, &ignore_patterns);
    let subscription_action =
        biovault::subscriptions::action_for_path(&subs_cfg, &owner_email, &path);
    let is_subscribed = subscription_action == biovault::subscriptions::Action::Allow;
    let base_ignored = ignore_match.is_some() && !is_path_whitelisted(&path, &ignore_patterns);
    let is_ignored = if is_subscribed {
        false
    } else {
        !is_essential && base_ignored
    };

    // Get file type and content for preview
    let (file_type, file_content, syft_pub_info) = if !is_dir {
        get_file_preview(&full_path, &name, size)
    } else {
        (None, None, None)
    };

    Ok(SyncTreeDetails {
        path: path.clone(),
        name,
        is_dir,
        size,
        file_count,
        sync_state: "completed".to_string(),
        conflict_state: "none".to_string(),
        progress: None,
        error: None,
        error_count: 0,
        last_modified: file_modified_time(&full_path),
        last_synced: None,
        etag: None,
        local_etag: None,
        upload_id: None,
        uploaded_bytes: None,
        total_bytes: None,
        is_ignored,
        ignore_pattern: if is_subscribed { None } else { ignore_match },
        is_essential,
        essential_pattern,
        is_priority: path.contains(".request") || path.contains(".response"),
        file_content,
        file_type,
        syft_pub_info,
    })
}

const MAX_PREVIEW_SIZE: u64 = 50 * 1024; // 50KB limit for preview

fn get_file_preview(
    path: &Path,
    name: &str,
    size: u64,
) -> (Option<String>, Option<String>, Option<SyftPubInfo>) {
    let ext = name.split('.').next_back().unwrap_or("").to_lowercase();

    // Only preview certain file types
    let file_type = match ext.as_str() {
        "json" => Some("json".to_string()),
        "yaml" | "yml" => Some("yaml".to_string()),
        "md" => Some("markdown".to_string()),
        "txt" => Some("text".to_string()),
        _ => None,
    };

    // Don't read large files
    if size > MAX_PREVIEW_SIZE {
        return (file_type, None, None);
    }

    // Read content for previewable files
    let file_content = if file_type.is_some() {
        fs::read_to_string(path).ok()
    } else {
        None
    };

    // Parse syft.pub.yaml specially
    let syft_pub_info = if name == "syft.pub.yaml" {
        file_content.as_ref().and_then(|c| parse_syft_pub_yaml(c))
    } else {
        None
    };

    (file_type, file_content, syft_pub_info)
}

fn parse_syft_pub_yaml(content: &str) -> Option<SyftPubInfo> {
    // Try parsing as a root-level list of permissions first (common format)
    if let Ok(perms) = serde_yaml::from_str::<Vec<SyftPermission>>(content) {
        let permissions = perms
            .into_iter()
            .map(|p| SyftPubPermission {
                is_wildcard: p.user == "*",
                user: p.user,
                access: p.access,
            })
            .collect();
        return Some(SyftPubInfo {
            permissions,
            description: None,
        });
    }

    // Try parsing as structured object with permissions key
    if let Ok(parsed) = serde_yaml::from_str::<SyftPubYaml>(content) {
        let permissions = parsed
            .permissions
            .into_iter()
            .map(|p| SyftPubPermission {
                is_wildcard: p.user == "*",
                user: p.user,
                access: p.access,
            })
            .collect();
        return Some(SyftPubInfo {
            permissions,
            description: parsed.metadata.and_then(|m| m.description),
        });
    }

    None
}

#[tauri::command]
pub async fn sync_tree_get_ignore_patterns() -> Result<SyncIgnorePatterns, String> {
    let syftignore_path = get_syftignore_path()?;
    let patterns = read_ignore_patterns(&syftignore_path);

    let default_patterns = vec![
        "*.tmp".to_string(),
        "*.log".to_string(),
        ".DS_Store".to_string(),
        "Thumbs.db".to_string(),
        ".git/".to_string(),
        "__pycache__/".to_string(),
        "node_modules/".to_string(),
    ];

    let custom_patterns = patterns
        .into_iter()
        .filter(|p| !default_patterns.contains(p))
        .collect();

    Ok(SyncIgnorePatterns {
        default_patterns,
        custom_patterns,
        syftignore_path: syftignore_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn sync_tree_add_ignore(pattern: String) -> Result<(), String> {
    let syftignore_path = get_syftignore_path()?;
    let mut patterns = read_ignore_patterns(&syftignore_path);

    if !patterns.contains(&pattern) {
        patterns.push(pattern);
        write_ignore_patterns(&syftignore_path, &patterns)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn sync_tree_remove_ignore(pattern: String) -> Result<(), String> {
    let syftignore_path = get_syftignore_path()?;
    let mut patterns = read_ignore_patterns(&syftignore_path);

    patterns.retain(|p| p != &pattern);
    write_ignore_patterns(&syftignore_path, &patterns)?;

    Ok(())
}

/// Initialize syftignore with default sync policy if it doesn't exist or is empty.
/// Default policy: ignore everything except essential BioVault paths.
#[tauri::command]
pub async fn sync_tree_init_default_policy() -> Result<bool, String> {
    let syftignore_path = get_syftignore_path()?;

    // Check if file exists and has content
    let existing = fs::read_to_string(&syftignore_path).unwrap_or_default();
    if !existing.trim().is_empty() {
        return Ok(false); // Already initialized
    }

    // Default policy: ignore everything, whitelist essential paths
    let default_patterns = vec![
        "# SyftBox Default Sync Policy".to_string(),
        "# Ignore everything by default, whitelist essential paths".to_string(),
        "".to_string(),
        "# Ignore all files by default".to_string(),
        "*".to_string(),
        "".to_string(),
        "# Essential BioVault paths (whitelisted)".to_string(),
        "!*/public/crypto/did.json".to_string(),
        "!*/public/biovault/datasets.yaml".to_string(),
        "!*/public/biovault/datasets/*/dataset.yaml".to_string(),
        "!*/app_data/biovault/*.yaml".to_string(),
        "!**/syft.pub.yaml".to_string(),
        "".to_string(),
        "# Request/Response files for sync coordination".to_string(),
        "!**/*.request".to_string(),
        "!**/*.response".to_string(),
    ];

    write_ignore_patterns(&syftignore_path, &default_patterns)?;
    Ok(true) // Initialized successfully
}

/// Structure for parsing syft.pub.yaml permission entries
#[derive(Deserialize, Debug)]
struct SyftPubYaml {
    #[serde(default)]
    permissions: Vec<SyftPermission>,
    #[serde(default)]
    metadata: Option<SyftMetadata>,
}

#[derive(Deserialize, Debug)]
struct SyftPermission {
    user: String,
    access: String,
}

#[derive(Deserialize, Debug)]
struct SyftMetadata {
    description: Option<String>,
}

/// Find all content shared with the current user by scanning syft.pub.yaml files
#[tauri::command]
pub async fn sync_tree_get_shared_with_me() -> Result<Vec<SharedWithMeItem>, String> {
    let runtime = load_runtime_config()?;
    let datasites_path = PathBuf::from(&runtime.data_dir).join("datasites");
    let syftignore_path = get_syftignore_path()?;
    let ignore_patterns = read_ignore_patterns(&syftignore_path);

    let current_email = runtime.email.clone();
    let mut shared_items: Vec<SharedWithMeItem> = Vec::new();

    // Scan all datasites for syft.pub.yaml files
    if let Ok(datasites) = fs::read_dir(&datasites_path) {
        for datasite in datasites.flatten() {
            let datasite_name = datasite.file_name().to_string_lossy().to_string();

            // Skip our own datasite
            if datasite_name == current_email {
                continue;
            }

            // Skip hidden directories
            if datasite_name.starts_with('.') {
                continue;
            }

            // Recursively find syft.pub.yaml files
            find_shared_in_datasite(
                &datasite.path(),
                &datasite_name,
                &current_email,
                &ignore_patterns,
                &mut shared_items,
            );
        }
    }

    Ok(shared_items)
}

fn find_shared_in_datasite(
    path: &Path,
    owner: &str,
    current_user: &str,
    ignore_patterns: &[String],
    items: &mut Vec<SharedWithMeItem>,
) {
    let pub_yaml = path.join("syft.pub.yaml");
    if pub_yaml.exists() {
        if let Ok(content) = fs::read_to_string(&pub_yaml) {
            if let Ok(parsed) = serde_yaml::from_str::<SyftPubYaml>(&content) {
                // Check if current user has access
                for perm in &parsed.permissions {
                    if (perm.user == current_user || perm.user == "*") && perm.access != "none" {
                        // Get relative path from datasites
                        let relative_path = path
                            .to_string_lossy()
                            .split("/datasites/")
                            .last()
                            .unwrap_or("")
                            .to_string();

                        // Check if already subscribed (whitelisted)
                        let is_subscribed = is_path_whitelisted(&relative_path, ignore_patterns);

                        items.push(SharedWithMeItem {
                            owner: owner.to_string(),
                            path: relative_path,
                            description: parsed
                                .metadata
                                .as_ref()
                                .and_then(|m| m.description.clone()),
                            access: perm.access.clone(),
                            is_subscribed,
                        });
                        break;
                    }
                }
            }
        }
    }

    // Recursively check subdirectories
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with('.') {
                    find_shared_in_datasite(
                        &entry_path,
                        owner,
                        current_user,
                        ignore_patterns,
                        items,
                    );
                }
            }
        }
    }
}

/// Subscribe to shared content by adding whitelist pattern to syftignore
#[tauri::command]
pub async fn sync_tree_subscribe(path: String) -> Result<(), String> {
    let syftignore_path = get_syftignore_path()?;
    let mut patterns = read_ignore_patterns(&syftignore_path);

    // Add whitelist pattern for this path
    let whitelist = format!("!{}/**", path);
    if !patterns.contains(&whitelist) {
        patterns.push(whitelist);
        write_ignore_patterns(&syftignore_path, &patterns)?;
    }

    Ok(())
}

/// Unsubscribe from shared content by removing whitelist pattern
#[tauri::command]
pub async fn sync_tree_unsubscribe(path: String) -> Result<(), String> {
    let syftignore_path = get_syftignore_path()?;
    let mut patterns = read_ignore_patterns(&syftignore_path);

    // Remove whitelist patterns for this path
    let whitelist = format!("!{}/**", path);
    let whitelist_exact = format!("!{}", path);
    patterns.retain(|p| p != &whitelist && p != &whitelist_exact);

    write_ignore_patterns(&syftignore_path, &patterns)?;
    Ok(())
}

#[tauri::command]
pub async fn sync_tree_set_subscription(
    path: String,
    allow: bool,
    is_dir: bool,
) -> Result<(), String> {
    let syftsub_path = get_syftsub_path()?;
    let mut cfg = biovault::subscriptions::load(&syftsub_path)
        .unwrap_or_else(|_| biovault::subscriptions::default_config());
    sanitize_subscription_rules(&mut cfg);

    let normalized = normalize_subscription_path(&path);
    let (datasite, rest) = split_datasite(&normalized);
    if datasite.trim().is_empty() {
        return Err("Invalid path (missing datasite)".to_string());
    }
    if !is_valid_datasite_selector(&datasite) {
        return Err(format!(
            "Invalid datasite selector: {} (expected '*' or email)",
            datasite
        ));
    }

    let path_within = if is_dir {
        if rest.trim().is_empty() {
            "**".to_string()
        } else {
            format!("{}/**", rest.trim_end_matches('/'))
        }
    } else {
        rest.trim_end_matches('/').to_string()
    };

    let target_prefix = strip_glob_suffix(&path_within);
    cfg.rules.retain(|rule| {
        if rule
            .datasite
            .as_deref()
            .map(|ds| ds.eq_ignore_ascii_case(&datasite))
            .unwrap_or(false)
        {
            let rule_path = normalize_subscription_path(&rule.path);
            let rule_prefix = strip_glob_suffix(&rule_path);
            if is_dir {
                return !rule_prefix.starts_with(&target_prefix);
            }
            return rule_prefix != target_prefix;
        }
        true
    });

    let action = if allow {
        biovault::subscriptions::Action::Allow
    } else {
        biovault::subscriptions::Action::Block
    };

    cfg.rules.push(biovault::subscriptions::Rule {
        action,
        datasite: Some(datasite.clone()),
        path: path_within,
    });

    if !allow && is_dir {
        let essentials = essential_rules_for_subtree(&datasite, &target_prefix);
        for rule in essentials {
            cfg.rules.push(rule);
        }
    }

    biovault::subscriptions::save(&syftsub_path, &cfg)
        .map_err(|e| format!("Failed to write syft.sub.yaml: {}", e))?;
    Ok(())
}

fn read_ignore_patterns(path: &Path) -> Vec<String> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|l| l.to_string())
        .filter(|l| !l.trim().is_empty())
        .collect()
}

fn write_ignore_patterns(path: &Path, patterns: &[String]) -> Result<(), String> {
    let content = patterns.join("\n");
    fs::write(path, content).map_err(|e| format!("Failed to write syftignore: {}", e))
}

fn calculate_dir_size(path: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                total += calculate_dir_size(&entry_path);
            } else {
                total += file_size(&entry_path).unwrap_or(0);
            }
        }
    }
    total
}

fn count_files_recursive(path: &Path) -> u32 {
    let mut count = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                count += count_files_recursive(&entry_path);
            } else {
                count += 1;
            }
        }
    }
    count
}
