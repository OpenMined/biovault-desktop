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

    eprintln!(
        "🔍 Detecting file types for {} files (using library)",
        files.len()
    );

    let mut results = HashMap::new();

    for file_path in files {
        let metadata = biovault::data::detect_genotype_metadata(&file_path).unwrap_or_else(|e| {
            eprintln!("⚠️  Failed to detect {}: {}", file_path, e);
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

    eprintln!("✅ Detected {} file types", results.len());
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

    eprintln!(
        "🔬 Analyzing files for row count, chromosomes, and sex: {} files (using library)",
        files.len()
    );

    let mut results = HashMap::new();

    for file_path in files {
        let metadata = biovault::data::analyze_genotype_file(&file_path).unwrap_or_else(|e| {
            eprintln!("⚠️  Failed to analyze {}: {}", file_path, e);
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

    eprintln!("✅ Analyzed {} files", results.len());
    Ok(results)
}
