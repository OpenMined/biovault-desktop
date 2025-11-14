use crate::{
    logging::{self, LogLevel},
    types::LogEntry,
};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

fn get_log_file_path() -> PathBuf {
    let biovault_home = std::env::var("BIOVAULT_HOME").unwrap_or_else(|_| {
        let home_dir = dirs::home_dir().unwrap();
        dirs::desktop_dir()
            .unwrap_or_else(|| home_dir.join("Desktop"))
            .join("BioVault")
            .to_string_lossy()
            .to_string()
    });
    Path::new(&biovault_home).join("desktop_commands.log")
}

#[allow(dead_code)]
pub fn append_log(entry: &LogEntry) -> Result<(), String> {
    let log_path = get_log_file_path();

    // Ensure directory exists
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create log directory: {}", e))?;
    }

    let json_line = serde_json::to_string(entry)
        .map_err(|e| format!("Failed to serialize log entry: {}", e))?;

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open log file: {}", e))?;

    writeln!(file, "{}", json_line).map_err(|e| format!("Failed to write to log file: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn get_command_logs() -> Result<Vec<LogEntry>, String> {
    let log_path = get_log_file_path();

    if !log_path.exists() {
        return Ok(Vec::new());
    }

    let file =
        std::fs::File::open(&log_path).map_err(|e| format!("Failed to open log file: {}", e))?;

    let reader = BufReader::new(file);
    let mut logs = Vec::new();

    for line_str in reader.lines().map_while(Result::ok) {
        if let Ok(entry) = serde_json::from_str::<LogEntry>(&line_str) {
            logs.push(entry);
        }
    }

    Ok(logs)
}

#[tauri::command]
pub fn clear_command_logs() -> Result<(), String> {
    let log_path = get_log_file_path();

    if log_path.exists() {
        fs::remove_file(&log_path).map_err(|e| format!("Failed to delete log file: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn log_frontend_message(level: Option<String>, message: String) -> Result<(), String> {
    let level = match level.as_deref().map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("warn") => LogLevel::Warn,
        Some("error") => LogLevel::Error,
        _ => LogLevel::Info,
    };

    logging::log_desktop_event(level, &message);
    Ok(())
}

#[tauri::command]
pub fn get_desktop_log_text(max_bytes: Option<u64>) -> Result<String, String> {
    let log_path = logging::desktop_log_path();

    if !log_path.exists() {
        return Ok(String::new());
    }

    let file =
        std::fs::File::open(&log_path).map_err(|e| format!("Failed to open log file: {}", e))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("Failed to read log metadata: {}", e))?;
    let file_size = metadata.len();
    let max_bytes = max_bytes.unwrap_or(20000);
    let mut reader = BufReader::new(file);

    if max_bytes == 0 || file_size <= max_bytes {
        let mut contents = String::new();
        reader
            .read_to_string(&mut contents)
            .map_err(|e| format!("Failed to read log file: {}", e))?;
        return Ok(contents);
    }

    let start_pos = file_size.saturating_sub(max_bytes);
    reader
        .seek(SeekFrom::Start(start_pos))
        .map_err(|e| format!("Failed to seek log file: {}", e))?;

    // Discard partial first line
    let mut discard = Vec::new();
    let _ = reader.read_until(b'\n', &mut discard);

    let mut contents = String::new();
    reader
        .read_to_string(&mut contents)
        .map_err(|e| format!("Failed to read log file: {}", e))?;

    Ok(contents)
}

#[tauri::command]
pub fn clear_desktop_log() -> Result<(), String> {
    let log_path = logging::desktop_log_path();
    if log_path.exists() {
        fs::remove_file(&log_path).map_err(|e| format!("Failed to delete desktop log: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn get_desktop_log_dir() -> Result<String, String> {
    let log_path = logging::desktop_log_path();
    let dir = log_path
        .parent()
        .ok_or_else(|| "Failed to determine desktop log directory".to_string())?;
    Ok(dir.to_string_lossy().to_string())
}
