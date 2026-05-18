use crate::types::AppState;
use csv::ReaderBuilder;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FacetRow {
    pub participant_id: String,
    pub facet_name: String,
    pub facet_value: String,
}

#[derive(Debug, Serialize)]
pub struct FacetPreview {
    pub rows: Vec<FacetRow>,
    pub unique_values: BTreeMap<String, Vec<String>>,
    pub unknown_participant_ids: Vec<String>,
    pub duplicate_keys: Vec<String>,
}

#[tauri::command]
pub fn save_participant_facets_sample(
    path: String,
    participant_ids: Option<Vec<String>>,
) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("No destination selected".to_string());
    }

    let mut ids: Vec<String> = participant_ids
        .unwrap_or_default()
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        ids = vec!["P001".to_string(), "P002".to_string(), "P003".to_string()];
    }

    let mut content = String::from("participant_id,country,cohort\n");
    for id in ids {
        content.push_str(&format!("{},,\n", id));
    }

    fs::write(&path, content).map_err(|e| format!("Failed to write sample facet file: {}", e))
}

fn detect_delimiter(path: &str) -> u8 {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".tsv") || lower.ends_with(".tab") {
        b'\t'
    } else {
        b','
    }
}

fn normalize_header(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace([' ', '-'], "_")
}

fn build_preview(
    db: &biovault::data::BioVaultDb,
    rows: Vec<FacetRow>,
) -> Result<FacetPreview, String> {
    let known_participants: HashSet<String> = {
        let mut stmt = db
            .conn
            .prepare("SELECT participant_id FROM participants")
            .map_err(|e| format!("Failed to load participants: {}", e))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Failed to read participants: {}", e))?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(|e| format!("Failed to collect participants: {}", e))?;
        rows
    };

    let mut unique_values: BTreeMap<String, HashSet<String>> = BTreeMap::new();
    let mut seen_keys = HashSet::new();
    let mut duplicate_keys = HashSet::new();
    let mut unknown_participant_ids = HashSet::new();

    for row in &rows {
        if !known_participants.contains(&row.participant_id) {
            unknown_participant_ids.insert(row.participant_id.clone());
        }
        unique_values
            .entry(row.facet_name.clone())
            .or_default()
            .insert(row.facet_value.clone());
        let key = format!("{}:{}", row.participant_id, row.facet_name);
        if !seen_keys.insert(key.clone()) {
            duplicate_keys.insert(key);
        }
    }

    let unique_values = unique_values
        .into_iter()
        .map(|(name, values)| {
            let mut values: Vec<String> = values.into_iter().collect();
            values.sort();
            (name, values)
        })
        .collect();

    let mut unknown_participant_ids: Vec<String> = unknown_participant_ids.into_iter().collect();
    unknown_participant_ids.sort();
    let mut duplicate_keys: Vec<String> = duplicate_keys.into_iter().collect();
    duplicate_keys.sort();

    Ok(FacetPreview {
        rows,
        unique_values,
        unknown_participant_ids,
        duplicate_keys,
    })
}

#[tauri::command]
pub fn preview_participant_facets(
    state: tauri::State<AppState>,
    path: String,
) -> Result<FacetPreview, String> {
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err(format!("Facet file not found: {}", path));
    }

    let delimiter = detect_delimiter(&path);
    let mut reader = ReaderBuilder::new()
        .delimiter(delimiter)
        .flexible(true)
        .from_path(&path)
        .map_err(|e| format!("Failed to open facet file: {}", e))?;

    let headers = reader
        .headers()
        .map_err(|e| format!("Failed to read facet headers: {}", e))?
        .clone();

    if headers.is_empty() || normalize_header(headers.get(0).unwrap_or("")) != "participant_id" {
        return Err("First column must be participant_id".to_string());
    }

    let normalized_headers: Vec<String> = headers.iter().map(normalize_header).collect();
    let is_long_format = normalized_headers.len() >= 3
        && normalized_headers[0] == "participant_id"
        && matches!(
            normalized_headers[1].as_str(),
            "facet" | "facet_name" | "name"
        )
        && matches!(normalized_headers[2].as_str(), "value" | "facet_value");

    if !is_long_format && headers.len() < 2 {
        return Err("Facet file must include at least one facet column".to_string());
    }

    let mut rows = Vec::new();
    for result in reader.records() {
        let record = result.map_err(|e| format!("Failed to read facet row: {}", e))?;
        let participant_id = record.get(0).unwrap_or("").trim();
        if participant_id.is_empty() {
            continue;
        }

        if is_long_format {
            let facet_name = record.get(1).unwrap_or("").trim();
            let facet_value = record.get(2).unwrap_or("");
            if !facet_name.is_empty() {
                rows.push(FacetRow {
                    participant_id: participant_id.to_string(),
                    facet_name: facet_name.to_string(),
                    facet_value: facet_value.to_string(),
                });
            }
        } else {
            for index in 1..headers.len() {
                let facet_name = headers.get(index).unwrap_or("").trim();
                let facet_value = record.get(index).unwrap_or("");
                if !facet_name.is_empty() {
                    rows.push(FacetRow {
                        participant_id: participant_id.to_string(),
                        facet_name: facet_name.to_string(),
                        facet_value: facet_value.to_string(),
                    });
                }
            }
        }
    }

    if rows.is_empty() {
        return Err("No facet values found in file".to_string());
    }

    let db = state
        .biovault_db
        .lock()
        .map_err(|_| "Failed to lock database")?;
    build_preview(&db, rows)
}

#[tauri::command]
pub fn import_participant_facets(
    state: tauri::State<AppState>,
    rows: Vec<FacetRow>,
    source_file: Option<String>,
) -> Result<usize, String> {
    if rows.is_empty() {
        return Err("No facet rows to import".to_string());
    }

    let mut db = state
        .biovault_db
        .lock()
        .map_err(|_| "Failed to lock database")?;
    let tx = db
        .conn
        .transaction()
        .map_err(|e| format!("Failed to start facet import: {}", e))?;

    let mut imported = 0usize;
    for row in rows {
        let participant = row.participant_id.trim();
        let facet_name = row.facet_name.trim();
        let facet_value = row.facet_value.trim();
        if participant.is_empty() || facet_name.is_empty() {
            continue;
        }

        let participant_row_id: i64 = tx
            .query_row(
                "SELECT id FROM participants WHERE participant_id = ?1",
                params![participant],
                |db_row| db_row.get(0),
            )
            .map_err(|_| format!("Unknown participant_id: {}", participant))?;

        tx.execute(
            "INSERT INTO participant_facets
             (participant_id, facet_name, facet_value, source_file, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(participant_id, facet_name) DO UPDATE SET
               facet_value = excluded.facet_value,
               source_file = excluded.source_file,
               updated_at = CURRENT_TIMESTAMP",
            params![
                participant_row_id,
                facet_name,
                facet_value,
                source_file.as_deref()
            ],
        )
        .map_err(|e| format!("Failed to import facet for {}: {}", participant, e))?;
        imported += 1;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit facet import: {}", e))?;
    Ok(imported)
}

pub fn facets_for_participant_ids(
    db: &biovault::data::BioVaultDb,
    participant_ids: &[String],
) -> Result<HashMap<String, BTreeMap<String, String>>, String> {
    let mut result: HashMap<String, BTreeMap<String, String>> = HashMap::new();
    for participant_id in participant_ids {
        let mut stmt = db
            .conn
            .prepare(
                "SELECT pf.facet_name, pf.facet_value
                 FROM participant_facets pf
                 JOIN participants p ON p.id = pf.participant_id
                 WHERE p.participant_id = ?1
                 ORDER BY pf.facet_name",
            )
            .map_err(|e| format!("Failed to prepare facet lookup: {}", e))?;
        let rows = stmt
            .query_map([participant_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("Failed to read facets: {}", e))?;

        let mut facets = BTreeMap::new();
        for row in rows {
            let (name, value) = row.map_err(|e| format!("Failed to collect facets: {}", e))?;
            facets.insert(name, value);
        }
        result.insert(participant_id.clone(), facets);
    }
    Ok(result)
}
