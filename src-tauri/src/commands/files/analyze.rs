use crate::types::AppState;
use std::collections::HashMap;

// Re-export GenotypeMetadata from parent module
use super::GenotypeMetadata;

#[tauri::command]
pub async fn detect_file_types(
    _state: tauri::State<'_, AppState>,
    files: Vec<String>,
) -> Result<HashMap<String, GenotypeMetadata>, String> {
    if files.is_empty() {
        return Ok(HashMap::new());
    }

    crate::desktop_log!(
        "🔍 Detecting file types for {} files (using library)",
        files.len()
    );

    let mut results = HashMap::new();

    for file_path in files {
        let metadata = biovault::data::detect_genotype_metadata(&file_path).unwrap_or_else(|e| {
            crate::desktop_log!("⚠️  Failed to detect {}: {}", file_path, e);
            biovault::data::GenotypeMetadata::default()
        });

        crate::desktop_log!(
            "📊 Detection for {}: data_type={:?}, source={:?}, grch={:?}",
            file_path,
            metadata.data_type,
            metadata.source,
            metadata.grch_version
        );

        results.insert(
            file_path.clone(),
            GenotypeMetadata {
                data_type: metadata.data_type,
                source: metadata.source,
                grch_version: metadata.grch_version,
                row_count: metadata.row_count,
                chromosome_count: metadata.chromosome_count,
                inferred_sex: metadata.inferred_sex,
            },
        );
    }

    crate::desktop_log!("✅ Detected {} file types", results.len());
    Ok(results)
}

#[tauri::command]
pub async fn analyze_file_types(
    _state: tauri::State<'_, AppState>,
    files: Vec<String>,
) -> Result<HashMap<String, GenotypeMetadata>, String> {
    if files.is_empty() {
        return Ok(HashMap::new());
    }

    crate::desktop_log!(
        "🔬 Analyzing files for row count, chromosomes, and sex: {} files (using library)",
        files.len()
    );

    let mut results = HashMap::new();

    for file_path in files {
        let metadata = biovault::data::analyze_genotype_file(&file_path).unwrap_or_else(|e| {
            crate::desktop_log!("⚠️  Failed to analyze {}: {}", file_path, e);
            biovault::data::GenotypeMetadata::default()
        });

        results.insert(
            file_path.clone(),
            GenotypeMetadata {
                data_type: metadata.data_type,
                source: metadata.source,
                grch_version: metadata.grch_version,
                row_count: metadata.row_count,
                chromosome_count: metadata.chromosome_count,
                inferred_sex: metadata.inferred_sex,
            },
        );
    }

    crate::desktop_log!("✅ Analyzed {} files", results.len());
    Ok(results)
}
