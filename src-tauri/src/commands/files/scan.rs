use crate::types::{ExtensionCount, PatternSuggestion, SampleExtraction};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

#[tauri::command]
pub fn get_extensions(path: String) -> Result<Vec<ExtensionCount>, String> {
    eprintln!(
        "🔍 get_extensions called for path: {} (using library)",
        path
    );

    let scan_result = biovault::data::scan(&path, None, true)
        .map_err(|e| format!("Failed to scan directory: {}", e))?;

    let extensions: Vec<ExtensionCount> = scan_result
        .extensions
        .into_iter()
        .map(|ext| ExtensionCount {
            extension: ext.extension,
            count: ext.count,
        })
        .collect();

    eprintln!("✅ Found {} extensions", extensions.len());
    Ok(extensions)
}

#[tauri::command]
pub fn search_txt_files(path: String, extensions: Vec<String>) -> Result<Vec<String>, String> {
    eprintln!(
        "🔍 search_txt_files called for path: {} with {} extensions (using library)",
        path,
        extensions.len()
    );

    if extensions.is_empty() {
        return Ok(Vec::new());
    }

    // Scan recursively for all files
    let scan_result = biovault::data::scan(&path, None, true)
        .map_err(|e| format!("Failed to scan directory: {}", e))?;

    // Normalize extensions (add leading dot if missing)
    let normalized_exts: Vec<String> = extensions
        .iter()
        .map(|ext| {
            if ext.starts_with('.') {
                ext.clone()
            } else {
                format!(".{}", ext)
            }
        })
        .collect();

    // Filter files by extension
    let filtered_files: Vec<String> = scan_result
        .files
        .into_iter()
        .filter(|file| {
            if let Some(ext) = std::path::Path::new(&file.path).extension() {
                let ext_with_dot = format!(".{}", ext.to_string_lossy());
                normalized_exts.contains(&ext_with_dot)
            } else {
                false
            }
        })
        .map(|file| file.path)
        .collect();

    eprintln!(
        "✅ Found {} files matching extensions",
        filtered_files.len()
    );
    Ok(filtered_files)
}

#[tauri::command]
pub fn suggest_patterns(files: Vec<String>) -> Result<Vec<PatternSuggestion>, String> {
    eprintln!(
        "🔍 suggest_patterns called with {} files (using library)",
        files.len()
    );

    if files.is_empty() {
        return Ok(vec![]);
    }

    let paths: Vec<PathBuf> = files.iter().map(PathBuf::from).collect();

    let common_root = find_common_root(&paths)
        .or_else(|| {
            paths
                .first()
                .and_then(|p| p.parent().map(|parent| parent.to_path_buf()))
        })
        .ok_or("Unable to determine common directory")?;

    let dir = common_root
        .to_str()
        .ok_or("Failed to convert directory to UTF-8 string")?;

    // Collect unique extensions from provided files
    let mut extensions: HashSet<String> = HashSet::new();
    for file in &paths {
        if let Some(ext) = file.extension().and_then(|e| e.to_str()) {
            extensions.insert(format!(".{}", ext));
        }
    }

    let extension_filter = if extensions.len() == 1 {
        extensions.iter().next().map(|s| s.as_str())
    } else {
        None
    };

    eprintln!(
        "📂 Analyzing directory: {}{}",
        dir,
        extension_filter
            .map(|ext| format!(" with extension: {}", ext))
            .unwrap_or_default()
    );

    let result = biovault::data::suggest_patterns(dir, extension_filter, true)
        .map_err(|e| format!("Failed to suggest patterns: {}", e))?;

    eprintln!("\n=== PATTERN SUGGESTIONS ===");
    for (idx, suggestion) in result.suggestions.iter().enumerate() {
        eprintln!("\n📋 Suggestion #{}", idx + 1);
        eprintln!("   Pattern: {}", suggestion.pattern);
        eprintln!("   Description: {}", suggestion.description);
        eprintln!("   Example: {}", suggestion.example);
        eprintln!("   Sample extractions:");
        for (filename, extracted_id) in &suggestion.sample_extractions {
            eprintln!("      {} → {}", filename, extracted_id);
        }
    }
    eprintln!("\n=== END SUGGESTIONS ===\n");

    let suggestions: Vec<PatternSuggestion> = result
        .suggestions
        .into_iter()
        .map(|s| PatternSuggestion {
            pattern: s.pattern,
            regex_pattern: s.regex_pattern,
            description: s.description,
            example: s.example,
            sample_extractions: s
                .sample_extractions
                .into_iter()
                .map(|(path, participant_id)| SampleExtraction {
                    path,
                    participant_id,
                })
                .collect(),
        })
        .collect();

    eprintln!("✅ Found {} pattern suggestions", suggestions.len());
    Ok(suggestions)
}

#[tauri::command]
pub fn extract_ids_for_files(
    files: Vec<String>,
    pattern: String,
) -> Result<HashMap<String, Option<String>>, String> {
    let trimmed = pattern.trim().to_string();
    if trimmed.is_empty() {
        return Ok(files.into_iter().map(|f| (f, None)).collect());
    }

    let mut results = HashMap::new();
    for file in files {
        let extracted = biovault::data::extract_id_from_pattern(&file, &trimmed)
            .map_err(|e| format!("Failed to extract ID for {}: {}", file, e))?;
        results.insert(file, extracted);
    }

    Ok(results)
}

/// Check if a path is a directory
#[tauri::command]
pub fn is_directory(path: String) -> Result<bool, String> {
    let path_buf = PathBuf::from(&path);
    Ok(path_buf.is_dir())
}

/// Find the common root directory of multiple paths
fn find_common_root(paths: &[PathBuf]) -> Option<PathBuf> {
    if paths.is_empty() {
        return None;
    }

    // Start with the parent directory of the first file
    let mut common = paths[0].parent()?.to_path_buf();

    // For each other path, find the common ancestor
    for path in &paths[1..] {
        let path_parent = path.parent()?;

        // Keep going up until we find a common ancestor
        while !path_parent.starts_with(&common) {
            common = common.parent()?.to_path_buf();
        }
    }

    Some(common)
}
