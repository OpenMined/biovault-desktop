use serde::Serialize;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

static DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
pub struct SampleDataFetchResult {
    pub sample_dir: String,
}

#[tauri::command]
pub async fn cancel_sample_download() -> Result<(), String> {
    DOWNLOAD_CANCELLED.store(true, Ordering::SeqCst);
    Ok(())
}

fn dynamic_dna_url() -> &'static str {
    "https://raw.githubusercontent.com/OpenMined/biovault-data/main/snp/genotype_files/build_38/100001/100001_X_X_GSAv3-DTC_GRCh38-07-01-2025.txt"
}

#[tauri::command]
pub async fn fetch_sample_data(samples: Vec<String>) -> Result<SampleDataFetchResult, String> {
    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to resolve BioVault home: {}", e))?;
    let sample_dir = biovault_home.join("data").join("sample");

    let mut preferred_dir: Option<String> = None;
    let mut wants_na06985_chry = false;
    let mut wants_na06985_full = false;

    let mut participant_ids: Vec<String> = Vec::new();
    let mut fetch_dynamic = false;

    for sample in samples {
        let key = sample.trim().to_lowercase();
        match key.as_str() {
            "na06985-chry" | "na06985-chr-y" | "na06985-chr_y" | "na06985-chry-raw" => {
                participant_ids.push("NA06985-chrY".to_string());
                wants_na06985_chry = true;
                if preferred_dir.is_none() {
                    preferred_dir = Some(
                        sample_dir
                            .join("NA06985-chrY-import")
                            .to_string_lossy()
                            .to_string(),
                    );
                }
            }
            "na06985-full" | "na06985" => {
                participant_ids.push("NA06985".to_string());
                wants_na06985_full = true;
                if preferred_dir.is_none() {
                    preferred_dir = Some(
                        sample_dir
                            .join("NA06985-import")
                            .to_string_lossy()
                            .to_string(),
                    );
                }
            }
            "dynamic-dna" | "dynamicdna" | "dynamic_dna" => {
                fetch_dynamic = true;
                if preferred_dir.is_none() {
                    preferred_dir =
                        Some(sample_dir.join("dynamic-dna").to_string_lossy().to_string());
                }
            }
            "23andme" => {
                participant_ids.push("23andme".to_string());
                if preferred_dir.is_none() {
                    preferred_dir = Some(sample_dir.join("23andme").to_string_lossy().to_string());
                }
            }
            _ => {
                participant_ids.push(sample);
            }
        }
    }

    if !participant_ids.is_empty() {
        biovault::cli::commands::sample_data::fetch(Some(participant_ids), false, true)
            .await
            .map_err(|e| format!("Failed to fetch sample data: {}", e))?;
    }

    if fetch_dynamic {
        let participant_dir = sample_dir.join("dynamic-dna");
        std::fs::create_dir_all(&participant_dir)
            .map_err(|e| format!("Failed to create sample directory: {}", e))?;

        let filename = "100001_X_X_GSAv3-DTC_GRCh38-07-01-2025.txt";
        let target_path = participant_dir.join(filename);

        let mut cache = biovault::cli::download_cache::DownloadCache::new(None)
            .map_err(|e| format!("Failed to initialize download cache: {}", e))?;

        let mut options = biovault::cli::download_cache::DownloadOptions::default();
        options.show_progress = false;
        cache
            .download_with_cache(dynamic_dna_url(), &target_path, options)
            .await
            .map_err(|e| format!("Failed to download Dynamic DNA sample: {}", e))?;
    }

    if wants_na06985_chry {
        prepare_participant_bundle(&sample_dir, "NA06985-chrY")
            .map_err(|e| format!("Failed to prepare NA06985-chrY import folder: {}", e))?;
    }
    if wants_na06985_full {
        prepare_participant_bundle(&sample_dir, "NA06985")
            .map_err(|e| format!("Failed to prepare NA06985 import folder: {}", e))?;
    }

    Ok(SampleDataFetchResult {
        sample_dir: preferred_dir.unwrap_or_else(|| sample_dir.to_string_lossy().to_string()),
    })
}

#[tauri::command]
pub async fn fetch_sample_data_with_progress(
    window: tauri::WebviewWindow,
    samples: Vec<String>,
) -> Result<SampleDataFetchResult, String> {
    let reporter: biovault::cli::commands::sample_data::ProgressReporter =
        std::sync::Arc::new(move |label, downloaded, total| {
            let _ = window.emit(
                "download-progress",
                json!({
                    "id": "sample_data",
                    "file": label,
                    "downloaded": downloaded,
                    "total": total
                }),
            );
        });

    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to resolve BioVault home: {}", e))?;
    let sample_dir = biovault_home.join("data").join("sample");

    let mut preferred_dir: Option<String> = None;
    let mut wants_na06985_chry = false;
    let mut wants_na06985_full = false;
    let mut participant_ids: Vec<String> = Vec::new();
    let mut fetch_dynamic = false;

    for sample in samples.clone() {
        let key = sample.trim().to_lowercase();
        match key.as_str() {
            "na06985-chry" | "na06985-chr-y" | "na06985-chr_y" | "na06985-chry-raw" => {
                participant_ids.push("NA06985-chrY".to_string());
                wants_na06985_chry = true;
                if preferred_dir.is_none() {
                    preferred_dir = Some(
                        sample_dir
                            .join("NA06985-chrY-import")
                            .to_string_lossy()
                            .to_string(),
                    );
                }
            }
            "na06985-full" | "na06985" => {
                participant_ids.push("NA06985".to_string());
                wants_na06985_full = true;
                if preferred_dir.is_none() {
                    preferred_dir = Some(
                        sample_dir
                            .join("NA06985-import")
                            .to_string_lossy()
                            .to_string(),
                    );
                }
            }
            "dynamic-dna" | "dynamicdna" | "dynamic_dna" => {
                fetch_dynamic = true;
                if preferred_dir.is_none() {
                    preferred_dir =
                        Some(sample_dir.join("dynamic-dna").to_string_lossy().to_string());
                }
            }
            "23andme" => {
                participant_ids.push("23andme".to_string());
                if preferred_dir.is_none() {
                    preferred_dir = Some(sample_dir.join("23andme").to_string_lossy().to_string());
                }
            }
            _ => {
                participant_ids.push(sample);
            }
        }
    }

    if !participant_ids.is_empty() {
        biovault::cli::commands::sample_data::fetch_with_progress(
            Some(participant_ids),
            false,
            true,
            Some(reporter),
        )
        .await
        .map_err(|e| format!("Failed to fetch sample data: {}", e))?;
    }

    if fetch_dynamic {
        let participant_dir = sample_dir.join("dynamic-dna");
        std::fs::create_dir_all(&participant_dir)
            .map_err(|e| format!("Failed to create sample directory: {}", e))?;

        let filename = "100001_X_X_GSAv3-DTC_GRCh38-07-01-2025.txt";
        let target_path = participant_dir.join(filename);

        let mut cache = biovault::cli::download_cache::DownloadCache::new(None)
            .map_err(|e| format!("Failed to initialize download cache: {}", e))?;

        let mut options = biovault::cli::download_cache::DownloadOptions::default();
        options.show_progress = false;
        cache
            .download_with_cache(
                "https://raw.githubusercontent.com/OpenMined/biovault-data/main/snp/genotype_files/build_38/100001/100001_X_X_GSAv3-DTC_GRCh38-07-01-2025.txt",
                &target_path,
                options,
            )
            .await
            .map_err(|e| format!("Failed to download Dynamic DNA sample: {}", e))?;
    }

    if wants_na06985_chry {
        prepare_participant_bundle(&sample_dir, "NA06985-chrY")
            .map_err(|e| format!("Failed to prepare NA06985-chrY import folder: {}", e))?;
    }
    if wants_na06985_full {
        prepare_participant_bundle(&sample_dir, "NA06985")
            .map_err(|e| format!("Failed to prepare NA06985 import folder: {}", e))?;
    }

    Ok(SampleDataFetchResult {
        sample_dir: preferred_dir.unwrap_or_else(|| sample_dir.to_string_lossy().to_string()),
    })
}

fn link_or_copy_file(source: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() || dest.is_symlink() {
        let _ = fs::remove_file(dest);
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let link_result = {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(source, dest).map_err(|e| e.to_string())
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(source, dest).map_err(|e| e.to_string())
        }
    };
    if let Err(err) = link_result {
        fs::copy(source, dest).map_err(|e| format!("Failed to symlink ({err}) and copy: {e}"))?;
    }
    Ok(())
}

fn prepare_participant_bundle(sample_dir: &Path, participant_id: &str) -> Result<PathBuf, String> {
    let bundle_dir = sample_dir.join(format!("{}-import", participant_id));
    fs::create_dir_all(&bundle_dir).map_err(|e| e.to_string())?;

    let mut sources: Vec<PathBuf> = Vec::new();
    if let Some(paths) = resolve_participant_paths(sample_dir, participant_id) {
        sources.extend(paths);
    }

    if sources.is_empty() {
        let ref_dir = sample_dir.join("reference");
        let participant_dir = sample_dir.join(participant_id);
        // Handle both chrY and full samples
        if participant_id == "NA06985-chrY" {
            sources.push(ref_dir.join("GRCh38_chrY.fa"));
            sources.push(ref_dir.join("GRCh38_chrY.fa.fai"));
            sources.push(participant_dir.join("NA06985.final.chrY.cram"));
            sources.push(participant_dir.join("NA06985.final.chrY.cram.crai"));
        } else if participant_id == "NA06985" {
            sources.push(ref_dir.join("GRCh38_full_analysis_set_plus_decoy_hla.fa"));
            sources.push(ref_dir.join("GRCh38_full_analysis_set_plus_decoy_hla.fa.fai"));
            sources.push(participant_dir.join("NA06985.final.cram"));
            sources.push(participant_dir.join("NA06985.final.cram.crai"));
        }
    }

    let mut linked = 0usize;
    for source in sources {
        if source.exists() {
            let name = source
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "sample".to_string());
            let dest = bundle_dir.join(name);
            link_or_copy_file(&source, &dest)?;
            linked += 1;
        }
    }

    if linked == 0 {
        return Err(format!(
            "Sample files not found under {}. Try re-downloading sample data.",
            sample_dir.display()
        ));
    }

    Ok(bundle_dir)
}

fn resolve_participant_paths(sample_dir: &Path, participant_id: &str) -> Option<Vec<PathBuf>> {
    let participants_path = sample_dir.join("participants.yaml");
    if !participants_path.exists() {
        return None;
    }

    let raw = fs::read_to_string(&participants_path).ok()?;
    let yaml: serde_yaml::Value = serde_yaml::from_str(&raw).ok()?;
    let participant = yaml.get("participant")?.get(participant_id)?;

    let mut paths = Vec::new();
    for key in ["ref_path", "ref_index", "aligned", "aligned_index"] {
        if let Some(path_val) = participant.get(key).and_then(|v| v.as_str()) {
            if path_val.trim().is_empty() {
                continue;
            }
            let resolved = if Path::new(path_val).is_absolute() {
                PathBuf::from(path_val)
            } else {
                let trimmed = path_val.trim_start_matches("./");
                sample_dir.join(trimmed)
            };
            paths.push(resolved);
        }
    }

    if paths.is_empty() {
        None
    } else {
        Some(paths)
    }
}

/// Check if a sample is already downloaded and return the import folder path if ready
#[tauri::command]
pub async fn check_sample_downloaded(sample_id: String) -> Result<Option<String>, String> {
    let biovault_home = biovault::config::get_biovault_home()
        .map_err(|e| format!("Failed to resolve BioVault home: {}", e))?;
    let sample_dir = biovault_home.join("data").join("sample");

    let key = sample_id.trim().to_lowercase();
    let (participant_id, expected_files, import_folder) = match key.as_str() {
        "na06985-chry" | "na06985-chr-y" | "na06985-chr_y" | "na06985-chry-raw" => (
            "NA06985-chrY",
            vec!["NA06985.final.chrY.cram", "NA06985.final.chrY.cram.crai"],
            "NA06985-chrY-import",
        ),
        "na06985-full" | "na06985" => (
            "NA06985",
            vec!["NA06985.final.cram", "NA06985.final.cram.crai"],
            "NA06985-import",
        ),
        "dynamic-dna" | "dynamicdna" | "dynamic_dna" => {
            let file_path = sample_dir
                .join("dynamic-dna")
                .join("100001_X_X_GSAv3-DTC_GRCh38-07-01-2025.txt");
            if file_path.exists() {
                return Ok(Some(
                    sample_dir.join("dynamic-dna").to_string_lossy().to_string(),
                ));
            }
            return Ok(None);
        }
        "23andme" => {
            let file_path = sample_dir
                .join("23andme")
                .join("genome_Zeeshan_Usamani_v4_Full.txt");
            if file_path.exists() {
                return Ok(Some(
                    sample_dir.join("23andme").to_string_lossy().to_string(),
                ));
            }
            return Ok(None);
        }
        _ => return Ok(None),
    };

    let participant_dir = sample_dir.join(participant_id);
    let reference_dir = sample_dir.join("reference");

    // Check if participant directory exists with expected files
    if !participant_dir.exists() {
        return Ok(None);
    }

    // Check for aligned files
    for file in expected_files {
        let file_path = participant_dir.join(file);
        if !file_path.exists() && !file_path.is_symlink() {
            return Ok(None);
        }
    }

    // Check for reference files
    let ref_files = if key.contains("chry") {
        vec!["GRCh38_chrY.fa", "GRCh38_chrY.fa.fai"]
    } else {
        vec![
            "GRCh38_full_analysis_set_plus_decoy_hla.fa",
            "GRCh38_full_analysis_set_plus_decoy_hla.fa.fai",
        ]
    };

    for file in ref_files {
        let file_path = reference_dir.join(file);
        if !file_path.exists() && !file_path.is_symlink() {
            return Ok(None);
        }
    }

    // All files exist, prepare the import bundle and return the import folder path
    let import_folder_path = sample_dir.join(import_folder);
    prepare_participant_bundle(&sample_dir, participant_id)
        .map_err(|e| format!("Failed to prepare import bundle: {}", e))?;

    Ok(Some(import_folder_path.to_string_lossy().to_string()))
}
