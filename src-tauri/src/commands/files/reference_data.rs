use serde::Serialize;
use serde_json::json;
use std::sync::Arc;
use tauri::Emitter;

#[derive(Serialize)]
pub struct ReferenceDownloadResult {
    pub reference_dir: String,
}

fn grch38_ref_url() -> &'static str {
    "https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/technical/reference/GRCh38_reference_genome/GRCh38_full_analysis_set_plus_decoy_hla.fa"
}

fn grch38_ref_index_url() -> &'static str {
    "https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/technical/reference/GRCh38_reference_genome/GRCh38_full_analysis_set_plus_decoy_hla.fa.fai"
}

#[tauri::command]
pub async fn fetch_reference_data() -> Result<ReferenceDownloadResult, String> {
    fetch_reference_data_internal(None).await
}

#[tauri::command]
pub async fn fetch_reference_data_with_progress(
    window: tauri::WebviewWindow,
) -> Result<ReferenceDownloadResult, String> {
    fetch_reference_data_internal(Some(window)).await
}

async fn fetch_reference_data_internal(
    window: Option<tauri::WebviewWindow>,
) -> Result<ReferenceDownloadResult, String> {
    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to resolve BioVault home: {}", e))?;
    let reference_dir = biovault_home.join("data").join("reference").join("GRCh38");
    std::fs::create_dir_all(&reference_dir)
        .map_err(|e| format!("Failed to create reference directory: {}", e))?;

    let mut cache = biovault::cli::download_cache::DownloadCache::new(None)
        .map_err(|e| format!("Failed to initialize download cache: {}", e))?;

    let mut options = biovault::cli::download_cache::DownloadOptions::default();
    options.show_progress = false;

    let make_reporter = |window: &tauri::WebviewWindow, label: &'static str| {
        let window = window.clone();
        Arc::new(move |downloaded, total| {
            let _ = window.emit(
                "download-progress",
                json!({
                    "id": "grch38",
                    "file": label,
                    "downloaded": downloaded,
                    "total": total
                }),
            );
        }) as Arc<dyn Fn(u64, u64) + Send + Sync>
    };

    let ref_path = reference_dir.join("GRCh38_full_analysis_set_plus_decoy_hla.fa");
    let mut ref_options = options.clone();
    if let Some(window) = window.as_ref() {
        ref_options.progress_callback = Some(make_reporter(window, "GRCh38 reference"));
    }
    cache
        .download_with_cache(grch38_ref_url(), &ref_path, ref_options)
        .await
        .map_err(|e| format!("Failed to download GRCh38 reference: {}", e))?;

    let ref_index_path = reference_dir.join("GRCh38_full_analysis_set_plus_decoy_hla.fa.fai");
    let mut index_options = options;
    if let Some(window) = window.as_ref() {
        index_options.progress_callback = Some(make_reporter(window, "GRCh38 reference index"));
    }
    cache
        .download_with_cache(grch38_ref_index_url(), &ref_index_path, index_options)
        .await
        .map_err(|e| format!("Failed to download GRCh38 reference index: {}", e))?;

    Ok(ReferenceDownloadResult {
        reference_dir: reference_dir.to_string_lossy().to_string(),
    })
}
