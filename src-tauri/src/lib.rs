use walkdir::WalkDir;
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use rusqlite::{Connection, params};
use sha2::{Sha256, Digest};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::Emitter;

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    docker_path: String,
    java_path: String,
    syftbox_path: String,
    biovault_path: String,
    email: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            docker_path: String::from("/usr/local/bin/docker"),
            java_path: String::from("/usr/bin/java"),
            syftbox_path: String::from("/usr/local/bin/syftbox"),
            biovault_path: String::from("bv"),
            email: String::new(),
        }
    }
}

#[derive(Serialize)]
struct PatternSuggestion {
    pattern: String,
    description: String,
}

#[derive(Serialize)]
struct ExtensionCount {
    extension: String,
    count: usize,
}

#[derive(Serialize)]
struct ImportResult {
    success: bool,
    message: String,
    conflicts: Vec<FileConflict>,
    imported_files: Vec<FileRecord>,
}

#[derive(Serialize)]
struct FileConflict {
    path: String,
    existing_hash: String,
    new_hash: String,
}

#[derive(Serialize)]
struct Participant {
    id: i64,
    participant_id: String,
    created_at: String,
}

#[derive(Serialize)]
struct FileRecord {
    id: i64,
    participant_id: i64,
    participant_name: String,
    file_path: String,
    file_hash: String,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
struct Project {
    id: i64,
    name: String,
    author: String,
    workflow: String,
    template: String,
    project_path: String,
    created_at: String,
}

#[derive(Serialize)]
struct Run {
    id: i64,
    project_id: i64,
    project_name: String,
    work_dir: String,
    participant_count: i64,
    status: String,
    created_at: String,
}

#[derive(Deserialize)]
struct ProjectYaml {
    name: String,
    author: String,
    workflow: String,
    template: String,
    assets: Vec<String>,
}

struct AppState {
    db: Mutex<Connection>,
}

fn init_db(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            participant_id TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            participant_id INTEGER NOT NULL,
            file_path TEXT UNIQUE NOT NULL,
            file_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (participant_id) REFERENCES participants(id)
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            author TEXT NOT NULL,
            workflow TEXT NOT NULL,
            template TEXT NOT NULL,
            project_path TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            work_dir TEXT NOT NULL,
            participant_count INTEGER NOT NULL,
            status TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (project_id) REFERENCES projects(id)
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS run_participants (
            run_id INTEGER NOT NULL,
            participant_id INTEGER NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(id),
            FOREIGN KEY (participant_id) REFERENCES participants(id),
            PRIMARY KEY (run_id, participant_id)
        )",
        [],
    )?;

    Ok(())
}

#[tauri::command]
fn get_extensions(path: String) -> Result<Vec<ExtensionCount>, String> {
    let mut ext_counts: HashMap<String, usize> = HashMap::new();

    for entry in WalkDir::new(&path).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            if let Some(ext) = entry.path().extension() {
                if let Some(ext_str) = ext.to_str() {
                    *ext_counts.entry(format!(".{}", ext_str)).or_insert(0) += 1;
                }
            }
        }
    }

    let mut extensions: Vec<ExtensionCount> = ext_counts
        .into_iter()
        .map(|(extension, count)| ExtensionCount { extension, count })
        .collect();

    extensions.sort_by(|a, b| b.count.cmp(&a.count));

    Ok(extensions)
}

#[tauri::command]
fn search_txt_files(path: String, extension: String) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    let ext = extension.trim_start_matches('.');

    for entry in WalkDir::new(&path).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            if let Some(file_ext) = entry.path().extension() {
                if file_ext == ext {
                    if let Some(path_str) = entry.path().to_str() {
                        files.push(path_str.to_string());
                    }
                }
            }
        }
    }

    Ok(files)
}

#[tauri::command]
fn suggest_patterns(files: Vec<String>) -> Result<Vec<PatternSuggestion>, String> {
    if files.is_empty() {
        return Ok(vec![]);
    }

    let mut suggestions = Vec::new();
    let filenames: Vec<String> = files.iter()
        .filter_map(|f| Path::new(f).file_name())
        .filter_map(|n| n.to_str())
        .map(|s| s.to_string())
        .collect();

    if filenames.is_empty() {
        return Ok(vec![]);
    }

    let first = &filenames[0];

    // Pattern 1: case_XXXX_ pattern
    if first.contains("case_") {
        let re = Regex::new(r"case_(\d+)_").unwrap();
        if re.is_match(first) {
            suggestions.push(PatternSuggestion {
                pattern: "case_{id}_*".to_string(),
                description: "Case ID pattern".to_string(),
            });
        }
    }

    // Pattern 2: XXXX_X_X_ pattern (numbers at start)
    let re_start = Regex::new(r"^(\d+)_").unwrap();
    if re_start.is_match(first) {
        suggestions.push(PatternSuggestion {
            pattern: "{id}_X_X_*".to_string(),
            description: "Leading ID pattern".to_string(),
        });
    }

    // Pattern 3: Generic number sequences
    let re_numbers = Regex::new(r"\d{3,}").unwrap();
    if let Some(mat) = re_numbers.find(first) {
        let start = mat.start();
        let end = mat.end();
        let before = &first[..start];
        let after = &first[end..];
        suggestions.push(PatternSuggestion {
            pattern: format!("{}{{id}}{}", before, after),
            description: "Numeric ID pattern".to_string(),
        });
    }

    Ok(suggestions)
}

fn calculate_file_hash(path: &str) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 8192];

    loop {
        let bytes_read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
fn import_files(
    state: tauri::State<AppState>,
    files: Vec<String>,
    pattern: String,
    file_id_map: std::collections::HashMap<String, String>,
) -> Result<ImportResult, String> {
    let conn = state.db.lock().unwrap();
    let mut conflicts = Vec::new();
    let mut imported_count = 0;
    let mut skipped_count = 0;
    let mut imported_file_ids = Vec::new();

    for file_path in files {
        // Try to get participant ID from map first, then fall back to pattern extraction
        let participant_id = if let Some(id) = file_id_map.get(&file_path) {
            id.clone()
        } else {
            let filename = Path::new(&file_path)
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or("Invalid filename")?;

            extract_id_from_filename(filename, &pattern)
                .ok_or("Could not extract participant ID")?
        };

        let file_hash = calculate_file_hash(&file_path)?;

        let db_participant_id: i64 = match conn.query_row(
            "SELECT id FROM participants WHERE participant_id = ?1",
            params![&participant_id],
            |row| row.get(0),
        ) {
            Ok(id) => id,
            Err(_) => {
                conn.execute(
                    "INSERT INTO participants (participant_id) VALUES (?1)",
                    params![&participant_id],
                )
                .map_err(|e| e.to_string())?;
                conn.last_insert_rowid()
            }
        };

        match conn.query_row(
            "SELECT file_hash FROM files WHERE file_path = ?1",
            params![&file_path],
            |row| row.get::<_, String>(0),
        ) {
            Ok(existing_hash) => {
                if existing_hash == file_hash {
                    skipped_count += 1;
                } else {
                    conflicts.push(FileConflict {
                        path: file_path.clone(),
                        existing_hash,
                        new_hash: file_hash,
                    });
                }
            }
            Err(_) => {
                conn.execute(
                    "INSERT INTO files (participant_id, file_path, file_hash) VALUES (?1, ?2, ?3)",
                    params![db_participant_id, &file_path, &file_hash],
                )
                .map_err(|e| e.to_string())?;
                imported_file_ids.push(conn.last_insert_rowid());
                imported_count += 1;
            }
        }
    }

    if !conflicts.is_empty() {
        return Ok(ImportResult {
            success: false,
            message: format!("Found {} conflicts", conflicts.len()),
            conflicts,
            imported_files: vec![],
        });
    }

    let mut imported_files = Vec::new();
    for file_id in imported_file_ids {
        let file = conn.query_row(
            "SELECT f.id, f.participant_id, p.participant_id, f.file_path, f.file_hash, f.created_at, f.updated_at
             FROM files f
             JOIN participants p ON f.participant_id = p.id
             WHERE f.id = ?1",
            params![file_id],
            |row| {
                Ok(FileRecord {
                    id: row.get(0)?,
                    participant_id: row.get(1)?,
                    participant_name: row.get(2)?,
                    file_path: row.get(3)?,
                    file_hash: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        ).map_err(|e| e.to_string())?;
        imported_files.push(file);
    }

    Ok(ImportResult {
        success: true,
        message: format!(
            "Imported {} files, skipped {} duplicates",
            imported_count, skipped_count
        ),
        conflicts: vec![],
        imported_files,
    })
}

fn extract_id_from_filename(filename: &str, pattern: &str) -> Option<String> {
    if !pattern.contains("{id}") {
        return None;
    }

    let regex_pattern = pattern
        .replace(".", "\\.")
        .replace("*", ".*")
        .replace("{id}", "(\\d+)");

    let re = Regex::new(&regex_pattern).ok()?;
    let captures = re.captures(filename)?;
    captures.get(1).map(|m| m.as_str().to_string())
}

#[tauri::command]
fn get_participants(state: tauri::State<AppState>) -> Result<Vec<Participant>, String> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, participant_id, created_at FROM participants ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;

    let participants = stmt
        .query_map([], |row| {
            Ok(Participant {
                id: row.get(0)?,
                participant_id: row.get(1)?,
                created_at: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(participants)
}

#[tauri::command]
fn get_files(state: tauri::State<AppState>) -> Result<Vec<FileRecord>, String> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.participant_id, p.participant_id, f.file_path, f.file_hash, f.created_at, f.updated_at
             FROM files f
             JOIN participants p ON f.participant_id = p.id
             ORDER BY f.created_at DESC"
        )
        .map_err(|e| e.to_string())?;

    let files = stmt
        .query_map([], |row| {
            Ok(FileRecord {
                id: row.get(0)?,
                participant_id: row.get(1)?,
                participant_name: row.get(2)?,
                file_path: row.get(3)?,
                file_hash: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(files)
}

fn github_url_to_raw(url: &str) -> String {
    url.replace("github.com", "raw.githubusercontent.com")
        .replace("/blob/", "/")
}

fn download_file(url: &str) -> Result<Vec<u8>, String> {
    use std::time::Duration;

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(url)
        .send()
        .map_err(|e| format!("Failed to download {}: {}", url, e))?;

    if !response.status().is_success() {
        return Err(format!("Failed to download {}: HTTP {}", url, response.status()));
    }

    response.bytes().map(|b| b.to_vec()).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_project(state: tauri::State<AppState>, url: String, overwrite: bool) -> Result<Project, String> {
    println!("Importing project from: {}", url);
    let raw_url = github_url_to_raw(&url);
    println!("Raw URL: {}", raw_url);

    println!("Downloading project.yaml...");
    let yaml_content = download_file(&raw_url)?;
    let yaml_str = String::from_utf8(yaml_content).map_err(|e| e.to_string())?;

    println!("Parsing YAML...");
    let project_yaml: ProjectYaml = serde_yaml::from_str(&yaml_str).map_err(|e| format!("Failed to parse YAML: {}", e))?;
    println!("Project name: {}", project_yaml.name);

    let conn = state.db.lock().unwrap();

    println!("Checking for existing project...");
    let existing_project: Result<i64, _> = conn.query_row(
        "SELECT id FROM projects WHERE name = ?1",
        params![&project_yaml.name],
        |row| row.get(0),
    );

    if existing_project.is_ok() && !overwrite {
        return Err(format!("Project '{}' already exists", project_yaml.name));
    }

    println!("Creating project directory...");
    let desktop_dir = dirs::desktop_dir().ok_or("Could not find desktop directory")?;
    let biovault_dir = desktop_dir.join("BioVault").join("projects");
    let project_dir = biovault_dir.join(&project_yaml.name);

    if project_dir.exists() {
        fs::remove_dir_all(&project_dir).map_err(|e| e.to_string())?;
    }

    fs::create_dir_all(&project_dir).map_err(|e| e.to_string())?;

    let yaml_file_path = project_dir.join("project.yaml");
    fs::write(&yaml_file_path, yaml_str).map_err(|e| e.to_string())?;

    println!("Downloading assets...");
    let base_url = raw_url.rsplit_once('/').map(|(base, _)| base).ok_or("Invalid URL")?;
    let assets_url = format!("{}/assets", base_url);

    let assets_dir = project_dir.join("assets");
    fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;

    for asset in &project_yaml.assets {
        println!("Downloading asset: {}", asset);
        let asset_url = format!("{}/{}", assets_url, asset);
        let asset_content = download_file(&asset_url)?;
        let asset_path = assets_dir.join(asset);

        // Create parent directories if asset has a path like "bioscript/classifier.py"
        if let Some(parent) = asset_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create asset directory: {}", e))?;
        }

        let mut file = File::create(&asset_path).map_err(|e| format!("Failed to create asset file {}: {}", asset, e))?;
        file.write_all(&asset_content).map_err(|e| format!("Failed to write asset {}: {}", asset, e))?;
        println!("Asset downloaded: {}", asset);
    }

    println!("Downloading workflow...");
    let workflow_url = format!("{}/{}", base_url, project_yaml.workflow);
    let workflow_content = download_file(&workflow_url)?;
    let workflow_path = project_dir.join(&project_yaml.workflow);
    let mut file = File::create(&workflow_path).map_err(|e| e.to_string())?;
    file.write_all(&workflow_content).map_err(|e| e.to_string())?;
    println!("Workflow downloaded");

    println!("Saving to database...");
    if let Ok(existing_id) = existing_project {
        println!("Updating existing project with id: {}", existing_id);
        conn.execute(
            "UPDATE projects SET author = ?1, workflow = ?2, template = ?3, project_path = ?4 WHERE id = ?5",
            params![
                &project_yaml.author,
                &project_yaml.workflow,
                &project_yaml.template,
                project_dir.to_str().unwrap(),
                existing_id
            ],
        ).map_err(|e| e.to_string())?;
    } else {
        println!("Inserting new project");
        conn.execute(
            "INSERT INTO projects (name, author, workflow, template, project_path) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                &project_yaml.name,
                &project_yaml.author,
                &project_yaml.workflow,
                &project_yaml.template,
                project_dir.to_str().unwrap()
            ],
        ).map_err(|e| format!("Failed to insert project: {}", e))?;
    }

    let project_id = if let Ok(id) = existing_project {
        id
    } else {
        conn.last_insert_rowid()
    };

    println!("Project ID: {}", project_id);
    println!("Fetching project from database...");
    let project = conn.query_row(
        "SELECT id, name, author, workflow, template, project_path, created_at FROM projects WHERE id = ?1",
        params![project_id],
        |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                author: row.get(2)?,
                workflow: row.get(3)?,
                template: row.get(4)?,
                project_path: row.get(5)?,
                created_at: row.get(6)?,
            })
        },
    ).map_err(|e| format!("Failed to fetch project: {}", e))?;

    println!("Import complete! Returning project: {}", project.name);
    Ok(project)
}

#[tauri::command]
fn get_projects(state: tauri::State<AppState>) -> Result<Vec<Project>, String> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, name, author, workflow, template, project_path, created_at FROM projects ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;

    let projects = stmt
        .query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                author: row.get(2)?,
                workflow: row.get(3)?,
                template: row.get(4)?,
                project_path: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(projects)
}

#[tauri::command]
fn delete_project(state: tauri::State<AppState>, project_id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();

    let project_path: String = conn.query_row(
        "SELECT project_path FROM projects WHERE id = ?1",
        params![project_id],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;

    if Path::new(&project_path).exists() {
        let _ = fs::remove_dir_all(&project_path);
    }

    conn.execute("DELETE FROM projects WHERE id = ?1", params![project_id])
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Serialize)]
struct RunStartResult {
    run_id: i64,
    work_dir: String,
}

#[tauri::command]
fn start_analysis(
    state: tauri::State<AppState>,
    participant_ids: Vec<i64>,
    project_id: i64,
) -> Result<RunStartResult, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let conn = state.db.lock().unwrap();

    let project: (String, String) = conn.query_row(
        "SELECT name, project_path FROM projects WHERE id = ?1",
        params![project_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|e| e.to_string())?;

    let desktop_dir = dirs::desktop_dir().ok_or("Could not find desktop directory")?;
    let biovault_dir = desktop_dir.join("BioVault");
    let runs_dir = biovault_dir.join("runs");

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let run_dir = runs_dir.join(format!("{}_{}", project.0, timestamp));
    let work_dir = run_dir.join("work");
    let results_dir = run_dir.join("results");

    fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&results_dir).map_err(|e| e.to_string())?;

    let mut csv_content = String::from("participant_id,genotype_file_path\n");

    for participant_id in &participant_ids {
        let (pid, file_path): (String, String) = conn.query_row(
            "SELECT p.participant_id, f.file_path
             FROM participants p
             JOIN files f ON f.participant_id = p.id
             WHERE p.id = ?1
             LIMIT 1",
            params![participant_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|e| e.to_string())?;

        csv_content.push_str(&format!("{},{}\n", pid, file_path));
    }

    let samplesheet_path = work_dir.join("samplesheet.csv");
    fs::write(&samplesheet_path, csv_content).map_err(|e| e.to_string())?;

    // Create the log file immediately so event listeners can attach
    let log_path = run_dir.join("run.log");
    let mut log_file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to create log file: {}", e))?;

    writeln!(log_file, "=== Preparing analysis... ===").map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO runs (project_id, work_dir, participant_count, status) VALUES (?1, ?2, ?3, ?4)",
        params![
            project_id,
            run_dir.to_str().unwrap(),
            participant_ids.len() as i64,
            "running"
        ],
    ).map_err(|e| e.to_string())?;

    let run_id = conn.last_insert_rowid();

    for participant_id in &participant_ids {
        conn.execute(
            "INSERT INTO run_participants (run_id, participant_id) VALUES (?1, ?2)",
            params![run_id, participant_id],
        ).map_err(|e| e.to_string())?;
    }

    Ok(RunStartResult {
        run_id,
        work_dir: run_dir.to_str().unwrap().to_string(),
    })
}

#[tauri::command]
fn execute_analysis(
    state: tauri::State<AppState>,
    run_id: i64,
    window: tauri::Window,
) -> Result<String, String> {
    use std::process::{Command, Stdio};
    use std::io::{BufRead, BufReader};
    use std::time::{SystemTime, UNIX_EPOCH};

    // Load settings to get bv path
    let settings = get_settings()?;
    let bv_path = if settings.biovault_path.is_empty() {
        "bv".to_string()
    } else {
        settings.biovault_path
    };

    let conn = state.db.lock().unwrap();

    let (project_path, work_dir): (String, String) = conn.query_row(
        "SELECT p.project_path, r.work_dir
         FROM runs r
         JOIN projects p ON r.project_id = p.id
         WHERE r.id = ?1",
        params![run_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|e| e.to_string())?;

    drop(conn);

    let run_dir_path = PathBuf::from(&work_dir);
    let work_subdir = run_dir_path.join("work");
    let results_subdir = run_dir_path.join("results");
    let samplesheet_path = work_subdir.join("samplesheet.csv");
    let log_path = run_dir_path.join("run.log");

    // Append to existing log file (created during start_analysis)
    let mut log_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open log file: {}", e))?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    writeln!(log_file, "\n=== Run {} started at {} ===", run_id, timestamp).map_err(|e| e.to_string())?;
    writeln!(log_file, "Command: {} run --work-dir {} --results-dir {} {} {}",
        bv_path, work_subdir.display(), results_subdir.display(), project_path, samplesheet_path.display()
    ).map_err(|e| e.to_string())?;
    writeln!(log_file, "").map_err(|e| e.to_string())?;

    // Emit initial log lines to UI
    let _ = window.emit("log-line", format!("=== Run {} started at {} ===", run_id, timestamp));
    let _ = window.emit("log-line", format!("Command: {} run --work-dir {} --results-dir {} {} {}",
        bv_path, work_subdir.display(), results_subdir.display(), project_path, samplesheet_path.display()));
    let _ = window.emit("log-line", "");

    let mut child = Command::new(&bv_path)
        .arg("run")
        .arg("--work-dir")
        .arg(work_subdir.to_str().unwrap())
        .arg("--results-dir")
        .arg(results_subdir.to_str().unwrap())
        .arg(&project_path)
        .arg(samplesheet_path.to_str().unwrap())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let log_path_clone = log_path.clone();
    let window_clone = window.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut log_file = fs::OpenOptions::new()
            .append(true)
            .open(&log_path_clone)
            .ok();

        for line in reader.lines() {
            if let Ok(line) = line {
                let _ = window_clone.emit("log-line", line.clone());
                if let Some(ref mut file) = log_file {
                    let _ = writeln!(file, "{}", line);
                }
            }
        }
    });

    let log_path_clone2 = log_path.clone();
    let window_clone2 = window.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut log_file = fs::OpenOptions::new()
            .append(true)
            .open(&log_path_clone2)
            .ok();

        for line in reader.lines() {
            if let Ok(line) = line {
                let stderr_line = format!("STDERR: {}", line);
                let _ = window_clone2.emit("log-line", stderr_line.clone());
                if let Some(ref mut file) = log_file {
                    let _ = writeln!(file, "{}", stderr_line);
                }
            }
        }
    });

    let status = child.wait().map_err(|e| e.to_string())?;

    let conn = state.db.lock().unwrap();
    let status_str = if status.success() {
        "success"
    } else {
        "failed"
    };

    conn.execute(
        "UPDATE runs SET status = ?1 WHERE id = ?2",
        params![status_str, run_id],
    ).map_err(|e| e.to_string())?;

    // Write final status to log
    let mut log_file = fs::OpenOptions::new()
        .append(true)
        .open(&log_path)
        .ok();
    if let Some(ref mut file) = log_file {
        let _ = writeln!(file, "\n=== Analysis {} ===", status_str);
        let _ = writeln!(file, "Exit code: {}", status.code().unwrap_or(-1));
    }

    let _ = window.emit("analysis-complete", status_str);

    if status.success() {
        Ok(format!("Analysis completed successfully. Output in: {}", work_dir))
    } else {
        Err("Analysis failed".to_string())
    }
}

#[tauri::command]
fn get_runs(state: tauri::State<AppState>) -> Result<Vec<Run>, String> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT r.id, r.project_id, p.name, r.work_dir, r.participant_count, r.status, r.created_at
             FROM runs r
             JOIN projects p ON r.project_id = p.id
             ORDER BY r.created_at DESC"
        )
        .map_err(|e| e.to_string())?;

    let runs = stmt
        .query_map([], |row| {
            Ok(Run {
                id: row.get(0)?,
                project_id: row.get(1)?,
                project_name: row.get(2)?,
                work_dir: row.get(3)?,
                participant_count: row.get(4)?,
                status: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(runs)
}

#[tauri::command]
fn delete_run(state: tauri::State<AppState>, run_id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();

    let work_dir: String = conn.query_row(
        "SELECT work_dir FROM runs WHERE id = ?1",
        params![run_id],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "DELETE FROM run_participants WHERE run_id = ?1",
        params![run_id],
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "DELETE FROM runs WHERE id = ?1",
        params![run_id],
    ).map_err(|e| e.to_string())?;

    if Path::new(&work_dir).exists() {
        let _ = fs::remove_dir_all(&work_dir);
    }

    Ok(())
}

#[tauri::command]
fn delete_participant(state: tauri::State<AppState>, participant_id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();

    conn.execute(
        "DELETE FROM run_participants WHERE participant_id = ?1",
        params![participant_id],
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "DELETE FROM files WHERE participant_id = ?1",
        params![participant_id],
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "DELETE FROM participants WHERE id = ?1",
        params![participant_id],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn delete_file(state: tauri::State<AppState>, file_id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();

    conn.execute(
        "DELETE FROM files WHERE id = ?1",
        params![file_id],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn get_run_logs(state: tauri::State<AppState>, run_id: i64) -> Result<String, String> {
    let conn = state.db.lock().unwrap();

    let work_dir: String = conn.query_row(
        "SELECT work_dir FROM runs WHERE id = ?1",
        params![run_id],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;

    let log_path = PathBuf::from(&work_dir).join("run.log");

    if !log_path.exists() {
        return Ok("No logs available for this run yet. Logs will appear once the analysis starts.".to_string());
    }

    let log_content = fs::read_to_string(&log_path)
        .map_err(|e| format!("Failed to read log file: {}", e))?;

    Ok(log_content)
}

#[tauri::command]
fn get_settings() -> Result<Settings, String> {
    let desktop_dir = dirs::desktop_dir().ok_or("Could not find desktop directory")?;
    let settings_path = desktop_dir.join("BioVault").join("database").join("settings.json");

    if !settings_path.exists() {
        return Ok(Settings::default());
    }

    let content = fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read settings: {}", e))?;

    let settings: Settings = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse settings: {}", e))?;

    Ok(settings)
}

#[tauri::command]
fn save_settings(settings: Settings) -> Result<(), String> {
    let desktop_dir = dirs::desktop_dir().ok_or("Could not find desktop directory")?;
    let settings_path = desktop_dir.join("BioVault").join("database").join("settings.json");

    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    fs::write(&settings_path, json)
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    Ok(())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let desktop_dir = dirs::desktop_dir().expect("Could not find desktop directory");
    let biovault_dir = desktop_dir.join("BioVault");
    let database_dir = biovault_dir.join("database");
    let db_path = database_dir.join("app.db");

    std::fs::create_dir_all(&database_dir).expect("Could not create database directory");

    let conn = Connection::open(&db_path).expect("Could not open database");
    init_db(&conn).expect("Could not initialize database");

    let app_state = AppState {
        db: Mutex::new(conn),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            search_txt_files,
            suggest_patterns,
            get_extensions,
            import_files,
            get_participants,
            get_files,
            import_project,
            get_projects,
            delete_project,
            start_analysis,
            execute_analysis,
            get_runs,
            get_run_logs,
            delete_run,
            delete_participant,
            delete_file,
            get_settings,
            save_settings,
            open_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
